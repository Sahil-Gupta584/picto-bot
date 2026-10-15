/**
 * Prints one session's transcript, in order, as it was actually sent to the
 * model - including the tool results.
 *
 *   node --env-file=.env scripts/show-session.mjs <session-key>
 *   node --env-file=.env scripts/show-session.mjs            # list sessions
 *
 * When a run does the wrong thing, the answer is in here: what the tool
 * returned, and what the model was told about it. The server log only shows the
 * calls, never the results.
 */
import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.PICTO_DB ?? "./.picto/picto.sqlite";
const db = new DatabaseSync(dbPath);

const argv = process.argv.slice(2);
const brief = argv.includes("--brief");
const tailIndex = argv.indexOf("--tail");
const tail = tailIndex === -1 ? 0 : Number(argv[tailIndex + 1] ?? 0);

const wanted = argv.find((arg) => !arg.startsWith("--") && arg !== String(tail));

if (!wanted) {
  const sessions = db
    .prepare("SELECT key, status, updated_at FROM sessions ORDER BY updated_at DESC")
    .all();
  console.log(`\n${dbPath}\n`);
  for (const s of sessions) console.log(`  ${s.updated_at}  ${String(s.status).padEnd(10)} ${s.key}`);
  console.log("\npass a key to see its transcript\n");
  process.exit(0);
}

const rows = db
  .prepare(
    "SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_key = ? ORDER BY rowid ASC",
  )
  .all(wanted);

if (!rows.length) {
  console.error(`no messages for ${wanted}`);
  process.exit(1);
}

const shown = tail > 0 ? rows.slice(-tail) : rows;

console.log(`\n=== ${wanted} : ${rows.length} messages${tail > 0 ? `, last ${shown.length}` : ""} ===\n`);

// A tool result is often a whole file. Printing it in full buries the shape of
// the run, which is what you are usually looking for.
const clip = (text, limit) =>
  brief && text.length > limit ? `${text.slice(0, limit)} …(+${text.length - limit} chars)` : text;

for (const row of shown) {
  console.log(
    `── ${row.role}${row.tool_call_id ? ` (tool result for ${row.tool_call_id})` : ""} ──`,
  );
  if (row.content) console.log(clip(row.content, 400));
  if (row.tool_calls) {
    const calls = JSON.parse(row.tool_calls);
    console.log(
      `[tool_calls] ${calls.map((call) => `${call.function?.name}(${clip(String(call.function?.arguments ?? ""), 200)})`).join(", ")}`,
    );
  }
  console.log("");
}
