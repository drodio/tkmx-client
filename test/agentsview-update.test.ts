import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { autoUpdateEnabled, maybeAutoUpdateAgentsview } from "../reporter/agentsview-update";

describe("autoUpdateEnabled", () => {
  it("defaults to enabled when unset", () => {
    assert.equal(autoUpdateEnabled({}), true);
  });

  it("treats false/0/no/off (any case) as disabled", () => {
    for (const v of ["false", "FALSE", "0", "no", "No", "off", "OFF", " false "]) {
      assert.equal(autoUpdateEnabled({ AGENTSVIEW_AUTO_UPDATE: v }), false, `value: ${JSON.stringify(v)}`);
    }
  });

  it("treats any other value as enabled", () => {
    for (const v of ["true", "1", "yes", "on", "anything"]) {
      assert.equal(autoUpdateEnabled({ AGENTSVIEW_AUTO_UPDATE: v }), true, `value: ${JSON.stringify(v)}`);
    }
  });
});

describe("maybeAutoUpdateAgentsview", () => {
  function withTmp(fn: (tmp: string) => void) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-av-update-"));
    try {
      fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A fake agentsview that records each invocation's argv to `log`, so tests
  // can assert whether `update` actually ran.
  function writeFakeAgentsview(tmp: string, log: string): string {
    const bin = path.join(tmp, "fake-agentsview");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `printf '%s ' "$@" >> "${log}"\n` +
        `printf '\\n' >> "${log}"\n` +
        `case "$1" in\n` +
        `  --version) echo "agentsview v0.33.1 (commit abc, built 2026-06-12T00:00:00Z)" ;;\n` +
        `  update) exit 0 ;;\n` +
        `  *) exit 0 ;;\n` +
        `esac\n`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  it("runs update when no stamp exists and writes the stamp", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");

      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000 });
      assert.equal(ran, true);
      assert.match(fs.readFileSync(log, "utf-8"), /^update /m);
      assert.equal(fs.readFileSync(stamp, "utf-8").trim(), "1700000000000");
    });
  });

  it("skips update when last check is within the interval", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");
      const now = 50 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(stamp, String(now - 60_000)); // checked 1 min ago

      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: now });
      assert.equal(ran, false);
      assert.equal(fs.existsSync(log), false, "update must not have been invoked");
    });
  });

  it("runs again once the interval has elapsed", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");
      const now = 50 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(stamp, String(now - 25 * 60 * 60 * 1000)); // 25h ago

      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: now });
      assert.equal(ran, true);
      assert.match(fs.readFileSync(log, "utf-8"), /^update /m);
    });
  });

  it("does nothing when disabled via env, even with no stamp", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");

      const ran = maybeAutoUpdateAgentsview(bin, stamp, {
        nowMs: 1_700_000_000_000,
        env: { AGENTSVIEW_AUTO_UPDATE: "false" },
      });
      assert.equal(ran, false);
      assert.equal(fs.existsSync(log), false);
      assert.equal(fs.existsSync(stamp), false, "disabled run must not write a stamp");
    });
  });

  it("logs the version change when update bumps the binary", () => {
    withTmp((tmp) => {
      // --version reports 0.1.0 until `update` drops a marker, then 0.2.0 —
      // so the before/after detection sees a real bump.
      const bin = path.join(tmp, "fake-agentsview");
      const marker = path.join(tmp, "updated");
      fs.writeFileSync(
        bin,
        `#!/usr/bin/env bash\n` +
          `case "$1" in\n` +
          `  --version) if [ -f "${marker}" ]; then echo "agentsview v0.2.0"; else echo "agentsview v0.1.0"; fi ;;\n` +
          `  update) touch "${marker}"; exit 0 ;;\n` +
          `  *) exit 0 ;;\n` +
          `esac\n`,
      );
      fs.chmodSync(bin, 0o755);
      const stamp = path.join(tmp, ".agentsview-update-check");

      const logs: string[] = [];
      const orig = console.log;
      console.log = (m?: unknown) => { logs.push(String(m)); };
      try {
        const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000 });
        assert.equal(ran, true);
      } finally {
        console.log = orig;
      }
      assert.ok(
        logs.some((l) => /auto-updated: 0\.1\.0 -> 0\.2\.0/.test(l)),
        `expected a version-change log line, got: ${logs.join(" | ")}`,
      );
    });
  });

  it("records the check time before updating so a failing update doesn't retry every run", () => {
    withTmp((tmp) => {
      // agentsview that always fails the update.
      const bin = path.join(tmp, "fake-agentsview");
      fs.writeFileSync(
        bin,
        `#!/usr/bin/env bash\ncase "$1" in\n  --version) echo "agentsview v0.1.0" ;;\n  update) echo boom >&2; exit 1 ;;\n  *) exit 0 ;;\nesac\n`,
      );
      fs.chmodSync(bin, 0o755);
      const stamp = path.join(tmp, ".agentsview-update-check");

      // First run attempts the (failing) update but still stamps.
      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000 });
      assert.equal(ran, true);
      assert.equal(fs.readFileSync(stamp, "utf-8").trim(), "1700000000000");

      // Immediately after, it's throttled — no second attempt.
      const ran2 = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000 + 60_000 });
      assert.equal(ran2, false);
    });
  });
});
