import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errMessage } from "./errors";
import type { DailyUsage, ModelBreakdown } from "./usage";

// Raw breakdown shape from `agentsview usage daily --json`. Token counters
// may be omitted (agentsview elides zeros) and totalTokens is always
// computed downstream — this is the wire shape, not the internal one.
// Kept private to this module: only parseAgentsviewOutput sees it.
interface RawModelBreakdown {
  modelName: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cost?: number;
  source?: string;
}

// Raw shape we accept from `agentsview usage daily --json`. Tolerant on
// purpose — agentsview occasionally omits the modelBreakdowns array on
// empty days.
interface RawDailyEntry {
  date: string;
  modelBreakdowns?: RawModelBreakdown[];
}

// Resolve agentsview binary — launchd/systemd don't inherit user shell PATH,
// so we can't rely on execvp's default search. Resolution order:
//   1. $AGENTSVIEW_BIN (explicit override for nix, asdf, custom installs)
//   2. Hard-coded install-location candidates (matches the quickstart)
//   3. $PATH (covers interactive runs)
// agentsview ships a native binary: `agentsview.exe` on Windows (its installer
// drops it in %USERPROFILE%\.agentsview\bin and adds that dir to PATH), bare
// `agentsview` elsewhere. We deliberately don't probe `.cmd`/`.bat` shims — the
// installer never writes one, and execFileSync can't run a command shim on
// Windows without a shell, so resolving to one would only hand the caller a
// path it can't exec. Parameterized over { platform, env, isExecutable } (with
// target-platform path semantics) so the Windows branch is testable on any host.
interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (p: string) => boolean;
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agentsview.exe" : "agentsview";
}

function agentsviewCandidates(deps: ResolveDeps): string[] {
  const p = pathFor(deps.platform);
  const name = binaryName(deps.platform);
  const candidates: string[] = [];
  for (const home of uniqueDefined([deps.env.HOME, deps.env.USERPROFILE])) {
    candidates.push(p.join(home, ".local", "bin", name));
    candidates.push(p.join(home, ".agentsview", "bin", name));
  }
  candidates.push("/opt/homebrew/bin/agentsview", "/usr/local/bin/agentsview");
  return uniqueDefined(candidates);
}

function resolveFromPath(deps: ResolveDeps): string | null {
  const p = pathFor(deps.platform);
  const name = binaryName(deps.platform);
  // process.env is case-insensitive on Windows, so PATH already resolves a
  // `Path`/`path`-cased var (production passes process.env; tests inject PATH).
  const pathValue = deps.env.PATH || "";
  for (const dir of pathValue.split(p.delimiter)) {
    if (!dir) continue;
    const candidate = p.join(dir, name);
    if (deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveAgentsviewWith(deps: ResolveDeps): string | null {
  const override = deps.env.AGENTSVIEW_BIN;
  if (override && deps.isExecutable(override)) return override;
  for (const candidate of agentsviewCandidates(deps)) {
    if (deps.isExecutable(candidate)) return candidate;
  }
  return resolveFromPath(deps);
}

export function resolveAgentsview(): string | null {
  return resolveAgentsviewWith({
    platform: process.platform,
    env: process.env,
    isExecutable: isExecutableFile,
  });
}

// Parses `agentsview --version` raw output like
//   "agentsview v0.23.0-2-g1b484fb (commit 1b484fb, built 2026-04-19T00:00:00Z)"
// into the bare git-describe core ("0.23.0" / "0.23.0-2-g1b484fb"). The
// server's MIN-version gate compares the leading X.Y.Z, so the wrapper
// prefix and "(commit …, built …)" tail are dropped to keep the wire
// value compact and directly displayable. Returns null if the binary is
// missing or `--version` fails.
export function detectAgentsviewVersion(bin: string | null, timeoutMs: number = 5000): string | null {
  if (!bin) return null;
  let raw: string;
  try {
    raw = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    console.error(`  agentsview --version failed: ${errMessage(err)}`);
    return null;
  }
  const m = raw.match(/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

export function toIsoDate(sinceStr: string): string {
  return `${sinceStr.slice(0, 4)}-${sinceStr.slice(4, 6)}-${sinceStr.slice(6, 8)}`;
}

interface AgentsviewJson {
  daily?: RawDailyEntry[];
}

// Convert `agentsview usage daily --json` output into the normalized
// internal shape. Defaults missing per-token-type counters to 0 and
// computes totalTokens once, so downstream code (merge.ts / report.ts)
// can rely on every counter being a finite number.
export function parseAgentsviewOutput(parsed: AgentsviewJson, source: string): DailyUsage[] {
  const daily = parsed.daily || [];
  return daily.map((day) => {
    const modelBreakdowns: ModelBreakdown[] = (day.modelBreakdowns || []).map((m) => {
      const inputTokens = m.inputTokens || 0;
      const outputTokens = m.outputTokens || 0;
      const cacheCreationTokens = m.cacheCreationTokens || 0;
      const cacheReadTokens = m.cacheReadTokens || 0;
      return {
        modelName: m.modelName,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
        cost: m.cost,
        source,
      };
    });
    return { date: day.date, modelBreakdowns };
  });
}

// agentsview's syncing pass runs its full parser registry, including a Warp
// parser that reads Warp's sqlite from a macOS App Group Container
// (~/Library/Group Containers/2BBY89MBSN.dev.warp/.../warp.sqlite). An
// unattended launchd/systemd daemon has no Full Disk Access, so that open()
// *blocks* (rather than failing fast) until the timeout, killing the run
// before it can POST. We only report Claude+Codex, so the syncing path points
// WARP_DIR at an always-empty dir: the parser finds no warp.sqlite there and
// skips Warp. Read (`--no-sync`) passes don't run the parser, so they're
// untouched. Living on the call env (not the OS-unit env) means existing
// installs get the fix on a plain `npm install` rebuild, with no daemon-unit
// regeneration. The only syncing call is now syncAgentsview() below; the
// guard in queryAgent stays as defense in case a caller ever syncs there.
const WARP_SKIP_DIR = "/var/empty";

function queryAgent(
  bin: string,
  since: string,
  agent: string,
  noSync: boolean,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): DailyUsage[] {
  const args = ["usage", "daily", "--json", "--breakdown", "--agent", agent, "--since", since];
  if (noSync) args.push("--no-sync");
  const execOpts: Parameters<typeof execFileSync>[2] = { encoding: "utf-8", timeout: timeoutMs };
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!noSync) env.WARP_DIR = WARP_SKIP_DIR;
  execOpts.env = env;
  let raw: string;
  try {
    raw = execFileSync(bin, args, execOpts) as string;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    const detail = stderr ? `: ${stderr}` : `: ${errMessage(err)}`;
    throw new Error(`agentsview ${agent} query failed${detail}`);
  }
  return parseAgentsviewOutput(JSON.parse(raw), agent);
}

// Refresh agentsview's local index as a standalone, time-boxed, best-effort
// step — kept deliberately separate from the read queries below.
//
// Why not fold sync into the query (the old behavior)? agentsview's data
// sync — any write path, including a bare `agentsview sync` — DEADLOCKS when
// the reporter runs under macOS launchd: the writer hangs forever inside
// sqlite3_open_v2 (0% CPU, all goroutines parked) while read-only queries
// (`--no-sync`) are completely unaffected. It is intrinsic to launchd's
// spawn context, not the environment: it reproduces across agentsview
// versions and survives ProcessType=Interactive, login-shell wrappers, a
// fully-replicated launchd env, raised rlimits, and GOMAXPROCS=1. A query
// that triggers sync therefore hangs until its timeout SIGKILLs it, the
// transaction rolls back, and the report fails outright — every 2h, forever
// (the symptom that motivated this change).
//
// So we ALWAYS read with --no-sync (deadlock-free) and run sync on its own:
//   - Interactive runs, Linux/systemd, and Macs that don't hit the deadlock
//     sync successfully → fully fresh data.
//   - Macs where launchd sync deadlocks: the timeout reaps the hung sync and
//     we report the last successfully-synced snapshot instead of nothing.
// The report can no longer hang or silently fail on the sync. A shorter
// default timeout bounds the wasted wall-clock when sync does deadlock; an
// incremental sync is near-instant and a cold full sync is rare. WARP_DIR is
// pointed at an empty dir here (see WARP_SKIP_DIR) because this is the syncing
// path that would otherwise block on Warp's Full-Disk-Access-gated sqlite.
export function syncAgentsview(
  bin: string,
  timeoutMs: number = 90000,
  extraEnv?: Record<string, string>,
): boolean {
  const execOpts: Parameters<typeof execFileSync>[2] = {
    encoding: "utf-8",
    timeout: timeoutMs,
    // Force-kill on timeout. The launchd deadlock parks every goroutine, so
    // the default SIGTERM would reap it too — but SIGKILL can't be caught or
    // ignored, so a future hang that installs a slow/blocking SIGTERM handler
    // still gets reaped within the timeout rather than wedging the report.
    killSignal: "SIGKILL",
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...extraEnv, WARP_DIR: WARP_SKIP_DIR },
  };
  try {
    execFileSync(bin, ["sync"], execOpts);
    return true;
  } catch (err) {
    console.error(`  agentsview sync skipped (${errMessage(err)}); reading last-synced data`);
    return false;
  }
}

export function collectAgentsviewUsage(bin: string, sinceStr: string, timeoutMs: number = 180000): { claudeDaily: DailyUsage[]; codexDaily: DailyUsage[] } {
  const since = toIsoDate(sinceStr);

  // One sync pass covers every agent: agentsview's syncAllLocked
  // (internal/sync/engine.go) iterates parser.Registry in a single pass, so a
  // standalone `agentsview sync` picks up claude, codex, gemini, copilot, etc.
  // Both reads below then run with --no-sync (noSync=true) so neither can hit
  // the launchd sync deadlock.
  syncAgentsview(bin);
  const claudeDaily = queryAgent(bin, since, "claude", true, timeoutMs);
  const codexDaily = queryAgent(bin, since, "codex", true, timeoutMs);

  return { claudeDaily, codexDaily };
}

// Single-agent collection against an isolated agentsview data dir. Used for
// EXTRA_{CLAUDE,CODEX}_CONFIGS extra homes — a synced remote ~/.claude or a
// separate ~/.codex (e.g. a reviewer bot's per-account home) that lives outside
// the local scan — so per-home incremental sync can't contaminate the local
// machine's ~/.agentsview/sessions.db. The caller passes the home's data dir
// and source dir via env (AGENT_VIEWER_DATA_DIR + CLAUDE_PROJECTS_DIR / CODEX_SESSIONS_DIR).
// The isolated dir starts empty, so the best-effort sync matters more here —
// but under a launchd deadlock we still degrade to "no rows for this home"
// rather than failing the whole report (the prior behavior). The read runs
// --no-sync to stay deadlock-free, same as the local path above.
export function collectAgentsviewAgentOnly(bin: string, sinceStr: string, agent: string, env: Record<string, string>, timeoutMs: number = 180000): DailyUsage[] {
  const since = toIsoDate(sinceStr);
  syncAgentsview(bin, 90000, env);
  return queryAgent(bin, since, agent, true, timeoutMs, env);
}
