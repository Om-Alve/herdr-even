import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatEntry } from '@herdr-even/protocol'
import { ChatModel, clip, firstLine, type Delta, type SubagentInfo } from './model.ts'

export type { Delta }

/** Find `<claudeDir>/<project>/<session>.jsonl`. */
export function locateTranscript(claudeDir: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null
  try {
    for (const d of readdirSync(claudeDir)) {
      const p = join(claudeDir, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {}
  return null
}

export function toolLine(name: string, input: any): string {
  const i = input && typeof input === 'object' ? input : {}
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  let arg = ''
  switch (name) {
    case 'Bash':
    case 'Monitor':
      arg = firstLine(str('command'))
      break
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      arg = str('file_path')
      break
    case 'NotebookEdit':
      arg = str('notebook_path')
      break
    case 'Grep':
    case 'Glob':
      arg = str('pattern')
      break
    case 'WebFetch':
      arg = str('url')
      break
    case 'WebSearch':
      arg = str('query')
      break
    case 'Agent':
    case 'Task':
      arg = str('description') || str('subagent_type')
      break
    case 'Skill':
      arg = str('skill')
      break
    case 'ToolSearch':
      arg = str('query')
      break
    case 'TaskCreate':
      arg = str('subject')
      break
    default:
      for (const v of Object.values(i)) if (typeof v === 'string' && v.trim()) { arg = firstLine(v); break }
  }
  return arg ? `${name}: ${clip(arg)}` : name
}

// ---- user-text noise
const NOISE_PREFIX = [
  '<command-name>', '<command-message>', '<command-args>', '<local-command-', '<task-notification>',
  '<system-reminder>', '<user-prompt-submit-hook>', '<bash-input>', '<bash-stdout>', '<bash-stderr>',
]
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Returns text to display for a user prompt, or null to hide it. */
export function cleanUserText(raw: string): string | null {
  let t = raw.replace(SYSTEM_REMINDER, '').trim()
  if (!t) return null
  if (NOISE_PREFIX.some((p) => t.startsWith(p))) return null
  if (t.startsWith('This session is being continued from')) return null
  if (t.startsWith('Caveat: The messages below were generated')) return null
  if (/^\[Image[: ]/.test(t) && t.length < 80) return null
  return t
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

/** Incremental Claude Code transcript model. `sidechain` reads a subagent's own file (all records are sidechain). */
export class ClaudeTranscript extends ChatModel {
  private toolEntry = new Map<string, string>() // tool_use_id -> entry id

  constructor(private sidechain = false) {
    super()
  }

  /** Ingest one JSONL line. Never throws. */
  ingest(line: string): Delta {
    const d: Delta = { appended: [], updated: [] }
    line = line.trim()
    if (!line) return d
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      this.badLines++
      return d
    }
    this.goodLines++
    try {
      this.record(o, d)
    } catch {
      // unknown shape: skip
    }
    return d
  }

  private record(o: any, d: Delta) {
    if (!o || typeof o !== 'object') return
    if (o.type !== 'user' && o.type !== 'assistant') return
    if ((o.isSidechain && !this.sidechain) || o.isMeta) return
    const msg = o.message
    if (!msg || typeof msg !== 'object') return
    const uuid: string | undefined = typeof o.uuid === 'string' ? o.uuid : undefined
    if (!uuid) return
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const base = Number.isFinite(ts) ? { ts } : {}
    const idFor = (i: number) => (i === 0 ? uuid : `${uuid}.${i}`)
    const content = msg.content

    if (o.type === 'user') {
      if (typeof content === 'string') {
        const t = cleanUserText(content)
        if (t) this.add({ id: idFor(0), kind: 'user', text: t, ...base }, d)
        return
      }
      if (!Array.isArray(content)) return
      content.forEach((b: any, i: number) => {
        if (!b || typeof b !== 'object') return
        if (b.type === 'tool_result') {
          const eid = this.toolEntry.get(b.tool_use_id)
          if (eid === undefined || this.spawns.has(eid)) return // spawn entries show state via the subagent list
          const err = b.is_error === true
          const fl = firstLine(resultText(b.content))
          const mark = err ? '✗' : '✓'
          this.replace(eid, (cur) => {
            const base1 = cur.text.split('\n')[0]!
            return { ...cur, text: fl && fl.length <= 80 ? `${base1}\n${mark} ${fl}` : `${base1}\n${mark}` }
          }, d)
        } else if (b.type === 'text' && typeof b.text === 'string') {
          const t = cleanUserText(b.text)
          if (t && !t.startsWith('[Request interrupted')) this.add({ id: idFor(i), kind: 'user', text: t, ...base }, d)
          else if (t) this.add({ id: idFor(i), kind: 'system', text: 'Interrupted', ...base }, d)
        }
      })
      return
    }

    // assistant
    if (!Array.isArray(content)) return
    content.forEach((b: any, i: number) => {
      if (!b || typeof b !== 'object') return
      if (b.type === 'text' && typeof b.text === 'string') {
        const t = b.text.replace(SYSTEM_REMINDER, '').trim()
        if (t && t !== '(no content)') this.add({ id: idFor(i), kind: 'assistant', text: t, ...base }, d)
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const id = idFor(i)
        if (typeof b.id === 'string') this.toolEntry.set(b.id, id)
        if ((b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string') {
          const i = b.input && typeof b.input === 'object' ? b.input : {}
          const type = typeof i.subagent_type === 'string' && i.subagent_type ? i.subagent_type : 'agent'
          const desc = clip(typeof i.description === 'string' && i.description ? i.description : firstLine(String(i.prompt ?? '')), 80)
          this.addSpawn({ id, kind: 'subagent', text: desc ? `${type} · ${desc}` : type, ...base }, b.id, desc, d)
        } else this.add({ id, kind: 'tool', text: toolLine(b.name, b.input), ...base }, d)
      }
      // thinking / redacted_thinking / others: hidden
    })
  }

  protected override spawnText(cur: ChatEntry, _info: SubagentInfo): string {
    return cur.text
  }
}
