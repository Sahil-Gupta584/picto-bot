/**
 * PICTO backend.
 *
 * One process, one port. It serves:
 *
 *   POST /hooks/github  the trigger - a maintainer mentions the bot on an issue
 *   POST /slack/interactions  the Approve button on a blocked action
 *   POST /mcp/fs        picto-fs    - read_file, write_file, list_files
 *   POST /mcp/repo      picto-repo  - run_command, git_commit, push_branch, push_main
 *   GET  /health        liveness, plus what is currently running
 *
 * The MCP endpoints are what ArmorIQ's proxy calls. They are separate MCP
 * servers registered separately, which is what lets policy allow work on a
 * branch and hold a push to main.
 *
 * ORDER MATTERS, and it is the one subtle thing in this file: the GitHub route
 * is mounted with `express.raw` and BEFORE the JSON parser, because a webhook
 * signature is computed over the exact bytes GitHub sent. Parse the JSON first
 * and the signature check silently stops working.
 */
import { PictoApp } from "@picto/agent-core";
import express from "express";
import { DB_PATH, GITHUB, PORT, SLACK, WORKSPACES_ROOT } from "./config.js";
import { githubWebhookRouter } from "./github/webhook.js";
import { createFsServer } from "./mcps/fs/index.js";
import { createRepoServer } from "./mcps/repo/index.js";
import { mountMcp } from "./mcps/mount.js";
import { ApprovalBroker } from "./sessions/broker.js";
import { SessionStore } from "./sessions/store.js";
import { SlackApprover, SlackClient, describeApproval, slackInteractionsRouter } from "./slack/index.js";
import { Workspaces } from "./workspace/index.js";

const workspaces = new Workspaces(WORKSPACES_ROOT);
const store = new SessionStore(DB_PATH);

// No run survives a process restart: the loop, the clone handle and the promise
// a Slack approval wakes all died with the last process. Anything the database
// still describes as in flight is stale, so correct it before serving traffic
// rather than showing work that is not happening.
const recovered = store.recoverInterrupted();
if (recovered.sessions > 0 || recovered.approvals > 0) {
  console.log(
    `[picto] after the restart: ${recovered.sessions} stale run(s) cleared, ` +
      `${recovered.approvals} approval(s) abandoned (no run was waiting for them)`,
  );
}

const toolContext = { workspaces };

/**
 * The join between a blocked run and the person who unblocks it.
 *
 * The run is stopped inside `runTask`, waiting on a broker promise. The answer
 * arrives on a completely different HTTP request. This is what connects them.
 */
const broker = new ApprovalBroker();

/**
 * Slack is optional.
 *
 * Without it, a blocked action is simply final: the run stops. That is the
 * correct default - an approval channel that is missing must not become an
 * approval that is skipped.
 */
const slackClient =
  SLACK.botToken && SLACK.channel ? new SlackClient(SLACK.botToken, SLACK.channel) : null;
const approver = slackClient ? new SlackApprover({ store, broker, client: slackClient }) : null;

/**
 * The most dangerous configuration is the one that looks fine.
 *
 * With a bot token and no signing secret, everything succeeds right up to the
 * moment a human acts: the approval message posts, the buttons look live, and
 * every click is rejected on arrival - so the run waits for an answer that can
 * never come. That is indistinguishable from a broken button, and it is silent.
 * Say so at boot, where someone will see it.
 */
if (slackClient && !SLACK.signingSecret) {
  console.warn(
    "[picto] SLACK_BOT_TOKEN is set but SLACK_SIGNING_SECRET is empty:\n" +
      "        approval messages will post and every button click will be rejected,\n" +
      "        so a blocked run will wait until it times out.\n" +
      "        Fix: Slack app -> Basic Information -> App Credentials -> Signing Secret.\n" +
      "        Verify with: npm run slack:check",
  );
}

const app = express();

// 1. GitHub, with the untouched body. Must come before express.json().
let github: PictoApp | null = null;
try {
  github = new PictoApp();
} catch (error) {
  console.warn(
    `[picto] GitHub App is not configured, so /hooks/github is off: ${message(error)}`,
  );
}

if (github) {
  app.use(
    "/hooks/github",
    express.raw({ type: "*/*", limit: "2mb" }),
    githubWebhookRouter({
      app: github,
      store,
      workspaces,
      // A blocked action is offered to a human in Slack, and the run waits.
      requestApproval: approver?.request,
      onEvent: (event, sessionKey) => {
        if (event.type === "blocked" || event.type === "held") {
          console.log(
            `[picto] ${sessionKey} ${event.type.toUpperCase()} ${event.name} (${event.code}): ${event.reason}`,
          );
        }
      },
    }),
  );
}

// 2. Slack, also raw. Signed by Slack over the exact bytes.
if (slackClient) {
  app.use(
    "/slack",
    express.raw({ type: "*/*", limit: "1mb" }),
    slackInteractionsRouter({ store, broker, client: slackClient }),
  );
}

// 3. Everything else.
app.use(express.json({ limit: "2mb" }));
app.use("/mcp/fs", mountMcp(() => createFsServer(toolContext)));
app.use("/mcp/repo", mountMcp(() => createRepoServer(toolContext)));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "picto",
    github: github ? `enabled (${GITHUB.mention})` : "disabled",
    slack: slackClient ? `enabled (${SLACK.channel})` : "disabled",
    workspaces: {
      root: WORKSPACES_ROOT,
      active: workspaces.list().map((workspace) => workspace.id),
    },
    sessions: store.listSessions(10).map((session) => ({
      key: session.key,
      status: session.status,
      workspace: session.workspace,
    })),
    approvals: store.pendingApprovals().map((approval) => ({
      id: approval.id,
      session: approval.sessionKey,
      action: approval.action,
    })),
  });
});

/**
 * Housekeeping at startup.
 *
 * Deliveries are pruned because the table is only there to stop a retry being
 * run twice, and GitHub does not retry for a day. Workspaces older than a week
 * are removed because they belong to conversations nobody came back to. Both
 * are deliberately conservative: deleting a live conversation's checkout would
 * look like the agent forgot what it was doing.
 */
console.log(`[picto] pruned ${store.pruneDeliveries()} old webhook delivery record(s)`);
console.log(`[picto] removed ${workspaces.sweepOlderThan(7 * 24 * 60 * 60 * 1000)} abandoned workspace(s)`);

const stale = store.staleApprovals(60 * 60 * 1000);
for (const approval of stale) {
  console.warn(
    `[picto] approval ${approval.id.slice(0, 8)} (${describeApproval(approval)}) is still pending ` +
      `from ${Math.round((Date.now() - approval.requestedAt) / 60000)} minute(s) ago. ` +
      `The decision is recorded but the run it belonged to did not survive the restart.`,
  );
}

app.listen(PORT, () => {
  console.log(`[picto] listening on http://127.0.0.1:${PORT}`);
  console.log(`[picto]   hook /hooks/github  ${github ? GITHUB.mention : "(GitHub App not configured)"}`);
  console.log(`[picto]   slack /slack/interactions  ${slackClient ? SLACK.channel : "(not configured - a block is final)"}`);
  console.log(`[picto]   MCP  /mcp/fs    picto-fs`);
  console.log(`[picto]   MCP  /mcp/repo  picto-repo`);
  console.log(`[picto]   db:         ${DB_PATH}`);
  console.log(`[picto]   workspaces: ${WORKSPACES_ROOT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[picto] ${signal} - closing the session database`);
    store.close();
    process.exit(0);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
