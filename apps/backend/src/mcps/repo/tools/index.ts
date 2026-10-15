/**
 * picto-repo - run commands and move work to GitHub, inside one workspace.
 *
 * Why these five live together: they all operate on the working copy rather than
 * on its contents.
 *
 * `push_branch` and `push_main` are separate tools on purpose. ArmorIQ matches
 * tool NAMES, not arguments - a single `git_push` tool would make "publish a
 * branch" and "publish to main" the same capability, and policy could not tell
 * them apart. Splitting them is what makes it possible to allow one and hold the
 * other.
 *
 * `git_branch` exists so that moving to a branch never requires the shell. It is
 * one reversible act with a name of its own, which is what lets it be granted
 * outright while `run_command` stays something a human has to approve.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { MCP } from "../../../config.js";
import type { ToolDefinition } from "../../types.js";

const execFileAsync = promisify(execFile);

/** The name this server is registered under in ArmorIQ. See config.ts. */
export const REPO_MCP_NAME = MCP.repo;

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const WORKSPACE_ARG = z
  .string()
  .describe("Workspace this run is working in. Supplied by the runner.");

/**
 * The environment handed to a shell command.
 *
 * An allowlist, not the parent environment. process.env holds the ArmorIQ key,
 * the Slack token and the GitHub private key; none of them may be readable by a
 * command the agent decides to run.
 */
function sandboxEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "windir",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SHELL",
    "NUMBER_OF_PROCESSORS",
  ];
  const env: NodeJS.ProcessEnv = { CI: "true", GIT_TERMINAL_PROMPT: "0" };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Git identity for commits, without depending on any global git config. */
const GIT_IDENTITY = [
  "-c",
  "user.name=picto-agent",
  "-c",
  "user.email=picto-agent@users.noreply.github.com",
];

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_BYTES) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT_BYTES), truncated: true };
}

/**
 * Switch the working copy to `branch`, creating it if it does not exist yet.
 *
 * Deliberately not `checkout -B`: `-B` resets an existing branch to the current
 * commit, so asking to switch to a branch that already holds work would quietly
 * discard that work. Creating a branch and overwriting one are different acts, and
 * only the first is being asked for here.
 */
async function checkoutBranch(dir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["checkout", branch], { cwd: dir, env: sandboxEnv() });
    return false;
  } catch {
    await execFileAsync("git", ["checkout", "-b", branch], { cwd: dir, env: sandboxEnv() });
    return true;
  }
}

function sanitize(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

export const repoTools: ToolDefinition[] = [
  {
    mcp: REPO_MCP_NAME,
    name: "run_command",
    title: "Run a command",
    description:
      "Run a shell command in the repository root, for example to install dependencies, " +
      "run tests, or search the code. Returns stdout, stderr and the exit code. Read the " +
      "exit code - a failing test suite is information, not an error.",
    shape: {
      workspace: WORKSPACE_ARG,
      command: z.string().describe("Shell command to run in the repository root"),
    },
    handler: async (args, ctx) => {
      const record = ctx.workspaces.get(String(args.workspace));
      const command = String(args.command);
      try {
        const { stdout, stderr } = await execFileAsync(command, {
          cwd: record.dir,
          env: sandboxEnv(),
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          shell: true,
        });
        const out = truncate(stdout);
        const err = truncate(stderr);
        return {
          command,
          exit_code: 0,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
        };
      } catch (error) {
        const e = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string;
        };
        const out = truncate(e.stdout ?? "");
        const err = truncate(e.stderr ?? "");
        return {
          command,
          exit_code: typeof e.code === "number" ? e.code : null,
          timed_out: Boolean(e.killed) || e.signal === "SIGTERM",
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
        };
      }
    },
  },

  {
    mcp: REPO_MCP_NAME,
    name: "git_branch",
    title: "Create or switch branch",
    description:
      "Create a branch, or switch to one that already exists, before making changes. " +
      "This only moves the working copy - nothing is published until push_branch.",
    shape: {
      workspace: WORKSPACE_ARG,
      branch: z
        .string()
        .describe("Branch to create or switch to, for example fix/rate-limit-window"),
    },
    handler: async (args, ctx) => {
      const record = ctx.workspaces.get(String(args.workspace));
      const branch = String(args.branch);
      const from = record.branch;
      const created = await checkoutBranch(record.dir, branch);
      ctx.workspaces.setBranch(record.id, branch);
      return { branch, created, from };
    },
  },

  {
    mcp: REPO_MCP_NAME,
    name: "git_commit",
    title: "Commit the working copy",
    description: "Stage every change in the repository and commit it.",
    shape: {
      workspace: WORKSPACE_ARG,
      message: z.string().describe("Commit message describing the change"),
    },
    handler: async (args, ctx) => {
      const record = ctx.workspaces.get(String(args.workspace));
      const message = String(args.message);
      await execFileAsync("git", ["add", "-A"], { cwd: record.dir, env: sandboxEnv() });
      const { stdout } = await execFileAsync(
        "git",
        [...GIT_IDENTITY, "commit", "--allow-empty", "-m", message],
        { cwd: record.dir, env: sandboxEnv() },
      );
      const { stdout: sha } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: record.dir,
        env: sandboxEnv(),
      });
      return { branch: record.branch, sha: sha.trim(), summary: stdout.trim() };
    },
  },

  {
    mcp: REPO_MCP_NAME,
    name: "push_branch",
    title: "Push a branch",
    description:
      "Push a new branch so a pull request can be opened. Use this to publish work - " +
      "it is reviewable and reversible.",
    shape: {
      workspace: WORKSPACE_ARG,
      branch: z
        .string()
        .describe("Branch name to create and push, for example fix/rate-limit-window"),
    },
    handler: async (args, ctx) => {
      const record = ctx.workspaces.get(String(args.workspace));
      const branch = String(args.branch);
      const auth = ctx.workspaces.authArgs(record.token);
      try {
        await execFileAsync("git", ["checkout", "-B", branch], {
          cwd: record.dir,
          env: sandboxEnv(),
        });
        await execFileAsync("git", [...auth, "push", "--set-upstream", "origin", branch], {
          cwd: record.dir,
          env: sandboxEnv(),
        });
        ctx.workspaces.setBranch(record.id, branch);
        return {
          pushed: true,
          branch,
          url: `https://github.com/${record.owner}/${record.repo}/tree/${branch}`,
        };
      } catch (error) {
        throw new Error(sanitize((error as Error).message, record.token));
      }
    },
  },

  {
    mcp: REPO_MCP_NAME,
    name: "push_main",
    title: "Push directly to the default branch",
    description:
      "Push the current commit straight to main, bypassing review. This publishes to the " +
      "default branch immediately and cannot be undone by closing a pull request. Prefer " +
      "push_branch and a pull request unless you have been explicitly asked for this.",
    shape: {
      workspace: WORKSPACE_ARG,
      reason: z
        .string()
        .describe("Why this must go to the default branch instead of a pull request"),
    },
    handler: async (args, ctx) => {
      const record = ctx.workspaces.get(String(args.workspace));
      const auth = ctx.workspaces.authArgs(record.token);
      try {
        await execFileAsync("git", [...auth, "push", "origin", "HEAD:refs/heads/main"], {
          cwd: record.dir,
          env: sandboxEnv(),
        });
        return {
          pushed: true,
          branch: "main",
          url: `https://github.com/${record.owner}/${record.repo}/commit/${record.branch}`,
          reason: args.reason,
        };
      } catch (error) {
        throw new Error(sanitize((error as Error).message, record.token));
      }
    },
  },
];
