/**
 * Turning a GitHub issue into something the agent can actually act on.
 *
 * GitHub's `issue_comment` webhook contains the comment, plus a *stub* of the
 * issue - number and title, but no body, and none of the earlier conversation.
 * A run built from the payload alone therefore opens with "sounds good, please
 * do that" and has no idea what "that" refers to. That is the bug this file
 * exists to prevent.
 *
 * So the context is fetched, never assumed:
 *
 *   title + body   the request itself. Always included, every run. It is short,
 *                  and it is the specification - a resumed conversation should
 *                  not drift away from what the issue actually asks for.
 *   comments       the conversation. On first contact, all of them. Afterwards,
 *                  only the ones this session has not already been shown, so a
 *                  resumed run is not handed a transcript it already has.
 */
import type { SessionStore } from "../sessions/store.js";

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  author: string;
  url: string;
  comments: IssueComment[];
  /** The comment that caused this run, if a comment is what caused it. */
  triggerCommentId?: number;
}

export interface BuiltInstruction {
  instruction: string;
  /** Write this back to the session so the next run knows what has been seen. */
  lastCommentId: number | null;
}

/**
 * Compose the instruction for one run.
 *
 * `seenCommentId` is what this session was last shown. Pass the stored value for
 * a conversation that already exists; pass nothing on first contact.
 */
export function buildInstruction(
  context: IssueContext,
  seenCommentId?: number | null,
): BuiltInstruction {
  const firstContact = !seenCommentId;
  const shown = firstContact
    ? context.comments
    : context.comments.filter((comment) => comment.id > (seenCommentId as number));

  const lines: string[] = [];

  lines.push(`ISSUE ${context.owner}/${context.repo}#${context.number}`);
  lines.push(`Title: ${context.title}`);
  lines.push(`Opened by: ${context.author}`);
  if (context.url) lines.push(`URL: ${context.url}`);

  lines.push("");
  lines.push("DESCRIPTION - what this issue is asking for");
  lines.push(context.body?.trim() ? context.body.trim() : "(opened with no description)");

  if (shown.length > 0) {
    lines.push("");
    lines.push(
      firstContact
        ? `CONVERSATION SO FAR - ${shown.length} comment${shown.length === 1 ? "" : "s"}`
        : `NEW COMMENT${shown.length === 1 ? "" : "S"} SINCE YOU LAST WORKED ON THIS - ${shown.length}`,
    );
    for (const comment of shown) lines.push(formatComment(comment, context.triggerCommentId));
  }

  lines.push("");
  lines.push("WHAT TO DO");
  lines.push(
    context.triggerCommentId
      ? "Act on the marked comment above. The description is context for it, not a separate task."
      : "Act on the description above.",
  );
  lines.push(
    "Do the work in the repository, then publish it. Prefer a branch and a pull request.",
  );

  return {
    instruction: lines.join("\n"),
    lastCommentId:
      context.comments.length > 0
        ? Math.max(...context.comments.map((comment) => comment.id))
        : (seenCommentId ?? null),
  };
}

function formatComment(comment: IssueComment, triggerId?: number): string {
  const when = comment.createdAt ? ` (${comment.createdAt.slice(0, 10)})` : "";
  const marker = triggerId !== undefined && comment.id === triggerId ? "  <<< ACT ON THIS" : "";
  return `--- ${comment.author}${when}${marker} ---\n${comment.body.trim() || "(empty)"}`;
}

/**
 * The cursor to store after a successful run - the highest comment id we have
 * shown. Written only once the run has actually happened, so a run that crashed
 * before reading its instructions does not silently swallow them.
 */
export function nextCursor(store: SessionStore, sessionKey: string): number | null {
  return store.getSession(sessionKey)?.lastCommentId ?? null;
}
