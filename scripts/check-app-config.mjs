/**
 * Checks the GitHub App's webhook configuration against this deployment.
 *
 *   node --env-file=.env scripts/check-app-config.mjs
 *
 * Worth running before a demo, because the failure it detects is silent from
 * our side: GitHub posts the event, our server correctly rejects the signature,
 * and the only trace is a 401 in a tunnel log. The `ping` GitHub sends when a
 * webhook URL is saved is itself signed, so a wrong secret shows up as a 401
 * there too.
 *
 * The App's secret cannot be read back - GitHub redacts it from both GET /app
 * and GET /app/hook/config. So this verifies what IS knowable (the URL, the
 * events, the permissions, and the status of recent deliveries) and infers the
 * rest from evidence.
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

const problems = [];

const { data: info } = await app.octokit.request("GET /app");
const { data: hook } = await app.octokit.request("GET /app/hook/config");

console.log("");
console.log(`app          ${info.slug} (id ${info.id})`);
console.log(`events       ${info.events.join(", ")}`);
console.log(
  `permissions  ${Object.entries(info.permissions)
    .map(([name, level]) => `${name}:${level}`)
    .join(", ")}`,
);

// The URL is the one thing here that can be checked exactly.
const expected = process.env.PICTO_PUBLIC_URL
  ? `${process.env.PICTO_PUBLIC_URL.replace(/\/$/, "")}/hooks/github`
  : null;
const actual = hook.url ?? "(unset)";

console.log("");
console.log("webhook url");
console.log(`  app        ${actual}`);
console.log(`  .env says  ${expected ?? "(PICTO_PUBLIC_URL unset)"}`);

if (expected && actual !== expected) {
  problems.push(`the app posts to ${actual}, this deployment expects ${expected}`);
  console.log("  -> MISMATCH. GitHub is sending events somewhere else.");
} else if (expected) {
  console.log("  -> match.");
}

for (const requiredEvent of ["issue_comment"]) {
  if (!info.events.includes(requiredEvent)) {
    problems.push(`the app is not subscribed to ${requiredEvent}`);
  }
}

// Recent deliveries are the ground truth about the secret.
const { data: deliveries } = await app.octokit.request("GET /app/hook/deliveries", { per_page: 10 });

console.log("");
console.log("recent deliveries");
if (!deliveries.length) {
  console.log("  (none recorded)");
} else {
  for (const delivery of deliveries) {
    const note =
      delivery.status_code === 401
        ? "  <- rejected: unsigned, or the secret did not match"
        : delivery.status_code === 404
          ? "  <- no server at that URL (tunnel down or moved)"
          : "";
    console.log(
      `  ${delivery.delivered_at}  ${delivery.event.padEnd(20)} ${delivery.status_code ?? delivery.status}${note}`,
    );
  }
}

// The verdict is the newest delivery. A 401 further back means it was broken
// then - flagging history would make this report a problem forever after any
// fix, which is exactly how a check gets ignored.
const newest = deliveries[0];
const staleFailures = deliveries.slice(1).filter((delivery) => delivery.status_code === 401);

if (!deliveries.length) {
  console.log("  (none recorded - comment on an issue to generate one)");
} else if (newest.status_code === 401) {
  problems.push(
    "the most recent delivery was rejected with 401 - the app's secret and ours differ, or the app has no secret at all",
  );
} else if (newest.status_code === 404) {
  problems.push("the most recent delivery got 404 - nothing is listening at that URL");
} else {
  console.log(`  -> newest delivery accepted (${newest.status_code}).`);
  if (staleFailures.length) {
    console.log(`  -> ${staleFailures.length} older 401(s) are from before the secret was set.`);
  }
}

console.log("");
if (!problems.length) {
  console.log("No problems found.");
  process.exit(0);
}

for (const problem of problems) console.log(`PROBLEM: ${problem}`);
console.log("");
console.log("A 401 means the delivery did not verify. GitHub only signs a delivery when");
console.log("the app has a webhook secret, so either none is set - the request arrives");
console.log("with no X-Hub-Signature-256 header at all - or it differs from");
console.log("GITHUB_WEBHOOK_SECRET. Set both sides to the same value, then restart.");
process.exit(1);
