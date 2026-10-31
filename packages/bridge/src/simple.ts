import { ChatModel, clip, firstLine, type Delta } from './model.ts'
import { toolLine } from './claude.ts'

type RecordValue = Record<string, unknown>
const obj = (v: unknown): RecordValue | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : null
const str = (v: unknown): string => typeof v === 'string' ? v : ''
const blocks = (v: unknown): unknown[] => Array.isArray(v) ? v : []

/** Cursor agent transcripts and Pi session files both carry message content blocks in JSONL. */
export class SimpleTranscript extends ChatModel {
  private lineNo = 0

  constructor(private agent: 'cursor' | 'pi') { super() }

  ingest(line: string): Delta {
    const d: Delta = { appended: [], updated: [] }
    const no = this.lineNo++
    let raw: unknown
    try { raw = JSON.parse(line) } catch { this.badLines++; return d }
    this.goodLines++
    const o = obj(raw)
    if (!o) return d
    const msg = obj(o.message)
    if (this.agent === 'pi' && o.type !== 'message') return d
    const role = this.agent === 'pi' ? str(msg?.role) : str(o.role)
    const id = this.agent === 'pi' ? str(o.id) || `p${no}` : `u${no}`
    const time = this.agent === 'pi' ? Date.parse(str(o.timestamp)) : NaN
    const base = Number.isFinite(time) ? { ts: time } : {}
    const content = msg?.content
    if (role === 'user' && typeof content === 'string' && content.trim()) {
      this.add({ id, kind: 'user', text: content.trim(), ...base }, d)
      return d
    }
    if (role === 'bashExecution') {
      this.add({ id, kind: 'tool', text: `Bash: ${clip(firstLine(str(msg?.command)))}`, ...base }, d)
      return d
    }
    if (role !== 'user' && role !== 'assistant') return d
    for (const [i, value] of blocks(content).entries()) {
      const b = obj(value)
      if (!b) continue
      const eid = `${id}.${i}`
      if (b.type === 'text' && str(b.text).trim()) this.add({ id: eid, kind: role, text: str(b.text).trim(), ...base }, d)
      if (role === 'assistant' && (b.type === 'tool_use' || b.type === 'toolCall')) {
        const name = str(b.name)
        if (name) this.add({ id: eid, kind: 'tool', text: toolLine(name, b.input ?? b.arguments), ...base }, d)
      }
    }
    return d
  }
}
