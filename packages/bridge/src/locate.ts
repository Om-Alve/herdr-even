import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SubagentIndex } from './subagents.ts'
import { cursorCandidates, piCandidates } from './other-locate.ts'
import { openCodeCandidates } from './opencode.ts'

/** How recently a Codex rollout must have been modified to be adopted without a session id. */
export const CODEX_MAX_AGE_MS = 24 * 3600_000
/** How many day directories (newest first) the Codex scan looks into; a rollout can be old but still active. */
const CODEX_DAYS = 8
const TTL_MS = 10_000

const list = async (d: string): Promise<string[]> => {
  try {
    return await readdir(d)
  } catch {
    return []
  }
}
const mtimeOf = async (p: string): Promise<number | null> => {
  try {
    return (await stat(p)).mtimeMs
  } catch {
    return null
  }
}
const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
export type TranscriptAgent = 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi'
export const hasTranscriptAdapter = (agent: string | null): agent is TranscriptAgent =>
  agent === 'claude' || agent === 'codex' || agent === 'cursor' || agent === 'opencode' || agent === 'pi'

/** Claude's project directory name for a cwd: every non-alphanumeric character becomes `-`. */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export interface Candidate {
  path: string
  /** The agent's own session id (Claude: file name; Codex: session_meta id). */
  id: string
  mtime: number
}

/**
 * Finds the transcript of an agent pane whose Herdr integration doesn't report a session id, by cwd and recency.
 * Lookups are cached per (agent, cwd) for a few seconds; the Codex scan itself is shared and reuses the
 * SubagentIndex's session_meta cache.
 */
export class TranscriptLocator {
  private codexScan: { at: number; list: (Candidate & { cwd: string })[] } | null = null
  private codexInflight: Promise<(Candidate & { cwd: string })[]> | null = null
  private cache = new Map<string, { at: number; list: Candidate[] }>()

  constructor(private cfg: { claudeDir: string; codexDir: string; cursorDir: string; openCodeDb: string; piDir: string }, private index: SubagentIndex, private now: () => number = Date.now) {}

  /** Candidates for this agent and cwd, most recently modified first. */
  async candidates(agent: TranscriptAgent, cwd: string): Promise<Candidate[]> {
    const key = `${agent}:${cwd}`
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < TTL_MS) return hit.list
    const list = agent === 'claude' ? await this.claude(cwd)
      : agent === 'codex' ? (await this.codexAll()).filter((c) => c.cwd === cwd)
      : agent === 'cursor' ? cursorCandidates(this.cfg.cursorDir, cwd, this.now())
      : agent === 'pi' ? piCandidates(this.cfg.piDir, cwd, this.now())
      : openCodeCandidates(this.cfg.openCodeDb, cwd, this.now())
    this.cache.set(key, { at: this.now(), list })
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
    return list
  }

  private async claude(cwd: string): Promise<Candidate[]> {
    const dir = join(this.cfg.claudeDir, claudeProjectDir(cwd))
    const out: Candidate[] = []
    for (const f of await list(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(dir, f)
      const mtime = await mtimeOf(path)
      if (mtime !== null) out.push({ path, id: basename(f, '.jsonl'), mtime })
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  private codexAll(): Promise<(Candidate & { cwd: string })[]> {
    if (this.codexScan && this.now() - this.codexScan.at < TTL_MS) return Promise.resolve(this.codexScan.list)
    return (this.codexInflight ??= this.scanCodex()
      .then((l) => ((this.codexScan = { at: this.now(), list: l }), l))
      .finally(() => (this.codexInflight = null)))
  }

  private async scanCodex(): Promise<(Candidate & { cwd: string })[]> {
    const root = this.cfg.codexDir
    const days: string[] = []
    outer: for (const y of (await list(root)).sort(desc))
      for (const m of (await list(join(root, y))).sort(desc))
        for (const d of (await list(join(root, y, m))).sort(desc)) {
          days.push(join(root, y, m, d))
          if (days.length >= CODEX_DAYS) break outer
        }
    const out: (Candidate & { cwd: string })[] = []
    const cutoff = this.now() - CODEX_MAX_AGE_MS
    for (const dir of days) {
      for (const f of await list(dir)) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue
        const path = join(dir, f)
        const mtime = await mtimeOf(path)
        if (mtime === null || mtime < cutoff) continue // cheap check first: the first line is only read for fresh files
        const meta = await this.index.codexSessionMeta(path)
        if (!meta || meta.subagent) continue
        out.push({ path, id: meta.id, mtime, cwd: meta.cwd })
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }
}

export interface FallbackPane {
  paneId: string
  agent: string | null
  cwd: string | null
  /** Herdr reported a session id. */
  reported: boolean
  transcript: string | null
  sessionId?: string | null
}

/**
 * Pure decision: which panes (by key) get which candidate. `all` is every pane on the machine (for claims and
 * ambiguity); `candidates` maps `${agent}:${cwd}` to its candidates. Returns key -> candidate and the ambiguous keys.
 */
export function pickFallbacks(
  all: (FallbackPane & { key: string })[],
  candidates: Map<string, Candidate[]>,
): { picks: Map<string, Candidate>; ambiguous: Map<string, string[]> } {
  const claimed = new Set(all.filter((p) => p.reported && p.transcript).map((p) => `${p.transcript}\0${p.sessionId ?? ''}`))
  const groups = new Map<string, string[]>()
  for (const p of all) {
    if (!hasTranscriptAdapter(p.agent) || p.reported || !p.cwd) continue
    const g = `${p.agent}:${p.cwd}`
    groups.set(g, [...(groups.get(g) ?? []), p.key])
  }
  const picks = new Map<string, Candidate>()
  const ambiguous = new Map<string, string[]>()
  for (const [g, keys] of groups) {
    if (keys.length > 1) {
      ambiguous.set(g, keys)
      continue
    }
    const c = (candidates.get(g) ?? []).find((x) => !claimed.has(`${x.path}\0${x.id}`) && !claimed.has(`${x.path}\0`))
    if (c) picks.set(keys[0]!, c)
  }
  return { picks, ambiguous }
}
