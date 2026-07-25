# Reporter query timeout — agentsview reads under contention

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
