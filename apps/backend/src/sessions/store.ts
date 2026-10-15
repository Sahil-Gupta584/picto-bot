/**
 * The session store.
 *
 * SQLite, through Node's own `node:sqlite` - no dependency, no server, no
 * service to run. This is the same choice OpenClaw makes, for the same reasons:
 * a conversation and the approvals inside it have to survive a restart, and a
 * process that keeps them in a Map forgets everything the moment it is
 * redeployed.
 *
 * What is stored, and why:
 *
 *   sessions    one row per conversation - where it lives, its workspace, its
 *               current status. The row is created on first contact and reused
 *               forever after, so a second mention does NOT start a new
 *               conversation.
 *   messages    the transcript, appended as the run happens.
 *   approvals   every blocked action and what a human decided. This is the
 *               audit trail, and it is what lets a Slack button still work
 *               after the process that asked the question has restarted.
 *
 * Deliberately NOT stored: the intent token, the installation token, or any
 * credential. Tokens are short-lived by design; persisting them would turn a
 * five-minute leak into a permanent one.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../agent/llm.js";
import type { SessionRef } from "./keys.js";

export interface SessionRecord {
  key: string;
  source: string;
  repo: string | null;
  issue: number | null;
  channel: string | null;
  thread: string | null;
  workspace: string | null;
  status: string;
  lastPlanHash: string | null;
  /** Highest issue-comment id this session has already been shown. */
  lastCommentId: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "abandoned";

export interface ApprovalRecord {
  id: string;
  sessionKey: string;
  runId: string;
  action: string;
  mcp: string;
  args: Record<string, unknown>;
  reason: string;
  code: string;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  /** Where the request was announced, so the message can be resolved in place. */
  notifiedChannel: string | null;
  notifiedTs: string | null;
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        key             TEXT PRIMARY KEY,
        source          TEXT NOT NULL,
        repo            TEXT,
        issue           INTEGER,
        channel         TEXT,
        thread          TEXT,
        workspace       TEXT,
        status          TEXT NOT NULL DEFAULT 'idle',
        last_plan_hash  TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key   TEXT NOT NULL,
        role          TEXT NOT NULL,
        content       TEXT,
        tool_calls    TEXT,
        tool_call_id  TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_key, id);

      CREATE TABLE IF NOT EXISTS approvals (
        id            TEXT PRIMARY KEY,
        session_key   TEXT NOT NULL,
        run_id        TEXT NOT NULL,
        action        TEXT NOT NULL,
        mcp           TEXT NOT NULL,
        args          TEXT NOT NULL,
        reason        TEXT NOT NULL,
        code          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        requested_at  INTEGER NOT NULL,
        decided_at    INTEGER,
        decided_by    TEXT,
        notified_channel TEXT,
        notified_ts      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_key, requested_at);

      CREATE TABLE IF NOT EXISTS deliveries (
        id          TEXT PRIMARY KEY,
        event       TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_received ON deliveries(received_at);
    `);

    // Columns added after the first release. Idempotent, so an existing
    // database upgrades in place instead of having to be thrown away.
    this.ensureColumn("sessions", "last_comment_id", "last_comment_id INTEGER");
    this.ensureColumn("approvals", "notified_channel", "notified_channel TEXT");
    this.ensureColumn("approvals", "notified_ts", "notified_ts TEXT");
  }

  /** Add a column if it is missing. SQLite has no ADD COLUMN IF NOT EXISTS. */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  // ── sessions ────────────────────────────────────────────────────────────

  /**
   * The session for this conversation, created if this is the first contact.
   * Returns the row, so callers can see whether it already had a workspace.
   */
  ensureSession(ref: SessionRef): SessionRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (key, source, repo, issue, channel, thread, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(
        ref.key,
        ref.source,
        ref.repo ?? null,
        ref.issue ?? null,
        ref.channel ?? null,
        ref.thread ?? null,
        now,
        now,
      );
    return this.getSession(ref.key) as SessionRecord;
  }

  getSession(key: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE key = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSession(row) : null;
  }

  listSessions(limit = 50): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToSession);
  }

  updateSession(
    key: string,
    patch: Partial<Pick<SessionRecord, "workspace" | "status" | "lastPlanHash" | "lastCommentId">>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.workspace !== undefined) {
      sets.push("workspace = ?");
      values.push(patch.workspace);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.lastPlanHash !== undefined) {
      sets.push("last_plan_hash = ?");
      values.push(patch.lastPlanHash);
    }
    if (patch.lastCommentId !== undefined) {
      sets.push("last_comment_id = ?");
      values.push(patch.lastCommentId);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), key);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE key = ?`).run(...(values as never[]));
  }

  /**
   * Clears the state that cannot survive a restart.
   *
   * A run lives inside the process that started it: the loop, the clone handle,
   * and the promise a Slack approval wakes. When the process ends none of that
   * exists, but the rows describing it do - so the database goes on claiming a
   * run is in progress and an approval is awaited, neither of which is true.
   *
   * That is worse than untidy: a session shown as `running` looks like work in
   * progress when nothing is happening, and a pending approval looks like a
   * decision that still has an effect when its run is already gone.
   *
   * Called once at startup, which is the only moment the claim is knowable.
   */
  recoverInterrupted(reason = "abandoned by a restart"): { sessions: number; approvals: number } {
    const sessions = this.db
      .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE status = 'running'")
      .run(Date.now());
    const approvals = this.db
      .prepare(
        `UPDATE approvals SET status = 'abandoned', decided_at = ?, decided_by = ?
         WHERE status = 'pending'`,
      )
      .run(Date.now(), reason);

    return { sessions: Number(sessions.changes), approvals: Number(approvals.changes) };
  }

  // ── transcript ──────────────────────────────────────────────────────────

  appendMessage(sessionKey: string, message: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_key, role, content, tool_calls, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionKey,
        message.role,
        message.content ?? null,
        message.tool_calls ? JSON.stringify(message.tool_calls) : null,
        message.tool_call_id ?? null,
        Date.now(),
      );
  }

  /** The last `limit` messages, oldest first - ready to hand back to the model. */
  history(sessionKey: string, limit = 40): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, tool_calls, tool_call_id FROM messages
         WHERE session_key = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionKey, limit) as Array<{
      role: string;
      content: string | null;
      tool_calls: string | null;
      tool_call_id: string | null;
    }>;

    return rows.reverse().map((row) => {
      const message: ChatMessage = { role: row.role as ChatMessage["role"] };
      if (row.content !== null) message.content = row.content;
      if (row.tool_calls) message.tool_calls = JSON.parse(row.tool_calls);
      if (row.tool_call_id) message.tool_call_id = row.tool_call_id;
      return message;
    });
  }

  countMessages(sessionKey: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM messages WHERE session_key = ?")
      .get(sessionKey) as { n: number };
    return row.n;
  }

  // ── approvals ───────────────────────────────────────────────────────────

  createApproval(input: {
    id: string;
    sessionKey: string;
    runId: string;
    action: string;
    mcp: string;
    args: Record<string, unknown>;
    reason: string;
    code: string;
  }): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_key, run_id, action, mcp, args, reason, code, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.id,
        input.sessionKey,
        input.runId,
        input.action,
        input.mcp,
        JSON.stringify(input.args),
        input.reason,
        input.code,
        Date.now(),
      );
    return this.getApproval(input.id) as ApprovalRecord;
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToApproval(row) : null;
  }

  /**
   * Record what a human decided.
   *
   * Refuses to overwrite a decision that has already been made, so a replayed
   * Slack callback cannot flip a denial into an approval.
   */
  decideApproval(id: string, status: Exclude<ApprovalStatus, "pending">, decidedBy: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, Date.now(), decidedBy, id);
    return Number(result.changes) > 0;
  }

  /**
   * Remember where a request was announced, so the message can be resolved in
   * place instead of a second one appearing. Stored on the row rather than in
   * memory, because the message outlives the process that posted it.
   */
  markApprovalNotified(id: string, channel: string, ts: string): void {
    this.db
      .prepare("UPDATE approvals SET notified_channel = ?, notified_ts = ? WHERE id = ?")
      .run(channel, ts, id);
  }

  pendingApprovals(sessionKey?: string): ApprovalRecord[] {
    const rows = (
      sessionKey
        ? this.db
            .prepare(
              `SELECT * FROM approvals WHERE status = 'pending' AND session_key = ? ORDER BY requested_at DESC`,
            )
            .all(sessionKey)
        : this.db
            .prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at DESC")
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToApproval);
  }

  /** Approvals left pending by a process that died. Surfaced at startup. */
  staleApprovals(olderThanMs: number): ApprovalRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND requested_at < ?")
      .all(Date.now() - olderThanMs) as Array<Record<string, unknown>>;
    return rows.map(rowToApproval);
  }

  // ── webhook deliveries ──────────────────────────────────────────────────

  /**
   * Claim a webhook delivery id. True if this is the first time we have seen it.
   *
   * GitHub redelivers when a webhook takes too long to answer, and a redelivery
   * that started a second run would put two agents on the same branch. Claiming
   * is an insert that can only win once, so a retry is ignored even across a
   * restart - which an in-memory set could not do.
   */
  claimDelivery(id: string, event: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO deliveries (id, event, received_at) VALUES (?, ?, ?)")
      .run(id, event, Date.now());
    return Number(result.changes) > 0;
  }

  pruneDeliveries(olderThanMs = 24 * 60 * 60 * 1000): number {
    const result = this.db
      .prepare("DELETE FROM deliveries WHERE received_at < ?")
      .run(Date.now() - olderThanMs);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    key: String(row.key),
    source: String(row.source),
    repo: (row.repo as string | null) ?? null,
    issue: (row.issue as number | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    thread: (row.thread as string | null) ?? null,
    workspace: (row.workspace as string | null) ?? null,
    status: String(row.status),
    lastPlanHash: (row.last_plan_hash as string | null) ?? null,
    lastCommentId: (row.last_comment_id as number | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    sessionKey: String(row.session_key),
    runId: String(row.run_id),
    action: String(row.action),
    mcp: String(row.mcp),
    args: JSON.parse(String(row.args ?? "{}")) as Record<string, unknown>,
    reason: String(row.reason),
    code: String(row.code),
    status: String(row.status) as ApprovalStatus,
    requestedAt: Number(row.requested_at),
    decidedAt: (row.decided_at as number | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    notifiedChannel: (row.notified_channel as string | null) ?? null,
    notifiedTs: (row.notified_ts as string | null) ?? null,
  };
}
