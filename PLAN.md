# SENTINEL — Hackathon Plan

**Flow State 2026 · Deadline Oct 17 · Solo · ~2.5 days remaining**

Goal: an agent a team triggers from GitHub/Slack that does real work, governed by
ArmorIQ, with one action allowed and one blocked — proven live.

---

## 1. Verified vs Unknown

Everything below is marked. Do not build on an UNKNOWN without testing it first.

### VERIFIED working

| Fact | Evidence |
|---|---|
| ArmorIQ account + live key | `ak_live…` in `~/.armoriq/credentials.json` |
| Plan signing works | token `667f4906…`, plan_hash `d17637de…` |
| Ed25519 signatures issued | `3046022100d0e682e…` |
| Merkle step proofs returned | `stepProofs=2` |
| `@armoriq/sdk@0.6.10` installed | `C:\s\armor\node_modules` |
| MCP server builds + serves | 10 tools, `tools/list` confirmed on `:8787` |
| Sandbox git repo works | real commits, real files, real logs |
| `opencode/big-pickle` free model responds | `EXIT=0`, returned `ok` |
| Node v24.17.0 | meets OpenClaw `>=24.16.0 <25` |
| ngrok installed | `C:\Program Files\ngrok.exe` |
| Competitor bar is low | iambatsy: Telegram bot + $100k spend limit |

### VERIFIED broken

| Fact | Cause |
|---|---|
| ArmorOpenCode on Windows | ships untranspiled TS; Windows loader is strip-only |
| `anthropic/*` models | config referenced them with no Anthropic auth → dead |
| `opencode plugin list` | returns nothing on Windows |

### UNKNOWN — test before depending on it

| Unknown | Risk |
|---|---|
| OpenClaw + ArmorClaw on Windows | **blocking** |
| Slack approval flow | high |
| ArmorIQ proxy reaching our MCP | needs public URL |
| ngrok URL stability | re-register on restart |

---

## 2. ArmorIQ enforcement model (from source, `armorOpenCode/src/core/decide.ts`)

Order of checks. First match wins:

```
1. built-in rules          → deny   (~/.armoriq read/write)
2. plugin's own tools      → allow  (register_intent_plan …)
3. policy: forbid          → DENY   ← absolute, cannot be planned around
   policy: require_approval→ HOLD  ← absolute
4. session.mode === monitor→ allow
5. token refused           → DENY   (revoked / billing)
6. no plan / no token      → DENY   intent_plan_missing
7. token expired           → DENY   intent_token_expired
8. tool not in plan        → DENY   intent_drift
9. token.deniedTools       → DENY   backend_denied_tool
10. token.heldTools        → HOLD
11. otherwise              → ALLOW
```

Two facts that shape the whole design:

1. **Policy is checked before the plan.** A `forbid` or `hold` is absolute.
2. **Plan matching is tool-NAME only.** `intent.ts:100` —
   `// Tool membership decides; params are advisory`. A `paramMismatch` flag still
   returns `kind: "allow"`.

**Consequence:** `bash` in a plan means *every* bash command runs — `alembic
upgrade` and `rm -rf /` are identical to the checker. To block one specific
command we need either:

- **policy** on `bash.program` / `bash.raw` — `forbid`, absolute, ~10 lines
- **discrete MCP tools** so the dangerous action is a different tool name

---

## 3. Architecture

```
GitHub issue comment  ──┐
                        ├──▶ trigger service
Slack @mention ─────────┘         │
                                  ▼
                    openclaw  (Linux VM)
                    + ArmorClaw (ArmorIQ plugin)
                                  │
                        intent plan declared + signed
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
        in-scope actions                    off-plan action
        edit · commit · open PR              run migration
                │                                   │
             ✅ ALLOWED                    ⛔ BLOCKED at the hook
                                                      │
                                          audit → ArmorIQ console
```

**Key point:** ArmorClaw hooks OpenClaw's tool lifecycle (`before_tool_call`), so
native tools — `bash`, `edit`, `read` — are gated. The agent keeps its full
toolset. Nothing is restricted by us; ArmorIQ decides from the signed plan.

---

## 4. Phases

### Phase 0 — Prove OpenClaw + ArmorClaw runs ⚠️ BLOCKING
**~1h · Do this first. If it fails, fall back to SDK (Phase 2b).**

1. `npm i -g openclaw@2026.6.34` (LTS — what ArmorClaw is verified against)
2. Clone ArmorClaw, `npm install && npm run build:install`
3. `openclaw plugins list` → must show `armorclaw | loaded`
4. Run one turn, confirm the intent directive is injected

**Exit:** plugin loads AND a block fires. Nothing else matters until this passes.

**If it fails:** go to WSL (Ubuntu 22 is installed) or switch to SDK.

---

### Phase 1 — MCP server
**~1.5h · mostly done**

The `sentinel-ci` MCP server exists with 10 real tools over a real git repo.
Needs:
1. Tools for the demo scenario (read schema, write migration, commit, open PR,
   **run migration**)
2. Expose publicly — `ngrok http 8787`
3. Register with ArmorIQ (`armoriq register`, or dashboard)
4. Confirm the ArmorIQ proxy reaches it

**Exit:** one `invoke()` returns real data.

---

### Phase 2a — The block
**~1.5h**

Task: *"Issue #1: users table missing an index, page load slow."*

| Step | Action | Expected |
|---|---|---|
| 1 | read schema | ✅ allowed |
| 2 | write migration file | ✅ allowed |
| 3 | commit, open draft PR | ✅ allowed |
| 4 | `run_migration` | ⛔ **BLOCKED** |

Block via **policy on `bash.program`** — fastest, needs no new tools:

```yaml
statements:
  - id: no-migrations
    effect: forbid
    when: { bash.program: { in: [alembic, prisma, knex, psql, migrate] } }
```

**Exit:** screenshot the blocked call + plan detail in the ArmorIQ console.

### Phase 2b — SDK fallback
If Phase 0 fails: wrap each tool call with `@armoriq/sdk` directly.
`capturePlan → getIntentToken → invoke`. Same enforcement, we control it,
works on Windows today.

---

### Phase 3 — Slack
**~2h · only if Phase 2 lands with time left**

OpenClaw has native Slack. ArmorClaw has `policyUpdateEnabled` +
`policyUpdateAllowList` — chat-driven policy management.

**Honest caveat:** ArmorClaw's `hold` is *"blocked, not run"* — there is **no
resume mechanism**. An Approve button cannot unblock the in-flight call. What is
buildable: Approve → inject `"approved"` into the session via the OpenClaw API →
agent re-registers a wider plan (supported natively) → retries → allowed.

**Decision: ship the block first. Slack is polish, not a dependency.**

---

### Phase 4 — Demo assets
**~1.5h**

- README: architecture, what ArmorIQ does, honest method disclosure
- 90s video, beat sheet below
- Screenshots: plan detail, blocked call, audit trail

---

## 5. 90-second video

| Time | Screen | Beat |
|---|---|---|
| 0:00–0:08 | title | "An agent fixes your CI. Watch what it tries next." |
| 0:08–0:18 | Slack/GitHub | maintainer: *"@agent fix issue #1 and open a PR"* |
| 0:18–0:28 | terminal | plan captured + signed, hash + steps shown |
| 0:28–0:48 | terminal | agent works: reads, fixes, commits, opens PR — ✅ ×4 |
| 0:48–1:00 | terminal | agent runs migration — ⛔ **BLOCKED** |
| 1:00–1:15 | ArmorIQ console | plan detail, Merkle chain, block in audit |
| 1:15–1:30 | title | "ArmorIQ didn't ask the agent to behave. It made misbehaving impossible." |

**The beat that kills any "hardcoded" objection:** same agent, same command, two
runs — plan excludes the migration → blocked; plan includes it → runs. Only the
signed plan changed.

---

## 6. Risks

| Risk | Likelihood | Fallback |
|---|---|---|
| OpenClaw + ArmorClaw fails on Windows | Medium | WSL, or SDK path |
| Model out of credits mid-demo | Medium | `opencode/big-pickle` is free; Bedrock profile also configured |
| ngrok URL changes | Medium | re-run `armoriq register` |
| Slack setup eats the deadline | High | cut Phase 3 entirely |
| Agent volunteers and never tries the migration | Low | the task implies verifying; if it won't, prompt asks it to run tests |

---

## 7. Cut list, in order

1. Discord — not mentioned in the brief
2. Slack Approve button — block alone satisfies the requirement
3. Live demo — record the video early, it's the deliverable
4. Multi-agent / subagent demos

**Never cut:** MCP server, ArmorIQ allow + block, README, video.

---

## 8. Deliverables checklist

- [ ] GitHub repo with code + README + setup steps
- [ ] ≥1 MCP server registered to ArmorIQ
- [ ] ArmorIQ proof: one ✅ allowed, one ⛔ blocked
- [ ] Demo video, ≤90s
- [ ] Short description: what, how the agent works, how ArmorIQ is used

---

## 9. Immediate next action

**Run Phase 0.** Everything else is blocked on whether OpenClaw + ArmorClaw loads.

```bash
npm i -g openclaw@2026.6.34
git clone https://github.com/armoriq/armorclaw
cd armorclaw && npm install && npm run build:install
openclaw plugins list      # expect: armorclaw | loaded
```