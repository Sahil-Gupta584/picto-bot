/**
 * The Slack message a human decides on.
 *
 * Two rules shape this:
 *
 *   The message must be readable by someone who has not read our source. It says
 *   what was attempted, in which server, and why ArmorIQ refused - not "HOLD".
 *
 *   The buttons must carry something small and opaque. Slack caps a button value
 *   at 2000 characters, so the arguments never travel in the button. The button
 *   carries the approval id and the server looks the rest up, which also means a
 *   tampered button cannot smuggle in a different action.
 */
import type { ApprovalRecord } from "../sessions/store.js";

export interface ApprovalMessageInput {
  id: string;
  action: string;
  mcp: string;
  args: Record<string, unknown>;
  reason: string;
  code: string;
  sessionKey: string;
}

export interface SlackMessage {
  channel: string;
  text: string;
  blocks: unknown[];
}

/** Build the message asking for a decision. */
export function approvalBlocks(input: ApprovalMessageInput): { text: string; blocks: unknown[] } {
  const args = JSON.stringify(input.args, null, 2);
  const trimmed = args.length > 600 ? `${args.slice(0, 600)}\n... (truncated)` : args;

  return {
    // Shown in the sidebar and in notifications, where blocks are not rendered.
    text: `ArmorIQ blocked \`${input.action}\` on ${input.mcp} - approval needed`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "⛔ ArmorIQ blocked an action", emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Action*\n\`${input.action}\`` },
          { type: "mrkdwn", text: `*MCP server*\n\`${input.mcp}\`` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Why*\n${input.reason}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Arguments*\n\`\`\`${trimmed}\`\`\`` },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `${describeSession(input.sessionKey)}  ·  enforcement: \`${input.code}\`` },
        ],
      },
      {
        type: "actions",
        block_id: "picto_decision",
        elements: [
          {
            type: "button",
            action_id: "picto_approve",
            style: "primary",
            text: { type: "plain_text", text: "Approve", emoji: true },
            value: input.id,
          },
          {
            type: "button",
            action_id: "picto_deny",
            style: "danger",
            text: { type: "plain_text", text: "Deny", emoji: true },
            value: input.id,
          },
        ],
      },
    ],
  };
}

/** Replace the buttons with the outcome, so a decision cannot be clicked twice. */
export function resolvedBlocks(
  approval: ApprovalRecord,
  decidedBy: string,
  approved: boolean,
): { text: string; blocks: unknown[] } {
  const outcome = approved ? "Approved" : "Denied";
  return {
    text: `${outcome}: ${approval.action} on ${approval.mcp} (by ${decidedBy})`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: approved ? "✅ Approved — resuming" : "🚫 Denied — stopping",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`${approval.action}\` on \`${approval.mcp}\` was *${outcome.toLowerCase()}* by *${decidedBy}*.`,
        },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Why it was blocked*\n${approval.reason}` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `${describeSession(approval.sessionKey)}  ·  \`${approval.code}\`  ·  approval \`${approval.id.slice(0, 8)}\``,
          },
        ],
      },
    ],
  };
}

/**
 * A session key, in words a person recognises.
 *
 *   gh:acme/site#42                  ->  acme/site#42
 *   slack:C123:thread:1777244748.7   ->  Slack thread in C123
 */
export function describeSession(key: string): string {
  if (key.startsWith("gh:")) return `GitHub ${key.slice(3)}`;
  if (key.startsWith("slack:")) {
    const [, channel, , thread] = key.split(":");
    return thread && thread !== "root"
      ? `Slack thread in ${channel}`
      : `Slack channel ${channel}`;
  }
  return key;
}
