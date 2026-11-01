import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Points this repository at `scripts/git-hooks` so the pre-commit guard runs.
 *
 * `.gitignore` is the first line of defence for `.env`, but it cannot stop `git add -f`, and it
 * does nothing once a file is already tracked. The hook checks the staged set instead, which is
 * why it needs installing per clone: hooks are not carried by the working tree unless the path is
 * configured, and `core.hooksPath` is local config.
 *
 * Run with `npm run hooks:install`. Safe to re-run; requires git on PATH.
 */

const HOOKS_PATH = "scripts/git-hooks";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

try {
  git(["--version"]);
} catch {
  console.error("hooks: git is not installed or not on PATH. Install git, then re-run.");
  process.exit(1);
}

try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  console.error("hooks: this directory is not a git repository yet. Run `git init` first.");
  process.exit(1);
}

if (!existsSync(join(HOOKS_PATH, "pre-commit"))) {
  console.error(`hooks: ${HOOKS_PATH}/pre-commit is missing.`);
  process.exit(1);
}

// Git for Windows runs hooks through its bundled sh, which ignores the executable bit, but other
// platforms require it. Failure here is not fatal: the hook still runs on Windows.
if (process.platform !== "win32") {
  try {
    chmodSync(join(HOOKS_PATH, "pre-commit"), 0o755);
  } catch {
    console.warn("hooks: could not mark pre-commit executable; check its mode manually.");
  }
}

git(["config", "core.hooksPath", HOOKS_PATH]);

console.log(`hooks: core.hooksPath = ${git(["config", "--get", "core.hooksPath"])}`);
console.log("hooks: .env commits are now blocked unless --no-verify is passed.");
