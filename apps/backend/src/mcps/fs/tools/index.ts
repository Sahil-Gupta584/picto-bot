/**
 * picto-fs - filesystem tools for one workspace.
 *
 * Every path is resolved inside the workspace directory. `../` and absolute
 * paths are refused, so the agent cannot reach anything outside the clone it was
 * given - not the developer's tree, not the host.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MCP } from "../../../config.js";
import type { ToolDefinition } from "../../types.js";

/** The name this server is registered under in ArmorIQ. See config.ts. */
export const FS_MCP_NAME = MCP.fs;

/** Directories that are noise for a coding agent and expensive to walk. */
const SKIP = new Set(["node_modules", ".git", "dist", ".next", ".turbo", "coverage"]);

/** Files a search should not open: binaries, lockfiles, and bundled output. */
const SKIP_FILE = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "*.lock",
]);

const SEARCH_MAX_FILES = 5_000;
const SEARCH_MAX_MATCHES = 100;
const SEARCH_MAX_BYTES = 512 * 1024;

/** Files that hold bytes but no searchable text. */
function isSearchable(name: string): boolean {
  if (SKIP.has(name)) return false;
  if (SKIP_FILE.has(name)) return false;
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return false;
  if (name.endsWith(".gif") || name.endsWith(".ico") || name.endsWith(".pdf")) return false;
  if (name.endsWith(".zip") || name.endsWith(".gz") || name.endsWith(".woff2")) return false;
  return true;
}

/**
 * Turn a text pattern into a regular expression.
 *
 * A plain string is matched literally, because a coding agent searching for
 * `ListThreadCounts` does not mean the regular expression `List.*Counts`. Only an
 * explicit `/.../ flags` form is treated as one, which is how the agent can ask
 * for a real pattern when it wants one.
 */
function toMatcher(pattern: string): { test: (line: string) => boolean; regex: boolean } {
  const asRegex = pattern.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (!asRegex) return { test: (line) => line.includes(pattern), regex: false };

  const [, source, flags] = asRegex;
  // `g` is meaningless here: every line is tested once.
  const cleaned = (flags ?? "").replace(/[gy]/g, "");
  try {
    const re = new RegExp(source ?? pattern, cleaned);
    return { test: (line) => re.test(line), regex: true };
  } catch {
    // An unusable pattern is the caller's mistake, not a reason to fail the run.
    return { test: (line) => line.includes(pattern), regex: false };
  }
}

const WORKSPACE_ARG = z
  .string()
  .describe("Workspace this run is working in. Supplied by the runner.");

export const fsTools: ToolDefinition[] = [
  {
    mcp: FS_MCP_NAME,
    name: "read_file",
    title: "Read a file",
    description:
      "Read a file from the repository, relative to its root. Read before you edit - " +
      "write_file replaces the whole file, so you need to know what is in it.",
    shape: {
      workspace: WORKSPACE_ARG,
      path: z.string().describe("Path relative to the repository root"),
    },
    handler: async (args, ctx) => {
      const abs = ctx.workspaces.resolve(String(args.workspace), String(args.path));
      const contents = readFileSync(abs, "utf8");
      return { path: args.path, bytes: Buffer.byteLength(contents), contents };
    },
  },
  {
    mcp: FS_MCP_NAME,
    name: "write_file",
    title: "Write a file",
    description:
      "Create or overwrite a file with its complete new contents. This replaces the " +
      "whole file, so read it first and keep everything that should not change.",
    shape: {
      workspace: WORKSPACE_ARG,
      path: z.string().describe("Path relative to the repository root"),
      contents: z.string().describe("The complete new contents of the file"),
    },
    handler: async (args, ctx) => {
      const abs = ctx.workspaces.resolve(String(args.workspace), String(args.path));
      mkdirSync(path.dirname(abs), { recursive: true });
      const contents = String(args.contents);
      writeFileSync(abs, contents, "utf8");
      return { path: args.path, bytes: Buffer.byteLength(contents) };
    },
  },
  {
    mcp: FS_MCP_NAME,
    name: "list_files",
    title: "List files",
    description:
      "List files and directories under a path. Use this first to get oriented in an " +
      "unfamiliar repository instead of guessing at paths.",
    shape: {
      workspace: WORKSPACE_ARG,
      path: z.string().default(".").describe("Directory to list, relative to the repository root"),
      depth: z.number().int().min(1).max(4).default(2).describe("How many levels deep to walk"),
    },
    handler: async (args, ctx) => {
      const workspace = String(args.workspace);
      const base = ctx.workspaces.resolve(workspace, String(args.path ?? "."));
      const depth = Number(args.depth ?? 2);
      const root = ctx.workspaces.resolve(workspace);
      const entries: Array<{ path: string; type: "file" | "dir"; bytes?: number }> = [];

      const walk = (dir: string, remaining: number): void => {
        if (remaining < 0) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP.has(entry.name)) continue;
          const abs = path.join(dir, entry.name);
          const rel = path.relative(root, abs).split(path.sep).join("/");
          if (entry.isDirectory()) {
            entries.push({ path: rel, type: "dir" });
            walk(abs, remaining - 1);
          } else if (entry.isFile()) {
            entries.push({ path: rel, type: "file", bytes: statSync(abs).size });
          }
        }
      };

      walk(base, depth);
      return { path: args.path, count: entries.length, entries: entries.slice(0, 500) };
    },
  },
  {
    mcp: FS_MCP_NAME,
    name: "search_code",
    title: "Search code",
    description:
      "Search the repository for text, returning matching lines with their file and " +
      "line number. Use this to find where something is defined or used instead of " +
      "reading files one at a time. Narrow it with `path` when you already know the " +
      "directory - it is much faster than searching the whole tree.",
    shape: {
      workspace: WORKSPACE_ARG,
      pattern: z
        .string()
        .describe(
          "Text to look for, matched literally. Wrap it in slashes (e.g. /Thread\\w+/) to search with a regular expression instead",
        ),
      path: z.string().default(".").describe("Directory to search under, relative to the repository root"),
      glob: z.string().optional().describe("Only search files whose name ends with this, e.g. .ts"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_MAX_MATCHES)
        .default(50)
        .describe("How many matching lines to return at most"),
    },
    handler: async (args, ctx) => {
      const workspace = String(args.workspace);
      // Scoping is optional, and the default is the whole workspace: searching a
      // directory is the fast path, not a requirement of the tool.
      const dirArg = String(args.path ?? ".");
      const base = ctx.workspaces.resolve(workspace, dirArg);
      const root = ctx.workspaces.resolve(workspace);
      const suffix = args.glob ? String(args.glob) : undefined;
      const limit = Number(args.maxResults ?? 50);
      const { test, regex } = toMatcher(String(args.pattern));

      const matches: Array<{ path: string; line: number; text: string }> = [];
      let filesScanned = 0;
      let truncated = false;

      const walkDir = (dir: string): void => {
        if (matches.length >= limit || filesScanned >= SEARCH_MAX_FILES) {
          truncated = true;
          return;
        }
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= limit || filesScanned >= SEARCH_MAX_FILES) {
            truncated = true;
            return;
          }
          if (!isSearchable(entry.name)) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walkDir(abs);
            continue;
          }
          if (!entry.isFile()) continue;
          if (suffix && !entry.name.endsWith(suffix)) continue;

          filesScanned += 1;
          let contents: string;
          try {
            const stat = statSync(abs);
            if (stat.size > SEARCH_MAX_BYTES) continue;
            contents = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          // A file with no newline in it is not source we can read.
          if (contents.includes("\0")) continue;

          const lines = contents.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] ?? "";
            if (!test(line)) continue;
            matches.push({
              path: path.relative(root, abs).split(path.sep).join("/"),
              line: i + 1,
              text: line.trim().slice(0, 300),
            });
            if (matches.length >= limit) {
              truncated = true;
              return;
            }
          }
        }
      };

      walkDir(base);

      return {
        pattern: args.pattern,
        searched: dirArg,
        regex,
        filesScanned,
        count: matches.length,
        truncated,
        matches,
      };
    },
  },
];
