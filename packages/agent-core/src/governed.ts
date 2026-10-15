import {
  ArmorIQClient,
  PolicyBlockedException,
  IntentMismatchException,
  PolicyHoldException,
  TokenExpiredException,
  InvalidTokenException,
  type IntentToken,
  type MCPInvocationResult,
} from "@armoriq/sdk";

/**
 * The governed execution layer.
 *
 * The whole point of this project in one file: an agent may only take an action
 * it declared up front and ArmorIQ has cryptographically signed.
 *
 * There is no path from "the model decided" to "the tool ran" that does not
 * pass a signed intent token. `act()` takes no escape hatch - no unsafeInvoke.
 */

export interface PlanStep {
  action: string;
  mcp: string;
  params: Record<string, unknown>;
  description?: string;
  /** Set only when a human approved this step outside the original plan. */
  approvedBy?: string;
  approvalReason?: string;
}

export interface IntentPlan {
  goal: string;
  steps: PlanStep[];
}

export interface PolicyRule {
  id: string;
  action: "allow" | "deny" | "require_approval";
  tool: string;
  reason?: string;
}

export interface Policy {
  rules: PolicyRule[];
}

/**
 * The policy this agent runs under.
 *
 * `require_approval` is deliberate and not a bug: publishing to a branch is
 * ordinary work that should never interrupt anyone, while writing to the
 * default branch bypasses review entirely and is exactly the kind of thing that
 * should stop and ask a human. `deny` would be wrong here - it is absolute and
 * has no approval path, so it could never be resumed.
 */
export const PICTO_POLICY: Policy = {
  rules: [
    {
      id: "publishing-a-branch",
      action: "allow",
      tool: "push_branch",
      reason: "Publishing to a branch is reviewable and reversible.",
    },
    {
      id: "default-branch-needs-a-human",
      action: "require_approval",
      tool: "push_main",
      reason: "Writing to the default branch bypasses review and is not reversible by closing a PR.",
    },
  ],
};

/**
 * Reduce an MCP result to the value the tool actually returned.
 *
 * MCP wraps every result in a transport envelope: a list of content parts, each
 * a tagged text blob with the real payload JSON-encoded inside. That envelope
 * describes how the reply travelled, not what the tool found, and passing it on
 * cost us twice in the same run.
 *
 * The model reads the payload as a quoted string - a tool that returned
 * `{ "branch": "fix/x" }` is shown `{"content":[{"type":"text","text":"{\n  \"branch\"..."}]}`
 * - which spends tokens on escaping and invites it to guess at the structure.
 *
 * And the caller, looking for a field it knows the tool returns, finds nothing:
 * reading the pushed branch name produced the literal string "branch", so the
 * pull request was opened against a branch that does not exist.
 *
 * Anything that is not the envelope is returned untouched, so this cannot
 * corrupt a result it does not recognise.
 */
export function unwrapMcpResult(result: unknown): unknown {
  const envelope =
    typeof result === "string" && result.startsWith("{")
      ? (() => {
          try {
            return JSON.parse(result) as unknown;
          } catch {
            return result;
          }
        })()
      : result;

  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return envelope;

  const parts = (envelope as { content?: unknown }).content;
  if (!Array.isArray(parts) || parts.length === 0) return envelope;

  const texts: string[] = [];
  for (const part of parts) {
    const { type, text } = (part ?? {}) as { type?: string; text?: string };
    // A part we do not understand means this is not the envelope we know.
    if (type !== "text" || typeof text !== "string") return envelope;
    texts.push(text);
  }

  const joined = texts.join("\n");

  // A failed tool is reported as text, and stays text: the caller has to be able
  // to tell a result from a failure.
  if ((envelope as { isError?: unknown }).isError === true) return joined;

  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

export type Verdict =
  | { outcome: "allowed"; action: string; data: unknown; status: string; ms: number }
  | { outcome: "blocked"; action: string; reason: string; code: string }
  | { outcome: "held"; action: string; reason: string; code: string; delegationId?: string }
  | { outcome: "error"; action: string; reason: string; code: string };

export interface DeclaredIntent {
  token: IntentToken;
  plan: IntentPlan;
  planHash: string;
  signature: string;
  totalSteps: number;
  allowedTools: string[];
  /** Which policy rules ArmorIQ actually matched. Empty means policy was ignored. */
  matchedPolicies: string[];
}

const BLOCK_CODES = new Set([
  PolicyBlockedException.name,
  IntentMismatchException.name,
  TokenExpiredException.name,
  InvalidTokenException.name,
]);

/**
 * Turn whatever the SDK threw into something a human can act on.
 *
 * The SDK builds its message as `MCP invocation failed: ${errorDetail}`, where
 * errorDetail is the proxy's parsed response BODY - an object. So the message
 * arrives as the literal string "[object Object]" and the cause is already gone
 * by the time we see it. What the exception does still carry is the HTTP status,
 * and that alone separates "the proxy could not route this call" (500) from "the
 * proxy refused it" (403). That distinction was invisible for a whole debugging
 * session, so it is worth surfacing.
 */
function describeFailure(
  message: string | undefined,
  statusCode: number | undefined,
  mcp: string,
  action: string,
): string {
  const parts = [message ?? "no message"];
  if (statusCode !== undefined) parts.push(`HTTP ${statusCode}`);
  parts.push(`mcp=${mcp}`, `action=${action}`);
  return parts.join(" | ");
}

export class GovernedAgent {
  private readonly client: ArmorIQClient;

  constructor(
    private readonly identity: { agentId: string; userId: string; contextId?: string },
    apiKey?: string,
  ) {
    this.client = new ArmorIQClient({
      apiKey: apiKey ?? process.env.ARMORIQ_API_KEY ?? "",
      userId: identity.userId,
      agentId: identity.agentId,
      contextId: identity.contextId ?? "default",
    });
  }

  get raw(): ArmorIQClient {
    return this.client;
  }

  /**
   * Declare intent and let ArmorIQ parse, sign and seal it.
   *
   * `llm` and `prompt` are bound into the signature, so a token lifted from one
   * run cannot be replayed to authorise a different one.
   */
  async declareIntent(input: {
    llm: string;
    prompt: string;
    plan: IntentPlan;
    policy?: Policy;
    validitySeconds?: number;
  }): Promise<DeclaredIntent> {
    const planCapture = this.client.capturePlan(input.llm, input.prompt, {
      goal: input.plan.goal,
      steps: input.plan.steps,
    });

    const token = await this.client.getIntentToken(
      planCapture,
      input.policy ? { rules: input.policy.rules } : undefined,
      input.validitySeconds ?? 300,
    );

    return {
      token,
      plan: input.plan,
      planHash: token.planHash,
      signature: token.signature,
      totalSteps: token.totalSteps,
      allowedTools: (token.policyValidation?.allowed_tools as string[] | undefined) ?? [],
      matchedPolicies: (token.policyValidation?.matched_policies as string[] | undefined) ?? [],
    };
  }

  /**
   * Re-declare intent with one extra step, and return a fresh token.
   *
   * This is the only way a blocked action can ever run: the original plan was
   * signed, so it can never be edited - a new plan has to be signed. Nothing
   * here is reachable from the model. It is called only after a human has
   * approved, and the approver's reason is recorded in the new step.
   */
  async declareIntentIncluding(
    previous: DeclaredIntent,
    input: {
      llm: string;
      prompt: string;
      step: PlanStep;
      approvedBy: string;
      reason: string;
      policy?: Policy;
      validitySeconds?: number;
    },
  ): Promise<DeclaredIntent> {
    const already = previous.plan.steps.some((s) => s.action === input.step.action);
    const steps = already ? previous.plan.steps : [...previous.plan.steps, input.step];

    return this.declareIntent({
      llm: input.llm,
      prompt: `${input.prompt}\n\nApproved by ${input.approvedBy}: ${input.reason}`,
      plan: {
        goal: previous.plan.goal,
        steps: steps.map((s) =>
          s.action === input.step.action
            ? { ...s, approvedBy: input.approvedBy, approvalReason: input.reason }
            : s,
        ) as PlanStep[],
      },
      policy: input.policy,
      validitySeconds: input.validitySeconds,
    });
  }

  /** Which MCP server a signed plan authorises `action` on, if any. */
  stepFor(intent: DeclaredIntent, action: string): PlanStep | undefined {
    return intent.plan.steps.find((s) => s.action === action);
  }

  /**
   * Execute one action through the ArmorIQ proxy.
   *
   * `mcp` is passed explicitly and looked up from the signed plan by the caller.
   * Deriving it from step 0 - as this did - silently sends every call to the
   * first server, which is how you get a governance layer that appears to work
   * while routing everything to the wrong place.
   *
   * Returns a verdict instead of throwing, because the block IS the result the
   * demo exists to show. Exceptions are classified, never swallowed.
   */
  async act(
    intent: DeclaredIntent,
    mcp: string,
    action: string,
    params: Record<string, unknown>,
    userEmail?: string,
  ): Promise<Verdict> {
    const started = Date.now();
    try {
      const result: MCPInvocationResult = await this.client.invoke(
        mcp,
        action,
        intent.token,
        params,
        undefined,
        userEmail,
      );
      return {
        outcome: "allowed",
        action,
        data: unwrapMcpResult(result.result),
        status: result.status,
        ms: Date.now() - started,
      };
    } catch (err) {
      const e = err as {
        name?: string;
        message?: string;
        delegationId?: string;
        statusCode?: number;
      };
      const code = e?.name ?? "UnknownError";
      const reason = describeFailure(e?.message, e?.statusCode, mcp, action);

      if (code === PolicyHoldException.name) {
        return { outcome: "held", action, reason, code, delegationId: e.delegationId };
      }
      if (BLOCK_CODES.has(code)) {
        return { outcome: "blocked", action, reason, code };
      }
      return { outcome: "error", action, reason, code };
    }
  }

  close(): void {
    this.client.close();
  }
}
