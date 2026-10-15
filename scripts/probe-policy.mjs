/**
 * Answers the two questions that decide the demo, without needing a registered
 * MCP server:
 *
 *   1. does a policy of `deny` produce a hard BLOCK?
 *   2. does a policy of `require_approval` produce a HOLD (not a block)?
 *
 * If enforcement happens at the proxy before routing to the MCP, both answers
 * come back here. If not, we will see a routing error instead - which is itself
 * the answer.
 *
 *   node scripts/probe-policy.mjs
 */
import { ArmorIQClient } from "@armoriq/sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function apiKey() {
  const doc = JSON.parse(
    readFileSync(path.join(homedir(), ".armoriq", "credentials.json"), "utf8"),
  );
  return Object.values(doc.profiles ?? {})[0].apiKey;
}

const MCP = "picto-repo";
const ACTION = "push_main";

const plan = {
  goal: "Land the rate-limit fix directly on main",
  steps: [
    {
      action: ACTION,
      mcp: MCP,
      params: { workspace: "probe", reason: "maintainer asked for no PR" },
      description: "Push straight to the default branch",
    },
  ],
};

async function attempt(label, policy) {
  const client = new ArmorIQClient({
    apiKey: apiKey(),
    userId: "bot@picto.dev",
    agentId: "picto-agent",
    contextId: "default",
  });

  console.log(`\n=== ${label} ===`);
  console.log("policy:", JSON.stringify(policy));

  try {
    const capture = client.capturePlan("gpt-4.1-mini", "land the fix on main", plan);
    const token = await client.getIntentToken(capture, policy, 300);
    console.log("token      :", token.tokenId);
    console.log("plan hash  :", String(token.planHash).slice(0, 32) + "...");
    console.log("steps      :", token.totalSteps);
    console.log("proofs     :", token.stepProofs?.length ?? 0);
    console.log("policyValidation:", JSON.stringify(token.policyValidation));

    try {
      const result = await client.invoke(MCP, ACTION, token, {
        workspace: "probe",
        reason: "maintainer asked for no PR",
      });
      const text = JSON.stringify(result.result ?? {}).slice(0, 200);
      console.log("OUTCOME    : ALLOWED");
      console.log("result     :", text);
    } catch (err) {
      console.log("OUTCOME    :", err.name);
      console.log("message    :", String(err.message).slice(0, 400));
      if (err.response?.data?.enforcement) {
        console.log("enforcement:", JSON.stringify(err.response.data.enforcement));
      }
      if (err.response?.data?.message) {
        console.log("backend msg:", String(err.response.data.message).slice(0, 240));
      }
    }
  } catch (err) {
    console.log("TOKEN STEP FAILED:", err.name, String(err.message).slice(0, 300));
  }
  client.close?.();
}

// 1. Nothing declared - what does the backend do by default?
await attempt("baseline - no policy", undefined);

// 2. Absolute deny.
await attempt("deny", {
  rules: [{ id: "block-push-main", action: "deny", tool: ACTION }],
});

// 3. The one the Slack flow depends on.
await attempt("require_approval", {
  rules: [{ id: "hold-push-main", action: "require_approval", tool: ACTION }],
});

process.exit(0);
