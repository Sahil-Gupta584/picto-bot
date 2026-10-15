/**
 * Makes one real, read-only, governed invocation through ArmorIQ's proxy so the
 * server records what the proxy actually forwards to the MCP endpoint.
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

const name = process.env.ARMORIQ_MCP_FS ?? "picto-fs";

try {
  const capture = client.capturePlan("probe", "trace probe", {
    goal: "trace what the proxy forwards",
    steps: [{ action: "list_files", mcp: name }],
  });
  const token = await client.getIntentToken(capture);
  const result = await client.invoke(name, "list_files", token, {
    workspace: "trace-probe",
    depth: 1,
  });
  console.log("OK:", JSON.stringify(result.result).slice(0, 300));
} catch (err) {
  console.log("threw:", err?.name, "| status", err?.statusCode, "|", err?.message);
}

client.close();
