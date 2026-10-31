import { openSync, readSync, readdirSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatEntry } from '@herdr-even/protocol'
import { ChatModel, clip, firstLine, type Delta, type SubagentInfo } from './model.ts'

const ID_RE = /^[A-Za-z0-9_-]+$/
const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
const names = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Find `<codexDir>/YYYY/MM/DD/rollout-<ts>-<session>.jsonl`, newest day directories first.
 * `codexDir` is `~/.codex/sessions`.
 */
export function locateRollout(codexDir: string, sessionId: string): string | null {
  if (!ID_RE.test(sessionId)) return null
  const suffix = `-${sessionId}.jsonl`
  for (const y of names(codexDir).sort(desc))
    for (const m of names(join(codexDir, y)).sort(desc))
      for (const d of names(join(codexDir, y, m)).sort(desc)) {
        const dir = join(codexDir, y, m, d)
        const hit = names(dir).find((f) => f.startsWith('rollout-') && f.endsWith(suffix))
        if (hit) return join(dir, hit)
      }
  return null
}

/** Latest Codex turn marker near the end of a rollout. Used when Herdr misses a completion event. */
export function codexTurnState(path: string): 'working' | 'done' | null {
  let fd: number | undefined
  try {
    const size = statSync(path).size
    const len = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(len)
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, len, size - len)
    let state: 'working' | 'done' | null = null
    for (const line of buf.toString('utf8').split('\n').slice(size > len ? 1 : 0)) {
      if (!line.includes('"event_msg"')) continue
      try {
        const o = JSON.parse(line)
        const type = o?.type === 'event_msg' ? o.payload?.type : null
        if (type === 'task_started') state = 'working'
        if (type === 'task_complete' || type === 'turn_aborted') state = 'done'
      } catch {}
    }
    return state
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** "/root/browser_integrity" -> "browser integrity" */
export const humanizeAgentPath = (p: string): string => (p.split('/').filter(Boolean).pop() ?? p).replace(/[_-]+/g, ' ').trim()

// ---- user-text noise (injected context, not typed by the user)
const NOISE_PREFIX = [
  '# AGENTS.md instructions', '# Instructions', 'Host notice:', '<environment_context>', '<recommended_plugins>',
  '<user_instructions>', '<user_shell_command>', '<permissions', '<collaboration_mode>', '<skill>', '<subagent_notification>',
  '<system-reminder>', '<INSTRUCTIONS>',
]

/** Returns text to display for a Codex user message part, or null to hide it. */
export function cleanCodexUser(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  if (t.startsWith('<send_user_message_question_reply>')) {
    try {
      const body = t.slice('<send_user_message_question_reply>'.length).replace(/<\/send_user_message_question_reply>$/, '').trim()
      const answers: unknown = JSON.parse(body)
      if (Array.isArray(answers)) return answers.flatMap(a => a && typeof a.answer === 'string' ? [a.answer] : []).join('\n') || null
    } catch {}
    return null
  }
  if (NOISE_PREFIX.some((p) => t.startsWith(p))) return null
  // a whole message wrapped in one injected XML-ish tag, e.g. <environment_context>…</environment_context>
  const tag = /^<([a-z_]+)[ >]/.exec(t)
  if (tag && t.endsWith(`</${tag[1]}>`)) return null
  if (/^\[Image[: ]/.test(t) && t.length < 80) return null
  return t
}

const FILE_RE = /\*\*\* (?:Add|Update|Delete) File: ([^\\\n"']+)/g
const CMD_RE = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g

function unquote(lit: string): string {
  try {
    return lit[0] === '"' ? (JSON.parse(lit) as string) : lit.slice(1, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')
  } catch {
    return lit.slice(1, -1)
  }
}

const stripShell = (c: string) => c.replace(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/, '$2')

function patchLine(text: string): string | null {
  const files = [...text.matchAll(FILE_RE)].map((m) => m[1]!.trim())
  if (!files.length) return null
  return `apply_patch: ${clip([...new Set(files)].join(', '))}`
}

/** One-liner for the `exec` custom tool, whose input is a JavaScript snippet calling `tools.*`. */
function execLine(code: string): string {
  const cmds = [...code.matchAll(CMD_RE)].map((m) => unquote(m[1]!))
  if (cmds.length) return `Bash: ${clip(firstLine(stripShell(cmds[0]!)))}${cmds.length > 1 ? ` (+${cmds.length - 1})` : ''}`
  const p = patchLine(code)
  if (p) return p
  const tool = /\btools\.([A-Za-z_]\w*)/.exec(code)
  if (tool) return `exec: ${tool[1]}`
  return `exec: ${clip(firstLine(code), 60)}`
}

function argsOf(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** Tool calls that are pure polling/plumbing: hidden (their outputs too). */
const HIDDEN = new Set(['wait', 'wait_agent', 'list_agents', 'sleep', 'get_goal'])

/** One-liner for a tool call; null hides it. */
export function codexToolLine(name: string, input: unknown): string | null {
  if (HIDDEN.has(name)) return null
  const a = argsOf(input)
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '')
  switch (name) {
    case 'exec':
      return execLine(typeof input === 'string' ? input : '')
    case 'apply_patch':
      return patchLine(typeof input === 'string' ? input : str('input')) ?? 'apply_patch'
    case 'exec_command':
      return `Bash: ${clip(firstLine(stripShell(str('cmd') || str('command'))))}`
    case 'shell':
    case 'local_shell': {
      const c = Array.isArray(a.command) ? a.command.join(' ') : str('command')
      return `Bash: ${clip(firstLine(stripShell(c.replace(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+/, '') || c)))}`
    }
    case 'write_stdin':
      return str('chars').trim() ? `write_stdin: ${clip(str('chars'), 60)}` : null
    case 'send_message':
    case 'followup_task':
    case 'interrupt_agent':
      return `${name}: ${clip(humanizeAgentPath(str('target')) || str('target'), 60)}`.replace(/: $/, '')
    case 'view_image':
      return `view_image: ${clip(str('path'))}`
    case 'update_plan':
      return 'update_plan'
    default: {
      for (const v of Object.values(a)) if (typeof v === 'string' && v.trim()) return `${name}: ${clip(firstLine(v), 60)}`
      return name
    }
  }
}

function outputText(o: unknown): string {
  if (typeof o === 'string') return o
  if (Array.isArray(o)) return o.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('\n')
  return ''
}

/** Status mark + short first line from a tool output, or null while the call is still running. */
export function codexResult(output: unknown): { ok: boolean; line: string } | null {
  const raw = outputText(output)
  if (/^Script running with cell ID|^Process running with session ID|\nProcess running with session ID/.test(raw)) return null
  let ok = true
  if (/^Script failed/.test(raw)) ok = false
  const code = /Process exited with code (-?\d+)|^Exit code: (-?\d+)|"exit_code":\s*(-?\d+)/.exec(raw)
  const n = code ? Number(code[1] ?? code[2] ?? code[3]) : 0
  if (n !== 0) ok = false
  // text after the "Output:" scaffold, unwrapping the {output:"…"} JSON of exec_command results
  let body = raw.includes('Output:\n') ? raw.slice(raw.indexOf('Output:\n') + 8) : raw
  if (body.trimStart().startsWith('{') && body.length < 200_000) {
    try {
      const j = JSON.parse(body.trim())
      const v = j?.value ?? j
      if (typeof v?.output === 'string') body = v.output
    } catch {}
  }
  if (/^(Script (completed|failed)|Wall time)/.test(body.trim())) body = ''
  const line = firstLine(body.trimStart().replace(/^Script error:\s*/, ''))
  return { ok, line: line.length <= 80 ? line : '' }
}

/** Incremental Codex rollout model. Pure: feed it JSONL lines, read entries. Entry ids are `c<line number>`. */
export class CodexTranscript extends ChatModel {
  private lineNo = 0
  private callEntry = new Map<string, string>() // call_id -> entry id (undefined entry = hidden call)
  private hidden = new Set<string>()
  private cellEntry = new Map<string, string>() // exec cell id -> entry id, while still running
  private spawnCalls = new Map<string, { entryId: string; task: string }>()
  private questions = new Map<string, { entryId: string; async: boolean }>()
  /** Subagent rollouts start with the forked parent's history; drop it when the task arrives. */
  private holdHistory = false
  private ownPath = ''

  constructor(private asSubagent = false) {
    super()
  }

  ingest(line: string): Delta {
    const d: Delta = { appended: [], updated: [] }
    line = line.trim()
    if (!line) return d
    const no = this.lineNo++
    // cheap skip of bulky bookkeeping records without parsing them
    const head = /"type":"(\w+)","payload":\{"type":"(\w+)"/.exec(line.slice(0, 200))
    const outer = head?.[1] ?? /^\{[^{]{0,120}?"type":"(\w+)"/.exec(line)?.[1]
    if (outer === 'token_usage_record' || outer === 'world_state' || outer === 'turn_context') {
      this.goodLines++
      return d
    }
    if (outer === 'event_msg' && head && head[2] !== 'turn_aborted') {
      this.goodLines++
      return d
    }
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      this.badLines++
      return d
    }
    this.goodLines++
    try {
      this.record(o, no, d)
    } catch {
      // unknown shape: skip
    }
    return d
  }

  private record(o: any, no: number, d: Delta) {
    if (!o || typeof o !== 'object') return
    const p = o.payload
    if (!p || typeof p !== 'object') return
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    const base = Number.isFinite(ts) ? { ts } : {}
    if (o.type === 'session_meta') {
      if (no === 0) {
        this.ownPath = typeof p.agent_path === 'string' ? p.agent_path : ''
        this.holdHistory = this.asSubagent && !!p.source?.subagent && !!p.forked_from_id
      }
      return
    }
    if (o.type === 'event_msg') {
      if (p.type === 'turn_aborted') this.add({ id: `c${no}`, kind: 'system', text: 'Interrupted', ...base }, d)
      return
    }
    if (o.type !== 'response_item') return

    switch (p.type) {
      case 'message': {
        const parts: any[] = Array.isArray(p.content) ? p.content : []
        if (p.role === 'user') {
          for (const q of this.questions.values()) this.replace(q.entryId, (cur) => cur.kind === 'question' ? { ...cur, answered: true } : cur, d)
          this.questions.clear()
          parts.forEach((c, i) => {
            if (!c || typeof c.text !== 'string') return
            const t = cleanCodexUser(c.text)
            if (t) this.add({ id: `c${no}.${i}`, kind: 'user', text: t, ...base }, d)
          })
        } else if (p.role === 'assistant') {
          const t = parts.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('').trim()
          if (t) this.add({ id: `c${no}`, kind: 'assistant', text: t, ...base }, d)
        }
        return
      }
      case 'agent_message': {
        // task / follow-up delivered to this subagent (the text is usually encrypted)
        if (!this.asSubagent) return
        if (this.holdHistory) {
          this.holdHistory = false
          this.reset()
        }
        const plain = (Array.isArray(p.content) ? p.content : [])
          .filter((c: any) => c?.type === 'input_text' && typeof c.text === 'string')
          .map((c: any) => c.text as string)
          .join('\n')
          .replace(/^Message Type:[\s\S]*?Payload:\s*/m, '')
          .trim()
        const from = typeof p.author === 'string' ? humanizeAgentPath(p.author) : 'parent'
        const what = this.ownPath ? humanizeAgentPath(this.ownPath) : ''
        this.add({ id: `c${no}`, kind: 'system', text: plain ? `Task from ${from}: ${clip(plain, 160)}` : `Task from ${from}${what ? `: ${what}` : ''}`, ...base }, d)
        return
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = typeof p.name === 'string' ? p.name : ''
        const callId = typeof p.call_id === 'string' ? p.call_id : ''
        const input = p.type === 'function_call' ? p.arguments : p.input
        const id = `c${no}`
        if (name === 'request_user_input' || name === 'request_user_input_async') {
          const raw = argsOf(input).questions
          const questions = (Array.isArray(raw) ? raw : []).flatMap((q: any) => {
            if (!q || typeof q !== 'object') return []
            const prompt = typeof q.question === 'string' ? q.question : typeof q.title === 'string' ? q.title : ''
            if (!prompt) return []
            const options = (Array.isArray(q.options) ? q.options : []).flatMap((o: any) =>
              typeof o === 'string' ? [o] : o && typeof o.label === 'string' ? [o.label] : [])
            return [{ prompt, options }]
          })
          if (questions.length) {
            const text = questions.map((q: { prompt: string; options: string[] }, i: number) =>
              `${questions.length > 1 ? `${i + 1}. ` : ''}${q.prompt}${q.options.length ? '\n' + q.options.map((o, n) => `  ${n + 1}. ${o}`).join('\n') : ''}`).join('\n\n')
            this.add({ id, kind: 'question', text, questions, answered: false, reply: name === 'request_user_input_async' ? 'message' : 'keys', ...base }, d)
            if (callId) this.questions.set(callId, { entryId: id, async: name === 'request_user_input_async' })
          }
          return
        }
        if (name === 'spawn_agent') {
          const task = typeof argsOf(input).task_name === 'string' ? (argsOf(input).task_name as string) : ''
          const label = humanizeAgentPath(task) || 'agent'
          const e: ChatEntry = { id, kind: 'subagent', text: label, ...base }
          this.add(e, d)
          if (callId) this.spawnCalls.set(callId, { entryId: id, task: label })
          return
        }
        if (name === 'wait' && callId) {
          const cell = argsOf(input).cell_id
          const eid = cell !== undefined ? this.cellEntry.get(String(cell)) : undefined
          if (eid) this.callEntry.set(callId, eid)
          else this.hidden.add(callId)
          return
        }
        const text = codexToolLine(name, input)
        if (text === null) {
          if (callId) this.hidden.add(callId)
          return
        }
        this.add({ id, kind: 'tool', text, ...base }, d)
        if (callId) this.callEntry.set(callId, id)
        return
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = typeof p.call_id === 'string' ? p.call_id : ''
        const question = this.questions.get(callId)
        if (question) {
          if (!question.async) {
            this.replace(question.entryId, (cur) => cur.kind === 'question' ? { ...cur, answered: true } : cur, d)
            this.questions.delete(callId)
          }
          return
        }
        const sp = this.spawnCalls.get(callId)
        if (sp) {
          // {"task_name":"/root/<task>"} is the child's agent_path
          let path = ''
          try {
            const j = JSON.parse(outputText(p.output))
            if (typeof j?.task_name === 'string') path = j.task_name
          } catch {}
          if (path) this.spawns.set(sp.entryId, { key: path, task: sp.task })
          return
        }
        const eid = this.callEntry.get(callId)
        if (!eid) return
        const raw = outputText(p.output)
        const cell = /^Script running with cell ID (\S+)/.exec(raw)?.[1]
        if (cell) this.cellEntry.set(cell, eid)
        const r = codexResult(p.output)
        if (!r) return
        for (const [c, e] of this.cellEntry) if (e === eid) this.cellEntry.delete(c)
        this.replace(eid, (cur) => {
          const base1 = cur.text.split('\n')[0]!
          const mark = r.ok ? '✓' : '✗'
          return { ...cur, text: r.line ? `${base1}\n${mark} ${r.line}` : `${base1}\n${mark}` }
        }, d)
        return
      }
      // reasoning, developer notes, everything else: hidden
    }
  }

  protected override spawnText(_cur: ChatEntry, info: SubagentInfo, task: string): string {
    return task ? `${info.label} · ${task}` : info.label
  }
}
