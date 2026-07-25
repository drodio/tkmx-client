import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { parseAgentsviewOutput, toIsoDate, collectAgentsviewUsage, syncAgentsview, resolveAgentsviewWith, queryTimeoutMs, DEFAULT_QUERY_TIMEOUT_MS, MAX_QUERY_TIMEOUT_MS, resetTimeoutWarningForTest, collectAgentsviewAgentOnly } from "../reporter/agentsview";

// Write an executable fixture (default: a no-op shell stub) and mark it +x.
function writeExec(p, body = "#!/bin/sh\n") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

describe("toIsoDate", () => {
  it("converts YYYYMMDD to YYYY-MM-DD", () => {
    assert.equal(toIsoDate("20260413"), "2026-04-13");
  });

  it("preserves single-digit months and days", () => {
    assert.equal(toIsoDate("20260101"), "2026-01-01");
  });
});

describe("parseAgentsviewOutput", () => {
  const sample = () => ({
    daily: [
      {
        date: "2026-04-10",
        modelBreakdowns: [
          {
            modelName: "claude-opus-4-6",
            inputTokens: 100,
            outputTokens: 200,
            cacheCreationTokens: 50,
            cacheReadTokens: 300,
            cost: 1.23,
          },
          {
            modelName: "claude-haiku-4-5",
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 5,
            cacheReadTokens: 30,
            cost: 0.05,
          },
        ],
      },
    ],
  });

  it("tags each breakdown with the given source", () => {
    const daily = parseAgentsviewOutput(sample(), "claude");
    for (const day of daily) {
      for (const m of day.modelBreakdowns) {
        assert.equal(m.source, "claude");
      }
    }
  });

  it("computes totalTokens as sum of all token-type fields", () => {
    const daily = parseAgentsviewOutput(sample(), "claude");
    assert.equal(daily[0].modelBreakdowns[0].totalTokens, 100 + 200 + 50 + 300);
    assert.equal(daily[0].modelBreakdowns[1].totalTokens, 10 + 20 + 5 + 30);
  });

  it("preserves the cost field untouched", () => {
    const daily = parseAgentsviewOutput(sample(), "claude");
    assert.equal(daily[0].modelBreakdowns[0].cost, 1.23);
    assert.equal(daily[0].modelBreakdowns[1].cost, 0.05);
  });

  it("returns [] for empty daily", () => {
    assert.deepEqual(parseAgentsviewOutput({ daily: [] }, "claude"), []);
  });

  it("returns [] when daily field is missing", () => {
    assert.deepEqual(parseAgentsviewOutput({}, "claude"), []);
  });

  it("treats missing token fields as 0 when computing totalTokens", () => {
    const parsed = {
      daily: [
        {
          date: "2026-04-10",
          modelBreakdowns: [
            { modelName: "x", inputTokens: 100, outputTokens: 50 },
          ],
        },
      ],
    };
    const daily = parseAgentsviewOutput(parsed, "codex");
    assert.equal(daily[0].modelBreakdowns[0].totalTokens, 150);
    assert.equal(daily[0].modelBreakdowns[0].source, "codex");
  });

  it("handles a day with no modelBreakdowns array", () => {
    const parsed = { daily: [{ date: "2026-04-10" }] };
    const daily = parseAgentsviewOutput(parsed, "claude");
    assert.equal(daily.length, 1);
    assert.equal(daily[0].date, "2026-04-10");
  });
});

describe("syncAgentsview", () => {
  function writeExec(dir, body) {
    const p = path.join(dir, "fake-agentsview");
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
    return p;
  }

  it("returns true when `agentsview sync` exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = writeExec(tmp, "#!/bin/sh\nexit 0\n");
      assert.equal(syncAgentsview(bin), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false (best-effort, no throw) when sync fails", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = writeExec(tmp, "#!/bin/sh\necho boom >&2\nexit 1\n");
      assert.equal(syncAgentsview(bin), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false (no throw) when sync hangs past the timeout", () => {
    // Mirrors the macOS launchd deadlock: the sync never returns, so the
    // timeout must SIGKILL it and we fall through to a read instead of
    // hanging the whole report.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = writeExec(tmp, "#!/bin/sh\nsleep 30\n");
      assert.equal(syncAgentsview(bin, 300), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("collectAgentsviewUsage WARP_DIR scoping", () => {
  // A fake agentsview that records the WARP_DIR it received plus its args,
  // then emits empty daily JSON so the caller parses cleanly. With the
  // deadlock fix, syncing is a standalone `agentsview sync` call (the only
  // one that runs the parser registry that hangs an unattended daemon) and
  // both reads pass --no-sync. So the Warp-skip must ride the sync call, not
  // the reads.
  it("sets WARP_DIR=/var/empty on the standalone sync call but not the --no-sync reads", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-warp-"));
    try {
      const logPath = path.join(tmp, "calls.log");
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(
        fakeBin,
        `#!/bin/sh\necho "WARP_DIR=\${WARP_DIR}|$*" >> "${logPath}"\ncase "$1" in sync) exit 0 ;; *) echo '{"daily":[]}' ;; esac\n`,
      );

      collectAgentsviewUsage(fakeBin, "20260501");

      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      const syncLine = lines.find((l) => l.includes("|sync"));
      const claudeLine = lines.find((l) => l.includes("--agent claude"));
      const codexLine = lines.find((l) => l.includes("--agent codex"));
      assert.match(syncLine, /WARP_DIR=\/var\/empty\|/);
      assert.ok(claudeLine.includes("--no-sync"), "claude read should pass --no-sync");
      assert.doesNotMatch(claudeLine, /WARP_DIR=\/var\/empty\|/);
      assert.ok(codexLine.includes("--no-sync"), "codex read should pass --no-sync");
      assert.doesNotMatch(codexLine, /WARP_DIR=\/var\/empty\|/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentsview", () => {
  // Isolate each case from the host's real agentsview install and any
  // ambient AGENTSVIEW_BIN env var. Tests that need $PATH to find
  // something set PATH explicitly; the default empty PATH makes
  // `which agentsview` miss.
  function withIsolatedEnv(fn) {
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPath = process.env.PATH;
    const origBin = process.env.AGENTSVIEW_BIN;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-resolve-"));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.PATH = "";
    delete process.env.AGENTSVIEW_BIN;
    try {
      return fn(tmp);
    } finally {
      process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      process.env.PATH = origPath;
      if (origBin === undefined) delete process.env.AGENTSVIEW_BIN;
      else process.env.AGENTSVIEW_BIN = origBin;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function localBinCandidate(tmp) {
    return path.join(tmp, ".local", "bin", process.platform === "win32" ? "agentsview.exe" : "agentsview");
  }

  it("returns null when no candidate path exists", () => {
    withIsolatedEnv(() => {
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), null);
    });
  });

  it("returns the first existing executable candidate", () => {
    withIsolatedEnv((tmp) => {
      const fake = localBinCandidate(tmp);
      writeExec(fake);
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), fake);
    });
  });

  it("skips non-executable candidates", { skip: process.platform === "win32" }, () => {
    withIsolatedEnv((tmp) => {
      const fake = localBinCandidate(tmp);
      fs.mkdirSync(path.dirname(fake), { recursive: true });
      fs.writeFileSync(fake, "#!/bin/sh\n");
      fs.chmodSync(fake, 0o644); // not executable
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), null);
    });
  });

  it("skips candidates that are directories, not files", () => {
    withIsolatedEnv((tmp) => {
      fs.mkdirSync(path.join(tmp, ".local", "bin", "agentsview"), { recursive: true });
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), null);
    });
  });

  it("respects AGENTSVIEW_BIN override", () => {
    withIsolatedEnv((tmp) => {
      const override = path.join(tmp, "nix", "store", process.platform === "win32" ? "agentsview.exe" : "agentsview");
      writeExec(override);
      const candidate = localBinCandidate(tmp);
      writeExec(candidate);
      process.env.AGENTSVIEW_BIN = override;
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), override);
    });
  });

  it("ignores AGENTSVIEW_BIN override when it points at nothing", () => {
    withIsolatedEnv((tmp) => {
      const candidate = localBinCandidate(tmp);
      writeExec(candidate);
      process.env.AGENTSVIEW_BIN = "/nonexistent/agentsview";
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), candidate);
    });
  });

  it("falls back to PATH when no hard-coded candidate exists", () => {
    withIsolatedEnv((tmp) => {
      const pathDir = path.join(tmp, "custom", "bin");
      const fake = path.join(pathDir, process.platform === "win32" ? "agentsview.exe" : "agentsview");
      writeExec(fake);
      process.env.PATH = [pathDir, "/usr/bin", "/bin"].join(path.delimiter);
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), fake);
    });
  });

});

// The Windows branch runs on any host by injecting platform/env/isExecutable,
// so CI (Linux) actually exercises it instead of skipping. Paths are built
// with path.win32 semantics regardless of the host separator.
describe("resolveAgentsviewWith — Windows branch (host-independent)", () => {
  const winEnv = (overrides = {}) => ({ USERPROFILE: "C:\\Users\\dev", PATH: "", ...overrides });

  it("finds agentsview.exe in the installer location under USERPROFILE", () => {
    const expected = path.win32.join("C:\\Users\\dev", ".agentsview", "bin", "agentsview.exe");
    const found = resolveAgentsviewWith({
      platform: "win32",
      env: winEnv(),
      isExecutable: (p) => p === expected,
    });
    assert.equal(found, expected);
  });

  it("resolves agentsview.exe from a ;-separated PATH", () => {
    const dir = "C:\\tools\\bin";
    const expected = path.win32.join(dir, "agentsview.exe");
    const found = resolveAgentsviewWith({
      platform: "win32",
      env: winEnv({ PATH: ["C:\\other", dir].join(path.win32.delimiter) }),
      isExecutable: (p) => p === expected,
    });
    assert.equal(found, expected);
  });

  it("never resolves a .cmd/.bat shim — execFileSync can't run one on Windows", () => {
    // Even if a shim is the only thing on disk, the resolver must not hand it
    // back: it only ever probes agentsview.exe, so a shim is never a candidate.
    const shim = path.win32.join("C:\\Users\\dev", ".local", "bin", "agentsview.cmd");
    const found = resolveAgentsviewWith({
      platform: "win32",
      env: winEnv(),
      isExecutable: (p) => p === shim,
    });
    assert.equal(found, null);
  });
});

// The reporter's read queries are its only FATAL agentsview call — a timeout
// there aborts the whole run and posts nothing (observed in the wild: a 1.2 GB
// index under launchd blew the old fixed 180s budget every few runs). The
// budget is therefore generous by default and tunable per-machine, so a slow
// index degrades into a slow report rather than a lost one.
// Collect console.error output, resetting the process-global warn-once latch
// first so a warning latched by an earlier case can't swallow this one's.
function captureStderr(fn: () => void): string[] {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (msg?: unknown) => { lines.push(String(msg)); };
  try {
    resetTimeoutWarningForTest();
    fn();
  } finally {
    console.error = orig;
    resetTimeoutWarningForTest();
  }
  return lines;
}

function withTimeoutEnv(value: string | undefined, fn: () => void): void {
  const orig = process.env.AGENTSVIEW_TIMEOUT_MS;
  if (value === undefined) delete process.env.AGENTSVIEW_TIMEOUT_MS;
  else process.env.AGENTSVIEW_TIMEOUT_MS = value;
  try { fn(); } finally {
    if (orig === undefined) delete process.env.AGENTSVIEW_TIMEOUT_MS;
    else process.env.AGENTSVIEW_TIMEOUT_MS = orig;
  }
}

describe("queryTimeoutMs", () => {
  it("defaults to 10 minutes when unset", () => {
    withTimeoutEnv(undefined, () => {
      assert.equal(queryTimeoutMs(), DEFAULT_QUERY_TIMEOUT_MS);
      assert.equal(DEFAULT_QUERY_TIMEOUT_MS, 600_000);
    });
  });

  it("is more generous than the 180s budget that was timing out", () => {
    assert.ok(DEFAULT_QUERY_TIMEOUT_MS > 180_000);
  });

  it("honours a valid AGENTSVIEW_TIMEOUT_MS override", () => {
    withTimeoutEnv("45000", () => assert.equal(queryTimeoutMs(), 45_000));
  });

  it("falls back to the default for non-numeric, zero, or negative values", () => {
    for (const bad of ["", "   ", "abc", "0", "-1"]) {
      withTimeoutEnv(bad, () => assert.equal(queryTimeoutMs(), DEFAULT_QUERY_TIMEOUT_MS));
    }
  });

  // parseInt would keep the leading digits of each of these and hand back a
  // sub-second budget, which aborts every read — the failure this whole change
  // exists to prevent, reintroduced by a plausible operator typo.
  it("rejects unit-suffixed and exponent forms instead of truncating them", () => {
    for (const bad of ["10m", "600s", "1e6", "60_000", "10.5", " 10m "]) {
      withTimeoutEnv(bad, () => assert.equal(queryTimeoutMs(), DEFAULT_QUERY_TIMEOUT_MS));
    }
  });

  // An extra run of zeros is the same typo class from the other direction: it
  // parses cleanly but would disable the backstop, or (at the far end) make
  // spawnSync throw ERR_OUT_OF_RANGE and turn a config typo into a fatal run.
  // Clamped, NOT dropped to the default: an operator raising the budget after
  // watching an hour-long read must never silently get LESS than they asked for.
  it("clamps an above-ceiling value to the ceiling rather than the default", () => {
    for (const big of [String(MAX_QUERY_TIMEOUT_MS + 1), "7200000", "6000000000000"]) {
      withTimeoutEnv(big, () => assert.equal(queryTimeoutMs(), MAX_QUERY_TIMEOUT_MS));
    }
  });

  it("falls back to the default when the value exceeds safe-integer range", () => {
    withTimeoutEnv("9".repeat(400), () => assert.equal(queryTimeoutMs(), DEFAULT_QUERY_TIMEOUT_MS));
  });

  it("accepts a value exactly at the ceiling", () => {
    withTimeoutEnv(String(MAX_QUERY_TIMEOUT_MS), () => assert.equal(queryTimeoutMs(), MAX_QUERY_TIMEOUT_MS));
  });

  // The comment promises a rejection is LOUD. Without this, a silent fallback
  // would keep the whole suite green while violating the documented contract.
  it("warns on stderr naming the rejected value", () => {
    const lines = captureStderr(() => withTimeoutEnv("10m", () => queryTimeoutMs()));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /AGENTSVIEW_TIMEOUT_MS/);
    assert.match(lines[0], /10m/);
    // Must NOT quote a ceiling: above-ceiling values clamp, they don't reject,
    // so naming an upper bound here would state a rule that isn't applied.
    assert.doesNotMatch(lines[0], new RegExp(String(MAX_QUERY_TIMEOUT_MS)));
  });

  // The operationally surprising case: the operator asked for 7200000 and got
  // 3600000. If that warning is ever dropped or garbled the change is silent,
  // so assert it directly rather than relying on the return value alone.
  it("warns on stderr naming both the requested value and the ceiling when clamping", () => {
    const lines = captureStderr(() => withTimeoutEnv("7200000", () => queryTimeoutMs()));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /AGENTSVIEW_TIMEOUT_MS/);
    assert.match(lines[0], /7200000/);
    assert.match(lines[0], new RegExp(String(MAX_QUERY_TIMEOUT_MS)));
  });

  // One bad value is resolved once per agentsview home; without the latch the
  // operator greps their log and finds N copies of the same line.
  it("warns only once even across repeated resolutions", () => {
    const lines = captureStderr(() =>
      withTimeoutEnv("abc", () => { queryTimeoutMs(); queryTimeoutMs(); queryTimeoutMs(); }),
    );
    assert.equal(lines.length, 1);
  });

  it("accepts a bare integer with surrounding whitespace", () => {
    withTimeoutEnv("  45000  ", () => assert.equal(queryTimeoutMs(), 45_000));
  });
});

describe("query failure reporting", () => {
  // .env.example tells operators to raise the budget when they see a timeout,
  // so the timeout has to survive a child that wrote to stderr on its way out —
  // otherwise the documented diagnostic is missing in exactly the slow-index
  // case it targets.
  it("names the timeout even when the killed child also wrote to stderr", { skip: process.platform === "win32" }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-noisy-"));
    try {
      const fakeBin = path.join(tmp, "agentsview");
      // Exit the sync leg immediately — collectAgentsviewUsage syncs before it
      // reads, and a stub that slept there too would burn 5s of suite time in a
      // path this test isn't exercising.
      writeExec(fakeBin, `#!/bin/sh\n[ "$1" = sync ] && exit 0\necho "warning: index is cold" >&2\nsleep 5\n`);
      withTimeoutEnv("250", () => {
        assert.throws(
          () => collectAgentsviewUsage(fakeBin, "20260501"),
          (err: Error) => /ETIMEDOUT after 250ms/.test(err.message) && /index is cold/.test(err.message),
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Proves the env var reaches the actual execFileSync budget, not just the
  // helper — a fake binary that outlives a deliberately tiny timeout must
  // surface as a thrown query failure rather than a silent empty result.
  //
  // Also asserts WALL CLOCK, not just the error text. Without that, a
  // regression to an unenforced budget (the child outliving its kill and
  // holding the pipes open) still throws the same message and would pass
  // silently — the elapsed-time bound is what makes "backstop, not floor"
  // an actually tested claim. This test doubles as the env-resolved-at-call-time
  // check: the value is set after import and must reach the default parameter.
  it("enforces the resolved budget in wall-clock time, not just in the message", { skip: process.platform === "win32" }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-timeout-"));
    try {
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(fakeBin, `#!/bin/sh\n[ "$1" = sync ] && exit 0\nsleep 30\necho '{"daily":[]}'\n`);
      withTimeoutEnv("250", () => {
        const t0 = process.hrtime.bigint();
        assert.throws(() => collectAgentsviewUsage(fakeBin, "20260501"), /query failed/);
        const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(elapsedMs < 5000, `expected the 250ms budget to be enforced, took ${Math.round(elapsedMs)}ms`);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The extra-homes path was switched off the same 180s literal, and its failure
  // is escalated to fatal by collectExtraAgentsviewHomes — so it needs the same
  // proof that the budget reaches its exec.
  it("applies the resolved budget to collectAgentsviewAgentOnly too", { skip: process.platform === "win32" }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-home-"));
    try {
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(fakeBin, `#!/bin/sh\n[ "$1" = sync ] && exit 0\nsleep 30\necho '{"daily":[]}'\n`);
      withTimeoutEnv("250", () => {
        const t0 = process.hrtime.bigint();
        assert.throws(
          () => collectAgentsviewAgentOnly(fakeBin, "20260501", "claude", {}),
          /ETIMEDOUT after 250ms/,
        );
        const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(elapsedMs < 5000, `expected the 250ms budget to be enforced, took ${Math.round(elapsedMs)}ms`);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
