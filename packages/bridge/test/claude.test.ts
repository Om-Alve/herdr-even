import { describe, expect, test } from 'bun:test'
import { ClaudeTranscript, cleanUserText, toolLine } from '../src/claude.ts'

// All fixtures are synthetic.
const user = (uuid: string, content: any, extra: any = {}) =>
  JSON.stringify({ type: 'user', uuid, isSidechain: false, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content }, ...extra })
const asst = (uuid: string, content: any[], extra: any = {}) =>
  JSON.stringify({ type: 'assistant', uuid, isSidechain: false, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content }, ...extra })

describe('ClaudeTranscript', () => {
  test('maps user/assistant/tool and hides noise', () => {
    const t = new ClaudeTranscript()
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'x' }),
      user('u1', 'hello there'),
      user('u2', '<local-command-caveat>Caveat: ignore</local-command-caveat>', { isMeta: true }),
      user('u3', '<command-name>/clear</command-name>'),
      asst('a1', [{ type: 'thinking', thinking: 'secret thoughts' }]),
      asst('a2', [{ type: 'text', text: 'Sure, running tests.' }]),
      asst('a3', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test\nsecond line' } }]),
      asst('a4', [{ type: 'text', text: '   ' }]),
      JSON.stringify({ type: 'attachment', uuid: 'x1' }),
      'not json at all',
      JSON.stringify({ type: 'assistant', uuid: 'weird', message: { content: 42 } }),
    ]
    for (const l of lines) t.ingest(l)
    expect(t.entries.map((e) => [e.id, e.kind])).toEqual([
      ['u1', 'user'],
      ['a2', 'assistant'],
      ['a3', 'tool'],
    ])
    expect(t.entries[2]!.text).toBe('Bash: npm test')
    expect(t.badLines).toBe(1)
    expect(JSON.stringify(t.entries)).not.toContain('secret')
  })

  test('tool_result updates the tool entry with a check mark and short first line', () => {
    const t = new ClaudeTranscript()
    t.ingest(asst('a1', [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'src/main.ts' } }]))
    t.ingest(asst('a2', [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'false' } }]))
    const d1 = t.ingest(user('r1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'The file was edited\nmore' }]))
    expect(d1.appended).toEqual([])
    expect(d1.updated).toHaveLength(1)
    expect(d1.updated[0]).toMatchObject({ id: 'a1', text: 'Edit: src/main.ts\n✓ The file was edited' })
    const d2 = t.ingest(user('r2', [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'exit 1' }] }]))
    expect(d2.updated[0]!.text).toBe('Bash: false\n✗ exit 1')
    // long first line: mark only
    t.ingest(asst('a3', [{ type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: 'x' } }]))
    const d3 = t.ingest(user('r3', [{ type: 'tool_result', tool_use_id: 'tu3', content: 'y'.repeat(200) }]))
    expect(d3.updated[0]!.text).toBe('Read: x\n✓')
    // unknown tool_use_id: ignored
    expect(t.ingest(user('r4', [{ type: 'tool_result', tool_use_id: 'nope', content: 'z' }])).updated).toEqual([])
  })

  test('stable ids with multiple blocks, no duplicate on re-ingest', () => {
    const t = new ClaudeTranscript()
    const l = asst('m1', [
      { type: 'text', text: 'one' },
      { type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'f' } },
    ])
    t.ingest(l)
    t.ingest(l)
    expect(t.entries.map((e) => e.id)).toEqual(['m1', 'm1.1'])
  })

  test('tail/older paging', () => {
    const t = new ClaudeTranscript()
    for (let i = 0; i < 100; i++) t.ingest(user(`u${i}`, `msg ${i}`))
    const w = t.tail(40)
    expect(w.entries).toHaveLength(40)
    expect(w.entries[0]!.id).toBe('u60')
    expect(w.hasOlder).toBe(true)
    const o = t.older('u60', 50)!
    expect(o.entries.map((e) => e.id)[0]).toBe('u10')
    expect(o.entries.at(-1)!.id).toBe('u59')
    expect(o.hasOlder).toBe(true)
    const o2 = t.older('u10', 50)!
    expect(o2.entries).toHaveLength(10)
    expect(o2.hasOlder).toBe(false)
    expect(t.older('missing')).toBeNull()
  })

  test('sidechain records ignored; interrupt shown as system', () => {
    const t = new ClaudeTranscript()
    t.ingest(user('s1', 'sub', { isSidechain: true }))
    t.ingest(user('i1', [{ type: 'text', text: '[Request interrupted by user]' }]))
    expect(t.entries.map((e) => [e.kind, e.text])).toEqual([['system', 'Interrupted']])
  })
})

describe('helpers', () => {
  test('toolLine', () => {
    expect(toolLine('Read', { file_path: '/a/b.ts' })).toBe('Read: /a/b.ts')
    expect(toolLine('Grep', { pattern: 'foo' })).toBe('Grep: foo')
    expect(toolLine('Mystery', { x: 'hello' })).toBe('Mystery: hello')
    expect(toolLine('Nothing', {})).toBe('Nothing')
    expect(toolLine('Bash', { command: 'x'.repeat(300) }).length).toBeLessThanOrEqual(110)
  })
  test('cleanUserText', () => {
    expect(cleanUserText('hi <system-reminder>x</system-reminder>')).toBe('hi')
    expect(cleanUserText('<system-reminder>x</system-reminder>')).toBeNull()
    expect(cleanUserText('This session is being continued from a previous')).toBeNull()
    expect(cleanUserText('<task-notification>x</task-notification>')).toBeNull()
  })
})
