import { describe, expect, test } from 'bun:test'
import { CodexTranscript, cleanCodexUser, codexResult, codexToolLine, codexTurnState, humanizeAgentPath, locateRollout } from '../src/codex.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// All fixtures are synthetic.
let ord = 0
const rec = (type: string, payload: any) => JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ordinal: ord++, type, payload })
const msg = (role: string, ...texts: string[]) =>
  rec('response_item', { type: 'message', role, content: texts.map((text) => ({ type: role === 'assistant' ? 'output_text' : 'input_text', text })) })
const call = (name: string, args: any, callId: string) => rec('response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId })
const out = (callId: string, output: any) => rec('response_item', { type: 'function_call_output', call_id: callId, output })
const custom = (name: string, input: string, callId: string) => rec('response_item', { type: 'custom_tool_call', name, input, call_id: callId })
const customOut = (callId: string, output: any) => rec('response_item', { type: 'custom_tool_call_output', call_id: callId, output })
const meta = (extra: any = {}) => rec('session_meta', { id: 'S1', cwd: '/x', source: 'cli', ...extra })

const feed = (t: CodexTranscript, lines: string[]) => lines.forEach((l) => t.ingest(l))

describe('CodexTranscript', () => {
  test('maps messages and hides developer, noise, reasoning and bookkeeping', () => {
    ord = 0
    const t = new CodexTranscript()
    feed(t, [
      meta(),
      rec('event_msg', { type: 'task_started', turn_id: 't' }),
      msg('developer', 'secret system rules'),
      msg('user', '# AGENTS.md instructions for /x\n\nbe nice', '<environment_context>\n<cwd>/x</cwd>\n</environment_context>'),
      rec('world_state', { state: {} }),
      rec('turn_context', { cwd: '/x' }),
      msg('user', 'fix the bug'),
      rec('response_item', { type: 'reasoning', summary: [], encrypted_content: 'zzz' }),
      msg('assistant', 'On it.'),
      rec('token_usage_record', {}),
      rec('event_msg', { type: 'token_count' }),
      'garbage line',
      rec('response_item', { type: 'message', role: 'assistant', content: 7 }),
    ])
    expect(t.entries.map((e) => [e.kind, e.text])).toEqual([
      ['user', 'fix the bug'],
      ['assistant', 'On it.'],
    ])
    expect(JSON.stringify(t.entries)).not.toContain('secret')
    expect(t.badLines).toBe(1)
    expect(new Set(t.entries.map((e) => e.id)).size).toBe(2)
  })

  test('tool one-liners and results', () => {
    ord = 0
    const t = new CodexTranscript()
    feed(t, [
      call('exec_command', { cmd: 'npm test\nsecond', workdir: '/x' }, 'c1'),
      out('c1', 'Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nall passed\n'),
      call('exec_command', { cmd: 'false' }, 'c2'),
      out('c2', 'Chunk ID: a\nWall time: 0.1 seconds\nProcess exited with code 1\nOutput:\n'),
      custom('apply_patch', '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch', 'c3'),
      customOut('c3', 'Exit code: 0\nWall time: 0.4 seconds\nOutput:\nSuccess. Updated the following files:\nM src/a.ts\n'),
      custom('exec', 'const r = await tools.exec_command({cmd:"ls -la",workdir:"/x"}); text(r.output)', 'c4'),
      customOut('c4', [{ type: 'input_text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'total 8\nfile' }) }]),
      custom('exec', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: lib/c.ts\\n@@"))', 'c5'),
      customOut('c5', [{ type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: 'Script error:\nboom' }]),
      call('wait', { cell_id: '9' }, 'w1'),
      call('list_agents', {}, 'l1'),
      out('l1', '{"agents":[]}'),
    ])
    expect(t.entries.map((e) => e.text)).toEqual([
      'Bash: npm test\n✓ all passed',
      'Bash: false\n✗',
      'apply_patch: src/a.ts, src/b.ts\n✓ Success. Updated the following files:',
      'Bash: ls -la\n✓ total 8',
      'apply_patch: lib/c.ts\n✗ boom',
    ])
    expect(t.entries.every((e) => e.kind === 'tool')).toBe(true)
  })

  test('long-running exec resolves through wait', () => {
    ord = 0
    const t = new CodexTranscript()
    feed(t, [
      custom('exec', 'tools.exec_command({cmd:"sleep 99"})', 'c1'),
      customOut('c1', 'Script running with cell ID 12\nWall time 31.0 seconds\nOutput:\n'),
      call('wait', { cell_id: '12' }, 'w1'),
      out('w1', [{ type: 'input_text', text: 'Script completed\nWall time 3 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 0, output: 'done' }) }]),
    ])
    expect(t.entries).toHaveLength(1)
    expect(t.entries[0]!.text).toBe('Bash: sleep 99\n✓ done')
  })

  test('spawn_agent entries link to subagents by agent_path', () => {
    ord = 0
    const t = new CodexTranscript()
    const d = t.ingest(call('spawn_agent', { task_name: 'browser_integrity', message: 'x' }, 's1'))
    expect(d.appended[0]).toMatchObject({ kind: 'subagent', text: 'browser integrity' })
    t.ingest(out('s1', JSON.stringify({ task_name: '/root/browser_integrity' })))
    expect(t.entries[0]!.subagent).toBeUndefined()
    const info = { id: 'child-1', key: '/root/browser_integrity', path: '/p', label: 'Erdos', description: 'browser integrity', status: 'working' as const }
    const upd = t.resolveSpawns([info])
    expect(upd[0]).toMatchObject({ subagent: 'child-1', text: 'Erdos · browser integrity' })
    expect(t.resolveSpawns([info])).toHaveLength(0) // idempotent
    expect(t.tail().entries[0]!.subagent).toBe('child-1')
  })

  test('forked subagent rollout drops the inherited history', () => {
    ord = 0
    const t = new CodexTranscript(true)
    feed(t, [
      meta({ source: { subagent: { thread_spawn: {} } }, forked_from_id: 'P', agent_path: '/root/job' }),
      msg('user', 'parent history question'),
      msg('assistant', 'parent history answer'),
      rec('response_item', { type: 'agent_message', author: '/root', recipient: '/root/job', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'zzz' }] }),
      msg('assistant', 'working on the job'),
    ])
    expect(t.entries.map((e) => [e.kind, e.text])).toEqual([
      ['system', 'Task from root: job'],
      ['assistant', 'working on the job'],
    ])
    // the same file read as a normal session keeps everything
    const n = new CodexTranscript(false)
    feed(n, [meta(), msg('user', 'hello'), rec('response_item', { type: 'agent_message', author: '/root/a', content: [] })])
    expect(n.entries.map((e) => e.text)).toEqual(['hello'])
  })

  test('older paging', () => {
    ord = 0
    const t = new CodexTranscript()
    for (let i = 0; i < 30; i++) t.ingest(msg(i % 2 ? 'assistant' : 'user', `m${i}`))
    const w = t.tail(10)
    expect(w.hasOlder).toBe(true)
    const o = t.older(w.entries[0]!.id, 5)!
    expect(o.entries.map((e) => e.text)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19'])
    expect(t.older('nope')).toBeNull()
  })

  test('turn_aborted shows Interrupted', () => {
    ord = 0
    const t = new CodexTranscript()
    t.ingest(rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' }))
    expect(t.entries[0]).toMatchObject({ kind: 'system', text: 'Interrupted' })
  })
})

describe('helpers', () => {
  test('cleanCodexUser', () => {
    expect(cleanCodexUser('<environment_context>\n<cwd>/x</cwd>\n</environment_context>')).toBeNull()
    expect(cleanCodexUser('# AGENTS.md instructions for /x')).toBeNull()
    expect(cleanCodexUser('Host notice: something')).toBeNull()
    expect(cleanCodexUser('  hi  ')).toBe('hi')
    expect(cleanCodexUser('use <b>bold</b> please')).toBe('use <b>bold</b> please')
  })
  test('codexToolLine / codexResult', () => {
    expect(codexToolLine('shell', { command: ['bash', '-lc', 'echo hi'] })).toBe('Bash: echo hi')
    expect(codexToolLine('exec_command', { cmd: "bash -lc 'git status'" })).toBe('Bash: git status')
    expect(codexToolLine('send_message', { target: '/root/some_job', message: 'x' })).toBe('send_message: some job')
    expect(codexToolLine('wait_agent', {})).toBeNull()
    expect(codexToolLine('write_stdin', { chars: '' })).toBeNull()
    expect(codexToolLine('exec', 'x'.repeat(500))?.length).toBeLessThan(80)
    expect(codexResult('Process running with session ID 3\nOutput:\n')).toBeNull()
    expect(humanizeAgentPath('/root/a_b')).toBe('a b')
  })
  test('locateRollout globs newest day first and validates the id', () => {
    const root = mkdtempSync(join(tmpdir(), 'he-cx-'))
    mkdirSync(join(root, '2026/01/02'), { recursive: true })
    mkdirSync(join(root, '2026/03/04'), { recursive: true })
    const f = join(root, '2026/01/02/rollout-2026-01-02T10-00-00-abc-123.jsonl')
    writeFileSync(f, '')
    expect(locateRollout(root, 'abc-123')).toBe(f)
    expect(locateRollout(root, 'nope')).toBeNull()
    expect(locateRollout(root, '../x')).toBeNull()
    expect(locateRollout(join(root, 'missing'), 'abc-123')).toBeNull()
  })
  test('questions stay visible with choices until answered', () => {
    const t = new CodexTranscript()
    t.ingest(call('request_user_input', { questions: [{ question: 'Ship now?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, 'q1'))
    expect(t.entries[0]).toMatchObject({ kind: 'question', questions: [{ prompt: 'Ship now?', options: ['Yes', 'No'] }], answered: false, reply: 'keys' })
    t.ingest(out('q1', { answers: { ship: 'Yes' } }))
    expect(t.entries[0]).toMatchObject({ kind: 'question', answered: true })
    t.ingest(custom('request_user_input_async', JSON.stringify({ questions: [{ title: 'Deploy?', options: ['Later', 'Now'] }] }), 'q2'))
    t.ingest(customOut('q2', { accepted: true }))
    expect(t.entries[1]).toMatchObject({ kind: 'question', answered: false, reply: 'message' })
    t.ingest(msg('user', 'Later'))
    expect(t.entries[1]).toMatchObject({ kind: 'question', answered: true })
    expect(cleanCodexUser('<send_user_message_question_reply>\n[{"answer":"Later","questionItemId":"q1"}]\n</send_user_message_question_reply>')).toBe('Later')
  })
  test('completed Codex rollout releases a queue even if Herdr still says working', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'he-turn-')), 'rollout.jsonl')
    writeFileSync(path, [rec('event_msg', { type: 'task_started' }), rec('event_msg', { type: 'task_complete' })].join('\n') + '\n')
    expect(codexTurnState(path)).toBe('done')
    writeFileSync(path, rec('event_msg', { type: 'task_started' }) + '\n')
    expect(codexTurnState(path)).toBe('working')
  })
})
