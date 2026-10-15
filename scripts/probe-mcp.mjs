/**
 * Connects to the running backend as an MCP client and lists the tools on each
 * MCP server. This is the same handshake ArmorIQ's proxy performs.
 *
 *   node scripts/probe-mcp.mjs [baseUrl]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const endpoints = ["/mcp/fs", "/mcp/repo"];

let failures = 0;

for (const endpoint of endpoints) {
  const client = new Client({ name: "picto-probe", version: "0.0.1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(base + endpoint)));
    const { tools } = await client.listTools();
    console.log(`\n${endpoint}  ->  ${tools.length} tools`);
    for (const tool of tools) {
      const params = Object.keys(tool.inputSchema?.properties ?? {}).join(", ");
      console.log(`   ${tool.name}(${params})`);
    }
    await client.close();
  } catch (error) {
    failures += 1;
    console.log(`\n${endpoint}  ->  FAILED: ${error.message}`);
  }
}

const health = await fetch(`${base}/health`).then((r) => r.json());
console.log(`\n/health -> ${JSON.stringify(health)}`);
process.exit(failures === 0 ? 0 : 1);
