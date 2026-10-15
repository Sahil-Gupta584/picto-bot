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
];
