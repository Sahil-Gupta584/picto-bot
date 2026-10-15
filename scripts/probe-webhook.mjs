/**
 * Sends signed GitHub webhooks at a locally running Picto, and checks that each
 * one is handled the way it should be.
 *
 *   node --env-file=.env scripts/probe-webhook.mjs
 *
 * A real webhook cannot be tested by hand: the signature has to be computed over
 * the exact bytes, and the interesting cases are the ones that must be REJECTED.
 * So this drives all of them, in order, and prints what each one did.
 *
 * It points at a repository that does not exist on purpose. The cases that get
 * as far as starting a run therefore fail harmlessly while fetching the issue,
 * and nothing is written to a real repository.
 */
import { createHmac, randomUUID } from "node:crypto";

const url = process.env.PICTO_URL ?? "http://127.0.0.1:8787/hooks/github";
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const mention = process.env.GITHUB_MENTION ?? "@picto-bot";
const repo = process.argv[2] ?? "picto-probe/this-repo-does-not-exist";

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is not set. Run with: node --env-file=.env ...");
  process.exit(1);
}

const sign = (body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const base = {
  action: "created",
  repository: { full_name: repo, default_branch: "main" },
  issue: {
    number: 4242,
    title: "Probe: verify the webhook does not start a run it should not",
    body: "Probe body.",
    html_url: `https://github.com/${repo}/issues/4242`,
    user: { login: "probe-author" },
  },
  comment: {
    id: 5_000_001,
    body: `hey ${mention} please take a look`,
    user: { login: "probe-human", type: "User" },
  },
};

async function send(label, { body = base, event = "issue_comment", delivery = randomUUID(), signature = sign(JSON.stringify(body)) } = {}) {
  const raw = JSON.stringify(body);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature ?? "",
    },
    body: raw,
  });
  const text = await response.text();
  console.log(`${label.padEnd(38)} ${String(response.status).padEnd(4)} ${text.slice(0, 150)}`);
  return response;
}

console.log(`\nprobing ${url}\ntarget repo (deliberately fake): ${repo}\n`);

await send("unsigned -> must be 401", { signature: "" });
await send("bad signature -> must be 401", { signature: "sha256=" + "0".repeat(64) });
await send("comment with no mention -> ignore", {
  body: { ...base, comment: { ...base.comment, body: "just a normal comment" } },
});
await send("comment from a bot -> ignore", {
  body: { ...base, comment: { ...base.comment, user: { login: "some-app[bot]", type: "Bot" } } },
});
await send("pull_request event -> ignore", { event: "pull_request" });
await send("edited comment -> ignore", { body: { ...base, action: "edited" } });

const delivery = randomUUID();
await send("valid mention -> must be 202", { delivery });
await send("same delivery again -> dedupe", { delivery });

console.log("\nwaiting for the background attempt to finish...");
await new Promise((resolve) => setTimeout(resolve, 3000));
console.log("done - the server log shows the (expected) failure fetching a fake repo\n");
