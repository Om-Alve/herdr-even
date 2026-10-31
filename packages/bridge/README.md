# @herdr-even/bridge

Per-machine bridge between Herdr (local unix sockets) and the herdr-even glasses plugin (WebSocket). Wire contract: `../protocol/src/index.ts`.

## Run

```sh
bun install                         # from the repo root
# 1. set your Tailscale login as owner (file is auto-created on first run)
$EDITOR ~/.config/herdr-even/config.json     # { "owner": "you@example.com", "port": 8791, "snippets": [...] }
# or: HERDR_EVEN_OWNER=you@example.com
bun run start                       # listens on 127.0.0.1:8791
tailscale serve --bg 8791           # expose to your tailnet over HTTPS (never Funnel, never bind 0.0.0.0)
```

`tailscale serve` adds the `Tailscale-User-Login` header; the bridge rejects `/ws` upgrades (403) unless it equals `owner`. It refuses to start with no owner.

Env overrides: `HERDR_EVEN_OWNER`, `HERDR_EVEN_PORT`, `HERDR_EVEN_HOST`. Transcript locations can be overridden with `HERDR_EVEN_CLAUDE_DIR`, `HERDR_EVEN_CODEX_DIR`, `HERDR_EVEN_CURSOR_DIR`, `HERDR_EVEN_OPENCODE_DB`, and `HERDR_EVEN_PI_DIR`. Test-only: `HERDR_EVEN_CONFIG_DIR`, `HERDR_EVEN_HERDR_DIR`.

### Dev mode (simulator testing)

```sh
HERDR_EVEN_DEV_NOAUTH=1 HERDR_EVEN_PORT=8799 bun run start
```
Skips the auth check, only honored when bound to loopback. Prints a loud warning. Never combine with `tailscale serve`.

## Behaviour

- Sessions: default (`~/.config/herdr/herdr.sock`) + `~/.config/herdr/sessions/<name>/herdr.sock`, rescanned every 10 s. Pane id is `<session>/<pane_id>`.
- One persistent `events.subscribe` per session (re-created when the pane set changes, since `pane.agent_status_changed` needs a `pane_id`); events debounce 300 ms into `session.snapshot` + `agent.list`; `panes` is pushed only when the list changed. Failures and `events_lost` resubscribe with backoff and re-snapshot.
- Chat source: the agent's own transcript if found, else cleaned screen text (`pane.read recent_unwrapped`, polled 1 s). Transcript read errors fall back to screen. Transcripts are tailed by byte offset (loaded in 4 MB slices that yield to the event loop; bulky bookkeeping records are skipped without parsing).
  - **Claude:** `~/.claude/projects/*/<session>.jsonl`.
  - **Codex:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<session>.jsonl`, found by globbing newest day directories first (cached; misses are retried after 5 s). Entry ids are `c<line number>` (stable, the file is append-only).
    - Shown: user and assistant messages (injected context such as AGENTS.md / `<environment_context>` / host notices is hidden), tool calls as one-liners, `turn_aborted` as `Interrupted`.
    - Tool calls: `exec` (the JS tool Codex uses now) is summarised by the first `cmd:` it passes to `exec_command` (`Bash: <cmd> (+N)`), by the files of an embedded patch (`apply_patch: a.ts, b.ts`), or by the first `tools.<name>` it calls; `exec_command`/`shell` give `Bash: <cmd>`; raw `apply_patch` custom calls list the files.
    - Results: ✓/✗ plus a short first line, from `Script failed`, `Process exited with code N`, `exit_code`. A long-running `exec` stays unmarked until the `wait` for its cell completes.
    - Hidden: reasoning, developer messages, and polling calls (`wait`, `wait_agent`, `list_agents`, `sleep`, empty `write_stdin`).
    - `request_user_input` and `request_user_input_async` appear as questions with numbered choices. The glasses action menu sends picker keys for synchronous questions. Asynchronous questions have no terminal picker, so selecting a choice sends its label as a user message to Codex.
  - **Cursor:** `~/.cursor/projects/<cwd with / replaced by ->/agent-transcripts/<session>/<session>.jsonl`. Shows user text, assistant text, and tool calls.
  - **Pi:** `~/.pi/agent/sessions/<encoded cwd>/<timestamp>_<session>.jsonl`. Shows user text, assistant text, and tool calls; thinking blocks stay hidden.
  - **OpenCode:** `~/.local/share/opencode/opencode.db`, opened read-only and polled while its pane is open. Shows user text, assistant text, and tool calls.
  - When Herdr has no session id, the bridge matches a recent transcript to the pane's cwd. Multiple panes of the same agent in one cwd stay in screen mode until the match is unambiguous. Cursor, Pi, and OpenCode subagent lists are not yet available.
- **Subagents** (`src/subagents.ts`): discovered per pane for panes with a transcript, cached ~3 s, listed oldest first.
  - **Claude:** `<project>/<session>/subagents/agent-<id>.jsonl` + `.meta.json` (`agentType` -> label, `description`). The parent's `Agent`/`Task` tool_use becomes a `subagent` entry (`general-purpose · Build bridge`), linked to the subagent by `toolUseId`. A subagent's own file (all records are sidechain) is read by the same Claude model.
    - Status: `meta.finished === true` -> `done`. Else `working` if the file was written in the last 60 s; else, if the parent has no `tool_result` for `toolUseId` yet, `working` (up to 15 min of silence, then `unknown`); else `done`. Caveat: a background agent's `tool_result` is only the launch ack, so for those the 60 s recency rule decides and a long silent think can flip to `done` until it writes again.
    - The parent's tool_results are collected by an incremental, cached scan (`"tool_use_id"` on `tool_result` lines), only when some subagent is unfinished.
  - **Codex:** child rollouts have `session_meta.payload.parent_thread_id` = the pane's session and `source.subagent.thread_spawn` (other subagent sources, e.g. approval reviewers, are ignored). Only day directories from the parent's day onwards are indexed; each rollout's first line is read once and cached by path. Label is `agent_nickname`, description the humanized `agent_path` (the spawn message is encrypted).
    - Linking: the parent's `spawn_agent` call has `task_name`; its `function_call_output` is `{task_name:"/root/<task>"}`, which equals the child's `agent_path`. Entries read `Erdos · browser integrity` once linked (until then just the task name).
    - Status from the last turn event near the end of the child rollout (cached by mtime/size): `task_complete` or `turn_aborted` -> `done`; `task_started` -> `working` (up to 10 min of silence, then `unknown`); no events -> `working` if written in the last 60 s else `unknown`. A follow-up task starts a new turn and flips it back to `working`.
    - Subagent rollouts forked from their parent (`forked_from_id`) begin with a copy of the parent history; the view drops everything before the first inter-agent task message and shows `Task from root: <task>`.
  - `PaneSummary.subagents` = number `working`, recounted every 7 s for all transcript panes; `panes` is pushed only when a count changes.
  - `open` with `subagent` streams that subagent's transcript (read-only, `keys`/`text` still target the pane); unknown id -> `unknown_subagent`. All `chat*` messages of that view carry `subagent`. `subagents` follows `chat` on every open and is re-sent when the list or a status changes while a view is open (re-read every ~3 s, and immediately when a spawn entry appears).
- **Queued messages** (`src/queue.ts`): `text` with `queue:true` holds the text (`enter` ignored) and replies `ok`; `unqueue {pane,item}` removes it (`unknown_item` if unknown, delivered, or being sent). Max 20 items per pane, 4000 chars each (`bad_request` beyond). Queues for panes with an agent session id are saved to a private `queue.json` in the bridge config directory and restored after a bridge restart. A restored queue is discarded if the pane now belongs to a different agent session.
  - Delivery is text, ~150 ms, `enter` (same path as `text`+`enter`). The oldest item goes out when the pane's status is `idle`/`done`; never while `working`/`blocked`. Non-agent panes (`unknown`) deliver immediately. The bridge refreshes the pane's status right before accepting a queued item, so an idle pane gets it at once.
  - For Codex, the bridge also reads the latest turn marker from its rollout. A `task_complete` or `turn_aborted` marker releases a queue when Herdr still reports `working` after the turn ends.
  - One item per idle period: after a delivery the next waits until the agent was seen `working` (or `blocked`) and is idle/done again, or until ~20 s have passed since the delivery (agent ignored it). Status comes from the existing session model (events + snapshot refresh, `queue.evaluateAll()` on every refresh); a 1 s timer runs only while a queue is non-empty, to cover the fallback, retries and vanished panes. Limitation: a working period shorter than the ~300 ms event debounce can be missed, in which case the fallback applies.
  - Send failures keep the item and retry on the next evaluation (about 1 s), 3 attempts, then it is dropped (logged). A pane missing for 3 s (gone, or its session's snapshot failing) drops its queue (logged).
  - `queue {pane, items}` goes to clients whose open view (main or subagent) is that pane: after `chat` on `open`, and on every change, including an empty list.
- While a pane is `blocked`, `prompt` carries the bottom 15 non-empty lines of the visible screen.
- Herdr calls are restricted to an allowlist in `src/herdr.ts` (read methods + `pane.send_keys`/`pane.send_text`). Nothing can create/close/split/focus/rename a pane.
- Plugin `log` messages append to `~/.config/herdr-even/plugin-log.jsonl` (rotates at ~2.5 MB, keeps one `.1`, so about 5 MB total).

## Test

```sh
bun test            # unit + integration (fake Herdr socket, synthetic transcripts)
bunx tsc --noEmit
bun scripts/smoke.ts --port 8799          # read-only against live sessions (bridge running in dev mode)
bun scripts/smoke.ts --port 8799 --input  # drives ONLY the throwaway session herdr-even-test:
                                          #   herdr --session herdr-even-test server   (start first)
                                          #   herdr --session herdr-even-test server stop   (after)
```
