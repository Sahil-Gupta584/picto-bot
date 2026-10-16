/**
 * Talk to our own Slack endpoint the way Slack would.
 *
 * Signing is identical to Slack's (v0:{ts}:{body}, HMAC-SHA256,
 * x-slack-signature / x-slack-request-timestamp), so this walks the real route
 * with the real verification, real role lookup, a real run, and real thread
 * replies. It exists because the first live mention cannot be sent until the
 * Events URL is registered in the Slack app - and the path is worth testing
 * before that moment, not at it.
 *
 *   node --env-file=.env scripts/slack-sim.mjs                 guest mention (expects a refusal)
 *   node --env-file=.env scripts/slack-sim.mjs "some request"  a different instruction
 *
 * The sender id defaults to a member the workspace does not know, which is the
 * fail-closed path: unknown identity answers as a guest. To simulate a
 * maintainer who is configured by id, set PICTO_SIM_USER to an id listed in
 * PICTO_MAINTAINERS.
 */
import { createHmac, randomUUID } from "node:crypto";

const server = process.env.PICTO_LOCAL_SERVER ?? "http://127.0.0.1:8787";
const secret = process.env.SLACK_SIGNING_SECRET ?? "";
const token = process.env.SLACK_BOT_TOKEN ?? "";
const channel = process.env.SLACK_CHANNEL ?? "";
const botId = process.env.PICTO_SIM_BOT ?? "U0PICTOBOT";
const userId = process.env.PICTO_SIM_USER ?? "U0SIMULATED";

if (!secret || !token || !channel) {
  console.error("SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN and SLACK_CHANNEL must be set");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function signedHeaders(body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-slack-signature": `v0=${signature}`,
    "x-slack-request-timestamp": timestamp,
  };
}

async function post(path, payload) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  });
  return { status: response.status, text: await response.text() };
}

async function slack(method, payload) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

// 1. The handshake Slack performs before it will save an Events URL.
const challenge = `sim-${randomUUID()}`;
const handshake = await post("/slack/events", { type: "url_verification", challenge });
console.log(`url_verification -> ${handshake.status} ${handshake.text}`);
if (!handshake.text.includes(challenge)) {
  console.error("the challenge was not echoed back");
  process.exit(1);
}

// 2. A mention, from the simulated member, inside a real thread.
const instruction =
  process.argv[2] ??
  "Open an issue titled 'Checkout page freezes on Safari' saying it hangs right after payment.";
const parent = await slack("chat.postMessage", {
  channel,
  text: "SIM: this thread stands in for a customer mentioning Picto. Watch the replies below.",
});
const ts = parent.ts;

const eventId = `Ev${randomUUID().replace(/-/g, "")}`;
const mention = {
  type: "event_callback",
  event_id: eventId,
  event: {
    type: "app_mention",
    user: userId,
    channel,
    text: `<@${botId}> ${instruction}`,
    ts,
    thread_ts: ts,
  },
};
const accepted = await post("/slack/events", mention);
console.log(`app_mention      -> ${accepted.status} (thread ts ${ts}, from ${userId})`);

// 3. Follow the session until it settles.
const key = `slack:${channel}:thread:${ts}`;
console.log(`watching ${key}`);
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(attempt === 0 ? 3000 : 10000);
  try {
    const health = await (await fetch(`${server}/health`)).json();
    const session = (health.sessions ?? []).find((s) => s.key === key);
    const status = session?.status ?? "(not listed yet)";
    console.log(`  ${String(attempt).padStart(2)}  ${status}`);
    if (session && status !== "running") break;
  } catch (error) {
    console.log(`  ${String(attempt).padStart(2)}  health check failed: ${error.message}`);
  }
}

// 4. The same delivery again: a Slack retry must be a no-op, not a second run.
const retried = await post("/slack/events", mention);
console.log(`retry (must be a no-op) -> ${retried.status}`);

console.log(
  `\ntranscript:  node --env-file=.env scripts/show-session.mjs "slack:${channel}:thread:${ts}" --brief\n` +
    "the thread in Slack shows the same thing, to a human",
);
