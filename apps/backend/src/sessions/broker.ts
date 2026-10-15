/**
 * Waking a paused run back up.
 *
 * When a run is blocked, it stops and waits. The thing that wakes it is a human
 * clicking Approve in Slack, which arrives on a completely different HTTP
 * request. This is the join between those two.
 *
 * The decision itself is durable - it is written to the session store - so a
 * restart cannot lose it. What lives in memory here is only the promise of the
 * run that is currently waiting, and if the process died there is simply nobody
 * to wake, which is a fact the caller can see rather than a silent failure.
 */

export interface Decision {
  approved: boolean;
  by: string;
}

export class ApprovalBroker {
  private readonly waiters = new Map<string, (decision: Decision) => void>();

  /**
   * Wait for a decision. Resolves `null` on timeout or when the run is called
   * off, so a held run can never hang forever and hold a workspace hostage.
   */
  wait(approvalId: string, timeoutMs: number): Promise<Decision | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        resolve(null);
      }, timeoutMs);

      this.waiters.set(approvalId, (decision) => {
        clearTimeout(timer);
        this.waiters.delete(approvalId);
        resolve(decision);
      });
    });
  }

  /**
   * Deliver a decision. Returns false when no run is waiting for it - either the
   * decision arrived late, or the process that asked restarted. The store still
   * holds it, so the caller can report that honestly instead of pretending.
   */
  decide(approvalId: string, decision: Decision): boolean {
    const waiter = this.waiters.get(approvalId);
    if (!waiter) return false;
    waiter(decision);
    return true;
  }

  waiting(): string[] {
    return [...this.waiters.keys()];
  }
}
