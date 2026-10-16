/**
 * Which policy rule shape does ArmorIQ actually honour?
 *
 * Four candidate vocabularies against one harmless tool (list_files). For
 * each: does issuance mark it denied, and does a real invoke get stopped?
 * Whatever shape comes back honoured is the one the role-gate is built from.
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

const shapes = [
  { label: "deny", rule: { id: "p-deny", action: "deny", tool: "list_files", reason: "probe" } },
  { label: "block", rule: { id: "p-block", action: "block", tool: "list_files", reason: "probe" } },
  { label: "hold", rule: { id: "p-hold", action: "hold", tool: "list_files", reason: "probe" } },
  {
    label: "require_approval",
    rule: { id: "p-req", action: "require_approval", tool: "list_files", reason: "probe" },
  },
];

for (const shape of shapes) {
  const line = `[${shape.label}]`;
  let i = 0;
  const capture = client.capturePlan("probe", `vocab probe ${shape.label}`, {
    goal: `vocab ${shape.label} #${++i}`,
    steps: [{ action: "list_files", mcp }],
  });
  let token;
  try {
    token = await client.getIntentToken(capture, { rules: [shape.rule] }, 120);
  } catch (e) {
    console.log(line, "signing REFUSED ->", e?.name, "|", String(e?.message).slice(0, 200));
    continue;
  }
  const pv = token.policyValidation ?? {};
  console.log(
    line,
    "signing OK  allowed=", JSON.stringify(pv.allowed_tools),
    " denied=", JSON.stringify(pv.denied_tools),
    " matched=", JSON.stringify(pv.matched_policies),
  );
  try {
    await client.invoke(mcp, "list_files", token, { workspace });
    console.log(line, "invoke: ALLOWED");
  } catch (e) {
    console.log(line, "invoke: STOPPED ->", e?.name, "|", String(e?.message).slice(0, 200));
  }
}

client.close();
