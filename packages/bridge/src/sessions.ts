import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, PaneSummary } from '@herdr-even/protocol'
import type { Config } from './config.ts'
import { HerdrClient } from './herdr.ts'
import { locateTranscript } from './claude.ts'
import { codexTurnState, locateRollout } from './codex.ts'
import { locateCursor, locatePi } from './other-locate.ts'
import { locateOpenCode } from './opencode.ts'
import { MessageQueue } from './queue.ts'
import { SubagentIndex } from './subagents.ts'
import { TranscriptLocator, hasTranscriptAdapter, pickFallbacks, type FallbackPane } from './locate.ts'

const STATUSES = new Set(['idle', 'working', 'blocked', 'done'])
const DEBOUNCE_MS = 300
const SUB_REFRESH_MS = 7_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface PaneInfo {
  summary: PaneSummary
  client: HerdrClient
  /** Agent transcript file or OpenCode database path when found. */
  transcript: string | null
  /** The agent's own session id (from Herdr's `agent_session`), when reported. */
  sessionId: string | null
  subagents: SubagentIndex
}

/** A mapped pane plus what the fallback transcript lookup needs. */
export interface RawPane {
  summary: PaneSummary
  transcript: string | null
  sessionId: string | null
  /** Pane cwd from Herdr, when known. */
  cwd: string | null
  /** Herdr reported an `agent_session` id for this pane (as opposed to us inferring the transcript from cwd). */
  reported: boolean
}

/** Pure mapping: snapshot + agent.list -> summaries (+ transcript hints). Exported for tests. */
export function mapPanes(
  session: string,
  snapshot: any,
  agents: any[],
  findTranscript: (agent: string, agentSessionId: string) => string | null,
): RawPane[] {
  const ws = new Map<string, string>((snapshot.workspaces ?? []).map((w: any) => [w.workspace_id, w.label ?? w.workspace_id]))
  const tabs = new Map<string, string>((snapshot.tabs ?? []).map((t: any) => [t.tab_id, t.label ?? t.tab_id]))
  const ag = new Map<string, any>()
  for (const a of agents ?? []) if (a?.pane_id) ag.set(a.pane_id, a)
  const out: RawPane[] = []
  for (const p of snapshot.panes ?? []) {
    const a = ag.get(p.pane_id)
    const agent: string | null = p.agent ?? a?.agent ?? null
    const rawStatus = a?.agent_status ?? p.agent_status
    const status: AgentStatus = agent && STATUSES.has(rawStatus) ? rawStatus : 'unknown'
    const sess = a?.agent_session ?? p.agent_session
    let transcript: string | null = null
    const sessionId = sess && sess.kind === 'id' && typeof sess.value === 'string' ? (sess.value as string) : null
    if (hasTranscriptAdapter(agent) && sessionId) transcript = findTranscript(agent, sessionId)
    const cwd = typeof (a?.cwd ?? p.cwd) === 'string' ? ((a?.cwd ?? p.cwd) as string) : null
    out.push({
      transcript,
      sessionId,
      cwd,
      reported: !!sessionId,
      summary: {
        id: `${session}/${p.pane_id}`,
        session,
        paneId: p.pane_id,
        workspace: ws.get(p.workspace_id) ?? p.workspace_id ?? '',
        tab: tabs.get(p.tab_id) ?? p.tab_id ?? '',
        agent,
        status,
        title: a?.terminal_title_stripped ?? p.terminal_title_stripped ?? p.terminal_title ?? '',
        chat: transcript ? 'transcript' : 'screen',
        subagents: 0,
        stateSeq: typeof a?.state_change_seq === 'number' ? a.state_change_seq : 0,
      },
    })
  }
  return out
}

class SessionWatch {
  panes: RawPane[] = []
  private sub: { close: () => void } | null = null
  private subscribedKey = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private backoff = 500
  private refreshing = false
  private dirty = false
  private stopped = false
  version: string | null = null

  constructor(
    public name: string,
    public client: HerdrClient,
    private findTranscript: (agent: string, id: string) => string | null,
    private resolve: (watch: string, panes: RawPane[]) => Promise<void>,
    private onChange: () => void,
  ) {}

  start() {
    this.connect()
    this.schedule(0)
  }

  stop() {
    this.stopped = true
    this.sub?.close()
    if (this.timer) clearTimeout(this.timer)
    if (this.retry) clearTimeout(this.retry)
  }

  private subs(): { type: string; pane_id?: string }[] {
    const s: { type: string; pane_id?: string }[] = [
      'workspace.created', 'workspace.closed', 'workspace.renamed', 'workspace.updated',
      'tab.created', 'tab.closed', 'tab.renamed', 'pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.agent_detected',
    ].map((type) => ({ type }))
    for (const p of this.panes) if (p.summary.agent) s.push({ type: 'pane.agent_status_changed', pane_id: p.summary.paneId })
    return s
  }

  private connect() {
    if (this.stopped || this.sub) return
    const subs = this.subs()
    this.subscribedKey = subs.map((x) => x.pane_id ?? '').join('|')
    this.sub = this.client.subscribe(subs, {
      onStarted: () => {
        this.backoff = 500
        this.schedule(0) // re-snapshot after (re)subscribing
      },
      onEvent: () => this.schedule(DEBOUNCE_MS),
      onEnd: () => {
        this.sub = null
        if (this.stopped) return
        this.retry = setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 10_000)
      },
    })
  }

  schedule(ms: number) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), ms)
  }

  async refresh() {
    if (this.refreshing) {
      this.dirty = true
      return
    }
    this.refreshing = true
    try {
      const [snap, agents] = await Promise.all([this.client.call('session.snapshot'), this.client.call('agent.list').catch(() => ({ agents: [] }))])
      const mapped = mapPanes(this.name, snap.snapshot ?? {}, agents.agents ?? [], this.findTranscript)
      await this.resolve(this.name, mapped).catch(() => {}) // fail soft: screen mode
      this.panes = mapped
      if (snap.snapshot?.version) this.version = String(snap.snapshot.version)
      // pane set changed: per-pane status subscriptions must be rebuilt
      const key = this.subs().map((x) => x.pane_id ?? '').join('|')
      if (this.sub && key !== this.subscribedKey) {
        this.sub.close()
        this.sub = null
        this.connect()
      }
    } catch {
      this.panes = []
    } finally {
      this.refreshing = false
      this.onChange()
      if (this.dirty) {
        this.dirty = false
        this.schedule(DEBOUNCE_MS)
      }
    }
  }
}

export class SessionManager {
  private watches = new Map<string, SessionWatch>()
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(panes: PaneSummary[]) => void>()
  private lastJson = '[]'
  private tcache = new Map<string, string>()
  /** Negative lookups, so a session without a transcript yet doesn't trigger a directory scan on every refresh. */
  private missing = new Map<string, number>()
  private subCounts = new Map<string, number>()
  private subTimer: ReturnType<typeof setInterval> | null = null
  private subBusy = false
  readonly subagents: SubagentIndex
  private locator: TranscriptLocator
  /** Last logged fallback state per `agent:cwd`, so each change is logged once. */
  private fallbackLog = new Map<string, string>()
  /** Messages held until their pane's agent stops working. Re-evaluated on every pane-list refresh. */
  readonly queue: MessageQueue
  herdrVersion: string | null = null

  constructor(private cfg: Pick<Config, 'configDir' | 'herdrDir' | 'claudeDir' | 'codexDir' | 'cursorDir' | 'openCodeDb' | 'piDir'>) {
    this.subagents = new SubagentIndex({ codexDir: cfg.codexDir })
    this.locator = new TranscriptLocator(cfg, this.subagents)
    this.queue = new MessageQueue({
      file: join(cfg.configDir, 'queue.json'),
      identity: (id) => {
        const info = this.get(id)
        return info?.summary.agent && info.sessionId ? `${info.summary.agent}:${info.sessionId}` : null
      },
      status: (id) => {
        const info = this.get(id)
        const s = info?.summary
        if (!s) return null
        if (s.agent === 'codex' && s.status === 'working' && info.transcript && codexTurnState(info.transcript) === 'done') return 'done'
        // An agent Herdr can't classify right now may be mid-turn or showing a permission prompt: hold, never type
        // into it. Only panes without an agent deliver on 'unknown'.
        return s.agent && s.status === 'unknown' ? 'blocked' : s.status
      },
      deliver: (id, text) => this.sendText(id, text, true),
      log: (m) => console.log(m),
    })
  }

  /** Type text into a pane; with `enter`, press enter ~150 ms later (so agents don't treat it as a paste). */
  async sendText(id: string, text: string, enter: boolean) {
    const info = this.get(id)
    if (!info) throw new Error(`unknown pane: ${id}`)
    await info.client.call('pane.send_text', { pane_id: info.summary.paneId, text })
    if (enter) {
      await sleep(150)
      await info.client.call('pane.send_keys', { pane_id: info.summary.paneId, keys: ['enter'] })
    }
    this.nudge(id)
  }

  private findTranscript = (agent: string, id: string): string | null => {
    const key = `${agent}:${id}`
    const hit = this.tcache.get(key)
    if (hit && existsSync(hit)) return hit
    this.tcache.delete(key)
    const miss = this.missing.get(key)
    if (miss && Date.now() - miss < 5_000) return null
    const p = agent === 'codex' ? locateRollout(this.cfg.codexDir, id)
      : agent === 'claude' ? locateTranscript(this.cfg.claudeDir, id)
      : agent === 'cursor' ? locateCursor(this.cfg.cursorDir, id)
      : agent === 'opencode' ? locateOpenCode(this.cfg.openCodeDb, id)
      : agent === 'pi' ? locatePi(this.cfg.piDir, id)
      : null
    if (p) {
      this.tcache.set(key, p)
      this.missing.delete(key)
    } else this.missing.set(key, Date.now())
    return p
  }

  /**
   * Agent panes without a reported session id: find their transcript by cwd + recency. Mutates `mine`.
   * Panes of other Herdr sessions on this machine count for claims and ambiguity.
   */
  private resolveFallbacks = async (watch: string, mine: RawPane[]) => {
    const all: (FallbackPane & { key: string; pane: RawPane })[] = []
    for (const [n, w] of this.watches) if (n !== watch) for (const p of w.panes) all.push({ key: p.summary.id, paneId: p.summary.paneId, agent: p.summary.agent, cwd: p.cwd, reported: p.reported, transcript: p.transcript, sessionId: p.sessionId, pane: p })
    for (const p of mine) all.push({ key: p.summary.id, paneId: p.summary.paneId, agent: p.summary.agent, cwd: p.cwd, reported: p.reported, transcript: p.transcript, sessionId: p.sessionId, pane: p })
    const candidates = new Map<string, Awaited<ReturnType<TranscriptLocator['candidates']>>>()
    for (const p of all) {
      if (!hasTranscriptAdapter(p.agent) || p.reported || !p.cwd) continue
      const g = `${p.agent}:${p.cwd}`
      if (!candidates.has(g)) candidates.set(g, await this.locator.candidates(p.agent, p.cwd))
    }
    const { picks, ambiguous } = pickFallbacks(all, candidates)
    const mineKeys = new Set(mine.map((p) => p.summary.id))
    for (const [g, keys] of ambiguous) {
      const state = `ambiguous ${keys.sort().join(',')}`
      if (keys.some((k) => mineKeys.has(k)) && this.fallbackLog.get(g) !== state) {
        this.fallbackLog.set(g, state)
        console.log(`[transcript] ${g}: ${keys.length} panes without a session id share this cwd (${keys.join(', ')}); using screen mode`)
      }
    }
    for (const p of mine) {
      const c = picks.get(p.summary.id)
      if (!c) continue
      p.transcript = c.path
      p.sessionId = c.id
      p.summary = { ...p.summary, chat: 'transcript' }
      const g = `${p.summary.agent}:${p.cwd}`
      const state = `pick ${p.summary.id} ${c.path}`
      if (this.fallbackLog.get(g) !== state) {
        this.fallbackLog.set(g, state)
        console.log(`[transcript] ${p.summary.id} (${g}) has no session id; matched ${c.path} by cwd`)
      }
    }
  }

  start() {
    this.scan()
    this.scanTimer = setInterval(() => this.scan(), 10_000)
    setTimeout(() => void this.refreshSubCounts(), 1500)
    this.subTimer = setInterval(() => void this.refreshSubCounts(), SUB_REFRESH_MS)
  }

  /** Recount working subagents for every pane with a transcript; pushes `panes` only if a count changed. */
  async refreshSubCounts() {
    if (this.subBusy) return
    this.subBusy = true
    try {
      const next = new Map<string, number>()
      for (const w of [...this.watches.values()]) {
        for (const p of [...w.panes]) {
          if (!p.transcript || !p.sessionId) continue
          try {
            const list = await this.subagents.list(p.summary.agent, p.sessionId, p.transcript)
            const n = list.filter((s) => s.status === 'working').length
            if (n) next.set(p.summary.id, n)
          } catch {}
        }
      }
      const same = next.size === this.subCounts.size && [...next].every(([k, v]) => this.subCounts.get(k) === v)
      this.subCounts = next
      if (!same) this.changed()
    } finally {
      this.subBusy = false
    }
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.subTimer) clearInterval(this.subTimer)
    this.queue.stop()
    for (const w of this.watches.values()) w.stop()
    this.watches.clear()
  }

  /** Session name -> socket path for everything currently on disk. */
  discover(): Map<string, string> {
    const found = new Map<string, string>()
    const def = join(this.cfg.herdrDir, 'herdr.sock')
    if (existsSync(def)) found.set('default', def)
    const dir = join(this.cfg.herdrDir, 'sessions')
    try {
      for (const n of readdirSync(dir)) {
        const sock = join(dir, n, 'herdr.sock')
        if (existsSync(sock)) found.set(n, sock)
      }
    } catch {}
    return found
  }

  scan() {
    const found = this.discover()
    for (const [name, path] of found) {
      const cur = this.watches.get(name)
      if (cur && cur.client.socketPath === path) {
        cur.schedule(0) // periodic safety re-snapshot
        continue
      }
      cur?.stop()
      const w = new SessionWatch(name, new HerdrClient(path), this.findTranscript, this.resolveFallbacks, () => this.changed())
      this.watches.set(name, w)
      w.start()
    }
    let removed = false
    for (const name of [...this.watches.keys()]) {
      if (!found.has(name)) {
        this.watches.get(name)!.stop()
        this.watches.delete(name)
        removed = true
      }
    }
    if (removed) this.changed()
  }

  private changed() {
    this.queue.evaluateAll()
    for (const w of this.watches.values()) if (w.version) this.herdrVersion ??= w.version
    const panes = this.panes()
    const j = JSON.stringify(panes)
    if (j === this.lastJson) return
    this.lastJson = j
    for (const l of this.listeners) {
      try {
        l(panes)
      } catch {}
    }
  }

  onPanes(cb: (panes: PaneSummary[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  panes(): PaneSummary[] {
    const names = [...this.watches.keys()].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
    return names.flatMap((n) => this.watches.get(n)!.panes.map((p) => this.withSubs(p.summary)))
  }

  private withSubs(s: PaneSummary): PaneSummary {
    const n = this.subCounts.get(s.id) ?? 0
    return n === s.subagents ? s : { ...s, subagents: n }
  }

  get(id: string): PaneInfo | null {
    const at = id.lastIndexOf('/')
    if (at <= 0) return null
    const w = this.watches.get(id.slice(0, at))
    const p = w?.panes.find((x) => x.summary.id === id)
    return w && p ? { summary: this.withSubs(p.summary), client: w.client, transcript: p.transcript, sessionId: p.sessionId, subagents: this.subagents } : null
  }

  /** Re-snapshot the pane's session now and wait for it (fresh status before a delivery decision). */
  async refreshNow(id: string) {
    const at = id.lastIndexOf('/')
    await this.watches.get(id.slice(0, at))?.refresh()
  }

  /** Force a re-snapshot (e.g. right after sending input). */
  nudge(id: string) {
    const at = id.lastIndexOf('/')
    this.watches.get(id.slice(0, at))?.schedule(DEBOUNCE_MS)
  }
}
