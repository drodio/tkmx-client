# AgentsView Pi and OpenCode Sessions Design

## Summary

The reporter currently collects AgentsView-backed local usage for Claude and Codex, plus optional extra homes through `EXTRA_CLAUDE_CONFIGS` and `EXTRA_CODEX_CONFIGS`. This feature extends the same pattern to Pi harness sessions and OpenCode sessions.

Public client naming stays user-facing and concise:

- Pi harness uses source `pi`, AgentsView filter `--agent pi`, and client config `EXTRA_PI_CONFIGS`.
- OpenCode uses source `opencode`, AgentsView filter `--agent opencode`, and client config `EXTRA_OPENCODE_CONFIGS`.

The only non-obvious mapping is internal to the child process environment: AgentsView documents the Pi harness source override as `PIEBALD_DIR`, so the reporter will pass `PIEBALD_DIR` when collecting configured extra Pi homes. This name will not be exposed as the tkmx-client public config.

## Requirements

- Collect local Pi harness and OpenCode usage from AgentsView on every report, alongside Claude and Codex.
- Support configured extra homes for Pi and OpenCode with the same fail-loud behavior as Claude and Codex.
- Keep one AgentsView sync pass per report; follow-up local agent queries must use `--no-sync`.
- Preserve existing merge behavior: rows with the same `(date, modelName, source)` sum before POST.
- Preserve current Claude, Codex, OpenAI platform, OpenClaw, session stats, and machine config behavior.

## Architecture

`reporter/agentsview.ts` will generalize the local AgentsView collection from a fixed two-agent return shape to a small descriptor-based collection over `claude`, `codex`, `pi`, and `opencode`.

The first local query will run without `--no-sync` to trigger AgentsView's registry sync. Subsequent local queries will pass `--no-sync`, matching the existing assumption that one sync pass covers all registered parsers.

`reporter/report.ts` will keep the existing extra-home helper and extend the descriptor list. Each descriptor will define:

- local daily usage returned from `collectAgentsviewUsage`
- public env var raw value
- AgentsView agent id
- expected configured-home subdir
- child env var passed to AgentsView
- display label

The merge call will include all AgentsView-backed sources plus OpenAI platform and OpenClaw arrays.

## Data Flow

Local collection:

1. Resolve and version-check `agentsview`.
2. Query `claude` with sync enabled.
3. Query `codex`, `pi`, and `opencode` with `--no-sync`.
4. Parse each AgentsView response into normalized `DailyUsage[]` with `source` set to the agent id.

Extra-home collection:

1. Read comma-separated config from `EXTRA_<AGENT>_CONFIGS`.
2. For each configured entry, require the expected subdir to exist.
3. Create an isolated `AGENT_VIEWER_DATA_DIR` under `~/.agentsview-tkmx/<hash>/`.
4. Run AgentsView for that one agent with the source override env var pointed at the configured home.
5. Concatenate those results into the matching source's local daily rows.

Expected extra-home mappings:

| Public config | Agent | Required subdir | AgentsView env |
| --- | --- | --- | --- |
| `EXTRA_CLAUDE_CONFIGS` | `claude` | `projects` | `CLAUDE_PROJECTS_DIR` |
| `EXTRA_CODEX_CONFIGS` | `codex` | `sessions` | `CODEX_SESSIONS_DIR` |
| `EXTRA_PI_CONFIGS` | `pi` | `.` | `PIEBALD_DIR` |
| `EXTRA_OPENCODE_CONFIGS` | `opencode` | `.` | `OPENCODE_DIR` |

Pi and OpenCode AgentsView help describes root data directories, not nested transcript subdirectories. For those two, each configured entry is treated as the directory passed directly to AgentsView. The existing helper can support this with `subdir: "."`, which still validates that the configured path exists.

## Error Handling

Configured extra homes remain fatal when invalid or uncollectable. A missing Pi/OpenCode path, or an AgentsView failure for that configured path, aborts the run before POSTing. This matches the existing posture for Claude and Codex and avoids silently underreporting user-declared sources.

Local Pi/OpenCode collection behaves like local Claude/Codex collection: an AgentsView query failure is fatal because token usage collection is the core reporter job.

## Testing

Tests will be added or updated before implementation:

- `collectAgentsviewUsage` invokes local agents in order: `claude` sync, then `codex`, `pi`, and `opencode` with `--no-sync`.
- Local Pi and OpenCode rows are tagged with sources `pi` and `opencode`.
- E2E extra-home matrix includes `EXTRA_PI_CONFIGS` and `EXTRA_OPENCODE_CONFIGS`.
- Extra Pi homes pass `PIEBALD_DIR=<home>` to AgentsView and sum into source `pi`.
- Extra OpenCode homes pass `OPENCODE_DIR=<home>` to AgentsView and sum into source `opencode`.
- Bad configured Pi/OpenCode homes abort with no POST.

## Out of Scope

- No new public `PIEBALD_*` tkmx-client config.
- No generic arbitrary AgentsView agent list.
- No server API changes.
- No changes to session stats collection.
