/**
 * Re-runs the most recent real webhook event.
 *
 *   node --env-file=.env scripts/redeliver.mjs            # newest mention
 *   node --env-file=.env scripts/redeliver.mjs <delivery> # a specific one
 *
 * GitHub replays a delivery when asked, creating a NEW delivery id, so our
 * own de-duplication does not swallow it. That makes this the fastest way to
 * exercise the full path - webhook, agent, ArmorIQ, Slack - without posting
 * another comment on the issue.
 *
 * It picks the newest issue_comment delivery that mentions the bot and was NOT
 * written by a bot, because replaying one of the agent's own comments would be
 * ignored by design.
 */
import { App } from "octokit";

const appId = process.env.GITHUB_APP_ID;
const privateKeyB64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;

if (!appId || !privateKeyB64) {
  console.error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64 are required.");
  process.exit(1);
}

const app = new App({
  appId,
  privateKey: Buffer.from(privateKeyB64, "base64").toString("utf8"),
});

const mention = process.env.GITHUB_MENTION ?? "@picto-bot";
const requested = process.argv[2];

async function payloadOf(deliveryId) {
  const { data } = await app.octokit.request("GET /app/hook/deliveries/{delivery_id}", {
    delivery_id: deliveryId,
  });
  return data.request?.payload ?? null;
}

let target = requested ? { id: requested } : null;

if (!target) {
  const { data: deliveries } = await app.octokit.request("GET /app/hook/deliveries", {
    per_page: 30,
  });

  for (const delivery of deliveries) {
    if (delivery.event !== "issue_comment") continue;

    const payload = await payloadOf(delivery.id);
    if (!payload || payload.action !== "created") continue;

    const body = String(payload.comment?.body ?? "");
    const sender = payload.sender?.login ?? "";
    // Our own comments must never be replayed: the handler ignores bots, so it
    // would look like the replay silently did nothing.
    if (!body.includes(mention) || sender.endsWith("[bot]")) continue;

    target = {
      id: delivery.id,
      repo: payload.repository?.full_name,
      issue: payload.issue?.number,
      sender,
      excerpt: body.replace(/\s+/g, " ").slice(0, 70),
    };
    break;
  }
}

if (!target) {
  console.error(`No redeliverable ${mention} issue_comment found in the last 30 deliveries.`);
  process.exit(1);
}

console.log("");
if (target.repo) {
  console.log(`replaying  ${target.repo}#${target.issue}  by ${target.sender}`);
  console.log(`           "${target.excerpt}"`);
}
console.log(`delivery   ${target.id}`);

await app.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
  delivery_id: target.id,
});

// Redelivery is asynchronous: give it a moment, then report what the new
// attempt actually got back. A 202 above only means GitHub accepted the request.
await new Promise((resolve) => setTimeout(resolve, 4000));

const { data: after } = await app.octokit.request("GET /app/hook/deliveries", { per_page: 3 });
console.log("");
console.log("newest deliveries");
for (const delivery of after) {
  console.log(
    `  ${delivery.delivered_at}  ${delivery.event.padEnd(16)} ${delivery.status_code ?? delivery.status}`,
  );
}

const newest = after[0];
console.log("");
if (newest && newest.status_code === 202) {
  console.log("202 - our server accepted the event and started a run.");
  console.log("Watch the backend log for: plan -> allowed/blocked -> (Slack) -> pushed.");
} else if (newest && newest.status_code === 200) {
  console.log("200 - accepted and ignored (a bot comment, an edit, or a duplicate).");
} else if (newest && newest.status_code >= 400) {
  console.log(`${newest.status_code} - the event was rejected. Check the backend log and`);
  console.log("`npm run github:app-config`.");
}
