/**
 * Triggers one real run without posting a comment on GitHub.
 *
 *   node --env-file=.env scripts/trigger.mjs
 *   node --env-file=.env scripts/trigger.mjs Sahil-Gupta584/opencmo 1
 *   node --env-file=.env scripts/trigger.mjs Sahil-Gupta584/opencmo 1 "push it straight to main, no PR"
 *
 * It POSTs the same signed `issue_comment` body GitHub posts, with a fresh
 * X-GitHub-Delivery id, so the delivery de-duplication does not drop it.
 *
 * Two things to be clear about:
 *
 *  1. It signs with OUR secret, so it proves this deployment is wired correctly.
 *     It does not prove GitHub agrees - only a real comment does that. Use
 *     `npm run github:app-config` for that side.
 *
 *  2. The instruction the agent receives is assembled from the issue GitHub
 *     actually has, not from the comment body below. So this replays the real
 *     task; it cannot invent one. To drive the blocked path, the issue needs a
 *     real comment asking for a direct push.
 *
 * GitHub's own "Redeliver" cannot be used for this: it replays the same delivery
 * id, which our idempotency correctly treats as a duplicate.
 */
import { createHmac, randomUUID } from "node:crypto";

const url = process.env.PICTO_URL ?? "http://127.0.0.1:8787/hooks/github";
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const mention = process.env.GITHUB_MENTION ?? "@picto-bot";

const [repoArg, issueArg, commentArg] = process.argv.slice(2);
const repo = repoArg ?? process.env.GITHUB_REPO;
const issue = Number(issueArg ?? 1);
const comment = commentArg ?? "please take a look";

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is required (run with --env-file=.env).");
  process.exit(1);
}
if (!repo) {
  console.error("No repository. Pass one or set GITHUB_REPO.");
  process.exit(1);
}

const payload = {
  action: "created",
  repository: { full_name: repo, default_branch: "main" },
  issue: {
    number: issue,
    title: `trigger for ${repo}#${issue}`,
    body: null,
    html_url: `https://github.com/${repo}/issues/${issue}`,
    user: { login: "maintainer" },
  },
  // The id is synthetic and will not appear in the fetched conversation, so the
  // instruction is the real issue. It only has to be unique and non-zero.
  comment: {
    id: Date.now(),
    body: `${mention} ${comment}`,
    user: { login: "maintainer", type: "User" },
  },
};

const raw = JSON.stringify(payload);
const delivery = randomUUID();
const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

console.log(`\ntriggering ${repo}#${issue}  (delivery ${delivery})\n`);

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": "issue_comment",
    "x-github-delivery": delivery,
    "x-hub-signature-256": signature,
  },
  body: raw,
});

console.log(`  ${response.status} ${(await response.text()).slice(0, 180)}`);

if (response.status === 202) {
  console.log("\n202 - accepted. A run has started in the background; watch the backend log.");
} else {
  console.log("\nExpected 202. A 200 means a filter ignored it, 401 means verification failed.");
}
