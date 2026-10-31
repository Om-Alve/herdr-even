import type { ClientMsg, PaneSummary, ServerMsg, Snippet } from '@herdr-even/protocol'

export type ConnStatus = 'connecting' | 'open' | 'closed'

type ReqMsg = Exclude<ClientMsg, { t: 'log' }>
type Body<U> = U extends unknown ? Omit<U, 'id'> : never
export type RequestBody = Body<ReqMsg>
type Reply = Extract<ServerMsg, { t: 'ok' | 'error' | 'chat' | 'chat.older' | 'pong' }>

export interface ConnEvents {
  onStatus(c: Conn): void
  onMsg(c: Conn, m: ServerMsg): void
  /** Fired after every (re)connect once `hello` arrived. */
  onReady(c: Conn, reconnect: boolean): void
}

/** One machine: a WebSocket with reconnect + backoff, request/reply by id, and a liveness probe. */
export class Conn {
  status: ConnStatus = 'connecting'
  machine: string
  herdrVersion: string | null = null
  snippets: Snippet[] = []
  panes: PaneSummary[] = []
  gotPanes = false
  /** Previous statuses by pane id, for transition detection (null until the first `panes`). */
  prevStatus: Map<string, string> | null = null
  lastError = ''
  lastMsgAt = 0
  opens = 0
  attempts = 0
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  private nextId = 1
  private pending = new Map<string, { resolve: (r: Reply | null) => void; timer: ReturnType<typeof setTimeout> }>()
  private everOpen = false
  readonly url: string

  constructor(readonly origin: string, private ev: ConnEvents) {
    this.machine = origin.replace(/^https?:\/\//, '').split('.')[0].split(':')[0]
    this.url = origin.replace(/^http/, 'ws') + '/ws'
  }

  start() { this.connect() }

  private connect() {
    clearTimeout(this.timer)
    this.setStatus('connecting')
    let ws: WebSocket
    try { ws = new WebSocket(this.url) } catch (e) { this.lastError = String(e); this.scheduleRetry(); return }
    this.ws = ws
    ws.onmessage = e => {
      this.lastMsgAt = Date.now()
      let m: ServerMsg
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.t === 'hello') {
        this.machine = m.machine || this.machine
        this.herdrVersion = m.herdrVersion
        this.snippets = m.snippets ?? []
        const re = this.everOpen
        this.everOpen = true
        this.attempts = 0
        this.opens++
        this.setStatus('open')
        this.ev.onReady(this, re)
        return
      }
      if ('id' in m && m.id && this.pending.has(m.id) && ['ok', 'error', 'chat', 'chat.older', 'pong'].includes(m.t)) {
        const p = this.pending.get(m.id)!
        clearTimeout(p.timer)
        this.pending.delete(m.id)
        p.resolve(m as Reply)
      }
      this.ev.onMsg(this, m)
    }
    ws.onerror = () => { this.lastError = 'socket error' }
    ws.onclose = e => {
      if (this.ws !== ws) return
      this.lastError = this.lastError || `closed ${e.code}`
      this.dropped()
    }
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (this.status !== 'open') return
      if (Date.now() - this.lastMsgAt > 45000) { this.lastError = 'ping timeout'; this.forceReconnect(); return }
      this.send({ t: 'ping', id: this.id() })
    }, 20000)
  }

  private dropped() {
    this.ws = null
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null) }
    this.pending.clear()
    this.gotPanes = false
    this.prevStatus = null // after a reconnect the first `panes` must not raise alerts
    this.setStatus('closed')
    this.scheduleRetry()
  }

  private scheduleRetry() {
    clearTimeout(this.timer)
    const delay = Math.min(15000, 1000 * 1.6 ** this.attempts) * (0.8 + Math.random() * 0.4)
    this.attempts++
    this.timer = setTimeout(() => this.connect(), delay)
  }

  /** Tear down and reconnect right now. */
  forceReconnect() {
    const ws = this.ws
    this.ws = null
    try { ws?.close() } catch { /* */ }
    this.attempts = 0
    this.dropped()
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), 50)
  }

  /** After a resume: ping; if nothing comes back soon, the socket is dead -> reconnect. */
  probe(ms = 3000) {
    if (this.status !== 'open') { this.attempts = 0; clearTimeout(this.timer); this.connect(); return }
    const before = this.lastMsgAt
    clearTimeout(this.probeTimer)
    this.send({ t: 'ping', id: this.id() })
    this.probeTimer = setTimeout(() => { if (this.lastMsgAt === before) { this.lastError = 'probe timeout'; this.forceReconnect() } }, ms)
  }

  private setStatus(s: ConnStatus) { if (this.status !== s || s === 'connecting') { this.status = s; this.ev.onStatus(this) } }
  id() { return `r${this.nextId++}` }

  send(m: ClientMsg): boolean {
    if (this.status !== 'open' || !this.ws) return false
    try { this.ws.send(JSON.stringify(m)); return true } catch { return false }
  }

  /** Send a request carrying an id and wait for its reply (null on timeout / disconnect). */
  request(m: RequestBody, timeoutMs = 8000): Promise<Reply | null> {
    const id = this.id()
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null) }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      if (!this.send({ ...m, id } as ClientMsg)) { clearTimeout(timer); this.pending.delete(id); resolve(null) }
    })
  }
}
