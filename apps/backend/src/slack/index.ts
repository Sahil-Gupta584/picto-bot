/**
 * The Slack side: asking a human, and acting on their answer.
 *
 * This is the part that makes the governance real to a person. ArmorIQ decides
 * something is not allowed; the run stops; a message appears in Slack with two
 * buttons; somebody who did not write the code makes a call; and the run either
 * continues or stops for good.
 *
 * The flow, end to end:
 *
 *   1. A tool call is refused (the SDK throws before any network call).
 *   2. runTask records the request in SQLite and calls `request`, which posts
 *      the message and then WAITS.
 *   3. The maintainer clicks Approve.
 *   4. Slack POSTs here. The signature is checked, the decision is written to
 *      SQLite, and the waiting run is woken.
 *   5. runTask re-signs its plan to include the action and retries it once.
 *
 * Two properties worth stating plainly:
 *
 *   The answer is written to the database, not to a variable, so an approval
 *   that arrives after a restart is still recorded and still auditable. What is
 *   NOT recoverable is the run itself - a process that died is not waiting, and
 *   `decide` says so rather than pretending.
 *
 *   If Slack is unreachable the run still stops. Posting fails, the wait times
 *   out, and the action is not taken. A notification channel being down must
 *   never become a way to bypass the policy.
 */
import { Router, type Request } from "express";
import type { ApprovalRequest } from "../agent/index.js";
import { SLACK } from "../config.js";
import type { ApprovalBroker } from "../sessions/broker.js";
import type { ApprovalRecord, SessionStore } from "../sessions/store.js";
import { approvalBlocks, resolvedBlocks } from "./blocks.js";
import { verifySlackRequest } from "./verify.js";

export { approvalBlocks, resolvedBlocks } from "./blocks.js";
export { verifySlackRequest, signSlackRequest } from "./verify.js";

/** How long a blocked run will wait for a human before giving up. */
export const APPROVAL_TIMEOUT_MS = Number(process.env.SLACK_APPROVAL_TIMEOUT_MS ?? 30 * 60 * 1000);

// ── the Slack Web API, as much of it as we need ─────────────────────────────

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly defaultChannel: string,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });

    // Slack answers 200 with { ok: false } for application errors, so the HTTP
    // status alone is not enough to know whether the call worked.
    const json = (await response.json()) as { ok?: boolean; error?: string };
    if (!json.ok) {
      throw new Error(`slack ${method} failed: ${json.error ?? `HTTP ${response.status}`}`);
    }
    return json as T;
  }

  postMessage(input: {
    text: string;
    blocks: unknown[];
    channel?: string;
  }): Promise<{ channel: string; ts: string }> {
    return this.call<{ channel: string; ts: string }>("chat.postMessage", {
      channel: input.channel ?? this.defaultChannel,
      text: input.text,
      blocks: input.blocks,
      unfurl_links: false,
    });
  }

  update(input: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<unknown> {
    return this.call("chat.update", {
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks,
    });
  }
}

// ── asking ──────────────────────────────────────────────────────────────────

export class SlackApprover {
  constructor(
    private readonly deps: {
      store: SessionStore;
      broker: ApprovalBroker;
      client: SlackClient;
      timeoutMs?: number;
    },
  ) {}

  /** Passed to runTask as `requestApproval`. Resolves when a human decides. */
  readonly request = async (request: ApprovalRequest): Promise<boolean> => {
    try {
      const posted = await this.deps.client.postMessage(approvalBlocks(request));
      this.deps.store.markApprovalNotified(request.id, posted.channel, posted.ts);
      console.log(
        `[slack] asked for approval: ${request.action} (${request.id.slice(0, 8)}) in ${posted.channel}`,
      );
    } catch (error) {
      // Deliberately not fatal. The run still stops; it just stops without a
      // button. Failing "open" here - continuing because we could not ask -
      // would turn a Slack outage into a policy bypass.
      console.error(`[slack] could not post the approval request: ${reason(error)}`);
    }

    const decision = await this.deps.broker.wait(request.id, this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS);
    if (!decision) {
      console.warn(`[slack] approval ${request.id.slice(0, 8)} was never answered`);
    }
    // The database is the source of truth, not the in-memory wake-up.
    return this.deps.store.getApproval(request.id)?.status === "approved";
  };
}

// ── answering ───────────────────────────────────────────────────────────────

interface SlackPayload {
  type?: string;
  user?: { id?: string; name?: string; username?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  /** Present on a `url_verification` post, which Slack uses to test the URL. */
  challenge?: string;
}

export function slackInteractionsRouter(deps: {
  store: SessionStore;
  broker: ApprovalBroker;
  client: SlackClient;
}): Router {
  const router = Router();

  router.post("/interactions", (req, res) => {
    // Raw, because the signature covers the exact bytes. Slack posts these as
    // form-encoded, so the payload is parsed by hand below rather than by a
    // body parser that would consume the bytes we need to verify.
    const body = rawBody(req);

    const verdict = verifySlackRequest({
      signingSecret: SLACK.signingSecret,
      signature: header(req, "x-slack-signature"),
      timestamp: header(req, "x-slack-request-timestamp"),
      body,
    });

    if (!verdict.ok) {
      console.warn(`[slack] rejected an interaction: ${verdict.error}`);
      res.status(401).json({ ok: false, error: verdict.error });
      return;
    }

    let payload: SlackPayload;
    try {
      payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}") as SlackPayload;
    } catch {
      res.status(400).json({ ok: false, error: "payload was not valid JSON" });
      return;
    }

    // Slack tests a newly saved Request URL by posting a challenge, and refuses
    // to save the URL unless the challenge comes back. It arrives signed like
    // everything else, so it has already been verified above - which is the
    // point: the URL cannot be registered unless this deployment can prove it is
    // the one that holds the signing secret.
    if (payload.type === "url_verification") {
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // Slack gives us three seconds. Answer first, then do the work.
    res.status(200).send("");

    if (payload.type === "block_actions") void decide(deps, payload);
  });

  return router;
}

async function decide(
  deps: { store: SessionStore; broker: ApprovalBroker; client: SlackClient },
  payload: SlackPayload,
): Promise<void> {
  const action = payload.actions?.[0];
  const approvalId = action?.value;
  if (!approvalId || !action?.action_id) return;

  const approved = action.action_id === "picto_approve";
  const denied = action.action_id === "picto_deny";
  if (!approved && !denied) return;

  const by = payload.user?.username ?? payload.user?.name ?? payload.user?.id ?? "someone";

  // Refuses to overwrite an existing decision, so a replayed callback cannot
  // turn a denial into an approval.
  const recorded = deps.store.decideApproval(approvalId, approved ? "approved" : "denied", by);
  if (!recorded) {
    console.warn(`[slack] approval ${approvalId.slice(0, 8)} was already decided - ignoring`);
    return;
  }

  const woken = deps.broker.decide(approvalId, { approved, by });
  console.log(
    `[slack] ${approved ? "approved" : "denied"} ${approvalId.slice(0, 8)} by ${by} - ` +
      (woken ? "run resumed" : "no run was waiting (it did not survive a restart)"),
  );

  const record = deps.store.getApproval(approvalId);
  if (!record?.notifiedChannel || !record.notifiedTs) return;

  try {
    const built = resolvedBlocks(record, by, approved);
    await deps.client.update({
      channel: record.notifiedChannel,
      ts: record.notifiedTs,
      text: built.text,
      blocks: built.blocks,
    });
  } catch (error) {
    // The decision is already recorded; failing to redraw the message must not
    // undo it.
    console.error(`[slack] could not update the approval message: ${reason(error)}`);
  }
}

/** Photo of an approval, for the startup log. */
export function describeApproval(approval: ApprovalRecord): string {
  return `${approval.action} on ${approval.mcp} for ${approval.sessionKey}`;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rawBody(req: Request): string {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  throw new Error("slack body was not raw. Mount this router with express.raw BEFORE express.json.");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
