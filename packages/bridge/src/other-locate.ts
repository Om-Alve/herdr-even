import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Candidate } from './locate.ts'

const safeId = (id: string) => /^[A-Za-z0-9_-]+$/.test(id)
const names = (dir: string): string[] => { try { return readdirSync(dir) } catch { return [] } }
const mtime = (path: string): number | null => { try { return statSync(path).mtimeMs } catch { return null } }
const piCwd = (path: string): string | null => {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const line = buf.subarray(0, n).toString('utf8').split('\n')[0]
    const header = JSON.parse(line)
    return header?.type === 'session' && typeof header.cwd === 'string' ? header.cwd : null
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}
const recent = (items: Candidate[], now: number) => items.filter(c => c.mtime >= now - 24 * 3600_000).sort((a, b) => b.mtime - a.mtime)

const cursorProject = (cwd: string) => cwd.replace(/^\//, '').replace(/\//g, '-')
const cursorTranscript = (root: string, project: string, id: string) => join(root, project, 'agent-transcripts', id, `${id}.jsonl`)

export function locateCursor(root: string, id: string): string | null {
  if (!safeId(id)) return null
  for (const project of names(root)) {
    const path = cursorTranscript(root, project, id)
    if (existsSync(path)) return path
  }
  return null
}

export function cursorCandidates(root: string, cwd: string, now = Date.now()): Candidate[] {
  const dir = join(root, cursorProject(cwd), 'agent-transcripts')
  const out: Candidate[] = []
  for (const id of names(dir)) {
    if (!safeId(id)) continue
    const path = join(dir, id, `${id}.jsonl`)
    const at = mtime(path)
    if (at !== null) out.push({ path, id, mtime: at })
  }
  return recent(out, now)
}

export function locatePi(root: string, id: string): string | null {
  if (!safeId(id)) return null
  for (const dir of names(root)) {
    for (const file of names(join(root, dir))) {
      if (file.endsWith(`_${id}.jsonl`) || file === `${id}.jsonl`) return join(root, dir, file)
    }
  }
  return null
}

export function piCandidates(root: string, cwd: string, now = Date.now()): Candidate[] {
  const encoded = cwd.replace(/\//g, '-')
  const out: Candidate[] = []
  for (const dir of [`--${encoded}--`, `--${encoded.replace(/^-/, '')}--`, encoded]) {
    for (const file of names(join(root, dir))) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(root, dir, file)
      const at = mtime(path)
      const id = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(file)?.[1] ?? file.slice(0, -6)
      if (at !== null && safeId(id) && piCwd(path) === cwd) out.push({ path, id, mtime: at })
    }
  }
  return recent(out, now)
}
