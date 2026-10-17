# Picto

Picto is a generalist agent teams can integrate in in github, slack organisation to get productive. all the agent actions are observed and geted by [Armor](https://armoriq.ai)

## The idea

Customers don't open pull requests. They ask in Slack.

- **A guest asks** → the plan is signed read-only. Anything that changes or
  publishes isn't in it, so ArmorIQ refuses. The answer names the way forward:
  a maintainer sends the same request.
- **A maintainer asks** → the plan carries the write tools. Work lands on a branch
  for review.
- **A risky action** → the run stops and an Approve/Deny card appears in the
  thread. A human decides.

Same agent, same question — the difference is who asked, and ArmorIQ decides that,
not the model.

## Quick facts

| | |
|---|---|
| Trigger | Slack mention (`app_mention`) or a GitHub issue comment |
| Governance | `@armoriq/sdk` — signed intent token, per-call enforcement |
| Actions | 2 MCP servers — 4 file tools, 6 repo tools |
| Human in the loop | Slack Approve/Deny card |
| Traces | `platform.armoriq.ai` → Observability → Traces |

## How the pieces fit

```
Slack mention
   │
   ├─ roles.ts       who asked?           PICTO_MAINTAINERS = [your @handle]
   ├─ planner.ts     build the plan       guest → read tools only
   ├─ governed.ts    sign it               ArmorIQ issues an Ed25519 token
   │                                     (per-request identity + rules)
   ├─ invoke()       every tool call      in the token → runs; not in it → refused
   └─ Slack          report back          refusals, plan hash, branch link
```

Authority reaches ArmorIQ two ways, both per request:

- **Identity** — `ARMORIQ_GUEST_USER_ID` vs `ARMORIQ_MAINTAINER_USER_ID`
- **Rules** — a guest's request carries `deny create_issue`; a maintainer's carries none

## Install

```bash
npm install
cp .env.example .env      # every variable is documented there
npm run dev               # :8787
```

Then expose it (`npm run tunnel`) and point three things at `PICTO_PUBLIC_URL`:

| What | Path |
|---|---|
| Slack → Event Subscriptions | `/slack/events` |
| Slack → Interactivity | `/slack/interactions` |
| GitHub App → Webhook URL | `/hooks/github` |

### GitHub App (optional — Slack works without it)

Create an app with Contents/Issues/Pull requests `Read and write`, subscribe to
**Issue comment**, set the webhook secret to match `GITHUB_WEBHOOK_SECRET`. Private
key from the **Key pairs** tab → `GITHUB_APP_PRIVATE_KEY_B64`. Install on the repo.

GitHub only signs a delivery when a secret is set. Without one, every delivery is
rejected and the only symptom is a 401 in the tunnel log. `npm run github:app-config`
tells a wrong URL from a wrong secret.

### Slack

Create an app, subscribe to `app_mention`, put the bot in the channel. Set
`SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `SLACK_SIGNING_SECRET`, and `PICTO_MAINTAINERS`
to your own @handle. Then mention the bot.

## Why it's not a prompt

The model proposes. It cannot approve.

- `packages/agent-core/src/governed.ts` has no bypass — no `unsafeInvoke`. A tool
  outside the signed plan can only be refused.
- `push_main` and `run_command` are never declared into any plan. The agent cannot
  reach them even if asked.
- A signed plan cannot be edited. Approving an action signs a **new** plan.

**Threat model:** ArmorIQ constrains *which tools*, not *what arguments*. A tool with
a wide surface grants a wide surface — hence no shell.

## Verify

```bash
npm run typecheck
npm run slack:check      # does Slack reach us?
npm run mcp:check        # does ArmorIQ have our MCP servers?
npm run slack:sim -- "what does the readme say?"
```

Console: `platform.armoriq.ai` → **Observability → Traces** (one trace per signed
plan, with the policy decision) and **Intent → Held Actions** (every plan, ever).

## Layout

```
apps/backend/src/
  mcps/registry.ts   the whole tool surface, one source of truth
  mcps/fs/           read_file, write_file, list_files, search_code
  mcps/repo/         run_command, git_branch, git_commit, push_branch, push_main, create_issue
  slack/             events in, cards out
  github/            the second trigger
packages/agent-core/src/governed.ts    the enforcement layer
```