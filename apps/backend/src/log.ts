/**
 * What the terminal is allowed to say.
 *
 * A run calls every tool it uses, and the SDK narrates each one - the action, the
 * proof that was attached to it, the round trip. Six of those lines per tool, with
 * a JSON dump of the arguments on top, buries the two lines that actually matter:
 * the action ArmorIQ refused, and the approval that went out to Slack.
 *
 * So: the SDK's narration is dropped, tool arguments are never printed, and a
 * refusal or an approval is the loudest thing on the screen.
 */
import type { RunEvent } from "./agent/index.js";

/** One line of the SDK's per-invocation narration. See node_modules/@armoriq/sdk. */
const SDK_CHATTER = [
  /^Invoking MCP action:/,
  /^Using Merkle proof from CSRG-IAP/,
  /^MCP invocation (succeeded|failed)/,
  /^Proxy request to/,
  /^Merkle proof/,
];

/** How much of a refusal reason is worth reading in a terminal. */
const REASON_CHARS = 160;

/**
 * Drop the SDK's narration, keeping every other line exactly as it was.
 *
 * The SDK writes straight to `console.log`, so there is no logger to configure and
 * no way to ask it to be quiet. Silencing it from here is the only handle - and it
 * has to be a prefix match, because a run's own lines are what the operator is
 * actually watching.
 */
export function quietSdkChatter(): void {
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    const first = parts[0];
    if (typeof first === "string" && SDK_CHATTER.some((pattern) => pattern.test(first))) return;
    original(...parts);
  };
}

/** Collapse to one line, because a reason that wraps is a reason nobody reads. */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The line for one run event, or null when the event is not worth a line.
 *
 * The tool *call* is deliberately silent: the allowed/blocked line that follows it
 * carries the same name and adds the verdict and the timing. Printing both is how
 * a run ends up as forty lines for four actions.
 */
export function describeEvent(event: RunEvent, sessionKey: string): string | null {
  const at = `[picto] ${sessionKey}`;
  switch (event.type) {
    case "session":
      return `${at}  run   ${event.reusedWorkspace ? "resumed" : "new conversation"} · ${
        event.priorMessages
      } prior message(s)`;

    case "planned":
      return `${at}  plan  ${event.steps.length} step(s) signed ${event.planHash.slice(0, 12)} · ${
        event.steps.join(", ")
      }${event.refused.length ? ` · not declared: ${event.refused.join(", ")}` : ""}`;

    case "tool":
      return null;

    case "allowed":
      return `${at}  ok    ${event.name} on ${event.mcp} (${secs(event.ms)})`;

    case "blocked":
      return `${at}  BLOCK ${event.name} on ${event.mcp} — ${event.code}\n         ${brief(
        event.reason,
      )}`;

    case "held":
      return `${at}  HOLD  ${event.name} on ${event.mcp} — ${event.code}\n         ${brief(
        event.reason,
      )}`;

    case "approval_requested":
      return `${at}  SLACK approval sent for ${event.name} (${event.approvalId.slice(
        0,
        8,
      )}) — waiting for a human`;

    case "approved":
      return `${at}  APPROVED ${event.name} by ${event.by}`;

    case "denied":
      return `${at}  DENIED  ${event.name} by ${event.by}`;

    case "replanned":
      return `${at}  replan ${event.planHash.slice(0, 12)} · ${event.steps.join(", ")}`;

    case "pushed":
      return `${at}  push  ${event.target}${event.url ? ` → ${event.url}` : ""}`;

    case "reply":
      return `${at}  reply ${brief(event.text)}`;

    case "nudge":
      return `${at}  nudge ${brief(event.text)}`;

    case "error":
      return `${at}  ERROR ${brief(event.message)}`;

    default:
      return null;
  }
}