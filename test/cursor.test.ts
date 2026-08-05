import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import { collectCursorStats } from "../reporter/cursor";

// Mirrors the real ~/.cursor/ai-tracking/ai-code-tracking.db schema. Kept in
// one place so a schema change lands once rather than per suite.
const SCHEMA = `
  CREATE TABLE scored_commits (
    commitHash TEXT NOT NULL,
    branchName TEXT NOT NULL,
    scoredAt INTEGER NOT NULL,
    linesAdded INTEGER,
    linesDeleted INTEGER,
    tabLinesAdded INTEGER,
    tabLinesDeleted INTEGER,
    composerLinesAdded INTEGER,
    composerLinesDeleted INTEGER,
    humanLinesAdded INTEGER,
    humanLinesDeleted INTEGER,
    blankLinesAdded INTEGER,
    blankLinesDeleted INTEGER,
    commitMessage TEXT,
    commitDate TEXT,
    v1AiPercentage TEXT,
    v2AiPercentage TEXT,
    PRIMARY KEY (commitHash, branchName)
  );
  CREATE TABLE conversation_summaries (
    conversationId TEXT PRIMARY KEY,
    title TEXT,
    tldr TEXT,
    overview TEXT,
    summaryBullets TEXT,
    model TEXT,
    mode TEXT,
    updatedAt INTEGER NOT NULL
  );
`;

interface CommitRow {
  hash: string;
  branch?: string;
  scoredAt: number;
  tabAdded?: number;
  tabDeleted?: number;
  composerAdded?: number;
  composerDeleted?: number;
  humanAdded?: number;
  humanDeleted?: number;
  message?: string;
  commitDate?: string | null;
}

interface ConvRow {
  id: string;
  model: string;
  mode: string;
  updatedAt: number;
}

// Builds a throwaway HOME containing a Cursor DB seeded with `commits` and
// `conversations`, and returns its path. Caller is responsible for restoring
// process.env.HOME and removing the directory.
function makeCursorHome(commits: CommitRow[], conversations: ConvRow[] = []): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-cursor-"));
  const cursorDir = path.join(tmpDir, ".cursor", "ai-tracking");
  fs.mkdirSync(cursorDir, { recursive: true });

  const db = new Database(path.join(cursorDir, "ai-code-tracking.db"));
  db.exec(SCHEMA);

  const insCommit = db.prepare(`INSERT INTO scored_commits
    (commitHash, branchName, scoredAt, linesAdded, linesDeleted,
     tabLinesAdded, tabLinesDeleted, composerLinesAdded, composerLinesDeleted,
     humanLinesAdded, humanLinesDeleted, blankLinesAdded, blankLinesDeleted,
     commitMessage, commitDate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of commits) {
    const tabAdded = c.tabAdded ?? 0;
    const composerAdded = c.composerAdded ?? 0;
    const humanAdded = c.humanAdded ?? 0;
    insCommit.run(
      c.hash, c.branch ?? "main", c.scoredAt,
      tabAdded + composerAdded + humanAdded, 0,
      tabAdded, c.tabDeleted ?? 0,
      composerAdded, c.composerDeleted ?? 0,
      humanAdded, c.humanDeleted ?? 0,
      0, 0,
      c.message ?? "m", c.commitDate === undefined ? null : c.commitDate,
    );
  }

  const insConv = db.prepare(`INSERT INTO conversation_summaries
    (conversationId, model, mode, updatedAt) VALUES (?, ?, ?, ?)`);
  for (const c of conversations) insConv.run(c.id, c.model, c.mode, c.updatedAt);

  db.close();
  return tmpDir;
}

describe("collectCursorStats", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  before(() => {
    tmpDir = makeCursorHome(
      [{
        hash: "abc123", scoredAt: Date.now(),
        tabAdded: 40, tabDeleted: 5,
        composerAdded: 30, composerDeleted: 5,
        humanAdded: 30, humanDeleted: 10,
        message: "test commit", commitDate: "2026-04-10",
      }],
      [{ id: "conv1", model: "claude-3-5-sonnet", mode: "composer", updatedAt: Date.now() }],
    );
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns scored commit stats with AI attribution", () => {
    const result = collectCursorStats("20260101");
    assert.ok(result);
    assert.equal(result.scored_commits, 1);
    assert.equal(result.tab_lines_added, 40);
    assert.equal(result.composer_lines_added, 30);
    assert.equal(result.human_lines_added, 30);
    assert.equal(result.ai_authored_pct, 70); // (40+30)/(40+30+30) = 70%
  });

  it("returns conversation model/mode breakdown", () => {
    const result = collectCursorStats("20260101");
    assert.ok(result.conversations);
    assert.equal(result.conversations["claude-3-5-sonnet/composer"], 1);
  });

  it("returns an empty object (not null) when the DB is present but the window has no activity", () => {
    // Use a future date so nothing matches. Returning {} rather than null
    // is load-bearing: report.js's `if (cursorStats)` is truthy on {} and
    // therefore still sends cursor_stats in the POST, which lets the
    // server's wholesale-replace overwrite the prior (now-stale) blob.
    // If this returned null, the body would omit cursor_stats entirely
    // and old Cursor data would linger on the profile forever.
    const result = collectCursorStats("20270101");
    assert.deepEqual(result, {});
  });

  it("never includes commit messages or branch names", () => {
    const result = collectCursorStats("20260101");
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("test commit"));
    assert.ok(!serialized.includes("main"));
    assert.ok(!serialized.includes("abc123"));
  });
});

// Regression: the window filter used to compare the commitDate TEXT column
// against an ISO "YYYY-MM-DD" string. Real Cursor writes commitDate in git's
// default ctime format ("Sat May 2 13:46:46 2026 -0700"), so the comparison
// was lexical between a weekday letter and a digit — and in ASCII every
// letter outranks every digit, making `commitDate >= <any ISO date>` TRUE for
// every non-NULL row. The window could never exclude anything: on a real DB,
// `commitDate >= '2099-12-31'` still matched 703 of 1099 rows (the other 396
// having NULL commitDate, which drops out because NULL >= 'x' is NULL).
//
// The effect was a profile permanently reporting lifetime Cursor totals as if
// they were current-window activity — the exact staleness the empty-object
// contract above exists to prevent, arriving by a different route.
describe("collectCursorStats window filtering (real-world commitDate formats)", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  const CTIME = "Sat May 2 13:46:46 2026 -0700"; // git's default format
  const MAY_2_2026 = new Date(2026, 4, 2).getTime();

  before(() => {
    tmpDir = makeCursorHome([
      // Scored 2026-05-02, commitDate in git ctime format — what real Cursor writes.
      { hash: "ct1", scoredAt: MAY_2_2026, tabAdded: 10, commitDate: CTIME },
      // Same vintage but NULL commitDate, which real DBs also contain in quantity.
      { hash: "ct2", scoredAt: MAY_2_2026, tabAdded: 10, commitDate: null },
    ]);
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes ctime-formatted commits that fall before the window", () => {
    // Window opens 2026-06-01; both rows were scored 2026-05-02, so the
    // correct answer is "no activity" -> {}. Against the old commitDate
    // comparison the ctime row always matched and this returned 1.
    assert.deepEqual(collectCursorStats("20260601"), {});
  });

  it("excludes ctime-formatted commits even for an absurdly future window", () => {
    // The sharpest form of the bug: a filter for commits after 2099 used to
    // match. If this ever returns a count again, the window is a no-op.
    assert.deepEqual(collectCursorStats("20991231"), {});
  });

  it("still includes commits that genuinely fall inside the window", () => {
    // Guards the opposite failure: a fix that excludes everything would also
    // make the two tests above pass. This also pins that the NULL-commitDate
    // row is counted — the old comparison silently dropped it.
    const result = collectCursorStats("20260401");
    assert.equal(result?.scored_commits, 2);
    assert.equal(result?.tab_lines_added, 20);
  });
});

// The fix rests on scoredAt being epoch MILLISECONDS, and a units mismatch
// would be silent in exactly the same way the original bug was: if Cursor ever
// wrote seconds, `scoredAt >= sinceMs` would compare ~1.7e9 against ~1.8e12,
// match nothing for any window forever, and the reporter would simply log
// "Cursor: 0 scored commits" with no error.
//
// Verified against a real DB at the time of the fix: MIN(scoredAt)=1766014757322,
// MAX(scoredAt)=1777820363850 — both ~1.7e12, i.e. milliseconds. (Read as
// seconds, MAX would land in the year 58332.) These tests pin the assumption so
// a future schema change is caught here rather than by a silently empty profile.
describe("collectCursorStats scoredAt units", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  const JUN_1_2026_MS = new Date(2026, 5, 1).getTime();

  before(() => {
    tmpDir = makeCursorHome([
      // Correct units: epoch ms.
      { hash: "ms1", scoredAt: JUN_1_2026_MS, tabAdded: 7 },
      // Same instant expressed in SECONDS — the shape a units regression takes.
      { hash: "sec1", scoredAt: Math.floor(JUN_1_2026_MS / 1000), tabAdded: 7 },
    ]);
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("treats scoredAt as epoch milliseconds", () => {
    // A window opening 2026-05-01 must see the ms row and must NOT see the
    // seconds row: read as ms, a seconds-scale value is 1970 and far outside
    // the window. Counting 2 here would mean the comparison is unit-agnostic
    // (i.e. broken); counting 0 would mean ms values are being missed.
    const result = collectCursorStats("20260501");
    assert.equal(result?.scored_commits, 1);
    assert.equal(result?.tab_lines_added, 7);
  });

  it("would report nothing if every row were seconds-scale", () => {
    // Documents the silent failure mode the reviewer flagged: with only
    // seconds-scale rows present, every window returns {} — indistinguishable
    // from "no Cursor activity". If Cursor ever switches units, this is the
    // test that explains the empty profile.
    const secondsOnly = makeCursorHome([
      { hash: "s1", scoredAt: Math.floor(JUN_1_2026_MS / 1000), tabAdded: 7 },
    ]);
    const prev = process.env.HOME;
    process.env.HOME = secondsOnly;
    try {
      assert.deepEqual(collectCursorStats("20260101"), {});
    } finally {
      process.env.HOME = prev;
      fs.rmSync(secondsOnly, { recursive: true, force: true });
    }
  });
});
