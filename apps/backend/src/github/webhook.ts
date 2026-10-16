/**
 * The GitHub trigger.
 *
 * A maintainer mentions the bot on an issue; the agent clones the repository,
 * works, and publishes. This file is the part that turns a webhook into that
 * run, and it is written around four things that are easy to get wrong:
 *
 *  1. ANSWER FAST. GitHub gives a webhook ten seconds and then retries. So the
 *     request is verified and acknowledged immediately, and the actual work
 *     happens after the response has already gone back.
 *
 *  2. RUN ONCE. A retry must not start a second agent on the same branch. Every
 *     delivery id is claimed in the session database, which survives a restart
 *     in a way an in-memory set does not.
 *
 *  3. SEND THE WHOLE ISSUE. An `issue_comment` payload has the comment and a
 *     stub of the issue - no body, no history. Building the run from the payload
 *     is what would leave the agent acting on "please do that" with no idea what
 *     "that" is. The context is fetched instead. See ./context.ts.
 *
 *  4. IGNORE ITSELF. The agent comments on the issue. That comment is a webhook
 *     too. Without a filter for its own author, every run would trigger the next
 *     one, forever.
 */
import { Router, type Request, type Response } from "express";
import type { PictoApp } from "@picto/agent-core";
import { runTask, type ApprovalRequest, type RunEvent, type RunResult } from "../agent/index.js";
import { GITHUB } from "../config.js";
import { githubSession } from "../sessions/keys.js";
import type { SessionStore } from "../sessions/store.js";
import type { Workspaces } from "../workspace/index.js";
import { buildInstruction, type IssueComment, type IssueContext } from "./context.js";

type Octokit = Awaited<ReturnType<PictoApp["forInstallation"]>>;

export interface WebhookDeps {
  app: PictoApp;
  store: SessionStore;
  workspaces: Workspaces;
  /** Supplied in phase 4 by the Slack approver. Absent means a block is final. */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /** Every run event, for logging or for mirroring into Slack. */
  onEvent?: (event: RunEvent, sessionKey: string) => void;
}

/** The parts of a GitHub payload this file reads. */
interface GithubPayload {
  action?: string;
  repository: {
    full_name: string;
    default_branch?: string;
  };
  issue: {
    number: number;
    title: string;
    body?: string | null;
    html_url: string;
    user?: { login?: string } | null;
  };
  comment: {
    id: number;
    body?: string | null;
    user?: { login?: string; type?: string } | null;
  };
}

export function githubWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();
  /** Sessions with a run in flight, so two comments cannot share one checkout. */
  const running = new Set<string>();

  router.post("/", (req: Request, res: Response) => {
    void handle(req, res, deps, running);
  });

  return router;
}

async function handle(
  req: Request,
  res: Response,
  deps: WebhookDeps,
  running: Set<string>,
): Promise<void> {
  const event = header(req, "x-github-event");
  const delivery = header(req, "x-github-delivery");
  const signature = header(req, "x-hub-signature-256");

  // 1. Authenticate before parsing. An unverified body is attacker-controlled.
  let payload: GithubPayload;
  try {
    const raw = rawBody(req);
    if (!GITHUB.webhookSecret) {
      console.warn("[picto] GITHUB_WEBHOOK_SECRET is empty - the webhook is NOT verified");
    } else {
      await deps.app.verifyWebhook(raw, signature);
    }
    payload = JSON.parse(raw) as GithubPayload;
  } catch (error) {
    res.status(401).json({ ok: false, error: `signature check failed: ${fn(error)}` });
    return;
  }

  // 2. Claim the delivery. A redelivery is acknowledged and dropped.
  if (delivery && event && !deps.store.claimDelivery(delivery, event)) {
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  if (event !== "issue_comment") {
    res.status(200).json({ ok: true, ignored: `event ${event ?? "unknown"}` });
    return;
  }
  if (payload.action !== "created") {
    res.status(200).json({ ok: true, ignored: `action ${payload.action ?? "unknown"}` });
    return;
  }

  // 3. Never answer ourselves, or any other bot.
  const author = payload.comment?.user;
  const login = author?.login ?? "";
  const self = GITHUB.mention.replace(/^@/, "");
  if (author?.type === "Bot" || login.endsWith("[bot]") || login === self) {
    res.status(200).json({ ok: true, ignored: `comment from ${login || "a bot"}` });
    return;
  }

  // 4. Only when actually addressed.
  const mention = `@${self.toLowerCase()}`;
  const commentBody = payload.comment?.body ?? "";
  if (!commentBody.toLowerCase().includes(mention)) {
    res.status(200).json({ ok: true, ignored: `no ${mention} mention` });
    return;
  }

  const repoFull = payload.repository.full_name;
  const [owner, name] = repoFull.split("/") as [string, string];
  const issueNumber = payload.issue.number;
  const session = githubSession(repoFull, issueNumber);
  const existing = deps.store.ensureSession(session);

  if (running.has(session.key)) {
    res.status(202).json({ ok: true, alreadyRunning: true, session: session.key });
    return;
  }

  // 5. Acknowledge, then work. Everything below happens after the response.
  running.add(session.key);
  res.status(202).json({ ok: true, session: session.key, issue: issueNumber, url: payload.issue.html_url });
  console.log(`[picto] ${delivery ?? "no-delivery"} -> ${session.key} (prior messages: ${deps.store.countMessages(session.key)})`);

  void (async () => {
    try {
      await work({ deps, payload, owner, repo: name, issueNumber, sessionKey: session.key, seen: existing.lastCommentId });
    } catch (error) {
      console.error(`[picto] run for ${session.key} failed: ${fn(error)}`);
    } finally {
      running.delete(session.key);
    }
  })();
}

async function work(input: {
  deps: WebhookDeps;
  payload: GithubPayload;
  owner: string;
  repo: string;
  issueNumber: number;
  sessionKey: string;
  seen: number | null;
}): Promise<void> {
  const { deps, payload, owner, repo, issueNumber, sessionKey } = input;

  const installationId = GITHUB.installationId || (await deps.app.installationFor(`${owner}/${repo}`));
  const octokit = await deps.app.forInstallation(installationId);
  const token = await deps.app.tokenFor(installationId);

  // Fetch the real context - title, body and the conversation, not the stub.
  const context = await loadIssueContext(
    octokit,
    owner,
    repo,
    issueNumber,
    payload.issue,
    payload.comment.id,
  );
  const { instruction, lastCommentId } = buildInstruction(context, input.seen);

  console.log(
    `[picto] context: "${context.title}" - ${context.comments.length} comment(s), ` +
      `${input.seen ? `sending ${context.comments.filter((c) => c.id > input.seen!).length} new` : "first contact, sending all"}`,
  );

  const note = await postNote(
    octokit,
    owner,
    repo,
    issueNumber,
    `🤖 **Picto** picked this up.\n\nReading the issue and the conversation, then working in a fresh clone.`,
  );

  let updatedOnPlan = false;
  const onEvent = (event: RunEvent): void => {
    deps.onEvent?.(event, sessionKey);
    if (event.type === "planned" && !updatedOnPlan) {
      updatedOnPlan = true;
      const refused = event.refused.length > 0 ? event.refused.join(", ") : "none";
      void editNote(
        octokit,
        owner,
        repo,
        note,
        [
          `🤖 **Picto** is working on this.`,
          ``,
          `**Goal** — ${event.goal}`,
          ``,
          `**Declared intent** (signed by ArmorIQ)`,
          ...event.steps.map((step) => `- \`${step}\``),
        ].join("\n"),
      );
    }
  };

  try {
    const result = await runTask(
      {
        sessionKey,
        runId: `${sessionKey}:${Date.now().toString(36)}`,
        owner,
        repo,
        ref: payload.repository.default_branch,
        token,
        instruction,
        branch: branchFor(issueNumber, context.title),
        store: deps.store,
        onEvent,
        requestApproval: deps.requestApproval,
        keepWorkspace: true,
      },
      { workspaces: deps.workspaces },
    );

    // The cursor moves only now, so a run that died before reading its
    // instructions does not swallow them.
    if (lastCommentId !== null && lastCommentId > (input.seen ?? 0)) {
      deps.store.updateSession(sessionKey, { lastCommentId });
    }

    let pullRequest: string | null = null;
    if (result.pushed && result.pushed !== "main") {
      pullRequest = await openPullRequest(
        octokit,
        owner,
        repo,
        result.pushed,
        payload.repository.default_branch ?? "main",
        context,
        result,
      );
    }

    await editNote(octokit, owner, repo, note, report(result, context, pullRequest));
  } catch (error) {
    // Without this, a run that throws leaves the issue showing "picked this up"
    // indefinitely. That reads as "still working" and hides the failure from the
    // only person who can act on it - and from whoever has to debug it later.
    // The reason a run died existed nowhere except the server log, which is not
    // where the maintainer is.
    await editNote(octokit, owner, repo, note, reportFailure(error, sessionKey));
    throw error;
  }
}

function reportFailure(error: unknown, sessionKey: string): string {
  return [
    `🤖 **Picto** could not finish this run.`,
    ``,
    "```",
    fn(error).slice(0, 1200),
    "```",
    ``,
    `The clone and the transcript are kept, so a follow-up comment resumes the same session.`,
    `<sub>session \`${sessionKey}\`</sub>`,
  ].join("\n");
}

async function loadIssueContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  issue: GithubPayload["issue"],
  triggerCommentId: number,
): Promise<IssueContext> {
  // The webhook carries a *stub* of the issue: number and title, and for some
  // event shapes no body at all and none of the earlier conversation. Trusting it
  // because it is usually complete is how a run gets handed the wrong task - or
  // no task, and then guesses at the repository instead of working on the issue.
  // The issue itself is the specification, so it is fetched.
  let title = issue.title;
  let body = issue.body ?? null;
  let author = issue.user?.login ?? "unknown";
  let url = issue.html_url;

  try {
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
    title = data.title ?? title;
    body = data.body ?? body;
    author = data.user?.login ?? author;
    url = data.html_url ?? url;
  } catch (error) {
    console.warn(
      `[picto] could not read ${owner}/${repo}#${number}; using the webhook copy: ${fn(error)}`,
    );
  }

  // Paged, not the first 30 - a long issue is exactly the one with the context.
  const rows = (await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  })) as unknown as Array<{
    id: number;
    body?: string | null;
    created_at?: string;
    user?: { login?: string } | null;
  }>;

  return {
    owner,
    repo,
    number,
    title,
    body,
    author,
    url,
    comments: rows.map(
      (row): IssueComment => ({
        id: row.id,
        author: row.user?.login ?? "unknown",
        body: row.body ?? "",
        createdAt: row.created_at ?? "",
      }),
    ),
    triggerCommentId,
  };
}

async function openPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  base: string,
  context: IssueContext,
  result: RunResult,
): Promise<string | null> {
  try {
    const existing = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
    });
    if (existing.data.length > 0) return existing.data[0]?.html_url ?? null;

    const allowed = result.events.filter((event) => event.type === "allowed").length;
    const created = await octokit.rest.pulls.create({
      owner,
      repo,
      head: branch,
      base,
      title: context.title.slice(0, 200),
      body: [
        `Closes #${context.number}`,
        ``,
        result.summary || "Worked on the issue above.",
        ``,
        `---`,
        `Opened by **Picto**. ${allowed} action(s) allowed by ArmorIQ before this branch was published.`,
        `Intent plan: \`${result.planHash.slice(0, 24)}\``,
      ].join("\n"),
    });
    return created.data.html_url;
  } catch (error) {
    console.error(`[picto] could not open a pull request for ${branch}: ${fn(error)}`);
    return null;
  }
}

function report(result: RunResult, context: IssueContext, pullRequest: string | null): string {
  const allowed = result.events.filter((event) => event.type === "allowed").length;
  const blocked = result.events.filter(
    (event) => event.type === "blocked" || event.type === "held",
  );
  const denied = result.events.filter((event) => event.type === "denied").length;

  const lines: string[] = [`🤖 **Picto** finished on #${context.number}.`, ``];

  lines.push(result.summary || "No summary was produced.", ``);

  if (pullRequest) lines.push(`**Pull request** — ${pullRequest}`, ``);
  else if (result.pushed) lines.push(`**Pushed** to \`${result.pushed}\``, ``);
  else lines.push(`**Nothing was published.**`, ``);

  lines.push(`| ArmorIQ | |`, `| --- | --- |`, `| ✅ allowed | ${allowed} |`);
  for (const event of blocked) {
    if (event.type === "blocked" || event.type === "held") {
      lines.push(`| ⛔ blocked \`${event.name}\` | ${event.code} |`);
    }
  }
  if (denied > 0) lines.push(`| ⛔ denied by a human | ${denied} |`);
  lines.push(``, `<sub>plan \`${result.planHash.slice(0, 12)}\` · session \`${result.sessionKey}\`</sub>`);

  return lines.join("\n");
}

// ── small GitHub helpers ────────────────────────────────────────────────────

async function postNote(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<number | null> {
  try {
    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return created.data.id;
  } catch (error) {
    console.error(`[picto] could not comment on #${issueNumber}: ${fn(error)}`);
    return null;
  }
}

async function editNote(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number | null,
  body: string,
): Promise<void> {
  if (commentId === null) return;
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (error) {
    console.error(`[picto] could not update comment ${commentId}: ${fn(error)}`);
  }
}

/** `picto/12-dismiss-leads-so-irrelevant-threads` - readable in a branch list. */
function branchFor(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `picto/${issueNumber}-${slug || "task"}`;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The untouched request body.
 *
 * Signature verification is over the exact bytes GitHub sent, so this route is
 * mounted with `express.raw` and before the global JSON parser. Getting that
 * order wrong does not fail loudly - it makes every signature check fail - so
 * this throws a clear message rather than quietly verifying nothing.
 */
function rawBody(req: Request): string {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  throw new Error(
    "webhook body was not raw. Mount this router with express.raw BEFORE express.json.",
  );
}

function fn(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
