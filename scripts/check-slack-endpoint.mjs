/**
 * Asks a running deployment the two questions Slack asks it.
 *
 *   node --env-file=.env scripts/check-slack-endpoint.mjs
 *   node --env-file=.env scripts/check-slack-endpoint.mjs http://127.0.0.1:8787
 *   node --env-file=.env scripts/check-slack-endpoint.mjs https://abc.ngrok-free.app
 *
 * probe-slack.mjs proves the approval LOGIC in-process with Slack stubbed. It
 * cannot prove that a click from Slack reaches the deployment, because it never
 * leaves the process - and that is a different failure with an identical
 * symptom: the button looks live and the click does nothing.
 *
 * So this asks the two things Slack will ask:
 *
 *   1. Will you accept a genuine click?  A 401 means the secret here and the one
 *      the server started with disagree.
 *   2. Will you echo a url_verification challenge?  Slack refuses to save a
 *      Request URL that does not answer, so if this fails the URL cannot even be
 *      registered.
 *
 * The approval id is random and matches nothing, so this cannot approve
 * anything.
 */
import { createHmac, randomUUID } from "node:crypto";

const secret = process.env.SLACK_SIGNING_SECRET;
const base = (process.argv[2] ?? process.env.PICTO_PUBLIC_URL ?? "http://127.0.0.1:8787").replace(
  /\/$/,
  "",
);
const url = `${base}/slack/interactions`;

if (!secret) {
  console.error("SLACK_SIGNING_SECRET is not set. Run with: node --env-file=.env ...");
  process.exit(1);
}

async function send(payload) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature =
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": String(timestamp),
        "x-slack-signature": signature,
      },
      body: raw,
    });
    return { status: response.status, body: (await response.text()).replace(/\s+/g, " ").trim() };
  } catch (error) {
    return { unreachable: `${error.name}: ${error.message}` };
  }
}

console.log(`\nPOST ${url}\n`);

// 1. A genuine click, for an approval that does not exist.
const click = await send({
  type: "block_actions",
  user: { id: "U_PROBE", username: "probe" },
  actions: [{ action_id: "picto_approve", value: randomUUID() }],
});

if (click.unreachable) {
  console.log(`click        unreachable: ${click.unreachable}`);
  console.log(
    "\nSlack cannot reach this either. Check the tunnel is running and that\n" +
      "PICTO_PUBLIC_URL matches the current ngrok hostname.",
  );
  process.exit(1);
}

console.log(`click        ${click.status}  ${click.body.slice(0, 80)}`);
if (click.status === 401) {
  console.log(
    "             rejected - the secret in .env does not match the one the server\n" +
      "             started with. It reads .env once, at startup: restart it.",
  );
}

// 2. The challenge Slack posts when a Request URL is saved.
const challenge = `probe-${randomUUID()}`;
const verify = await send({ type: "url_verification", challenge });
const echoed = verify.body.includes(challenge);

console.log(`challenge    ${verify.status}  ${verify.body.slice(0, 80)}`);
console.log(`             echoed back: ${echoed ? "yes" : "NO"}`);

console.log("");
if (click.status < 300 && echoed) {
  console.log("Both answered. This deployment can serve Slack, so a live button");
  console.log("click will reach a waiting run. The last piece is the Slack app's own");
  console.log("Interactivity Request URL pointing here:");
  console.log(`\n  ${url}\n`);
} else {
  console.log("At least one failed - see above. Fix that before setting the URL in Slack.");
}
