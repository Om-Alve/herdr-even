// Bridge ⇄ plugin wire protocol for herdr-even (milestone 1).
// Transport: one WebSocket per machine at `wss://<machine>.<tailnet>.ts.net/ws` (via `tailscale serve`).
// Framing: one JSON object per WebSocket text message. Requests carry `id`; their reply echoes it.
// Product context: /spec.md.

export const PROTOCOL_VERSION = 2

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface PaneSummary {
  /** Unique on this machine: `${session}/${paneId}`, e.g. "default/w1:p1". Use this everywhere in the protocol. */
  id: string
  /** Herdr session name; "default" for `~/.config/herdr/herdr.sock`. */
  session: string
  /** Herdr pane id within its session, e.g. "w1:p1". */
  paneId: string
  workspace: string
  tab: string
  /** "claude" | "codex" | "cursor" | "opencode" | … ; null when no agent is detected. */
  agent: string | null
  /** 'unknown' for non-agent panes. */
  status: AgentStatus
  /** Terminal title, ANSI-free. */
  title: string
  /** Which source the chat view uses for this pane. */
  chat: 'transcript' | 'screen'
  /** Number of subagents currently working (0 when none, or when the agent has no transcript adapter). */
  subagents: number
  /** Herdr `state_change_seq`; lets the plugin track "done but not yet seen". */
  stateSeq: number
}

export type ChatEntryKind = 'user' | 'assistant' | 'tool' | 'subagent' | 'system' | 'screen' | 'question'

interface EntryBase {
  /** Stable within one pane's chat (transcript record uuid, or "screen" for the screen fallback). */
  id: string
  /** Plain text, no ANSI, may contain newlines. The bridge does NOT map glyphs; the plugin does. */
  text: string
  /** Epoch ms, when known. */
  ts?: number
  /** For kind 'subagent': the SubagentSummary id this entry refers to, when it could be resolved. */
  subagent?: string
}

export type ChatEntry =
  | (EntryBase & { kind: Exclude<ChatEntryKind, 'question'> })
  | (EntryBase & { kind: 'question'; questions: { prompt: string; options: string[] }[]; answered: boolean; reply: 'message' | 'keys' })

export interface SubagentSummary {
  /** Stable within its pane: Claude `agentId`, Codex thread id. */
  id: string
  /** Claude `agentType` (e.g. "general-purpose") or Codex `agent_nickname` (e.g. "Erdos"). */
  label: string
  /** What it was asked to do (Claude `description`, Codex `agent_path` / spawn message), short. */
  description: string
  status: 'working' | 'done' | 'unknown'
  /** Epoch ms of its last transcript activity. */
  lastActivity?: number
}

export interface QueuedItem {
  /** Unique within the bridge. */
  id: string
  text: string
  /** Epoch ms when it was queued. */
  ts: number
}

export interface Snippet {
  label: string
  /** Key combos sent via Herdr `pane.send_keys`, e.g. ["ctrl+c"]. */
  keys?: string[]
  /** Literal text sent via Herdr `pane.send_text`. */
  text?: string
  /** With `text`: also press enter afterwards (sent separately, ~150 ms later). */
  enter?: boolean
}

// ---------------------------------------------------------------- server → client

export type ServerMsg =
  | {
      t: 'hello'
      protocol: number
      /** Short machine label (hostname without domain), e.g. "oms-macbook-pro". */
      machine: string
      herdrVersion: string | null
      /** Tailscale login of the connected user. */
      user: string | null
      snippets: Snippet[]
    }
  /** Full pane list. Sent after hello and whenever anything in it changes (debounced). */
  | { t: 'panes'; panes: PaneSummary[] }
  /**
   * Latest window of a pane's chat. Sent in reply to `open` and whenever the bridge has to resync; replaces
   * everything the client holds for that pane. `subagent` is set when the open view is one of the pane's subagents
   * (on every chat.* message below too), so a client can drop messages for a view it already left.
   */
  | { t: 'chat'; id?: string; pane: string; subagent?: string; source: 'transcript' | 'screen'; entries: ChatEntry[]; hasOlder: boolean }
  /** New entries at the bottom of the open chat. */
  | { t: 'chat.append'; pane: string; subagent?: string; entries: ChatEntry[] }
  /** Replace entries with the same ids (screen text changed, a tool result arrived, …). */
  | { t: 'chat.update'; pane: string; subagent?: string; entries: ChatEntry[] }
  /** Reply to `older`: entries strictly older than `before`, oldest first. */
  | { t: 'chat.older'; id: string; pane: string; subagent?: string; entries: ChatEntry[]; hasOlder: boolean }
  /** The open pane's queued messages, oldest first (delivered in that order). Sent after `chat` on open and whenever that queue changes. */
  | { t: 'queue'; pane: string; items: QueuedItem[] }
  /** The open pane's subagents, oldest first. Sent after `chat` on open (main view or a subagent view) and whenever the list or a status changes. Empty for agents without an adapter. */
  | { t: 'subagents'; pane: string; subagents: SubagentSummary[] }
  /** While the open pane is blocked: the cleaned bottom of its live screen (the permission dialog). `null` clears it. */
  | { t: 'prompt'; pane: string; text: string | null }
  | { t: 'pong'; id: string }
  | { t: 'ok'; id: string }
  | { t: 'error'; id?: string; code: ErrorCode; message: string }

export type ErrorCode =
  | 'bad_request'
  | 'unknown_pane'
  | 'unknown_subagent'
  | 'unknown_item'
  | 'key_not_allowed'
  | 'herdr_unavailable'
  | 'herdr_error'
  | 'internal'

// ---------------------------------------------------------------- client → server

export type ClientMsg =
  /**
   * Subscribe to one pane's chat, or with `subagent` to one of its subagents' transcripts (read-only); replaces any
   * previous subscription on this connection. Reply: `chat` (+ `prompt` if the pane is blocked, + `subagents`).
   */
  | { t: 'open'; id: string; pane: string; subagent?: string }
  /** Unsubscribe from the open pane. Reply: `ok`. */
  | { t: 'close'; id: string }
  /** Page of entries older than entry id `before` (default limit 50) in the open view. Reply: `chat.older`. */
  | { t: 'older'; id: string; pane: string; subagent?: string; before: string; limit?: number }
  /** Send key combos to a pane. Every key must match KEY_RE. Reply: `ok` or `error`. */
  | { t: 'keys'; id: string; pane: string; keys: string[] }
  /**
   * Send literal text; with enter=true the bridge waits ~150 ms then sends `enter` (so agents don't treat it as a paste). Reply: `ok`.
   * With queue=true the bridge instead holds the text and submits it (text + enter) once the pane's agent is no longer
   * working (status idle or done; never while blocked), immediately if it already is. `enter` is ignored when queueing.
   */
  | { t: 'text'; id: string; pane: string; text: string; enter: boolean; queue?: boolean }
  /** Remove a queued item before it's delivered. Reply: `ok`, or `error unknown_item` if it was already delivered or never existed. */
  | { t: 'unqueue'; id: string; pane: string; item: string }
  | { t: 'ping'; id: string }
  /** Diagnostics from the device. No reply. The bridge appends it (with a server timestamp) to `~/.config/herdr-even/plugin-log.jsonl`, capped at ~5 MB. */
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }

/** Key combos the bridge accepts for `keys` (Herdr `pane.send_keys` syntax). */
export const KEY_RE =
  /^(?:(?:ctrl|alt|shift)\+)*(?:enter|esc|tab|backspace|delete|space|up|down|left|right|home|end|pageup|pagedown|minus|f(?:[1-9]|1[0-2])|[a-z0-9])$/

export const isAllowedKey = (k: string): boolean => KEY_RE.test(k)

// ---------------------------------------------------------------- HTTP

/**
 * GET /health → { ok: true, protocol: PROTOCOL_VERSION, machine: string }   (no auth, no pane data)
 * GET /ws     → WebSocket upgrade. Rejected with 403 unless the `Tailscale-User-Login` header equals the
 *               configured owner (see bridge config). All other paths → 404.
 * CORS: `Access-Control-Allow-Origin: *` on HTTP responses; OPTIONS → 204.
 */
export type Health = { ok: true; protocol: number; machine: string }
