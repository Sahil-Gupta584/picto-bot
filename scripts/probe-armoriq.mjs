/**
 * Minimal proof that the ArmorIQ backend will sign a plan and mint a token.
 * Run: node scripts/probe-armoriq.mjs
 */
import { readFileSync } from "node:fs";
import { ArmorIQClient } from "@armoriq/sdk";

const credsPath = process.env.USERPROFILE + "/.armoriq/credentials.json";
const creds = JSON.parse(readFileSync(credsPath, "utf8"));
const profile = Object.values(creds.profiles ?? {})[0];
const apiKey = profile.apiKey;

console.log(`using profile : ${Object.keys(creds.profiles)[0]}`);
console.log(`key prefix    : ${apiKey.slice(0, 7)}***\n`);

const client = new ArmorIQClient({
  apiKey,
  userId: "ci-bot@sentinel.local",
  agentId: "sentinel-ci-agent",
});

// A plan with exactly two declared actions.
const plan = client.capturePlan(
  "opencode/big-pickle",
  "Fix issue #1 (missing users index) and raise a PR. Do not touch the database.",
  {
    goal: "Add an index migration for the users table and open a draft PR",
    steps: [
      { action: "repo_read_file", mcp: "sentinel-ci", params: { path: "db/schema.sql" } },
      { action: "repo_write_file", mcp: "sentinel-ci", params: { path: "db/migrations/042.sql" } },
    ],
  },
);

console.log("plan captured locally");
console.log("  planHash :", plan.plan?.hash ?? plan.metadata?.hash ?? "(n/a)");
console.log("  steps    :", plan.plan?.steps?.length);

const token = await client.getIntentToken(plan, undefined, 300);

console.log("\n=== ARMORIQ BACKEND RESPONSE ===");
console.log("  tokenId   :", token.tokenId);
console.log("  planHash  :", token.planHash);
console.log("  signature :", token.signature.slice(0, 32) + "...");
console.log("  issuedAt  :", new Date(token.issuedAt * 1000).toISOString());
console.log("  expiresAt :", new Date(token.expiresAt * 1000).toISOString());
console.log("  totalSteps:", token.totalSteps);
console.log("  status    :", token.status ?? "(active)");
console.log("  deniedTools:", [...(token.deniedTools ?? [])].join(", ") || "(none)");
console.log("  heldTools  :", [...(token.heldTools ?? [])].join(", ") || "(none)");
console.log("  stepProofs :", token.stepProofs?.length ?? 0);

client.close();