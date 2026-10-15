/**
 * Locate the GitHub App private key that was downloaded from the app settings
 * page, and read the installation id out of the local git remotes.
 */
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const DOWNLOADS = join(homedir(), "Downloads");
const DESKTOP = join(homedir(), "Desktop");
const TEMP = join(tmpdir(), "Temp");
const CWD = process.cwd();

function findKeys(): string[] {
  const out: string[] = [];
  for (const dir of [DOWNLOADS, DESKTOP, TEMP, CWD]) {
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!/\.pem$/i.test(f)) continue;
      const p = join(dir, f);
      try {
        const body = readFileSync(p, "utf8");
        if (body.includes("PRIVATE KEY")) out.push(p);
      } catch {
        /* unreadable, skip */
      }
    }
  }
  return out;
}

function keyInfo(p: string): { file: string; appId: string | null } {
  const body = readFileSync(p, "utf8");
  // GitHub puts the app id in the key's first comment: "u!***APPID***..."
  const m = body.match(/APPID\*?\*\*?(\d+)/i) ?? body.match(/u!\*\*(\d+)/i);
  return { file: p, appId: m?.[1] ?? null };
}

console.log("=== private keys found ===");
const keys = findKeys();
if (keys.length === 0) {
  console.log("(none) — look for picto-bot.*.pem in Downloads");
} else {
  for (const k of keys) {
    const info = keyInfo(k);
    console.log(`  ${info.file}`);
    console.log(`     appId from key: ${info.appId ?? "(not found)"}`);
    console.log(`     bytes: ${statSync(info.file).size}`);
  }
}

console.log("\n=== installation id (from git remotes) ===");
const remotes = join(CWD, "sandbox", "repo", ".git", "config");
if (existsSync(remotes)) {
  for (const line of readFileSync(remotes, "utf8").split("\n")) {
    if (line.includes("url")) console.log("  " + line.trim());
  }
} else {
  console.log("  (no sandbox repo yet — run: npm run seed)");
}
