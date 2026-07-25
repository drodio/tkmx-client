import { execFileSync } from "node:child_process";
import { resolveAgentsview } from "./agentsview";
import { errMessage } from "./errors";
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

// Deliberately NOT the usage-read budget (DEFAULT_QUERY_TIMEOUT_MS, 10 min).
// The tradeoff inverts here: a usage read is fatal, so waiting it out beats
// losing the cycle — but session stats are best-effort (this returns null on
// any failure and the report still posts), so a long stall buys nothing and
// only delays the POST. 3 minutes keeps room for the git integration this
// command does while bounding how long a wedged binary can hold up the run.
const STATS_TIMEOUT_MS = 180_000;

export interface SessionStatsBlob {
  schema_version: number;
  totals?: { sessions_all?: number };
  [key: string]: unknown;
}

// collectSessionStats runs `agentsview stats --format json` and returns
// the parsed blob, or null on any error (missing binary, non-zero exit,
// non-JSON output). Errors are logged but never propagate — the reporter
// treats session stats as a best-effort addition and must keep working.
//
// GH_TOKEN / GITHUB_TOKEN are passed through the child env (execFileSync
// inherits process.env by default) rather than on argv, so the token
// doesn't show up in `ps` output.
export function collectSessionStats({ sinceDays = 28, timezone }: { sinceDays?: number; timezone?: string } = {}): SessionStatsBlob | null {
  const bin = resolveAgentsview();
  if (!bin) {
    console.error("[session-stats] agentsview binary not found; skipping");
    return null;
  }
  const args = ["stats", "--format", "json", "--since", `${sinceDays}d`];
  if (timezone) args.push("--timezone", timezone);

  const execOpts = {
    encoding: "utf-8" as const,
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: STATS_TIMEOUT_MS,
  };

  let raw: string;
  try {
    raw = execFileSync(bin, args, execOpts);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    const detail = stderr ? `: ${stderr}` : `: ${errMessage(err)}`;
    console.error(`[session-stats] agentsview failed${detail}`);
    return null;
  }

  let parsed: SessionStatsBlob;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[session-stats] JSON parse failed: ${errMessage(err)}`);
    return null;
  }

  if (!parsed || typeof parsed !== "object" || typeof parsed.schema_version !== "number") {
    console.error("[session-stats] unexpected output shape");
    return null;
  }
  return parsed;
}
