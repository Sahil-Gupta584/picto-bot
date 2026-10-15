/**
 * Asks the model endpoint about each configured model, one tiny request apiece.
 *
 *   node --env-file=.env scripts/probe-models.mjs
 *   node --env-file=.env scripts/probe-models.mjs gemini-2.0-flash gemini-2.5-pro
 *
 * Worth running before a demo. `LLM_FALLBACK_MODELS` only helps if the names in
 * it are real and usable on this key: a name that does not exist is skipped, and
 * a name whose allowance is spent is exactly the case it exists for. Neither is
 * visible from inside the agent, which reports only that the run failed.
 *
 * One token per model, so this costs almost nothing.
 */
const baseUrl = (process.env.LLM_BASE_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.LLM_API_KEY;

if (!baseUrl || !apiKey) {
  console.error("LLM_BASE_URL and LLM_API_KEY are required (run with --env-file=.env).");
  process.exit(1);
}

const configured = [
  process.env.LLM_MODEL,
  ...(process.env.LLM_FALLBACK_MODELS ?? "").split(","),
]
  .map((name) => (name ?? "").trim())
  .filter(Boolean);

const models = process.argv.slice(2).length > 0 ? process.argv.slice(2) : configured;

console.log(`\n${baseUrl}\n`);

for (const model of models) {
  const started = Date.now();
  let status;
  let detail;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      // A probe that can hang is worse than no probe: an unavailable model can
      // sit on the connection rather than answering.
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    status = response.status;
    detail = (await response.text()).replace(/\s+/g, " ").slice(0, 150);
  } catch (error) {
    status = "ERR";
    detail = `${error.name}: ${error.message}`.slice(0, 150);
  }

  const ms = Date.now() - started;
  const verdict =
    status === 200
      ? "usable"
      : status === 429
        ? "RATE/QUOTA - this is what the fallback list is for"
        : status === 404
          ? "no such model - remove it"
          : "check";

  console.log(`${String(status).padEnd(4)} ${model.padEnd(26)} ${String(ms).padStart(6)}ms  ${verdict}`);
  if (status !== 200) console.log(`     ${detail}\n`);
}
