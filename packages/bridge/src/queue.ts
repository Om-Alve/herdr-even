import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentStatus, QueuedItem } from '@herdr-even/protocol'

export const MAX_QUEUE = 20
export const MAX_ITEM_CHARS = 4000
const MAX_ATTEMPTS = 3

export interface QueueDeps {
  /** Current status of a pane, or null when the pane doesn't exist (any more). */
  status(paneId: string): AgentStatus | null
  /** Type the text and press enter (the normal text+enter send path). Throws on failure. */
  deliver(paneId: string, text: string): Promise<void>
  /** Stable agent session id; restored messages are sent only to this same session. */
  identity?(paneId: string): string | null
  /** Private on-disk queue snapshot, used to survive bridge restarts. */
  file?: string
  log?(s: string): void
  now?: () => number
  /** Stays idle/done this long after a delivery without having been seen working -> deliver the next item. */
  fallbackMs?: number
  /** A pane must be missing this long before its queue is dropped (a failed re-snapshot empties the pane list for a moment). */
  vanishGraceMs?: number
  /** How often queues are re-evaluated (only while some queue is non-empty); covers the fallback, retries and vanishing. */
  tickMs?: number
}

interface PaneQueue {
  items: QueuedItem[]
  identity: string | null
  attempts: number
  busy: boolean
  /** Set after a delivery to a real agent; gates the next one until it worked, or until fallbackMs passed. */
  last: { at: number; sawWorking: boolean } | null
  missingSince: number | null
}

interface StoredQueue {
  pane: string
  identity: string
  items: QueuedItem[]
  attempts: number
  last: PaneQueue['last']
}

function loadQueues(file: string): StoredQueue[] {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('panes' in raw) || !Array.isArray(raw.panes)) return []
  return raw.panes.flatMap((x: unknown) => {
    if (!x || typeof x !== 'object' || !('pane' in x) || typeof x.pane !== 'string' || !('identity' in x) || typeof x.identity !== 'string' || !x.identity || !('items' in x) || !Array.isArray(x.items)) return []
    const items = x.items.filter((i: unknown): i is QueuedItem => !!i && typeof i === 'object' && 'id' in i && typeof i.id === 'string' && 'text' in i && typeof i.text === 'string' && i.text.length <= MAX_ITEM_CHARS && 'ts' in i && typeof i.ts === 'number').slice(0, MAX_QUEUE)
    if (!items.length) return []
    const attempts = 'attempts' in x && typeof x.attempts === 'number' && Number.isInteger(x.attempts) && x.attempts >= 0 && x.attempts < MAX_ATTEMPTS ? x.attempts : 0
    const l = 'last' in x ? x.last : null
    const last = l && typeof l === 'object' && 'at' in l && typeof l.at === 'number' && 'sawWorking' in l && typeof l.sawWorking === 'boolean' ? { at: l.at, sawWorking: l.sawWorking } : null
    return [{ pane: x.pane, identity: x.identity, items, attempts, last }]
  })
}

/**
 * Per-pane queues of messages waiting for the agent to stop working. Pure logic over `QueueDeps`: status comes from
 * the session model (`evaluate()` is called on every pane-list refresh, which follows Herdr's status events), no polling
 * of Herdr here. In memory only.
 */
export class MessageQueue {
  private panes = new Map<string, PaneQueue>()
  private listeners = new Set<(paneId: string, items: QueuedItem[]) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private n = 0
  private readonly prefix = Math.random().toString(36).slice(2, 6)
  private now: () => number
  private fallbackMs: number
  private graceMs: number
  private tickMs: number

  constructor(private d: QueueDeps) {
    this.now = d.now ?? Date.now
    this.fallbackMs = d.fallbackMs ?? 20_000
    this.graceMs = d.vanishGraceMs ?? 30_000
    this.tickMs = d.tickMs ?? 1_000
    if (d.file) for (const q of loadQueues(d.file)) this.panes.set(q.pane, { items: q.items, identity: q.identity, attempts: q.attempts, last: q.last, busy: false, missingSince: null })
    if (this.panes.size) this.arm()
  }

  /** Called whenever a pane's queue changed (add, deliver, unqueue, drop) with the new list, possibly empty. */
  onChange(cb: (paneId: string, items: QueuedItem[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  list(paneId: string): QueuedItem[] {
    return [...(this.panes.get(paneId)?.items ?? [])]
  }

  /** Returns null when the pane's queue is full. */
  add(paneId: string, text: string): QueuedItem | null {
    let q = this.panes.get(paneId)
    const identity = this.d.identity?.(paneId) ?? null
    if (q?.identity && identity && q.identity !== identity) {
      this.panes.delete(paneId)
      this.changed(paneId, [])
      q = undefined
    }
    if (!q) this.panes.set(paneId, (q = { items: [], identity, attempts: 0, busy: false, last: null, missingSince: null }))
    if (!q.identity) q.identity = identity
    if (q.items.length >= MAX_QUEUE) return null
    const item: QueuedItem = { id: `q${this.prefix}${++this.n}`, text, ts: this.now() }
    q.items.push(item)
    try { this.changed(paneId) } catch (e) {
      q.items.pop()
      if (!q.items.length) this.panes.delete(paneId)
      throw e
    }
    this.arm()
    this.d.log?.(`queue: stored ${item.id} for ${paneId}`)
    void this.evaluate(paneId).catch(e => this.d.log?.(`queue: evaluation failed for ${paneId}: ${e}`))
    return item
  }

  /** False when unknown, already delivered, or being delivered right now. */
  remove(paneId: string, itemId: string): boolean {
    const q = this.panes.get(paneId)
    const at = q ? q.items.findIndex((i) => i.id === itemId) : -1
    if (!q || at < 0 || (q.busy && at === 0)) return false
    const [item] = q.items.splice(at, 1)
    try { this.changed(paneId) } catch (e) {
      q.items.splice(at, 0, item!)
      throw e
    }
    return true
  }

  /** Re-check every non-empty queue. Call after each pane-list refresh. */
  evaluateAll() {
    for (const id of [...this.panes.keys()]) void this.evaluate(id).catch(e => this.d.log?.(`queue: evaluation failed for ${id}: ${e}`))
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async evaluate(paneId: string): Promise<void> {
    const q = this.panes.get(paneId)
    if (!q || q.busy) return
    const status = this.d.status(paneId)
    if (!q.items.length) {
      // keep tracking whether the agent worked since the last delivery, so a later item isn't held for the fallback
      if (q.last && (status === 'working' || status === 'blocked')) q.last.sawWorking = true
      return
    }
    if (status === null) {
      q.missingSince ??= this.now()
      if (this.now() - q.missingSince >= this.graceMs) {
        this.d.log?.(`queue: pane ${paneId} is gone, dropping ${q.items.length} queued message(s)`)
        this.panes.delete(paneId)
        this.changed(paneId, [])
        this.disarmIfIdle()
      }
      return
    }
    q.missingSince = null
    const identity = this.d.identity?.(paneId) ?? null
    if (q.identity && identity && q.identity !== identity) {
      this.d.log?.(`queue: session changed for ${paneId}, dropping ${q.items.length} queued message(s)`)
      this.panes.delete(paneId)
      this.changed(paneId, [])
      this.disarmIfIdle()
      return
    }
    if (q.identity && !identity) return
    if (!q.identity && identity) {
      q.identity = identity
      this.persist()
    }
    if (status === 'working' || status === 'blocked') {
      if (q.last) q.last.sawWorking = true
      return
    }
    if (status !== 'unknown' && q.last && !q.last.sawWorking && this.now() - q.last.at < this.fallbackMs) return
    await this.deliverHead(paneId, q, status)
  }

  private async deliverHead(paneId: string, q: PaneQueue, status: AgentStatus) {
    const item = q.items[0]!
    q.busy = true
    q.attempts++
    let ok = false
    try {
      await this.d.deliver(paneId, item.text)
      ok = true
    } catch (e: any) {
      this.d.log?.(`queue: delivery to ${paneId} failed (attempt ${q.attempts}/${MAX_ATTEMPTS}): ${e?.message ?? e}`)
    }
    q.busy = false
    if (this.panes.get(paneId) !== q) return
    if (ok) {
      q.items.shift()
      q.attempts = 0
      q.last = status === 'unknown' ? null : { at: this.now(), sawWorking: false }
      this.d.log?.(`queue: delivered ${item.id} to ${paneId}`)
    } else if (q.attempts >= MAX_ATTEMPTS) {
      this.d.log?.(`queue: dropping ${item.id} for ${paneId} after ${MAX_ATTEMPTS} failed attempts`)
      q.items.shift()
      q.attempts = 0
    } else return // retried by the next evaluation
    try { this.changed(paneId) } catch (e) { this.d.log?.(`queue: could not save delivery state for ${paneId}: ${e}`) }
    this.arm()
    if (q.items.length) await this.evaluate(paneId) // non-agent panes: next one right away; agents are gated by `last`
  }

  private changed(paneId: string, items?: QueuedItem[]) {
    this.persist()
    const l = items ?? this.list(paneId)
    for (const cb of this.listeners) {
      try {
        cb(paneId, l)
      } catch {}
    }
  }

  private persist() {
    if (!this.d.file) return
    this.dirty = true
    const panes: StoredQueue[] = [...this.panes].flatMap(([pane, q]) => q.items.length && q.identity ? [{ pane, identity: q.identity, items: q.items, attempts: q.attempts, last: q.last }] : [])
    mkdirSync(dirname(this.d.file), { recursive: true })
    const tmp = `${this.d.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, panes }), { mode: 0o600 })
    renameSync(tmp, this.d.file)
    this.dirty = false
  }

  private arm() {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.dirty) try { this.persist() } catch (e) { this.d.log?.(`queue: could not save queue state: ${e}`) }
      this.evaluateAll()
      this.disarmIfIdle()
    }, this.tickMs)
  }

  private disarmIfIdle() {
    let live = false
    for (const [id, q] of this.panes) {
      if (q.items.length) live = true
      else if (q.last && this.now() - q.last.at < this.fallbackMs) live = true
      else this.panes.delete(id)
    }
    if (!live && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
