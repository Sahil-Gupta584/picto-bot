/**
 * The run loop.
 *
 * A model proposes, ArmorIQ disposes. Every tool call goes through
 * `GovernedAgent.act()`, which needs a valid signed intent token, and the SDK
 * refuses any action that is not a step in the plan it signed. There is no
 * branch here that calls a tool directly - if there were, this project would be
 * a demo about governance with a hole in it exactly where the governance is.
 *
 * A run belongs to a SESSION, not to a message. The second comment on an issue
 * resumes the same conversation, with the same transcript and the same working
 * copy, instead of starting again from nothing.
 */
import {
  GovernedAgent,
  PICTO_POLICY,
  type DeclaredIntent,
  type Verdict,
} from "@picto/agent-core";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IDENTITY, LLM, armorIqApiKey } from "../config.js";
import { describeEvent } from "../log.js";
import { bindRunArgs, chatTools, toolByName } from "../mcps/registry.js";
import { safeWorkspaceId } from "../sessions/keys.js";
import type { SessionStore } from "../sessions/store.js";
import type { Workspaces } from "../workspace/index.js";
import { chat, parseToolArgs, type ChatMessage } from "./llm.js";
import { planFromPrompt } from "./planner.js";
import { systemPrompt } from "./prompts.js";

const MAX_TURNS = 32;
/**
 * When to tell the model that the budget is finite.
 *
 * A run on an unfamiliar repository spends a fifth of its calls just learning
 * where things are, and a model with no sense of a budget will keep researching
 * until the cap throws the work away unpublished. This lands late enough that
 * exploration is still serious, early enough to leave room to write, commit and
 * push.
 */
const BUDGET_WARNING_AT = 21;
const INTENT_TTL_SECONDS = 1800;
const MAX_TOOL_RESULT_CHARS = 8_000;
/** How much of the conversation the model is shown. */
const HISTORY_LIMIT = 40;
/**
 * Stands in for a turn the model ended without words.
 *
 * The transcript is persisted and replayed on the next run, and an assistant
 * message with empty content is the kind of thing a provider rejects - which
 * would turn a silently empty reply into a failed run. This is only ever stored,
 * never shown as the run's answer.
 */
const EMPTY_REPLY = "(the model ended its turn without saying anything)";

/** Blocks that a human is allowed to override. Everything else is final. */
const APPROVABLE = new Set(["IntentMismatchException", "PolicyHoldException", "PolicyBlockedException"]);

export type RunEvent =
  | { type: "session"; key: string; priorMessages: number; reusedWorkspace: boolean }
  | { type: "planned"; goal: string; steps: string[]; refused: string[]; planHash: string }
  | { type: "tool"; name: string; mcp: string; args: Record<string, unknown> }
  | { type: "allowed"; name: string; mcp: string; ms: number }
  | { type: "blocked"; name: string; mcp: string; code: string; reason: string }
  | { type: "held"; name: string; mcp: string; code: string; reason: string }
  | { type: "approval_requested"; approvalId: string; name: string }
  | { type: "approved"; name: string; by: string }
  | { type: "denied"; name: string; by: string }
  | { type: "replanned"; planHash: string; steps: string[] }
  | { type: "pushed"; target: string; url?: string }
  | { type: "reply"; text: string }
  | { type: "nudge"; text: string }
  | { type: "error"; message: string };

export interface ApprovalRequest {
  /** Durable id of this request. The Slack button carries it. */
  id: string;
  action: string;
  mcp: string;
  args: Record<string, unknown>;
  reason: string;
  code: string;
  sessionKey: string;
  runId: string;
}

export interface RunInput {
  /** The conversation this run belongs to. */
  sessionKey: string;
  /** This invocation. Distinct from the session. */
  runId: string;
  owner: string;
  repo: string;
  ref?: string;
  token: string;
  /** What the maintainer just asked for, in their own words. */
  instruction: string;
  /** Branch to publish to if the agent goes the normal route. */
  branch: string;
  store: SessionStore;
  onEvent?: (event: RunEvent) => void;
  /**
   * Ask a human to allow a blocked action. Resolve true to allow it.
   *
   * The decision must also be written through `store.decideApproval` - the
   * record is the audit trail, and it is what makes a Slack click still work
   * after the process that asked the question has been restarted.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /** Keep the working copy after the run. Defaults to true for a real session. */
  keepWorkspace?: boolean;
  /**
   * Who is asking.
   *
   * A guest's run is planned read-only and has no approval path: the plan
   * ArmorIQ signs cannot change or publish anything, and a refusal is a final
   * answer rather than a question for a human. Defaults to a maintainer, which
   * is what every GitHub-issue run is.
   */
  authority?: "maintainer" | "guest";
}

export interface RunResult {
  runId: string;
  sessionKey: string;
  branch: string;
  pushed: string | null;
  summary: string;
  planHash: string;
  events: RunEvent[];
  transcript: ChatMessage[];
}

export async function runTask(input: RunInput, deps: { workspaces: Workspaces }): Promise<RunResult> {
  const events: RunEvent[] = [];
  const emit = (event: RunEvent): void => {
    events.push(event);
    input.onEvent?.(event);
    const line = describeEvent(event, input.sessionKey);
    if (line) console.log(line);
  };

  const workspaceId = safeWorkspaceId(input.sessionKey);
  const store = input.store;
  // A guest's request is answered, not acted on, so its plan is signed
  // read-only and the refusals below are final.
  const readOnly = input.authority === "guest";
  const session = store.ensureSession({
    key: input.sessionKey,
    source: input.sessionKey.startsWith("gh:")
      ? "github"
      : input.sessionKey.startsWith("slack:")
        ? "slack"
        : "local",
    repo: `${input.owner}/${input.repo}`,
  });

  // Resume the conversation's working copy if it is still on disk. A second
  // comment should not throw away a checkout the first one already set up -
  // including one left behind by a run that predates this process.
  const reuse = deps.workspaces.exists(workspaceId);
  if (reuse) {
    deps.workspaces.attach({
      id: workspaceId,
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      token: input.token,
    });
  } else {
    await deps.workspaces.create({
      id: workspaceId,
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      branch: input.branch,
      token: input.token,
    });
  }
  store.updateSession(input.sessionKey, { workspace: workspaceId, status: "running" });

  const agent = new GovernedAgent(IDENTITY, armorIqApiKey());
  const transcript: ChatMessage[] = [];
  let pushed: string | null = null;
  let summary = "";
  let planHash = "";
  let nudged = false;
  /**
   * Whether this run wrote anything to the working copy.
   *
   * The "you did not publish" nudge is for a run that left work on disk - not
   * for every run that ends without a push. An issue opened, a question
   * answered, a command run: those are finished work, and asking them to push a
   * branch invents work nobody asked for.
   */
  let changed = false;

  try {
    const agentsFile = readAgentsFile(deps.workspaces.resolve(workspaceId));
    const system: ChatMessage = {
      role: "system",
      content: systemPrompt({ repo: `${input.owner}/${input.repo}`, agentsFile }),
    };

    // The conversation so far, then this turn's request.
    const prior = completeSequences(store.history(input.sessionKey, HISTORY_LIMIT));
    const messages: ChatMessage[] = [system, ...prior];
    emit({ type: "session", key: input.sessionKey, priorMessages: prior.length, reusedWorkspace: reuse });

    const remember = (message: ChatMessage): void => {
      messages.push(message);
      transcript.push(message);
      store.appendMessage(input.sessionKey, message);
    };

    remember({ role: "user", content: input.instruction });

    // 1. Declare intent before doing anything.
    const planned = await planFromPrompt({
      instruction: input.instruction,
      repo: `${input.owner}/${input.repo}`,
      readOnly,
    });

    let intent = await agent.declareIntent({
      llm: LLM.model,
      prompt: input.instruction,
      plan: planned,
      policy: PICTO_POLICY,
      validitySeconds: INTENT_TTL_SECONDS,
    });
    planHash = intent.planHash;
    store.updateSession(input.sessionKey, { lastPlanHash: planHash });

    emit({
      type: "planned",
      goal: planned.goal,
      steps: planned.steps.map((step) => step.action),
      refused: planned.refused,
      planHash: intent.planHash,
    });

    // 2. Work.
    let warned = false;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (turn === BUDGET_WARNING_AT && !warned && !readOnly) {
        warned = true;
        remember({
          role: "user",
          content:
            `You have made ${turn} tool calls, and this run allows ${MAX_TURNS} in total. ` +
            "Stop exploring. Decide the smallest change that does the job, make it with write_file, " +
            "then git_commit and push_branch. Running out of turns here leaves the maintainer " +
            "with research and nothing to review.",
        });
      }

      const assistant = await chat({ messages, tools: chatTools(), temperature: 0 });

      // The transcript is stored and replayed, so even a turn the model ended
      // without words has to be a valid message.
      const said = (assistant.content ?? "").trim();
      if (!said && (assistant.tool_calls ?? []).length === 0) assistant.content = EMPTY_REPLY;
      remember(assistant);

      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        summary = said;

        // Stopping is not the same as finishing.
        //
        // A model can end its turn with the change written to disk and nothing
        // published: no commit, no branch, no pull request. The run then reports
        // that it finished while the maintainer sees an unchanged repository -
        // indistinguishable from the agent having done nothing at all.
        //
        // The instruction to publish is already in the system prompt, so this is
        // one reminder that it was not followed. Once is the right number: a
        // model that declines a second time will not be argued into it, and a
        // loop that keeps asking is worse than one that stops and says so.
        if (!pushed && !nudged && !readOnly && changed) {
          nudged = true;
          emit({ type: "nudge", text: said || "ended its turn before publishing" });
          remember({
            role: "user",
            content:
              "You ended your turn without publishing. If the change is ready, call git_commit and then push_branch now. " +
              "If it is not ready, say what is still missing in one sentence. " +
              "Ending here leaves the maintainer with nothing to review.",
          });
          continue;
        }

        emit({ type: "reply", text: summary });
        break;
      }

      for (const call of calls) {
        const name = call.function.name;
        const def = toolByName(name);

        if (!def) {
          remember(toolResult(call.id, `There is no tool called "${name}". Use one of the available tools.`));
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = parseToolArgs(call.function.arguments);
        } catch (err) {
          remember(toolResult(call.id, (err as Error).message));
          continue;
        }

        emit({ type: "tool", name, mcp: def.mcp, args });
        const params = bindRunArgs(args, workspaceId);

        // The only route from a model decision to a running tool.
        let verdict: Verdict = await agent.act(intent, def.mcp, name, params);

        if (verdict.outcome === "blocked" || verdict.outcome === "held") {
          emit(
            verdict.outcome === "held"
              ? { type: "held", name, mcp: def.mcp, code: verdict.code, reason: verdict.reason }
              : { type: "blocked", name, mcp: def.mcp, code: verdict.code, reason: verdict.reason },
          );

          // A guest's refusal is final. There is no button here, because the
          // approved route up is a maintainer making the request themselves.
          if (readOnly) {
            remember(
              toolResult(
                call.id,
                `REFUSED by ArmorIQ: "${name}" is not part of the plan signed for this request ` +
                  `(${verdict.code}), so it cannot be called. Do not retry it. Answer the ` +
                  `requester in one or two sentences: an action like this needs a maintainer to ` +
                  `ask for it.`,
              ),
            );
            continue;
          }

          if (APPROVABLE.has(verdict.code)) {
            const approvalId = randomUUID();
            store.createApproval({
              id: approvalId,
              sessionKey: input.sessionKey,
              runId: input.runId,
              action: name,
              mcp: def.mcp,
              args,
              reason: verdict.reason,
              code: verdict.code,
            });
            emit({ type: "approval_requested", approvalId, name });

            let approved = false;
            let by = "unknown";
            if (input.requestApproval) {
              try {
                approved = await input.requestApproval({
                  id: approvalId,
                  action: name,
                  mcp: def.mcp,
                  args,
                  reason: verdict.reason,
                  code: verdict.code,
                  sessionKey: input.sessionKey,
                  runId: input.runId,
                });
                const decision = store.getApproval(approvalId);
                by = decision?.decidedBy ?? "unknown";
                approved = decision?.status === "approved";
              } catch (err) {
                emit({ type: "error", message: `approval failed: ${(err as Error).message}` });
              }
            }

            if (approved) {
              emit({ type: "approved", name, by });

              // A drift block is a statement about the plan, so the plan has to
              // change. A policy hold is a statement about permission, so the
              // delegation has to change - that already happened, and the retry
              // below picks it up. Doing both is safe: a new plan can never
              // widen what policy permits.
              if (!agent.stepFor(intent, name)) {
                intent = await agent.declareIntentIncluding(intent, {
                  llm: LLM.model,
                  prompt: input.instruction,
                  step: {
                    action: name,
                    mcp: def.mcp,
                    params: {},
                    description: "approved by a human after being blocked",
                  },
                  approvedBy: by,
                  reason: verdict.reason,
                  policy: PICTO_POLICY,
                  validitySeconds: INTENT_TTL_SECONDS,
                });
                planHash = intent.planHash;
                store.updateSession(input.sessionKey, { lastPlanHash: planHash });
                emit({
                  type: "replanned",
                  planHash: intent.planHash,
                  steps: intent.plan.steps.map((step) => step.action),
                });
              }

              verdict = await agent.act(intent, def.mcp, name, params);
            } else {
              emit({ type: "denied", name, by });
              remember(
                toolResult(
                  call.id,
                  `REFUSED: a human declined "${name}". Do not retry it. ` +
                    `Publish the work with push_branch and leave it for review instead.`,
                ),
              );
              continue;
            }
          }
        }

        if (verdict.outcome === "allowed") {
          emit({ type: "allowed", name, mcp: def.mcp, ms: verdict.ms });

          if (name === "push_branch" || name === "push_main") {
            const data = verdict.data as { branch?: string; url?: string } | undefined;
            pushed = data?.branch ?? name.replace("push_", "");
            emit({ type: "pushed", target: pushed, url: data?.url });
          }

          if (name === "write_file" || name === "git_commit") changed = true;

          remember(toolResult(call.id, JSON.stringify(verdict.data ?? {}).slice(0, MAX_TOOL_RESULT_CHARS)));
        } else if (verdict.outcome === "error") {
          // Not a governance decision: the call never reached the tool, for an
          // infrastructure reason. Calling this "refused" is a lie, and the model
          // reasonably reads it as "my permissions are broken" and gives up on
          // the whole task - which is exactly what it did.
          remember(
            toolResult(
              call.id,
              `TOOL FAILED - this was not a policy refusal, the call never reached the tool: ${verdict.reason}. ` +
                `Do not retry it. Tell the user what broke instead of guessing at the code.`,
            ),
          );
        } else {
          remember(
            toolResult(
              call.id,
              `REFUSED by ArmorIQ (${verdict.outcome}): ${"reason" in verdict ? verdict.reason : "unknown"}. ` +
                `Do not retry the same call. Continue with the work you can still do.`,
            ),
          );
        }
      }
    }

    if (!summary) {
      summary = pushed
        ? `Pushed ${pushed}.`
        : `I spent this run's ${MAX_TURNS} tool-call budget without publishing, so there is nothing to review. ` +
          "A follow-up comment resumes this conversation with everything I have already learned — " +
          "the transcript and the clone are kept.";
    }
    store.updateSession(input.sessionKey, { status: pushed ? "published" : "idle" });

    return {
      runId: input.runId,
      sessionKey: input.sessionKey,
      branch: input.branch,
      pushed,
      summary,
      planHash,
      events,
      transcript,
    };
  } catch (err) {
    store.updateSession(input.sessionKey, { status: "error" });
    throw err;
  } finally {
    agent.close();
    if (input.keepWorkspace === false) deps.workspaces.destroy(workspaceId);
  }
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

/**
 * Make a transcript slice that a provider will actually accept.
 *
 * A conversation is a sequence of turns, and a window into a long one can cut into
 * the middle of a turn. Both ends have to be repaired, and either failure is fatal
 * to the whole request rather than to the one message:
 *
 *   - A leading fragment. Everything before the first user turn belongs to a turn
 *     whose beginning fell outside the window: a result with no function name to
 *     report, or a function call with nothing before it. Providers reject the
 *     request over it, in a message that names the symptom rather than the cause -
 *     "function call turn comes immediately after a user turn or after a function
 *     response turn" - which reads as a broken session rather than a short window,
 *     and it stays broken for every comment that follows.
 *
 *   - A trailing assistant turn that promised tool calls whose results never
 *     arrived. A run killed between asking and running leaves this behind, and
 *     every provider rejects a promise that was never answered.
 *
 * A window with no user turn in it has no usable beginning, so it yields nothing:
 * the run continues from its current instruction, which is a better request than a
 * fragment of a turn nobody can read.
 */
export function completeSequences(messages: ChatMessage[]): ChatMessage[] {
  const start = messages.findIndex((message) => message.role === "user");
  const out = start === -1 ? [] : messages.slice(start);

  let index = out.length - 1;
  while (index >= 0 && out[index]?.role === "tool") index -= 1;

  const candidate = index >= 0 ? out[index] : undefined;
  if (candidate?.role === "assistant" && candidate.tool_calls?.length) {
    const expected = candidate.tool_calls.map((call) => call.id);
    const present = new Set(
      out
        .slice(index + 1)
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    );
    if (!expected.every((id) => present.has(id))) out.splice(index);
  }
  return out;
}

/** A repository's own conventions, if it documents them. */
function readAgentsFile(workspaceDir: string): string | null {
  for (const name of ["AGENTS.md", "CLAUDE.md", ".github/CONTRIBUTING.md"]) {
    const file = path.join(workspaceDir, name);
    if (existsSync(file)) {
      try {
        return readFileSync(file, "utf8");
      } catch {
        /* unreadable is the same as absent */
      }
    }
  }
  return null;
}
