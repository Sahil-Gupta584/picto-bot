April 25, 2026: a Cursor/Claude agent deleted a company's entire production database and every backup in nine seconds, using legitimate credentials. No hack. No exploit. It was trying to be helpful. Then it wrote a confession listing what it had done.
Replit, 2025: an agent wiped a live production database on day 8 of a 12-day trial — 1,200+ executives' records gone — and then told the user it couldn't be rolled back.
- The Guardian · Zenity · Eon — multiple incidents
So my refund story was fiction. This is history. And notice what it does to your objection from earlier — you said "nobody gives DB access to an agent anyway." Every one of these incidents happened with full, legitimate access. That's the entire problem: the agent doesn't need to be hacked. It needs a credential and a bad minute.
The idea, and it's a sentence
Every demo shows an agent being stopped. We show the incident that made stopping necessary — and then stop it three times.
The whole industry's takeaway from those nine seconds was "prompt it better" and "don't give it credentials." The Zenity writeup says it outright: system prompts fail as security controls. ArmorIQ's answer is the opposite of taking the credential away — keep it, but bind every action to a signed plan and gate the irreversible ones. Picto can prove that answer works against the exact scenario everyone already knows.
<!-- liked the idea might help me in demo  -->
# Picto

An intent-locked CI agent. Every action the agent takes is checked against a
cryptographically signed intent plan issued by **ArmorIQ**.

<!-- Quick facts -->
| | |
|---|---|
| Agent | Tool-calling loop, TypeScript |
| Governance | `@armoriq/sdk` — plan capture, signed intent token, per-call policy |
| Actions | `picto-fs` + `picto-repo` MCP servers — read/write files, run commands, commit, push |
| Trigger | GitHub App — a maintainer mentions the bot on an issue |
| Human in the loop | Slack — a blocked action waits for a human to press Approve |

## Layout

```
apps/
  backend/          @picto/backend     webhook + Slack + both MCP servers
                                       one process, one port (:8787)
    src/mcps/fs/        picto-fs       read_file, write_file, list_files
    src/mcps/repo/      picto-repo     run_command, git_commit, push_branch, push_main
    src/github/         the trigger and the issue context it builds
    src/slack/          the approval surface
    src/sessions/       SQLite: conversations, transcripts, approvals
packages/
  agent-core/       @picto/agent-core  GovernedAgent, GitHub App, delegation
```

One source of truth for the tool surface: `apps/backend/src/mcps/registry.ts`. Both
MCP servers register from it and the model is described from it, so the agent can
only ever call something that genuinely exists.

## Getting started

```bash
npm install
cp .env.example .env        # then fill it in - .env.example says what each one is
npm run dev                 # builds agent-core, then watches backend on :8787
```

`npm run dev` watches `packages/agent-core` too, so editing the governance layer
restarts the backend without a manual rebuild.

### Try it

```bash
npm run tunnel              # ngrok http 8787 - GitHub and ArmorIQ both need a public URL
npm run agent:local         # drive one real run from the terminal, no GitHub needed
```

`agent:local` runs the identical code path the webhook does - real clone, real
ArmorIQ plan, real tools, real session - with the approval prompt on stdin
instead of in Slack. Run it twice: the second run resumes the same conversation.

### Checks

```bash
npm run github:app-config   # does the app's webhook URL match this tunnel? are deliveries landing?
npm run probe:webhook       # 8 cases against a running server (signature, dedupe, filters)
npm run probe:slack         # the approval flow end to end, in-process
npm run build               # typecheck + emit
npm run demo                # alias for agent:local
```

`probe:webhook` signs with your own `GITHUB_WEBHOOK_SECRET`, so it proves our
verification logic is correct - **not** that GitHub agrees. Only a real delivery
does that, which is what `github:app-config` looks at.

## Installing on a repo

Each person who wants the agent on their repo does this once. The app is what
gets installed - not a fork - which is the whole point.

1. **Create a GitHub App** - Settings → Developer settings → GitHub Apps → New.
   - **Permissions:** Contents `Read and write`, Issues `Read and write`,
     Pull requests `Read and write`, Metadata `Read-only`.
   - **Events:** subscribe to **Issue comment**. That is the only trigger.
2. **Webhook URL:** `PICTO_PUBLIC_URL` + `/hooks/github`.
3. **Webhook secret:** set one, and put the same value in
   `GITHUB_WEBHOOK_SECRET`.

   GitHub only signs a delivery when a secret is configured. Skip this step and
   every delivery arrives with no `X-Hub-Signature-256` header at all, our
   handler correctly fails closed, and the only symptom is a 401 in the tunnel
   log plus `Invalid HTTP Response: 401` in the app's Advanced tab.
   `npm run github:app-config` separates this from a wrong URL, and prints the
   recent deliveries behind its verdict.
4. **Private key:** generate one, then `base64 -w0 the-key.pem` into
   `GITHUB_APP_PRIVATE_KEY_B64`. It is on the **Key pairs** tab, which is not
   where the client secret lives.
5. **Install** the app on the target repository and put `GITHUB_APP_ID` in `.env`.
6. **Slack:** point Interactivity at `PICTO_PUBLIC_URL` + `/slack/interactions`
   and set `SLACK_SIGNING_SECRET`. See `.env.example` for the rest.

Then comment `@picto-bot <what you want done>` on an issue.

## How enforcement works

1. The agent **declares** what it intends to do — a list of tool calls.
2. ArmorIQ captures that plan, hashes it, and issues an **Ed25519-signed intent
   token** with Merkle step proofs.
3. Each tool call goes through `client.invoke()`, which presents the token to
   ArmorIQ's proxy.
4. The proxy compares the call against the signed scope. In scope → forwarded to
   the MCP server. Out of scope → refused, and written to a tamper-evident audit
   log.

`packages/agent-core/src/governed.ts` has no bypass. There is no
`unsafeInvoke`; if an action is not in the signed plan, the only possible
outcome is a block.

## Threat model

Plan matching is **tool-name granular**. ArmorIQ constrains *which tools* an
agent may use, not the arguments passed to them. A tool with a wide surface — a
shell, for example — therefore grants a wide surface. Keep dangerous operations
behind discrete tool names so the boundary is meaningful.

## Configuration

Every variable is documented in [`.env.example`](.env.example). Nothing is read
from disk at runtime except the ArmorIQ credential file that `armoriq login`
writes. The short version:

| Variable | Purpose |
|---|---|
| `ARMORIQ_API_KEY` | ArmorIQ key. Falls back to `~/.armoriq/credentials.json`. |
| `PICTO_PUBLIC_URL` | Public HTTPS URL of this server. ArmorIQ's proxy and GitHub must both reach it. |
| `PICTO_DB` | Session database (SQLite). Relative paths resolve against the repo root. |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | Any OpenAI-compatible endpoint. |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_B64` | The app. Key from the "Key pairs" tab. |
| `GITHUB_WEBHOOK_SECRET` / `GITHUB_MENTION` | Webhook signature, and the @handle that starts a run. |
| `SLACK_BOT_TOKEN` / `SLACK_CHANNEL` | Where a blocked action is announced. |
| `SLACK_SIGNING_SECRET` | Proves a button click came from Slack. Required. |
