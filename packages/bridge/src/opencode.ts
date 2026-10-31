import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { ChatModel, clip, firstLine, type Delta } from './model.ts'
import type { Candidate } from './locate.ts'
import type { TailHandlers } from './tail.ts'

type Row = { id: string; data: string; message: string; ts: number }
type SessionRow = { id: string; time_updated: number }
type Rec = Record<string, unknown>
const obj = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null
const parse = (text: string): Rec | null => { try { return obj(JSON.parse(text)) } catch { return null } }
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const isSessionRow = (v: unknown): v is SessionRow => { const r = obj(v); return typeof r?.id === 'string' && typeof r.time_updated === 'number' }
const isRow = (v: unknown): v is Row => { const r = obj(v); return typeof r?.id === 'string' && typeof r.data === 'string' && typeof r.message === 'string' && typeof r.ts === 'number' }

const openDb = (path: string) => new Database(path, { readonly: true })

export function locateOpenCode(path: string, id: string): string | null {
  if (!existsSync(path) || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  try {
    const db = openDb(path)
    try { return db.query('SELECT id FROM session WHERE id = ?').get(id) ? path : null }
    finally { db.close() }
  } catch { return null }
}

export function openCodeCandidates(path: string, cwd: string, now = Date.now()): Candidate[] {
  if (!existsSync(path)) return []
  try {
    const db = openDb(path)
    try {
      const rows: unknown[] = db.query('SELECT id, time_updated FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 20').all(cwd)
      return rows.filter(isSessionRow).filter(r => r.time_updated >= now - 24 * 3600_000).map(r => ({ path, id: r.id, mtime: r.time_updated }))
    } finally { db.close() }
  } catch { return [] }
}

class OpenCodeTranscript extends ChatModel {
  ingest(_line: string): Delta { return { appended: [], updated: [] } }

  loadRows(rows: Row[]) {
    this.reset()
    for (const row of rows) {
      const part = parse(row.data)
      const msg = parse(row.message)
      if (!part || !msg) continue
      const role = str(msg.role)
      const type = str(part.type)
      const ts = row.ts || undefined
      const d: Delta = { appended: [], updated: [] }
      if (type === 'text' && (role === 'user' || role === 'assistant')) {
        const text = str(part.text).trim()
        if (text) this.add({ id: row.id, kind: role, text, ts }, d)
      } else if (type === 'tool') {
        const state = obj(part.state)
        const input = obj(state?.input)
        const tool = str(part.tool)
        const arg = input ? Object.values(input).find(v => typeof v === 'string' && v.trim()) : undefined
        const label = `${tool}${typeof arg === 'string' ? `: ${clip(firstLine(arg))}` : ''}`
        if (tool) this.add({ id: row.id, kind: 'tool', text: label, ts }, d)
      } else if (type === 'subtask') {
        const text = str(part.prompt) || str(part.description)
        if (text) this.add({ id: row.id, kind: 'system', text: `Subtask: ${clip(text)}`, ts }, d)
      }
    }
  }
}

/** Polls OpenCode's read-only SQLite store while a pane is open. */
export class OpenCodeTail {
  model = new OpenCodeTranscript()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private busy = false

  constructor(private path: string, private sessionId: string, private h: TailHandlers) {}

  async load() { this.model.loadRows(this.rows()) }

  startWatching() { this.timer = setInterval(() => void this.poll(), 1000) }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer) }

  private rows(): Row[] {
    const db = openDb(this.path)
    try {
      const rows: unknown[] = db.query('SELECT p.id, p.data, m.data AS message, p.time_created AS ts FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? ORDER BY p.time_created, p.id').all(this.sessionId)
      return rows.filter(isRow)
    } finally { db.close() }
  }

  private async poll() {
    if (this.stopped || this.busy) return
    this.busy = true
    try {
      const prev = this.model.entries
      const next = new OpenCodeTranscript()
      next.loadRows(this.rows())
      if (this.stopped) return
      const old = new Map(prev.map(e => [e.id, e]))
      const ids = new Set(next.entries.map(e => e.id))
      this.model = next
      if (prev.some(e => !ids.has(e.id))) { this.h.onReset(); return }
      const appended = next.entries.filter(e => !old.has(e.id))
      const updated = next.entries.filter(e => old.has(e.id) && JSON.stringify(old.get(e.id)) !== JSON.stringify(e))
      if (appended.length || updated.length) this.h.onDelta({ appended, updated })
    } catch (e) {
      this.stop()
      this.h.onFail(String(e))
    } finally { this.busy = false }
  }
}
