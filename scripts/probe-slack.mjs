/**
 * Drives the Slack approval endpoint for real, in one process.
 *
 *   node scripts/probe-slack.mjs
 *
 * The signing secret is taken from the environment, or a throwaway one is used,
 * so this runs whether or not Slack is configured yet.
 *
 * Doing it in-process rather than against the running server is deliberate: it
 * lets the test hold the OTHER end of the wire. A real blocked run is sitting in
 * `broker.wait(...)`, and the point is to prove that a signed button click
 * actually wakes it - not merely that an HTTP endpoint answered.
 *
 * Slack itself is stubbed. Nothing is posted to a real workspace.
 */
import { createHmac, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

// Must be set before config.js is imported - it reads the secret at load time.
if (!process.env.SLACK_SIGNING_SECRET) {
  process.env.SLACK_SIGNING_SECRET = "probe-signing-secret-not-a-real-one";
}
const secret = process.env.SLACK_SIGNING_SECRET;

const express = (await import("express")).default;
const { SlackApprover, slackInteractionsRouter } = await import(
  "../apps/backend/dist/slack/index.js"
);
const { ApprovalBroker } = await import("../apps/backend/dist/sessions/broker.js");
const { SessionStore } = await import("../apps/backend/dist/sessions/store.js");

const DB = "./.picto/probe-slack.sqlite";
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

const store = new SessionStore(DB);
const broker = new ApprovalBroker();

/** A stand-in for Slack, which records instead of posting. */
const sent = [];
const slack = {
  postMessage: async (message) => {
    sent.push({ kind: "post", message });
    return { channel: "C_PROBE", ts: "1777244748.000100" };
  },
  update: async (message) => {
    sent.push({ kind: "update", message });
    return { ok: true };
  },
};

const app = express();
app.use("/slack", express.raw({ type: "*/*" }), slackInteractionsRouter({ store, broker, client: slack }));
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${server.address().port}/slack/interactions`;

const sign = (ts, body) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
const form = (payload) => `payload=${encodeURIComponent(JSON.stringify(payload))}`;
const button = (id, actionId) => ({
  type: "block_actions",
  user: { id: "U0A48G6UUBZ", username: "sahil" },
  actions: [{ action_id: actionId, value: id }],
});

async function post(label, { payload, timestamp = Math.floor(Date.now() / 1000), signature, body } = {}) {
  const raw = body ?? form(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature ?? sign(timestamp, raw),
    },
    body: raw,
  });
  console.log(`${label.padEnd(42)} ${String(response.status).padEnd(4)} ${(await response.text()).slice(0, 60)}`);
  return response;
}

console.log(`\nslack approval probe (in-process, Slack stubbed)\n`);

// ── rejections ──────────────────────────────────────────────────────────────
const dummy = randomUUID();
await post("no signature", { signature: "" });
await post("forged signature", { payload: button(dummy, "picto_approve"), signature: "v0=" + "0".repeat(64) });
await post("stale timestamp (30 min old)", {
  payload: button(dummy, "picto_approve"),
  timestamp: Math.floor(Date.now() / 1000) - 1800,
});
await post("signed body swapped for another", {
  payload: button(dummy, "picto_deny"),
  body: form(button(dummy, "picto_deny")),
  signature: sign(Math.floor(Date.now() / 1000), form(button(dummy, "picto_approve"))),
});

// ── the real flow: a blocked run waiting for a human ────────────────────────
const approvalId = randomUUID();
store.createApproval({
  id: approvalId,
  sessionKey: "gh:probe/repository#7",
  runId: "probe-run",
  action: "push_main",
  mcp: "picto-repo",
  args: { reason: "publish straight to the default branch" },
  reason: "Action 'push_main' not found in the original plan, so it is outside the signed intent",
  code: "IntentMismatchException",
});

console.log(`\n--- a blocked run is now waiting on approval ${approvalId.slice(0, 8)} ---`);
const waiting = new SlackApprover({ store, broker, client: slack, timeoutMs: 5000 }).request({
  id: approvalId,
  action: "push_main",
  mcp: "picto-repo",
  args: { reason: "publish straight to the default branch" },
  reason: "Action 'push_main' not found in the original plan",
  code: "IntentMismatchException",
  sessionKey: "gh:probe/repository#7",
  runId: "probe-run",
});
await new Promise((r) => setTimeout(r, 200));
console.log(`message posted: ${sent.filter((s) => s.kind === "post").length}, broker waiting: ${broker.waiting().length}\n`);

await post("click Approve", { payload: button(approvalId, "picto_approve") });
const approved = await waiting;
await new Promise((r) => setTimeout(r, 200));

const record = store.getApproval(approvalId);
console.log(`\n  run resumed from the wait : ${approved}`);
console.log(`  stored status             : ${record.status}`);
console.log(`  decided by                : ${record.decidedBy}`);
const resolved = sent.filter((s) => s.kind === "update").at(-1);
console.log(`  message redrawn           : ${Boolean(resolved)}`);
console.log(`  buttons removed           : ${resolved ? !JSON.stringify(resolved.message.blocks).includes("picto_approve") : "n/a"}`);

// ── a replay must not flip the decision ─────────────────────────────────────
console.log("");
await post("click Deny on a settled approval", { payload: button(approvalId, "picto_deny") });
await new Promise((r) => setTimeout(r, 200));
console.log(`  stored status after replay: ${store.getApproval(approvalId).status} (must stay approved)`);

server.close();
store.close();
console.log("");
