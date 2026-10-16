/**
 * All configuration comes from the environment. Nothing is read from disk at
 * runtime except the ArmorIQ credential file, which is written by `armoriq login`
 * and is the documented way to hold that key locally.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repository root, taken from this file's location rather than from the
 * working directory.
 *
 * `npm run dev` and `npm start` execute with cwd=apps/backend, while
 * `node --env-file=.env apps/backend/dist/index.js` executes with cwd=the repo
 * root. Anchoring the database and the workspaces to the working directory
 * therefore gave those two ways of starting the SAME process two different
 * databases - so sessions and approvals silently appeared or vanished depending
 * on how you launched it. `src/` and `dist/` both sit one level under
 * apps/backend, so this resolves identically in development and production.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * The ArmorIQ API key. Prefer the env var; fall back to the credential file that
 * `armoriq login` writes so local setup needs no extra step.
 */
export function armorIqApiKey(): string {
  const fromEnv = process.env.ARMORIQ_API_KEY;
  if (fromEnv) return fromEnv;

  for (const candidate of [
    path.join(homedir(), ".armoriq", "credentials.json"),
    path.join(process.env.USERPROFILE ?? "", ".armoriq", "credentials.json"),
  ]) {
    try {
      const doc = JSON.parse(readFileSync(candidate, "utf8")) as {
        profiles?: Record<string, { apiKey?: string }>;
      };
      const first = Object.values(doc.profiles ?? {})[0];
      if (first?.apiKey) return first.apiKey;
    } catch {
      /* try the next location */
    }
  }
  throw new Error("No ArmorIQ API key. Run `armoriq login` or set ARMORIQ_API_KEY.");
}

/**
 * Where per-session working copies live. One directory per conversation, reused
 * by later turns and swept once the conversation goes cold.
 *
 * A relative value resolves against the repository root; an absolute one is
 * used as given.
 */
export const WORKSPACES_ROOT = process.env.PICTO_WORKSPACES
  ? path.resolve(REPO_ROOT, process.env.PICTO_WORKSPACES)
  : path.join(REPO_ROOT, ".workspaces");

/**
 * The session database.
 *
 * Sessions and their transcripts outlive the process, for the same reason they
 * do in any chat system: a maintainer who replies "no, do it the other way"
 * expects to be understood, and an approval that is waiting in Slack must still
 * be there after a restart.
 */
export const DB_PATH = process.env.PICTO_DB
  ? path.resolve(REPO_ROOT, process.env.PICTO_DB)
  : path.join(REPO_ROOT, ".picto", "picto.sqlite");

/** Public base URL of this server, e.g. https://picto.fly.dev */
export const MCP_PUBLIC_URL = process.env.PICTO_PUBLIC_URL ?? "http://127.0.0.1:8787";

/**
 * The names ArmorIQ routes by.
 *
 * `client.invoke(mcp, ...)` puts this string in the request body as `payload.mcp`
 * and the proxy looks it up among the MCP servers registered for the org. If it
 * matches nothing, the proxy has nowhere to send the call and answers 500 - which
 * the SDK reports as `MCP invocation failed: [object Object]`. The only symptom is
 * an agent that quietly cannot use any of its tools and blames itself.
 *
 * Registration happens in the dashboard, so these names are a deployment detail,
 * not a constant. They must match exactly what is registered.
 */
export const MCP = {
  fs: process.env.ARMORIQ_MCP_FS ?? "picto-fs",
  repo: process.env.ARMORIQ_MCP_REPO ?? "picto-repo",
};

export const PORT = Number(process.env.PORT ?? 8787);

/** The identity ArmorIQ records for this agent. */
export const IDENTITY = {
  agentId: process.env.ARMORIQ_AGENT_ID ?? "picto-agent",
  userId: process.env.ARMORIQ_USER_ID ?? "bot@picto.dev",
  contextId: "default",
};

export const GITHUB = {
  appId: process.env.GITHUB_APP_ID ?? "",
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  /** owner/repo the agent is allowed to work on, per install. */
  repo: process.env.GITHUB_REPO ?? "",
  /** App private key, base64. Empty in local dev - falls back to a file. */
  privateKeyB64: process.env.GITHUB_APP_PRIVATE_KEY_B64 ?? "",
  /**
   * The app's own @handle. A comment must mention it to start a run, so the
   * agent does not answer every message on every issue it can see.
   */
  mention: process.env.GITHUB_MENTION ?? "@picto-bot",
  /** Optional: pin to one installation instead of resolving it per event. */
  installationId: process.env.GITHUB_APP_INSTALLATION_ID ?? "",
};

export const SLACK = {
  botToken: process.env.SLACK_BOT_TOKEN ?? "",
  channel: process.env.SLACK_CHANNEL ?? "",
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  /**
   * The repository a conversation on Slack works on, owner/name.
   *
   * A mention does not name a repository the way an issue does, so the channel
   * is bound to one. Falls back to GITHUB_REPO, which is already the repository
   * the local scripts default to.
   */
  repo: process.env.PICTO_SLACK_REPO ?? process.env.GITHUB_REPO ?? "",
  /**
   * Who may command the agent, written as @handles or member IDs.
   *
   * Handles are how people know each other, but they are only input: the list
   * is resolved to immutable member IDs the first time it is needed, and every
   * decision after that compares IDs. A handle can be renamed and a display
   * name can be imitated; the ID cannot. Workspace admins and owners always
   * count as maintainers - this list only adds people Slack does not already
   * trust with the workspace.
   */
  maintainers: (process.env.PICTO_MAINTAINERS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
};

/**
 * One OpenAI-compatible adapter covers OpenAI, OpenRouter, Groq, Together and
 * Google's OpenAI-compatible endpoint, so the provider is a config change and
 * not a code change.
 */
export const LLM = {
  baseUrl: process.env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  model: process.env.LLM_MODEL ?? "gemini-3.5-flash-lite",
  /**
   * Models to try, in order, if the one above will not answer. Comma-separated.
   *
   * A run is a dozen or more model calls, and a free allowance is counted per
   * model. When one model's quota is spent its siblings' are not, so a run that
   * would otherwise die mid-task continues on the next name in this list. That
   * matters far more than retrying the exhausted one.
   *
   * Kept in configuration rather than in code for the same reason the MCP names
   * are: which models exist is a property of the account, not of the agent.
   */
  fallbacks: (process.env.LLM_FALLBACK_MODELS ?? "gemini-3.1-flash-lite")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
};

export function assertGithubConfigured(): void {
  required("GITHUB_APP_ID");
}
