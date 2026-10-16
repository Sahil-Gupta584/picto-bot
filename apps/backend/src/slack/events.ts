/**
 * Being spoken to in Slack.
 *
 * A mention is a request, and who wrote it decides which plan gets signed:
 *
 *   a maintainer's request  is planned like any other run - the plan carries
 *                           what the work needs, and a blocked step is offered
 *                           to a human the usual way.
 *
 *   a guest's request       is planned read-only. The plan ArmorIQ signs holds
 *                           no tool that can change or publish anything, and a
 *                           refusal is final - there is no button, because the
 *                           approved route up is a maintainer making the
 *                           request themselves.
 *
 * The agent is not told which of the two it is talking to. It proposes what the
 * request needs, and finds out the same way everything else does: ArmorIQ
 * refuses a call the signed plan does not cover, and the refusal is what the
 * reply reports.
 *
 * Everything a run says goes back into the thread the mention came from.
 */
import type { PictoApp } from "@picto/agent-core";
import { Router } from "express";
import { runTask, type ApprovalRequest, type RunEvent, type RunResult } from "../agent/index.js";
import { SLACK } from "../config.js";
import { slackSession } from "../sessions/keys.js";
import type { SessionStore } from "../sessions/store.js";
import type { Workspaces } from "../workspace/index.js";
import { header, rawBody, type Authority, type SlackClient } from "./index.js";
import type { SlackRoles } from "./roles.js";
import { verifySlackRequest } from "./verify.js";

export interface SlackRunDeps {
  /** Null when the GitHub App is not configured: no token, no clone, no runs. */
  app: PictoApp | null;
  store: SessionStore;
  workspaces: Workspaces;
  client: SlackClient;
  roles: SlackRoles;
  /** A maintainer's block is offered to a human; a guest's never is. */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /** owner/name of the repository Slack conversations work on. */
  repo: string;
}

interface SlackEventPayload {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

/** One run per conversation at a time, the same guard the GitHub hook keeps. */
const running = new Set<string>();

/**
 * Event ids already handled.
 *
 * Slack re-delivers an event when it thinks the response was too slow, which is
 * exactly when the server is busy doing the work - so a retry is the rule, not
 * the exception, and running it twice would answer one mention twice.
 */
const seen = new Set<string>();
const SEEN_LIMIT = 500;

export function slackEventsRouter(deps: SlackRunDeps): Router {
  const router = Router();

  router.post("/events", (req, res) => {
    const body = rawBody(req);

    const verdict = verifySlackRequest({
      signingSecret: SLACK.signingSecret,
      signature: header(req, "x-slack-signature"),
      timestamp: header(req, "x-slack-request-timestamp"),
      body,
    });

    if (!verdict.ok) {
      console.warn(`[slack] rejected an event: ${verdict.error}`);
      res.status(401).json({ ok: false, error: verdict.error });
      return;
    }

    let payload: SlackEventPayload;
    try {
      payload = JSON.parse(body) as SlackEventPayload;
    } catch {
      res.status(400).json({ ok: false, error: "event body was not valid JSON" });
      return;
    }

    // Slack proves an Events URL by posting a challenge and refusing to save
    // the URL unless the same challenge comes back - signed like everything
    // else, so it has already been verified above.
    if (payload.type === "url_verification") {
      console.log("[slack] events URL verified by Slack");
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // Slack gives us three seconds. Answer first, then do the work.
    res.status(200).send("");

    if (payload.type === "event_callback") {
      void handle(deps, payload).catch((error) =>
        console.error(`[slack] could not handle an event: ${text(error)}`),
      );
    }
  });

  return router;
}

async function handle(deps: SlackRunDeps, payload: SlackEventPayload): Promise<void> {
  const event = payload.event;
  if (!event || event.type !== "app_mention") return;
  if (event.bot_id || event.subtype) return; // another bot talking, or an edit

  const { user, channel, ts, text: message } = event;
  if (!user || !channel || !ts || !message) return;

  if (payload.event_id) {
    if (seen.has(payload.event_id)) return;
    seen.add(payload.event_id);
    if (seen.size > SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
  }

  console.log(
    `[slack] mention from ${user} in ${channel}: ${message.replace(/\s+/g, " ").slice(0, 120)}`,
  );

  const thread = event.thread_ts ?? ts;
  const sessionKey = slackSession(channel, thread).key;

  if (running.has(sessionKey)) {
    await say(
      deps,
      channel,
      thread,
      "Still working on the earlier request in this thread - one run at a time.",
    );
    return;
  }

  // The mention itself is not part of the request.
  const instruction = message
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!instruction) {
    await say(
      deps,
      channel,
      thread,
      "Tell me what you need - a question about the code, or something to do.",
    );
    return;
  }

  const [owner, repo] = deps.repo.split("/");
  if (!owner || !repo) {
    await say(
      deps,
      channel,
      thread,
      "Slack runs are not configured: set `PICTO_SLACK_REPO` to owner/name.",
    );
    return;
  }

  running.add(sessionKey);
  try {
    await work(deps, { channel, thread, sessionKey, owner, repo, instruction, userId: user });
  } finally {
    running.delete(sessionKey);
  }
}

async function work(
  deps: SlackRunDeps,
  input: {
    channel: string;
    thread: string;
    sessionKey: string;
    owner: string;
    repo: string;
    instruction: string;
    userId: string;
  },
): Promise<void> {
  const { channel, thread, sessionKey, owner, repo } = input;

  if (!deps.app) {
    await say(deps, channel, thread, "The GitHub App is not configured, so I cannot clone or file anything.");
    return;
  }

  const authority = await deps.roles.authorityFor(input.userId);

  let token: string;
  try {
    const installationId = await deps.app.installationFor(`${owner}/${repo}`);
    token = await deps.app.tokenFor(installationId);
  } catch (error) {
    await say(deps, channel, thread, `I could not reach \`${owner}/${repo}\`: ${text(error)}`);
    return;
  }

  const posted = await deps.client.postMessage({
    channel,
    threadTs: thread,
    text: "Picto is on it.",
    blocks: [section("🤖 On it — reading the repository.")],
  });

  let announced = false;
  const onEvent = (event: RunEvent): void => {
    if (event.type !== "planned" || announced) return;
    announced = true;
    void deps.client
      .update({
        channel,
        ts: posted.ts,
        text: `Picto - ${event.goal}`,
        blocks: [
          section(
            [
              "🤖 *On it.*",
              "",
              `*Goal* — ${event.goal}`,
              "",
              `*Plan signed by ArmorIQ* — ${event.steps.length} step${event.steps.length === 1 ? "" : "s"}`,
              ...event.steps.map((step) => `• \`${step}\``),
            ].join("\n"),
          ),
        ],
      })
      .catch((error) => console.error(`[slack] could not post the plan: ${text(error)}`));
  };

  try {
    const result = await runTask(
      {
        sessionKey,
        runId: `${sessionKey}:${Date.now().toString(36)}`,
        owner,
        repo,
        token,
        instruction: input.instruction,
        // Stable per thread, so a follow-up mention publishes to the same branch.
        branch: `picto/slack-${thread.replace(/\D/g, "").slice(-10) || "task"}`,
        store: deps.store,
        onEvent,
        requestApproval: authority === "maintainer" ? deps.requestApproval : undefined,
        keepWorkspace: true,
        authority,
      },
      { workspaces: deps.workspaces },
    );

    await deps.client.update({
      channel,
      ts: posted.ts,
      text: "Picto finished.",
      blocks: [section(finalReport(result, authority))],
    });
  } catch (error) {
    await deps.client
      .update({
        channel,
        ts: posted.ts,
        text: "Picto could not finish.",
        blocks: [section(`🤖 I could not finish this run: ${text(error)}`)],
      })
      .catch((updateError) =>
        console.error(`[slack] could not update the failure note: ${text(updateError)}`),
      );
  }
}

function finalReport(result: RunResult, authority: Authority): string {
  const allowed = result.events.filter((event) => event.type === "allowed").length;
  const refused = result.events.filter(
    (event) => event.type === "blocked" || event.type === "held" || event.type === "denied",
  );

  const lines = [
    "🤖 *Picto finished.*",
    "",
    slackMarkdown(result.summary || "No summary was produced."),
    "",
  ];

  if (result.pushed && result.pushed !== "main") {
    lines.push(`📤 Branch \`${result.pushed}\` pushed.`, "");
  } else if (result.pushed) {
    lines.push(`📤 Pushed to \`${result.pushed}\`.`, "");
  }

  lines.push(`✅ ${allowed} action(s) allowed by ArmorIQ`);
  for (const event of refused) {
    if (event.type === "denied") lines.push(`⛔ \`${event.name}\` — denied by a human`);
    else if (event.type === "blocked" || event.type === "held") {
      lines.push(`⛔ \`${event.name}\` — refused (${event.code})`);
    }
  }

  const request = authority === "guest" ? "guest request, signed read-only" : "maintainer request";
  lines.push("", `_plan \`${result.planHash.slice(0, 12)}\` · ${request}_`);

  return lines.join("\n").slice(0, 2800);
}

/** GitHub-flavoured markdown, as the model writes it, in Slack's dialect. */
function slackMarkdown(source: string): string {
  return source
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}

function section(markdown: string): unknown {
  return { type: "section", text: { type: "mrkdwn", text: markdown } };
}

async function say(
  deps: SlackRunDeps,
  channel: string,
  thread: string,
  markdown: string,
): Promise<void> {
  try {
    await deps.client.postMessage({
      channel,
      threadTs: thread,
      text: markdown,
      blocks: [section(markdown)],
    });
  } catch (error) {
    console.error(`[slack] could not reply in ${channel}: ${text(error)}`);
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
