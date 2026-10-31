// Voice dictation: Deepgram streaming socket (warm + push-to-talk), transcript assembly, keyterms and the phase machine.
// Pure parts (applyResult, buildKeyterms, buildDgUrl, dictStep) are unit-tested; DgStream is the only thing that touches WebSocket.

export const DG_DEFAULT_BASE = 'wss://api.deepgram.com'
export const KEEPALIVE_MS = 5000
export const WARM_IDLE_MS = 120000
export const FINAL_TIMEOUT_MS = 2500
const MAX_BUFFER_BYTES = 960000 // ~30 s of 16 kHz s16le

// ---------------------------------------------------------------- transcript assembly
export interface TranscriptState { finals: string[]; interim: string }
export const newTranscript = (): TranscriptState => ({ finals: [], interim: '' })
export const transcriptText = (t: TranscriptState): string => [...t.finals, t.interim].map(s => s.trim()).filter(Boolean).join(' ')

/** Apply one Deepgram websocket message. Returns what changed; non-`Results` messages are ignored. */
export function applyResult(t: TranscriptState, msg: any): { changed: boolean; fromFinalize: boolean; text: string } {
  if (!msg || msg.type !== 'Results') return { changed: false, fromFinalize: false, text: '' }
  const text: string = String(msg.channel?.alternatives?.[0]?.transcript ?? '').trim()
  const fromFinalize = msg.from_finalize === true
  if (msg.is_final) {
    t.interim = ''
    if (text) t.finals.push(text)
  } else t.interim = text
  return { changed: true, fromFinalize, text }
}

// ---------------------------------------------------------------- keyterms + URL
const GENERIC = new Set(['zsh', 'bash', 'sh', 'fish', 'shell', 'default', 'main', 'pane', 'tab', 'the', 'and', 'new', 'untitled', 'terminal'])
export interface TermSource { workspace?: string; agent?: string | null; title?: string; tab?: string }

/** Distinctive words from the current panes: workspace names, agent names, then words of titles/tabs. Deduped, <= max. */
export function buildKeyterms(panes: TermSource[], max = 20): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (raw: string | null | undefined, filter = true) => {
    const t = (raw ?? '').replace(/[^\p{L}\p{N}._\- ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
    const k = t.toLowerCase()
    if (t.length < 3 || /^\d+$/.test(t) || seen.has(k) || (filter && GENERIC.has(k))) return
    seen.add(k)
    out.push(t)
  }
  for (const p of panes) add(p.workspace)
  for (const p of panes) add(p.agent)
  for (const p of panes) for (const w of `${p.title ?? ''} ${p.tab ?? ''}`.split(/[\s/:~]+/)) add(w)
  return out.slice(0, max)
}

export function buildDgUrl(base: string, terms: string[]): string {
  const root = base.replace(/\/+$/, '').replace(/\/v1\/listen$/, '')
  const params = 'model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&punctuate=true'
  return `${root}/v1/listen?${params}${terms.map(t => `&keyterm=${encodeURIComponent(t)}`).join('')}`
}

// ---------------------------------------------------------------- phase machine
export type DictPhase = 'idle' | 'listening' | 'finalizing' | 'confirm'
export type DictEvent =
  | { t: 'start'; canDictate: boolean; hasKey: boolean }
  | { t: 'stop' }
  | { t: 'final'; transcript: string }
  | { t: 'send' }
  | { t: 'redo' }
  | { t: 'cancel' }
  | { t: 'error' }
  | { t: 'leave' }
export type DictEffect = 'noKey' | 'beginListen' | 'finalize' | 'empty' | 'showConfirm' | 'send' | 'error' | 'abort'

/** idle → listening → finalizing → confirm → (sent | cancel → idle | redo → listening). `error`/`leave` always end in idle. */
export function dictStep(phase: DictPhase, ev: DictEvent): { phase: DictPhase; fx: DictEffect[] } {
  const stay = { phase, fx: [] as DictEffect[] }
  switch (ev.t) {
    case 'start':
      if (phase !== 'idle' || !ev.canDictate) return stay
      return ev.hasKey ? { phase: 'listening', fx: ['beginListen'] } : { phase: 'idle', fx: ['noKey'] }
    case 'stop': return phase === 'listening' ? { phase: 'finalizing', fx: ['finalize'] } : stay
    case 'final':
      if (phase !== 'finalizing') return stay
      return ev.transcript.trim() ? { phase: 'confirm', fx: ['showConfirm'] } : { phase: 'idle', fx: ['empty'] }
    case 'send': return phase === 'confirm' ? { phase: 'idle', fx: ['send'] } : stay
    case 'redo': return phase === 'confirm' ? { phase: 'listening', fx: ['beginListen'] } : stay
    case 'cancel': return phase === 'idle' ? stay : { phase: 'idle', fx: ['abort'] }
    case 'error': return phase === 'idle' ? stay : { phase: 'idle', fx: ['abort', 'error'] }
    case 'leave': return phase === 'idle' ? stay : { phase: 'idle', fx: ['abort'] }
  }
}

// ---------------------------------------------------------------- Deepgram socket
export interface DgFinish { transcript: string; releaseToFinalMs: number; firstPartialMs: number | null; frames: number; bytes: number; error?: string }
export interface DgOptions {
  /** Called once when the socket closes or fails (reason: 'idle' | 'error' | 'closed' | 'local'). */
  onClose?: (reason: string, detail?: string) => void
  /** Called with error text for socket errors; also fires while active. */
  onError?: (msg: string) => void
  /** Socket opened after `ms` since construction. */
  onOpen?: (ms: number) => void
}

/**
 * One Deepgram streaming socket. Idle ("warm"): KeepAlive every 5 s and self-closes after 2 min. `begin()` claims it for a
 * dictation (audio flows, buffered until the socket opens); `finish()` sends Finalize, waits for the final results, then
 * CloseStream and closes. A socket is single-use: open a fresh one for the next dictation.
 */
export class DgStream {
  private ws: WebSocket
  readonly t0 = performance.now()
  opened = false
  openMs: number | null = null
  closed = false
  failed = false
  private active = false
  private begun = false
  private tr = newTranscript()
  private buf: Uint8Array[] = []
  private bufBytes = 0
  private tPress = 0
  firstPartialMs: number | null = null
  frames = 0
  bytes = 0
  private ka: ReturnType<typeof setInterval> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private onText: ((text: string) => void) | null = null
  private waiters = new Set<() => void>()
  private finalized = false
  private reported = false

  constructor(url: string, key: string, private opts: DgOptions = {}, idleMs = WARM_IDLE_MS) {
    this.ws = new WebSocket(url, ['token', key])
    this.ws.binaryType = 'arraybuffer'
    this.idle = setTimeout(() => this.shutdown('idle'), idleMs)
    this.ws.onopen = () => {
      this.opened = true
      this.openMs = Math.round(performance.now() - this.t0)
      this.opts.onOpen?.(this.openMs)
      this.ka = setInterval(() => { if (!this.active) this.sendJson({ type: 'KeepAlive' }) }, KEEPALIVE_MS)
      if (this.active) this.flush()
      this.wake()
    }
    this.ws.onerror = () => { this.failed = true; this.opts.onError?.('socket error'); this.wake() }
    this.ws.onclose = ev => { this.closed = true; this.clearTimers(); this.report(this.failed || !this.opened ? 'error' : 'closed', `code ${ev.code}`); this.wake() }
    this.ws.onmessage = ev => {
      let m: any
      try { m = JSON.parse(String(ev.data)) } catch { return }
      if (!this.begun) return // warm socket: nothing to transcribe
      const r = applyResult(this.tr, m)
      if (!r.changed) return
      const text = transcriptText(this.tr)
      if (text && this.firstPartialMs === null && this.tPress) this.firstPartialMs = Math.round(performance.now() - this.tPress)
      this.onText?.(text)
      if (r.fromFinalize) { this.finalized = true; this.wake() }
    }
  }

  get ready(): boolean { return this.opened && !this.closed && this.ws.readyState === WebSocket.OPEN }
  get dead(): boolean { return this.closed || this.failed }
  get ageMs(): number { return Math.round(performance.now() - this.t0) }

  /** Claim for a dictation: reset the transcript, flush anything buffered once open. */
  begin(onText: (text: string) => void) {
    this.active = true; this.begun = true; this.finalized = false
    this.tr = newTranscript(); this.firstPartialMs = null; this.frames = 0; this.bytes = 0
    this.tPress = performance.now()
    this.onText = onText
    clearTimeout(this.idle)
    if (this.ready) this.flush()
  }

  sendPcm(pcm: Uint8Array) {
    if (!this.active || this.dead) return
    this.frames++; this.bytes += pcm.length
    const copy = pcm.slice()
    if (this.ready) { try { this.ws.send(copy) } catch { /* */ } return }
    this.buf.push(copy); this.bufBytes += copy.length
    while (this.bufBytes > MAX_BUFFER_BYTES && this.buf.length) this.bufBytes -= this.buf.shift()!.length
  }

  /** Release: Finalize, wait for the final results (or `timeoutMs`), CloseStream, close. */
  async finish(timeoutMs = FINAL_TIMEOUT_MS): Promise<DgFinish> {
    const tRelease = performance.now()
    this.active = false
    const deadline = tRelease + timeoutMs
    const waitFor = (cond: () => boolean) => new Promise<void>(res => {
      if (cond()) return res()
      const w = () => { if (cond()) done() }
      const done = () => { clearTimeout(t); this.waiters.delete(w); res() }
      const t = setTimeout(done, Math.max(0, deadline - performance.now()))
      this.waiters.add(w)
    })
    await waitFor(() => this.ready || this.dead)
    let error: string | undefined
    if (this.ready) {
      this.flush()
      this.finalized = false
      this.sendJson({ type: 'Finalize' })
      await waitFor(() => this.finalized || this.dead)
      if (!this.finalized && !this.dead) error = 'final timeout'
    } else error = this.dead ? 'socket failed' : 'socket not open'
    const transcript = transcriptText(this.tr)
    const res: DgFinish = { transcript, releaseToFinalMs: Math.round(performance.now() - tRelease), firstPartialMs: this.firstPartialMs, frames: this.frames, bytes: this.bytes, error }
    this.onText = null
    this.shutdown('local', true)
    return res
  }

  /** Drop everything (cancel/leave/error). */
  abort() { this.active = false; this.onText = null; this.shutdown('local') }
  close() { this.shutdown('local') }

  private flush() {
    for (const b of this.buf) { try { this.ws.send(b) } catch { /* */ } }
    this.buf = []; this.bufBytes = 0
  }
  private sendJson(o: object) { if (this.ready) { try { this.ws.send(JSON.stringify(o)) } catch { /* */ } } }
  private wake() { for (const w of [...this.waiters]) w() }
  private clearTimers() { clearInterval(this.ka); clearTimeout(this.idle) }
  private report(reason: string, detail?: string) { if (this.reported) return; this.reported = true; this.opts.onClose?.(reason, detail) }
  private shutdown(reason: string, graceful = false) {
    if (this.closed && this.reported) return
    this.clearTimers()
    if (graceful) this.sendJson({ type: 'CloseStream' })
    this.report(reason)
    try { this.ws.close() } catch { /* */ }
    this.closed = true
    this.wake()
  }
}
