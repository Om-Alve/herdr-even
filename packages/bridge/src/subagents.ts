import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { humanizeAgentPath } from './codex.ts'
import { clip, type SubagentInfo } from './model.ts'

/** A file touched this recently counts as working. */
export const RECENT_MS = 60_000
/** Claude: a spawn without a tool_result yet counts as working for at most this long after its last write. */
export const OPEN_CALL_MAX_MS = 15 * 60_000
/** Codex: a turn without task_complete counts as working for at most this long after its last write. */
export const OPEN_TURN_MAX_MS = 10 * 60_000
const CACHE_MS = 3_000
const FIRST_LINE_CAP = 512 * 1024
const TAIL_BYTES = 128 * 1024

type Status = SubagentInfo['status']
type CodexLast = 'task_started' | 'task_complete' | 'turn_aborted' | null

/** Pure Claude status rule. `hasResult`: the parent transcript already holds a tool_result for the spawn. */
export function claudeStatus(m: { finished: boolean; hasResult: boolean; hasKey: boolean; ageMs: number }): Status {
  if (m.finished) return 'done'
  if (m.ageMs < RECENT_MS) return 'working'
  if (m.hasKey && !m.hasResult) return m.ageMs < OPEN_CALL_MAX_MS ? 'working' : 'unknown'
  return m.hasKey ? 'done' : 'unknown'
}

/** Pure Codex status rule from the last turn event in the child rollout. */
export function codexStatus(last: CodexLast, ageMs: number): Status {
  if (last === 'task_complete' || last === 'turn_aborted') return 'done'
  if (last === 'task_started') return ageMs < OPEN_TURN_MAX_MS ? 'working' : 'unknown'
  return ageMs < RECENT_MS ? 'working' : 'unknown'
}

const statOrNull = async (p: string) => {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

const listDir = async (p: string): Promise<string[]> => {
  try {
    return await readdir(p)
  } catch {
    return []
  }
}

/** First line of a file (up to a cap), or null. */
async function readFirstLine(path: string): Promise<string | null> {
  let fh
  try {
    fh = await open(path, 'r')
    const chunk = Buffer.alloc(64 * 1024)
    let acc = Buffer.alloc(0)
    for (let pos = 0; acc.length < FIRST_LINE_CAP; ) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos)
      if (bytesRead <= 0) break
      pos += bytesRead
      const nl = chunk.subarray(0, bytesRead).indexOf(10)
      if (nl >= 0) return Buffer.concat([acc, chunk.subarray(0, nl)]).toString('utf8')
      acc = Buffer.concat([acc, chunk.subarray(0, bytesRead)])
    }
    return acc.length < FIRST_LINE_CAP ? acc.toString('utf8') : null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Incrementally collects every `tool_use_id` that has a tool_result in a Claude transcript. */
class ResultScanner {
  ids = new Set<string>()
  private offset = 0
  private partial = ''
  private busy: Promise<void> | null = null

  constructor(private path: string) {}

  scan(): Promise<void> {
    return (this.busy ??= this.run().finally(() => (this.busy = null)))
  }

  private async run() {
    const st = await statOrNull(this.path)
    if (!st) return
    if (st.size < this.offset) {
      this.ids.clear()
      this.offset = 0
      this.partial = ''
    }
    if (st.size === this.offset) return
    const fh = await open(this.path, 'r')
    try {
      const buf = Buffer.alloc(1 << 20)
      while (this.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
        if (bytesRead <= 0) break
        this.offset += bytesRead
        const text = this.partial + buf.toString('utf8', 0, bytesRead)
        const lines = text.split('\n')
        this.partial = lines.pop() ?? ''
        for (const l of lines) {
          if (!l.includes('"tool_result"')) continue
          for (const m of l.matchAll(/"tool_use_id":"([^"]+)"/g)) this.ids.add(m[1]!)
        }
        await new Promise((r) => setImmediate(r))
      }
    } finally {
      await fh.close()
    }
  }
}

interface CodexMeta {
  id: string
  parent: string
  agentPath: string
  label: string
  startedAt: number
}

/** Discovers and describes a pane's subagents. Cheap and cached: safe to call every few seconds. */
export class SubagentIndex {
  private claudeMeta = new Map<string, { mtime: number; meta: any }>()
  private scanners = new Map<string, ResultScanner>()
  private codexFirst = new Map<string, CodexMeta | null>() // rollout path -> parsed first line
  private codexTail = new Map<string, { mtime: number; size: number; last: CodexLast }>()
  private cache = new Map<string, { at: number; list: SubagentInfo[] }>()
  private inflight = new Map<string, Promise<SubagentInfo[]>>()

  private codexSession = new Map<string, { id: string; cwd: string; subagent: boolean } | null>() // rollout path -> session_meta basics

  constructor(private cfg: { codexDir: string }) {}

  /** `session_meta` basics of a Codex rollout (cached forever: the first line never changes). Null when unreadable. */
  async codexSessionMeta(path: string): Promise<{ id: string; cwd: string; subagent: boolean } | null> {
    if (this.codexSession.has(path)) return this.codexSession.get(path)!
    let out: { id: string; cwd: string; subagent: boolean } | null = null
    const line = await readFirstLine(path)
    if (line) {
      try {
        const rec = JSON.parse(line)
        const p = rec?.payload
        if (rec?.type === 'session_meta' && p && typeof p.id === 'string') {
          out = { id: p.id, cwd: typeof p.cwd === 'string' ? p.cwd : '', subagent: p.source?.subagent != null || typeof p.parent_thread_id === 'string' }
        }
      } catch {}
    }
    if (out || line === null) this.codexSession.set(path, out)
    if (this.codexSession.size > 5000) this.codexSession.delete(this.codexSession.keys().next().value!)
    return out
  }

  /**
   * Subagents of one pane, oldest first. `transcript` is the pane's own transcript path (Claude project file or
   * Codex rollout), `sessionId` its agent session id.
   */
  list(agent: string | null, sessionId: string | null, transcript: string | null, fresh = false): Promise<SubagentInfo[]> {
    if (!sessionId || !transcript || (agent !== 'claude' && agent !== 'codex')) return Promise.resolve([])
    const key = `${agent}:${sessionId}`
    const hit = this.cache.get(key)
    if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.list)
    let p = this.inflight.get(key)
    if (!p) {
      p = (agent === 'claude' ? this.listClaude(transcript, sessionId) : this.listCodex(transcript, sessionId))
        .catch(() => hit?.list ?? [])
        .then((list) => {
          this.cache.set(key, { at: Date.now(), list })
          if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
          return list
        })
        .finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
  }

  async find(agent: string | null, sessionId: string | null, transcript: string | null, id: string): Promise<SubagentInfo | null> {
    const l = await this.list(agent, sessionId, transcript)
    return l.find((s) => s.id === id) ?? (await this.list(agent, sessionId, transcript, true)).find((s) => s.id === id) ?? null
  }

  // ------------------------------------------------------------------ Claude

  private async listClaude(parentPath: string, sessionId: string): Promise<SubagentInfo[]> {
    const dir = join(dirname(parentPath), sessionId, 'subagents')
    const files = (await listDir(dir)).filter((f) => /^agent-[A-Za-z0-9_-]+\.meta\.json$/.test(f))
    if (!files.length) return []
    const rows: { info: SubagentInfo; birth: number; meta: any }[] = []
    const now = Date.now()
    for (const f of files) {
      const id = f.slice('agent-'.length, -'.meta.json'.length)
      const path = join(dir, `agent-${id}.jsonl`)
      const st = await statOrNull(path)
      if (!st) continue
      const mp = join(dir, f)
      const mst = await statOrNull(mp)
      let cached = this.claudeMeta.get(mp)
      if (mst && (!cached || cached.mtime !== mst.mtimeMs)) {
        let meta: any = {}
        try {
          meta = JSON.parse(await readFile(mp, 'utf8')) ?? {}
        } catch {}
        cached = { mtime: mst.mtimeMs, meta }
        this.claudeMeta.set(mp, cached)
      }
      const meta = cached?.meta ?? {}
      rows.push({
        meta,
        birth: st.birthtimeMs || st.mtimeMs,
        info: {
          id,
          key: typeof meta.toolUseId === 'string' ? meta.toolUseId : '',
          path,
          label: typeof meta.agentType === 'string' && meta.agentType ? meta.agentType : 'agent',
          description: clip(typeof meta.description === 'string' ? meta.description : '', 80),
          status: 'unknown',
          lastActivity: Math.round(st.mtimeMs),
        },
      })
    }
    // the parent's tool_results only matter for subagents that are not marked finished
    let results: Set<string> | null = null
    if (rows.some((r) => r.meta.finished !== true && r.info.key)) {
      let sc = this.scanners.get(parentPath)
      if (!sc) this.scanners.set(parentPath, (sc = new ResultScanner(parentPath)))
      if (this.scanners.size > 50) this.scanners.delete(this.scanners.keys().next().value!)
      await sc.scan().catch(() => {})
      results = sc.ids
    }
    for (const r of rows)
      r.info.status = claudeStatus({
        finished: r.meta.finished === true,
        hasResult: !!results && results.has(r.info.key),
        hasKey: !!r.info.key,
        ageMs: now - (r.info.lastActivity ?? 0),
      })
    return rows.sort((a, b) => a.birth - b.birth).map((r) => r.info)
  }

  // ------------------------------------------------------------------ Codex

  private async codexMeta(path: string): Promise<CodexMeta | null> {
    if (this.codexFirst.has(path)) return this.codexFirst.get(path)!
    let out: CodexMeta | null = null
    const line = await readFirstLine(path)
    if (line) {
      try {
        const p = JSON.parse(line)?.payload
        const sp = p?.source?.subagent?.thread_spawn
        if (p && typeof p.parent_thread_id === 'string' && sp && typeof p.id === 'string') {
          const agentPath = String(p.agent_path ?? sp.agent_path ?? '')
          const t = Date.parse(String(p.timestamp ?? ''))
          out = {
            id: p.id,
            parent: p.parent_thread_id,
            agentPath,
            label: String(p.agent_nickname ?? sp.agent_nickname ?? sp.agent_role ?? 'agent'),
            startedAt: Number.isFinite(t) ? t : 0,
          }
        }
      } catch {}
    }
    this.codexFirst.set(path, out)
    return out
  }

  /** The last turn event (task_started / task_complete / turn_aborted) near the end of a rollout. */
  private async codexLast(path: string, mtime: number, size: number) {
    const c = this.codexTail.get(path)
    if (c && c.mtime === mtime && c.size === size) return c.last
    let last: CodexLast = null
    let fh
    try {
      fh = await open(path, 'r')
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, size - len)
      const lines = buf.toString('utf8', 0, bytesRead).split('\n')
      if (size > len) lines.shift() // partial first line
      for (let i = lines.length - 1; i >= 0 && !last; i--) {
        const m = /"payload":\{"type":"(task_started|task_complete|turn_aborted)"/.exec(lines[i]!.slice(0, 200))
        if (m) last = m[1] as CodexLast
      }
    } catch {
    } finally {
      await fh?.close().catch(() => {})
    }
    this.codexTail.set(path, { mtime, size, last })
    if (this.codexTail.size > 500) this.codexTail.delete(this.codexTail.keys().next().value!)
    return last
  }

  private async listCodex(parentPath: string, sessionId: string): Promise<SubagentInfo[]> {
    // children are created after their parent: only look at the parent's day directory and later ones
    const dayDir = dirname(parentPath)
    const monthDir = dirname(dayDir)
    const yearDir = dirname(monthDir)
    const root = dirname(yearDir)
    const [y, m, d] = [basename(yearDir), basename(monthDir), basename(dayDir)]
    const parentName = basename(parentPath).slice('rollout-'.length)
    const dirs: string[] = []
    for (const yy of (await listDir(root)).sort()) {
      if (yy < y) continue
      for (const mm of (await listDir(join(root, yy))).sort()) {
        if (yy === y && mm < m) continue
        for (const dd of (await listDir(join(root, yy, mm))).sort()) {
          if (yy === y && mm === m && dd < d) continue
          dirs.push(join(root, yy, mm, dd))
        }
      }
    }
    const now = Date.now()
    const found: { info: SubagentInfo; startedAt: number }[] = []
    for (const dir of dirs) {
      for (const f of await listDir(dir)) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl') || f.endsWith(`-${sessionId}.jsonl`)) continue
        if (f.slice('rollout-'.length) < parentName.slice(0, 19)) continue // created before the parent
        const path = join(dir, f)
        const meta = await this.codexMeta(path)
        if (!meta || meta.parent !== sessionId) continue
        const st = await statOrNull(path)
        if (!st) continue
        const last = await this.codexLast(path, st.mtimeMs, st.size)
        found.push({
          startedAt: meta.startedAt,
          info: {
            id: meta.id,
            key: meta.agentPath,
            path,
            label: meta.label,
            description: clip(humanizeAgentPath(meta.agentPath), 80),
            status: codexStatus(last, now - st.mtimeMs),
            lastActivity: Math.round(st.mtimeMs),
          },
        })
      }
    }
    return found.sort((a, b) => a.startedAt - b.startedAt).map((x) => x.info)
  }
}
