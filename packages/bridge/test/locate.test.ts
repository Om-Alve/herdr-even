import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptLocator, claudeProjectDir, pickFallbacks, type Candidate } from '../src/locate.ts'
import { SubagentIndex } from '../src/subagents.ts'

// All fixtures are synthetic.
const ago = (ms: number) => new Date(Date.now() - ms)
const HOUR = 3600_000

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'he-loc-'))
  const codexDir = join(root, 'codex')
  const claudeDir = join(root, 'claude')
  const loc = new TranscriptLocator({ codexDir, claudeDir, cursorDir: join(root, 'cursor'), openCodeDb: join(root, 'opencode.db'), piDir: join(root, 'pi') }, new SubagentIndex({ codexDir }))
  let n = 0
  const rollout = (id: string, cwd: string, ageMs: number, extra: any = {}) => {
    const day = join(codexDir, '2026', '10', '31')
    mkdirSync(day, { recursive: true })
    const f = join(day, `rollout-2026-10-31T10-00-0${n++}-${id}.jsonl`)
    writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli', ...extra } }) + '\n{"type":"x"}\n')
    utimesSync(f, ago(ageMs), ago(ageMs))
    return f
  }
  const claude = (cwd: string, id: string, ageMs: number, sub = false) => {
    const dir = join(claudeDir, claudeProjectDir(cwd), ...(sub ? ['s1', 'subagents'] : []))
    mkdirSync(dir, { recursive: true })
    const f = join(dir, `${id}.jsonl`)
    writeFileSync(f, '{}\n')
    utimesSync(f, ago(ageMs), ago(ageMs))
    return f
  }
  return { loc, rollout, claude }
}

describe('TranscriptLocator', () => {
  test('codex: newest non-subagent rollout with the cwd, within 24h', async () => {
    const { loc, rollout } = setup()
    const old = rollout('old', '/w/a', 2 * HOUR)
    const newest = rollout('new', '/w/a', 1 * HOUR)
    rollout('sub', '/w/a', 1000, { source: { subagent: { thread_spawn: {} } }, parent_thread_id: 'new' })
    rollout('other', '/w/b', 1000)
    rollout('stale', '/w/c', 30 * HOUR)
    const a = await loc.candidates('codex', '/w/a')
    expect(a.map((c) => c.path)).toEqual([newest, old])
    expect(a[0]!.id).toBe('new')
    expect(await loc.candidates('codex', '/w/c')).toEqual([])
    expect(await loc.candidates('codex', '/nope')).toEqual([])
  })

  test('claude: newest main transcript in the cwd project dir, subagents ignored', async () => {
    const { loc, claude } = setup()
    claude('/w/a', 'older', 5 * HOUR)
    const newest = claude('/w/a', 'newer', 1 * HOUR)
    claude('/w/a', 'agent-x', 1000, true)
    const c = await loc.candidates('claude', '/w/a')
    expect(c[0]!.path).toBe(newest)
    expect(c[0]!.id).toBe('newer')
    expect(c.length).toBe(2)
  })

  test('lookups are cached for a short TTL', async () => {
    const { loc, rollout } = setup()
    rollout('one', '/w/a', 1000)
    expect((await loc.candidates('codex', '/w/a')).length).toBe(1)
    rollout('two', '/w/a', 500)
    expect((await loc.candidates('codex', '/w/a')).length).toBe(1)
  })
})

describe('pickFallbacks', () => {
  const cand = (path: string): Candidate => ({ path, id: path, mtime: 1 })
  const pane = (key: string, o: any = {}) => ({ key, paneId: key, agent: 'codex', cwd: '/w/a', reported: false, transcript: null, ...o })

  test('unique match', () => {
    const r = pickFallbacks([pane('p1')], new Map([['codex:/w/a', [cand('/r1')]]]))
    expect(r.picks.get('p1')?.path).toBe('/r1')
  })
  test('ambiguous: two panes of the same agent and cwd get nothing', () => {
    const r = pickFallbacks([pane('p1'), pane('p2')], new Map([['codex:/w/a', [cand('/r1')]]]))
    expect(r.picks.size).toBe(0)
    expect([...r.ambiguous.get('codex:/w/a')!]).toEqual(['p1', 'p2'])
  })
  test('a pane of another agent in the same cwd is not ambiguous', () => {
    const r = pickFallbacks([pane('p1'), pane('p2', { agent: 'claude' })], new Map([['codex:/w/a', [cand('/r1')]], ['claude:/w/a', [cand('/c1')]]]))
    expect(r.picks.get('p1')?.path).toBe('/r1')
    expect(r.picks.get('p2')?.path).toBe('/c1')
  })
  test('a pane that reports a session does not count toward ambiguity', () => {
    const r = pickFallbacks([pane('p1'), pane('p2', { reported: true, transcript: '/r9' })], new Map([['codex:/w/a', [cand('/r1')]]]))
    expect(r.picks.get('p1')?.path).toBe('/r1')
  })
  test('transcripts claimed by a reporting pane are skipped', () => {
    const r = pickFallbacks([pane('p1'), pane('p2', { reported: true, transcript: '/r1' })], new Map([['codex:/w/a', [cand('/r1'), cand('/r2')]]]))
    expect(r.picks.get('p1')?.path).toBe('/r2')
    const none = pickFallbacks([pane('p1'), pane('p2', { reported: true, transcript: '/r1' })], new Map([['codex:/w/a', [cand('/r1')]]]))
    expect(none.picks.size).toBe(0)
  })
  test('no cwd or non-transcript agents are ignored', () => {
    const r = pickFallbacks([pane('p1', { cwd: null }), pane('p2', { agent: 'cursor' })], new Map())
    expect(r.picks.size).toBe(0)
    expect(r.ambiguous.size).toBe(0)
  })
})

describe('startOrExit', () => {
  test('exits non-zero when startup throws, passes the value through otherwise', async () => {
    const { startOrExit } = await import('../src/server.ts')
    const logs: string[] = []
    let code = -1
    const exit = ((c: number) => { code = c; return undefined as never }) as (c: number) => never
    expect(startOrExit(() => 42, (m) => logs.push(m), exit)).toBe(42)
    expect(code).toBe(-1)
    startOrExit(() => { throw new Error('Failed to start server. Is port 8791 in use?') }, (m) => logs.push(m), exit)
    expect(code).toBe(1)
    expect(logs[0]).toContain('port 8791')
  })
  test('a real port conflict throws', () => {
    const a = Bun.serve({ port: 0, fetch: () => new Response('x') })
    try {
      expect(() => Bun.serve({ port: a.port, fetch: () => new Response('y') })).toThrow()
    } finally { a.stop(true) }
  })
})
