/**
 * The model adapter.
 *
 * One OpenAI-shaped interface, pointed at any compatible endpoint. Google
 * exposes an OpenAI-compatible surface, so Gemini, OpenAI, OpenRouter and Groq
 * are all a base URL away and the agent has no provider branch in it.
 *
 * A run makes many model calls, one per step, so a single refused call would
 * otherwise end it. Two things stand between a throttled request and a dead run:
 *
 *   retry    the same model is tried again after a backoff, because most 429s
 *            are a rate limit rather than a spent allowance.
 *   fallback when a model will not answer at all, the next model in the chain is
 *            tried. Allowances are counted per model, so a spent one says
 *            nothing about its siblings - and a run needs ten calls, not one.
 */
import { LLM } from "../config.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** From a Retry-After header, when the provider bothered to send one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Whether a failed call is worth repeating against the same model.
 *
 * 429 and 5xx mean the request was understood and refused for now: the same
 * bytes may well work a second later. Errors with no status at all - connection
 * reset, timeout, empty body - are the most transient of the lot.
 */
function isTransient(error: LlmError): boolean {
  const status = error.status;
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Whether the model itself is the problem, rather than the request.
 *
 * Providers are inconsistent about this: an unknown or retired model comes back
 * as 404 from the OpenAI-compatible surface and as 400 from Google's own. Both
 * mean "not this model", so both advance the chain rather than failing the run.
 * A 400 that does not mention the model is our bug, and repeating it against
 * four models just produces the same error four times.
 */
function isModelUnavailable(error: LlmError): boolean {
  if (error.status === 404) return true;
  return error.status === 400 && /model/i.test(error.message);
}

/**
 * Whether to abandon this model and move along the chain immediately.
 *
 * A 404 means the name is wrong. A 429 or a 503 means the model is refusing
 * everyone right now - throttled, out of allowance, or, in Google's words,
 * "experiencing high demand". The next model has its own allowance and its own
 * capacity, so moving on answers sooner than waiting does. Only the last model
 * in the chain is worth waiting for, because there is nowhere else to go.
 */
function shouldSkipModel(error: LlmError, hasAlternative: boolean): boolean {
  if (isModelUnavailable(error)) return true;
  return hasAlternative && (error.status === 429 || error.status === 503);
}

/** Exponential backoff, capped, with jitter so parallel runs do not sync up. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  // Capped: a spent daily quota can ask for an hour, and waiting an hour inside
  // a run is worse than moving on and saying so.
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  return undefined;
}

/** One attempt against one model. The policy lives in `chat`. */
async function once(
  input: {
    messages: ChatMessage[];
    tools?: ChatTool[];
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  },
  model: string,
): Promise<ChatMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000);

  try {
    const response = await fetch(`${LLM.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${LLM.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        ...(input.tools && input.tools.length > 0
          ? { tools: input.tools, tool_choice: "auto" }
          : {}),
        temperature: input.temperature ?? 0,
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new LlmError(
        `model ${model} returned ${response.status}: ${body.slice(0, 400)}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    const parsed = JSON.parse(body) as {
      choices?: Array<{ message?: ChatMessage }>;
    };
    const message = parsed.choices?.[0]?.message;
    if (!message) throw new LlmError(`model ${model} returned no message: ${body.slice(0, 300)}`);
    return message;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new LlmError(`model ${model} timed out after ${(input.timeoutMs ?? 120_000) / 1000}s`);
    }
    // A connection error arrives as a TypeError with no status. Re-throw it as an
    // LlmError so the policy sees it as transient rather than as a crash in the
    // agent loop.
    if (!(err instanceof LlmError)) {
      throw new LlmError(`model ${model} request failed: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(input: {
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<ChatMessage> {
  if (!LLM.apiKey) {
    throw new LlmError(
      "No LLM key configured. Set LLM_API_KEY (and LLM_BASE_URL, LLM_MODEL) in .env.",
    );
  }

  const models = [LLM.model, ...LLM.fallbacks.filter((name) => name !== LLM.model)];
  const maxAttempts = Math.max(1, Number(process.env.LLM_MAX_ATTEMPTS ?? 3));

  let lastError: LlmError | undefined;

  for (const [index, model] of models.entries()) {
    const isLastModel = index === models.length - 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await once(input, model);
      } catch (err) {
        const error = err instanceof LlmError ? err : new LlmError(String(err));
        lastError = error;

        if (!isTransient(error) && !isModelUnavailable(error)) throw error;

        if (shouldSkipModel(error, !isLastModel)) {
          if (isLastModel) break;
          console.warn(
            `[llm] ${model} ${error.status ?? "connection error"} - ` +
              `trying ${models[index + 1]}`,
          );
          break;
        }

        // Out of attempts. Nothing left to wait for, so stop and report.
        if (attempt === maxAttempts) break;

        const wait = error.retryAfterMs ?? backoffMs(attempt);
        console.warn(
          `[llm] ${model} ${error.status ?? "connection error"} - attempt ` +
            `${attempt}/${maxAttempts}, retrying in ${(wait / 1000).toFixed(1)}s`,
        );
        await sleep(wait);
      }
    }
  }

  if (lastError && models.length > 1) {
    // Naming every model tried is the difference between "the model failed" and
    // knowing the account is out of allowance across the board.
    lastError = new LlmError(
      `${lastError.message}\n\nModels tried: ${models.join(", ")}`,
      lastError.status,
    );
  }
  throw lastError ?? new LlmError("No model configured. Set LLM_MODEL in .env.");
}

/** Tool call arguments arrive as a JSON string. A malformed one is a model bug, not a crash. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(`tool call arguments were not valid JSON: ${raw.slice(0, 200)}`);
  }
}
