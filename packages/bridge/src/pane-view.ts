import type { ChatEntry, ServerMsg } from '@herdr-even/protocol'
import { ClaudeTranscript } from './claude.ts'
import { cleanScreen, promptTail } from './clean.ts'
import { CodexTranscript } from './codex.ts'
import { SimpleTranscript } from './simple.ts'
import { OpenCodeTail } from './opencode.ts'
import { toSummary, type ChatModel, type Delta, type SubagentInfo } from './model.ts'
import { TranscriptTail } from './tail.ts'
import type { PaneInfo } from './sessions.ts'

const WINDOW = 40
const TICK_MS = 1000
/** Re-read the subagent list every this many ticks while a view is open (the index itself caches ~3 s). */
const SUB_TICKS = 3

type Send = (m: ServerMsg) => void

/**
 * One client's open pane: transcript tail or screen polling, plus the blocked prompt and the pane's subagent list.
 * With `sub` it shows that subagent's transcript instead (read-only; no screen fallback, the pane screen isn't it).
 */
export class PaneView {
  mode: 'transcript' | 'screen' = 'screen'
  private tail: TranscriptTail | OpenCodeTail | null = null
  private failedPath: string | null = null
  private failedAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private disposed = false
  private lastRev: number | null = null
  private lastScreen: string | null = null
  private promptText: string | null = null
  private promptRev: number | null = null
  private promptActive = false
  /** Bumped on every (re)start so stale async work can detect it. */
  private gen = 0

  private subs: SubagentInfo[] = []
  private subsJson = ''
  private ticks = 0
  private subBusy = false

  constructor(public paneId: string, private info: PaneInfo, private send: Send, private sub: SubagentInfo | null = null) {}

  get subagentId(): string | undefined {
    return this.sub?.id
  }

  private makeModel = (): ChatModel => {
    switch (this.info.summary.agent) {
      case 'codex': return new CodexTranscript(!!this.sub)
      case 'cursor': return new SimpleTranscript('cursor')
      case 'pi': return new SimpleTranscript('pi')
      default: return new ClaudeTranscript(!!this.sub)
    }
  }

  private safeSend(m: ServerMsg) {
    if (this.disposed) return
    if (this.sub && (m.t === 'chat' || m.t === 'chat.append' || m.t === 'chat.update' || m.t === 'chat.older')) m = { ...m, subagent: this.sub.id }
    this.send(m)
  }

  /** Re-list the pane's subagents, link spawn entries, and push what changed. `quiet`: just store (initial open). */
  private async refreshSubs(quiet = false, fresh = false) {
    if (this.subBusy) return
    this.subBusy = true
    const gen = this.gen
    try {
      const i = this.info
      const list = await i.subagents.list(i.summary.agent, i.sessionId, i.transcript, fresh)
      if (this.disposed || gen !== this.gen) return
      this.subs = list
      const upd = this.tail?.model.resolveSpawns(list) ?? []
      if (!quiet) {
        if (upd.length) this.safeSend({ t: 'chat.update', pane: this.paneId, entries: upd })
        this.sendSubs()
      }
    } catch {
    } finally {
      this.subBusy = false
    }
  }

  private sendSubs(force = false) {
    const subagents = this.subs.map(toSummary)
    const j = JSON.stringify(subagents)
    if (!force && j === this.subsJson) return
    this.subsJson = j
    this.safeSend({ t: 'subagents', pane: this.paneId, subagents })
  }

  /** Open: reply with `chat` (echoing reqId), then `subagents`, then `prompt` if blocked. */
  async start(reqId?: string) {
    await this.sendWindow(reqId)
    this.sendSubs(true)
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    if (this.info.summary.status === 'blocked') await this.pollPrompt(true)
  }

  dispose() {
    this.disposed = true
    this.gen++
    this.tail?.stop()
    if (this.timer) clearInterval(this.timer)
  }

  private async sendWindow(reqId?: string) {
    const gen = ++this.gen
    this.tail?.stop()
    this.tail = null
    const path = this.sub ? this.sub.path : this.info.transcript
    if (path && path !== this.failedPath) {
      const handlers = {
        onDelta: (d: Delta) => {
          if (this.tail !== t) return
          if (d.appended.length) this.safeSend({ t: 'chat.append', pane: this.paneId, entries: d.appended })
          if (d.updated.length) this.safeSend({ t: 'chat.update', pane: this.paneId, entries: d.updated })
          if (d.appended.some((e) => e.kind === 'subagent')) void this.refreshSubs(false, true)
        },
        onReset: () => {
          if (this.tail !== t) return
          t.model.resolveSpawns(this.subs)
          const w = t.model.tail(WINDOW)
          this.safeSend({ t: 'chat', pane: this.paneId, source: 'transcript', entries: w.entries, hasOlder: w.hasOlder })
        },
        onFail: () => {
          if (this.tail !== t) return
          this.failedPath = path
          this.failedAt = Date.now()
          this.tail = null
          void this.sendWindow()
        },
      }
      const t = this.info.summary.agent === 'opencode' && this.info.sessionId
        ? new OpenCodeTail(path, this.info.sessionId, handlers)
        : new TranscriptTail(path, handlers, this.makeModel)
      try {
        await t.load()
        if (gen !== this.gen || this.disposed) return t.stop()
        this.tail = t
        this.mode = 'transcript'
        this.subBusy = false
        await this.refreshSubs(true, true) // link spawn entries before the first window goes out
        if (gen !== this.gen || this.disposed) return t.stop()
        t.startWatching()
        const w = t.model.tail(WINDOW)
        this.safeSend({ t: 'chat', id: reqId, pane: this.paneId, source: 'transcript', entries: w.entries, hasOlder: w.hasOlder })
        return
      } catch {
        this.failedPath = path
        this.failedAt = Date.now()
      }
    }
    if (this.sub) {
      // a subagent has no screen of its own: say so instead of showing the parent's
      this.mode = 'transcript'
      this.safeSend({ t: 'chat', id: reqId, pane: this.paneId, source: 'transcript', entries: [{ id: 'unavailable', kind: 'system', text: 'Subagent transcript unavailable' }], hasOlder: false })
      return
    }
    // screen fallback
    this.mode = 'screen'
    this.lastRev = null
    this.lastScreen = null
    const text = (await this.readScreen()) ?? ''
    if (gen !== this.gen || this.disposed) return
    this.lastScreen = text
    this.safeSend({ t: 'chat', id: reqId, pane: this.paneId, source: 'screen', entries: [this.screenEntry(text)], hasOlder: false })
  }

  private screenEntry(text: string): ChatEntry {
    return { id: 'screen', kind: 'screen', text }
  }

  /** Returns cleaned text, or null when unchanged (same revision) / unreadable. */
  private async readScreen(): Promise<string | null> {
    try {
      const r = await this.info.client.call('pane.read', {
        pane_id: this.info.summary.paneId,
        source: 'recent_unwrapped',
        format: 'text',
        strip_ansi: true,
        lines: 200,
      })
      const rev = r?.read?.revision
      // Herdr 0.9.5 reports revision 0 for every read, so only trust non-zero revisions.
      if (typeof rev === 'number' && rev > 0 && rev === this.lastRev) return null
      if (typeof rev === 'number') this.lastRev = rev
      return cleanScreen(String(r?.read?.text ?? ''), { agent: !!this.info.summary.agent })
    } catch {
      return null
    }
  }

  private async tick() {
    if (this.busy || this.disposed) return
    this.busy = true
    const gen = this.gen
    try {
      if (++this.ticks % SUB_TICKS === 0) void this.refreshSubs()
      if (this.mode === 'screen') {
        const text = await this.readScreen()
        if (text !== null && text !== this.lastScreen && gen === this.gen && !this.disposed) {
          this.lastScreen = text
          this.safeSend({ t: 'chat.update', pane: this.paneId, entries: [this.screenEntry(text)] })
        }
      }
      if (this.info.summary.status === 'blocked') await this.pollPrompt(false)
    } finally {
      this.busy = false
    }
  }

  private async pollPrompt(force: boolean) {
    try {
      const r = await this.info.client.call('pane.read', {
        pane_id: this.info.summary.paneId,
        source: 'visible',
        format: 'text',
        strip_ansi: true,
      })
      const rev = r?.read?.revision
      if (!force && typeof rev === 'number' && rev > 0 && rev === this.promptRev && this.promptActive) return
      if (typeof rev === 'number') this.promptRev = rev
      const text = promptTail(String(r?.read?.text ?? ''))
      if (this.info.summary.status !== 'blocked') return
      if (force || text !== this.promptText || !this.promptActive) {
        this.promptText = text
        this.promptActive = true
        this.safeSend({ t: 'prompt', pane: this.paneId, text })
      }
    } catch {}
  }

  /** Called whenever the pane list changes. Returns false when the pane vanished. */
  update(info: PaneInfo | null): boolean {
    if (this.disposed) return false
    if (!info) return false
    const prev = this.info
    this.info = info
    const s = info.summary
    if (info.sessionId !== prev.sessionId || Date.now() - this.failedAt > 5_000) this.failedPath = null
    // source flip (agent appeared/disappeared, /clear -> new session file)
    const wantTranscript = !!info.transcript && info.transcript !== this.failedPath
    if (!this.sub && (info.transcript !== prev.transcript || info.sessionId !== prev.sessionId || (wantTranscript && this.mode !== 'transcript') || (!wantTranscript && this.mode === 'transcript'))) {
      void this.sendWindow()
    }
    if (s.status === 'blocked' && prev.summary.status !== 'blocked') {
      this.promptActive = false
      void this.pollPrompt(true)
    } else if (s.status !== 'blocked' && this.promptActive) {
      this.promptActive = false
      this.promptText = null
      this.promptRev = null
      this.safeSend({ t: 'prompt', pane: this.paneId, text: null })
    }
    return true
  }

  older(before: string, limit?: number): { entries: ChatEntry[]; hasOlder: boolean } {
    if (this.mode !== 'transcript' || !this.tail) return { entries: [], hasOlder: false }
    return this.tail.model.older(before, Math.min(Math.max(limit ?? 50, 1), 200)) ?? { entries: [], hasOlder: false }
  }
}
