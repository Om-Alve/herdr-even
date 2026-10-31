import type { ChatEntry, SubagentSummary } from '@herdr-even/protocol'

export interface Delta {
  appended: ChatEntry[]
  updated: ChatEntry[]
}

/** A subagent as the bridge sees it: the wire summary plus how to link and read it. Never sent as is. */
export interface SubagentInfo extends SubagentSummary {
  /** What the parent's spawn call carries: Claude `toolUseId`, Codex `agent_path`. */
  key: string
  /** Transcript file of the subagent. */
  path: string
}

export const toSummary = ({ key: _k, path: _p, ...s }: SubagentInfo): SubagentSummary => s

const MAX_LINE = 100
export const clip = (s: string, n = MAX_LINE) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
export const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? ''

/** Shared entry bookkeeping for the agent transcript models (Claude, Codex). Pure: feed it JSONL lines. */
export abstract class ChatModel {
  entries: ChatEntry[] = []
  protected index = new Map<string, number>()
  /** Spawn entry id -> how to find its subagent (`key`, see SubagentInfo) and the task it was given. */
  protected spawns = new Map<string, { key: string; task: string }>()
  /** Number of lines that could not be parsed (for diagnostics / fallback decisions). */
  badLines = 0
  goodLines = 0

  /** Ingest one JSONL line. Never throws. */
  abstract ingest(line: string): Delta

  protected add(e: ChatEntry, d: Delta) {
    if (this.index.has(e.id)) return
    this.index.set(e.id, this.entries.length)
    this.entries.push(e)
    d.appended.push(e)
  }

  protected replace(id: string, f: (cur: ChatEntry) => ChatEntry, d: Delta) {
    const at = this.index.get(id)
    if (at === undefined) return
    const next = f(this.entries[at]!)
    this.entries[at] = next
    d.updated.push(next)
  }

  protected reset() {
    this.entries = []
    this.index.clear()
    this.spawns.clear()
  }

  protected addSpawn(e: ChatEntry, key: string, task: string, d: Delta) {
    this.spawns.set(e.id, { key, task })
    this.add(e, d)
  }

  /** Text of a spawn entry once its subagent is known. */
  protected spawnText(cur: ChatEntry, _info: SubagentInfo, _task: string): string {
    return cur.text
  }

  /** Link spawn entries to the pane's subagents. Returns the entries that changed. */
  resolveSpawns(list: SubagentInfo[]): ChatEntry[] {
    const out: ChatEntry[] = []
    if (!this.spawns.size) return out
    const byKey = new Map(list.map((s) => [s.key, s]))
    for (const [eid, sp] of this.spawns) {
      const info = sp.key ? byKey.get(sp.key) : undefined
      const at = this.index.get(eid)
      if (!info || at === undefined) continue
      const cur = this.entries[at]!
      const text = this.spawnText(cur, info, sp.task)
      if (cur.subagent === info.id && cur.text === text) continue
      const next = { ...cur, text, subagent: info.id }
      this.entries[at] = next
      out.push(next)
    }
    return out
  }

  /** Last `limit` entries, with whether older ones exist. */
  tail(limit = 40): { entries: ChatEntry[]; hasOlder: boolean } {
    const start = Math.max(0, this.entries.length - limit)
    return { entries: this.entries.slice(start), hasOlder: start > 0 }
  }

  /** Entries strictly older than `before`, oldest first. Null when `before` is unknown. */
  older(before: string, limit = 50): { entries: ChatEntry[]; hasOlder: boolean } | null {
    const at = this.index.get(before)
    if (at === undefined) return null
    const start = Math.max(0, at - limit)
    return { entries: this.entries.slice(start, at), hasOlder: start > 0 }
  }
}
