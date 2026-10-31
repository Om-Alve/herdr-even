import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Snippet } from '@herdr-even/protocol'
import { isAllowedKey } from '@herdr-even/protocol'

export interface Config {
  owner: string | null
  host: string
  port: number
  snippets: Snippet[]
  devNoAuth: boolean
  /** Directory holding config.json and plugin-log.jsonl. */
  configDir: string
  /** Herdr config dir (default session socket, sessions/<name>/herdr.sock). */
  herdrDir: string
  /** Claude Code projects dir. */
  claudeDir: string
  /** Codex sessions dir (`~/.codex/sessions`). */
  codexDir: string
  /** Cursor agent transcript projects dir. */
  cursorDir: string
  /** OpenCode SQLite database. */
  openCodeDb: string
  /** Pi session files dir. */
  piDir: string
}

export const DEFAULT_SNIPPETS: Snippet[] = [
  { label: 'continue', text: 'continue', enter: true },
  { label: 'yes', text: 'yes', enter: true },
  { label: 'no', text: 'no', enter: true },
  { label: '/clear', text: '/clear', enter: true },
  { label: 'git status', text: 'git status', enter: true },
  { label: 'ctrl+d', keys: ['ctrl+d'] },
]

const isLoopback = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost'

export function sanitizeSnippets(v: unknown): Snippet[] {
  if (!Array.isArray(v)) return DEFAULT_SNIPPETS
  const out: Snippet[] = []
  for (const s of v) {
    if (!s || typeof s !== 'object' || typeof (s as any).label !== 'string') continue
    const x = s as any
    const sn: Snippet = { label: x.label }
    if (Array.isArray(x.keys) && x.keys.every((k: unknown) => typeof k === 'string' && isAllowedKey(k))) sn.keys = x.keys
    if (typeof x.text === 'string') sn.text = x.text
    if (x.enter === true) sn.enter = true
    if (sn.keys || sn.text !== undefined) out.push(sn)
  }
  return out
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const home = homedir()
  const configDir = env.HERDR_EVEN_CONFIG_DIR ?? join(home, '.config/herdr-even')
  const file = join(configDir, 'config.json')
  let raw: any = {}
  if (!existsSync(file)) {
    try {
      mkdirSync(configDir, { recursive: true })
      writeFileSync(file, JSON.stringify({ host: '127.0.0.1', port: 8791, snippets: DEFAULT_SNIPPETS }, null, 2) + '\n')
      console.log(`created ${file} (set "owner" to your Tailscale login)`)
    } catch (e) {
      console.warn(`could not create ${file}: ${e}`)
    }
  } else {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`cannot parse ${file}: ${e}`)
    }
  }
  const owner = (env.HERDR_EVEN_OWNER ?? (typeof raw.owner === 'string' ? raw.owner : '')).trim() || null
  const host = env.HERDR_EVEN_HOST ?? (typeof raw.host === 'string' ? raw.host : '127.0.0.1')
  const port = Number(env.HERDR_EVEN_PORT ?? raw.port ?? 8791)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`)
  const wantDev = env.HERDR_EVEN_DEV_NOAUTH === '1'
  const devNoAuth = wantDev && isLoopback(host)
  if (wantDev && !devNoAuth) console.warn(`HERDR_EVEN_DEV_NOAUTH ignored: host ${host} is not loopback`)
  return {
    owner,
    host,
    port,
    snippets: raw.snippets === undefined ? DEFAULT_SNIPPETS : sanitizeSnippets(raw.snippets),
    devNoAuth,
    configDir,
    herdrDir: env.HERDR_EVEN_HERDR_DIR ?? join(home, '.config/herdr'),
    claudeDir: env.HERDR_EVEN_CLAUDE_DIR ?? join(home, '.claude/projects'),
    codexDir: env.HERDR_EVEN_CODEX_DIR ?? join(home, '.codex/sessions'),
    cursorDir: env.HERDR_EVEN_CURSOR_DIR ?? join(home, '.cursor/projects'),
    openCodeDb: env.HERDR_EVEN_OPENCODE_DB ?? join(home, '.local/share/opencode/opencode.db'),
    piDir: env.HERDR_EVEN_PI_DIR ?? join(home, '.pi/agent/sessions'),
  }
}
