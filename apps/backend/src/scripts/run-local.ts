/**
 * Runs the agent against a real repository from the terminal.
 *
 * This is the same code path the webhook uses - real clone, real ArmorIQ plan,
 * real tools, real session - with the approval request coming from stdin instead
 * of Slack. It exists so the loop can be exercised without GitHub and Slack
 * being in the picture, and so a broken webhook is never mistaken for a broken
 * agent.
 *
 *   node --env-file=.env dist/scripts/run-local.js \
 *     --repo Sahil-Gupta584/opencmo --issue 1 --branch picto/dismiss-leads
 *
 * Run it twice: the second run resumes the same session, with the same
 * transcript and the same checkout.
 */
import { PictoApp } from "@picto/agent-core";
import { createInterface } from "node:readline/promises";
import { runTask, type RunEvent, type ApprovalRequest } from "../agent/index.js";
import { DB_PATH, WORKSPACES_ROOT } from "../config.js";
import { buildInstruction, type IssueContext } from "../github/context.js";
import { localSession } from "../sessions/keys.js";
import { SessionStore } from "../sessions/store.js";
import { Workspaces } from "../workspace/index.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = arg("repo") ?? process.env.GITHUB_REPO ?? "";
if (!repo.includes("/")) {
  console.error(
    "Usage: run-local.js --repo owner/name [--issue N] [--branch name] [--session name]",
  );
  process.exit(1);
}

const [owner, name] = repo.split("/") as [string, string];
const branch = arg("branch") ?? `picto/run-${Date.now()}`;
const issueNumber = arg("issue");

const app = new PictoApp();
const installationId = await app.installationFor(repo);
const octokit = await app.forInstallation(installationId);
const token = await app.tokenFor(installationId);

const store = new SessionStore(DB_PATH);
const session = localSession(arg("session") ?? `${owner}-${name}`);
const existing = store.ensureSession(session);

/**
 * The instruction is built by the SAME code the webhook uses.
 *
 * A first run gets the title, the body and the whole conversation; a resumed
 * run gets the body again plus only the comments it has not already seen. That
 * way the terminal and GitHub paths cannot drift apart, and the local driver
 * cannot accidentally be kinder to the agent than production is.
 */
let instruction = arg("instruction") ?? "";
let lastCommentId: number | null = null;
let commentCount = 0;

if (!instruction && issueNumber) {
  const issue = await octokit.rest.issues.get({
    owner,
    repo: name,
    issue_number: Number(issueNumber),
  });
  const comments = (await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: name,
    issue_number: Number(issueNumber),
    per_page: 100,
  })) as unknown as Array<{
    id: number;
    body?: string | null;
    created_at?: string;
    user?: { login?: string } | null;
  }>;

  const context: IssueContext = {
    owner,
    repo: name,
    number: Number(issueNumber),
    title: issue.data.title,
    body: issue.data.body ?? null,
    author: issue.data.user?.login ?? "unknown",
    url: issue.data.html_url,
    comments: comments.map((row) => ({
      id: row.id,
      author: row.user?.login ?? "unknown",
      body: row.body ?? "",
      createdAt: row.created_at ?? "",
    })),
  };

  const built = buildInstruction(context, existing.lastCommentId);
  instruction = built.instruction;
  lastCommentId = built.lastCommentId;
  commentCount = context.comments.length;
}

if (!instruction) {
  instruction = "Look at this repository and fix the most obvious bug you can find, then publish it.";
}

console.log(`repo        : ${repo}`);
console.log(`installation: ${installationId}`);
console.log(`session     : ${session.key}`);
console.log(`transcript  : ${store.countMessages(session.key)} message(s) already stored`);
console.log(`workspace   : ${existing.workspace ?? "(not created yet)"}`);
console.log(`branch      : ${branch}`);
if (commentCount > 0) {
  console.log(
    `issue       : ${commentCount} comment(s), cursor ${existing.lastCommentId ?? "(first contact)"}`,
  );
}
console.log(`instruction :\n${instruction.slice(0, 900)}\n`);

const workspaces = new Workspaces(WORKSPACES_ROOT);
const runId = `${session.key}:${Date.now().toString(36)}`;
const rl = createInterface({ input: process.stdin, output: process.stdout });

const icons: Record<string, string> = {
  session: "SESS",
  planned: "PLAN",
  tool: "CALL",
  allowed: "  OK",
  blocked: "  !!",
  held: "  ||",
  approval_requested: " ASK",
  approved: "  ++",
  denied: "  --",
  replanned: "PLAN",
  pushed: "PUSH",
  reply: "DONE",
  error: " ERR",
};

try {
  const result = await runTask(
    {
      sessionKey: session.key,
      runId,
      owner,
      repo: name,
      token,
      instruction,
      branch,
      store,
      onEvent: (event: RunEvent) => {
        const label = icons[event.type] ?? event.type;
        if (event.type === "session")
          console.log(
            `${label} ${event.key} - ${event.priorMessages} prior message(s), workspace ${event.reusedWorkspace ? "reused" : "created"}`,
          );
        else if (event.type === "planned")
          console.log(
            `${label} "${event.goal}"\n       steps  : ${event.steps.join(", ")}\n       refused: ${event.refused.join(", ") || "(none)"}\n       hash   : ${event.planHash.slice(0, 24)}...`,
          );
        else if (event.type === "tool")
          console.log(`${label} ${event.name} ${JSON.stringify(event.args).slice(0, 120)}`);
        else if (event.type === "allowed") console.log(`${label} ${event.name} (${event.ms}ms)`);
        else if (event.type === "blocked")
          console.log(`${label} ${event.name} BLOCKED ${event.code}\n       ${event.reason.slice(0, 170)}`);
        else if (event.type === "held")
          console.log(`${label} ${event.name} HELD\n       ${event.reason.slice(0, 170)}`);
        else if (event.type === "pushed") console.log(`${label} ${event.target} ${event.url ?? ""}`);
        else if (event.type === "reply") console.log(`${label} ${event.text.slice(0, 300)}`);
        else console.log(`${label} ${JSON.stringify(event).slice(0, 200)}`);
      },
      requestApproval: async (request: ApprovalRequest) => {
        console.log(`\n  "${request.action}" on ${request.mcp} was refused by ArmorIQ.`);
        console.log(`  code    : ${request.code}`);
        console.log(`  reason  : ${request.reason}`);
        console.log(`  args    : ${JSON.stringify(request.args)}`);
        console.log(`  approval: ${request.id}\n`);
        const answer = await rl.question("  Allow this action? [y/N] ");
        const approved = answer.trim().toLowerCase().startsWith("y");
        store.decideApproval(request.id, approved ? "approved" : "denied", "local-console");
        return approved;
      },
    },
    { workspaces },
  );

  // Move the comment cursor, exactly as the webhook does, so the next run in
  // this session is only handed what it has not already seen.
  if (lastCommentId !== null && lastCommentId > (existing.lastCommentId ?? 0)) {
    store.updateSession(session.key, { lastCommentId });
  }

  console.log(`\n=== result ===`);
  console.log(`session     : ${result.sessionKey}`);
  console.log(`pushed      : ${result.pushed ?? "(nothing)"}`);
  console.log(`plan hash   : ${result.planHash.slice(0, 32)}...`);
  console.log(`summary     : ${result.summary.slice(0, 400)}`);

  const blocked = result.events.filter((e) => e.type === "blocked" || e.type === "held").length;
  const allowed = result.events.filter((e) => e.type === "allowed").length;
  console.log(`\nArmorIQ     : ${allowed} allowed, ${blocked} blocked`);
  console.log(`transcript  : ${store.countMessages(result.sessionKey)} message(s) stored`);
} finally {
  rl.close();
  store.close();
}

process.exit(0);
