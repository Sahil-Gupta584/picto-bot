/**
 * Prints an issue the way the maintainer sees it.
 *
 *   node --env-file=.env scripts/issue-log.mjs
 *   node --env-file=.env scripts/issue-log.mjs Sahil-Gupta584/opencmo 1
 *
 * The agent's user-visible surface is the issue: the note it posts, the note it
 * edits as it works, the report it finishes with, or the failure it has to
 * admit. None of that is in our session store, and the server log is the wrong
 * place to look for it - so this reads it back from GitHub.
 *
 * Authenticates as the App, so it sees exactly what the App can see.
 */
import { App } from "octokit";

const appId = process.env.GITHUB_APP_ID;
const privateKeyB64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;

if (!appId || !privateKeyB64) {
  console.error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_B64 are required.");
  process.exit(1);
}

const [repoArg, issueArg] = process.argv.slice(2);
const target = repoArg ?? process.env.GITHUB_REPO;
const issueNumber = Number(issueArg ?? 1);

if (!target?.includes("/")) {
  console.error("Pass owner/repo or set GITHUB_REPO.");
  process.exit(1);
}

const [owner, repo] = target.split("/");

const app = new App({
  appId,
  privateKey: Buffer.from(privateKeyB64, "base64").toString("utf8"),
});

const installationId =
  process.env.GITHUB_APP_INSTALLATION_ID ||
  String(
    (
      await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
        owner,
        repo,
      })
    ).data.id,
  );

const octokit = await app.getInstallationOctokit(Number(installationId));

const { data: issue } = await octokit.rest.issues.get({
  owner,
  repo,
  issue_number: issueNumber,
});

console.log(`\n═══ ${target}#${issueNumber} — ${issue.title} ═══`);
console.log(`state: ${issue.state}   by: ${issue.user?.login ?? "?"}\n`);
if (issue.body) console.log(`${issue.body.trim()}\n`);

const comments = await octokit.paginate(octokit.rest.issues.listComments, {
  owner,
  repo,
  issue_number: issueNumber,
  per_page: 100,
});

console.log(`── ${comments.length} comment(s) ──\n`);
for (const comment of comments) {
  console.log(`┌ ${comment.user?.login ?? "?"}  ${comment.created_at ?? ""}  #${comment.id}`);
  console.log(
    `${(comment.body ?? "")
      .trim()
      .split("\n")
      .map((line) => `│ ${line}`)
      .join("\n")}\n`,
  );
}
