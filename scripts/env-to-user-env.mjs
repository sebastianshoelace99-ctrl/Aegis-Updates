import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors `.env` into the current user's environment, so the file can be emptied (or deleted)
 * without losing the configuration `server/env.ts` needs.
 *
 * Why this exists: `.gitignore` is advisory - `git add -f` ignores it, and a file that is already
 * tracked stays tracked - so the pre-commit hook is the real guard. But a guard is still a guard;
 * the smallest exposure is a secret that is not in the working tree at all. `server/env.ts` gives
 * an existing process variable precedence over `.env` (`if (!key || key in process.env) continue`),
 * which is exactly what makes this swap safe.
 *
 * Deliberate limits:
 *  - `VITE_*` keys are skipped. Vite bakes those from the `.env` files at build time; a user
 *    environment variable would change nothing and would leave a stale copy of the API key lying
 *    around. They are not secrets the backend needs.
 *  - Values never appear in this process's output, and never on a command line: the value travels
 *    to PowerShell through the child's environment, not through argument quoting.
 *
 * Usage: `npm run env:to-user` (add `-- --dry-run` to list, `-- --remove` to revert).
 *
 * Trade-off worth knowing: a User-scope variable is inherited by every process this account
 * starts, which is a broader audience than one file. The point is to make the repository clean,
 * not to build a vault. A real secret manager is the next step up.
 */

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const remove = args.has("--remove");

const envPath = join(process.cwd(), ".env");

if (!existsSync(envPath)) {
  console.error(`env:to-user: ${envPath} does not exist. Nothing to copy.`);
  process.exit(1);
}

/** The same parse `loadDotEnv` uses, so the two can never disagree about a value. */
function parse(text) {
  const pairs = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    // An empty value is a deliberate "unset" everywhere else in this project; copying it would
    // create a variable that shadows nothing but looks configured.
    if (value.length === 0) continue;
    pairs.push([key, value]);
  }
  return pairs;
}

const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  "$name = $env:AEGIS_SECRET_NAME",
  "$value = $env:AEGIS_SECRET_VALUE",
  "[Environment]::SetEnvironmentVariable($name, $value, 'User')",
  // Report success without ever printing the value: a mismatch is a failure, not a warning.
  // `-cne` on two nulls is false, so the same check covers removal.
  "if ([Environment]::GetEnvironmentVariable($name, 'User') -cne $value) { exit 4 }",
].join("\n");

function apply(key, value) {
  if (process.platform !== "win32") {
    // POSIX has no equivalent "user environment" store; say so instead of pretending.
    console.error("env:to-user: only implemented for Windows user environment variables.");
    process.exit(1);
  }

  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL],
      {
        // The value is handed over out-of-band; it never touches the command line.
        env: { ...process.env, AEGIS_SECRET_NAME: key, AEGIS_SECRET_VALUE: value },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    console.error(`env:to-user: failed for ${key}. ${detail.trim().slice(0, 200)}`);
    return false;
  }
}

const pairs = parse(readFileSync(envPath, "utf8")).filter(([key]) => !key.startsWith("VITE_"));

if (pairs.length === 0) {
  console.log("env:to-user: nothing to copy (only VITE_ keys or empty values).");
  process.exit(0);
}

if (dryRun) {
  for (const [key] of pairs) console.log(`would ${remove ? "remove" : "set"} ${key}`);
  process.exit(0);
}

let failed = 0;
for (const [key, value] of pairs) {
  const ok = apply(key, remove ? null : value);
  if (ok) console.log(`${remove ? "removed" : "set"} ${key}`);
  else failed += 1;
}

if (failed > 0) {
  console.error(`env:to-user: ${failed} of ${pairs.length} variables could not be stored.`);
  process.exit(1);
}

console.log(
  remove
    ? "env:to-user: done. The .env values are now the only copy again."
    : "env:to-user: done. New terminals inherit these; .env may now be emptied once you confirm " +
        "the backend still boots. Existing terminals keep their old environment until restarted.",
);
