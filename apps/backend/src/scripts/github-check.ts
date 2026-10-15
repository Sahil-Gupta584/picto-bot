/**
 * Verify the GitHub App: where it is installed, what it may do, and whether it
 * can actually write.
 *
 *   npm run github:check -w @picto/app
 */
import { PictoApp } from "@picto/agent-core";

const repo = process.env.GITHUB_REPO ?? "";

const github = new PictoApp();

const installs = await github.installations();
console.log("installations :");
for (const i of installs) {
  console.log(
    `   #${i.id}  ${i.targetType.padEnd(12)} ${i.account.padEnd(20)} repos=${i.repositorySelection}`,
  );
}
if (installs.length === 0) {
  console.log("   (none — install the app first)");
}

const installationId = await github.installationFor(repo);
const octokit = await github.forInstallation(installationId);

const me = await octokit.rest.apps.getAuthenticated();
const identity = me.data as { slug?: string; name?: string } | null;
console.log(`\nacting as     : ${identity?.slug ?? identity?.name ?? "?"}[bot]`);
console.log(`installation  : ${installationId}`);

const repos = await github.repositories(installationId);
console.log(`repositories  : ${repos.length}`);
for (const r of repos) console.log(`   ${r}${r === repo ? "   <- GITHUB_REPO" : ""}`);

const [owner, name] = repo.split("/");
const issue = await octokit.rest.issues.get({
  owner: owner ?? "",
  repo: name ?? "",
  issue_number: 1,
});
console.log(`\nissue #${issue.data.number}    : ${issue.data.title}`);
console.log(`   author     : ${issue.data.user?.login ?? "-"}`);
console.log(`   comments   : ${issue.data.comments}`);
