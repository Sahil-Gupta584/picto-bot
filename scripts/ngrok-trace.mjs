/**
 * Reads ngrok's local inspection API for requests it forwarded to us.
 *
 *   node scripts/ngrok-trace.mjs [name-filter]
 *
 * The proxy's exact request body is the one thing that settles how ArmorIQ
 * invokes an MCP server, and ngrok already recorded it.
 */
const filter = process.argv[2] ?? "/mcp/";

const response = await fetch("http://127.0.0.1:4040/api/requests/http?limit=100");
if (!response.ok) {
  console.error("ngrok API returned", response.status, "- is ngrok running?");
  process.exit(1);
}

const { requests } = await response.json();
const matching = requests.filter((request) => request.request?.uri?.includes(filter));

console.log(`\n${requests.length} requests captured, ${matching.length} matching "${filter}"\n`);

for (const request of matching.slice(0, 12)) {
  const req = request.request;
  console.log("─".repeat(70));
  console.log(`${req.method} ${req.uri}  ->  ${request.response?.status?.code ?? "?"}`);
  console.log(`  content-type: ${req.headers?.["content-type"] ?? "(none)"}`);
  console.log(`  accept: ${req.headers?.accept ?? "(none)"}`);
  console.log(`  user-agent: ${(req.headers?.["user-agent"] ?? "").slice(0, 60)}`);

  if (req.raw) {
    const decoded = Buffer.from(req.raw, "base64").toString("utf8");
    console.log(`  body (${decoded.length} bytes):`);
    console.log(`  ${decoded.slice(0, 700)}`);
  } else {
    console.log("  body: (not captured)");
  }
}
