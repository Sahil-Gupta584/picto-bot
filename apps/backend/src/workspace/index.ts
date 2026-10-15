/**
 * Per-run working copies.
 *
 * Every run gets its own clone of the repository, created when the run starts
 * and deleted when it ends. Nothing is shared between runs, and a developer's
 * own working tree is never touched.
 *
 *   <root>/<id>/            the clone
 *
 * The installation token is held in memory, keyed by workspace id - never
 * written into the clone, where the agent could read it back out of .git/config.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface WorkspaceRecord {
  id: string;
  dir: string;
  owner: string;
  repo: string;
  /** Branch the agent pushes to. Never the default branch. */
  branch: string;
  createdAt: number;
}

interface Stored extends WorkspaceRecord {
  token: string;
}

/** Refuse any path that escapes `base`. */
function assertInside(base: string, candidate: string): string {
  const abs = path.resolve(base, candidate);
  const rel = path.relative(base, abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return abs;
  throw new Error(`path escapes the workspace: ${candidate}`);
}

export class Workspaces {
  private readonly records = new Map<string, Stored>();

  constructor(private readonly root: string) {
    mkdirSync(this.root, { recursive: true });
  }

  get rootDir(): string {
    return this.root;
  }

  /**
   * Clone `owner/repo` into a fresh directory.
   *
   * The remote URL carries no credentials: authentication is passed as a
   * per-invocation header so the token never lands in .git/config.
   */
  async create(input: {
    id: string;
    owner: string;
    repo: string;
    ref?: string;
    branch: string;
    token: string;
  }): Promise<WorkspaceRecord> {
    if (this.records.has(input.id)) throw new Error(`workspace already exists: ${input.id}`);

    const dir = assertInside(this.root, input.id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const url = `https://github.com/${input.owner}/${input.repo}.git`;
    const args = ["clone", "--depth", "1", "--quiet"];
    if (input.ref) args.push("--branch", input.ref);
    args.push(url, dir);

    try {
      execFileSync("git", [...this.authArgs(input.token), ...args], {
        stdio: "pipe",
        encoding: "utf8",
      });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`clone failed: ${sanitize(errorText(err), input.token)}`);
    }

    const record: Stored = {
      id: input.id,
      dir,
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      createdAt: Date.now(),
      token: input.token,
    };
    this.records.set(input.id, record);
    return publicView(record);
  }

  /** The workspace for `id`, or undefined. Never throws - used to test for one. */
  find(id: string): WorkspaceRecord | undefined {
    const found = this.records.get(id);
    return found ? publicView(found) : undefined;
  }

  /**
   * Is there a checkout on disk for `id`?
   *
   * Deliberately answers from disk, not from memory. After a restart the record
   * is gone while the directory is not, and asking memory alone would say "no
   * workspace here" and re-clone over the top of work that was never pushed.
   */
  exists(id: string): boolean {
    try {
      return existsSync(assertInside(this.root, id));
    } catch {
      return false;
    }
  }

  /**
   * Re-bind a directory that already exists on disk.
   *
   * This is what makes a session resumable across a restart. The clone survived
   * on disk; the installation token did not, because it only ever lived in
   * memory. Re-attaching gives the same checkout a fresh credential instead of
   * throwing away work that has not been pushed yet.
   */
  attach(input: {
    id: string;
    owner: string;
    repo: string;
    branch: string;
    token: string;
  }): WorkspaceRecord {
    const dir = assertInside(this.root, input.id);
    if (!existsSync(dir)) throw new Error(`workspace directory is missing: ${dir}`);
    const record: Stored = {
      id: input.id,
      dir,
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      createdAt: Date.now(),
      token: input.token,
    };
    this.records.set(input.id, record);
    return publicView(record);
  }

  /** The workspace for `id`, or a clear error. */
  get(id: string): Stored {
    const found = this.records.get(id);
    if (!found) {
      const known = [...this.records.keys()];
      throw new Error(
        `unknown workspace "${id}"${known.length ? `. known: ${known.join(", ")}` : ""}`,
      );
    }
    return found;
  }

  /** Absolute path of `relative` inside the workspace, refusing any escape. */
  resolve(id: string, relative = "."): string {
    return assertInside(this.get(id).dir, relative);
  }

  /**
   * Git arguments that authenticate as the app for this workspace. The token is
   * passed through `-c` rather than the remote URL.
   */
  authArgs(token: string): string[] {
    const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
  }

  list(): WorkspaceRecord[] {
    return [...this.records.values()].map(publicView);
  }

  destroy(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    rmSync(record.dir, { recursive: true, force: true });
  }

  /** Remove workspaces left behind by a crash. */
  sweepOlderThan(ms: number): number {
    let removed = 0;
    for (const entry of readdirSync(this.root)) {
      const dir = path.join(this.root, entry);
      try {
        if (Date.now() - statSync(dir).mtimeMs > ms && !this.records.has(entry)) {
          rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        /* skip */
      }
    }
    return removed;
  }
}

function publicView(record: Stored): WorkspaceRecord {
  const { token: _token, ...rest } = record;
  return rest;
}

function errorText(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: string; message?: string };
    return String(e.stderr ?? e.message ?? err);
  }
  return String(err);
}

/** Never let a token reach a log line or an error message. */
function sanitize(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}
