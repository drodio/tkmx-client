import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { errMessage } from "./errors";
import { detectAgentsviewVersion } from "./agentsview";

const DAY_MS = 24 * 60 * 60 * 1000;

// Auto-update is opt-OUT. Any of false/0/no/off (case-insensitive) disables
// it; anything else (including unset) leaves it on. We keep agentsview current
// so the reporter doesn't silently fall behind the server's MIN-version gate.
export function autoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AGENTSVIEW_AUTO_UPDATE ?? "").trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}

function readStamp(stampPath: string): number {
  try {
    const n = parseInt(fs.readFileSync(stampPath, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeStamp(stampPath: string, nowMs: number): void {
  try {
    fs.writeFileSync(stampPath, String(nowMs), "utf-8");
  } catch (err) {
    // A non-writable repo dir shouldn't fail the report; we just lose the
    // throttle and may re-check next run.
    console.error(`  agentsview auto-update: could not record check time (${errMessage(err)})`);
  }
}

export interface AutoUpdateOptions {
  nowMs: number;
  intervalMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// Best-effort, throttled (default once/day) agentsview self-update. Runs
// `agentsview update --yes`, which downloads and swaps the binary — a plain
// download+replace with no SQLite write, so unlike `agentsview sync` it does
// NOT hit the macOS launchd deadlock and is safe to run from the scheduled
// reporter. Never throws: an update failure must not fail the report.
//
// The check timestamp is written BEFORE the update runs, so a hang that the
// timeout reaps (or a crash) doesn't re-attempt every 2h — it waits a full
// interval before trying again.
//
// Returns true when an update was attempted this run (throttle elapsed and
// auto-update enabled), false when skipped.
export function maybeAutoUpdateAgentsview(
  bin: string,
  stampPath: string,
  opts: AutoUpdateOptions,
): boolean {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const env = opts.env ?? process.env;

  if (!autoUpdateEnabled(env)) return false;
  if (opts.nowMs - readStamp(stampPath) < intervalMs) return false;

  writeStamp(stampPath, opts.nowMs);

  const before = detectAgentsviewVersion(bin);
  try {
    execFileSync(bin, ["update", "--yes"], {
      encoding: "utf-8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    console.error(`  agentsview auto-update skipped (${errMessage(err)})`);
    return true;
  }
  const after = detectAgentsviewVersion(bin);
  if (after && before && after !== before) {
    console.log(`  agentsview auto-updated: ${before} -> ${after}`);
  } else {
    console.log(`  agentsview up to date (${after ?? "unknown"})`);
  }
  return true;
}
