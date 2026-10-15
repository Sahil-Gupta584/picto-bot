/**
 * GitHub App authentication, on top of the official Octokit SDK.
 *
 * Octokit owns the parts that are easy to get subtly wrong:
 *   - signing the app JWT
 *   - exchanging it for a per-installation token, and refreshing before expiry
 *   - verifying `X-Hub-Signature-256` on incoming webhooks, in constant time
 *   - retries and rate-limit handling
 *
 * This module only maps our configuration onto it. There is deliberately no
 * hand-rolled crypto and no hand-rolled HTTP here.
 *
 * Install scope: an app can be installed on a single repository, on an
 * organization (all repos, or selected), or on a user account. Each install is
 * a separate installation with its own id and its own token - which is why one
 * app can serve many teams.
 */
import { App } from "octokit";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PictoAppOptions {
  appId?: string;
  privateKey?: string;
  webhookSecret?: string;
  /** Optional: pin to one installation. Otherwise resolved per event. */
  installationId?: string;
}

/**
 * Read the app private key. In order of preference:
 *
 *   GITHUB_APP_PRIVATE_KEY_B64    base64 of the raw PEM   <- use this in deploy
 *   GITHUB_APP_PRIVATE_KEY        raw PEM with \n escapes
 *   GITHUB_PEM_PATH               a file path, for local development
 *   newest .pem in Downloads      last resort so local setup just works
 */
export function readPrivateKey(): string {
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");

  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (raw) return raw.replace(/\\n/g, "\n");

  const p = process.env.GITHUB_PEM_PATH;
  if (p && existsSync(p)) return readFileSync(p, "utf8");

  const downloaded = newestDownloadedKey();
  if (downloaded) return downloaded;

  throw new Error(
    "No GitHub App private key. Set GITHUB_APP_PRIVATE_KEY_B64 (preferred), " +
      "GITHUB_APP_PRIVATE_KEY, or GITHUB_PEM_PATH. Generate one at " +
      "https://github.com/settings/apps -> your app -> Private keys.",
  );
}

/** The most recently downloaded app key, if one is lying around. */
function newestDownloadedKey(): string | null {
  const dir = join(homedir(), "Downloads");
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => /\.pem$/i.test(f))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    try {
      const body = readFileSync(c.path, "utf8");
      if (body.includes("PRIVATE KEY")) {
        console.error(`[github-app] using key ${c.path}`);
        return body;
      }
    } catch {
      /* unreadable, skip */
    }
  }
  return null;
}

export interface InstallationSummary {
  id: number;
  account: string;
  targetType: string;
  repositorySelection: string;
}

export class PictoApp {
  /** The Octokit app instance. App-level calls go through `.octokit`. */
  readonly app: App;

  constructor(options: PictoAppOptions = {}) {
    const appId = options.appId ?? process.env.GITHUB_APP_ID ?? "";
    if (!appId) throw new Error("Missing GITHUB_APP_ID.");

    this.app = new App({
      appId,
      privateKey: options.privateKey ?? readPrivateKey(),
      webhooks: { secret: options.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? "" },
    });
  }

  /**
   * Verify a webhook actually came from GitHub.
   *
   * Throws unless the signature matches. `rawBody` must be the untouched request
   * body - re-serialising JSON changes the bytes and the check fails.
   *
   * Octokit's `verify` ANSWERS the question rather than enforcing it: it
   * resolves to `true` or `false` and never throws. Handing that value straight
   * back is a trap, because a caller that only guards with try/catch - the
   * obvious way to read a function documented as "throws" - accepts every forged
   * payload. So the answer is turned into an exception here, once, for all
   * callers.
   */
  async verifyWebhook(rawBody: string, signature: string | undefined): Promise<void> {
    if (!signature) throw new Error("missing X-Hub-Signature-256 header");
    const valid = await this.app.webhooks.verify(rawBody, signature);
    if (valid !== true) {
      throw new Error("signature does not match - this request did not come from GitHub");
    }
  }

  /**
   * A GitHub client acting as one installation.
   *
   * This is the call that turns "we are the app" into "we may write to this
   * repository". Octokit mints the installation token and reuses it until it
   * nears expiry.
   */
  forInstallation(installationId: string | number) {
    return this.app.getInstallationOctokit(Number(installationId));
  }

  /** Every place this app is installed. */
  async installations(): Promise<InstallationSummary[]> {
    const rows = await this.app.octokit.rest.apps.listInstallations();
    return rows.data.map((r) => ({
      id: r.id,
      account: r.account?.login ?? "unknown",
      targetType: r.target_type ?? "User",
      repositorySelection: r.repository_selection ?? "all",
    }));
  }

  /**
   * The installation that covers a repository.
   *
   * Prefers an explicit id, then a cached map, then matches on owner so a
   * webhook for any repository lands on the right grant.
   */
  async installationFor(repo: string, explicitId?: string): Promise<number> {
    if (explicitId) return Number(explicitId);
    const owner = (repo.split("/")[0] ?? "").toLowerCase();
    const all = await this.installations();
    const match = all.find((i) => i.account.toLowerCase() === owner) ?? all[0];
    if (!match) {
      throw new Error(
        `The app is not installed anywhere. Install it at https://github.com/apps/<slug>/installations/new`,
      );
    }
    return match.id;
  }

  /** Repositories the given installation can reach. */
  async repositories(installationId: string | number): Promise<string[]> {
    const octokit = await this.forInstallation(installationId);
    const res = await octokit.rest.apps.listReposAccessibleToInstallation();
    return res.data.repositories.map((r) => r.full_name);
  }

  /**
   * A raw installation token, for things that are not HTTP calls - `git clone`
   * and `git push` in particular.
   *
   * Octokit caches and refreshes this, so calling it per run is cheap and never
   * hands out an expired one.
   */
  async tokenFor(installationId: string | number): Promise<string> {
    const octokit = await this.forInstallation(installationId);
    const auth = (await octokit.auth({ type: "installation" })) as { token?: string };
    if (!auth?.token) throw new Error(`No installation token for installation ${installationId}.`);
    return auth.token;
  }
}
