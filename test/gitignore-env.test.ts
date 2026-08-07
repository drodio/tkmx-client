// .env holds USERNAME and API_KEY. So does every copy of it — the backup you
// make before editing, a per-machine .env.local, whatever `cp .env .env.old`
// leaves behind. .gitignore listed only the exact name `.env`, so those copies
// were untracked but *committable*: one `git add .` away from a public repo.
//
// These assert the two halves that have to hold together — every .env variant
// is ignored, and the one .env file that is meant to be tracked still is.
// Getting only the first half right (a bare `.env.*`) would silently drop
// .env.example from the repo, which is the file new users are told to copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// After build this file lives in dist/test/, so the repo root is two levels up.
const REPO = path.join(__dirname, "..", "..");

// `git check-ignore -q <path>` exits 0 when the path is ignored, 1 when it is
// not. Ask git rather than re-implementing gitignore matching, and use --no-index
// so the answer is about the rules, not about what happens to be on disk.
function isIgnored(relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--no-index", "-q", relPath], { cwd: REPO });
    return true;
  } catch (err) {
    const code = (err as { status?: number }).status;
    if (code === 1) return false;
    throw err;
  }
}

test("every .env variant that could hold credentials is ignored", () => {
  for (const name of [
    ".env",
    ".env.bak",
    ".env.bak-20260724",
    ".env.backup",
    ".env.local",
    ".env.old",
    ".env.save",
    ".env.production",
  ]) {
    assert.ok(
      isIgnored(name),
      `${name} can hold USERNAME/API_KEY and must be ignored, or it is one 'git add .' from being published`,
    );
  }
});

test(".env.example stays tracked", () => {
  // The negation has to survive any future widening of the pattern above —
  // .env.example is the template the README tells new users to copy, and it
  // carries no secrets.
  assert.equal(
    isIgnored(".env.example"),
    false,
    ".env.example must remain tracked; it is the template new installs copy from",
  );
});
