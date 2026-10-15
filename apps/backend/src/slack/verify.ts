/**
 * Proving an interaction really came from Slack.
 *
 * This is the same class of check as the GitHub webhook signature, and it has
 * the same trap, so it is written the same way: it must be FAIL-CLOSED. A
 * function that verifies a signature and then returns a value which a careless
 * caller forgets to test is worse than no check at all, because it looks like
 * one. So this returns an explicit result and the route refuses anything that is
 * not `ok`.
 *
 * Two details that matter:
 *
 *   The timestamp is part of the signed string (`v0:{ts}:{body}`), so a request
 *   captured off the wire cannot be replayed an hour later. The replay window is
 *   checked separately, because a signature that is valid forever is a signature
 *   that leaks eventually.
 *
 *   The comparison is `timingSafeEqual`. Comparing with `===` leaks how many
 *   leading characters were right, which is enough to forge a signature one byte
 *   at a time given enough attempts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack's own recommendation. Long enough for a slow network, short enough to matter. */
const REPLAY_WINDOW_SECONDS = 60 * 5;

export type VerifyResult = { ok: true } | { ok: false; error: string };

export function verifySlackRequest(input: {
  signingSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  /** Injectable so the replay window can be tested without waiting. */
  now?: number;
}): VerifyResult {
  const { signingSecret, signature, timestamp, body } = input;

  if (!signingSecret) {
    return { ok: false, error: "SLACK_SIGNING_SECRET is not configured" };
  }
  if (!signature) return { ok: false, error: "missing X-Slack-Signature header" };
  if (!timestamp) return { ok: false, error: "missing X-Slack-Request-Timestamp header" };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, error: "malformed timestamp" };

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - seconds) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, error: "timestamp is outside the replay window" };
  }

  const expected =
    "v0=" +
    createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`, "utf8").digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // Length is compared first because timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "signature does not match" };
  }
  return { ok: true };
}

/** Sign a body the way Slack does. Used by the probe, and by tests. */
export function signSlackRequest(signingSecret: string, timestamp: string, body: string): string {
  return (
    "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`, "utf8").digest("hex")
  );
}
