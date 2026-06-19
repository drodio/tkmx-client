# AgentsView Pi and OpenCode Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect Pi harness and OpenCode token usage through AgentsView, including local sessions and configured extra homes, using the same reporting behavior as Claude and Codex.

**Architecture:** Extend the existing AgentsView-backed reporter path from two fixed agents to a descriptor-backed four-agent flow: `claude`, `codex`, `pi`, and `opencode`. Keep one sync pass, query later agents with `--no-sync`, and fold each agent's local plus extra-home rows into the existing `mergeDailyUsage` pipeline.

**Tech Stack:** TypeScript, Node.js `node:test`, AgentsView CLI, existing reporter modules under `reporter/`.

---

## File Structure

- Modify `reporter/agentsview.ts`: define supported local AgentsView agents and return a usage map keyed by source name.
- Modify `reporter/report.ts`: add `EXTRA_PI_CONFIGS` and `EXTRA_OPENCODE_CONFIGS`, extend extra-home descriptors, and merge all AgentsView-backed sources.
- Modify `test/agentsview.test.ts`: add local multi-agent collection coverage and update WARP sync scoping expectations.
- Modify `test/report-e2e.test.ts`: update fake AgentsView env logging/failure hooks and extend extra-home matrix to Pi/OpenCode.
- Modify `README.md`: document Pi/OpenCode local collection and extra-home config.

## Task 1: Add Failing AgentsView Collector Tests

**Files:**
- Modify: `test/agentsview.test.ts`
- Test: `test/agentsview.test.ts`

- [ ] **Step 1: Add a failing local multi-agent collection test**

Add this test immediately before the existing `describe("collectAgentsviewUsage WARP_DIR scoping", ...)` block:

```ts
describe("collectAgentsviewUsage local agents", () => {
  it("collects claude, codex, pi, and opencode with one sync pass", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-agents-"));
    try {
      const logPath = path.join(tmp, "calls.log");
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(
        fakeBin,
        `#!/bin/sh
agent=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--agent" ]; then agent="$arg"; fi
  prev="$arg"
done
echo "$*" >> "${logPath}"
printf '{"daily":[{"date":"2026-05-01","modelBreakdowns":[{"modelName":"%s-model","inputTokens":10,"outputTokens":2}]}]}\\n' "$agent"
`,
      );

      const usageByAgent = collectAgentsviewUsage(fakeBin, "20260501") as any;

      assert.deepEqual(Object.keys(usageByAgent).sort(), ["claude", "codex", "opencode", "pi"]);
      assert.equal(usageByAgent.claude[0].modelBreakdowns[0].source, "claude");
      assert.equal(usageByAgent.codex[0].modelBreakdowns[0].source, "codex");
      assert.equal(usageByAgent.pi[0].modelBreakdowns[0].source, "pi");
      assert.equal(usageByAgent.opencode[0].modelBreakdowns[0].source, "opencode");

      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      assert.deepEqual(
        lines.map((line) => line.match(/--agent ([^ ]+)/)?.[1]),
        ["claude", "codex", "pi", "opencode"],
      );
      assert.ok(!lines[0].includes("--no-sync"), "first claude call should trigger the one sync pass");
      for (const line of lines.slice(1)) {
        assert.ok(line.includes("--no-sync"), `follow-up call should skip sync: ${line}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Update the WARP_DIR scoping test expectation**

Replace the body after `const lines = ...` in the WARP_DIR test with:

```ts
const claudeLine = lines.find((l) => l.includes("--agent claude"));
assert.match(claudeLine, /WARP_DIR=\/var\/empty\|/);

for (const agent of ["codex", "pi", "opencode"]) {
  const line = lines.find((l) => l.includes(`--agent ${agent}`));
  assert.ok(line, `missing ${agent} call`);
  assert.ok(line.includes("--no-sync"), `${agent} call should pass --no-sync`);
  assert.doesNotMatch(line, /WARP_DIR=\/var\/empty\|/);
}
```

- [ ] **Step 3: Run the targeted test and verify RED**

Run:

```bash
npm run build:tests && node --test dist/test/agentsview.test.js
```

Expected: FAIL. The new local multi-agent test should show that the collector still returns `claudeDaily`/`codexDaily` instead of keys `claude`, `codex`, `pi`, and `opencode`, or that the Pi/OpenCode calls are missing.

## Task 2: Implement the AgentsView Collector Map

**Files:**
- Modify: `reporter/agentsview.ts`
- Modify: `reporter/report.ts`
- Test: `test/agentsview.test.ts`

- [ ] **Step 1: Replace the fixed two-agent return shape**

In `reporter/agentsview.ts`, add these exports near the `AgentsviewJson` interface:

```ts
export const LOCAL_AGENTSVIEW_AGENTS = ["claude", "codex", "pi", "opencode"] as const;
export type AgentsviewAgent = (typeof LOCAL_AGENTSVIEW_AGENTS)[number];
export type AgentsviewUsageByAgent = Record<AgentsviewAgent, DailyUsage[]>;
```

Then replace `collectAgentsviewUsage` with:

```ts
export function collectAgentsviewUsage(
  bin: string,
  sinceStr: string,
  timeoutMs: number = 180000,
): AgentsviewUsageByAgent {
  const since = toIsoDate(sinceStr);
  const usageByAgent = {} as AgentsviewUsageByAgent;

  LOCAL_AGENTSVIEW_AGENTS.forEach((agent, index) => {
    usageByAgent[agent] = queryAgent(bin, since, agent, index > 0, timeoutMs);
  });

  return usageByAgent;
}
```

Update the comment above this function to say:

```ts
// One sync call covers every agent: agentsview's syncAllLocked
// (internal/sync/engine.go) iterates parser.Registry in a single
// pass, so triggering sync via the first query also picks up
// codex, pi, opencode, gemini, copilot, etc. Follow-up queries pass
// --no-sync to avoid redundant sync passes. If agentsview ever
// changes to per-agent sync scoping, remove that optimization here.
```

- [ ] **Step 2: Run the collector tests and verify GREEN**

Before running tests, keep the reporter buildable with the new return shape. In `reporter/report.ts`, replace:

```ts
const { claudeDaily: localClaudeDaily, codexDaily: localCodexDaily } = collectAgentsviewUsage(agentsviewBin, sinceStr);
console.log(`  Claude (local): ${localClaudeDaily.length} days`);
console.log(`  Codex (local): ${localCodexDaily.length} days`);
```

with:

```ts
const localAgentsviewDaily = collectAgentsviewUsage(agentsviewBin, sinceStr);
const localClaudeDaily = localAgentsviewDaily.claude;
const localCodexDaily = localAgentsviewDaily.codex;
console.log(`  Claude (local): ${localClaudeDaily.length} days`);
console.log(`  Codex (local): ${localCodexDaily.length} days`);
```

This is a compile-only adaptation. Pi and OpenCode are intentionally not merged into the POST body until Task 4, where the E2E tests drive that behavior.

- [ ] **Step 3: Run the collector tests and verify GREEN**

Run:

```bash
npm run build && npm run build:tests && node --test dist/test/agentsview.test.js
```

Expected: PASS for `agentsview.test.js`.

- [ ] **Step 4: Commit the collector change**

Run:

```bash
git add reporter/agentsview.ts reporter/report.ts test/agentsview.test.ts
git commit -m "feat(reporter): collect pi and opencode from agentsview"
```

## Task 3: Add Failing Reporter E2E Tests for Extra Homes

**Files:**
- Modify: `test/report-e2e.test.ts`
- Test: `test/report-e2e.test.ts`

- [ ] **Step 1: Generalize fake AgentsView failure/env logging**

Change the fake writer signature from:

```ts
function writeFakeAgentsview(fakeBin, argvLog, dailyJson, failCodexSessionsDir = "") {
```

to:

```ts
function writeFakeAgentsview(fakeBin, argvLog, dailyJson, failUsageEnvKey = "", failUsageEnvValue = "") {
```

In the Windows fake script, replace the `envCols` line with:

```ts
const envCols = ["CODEX_SESSIONS_DIR", "CLAUDE_PROJECTS_DIR", "PIEBALD_DIR", "OPENCODE_DIR", "AGENT_VIEWER_DATA_DIR"].map((k) => k + "=" + (process.env[k] || ""));
```

Replace the Windows usage-failure block with:

```ts
if (${JSON.stringify(failUsageEnvKey)} && process.env[${JSON.stringify(failUsageEnvKey)}] === ${JSON.stringify(failUsageEnvValue)}) {
  process.stderr.write("agentsview: simulated usage failure for " + ${JSON.stringify(failUsageEnvKey)} + "=" + process.env[${JSON.stringify(failUsageEnvKey)}] + "\\n");
  process.exit(2);
}
```

In the POSIX fake script, replace the env logging printf with:

```bash
printf 'CODEX_SESSIONS_DIR=%s\tCLAUDE_PROJECTS_DIR=%s\tPIEBALD_DIR=%s\tOPENCODE_DIR=%s\tAGENT_VIEWER_DATA_DIR=%s\t' "$CODEX_SESSIONS_DIR" "$CLAUDE_PROJECTS_DIR" "$PIEBALD_DIR" "$OPENCODE_DIR" "$AGENT_VIEWER_DATA_DIR" >> "${argvLog}"
```

Replace the POSIX usage-failure block with:

```bash
if [ -n '${failUsageEnvKey}' ] && [ "$(eval "printf '%s' \"\\$${failUsageEnvKey}\"")" = '${failUsageEnvValue}' ]; then
  echo "agentsview: simulated usage failure for ${failUsageEnvKey}=${failUsageEnvValue}" >&2
  exit 2
fi
```

- [ ] **Step 2: Update setupE2E parameters**

Change:

```ts
async function setupE2E({ dailyJson, failCodexSessionsDir = "" }) {
```

to:

```ts
async function setupE2E({ dailyJson, failUsageEnvKey = "", failUsageEnvValue = "" }) {
```

Change the fake writer call to:

```ts
writeFakeAgentsview(fakeScript, argvLog, dailyJson, failUsageEnvKey, failUsageEnvValue);
```

Add empty defaults to `baseEnv`:

```ts
EXTRA_PI_CONFIGS: "",
EXTRA_OPENCODE_CONFIGS: "",
```

- [ ] **Step 3: Extend the extra-home success matrix**

Replace the two-case matrix above `sums every configured home's usage` with:

```ts
for (const tc of [
  { agent: "codex", envVar: "EXTRA_CODEX_CONFIGS", subdir: "sessions", subdirEnvKey: "CODEX_SESSIONS_DIR", source: "codex" },
  { agent: "claude", envVar: "EXTRA_CLAUDE_CONFIGS", subdir: "projects", subdirEnvKey: "CLAUDE_PROJECTS_DIR", source: "claude" },
  { agent: "pi", envVar: "EXTRA_PI_CONFIGS", subdir: ".", subdirEnvKey: "PIEBALD_DIR", source: "pi" },
  { agent: "opencode", envVar: "EXTRA_OPENCODE_CONFIGS", subdir: ".", subdirEnvKey: "OPENCODE_DIR", source: "opencode" },
]) {
```

Replace the home directory setup with:

```ts
const sourcePath = (home: string) => tc.subdir === "." ? home : path.join(home, tc.subdir);
fs.mkdirSync(sourcePath(homeA), { recursive: true });
fs.mkdirSync(sourcePath(homeB), { recursive: true });
```

Replace the "other source" assertion with:

```ts
for (const source of ["claude", "codex", "pi", "opencode"].filter((source) => source !== tc.source)) {
  const localOnlyRow = day.modelBreakdowns.find((m) => m.source === source && m.modelName === "gpt-5.5");
  assert.ok(localOnlyRow, `expected a ${source}-source row from the local scan`);
  assert.equal(localOnlyRow.inputTokens, 1000, `extra ${tc.agent} homes must not be counted under ${source}`);
}
```

Replace the env-var wiring assertion body with:

```ts
for (const home of [homeA, homeB]) {
  assert.ok(
    usageCalls.some((l) => l.includes(`${tc.subdirEnvKey}=${sourcePath(home)}`)),
    `expected a ${tc.agent} usage call with ${tc.subdirEnvKey}=${sourcePath(home)}, got:\n${usageCalls.join("\n")}`,
  );
}
```

- [ ] **Step 4: Extend the fail-loud matrix**

Replace the `EXTRA_CODEX_CONFIGS`-only failure test matrix with:

```ts
for (const tc of [
  {
    agent: "codex",
    envVar: "EXTRA_CODEX_CONFIGS",
    subdir: "sessions",
    subdirEnvKey: "CODEX_SESSIONS_DIR",
    missingName: "missing sessions/ subdir",
    missingPattern: /missing sessions\/ subdir/i,
  },
  {
    agent: "pi",
    envVar: "EXTRA_PI_CONFIGS",
    subdir: ".",
    subdirEnvKey: "PIEBALD_DIR",
    missingName: "missing configured directory",
    missingPattern: /missing directory/i,
  },
  {
    agent: "opencode",
    envVar: "EXTRA_OPENCODE_CONFIGS",
    subdir: ".",
    subdirEnvKey: "OPENCODE_DIR",
    missingName: "missing configured directory",
    missingPattern: /missing directory/i,
  },
]) {
  for (const mode of [
    { name: tc.missingName, makeSource: false, failUsage: false, expectStderr: tc.missingPattern },
    { name: "agentsview usage call fails for a valid home", makeSource: true, failUsage: true, expectStderr: /usage collection failed/i },
  ]) {
    test(`a configured ${tc.envVar} home aborts the run with no POST when it can't be collected - ${mode.name}`, async () => {
      const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tkmx-${tc.agent}-bad-`));
      const home = path.join(extraRoot, `${tc.agent}-account-broken`);
      const sourcePath = tc.subdir === "." ? home : path.join(home, tc.subdir);
      if (mode.makeSource) fs.mkdirSync(sourcePath, { recursive: true });
      else fs.mkdirSync(extraRoot, { recursive: true });
      const ctx = await setupE2E({
        dailyJson:
          '{"daily":[{"date":"2026-05-25","modelBreakdowns":[{"modelName":"gpt-5.5","inputTokens":1000,"outputTokens":100,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
        failUsageEnvKey: mode.failUsage ? tc.subdirEnvKey : "",
        failUsageEnvValue: mode.failUsage ? sourcePath : "",
      });
      try {
        const result = await runReporter({
          ...ctx.baseEnv,
          REPORT_DAYS: "3650",
          [tc.envVar]: home,
        });
        assert.notEqual(result.status, 0, "reporter must exit non-zero when a configured home can't be collected");
        assert.equal(ctx.getCaptured(), null, "no POST may be sent when a configured extra home can't be collected");
        assert.match(result.stderr, new RegExp(`${tc.agent}-account-broken`, "i"), `expected fatal error naming the home, got stderr:\n${result.stderr}`);
        assert.match(result.stderr, mode.expectStderr, `expected the ${mode.name} branch's error message, got stderr:\n${result.stderr}`);
      } finally {
        fs.rmSync(extraRoot, { recursive: true, force: true });
        ctx.cleanup();
      }
    });
  }
}
```

- [ ] **Step 5: Run the targeted E2E test and verify RED**

Run:

```bash
npm run build && npm run build:tests && node --test dist/test/report-e2e.test.js
```

Expected: FAIL because `EXTRA_PI_CONFIGS` and `EXTRA_OPENCODE_CONFIGS` are not wired in `reporter/report.ts` yet, and local Pi/OpenCode rows are not merged into the POST body yet.

## Task 4: Wire Pi/OpenCode Through the Reporter

**Files:**
- Modify: `reporter/report.ts`
- Test: `test/report-e2e.test.ts`

- [ ] **Step 1: Add the new env constants**

Near the existing extra config constants, change:

```ts
const EXTRA_CLAUDE_CONFIGS = process.env.EXTRA_CLAUDE_CONFIGS || "";
const EXTRA_CODEX_CONFIGS = process.env.EXTRA_CODEX_CONFIGS || "";
```

to:

```ts
const EXTRA_CLAUDE_CONFIGS = process.env.EXTRA_CLAUDE_CONFIGS || "";
const EXTRA_CODEX_CONFIGS = process.env.EXTRA_CODEX_CONFIGS || "";
const EXTRA_PI_CONFIGS = process.env.EXTRA_PI_CONFIGS || "";
const EXTRA_OPENCODE_CONFIGS = process.env.EXTRA_OPENCODE_CONFIGS || "";
```

- [ ] **Step 2: Make extra-home path validation handle root data dirs**

Inside `collectExtraAgentsviewHomes`, replace:

```ts
const subdirPath = path.join(absEntry, opts.subdir);
if (!fs.existsSync(subdirPath)) {
  throw new Error(`${opts.label} (${name}) missing ${opts.subdir}/ subdir at ${absEntry} — a configured EXTRA_${opts.label.toUpperCase()}_CONFIGS home must be a valid ${opts.agent} home`);
}
```

with:

```ts
const subdirPath = opts.subdir === "." ? absEntry : path.join(absEntry, opts.subdir);
const expectedPathLabel = opts.subdir === "." ? "directory" : `${opts.subdir}/ subdir`;
if (!fs.existsSync(subdirPath)) {
  throw new Error(`${opts.label} (${name}) missing ${expectedPathLabel} at ${absEntry} — a configured EXTRA_${opts.label.toUpperCase()}_CONFIGS home must be a valid ${opts.agent} home`);
}
```

- [ ] **Step 3: Replace fixed local destructuring with descriptor-based aggregation**

Replace:

```ts
const localAgentsviewDaily = collectAgentsviewUsage(agentsviewBin, sinceStr);
const localClaudeDaily = localAgentsviewDaily.claude;
const localCodexDaily = localAgentsviewDaily.codex;
console.log(`  Claude (local): ${localClaudeDaily.length} days`);
console.log(`  Codex (local): ${localCodexDaily.length} days`);
```

with:

```ts
const localAgentsviewDaily = collectAgentsviewUsage(agentsviewBin, sinceStr);
console.log(`  Claude (local): ${localAgentsviewDaily.claude.length} days`);
console.log(`  Codex (local): ${localAgentsviewDaily.codex.length} days`);
console.log(`  Pi (local): ${localAgentsviewDaily.pi.length} days`);
console.log(`  OpenCode (local): ${localAgentsviewDaily.opencode.length} days`);
```

Replace the two-source map:

```ts
const [claudeDaily, allCodexDaily] = [
  { local: localClaudeDaily, raw: EXTRA_CLAUDE_CONFIGS, agent: "claude", subdir: "projects", subdirEnvKey: "CLAUDE_PROJECTS_DIR", label: "Claude" },
  { local: localCodexDaily,  raw: EXTRA_CODEX_CONFIGS,  agent: "codex",  subdir: "sessions",  subdirEnvKey: "CODEX_SESSIONS_DIR", label: "Codex" },
].map((s) => s.local.concat(collectExtraAgentsviewHomes(agentsviewBin, sinceStr, s.raw, s)));
```

with:

```ts
const agentsviewSources = [
  { local: localAgentsviewDaily.claude, raw: EXTRA_CLAUDE_CONFIGS, agent: "claude", subdir: "projects", subdirEnvKey: "CLAUDE_PROJECTS_DIR", label: "Claude" },
  { local: localAgentsviewDaily.codex, raw: EXTRA_CODEX_CONFIGS, agent: "codex", subdir: "sessions", subdirEnvKey: "CODEX_SESSIONS_DIR", label: "Codex" },
  { local: localAgentsviewDaily.pi, raw: EXTRA_PI_CONFIGS, agent: "pi", subdir: ".", subdirEnvKey: "PIEBALD_DIR", label: "Pi" },
  { local: localAgentsviewDaily.opencode, raw: EXTRA_OPENCODE_CONFIGS, agent: "opencode", subdir: ".", subdirEnvKey: "OPENCODE_DIR", label: "OpenCode" },
];
const agentsviewDaily = agentsviewSources.map((s) => (
  s.local.concat(collectExtraAgentsviewHomes(agentsviewBin, sinceStr, s.raw, s))
));
```

Replace:

```ts
const mergedDaily = mergeDailyUsage(claudeDaily, allCodexDaily, openaiDaily, openclawDaily);
```

with:

```ts
const mergedDaily = mergeDailyUsage(...agentsviewDaily, openaiDaily, openclawDaily);
```

- [ ] **Step 4: Run E2E tests and verify GREEN**

Run:

```bash
npm run build && npm run build:tests && node --test dist/test/report-e2e.test.js
```

Expected: PASS for `report-e2e.test.js`.

- [ ] **Step 5: Commit reporter wiring**

Run:

```bash
git add reporter/report.ts test/report-e2e.test.ts
git commit -m "feat(reporter): report extra pi and opencode homes"
```

## Task 5: Update README and Run Full Verification

**Files:**
- Modify: `README.md`
- Test: full project test suite

- [ ] **Step 1: Update setup copy**

In the setup section, change:

```md
[agentsview](https://www.agentsview.io/token-usage/) is required — it reads your local Claude Code and Codex usage data from an incrementally-synced SQLite index, which is dramatically faster than walking every JSONL transcript.
```

to:

```md
[agentsview](https://www.agentsview.io/token-usage/) is required — it reads your local Claude Code, Codex, Pi harness, and OpenCode usage data from an incrementally-synced SQLite index, which is dramatically faster than walking every transcript on each report.
```

Change:

```md
Codex CLI usage is auto-detected from `~/.codex/` — no extra setup beyond agentsview.
```

to:

```md
Codex, Pi harness, and OpenCode usage are auto-detected from AgentsView's supported default locations — no extra setup beyond agentsview.
```

- [ ] **Step 2: Document extra Pi/OpenCode configs**

After the `EXTRA_CODEX_CONFIGS` example in the "Aggregating from synced remote machines" section, add:

```md
Pi harness and OpenCode can be aggregated the same way when their data lives outside the local machine's default AgentsView scan. These config values point directly at the data directory AgentsView should scan, not at a nested `projects/` or `sessions/` subdirectory:

```
EXTRA_PI_CONFIGS=/path/to/pi-data-a,/path/to/pi-data-b
EXTRA_OPENCODE_CONFIGS=/path/to/opencode-data-a,/path/to/opencode-data-b
```

Pi reports under the `pi` source and OpenCode reports under the `opencode` source. A configured directory that does not exist, or that AgentsView cannot collect, aborts the run before POSTing so the report cannot silently undercount declared sources.
```

- [ ] **Step 3: Update "How It Works" source list**

Change:

```md
it maintains its own sqlite database synced from `~/.claude` and `~/.codex`, and the reporter queries it via `agentsview usage daily --json --breakdown --agent <claude|codex>`.
```

to:

```md
it maintains its own sqlite database synced from supported local agent data directories, and the reporter queries it via `agentsview usage daily --json --breakdown --agent <claude|codex|pi|opencode>`.
```

Change:

```md
When `EXTRA_CLAUDE_CONFIGS` (or `EXTRA_CODEX_CONFIGS`) is set, the reporter runs one agentsview invocation per extra home, each with its own `AGENT_VIEWER_DATA_DIR` (under `~/.agentsview-tkmx/<hash>/`) and the matching source dir env — `CLAUDE_PROJECTS_DIR` (`<home>/projects`) for Claude, `CODEX_SESSIONS_DIR` (`<home>/sessions`) for Codex.
```

to:

```md
When `EXTRA_CLAUDE_CONFIGS`, `EXTRA_CODEX_CONFIGS`, `EXTRA_PI_CONFIGS`, or `EXTRA_OPENCODE_CONFIGS` is set, the reporter runs one agentsview invocation per extra home, each with its own `AGENT_VIEWER_DATA_DIR` (under `~/.agentsview-tkmx/<hash>/`) and the matching source dir env — `CLAUDE_PROJECTS_DIR` (`<home>/projects`) for Claude, `CODEX_SESSIONS_DIR` (`<home>/sessions`) for Codex, `PIEBALD_DIR` (`<home>`) for Pi, and `OPENCODE_DIR` (`<home>`) for OpenCode.
```

Change:

```md
The reporter merges daily token-usage rows from all enabled sources (Claude, Codex, OpenAI platform, OpenClaw) client-side into `body.data`
```

to:

```md
The reporter merges daily token-usage rows from all enabled sources (Claude, Codex, Pi, OpenCode, OpenAI platform, OpenClaw) client-side into `body.data`
```

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
```

Expected: PASS for all tests.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add README.md
git commit -m "docs: document pi and opencode reporting"
```

## Self-Review

- Spec coverage: local collection, extra-home collection, one sync pass, merge behavior, fail-loud errors, and public Pi naming are each covered by a task.
- Placeholder scan: no plan step uses a placeholder; all code edits have concrete snippets.
- Type consistency: `pi`, `opencode`, `EXTRA_PI_CONFIGS`, `EXTRA_OPENCODE_CONFIGS`, `PIEBALD_DIR`, and `OPENCODE_DIR` are used consistently across tests, reporter wiring, and docs.
