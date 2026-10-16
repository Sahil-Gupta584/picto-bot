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

/**
 * Who is asking, decided from their Slack identity - never from the text.
 *
 * `guest` is also the answer for "unknown", because guessing in that direction
 * is the only kind of wrong that matters here.
 */
export type Authority = "maintainer" | "guest";

// ── the Slack Web API, as much of it as we need ─────────────────────────────

/** The fields of a Slack member this server reads. Named as Slack names them. */
export interface SlackUserInfo {
  id?: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

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
    /** Rich rendering. Optional: a plain text reply is often enough. */
    blocks?: unknown[];
    channel?: string;
    /** Reply inside a thread. */
    threadTs?: string;
  }): Promise<{ channel: string; ts: string }> {
    return this.call<{ channel: string; ts: string }>("chat.postMessage", {
      channel: input.channel ?? this.defaultChannel,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
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

  /**
   * GET a Web API method with query parameters.
   *
   * users.info and users.list are lookups, and the GET form is the one Slack
   * has always accepted query strings on.
   */
  private async get<T>(method: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    const json = (await response.json()) as { ok?: boolean; error?: string };
    if (!json.ok) {
      throw new Error(`slack ${method} failed: ${json.error ?? `HTTP ${response.status}`}`);
    }
    return json as T;
  }

  /**
   * One member's workspace profile, including whether Slack itself considers
   * them an admin or owner. Null means Slack could not or would not answer,
   * which the caller must read as "unknown", never as "fine".
   */
  async usersInfo(userId: string): Promise<SlackUserInfo | null> {
    try {
      const json = await this.get<{ user?: SlackUserInfo }>("users.info", { user: userId });
      return json.user ?? null;
    } catch {
      return null;
    }
  }

  /** Every member of the workspace, paged. Turns @handles into member IDs once. */
  async usersList(): Promise<SlackUserInfo[]> {
    const members: SlackUserInfo[] = [];
    let cursor = "";
    do {
      const json = await this.get<{
        members?: SlackUserInfo[];
        response_metadata?: { next_cursor?: string };
      }>("users.list", cursor ? { limit: "200", cursor } : { limit: "200" });
      members.push(...(json.members ?? []));
      cursor = json.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return members;
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
        `[slack] message sent to ${posted.channel}: approve ${request.action} ` +
          `(${request.id.slice(0, 8)}) — the run is waiting`,
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
  /**
   * Who counts as a maintainer. Omitted means every click is honoured, which
   * is only correct when there is no identity to check against.
   */
  authorityFor?: (userId: string) => Promise<Authority>;
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
  deps: {
    store: SessionStore;
    broker: ApprovalBroker;
    client: SlackClient;
    authorityFor?: (userId: string) => Promise<Authority>;
  },
  payload: SlackPayload,
): Promise<void> {
  const action = payload.actions?.[0];
  const approvalId = action?.value;
  if (!approvalId || !action?.action_id) return;

  const approved = action.action_id === "picto_approve";
  const denied = action.action_id === "picto_deny";
  if (!approved && !denied) return;

  const by = payload.user?.username ?? payload.user?.name ?? payload.user?.id ?? "someone";

  // Approving is the privileged direction, so it is the one that checks who is
  // clicking. Denying stays open to everyone: stopping something is never the
  // dangerous direction, and a bystander should not need permission to pull
  // the brake.
  if (approved && deps.authorityFor && payload.user?.id) {
    const authority = await deps.authorityFor(payload.user.id);
    if (authority !== "maintainer") {
      console.warn(
        `[slack] ignored an approve click from ${by} (${payload.user.id}): not a maintainer`,
      );
      await noteOnMessage(
        deps.client,
        deps.store,
        approvalId,
        `🚫 *${by}* tried to approve, but only maintainers can decide this. Nothing changed; the request is still waiting.`,
      );
      return;
    }
  }

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

/**
 * Say something under an approval message when there is one to speak under.
 *
 * Used for clicks that were refused: the person needs an answer, and silence
 * would read as a broken button.
 */
async function noteOnMessage(
  client: SlackClient,
  store: SessionStore,
  approvalId: string,
  markdown: string,
): Promise<void> {
  const record = store.getApproval(approvalId);
  const thread = Boolean(record?.notifiedChannel && record?.notifiedTs);
  try {
    await client.postMessage({
      text: markdown.replace(/[*🚫]/g, "").trim(),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: markdown } }],
      channel: thread ? (record?.notifiedChannel ?? undefined) : undefined,
      threadTs: thread ? (record?.notifiedTs ?? undefined) : undefined,
    });
  } catch (error) {
    console.error(`[slack] could not report a refused click: ${reason(error)}`);
  }
}

/** Photo of an approval, for the startup log. */
export function describeApproval(approval: ApprovalRecord): string {
  return `${approval.action} on ${approval.mcp} for ${approval.sessionKey}`;
}

export function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function rawBody(req: Request): string {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  throw new Error("slack body was not raw. Mount this router with express.raw BEFORE express.json.");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
