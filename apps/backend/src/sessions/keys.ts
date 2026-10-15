/**
 * Session keys.
 *
 * A session is a conversation, not a message. The key is derived from where the
 * conversation lives, so every later message in that same place lands on the
 * session that already exists instead of starting an amnesiac new one.
 *
 * This follows the same shape OpenClaw uses - a structured key, scoped to the
 * place the conversation happens:
 *
 *   agent:<agentId>:slack:channel:<channelId>[:thread:<threadTs>]
 *
 * Ours, for the two places this agent is spoken to:
 *
 *   gh:Sahil-Gupta584/opencmo#1        one issue is one conversation
 *   slack:C0C8YCKL93R:thread:17...     one Slack thread is one conversation
 *   slack:C0C8YCKL93R:root             the channel itself, outside any thread
 */
import { createHash } from "node:crypto";

export type SessionSource = "github" | "slack" | "local";

export interface SessionRef {
  key: string;
  source: SessionSource;
  /** owner/name, for GitHub sessions. */
  repo?: string;
  issue?: number;
  /** Slack channel id. */
  channel?: string;
  /** Slack thread root timestamp, or "root" for the channel itself. */
  thread?: string;
}

export function githubSession(repo: string, issue: number): SessionRef {
  return { key: `gh:${repo}#${issue}`, source: "github", repo, issue };
}

export function slackSession(channel: string, threadTs?: string): SessionRef {
  const thread = threadTs && threadTs.trim() ? threadTs.trim() : "root";
  return { key: `slack:${channel}:thread:${thread}`, source: "slack", channel, thread };
}

export function localSession(name: string): SessionRef {
  return { key: `local:${name}`, source: "local" };
}

/**
 * A session key is a name for a conversation, not a directory name.
 *
 * It contains `/`, `#` and `:` - which is fine for a key and wrong for a path.
 * The hash suffix keeps two different keys that sanitise to the same string
 * apart, so one conversation can never end up reading another one's checkout.
 */
export function safeWorkspaceId(sessionKey: string): string {
  const cleaned = sessionKey
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 8);
  return `${cleaned || "session"}-${hash}`;
}
