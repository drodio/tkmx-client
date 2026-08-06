# Reporter query timeout — agentsview reads under contention

## Progress Update as of 2026-08-05 15:45 PDT
*(Most recent updates at top)*

### Summary of changes since last update

Audited whether every agent/worktree on this machine reports. Worktrees are fine
(3,939 Sparkle worktree sessions indexed in the last 7d, newest today — they all
land in the main `~/.claude/projects`, which `Claude (local)` already collects).
Found and fixed a separate, long-standing bug: the **Cursor window filter was a
complete no-op**, so the profile has been reporting lifetime Cursor totals as if
they were current-window activity.

### Detail of changes made:

- `reporter/cursor.ts`: the scored-commits query filtered `WHERE commitDate >= ?`
  with an ISO `YYYY-MM-DD` string. `commitDate` is TEXT holding git's default
  ctime rendering (`"Sat May 2 13:46:46 2026 -0700"`), so this was a lexical
  compare of a weekday letter against a digit. Letters outrank digits in ASCII,
  making the predicate TRUE for every non-NULL row. Proof on the real DB:
  `commitDate >= '2099-12-31'` matched 703 rows. Switched to `scoredAt`, an
  INTEGER epoch-ms column that is `NOT NULL` and already indexed
  (`idx_scored_commits_scoredAt`).
- Second half of the same bug: rows with a NULL `commitDate` were silently
  dropped (`NULL >= 'x'` is NULL, not true). The real DB has 396 of them out of
  1,099 — which is exactly why the reported figure was the oddly specific 703.
  Filtering on `scoredAt` recovers them.
- `test/cursor.test.ts`: new `describe` block with a fixture using the REAL ctime
  format plus a NULL-commitDate row. The pre-existing fixture inserted
  `commitDate = "2026-04-10"` (ISO), which compares correctly — that is why the
  bug survived having tests. Three cases: excluded before-window, excluded for an
  absurd 2099 window (the sharpest form), and a positive case so a fix that
  excluded everything would not pass.

Verified on the real Cursor DB — the window now actually moves, where all three
of these previously returned 703:

| since | before | after |
|---|---|---|
| 28d (`20260708`) | 703 | `{}` |
| `20260101` | 703 | 1,088 |
| `20250101` | 703 | 1,099 |

Note the semantic shift: `scoredAt` is when Cursor scored the commit, not when it
was authored. That is the better signal for a usage reporter, and `commitDate` is
not reliably parseable in SQL given the mixed NULL/ctime contents.

Also audited, no change needed: Codex reporting (6 days, 1,052 files touched in
14d), OpenClaw (present but dormant — 0 files in 14d, nothing to report).

### .env backups were one `git add -A` from leaking a live API key

`.gitignore` covered `.env` but not its backups. Two sat untracked in the
worktree — `.env.bak-20260724` and `.env.bak-concierge-20260806-021701`, the
latter written by tooling, not by hand — and both carry `API_KEY` in plaintext.
Nothing had leaked (`.env.example` is the only tracked `.env*`, holding the
placeholder, and no 40+ hex key appears anywhere in history), but the exposure
was one careless `git add -A` away, and the filenames are generated with
timestamps so enumerating them is futile. Left the backup files themselves in
place — they are the user's data, not mine to delete.

roborev (job 59583) then caught that my first attempt — `.env.bak*`,
`.env.*.bak`, `.env.backup*` — was still a fixed list, just a wider one, missing
`.env~`, `.env.old`, `.env.save`, `.env.orig`. Since the writers live outside
this repo, the naming surface cannot be enumerated from in here, so a prefix
match is the only form that closes rather than chases. Collapsed to `.env*` plus
`!.env.example`: four ignore lines become two, and every sibling form is covered.
Verified all ten candidate names ignored while `.env.example` stays tracked.
Deliberately swallows `.envrc` as well — direnv configs commonly hold secrets, and
silently untracking one is far cheaper than committing it; anything that
genuinely belongs in git can be added with `git add -f`.

### roborev round on 572bfaa (job 59099) — two findings, both addressed

- **Medium — the cited verification was non-discriminating.** "The 28d window now
  returns `{}`" is also what a units mismatch produces: if `scoredAt` were epoch
  seconds, `scoredAt >= sinceMs` would compare ~1.7e9 against ~1.8e12 and match
  nothing for any window, forever, logging "Cursor: 0 scored commits" with no
  error — the mirror image of the bug being fixed, and equally silent.
  Ran the discriminating query: `MIN(scoredAt)=1766014757322`,
  `MAX(scoredAt)=1777820363850`, both ~1.7e12, i.e. **milliseconds**. Read as
  seconds, MAX would land in the year 58332. So the fix is correct as shipped.
  Note the differential already ruled this out — `20250101` returned 1,099 rows,
  which under a seconds interpretation would have been 0 — but that was never
  stated as a discriminating test, which was the fair part of the finding.
  Pinned it durably with a new `scoredAt units` suite instead of leaving it as an
  undocumented assumption.
- **Low — ~45 duplicated lines between the two suites.** Valid. Hoisted a single
  `makeCursorHome(commits, conversations)` helper plus one `SCHEMA` const; both
  suites now call it. Net-negative LOC and one copy of the DDL.
- Mutation-checked the new assertions rather than trusting a green run: patching
  the query to `Math.floor(sinceMs/1000)` (a units regression) fails 5 tests,
  including both new units tests. The tests can actually fail.

### Beads activity:
- None — `bd` resolves here but the workspace has 0 issues and is not this
  project's tracker.

### Potential concerns to address:

- **`EXTRA_CLAUDE_CONFIGS` is a literal path list with no globbing, and Sparkle
  mints a NEW account store per account switch.** `ef6ce18fe79bcf53` went stale
  after 2026-07-27 (reports "0 days") when the account switched to
  `602064ad688be368`, which was never added — so that store's usage is dropped.
  Verified no session-id overlap between the stores and `~/.claude`, so listing
  both is additive. The durable fix is auto-discovery of
  `.../ai.sparkle.desktop/accounts/*`, mirroring how `OPENCLAW_SESSIONS_DIRS`
  already defaults to discovering every Plow variant. Could not edit the live
  `.env` (worktree guard blocks writes outside the agent worktree); handed the
  user the one-line command.
- **The iMac reports nothing and is unreachable from here** (no SSH hosts, no
  Tailscale). Needs tkmx-client installed on that machine with its OWN
  `CLIENT_ID` — the server PK is `username+date+model+client_id+source`, so
  copying this Mac's `.env` wholesale would make the two machines overwrite each
  other's rows.

## Progress Update as of 2026-07-24 18:07 PDT
*(Most recent updates at top)*

### Summary of changes since last update

Investigated a user report that Builder Index usage looked under-counted. Tracking
turned out to be **correct** — published rows match the local agentsview index
exactly, day for day, across 30 days. The real defect is delivery: the reporter's
fixed 180s agentsview query budget is fatal when it expires, and on this machine's
1.2 GB index a read intermittently exceeds it, silently dropping a whole 2h cycle.
Replaced the fixed budget with a generous, env-tunable one.

**Rebased onto `main` (541cd6f) mid-flight.** The branch was cut from `e0ec106`,
three commits behind, and `main` had since merged the launchd-sync-deadlock fix
(PR #1) that introduces `syncAgentsview()`. Landing the branch un-rebased would
have regressed that fix. Conflicts in `reporter/agentsview.ts` and
`test/agentsview.test.ts` resolved by keeping main's sync/read separation intact
and applying only the timeout default on top. roborev caught this indirectly by
flagging that `syncAgentsview` "does not exist in the repo" — true of the stale
base, false of main.

### Detail of changes made:

- `reporter/agentsview.ts`: new `DEFAULT_QUERY_TIMEOUT_MS` (600_000) and
  `queryTimeoutMs(env)`, honouring `AGENTSVIEW_TIMEOUT_MS` and falling back to the
  default for non-numeric / zero / negative values. Both `collectAgentsviewUsage`
  and `collectAgentsviewAgentOnly` now default to it instead of a literal 180000.
- `reporter/session-stats.ts`: dropped its own `DEFAULT_TIMEOUT_MS` literal and
  reuses `queryTimeoutMs()` — it hits the same contended sqlite index and
  additionally does git integration.
- `.env.example`: documented `AGENTSVIEW_TIMEOUT_MS` with the failure signature to
  grep for (`query failed: ... ETIMEDOUT`).
- `test/agentsview.test.ts`: 5 new tests under `describe("queryTimeoutMs")`,
  including one that drives a real `execFileSync` against a sleeping fake binary
  with a 250ms budget, proving the env var reaches the actual exec rather than
  just the helper.

Evidence behind the 600s default (measured on this machine, 1.2 GB index,
18,924 sessions / 242,860 messages):

- 1-day read and 7-day read both ~15-16s idle → cost is NOT proportional to the
  query window, so shrinking `REPORT_DAYS` would not have helped.
- Same read spiked to **57s** while agents were actively writing the index, and a
  live launchd run died outright at `spawnSync ETIMEDOUT`.
- A pristine `.backup` copy of the same DB read in 14-24s — i.e. size alone does
  not explain the spike; **contention does**.
- `agentsview prune --before 2026-04-25` (90d) would reclaim only 556 sessions /
  115 MB of 1.2 GB, so pruning is not a fix for this. Not run.

Addressed all four roborev findings on the first revision of this commit:

- **Medium — `parseInt` truncation (real bug, mine).** `AGENTSVIEW_TIMEOUT_MS=10m`
  parsed as `10` ms, aborting every read: the exact failure the commit prevents,
  re-armed by a plausible typo. Now strict `/^\d+$/` with a loud stderr warning on
  rejection. Tests cover `10m`, `600s`, `1e6`, `60_000`, `10.5`, `" 10m "`.
- **Low — stale comment referencing a non-existent `syncAgentsview`.** Resolved by
  the rebase; the function exists on main and the comment's premise is now correct
  (sync is a separate best-effort exec, reads run `--no-sync`).
- **Low — timeout signature masked by stderr.** `queryAgent` preferred stderr over
  the error, so a slow agentsview that logged a warning before being reaped hid the
  ETIMEDOUT that `.env.example` tells operators to grep for. Now reports
  `timed out after Nms` alongside stderr whenever the kill was ours. Test drives a
  fake binary that writes to stderr and then hangs.
- **Low — 10-minute budget applied to a best-effort path.** Reverted session-stats
  to its own `STATS_TIMEOUT_MS` (180s): it returns null on failure and the report
  posts anyway, so a long stall there buys nothing and only delays the POST.

Second roborev round on the amended commit raised three more, all fixed:

- **Timeout detection keyed on SIGTERM.** SIGTERM is equally what an external
  killer sends (launchd teardown, an operator `kill`), so a run that died in
  seconds would report `timed out after 600000ms`. Now keyed on
  `code === "ETIMEDOUT"` alone, which Node sets whenever the timeout fired.
- **No upper bound on the parsed value.** A fat-fingered extra run of zeros passes
  `/^\d+$/` and silently disables the backstop; large enough and `spawnSync` throws
  `ERR_OUT_OF_RANGE`, making a config typo fatal. Added `Number.isSafeInteger` and
  a `MAX_QUERY_TIMEOUT_MS` ceiling of 1 hour.
- **Error message dropped the `ETIMEDOUT` token** that `.env.example` tells
  operators to grep for. Message is now `ETIMEDOUT after Nms; <stderr>`.
- Test stubs slept in the sync leg as well as the read, burning ~10s of suite
  wall-clock for no coverage. Stubs now `exit 0` on `sync`; those two tests went
  from ~5.9s each to ~0.7s.

Third roborev round (review 46893) raised four more — all judged VALID and fixed
in follow-up commit rather than another amend, per the roborev contract:

- **Read exec had no `killSignal`, unlike `syncAgentsview`.** `spawnSync` blocks
  until the child exits after the signal is sent, so a read that ignores SIGTERM
  made the 10-minute budget an unenforceable floor — the lost-cycle failure again,
  with a longer head start. Now `killSignal: "SIGKILL"` for parity.
- **Above-ceiling values fell back to the default instead of clamping.** Someone
  setting `7200000` after watching hour-long reads would silently get `600000` —
  *less* than they asked for. Now clamps to `MAX_QUERY_TIMEOUT_MS`; the default
  fallback is kept only for unparseable / zero / negative / unsafe-integer input.
- **Warning fired once per agentsview home.** Latched to warn-once per process
  (`warnOnce`), while keeping resolution lazy.
- **Test gaps.** Added: stderr capture proving the rejection is actually loud and
  names both the value and the ceiling; a warn-once assertion; a test pinning
  call-time (not import-time) resolution, which is what keeps dotenv working since
  `report.ts` loads `.env` after importing this module; and timeout coverage for
  `collectAgentsviewAgentOnly`, the extra-homes path whose failure is fatal.

Final: typecheck clean, 137 tests / 132 pass / 5 pre-existing failures (below).

Fourth roborev round (review on 5b3081a) — four more, all VALID, all fixed:

- **Reject message quoted a ceiling it no longer enforces.** Introduced by the
  clamp change in 5b3081a: above-ceiling values clamp, so only non-numeric / zero
  / negative / unsafe-integer input reaches that branch. Reworded; the test now
  asserts the ceiling is *absent* there and present in the clamp message.
- **Clamp path had no warning coverage** — the operationally surprising case
  (asked for 7200000, got 3600000) could go silent. Added, with a shared
  `captureStderr` helper that resets the warn-once latch before and after so
  warning state can't leak between cases.
- **Timeout tests asserted only the message, never elapsed time.** A regression to
  an unenforced budget throws the identical error and would have passed. Both now
  bound wall-clock against a `sleep 30` stub — and empirically the budget IS
  enforced: ~610ms and ~690ms against a 250ms budget, so the direct-child SIGKILL
  reaps in practice.
- **"resolves at call time" test didn't test its contract** — mechanically
  identical to two neighbours, and it called `queryTimeoutMs()` directly rather
  than exercising a caller's default parameter. Dropped; the wall-clock test now
  carries that contract, since it sets the env after import and the value must
  reach `collectAgentsviewUsage`'s default parameter to take effect.

Documented the real scope of the SIGKILL guarantee next to it: the budget bounds
the DIRECT child, since `spawnSync` pumps until the stdio pipes hit EOF and a
grandchild holding stdout/stderr could outlive the kill. agentsview is a single
static binary that spawns no helpers, so the bound is real here — the note is for
whoever points this code at something else.

### Beads activity:
- None — no `bd` database in this repo (`bd` not initialized here).

### Potential concerns to address:

- **5 pre-existing test failures on this machine, unrelated to this change.**
  Identical before and after (clean tree: 119 tests / 114 pass / 5 fail; with this
  change: 124 / 119 / 5). Root cause: `agentsviewCandidates()` hard-codes
  `/opt/homebrew/bin/agentsview` and `/usr/local/bin/agentsview`, which the
  `resolveAgentsview` tests' `HOME`+`PATH` isolation cannot defeat. On a machine
  with a real agentsview at `/usr/local/bin` (this one), those tests resolve the
  real binary and get real output where they assert null. They pass on hosts
  without a real install (CI). Fix would be to route those tests through the
  already-injectable `resolveAgentsviewWith`. Left alone as out of scope.
- **`better-sqlite3@11.10.0` does not compile on Node 26** (Homebrew default here);
  6 compile errors under node-gyp. This worktree builds under nvm Node v23.11.1,
  which is what the launchd plist pins. Worth an engines constraint.
- **A second, dormant tkmx-client checkout exists at `/Users/drodio/tkmx-client`** —
  old ccusage-era code, no `dist/`, no service, and a *different* `CLIENT_ID` from
  the live install at `/Users/drodio/Projects/tkmx-client`. Harmless while dormant,
  but running it would post under a second client identity.
- The `Chief.bot` team rows on the server come from a machine that is **not** this
  Mac (no `TEAM=Chief.bot` anywhere locally); they stop after 2026-07-23.
