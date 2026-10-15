/**
 * Human-in-the-loop approval against ArmorIQ's delegation API.
 *
 * Verified against the live backend:
 *   POST /delegation/request  { action, arguments, requesterRole, requesterLimit, domain, amount }
 *   GET  /delegation/poll?delegationId=...   (X-User-Email header required)
 *   POST /delegation/approve  { delegationId (uuid), approverEmail }
 *   POST /delegation/reject   { delegationId (uuid), approverEmail }
 *
 * Constraints ArmorIQ enforces:
 *   - the approver must outrank the requester's role
 *   - a requester can never approve their own request
 */

const API = process.env.ARMORIQ_BACKEND ?? "https://api.armoriq.ai";

export interface Delegation {
  delegationId: string;
  status: string;
  approverEmail?: string;
}

export class DelegationClient {
  constructor(private readonly apiKey: string) {}

  private async call<T>(path: string, init: RequestInit & { userEmail?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
    };
    if (init.userEmail) headers["X-User-Email"] = init.userEmail;

    const res = await fetch(`${API}${path}`, { ...init, headers });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body.message ?? body)}`,
      );
    }
    return body as T;
  }

  async request(input: {
    action: string;
    arguments: Record<string, unknown>;
    requesterRole: string;
    requesterLimit: number;
    domain: string;
    amount?: number;
    requesterEmail?: string;
  }): Promise<Delegation> {
    const res = await this.call<{ delegationId: string; status: string; expiresAt: string }>(
      "/delegation/request",
      {
        method: "POST",
        userEmail: input.requesterEmail,
        body: JSON.stringify({
          action: input.action,
          arguments: input.arguments,
          requesterRole: input.requesterRole,
          requesterLimit: input.requesterLimit,
          domain: input.domain,
          amount: input.amount ?? 0.01,
        }),
      },
    );
    return { delegationId: res.delegationId, status: res.status };
  }

  async poll(delegationId: string, userEmail: string): Promise<string> {
    const res = await this.call<{ status: string }>(
      `/delegation/poll?delegationId=${encodeURIComponent(delegationId)}`,
      { userEmail },
    );
    return res.status;
  }

  async approve(delegationId: string, approverEmail: string): Promise<void> {
    await this.call("/delegation/approve", {
      method: "POST",
      userEmail: approverEmail,
      body: JSON.stringify({ delegationId, approverEmail }),
    });
  }

  async reject(delegationId: string, approverEmail: string): Promise<void> {
    await this.call("/delegation/reject", {
      method: "POST",
      userEmail: approverEmail,
      body: JSON.stringify({ delegationId, approverEmail }),
    });
  }
}
