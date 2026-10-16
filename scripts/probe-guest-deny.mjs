/**
 * Where does a denied tool get stopped: at signing, or at the call?
 *
 * Declares a plan containing one tool a policy denies and one it allows, then
 * asks ArmorIQ to sign it. Whichever gate refuses tells us what a guest's
 * create_issue will look like - refused to sign, or signed but blocked at the
 * callsite. The answer decides what the demo claims.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ArmorIQClient } from "@armoriq/sdk";

function apiKey() {
  if (process.env.ARMORIQ_API_KEY) return process.env.ARMORIQ_API_KEY;
  const doc = JSON.parse(readFileSync(path.join(homedir(), ".armoriq", "credentials.json"), "utf8"));
  return Object.values(doc.profiles ?? {})[0].apiKey;
}

const client = new ArmorIQClient({
  apiKey: apiKey(),
  userId: process.env.ARMORIQ_USER_ID ?? "bot@picto.dev",
  agentId: process.env.ARMORIQ_AGENT_ID ?? "picto-agent",
  contextId: "default",
});

const mcp = process.env.ARMORIQ_MCP_FS ?? "Filesystem";
const workspace = process.env.PICTO_PROBE_WORKSPACE ?? "gh-Sahil-Gupta584-opencmo-10-266e1699";

const capture = client.capturePlan("probe", "guest policy probe", {
  goal: "learn where a denied tool is stopped",
  steps: [
    { action: "list_files", mcp },
    { action: "create_issue", mcp },
  ],
});

let token;
try {
  token = await client.getIntentToken(
    capture,
    {
      rules: [
        {
          id: "guest-cannot-open-issues",
          action: "deny",
          tool: "create_issue",
          reason: "guests may not open issues",
        },
      ],
    },
    120,
  );
  console.log("signing: ISSUED");
  console.log("  policyValidation:", JSON.stringify(token.policyValidation ?? null).slice(0, 500));
} catch (e) {
  console.log("signing: REFUSED ->", e?.name, "|", String(e?.message).slice(0, 300));
}

if (token) {
  try {
    const r = await client.invoke(mcp, "create_issue", token, { workspace, title: "probe" });
    console.log("call create_issue: SUCCEEDED?!", JSON.stringify(r.result).slice(0, 200));
  } catch (e) {
    console.log("call create_issue: REFUSED ->", e?.name, "|", String(e?.message).slice(0, 300));
  }
  try {
    await client.invoke(mcp, "list_files", token, { workspace });
    console.log("call list_files: allowed");
  } catch (e) {
    console.log("call list_files: refused ->", e?.name, "|", String(e?.message).slice(0, 200));
  }
}

client.close();
