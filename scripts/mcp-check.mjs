/**
 * Shows which MCP servers ArmorIQ has registered for this org, and whether the
 * two this deployment serves are among them.
 *
 *   node --env-file=.env scripts/mcp-check.mjs
 *
 * Registration happens in the ArmorIQ dashboard, not from here - the SDK API key
 * is refused by POST /mcp/register, which wants a dashboard access token. So this
 * reports; it does not fix.
 *
 * Worth knowing because an unregistered MCP does not fail loudly. The proxy has
 * nowhere to route the call, returns 500, and the SDK collapses that into
 * "MCP invocation failed: [object Object]" - which is what the agent then
 * apologises to the user about.
 */
import { ArmorIQClient } from "@armoriq/sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function apiKey() {
  if (process.env.ARMORIQ_API_KEY) return process.env.ARMORIQ_API_KEY;
  for (const candidate of [
    path.join(homedir(), ".armoriq", "credentials.json"),
    path.join(process.env.USERPROFILE ?? "", ".armoriq", "credentials.json"),
  ]) {
    try {
      const doc = JSON.parse(readFileSync(candidate, "utf8"));
      const first = Object.values(doc.profiles ?? {})[0];
      if (first?.apiKey) return first.apiKey;
    } catch {
      /* try the next location */
    }
  }
  throw new Error("No ArmorIQ API key. Run `armoriq login` or set ARMORIQ_API_KEY.");
}

const client = new ArmorIQClient({
  apiKey: apiKey(),
  userId: process.env.ARMORIQ_USER_ID ?? "bot@picto.dev",
  agentId: process.env.ARMORIQ_AGENT_ID ?? "picto-agent",
  contextId: "default",
});

let mcps = [];
try {
  mcps = await client.listMcps();
} catch (err) {
  console.error("\nlistMcps failed.");
  console.error("  name       ", err?.name);
  console.error("  message    ", err?.message);
  console.error("  statusCode ", err?.statusCode);
  console.error("  code       ", err?.code);
  process.exit(1);
}

console.log(`\nregistered MCPs for this org: ${mcps.length}\n`);
for (const mcp of mcps) console.log(" ", JSON.stringify(mcp));

const publicUrl = (process.env.PICTO_PUBLIC_URL ?? "").replace(/\/$/, "");

const expected = [
  { name: process.env.ARMORIQ_MCP_FS ?? "picto-fs", path: "/mcp/fs" },
  { name: process.env.ARMORIQ_MCP_REPO ?? "picto-repo", path: "/mcp/repo" },
];

console.log("");
const stale = [];
for (const wanted of expected) {
  const found = mcps.find((mcp) => mcp?.name === wanted.name || mcp?.mcpId === wanted.name);
  if (!found) {
    console.log(`  MISSING  ${wanted.name}  nothing is registered under that name`);
    continue;
  }
  console.log(`  OK       ${wanted.name}  ${found.url}`);

  // A registration outlives the tunnel. ngrok hands out a new hostname on
  // restart, and the dashboard keeps pointing at the old one - so every invoke
  // 500s at the proxy while everything on this side looks healthy.
  const current = `${publicUrl}${wanted.path}`;
  if (publicUrl && found.url !== current) {
    stale.push(wanted.name);
    console.log(`           -> registered URL is stale. this deployment now serves\n              ${current}`);
  }
}

if (stale.length) {
  console.log(
    `\n  -> ${stale.join(", ")}: why every invoke() 500s at the proxy. Point the\n` +
      `     ArmorIQ dashboard at the URL above after each tunnel restart.\n`,
  );
} else if (!mcps.length) {
  console.log(
    "  -> Neither server is registered. Every invoke() will 500 at the proxy,\n" +
      "     because there is nothing for it to route the call to.\n",
  );
}

client.close();
