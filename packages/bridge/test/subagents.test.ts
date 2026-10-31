import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeTranscript } from '../src/claude.ts'
import { SubagentIndex, claudeStatus, codexStatus } from '../src/subagents.ts'

// All fixtures are synthetic.
const ago = (ms: number) => new Date(Date.now() - ms)
const touch = (p: string, ms: number) => utimesSync(p, ago(ms), ago(ms))
const j = (o: any) => JSON.stringify(o) + '\n'

describe('status rules', () => {
  test('claude', () => {
    const base = { finished: false, hasResult: false, hasKey: true, ageMs: 5_000 }
    expect(claudeStatus({ ...base, finished: true, ageMs: 1 })).toBe('done')
    expect(claudeStatus(base)).toBe('working') // recent write
    expect(claudeStatus({ ...base, ageMs: 5 * 60_000 })).toBe('working') // open spawn call, quiet for a while
    expect(claudeStatus({ ...base, ageMs: 60 * 60_000 })).toBe('unknown') // open call but long dead
    expect(claudeStatus({ ...base, hasResult: true, ageMs: 5 * 60_000 })).toBe('done')
    expect(claudeStatus({ ...base, hasResult: true, ageMs: 5_000 })).toBe('working') // background agent: result is the launch ack
    expect(claudeStatus({ ...base, hasKey: false, ageMs: 5 * 60_000 })).toBe('unknown')
  })
  test('codex', () => {
    expect(codexStatus('task_complete', 1)).toBe('done')
    expect(codexStatus('turn_aborted', 1)).toBe('done')
    expect(codexStatus('task_started', 5 * 60_000)).toBe('working')
    expect(codexStatus('task_started', 60 * 60_000)).toBe('unknown')
    expect(codexStatus(null, 1000)).toBe('working')
    expect(codexStatus(null, 60 * 60_000)).toBe('unknown')
  })
})

describe('Claude subagents', () => {
  const root = mkdtempSync(join(tmpdir(), 'he-sa-claude-'))
  const SID = 'sess-1'
  const parent = join(root, '-proj', `${SID}.jsonl`)
  const dir = join(root, '-proj', SID, 'subagents')
  mkdirSync(dir, { recursive: true })
  const agent = (id: string, meta: any, ageMs: number) => {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta))
    const f = join(dir, `agent-${id}.jsonl`)
    writeFileSync(f, j({ type: 'user', uuid: `${id}-u`, isSidechain: true, agentId: id, message: { role: 'user', content: 'do the thing' } }))
    touch(f, ageMs)
  }
  agent('aaa1', { agentType: 'general-purpose', description: 'Build the bridge', toolUseId: 'toolu_A', finished: true }, 3_600_000)
  agent('bbb2', { agentType: 'Explore', description: 'Search the repo', toolUseId: 'toolu_B' }, 5 * 60_000) // quiet, call still open
  agent('ccc3', { agentType: 'general-purpose', description: 'Review', toolUseId: 'toolu_C' }, 5 * 60_000) // result already in parent
  agent('ddd4', { agentType: 'general-purpose', description: 'Fresh', toolUseId: 'toolu_D' }, 2_000)
  writeFileSync(join(dir, 'agent-bad5.meta.json'), '{not json')
  writeFileSync(join(dir, 'agent-bad5.jsonl'), '')
  touch(join(dir, 'agent-bad5.jsonl'), 2 * 3_600_000)
  writeFileSync(join(dir, 'agent-orphan.meta.json'), '{}') // no jsonl: skipped
  writeFileSync(
    parent,
    j({ type: 'assistant', uuid: 'p1', message: { content: [{ type: 'tool_use', id: 'toolu_C', name: 'Agent', input: {} }] } }) +
      j({ type: 'user', uuid: 'p2', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_C', content: 'ok' }] } }),
  )

  test('lists with description, label and status; tolerates bad meta', async () => {
    const idx = new SubagentIndex({ codexDir: join(root, 'none') })
    const list = await idx.list('claude', SID, parent, true)
    const by = Object.fromEntries(list.map((s) => [s.id, s]))
    expect(Object.keys(by).sort()).toEqual(['aaa1', 'bad5', 'bbb2', 'ccc3', 'ddd4'])
    expect(by.aaa1).toMatchObject({ label: 'general-purpose', description: 'Build the bridge', status: 'done', key: 'toolu_A' })
    expect(by.bbb2!.status).toBe('working')
    expect(by.ccc3!.status).toBe('done')
    expect(by.ddd4!.status).toBe('working')
    expect(by.bad5!.status).toBe('unknown')
    expect(by.bbb2!.lastActivity).toBeGreaterThan(Date.now() - 6 * 60_000)
    expect(await idx.find('claude', SID, parent, 'ddd4')).not.toBeNull()
    expect(await idx.find('claude', SID, parent, '../etc')).toBeNull()
    expect(await idx.list('claude', 'nope', parent, true)).toEqual([])
    expect(await idx.list('cursor', SID, parent)).toEqual([])
  })

  test('parent spawn entries become subagent entries and link by toolUseId', async () => {
    const t = new ClaudeTranscript()
    const d = t.ingest(j({ type: 'assistant', uuid: 'p9', message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'Agent', input: { description: 'Search the repo', subagent_type: 'Explore', prompt: 'x' } }] } }))
    expect(d.appended[0]).toMatchObject({ kind: 'subagent', text: 'Explore · Search the repo' })
    t.ingest(j({ type: 'user', uuid: 'p10', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'launched' }] } }))
    expect(t.entries[0]!.text).toBe('Explore · Search the repo') // no check mark on spawn entries
    const idx = new SubagentIndex({ codexDir: '' })
    const upd = t.resolveSpawns(await idx.list('claude', SID, parent, true))
    expect(upd[0]).toMatchObject({ subagent: 'bbb2', text: 'Explore · Search the repo' })
    // legacy tool name
    const t2 = new ClaudeTranscript()
    t2.ingest(j({ type: 'assistant', uuid: 'q', message: { content: [{ type: 'tool_use', id: 'toolu_Z', name: 'Task', input: { description: 'Old', subagent_type: 'general-purpose' } }] } }))
    expect(t2.entries[0]!.kind).toBe('subagent')
  })

  test('sidechain files only parse in sidechain mode', () => {
    const line = j({ type: 'assistant', uuid: 'x', isSidechain: true, agentId: 'a', message: { content: [{ type: 'text', text: 'hi' }] } })
    const main = new ClaudeTranscript()
    main.ingest(line)
    expect(main.entries).toHaveLength(0)
    const side = new ClaudeTranscript(true)
    side.ingest(line)
    expect(side.entries[0]!.text).toBe('hi')
  })
})

describe('Codex subagents', () => {
  const root = mkdtempSync(join(tmpdir(), 'he-sa-codex-'))
  const day = join(root, '2026/05/06')
  const nextDay = join(root, '2026/05/07')
  mkdirSync(day, { recursive: true })
  mkdirSync(nextDay, { recursive: true })
  const PARENT = 'p0000000-0000-0000-0000-000000000001'
  const rollout = (dir: string, ts: string, id: string, first: any, lines: string[], ageMs: number) => {
    const f = join(dir, `rollout-${ts}-${id}.jsonl`)
    writeFileSync(f, j({ type: 'session_meta', payload: { id, ...first } }) + lines.join(''))
    touch(f, ageMs)
    return f
  }
  const spawnMeta = (parent: string, path: string, nick: string, timestamp = '2026-05-06T10:00:00Z') => ({
    parent_thread_id: parent, timestamp, agent_path: path, agent_nickname: nick,
    source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: path, agent_nickname: nick } } },
  })
  const ev = (type: string) => j({ type: 'event_msg', payload: { type } })
  const parentFile = rollout(day, '2026-05-06T09-00-00', PARENT, { source: 'cli' }, [], 1000)
  rollout(day, '2026-05-06T10-00-00', 'c1', spawnMeta(PARENT, '/root/alpha_job', 'Erdos'), [ev('task_started'), ev('task_complete')], 3_600_000)
  rollout(day, '2026-05-06T10-05-00', 'c2', spawnMeta(PARENT, '/root/beta_job', 'Dirac', '2026-05-06T10:05:00Z'), [ev('task_started'), ev('task_complete'), ev('task_started')], 90_000)
  rollout(nextDay, '2026-05-07T08-00-00', 'c3', spawnMeta(PARENT, '/root/gamma_job', 'Pascal', '2026-05-07T08:00:00Z'), [ev('task_started'), ev('turn_aborted')], 30_000)
  rollout(day, '2026-05-06T10-10-00', 'x1', spawnMeta('someone-else', '/root/other', 'Nope'), [], 1000) // other parent
  rollout(day, '2026-05-06T10-11-00', 'x2', { parent_thread_id: PARENT, source: { subagent: 'other' } }, [], 1000) // not a thread_spawn
  rollout(day, '2026-05-06T10-12-00', 'x3', { source: 'cli' }, [], 1000) // unrelated session
  writeFileSync(join(day, 'rollout-2026-05-06T10-13-00-bad.jsonl'), 'not json at all\n')
  rollout(day, '2026-05-06T08-00-00', 'old', spawnMeta(PARENT, '/root/older', 'Early'), [], 1000) // created before the parent

  test('finds children by parent_thread_id, with status from turn events', async () => {
    const idx = new SubagentIndex({ codexDir: root })
    const list = await idx.list('codex', PARENT, parentFile, true)
    expect(list.map((s) => [s.id, s.label, s.description, s.status, s.key])).toEqual([
      ['c1', 'Erdos', 'alpha job', 'done', '/root/alpha_job'],
      ['c2', 'Dirac', 'beta job', 'working', '/root/beta_job'],
      ['c3', 'Pascal', 'gamma job', 'done', '/root/gamma_job'],
    ])
    expect(list[1]!.lastActivity).toBeGreaterThan(Date.now() - 120_000)
    // cached: a second call returns the same list
    expect(await idx.list('codex', PARENT, parentFile)).toBe(list)
  })

  test('status follows new events after the cache expires', async () => {
    const idx = new SubagentIndex({ codexDir: root })
    const c1 = join(day, 'rollout-2026-05-06T10-00-00-c1.jsonl')
    writeFileSync(c1, j({ type: 'session_meta', payload: { id: 'c1', ...spawnMeta(PARENT, '/root/alpha_job', 'Erdos') } }) + ev('task_started'))
    const list = await idx.list('codex', PARENT, parentFile, true)
    expect(list.find((s) => s.id === 'c1')!.status).toBe('working')
  })
})
