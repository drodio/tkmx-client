import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

import { collectCursorStats } from "../reporter/cursor";

describe("collectCursorStats", () => {
  let tmpDir;
  let dbPath;
  let origHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-cursor-"));
    const cursorDir = path.join(tmpDir, ".cursor", "ai-tracking");
    fs.mkdirSync(cursorDir, { recursive: true });
    dbPath = path.join(cursorDir, "ai-code-tracking.db");

    const db = new Database(dbPath);
    db.exec(`
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
    `);

    // Insert test data — recent commits
    db.prepare(`INSERT INTO scored_commits
      (commitHash, branchName, scoredAt, linesAdded, linesDeleted,
       tabLinesAdded, tabLinesDeleted, composerLinesAdded, composerLinesDeleted,
       humanLinesAdded, humanLinesDeleted, blankLinesAdded, blankLinesDeleted,
       commitMessage, commitDate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("abc123", "main", Date.now(), 100, 20, 40, 5, 30, 5, 30, 10, 0, 0, "test commit", "2026-04-10");

    db.prepare(`INSERT INTO conversation_summaries
      (conversationId, model, mode, updatedAt)
      VALUES (?, ?, ?, ?)
    `).run("conv1", "claude-3-5-sonnet", "composer", Date.now());

    db.close();

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
//
// The fix reads scoredAt: an INTEGER epoch-ms column that already carries an
// index, and is never NULL (NOT NULL in the schema). It is a true numeric
// comparison, so the window is real.
describe("collectCursorStats window filtering (real-world commitDate formats)", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  const CTIME = "Sat May 2 13:46:46 2026 -0700"; // git's default format
  const MAY_2_2026 = new Date(2026, 4, 2).getTime();

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-cursor-window-"));
    const cursorDir = path.join(tmpDir, ".cursor", "ai-tracking");
    fs.mkdirSync(cursorDir, { recursive: true });
    const db = new Database(path.join(cursorDir, "ai-code-tracking.db"));
    db.exec(`
      CREATE TABLE scored_commits (
        commitHash TEXT NOT NULL, branchName TEXT NOT NULL, scoredAt INTEGER NOT NULL,
        linesAdded INTEGER, linesDeleted INTEGER, tabLinesAdded INTEGER,
        tabLinesDeleted INTEGER, composerLinesAdded INTEGER, composerLinesDeleted INTEGER,
        humanLinesAdded INTEGER, humanLinesDeleted INTEGER, blankLinesAdded INTEGER,
        blankLinesDeleted INTEGER, commitMessage TEXT, commitDate TEXT,
        v1AiPercentage TEXT, v2AiPercentage TEXT,
        PRIMARY KEY (commitHash, branchName)
      );
      CREATE TABLE conversation_summaries (
        conversationId TEXT PRIMARY KEY, title TEXT, tldr TEXT, overview TEXT,
        summaryBullets TEXT, model TEXT, mode TEXT, updatedAt INTEGER NOT NULL
      );
    `);
    const ins = db.prepare(`INSERT INTO scored_commits
      (commitHash, branchName, scoredAt, linesAdded, linesDeleted,
       tabLinesAdded, tabLinesDeleted, composerLinesAdded, composerLinesDeleted,
       humanLinesAdded, humanLinesDeleted, blankLinesAdded, blankLinesDeleted,
       commitMessage, commitDate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Scored on 2026-05-02, in git ctime format — the shape real Cursor writes.
    ins.run("ct1", "main", MAY_2_2026, 10, 0, 10, 0, 0, 0, 0, 0, 0, 0, "m", CTIME);
    // Same vintage but with a NULL commitDate, which real DBs also contain.
    ins.run("ct2", "main", MAY_2_2026, 10, 0, 10, 0, 0, 0, 0, 0, 0, 0, "m", null);
    db.close();

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
    // make the two tests above pass.
    const result = collectCursorStats("20260401");
    assert.equal(result?.scored_commits, 2);
    assert.equal(result?.tab_lines_added, 20);
  });
});
