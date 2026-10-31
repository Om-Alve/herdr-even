import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SimpleTranscript } from '../src/simple.ts'
import { cursorCandidates, locateCursor, locatePi, piCandidates } from '../src/other-locate.ts'
import { OpenCodeTail, locateOpenCode, openCodeCandidates } from '../src/opencode.ts'

test('Cursor transcript is found by session id and parsed as chat and tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'he-cursor-'))
  const dir = join(root, 'Users-example-app/agent-transcripts/s1')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 's1.jsonl')
  writeFileSync(path, '')
  expect(locateCursor(root, 's1')).toBe(path)
  expect(cursorCandidates(root, '/Users/example/app')[0]).toMatchObject({ path, id: 's1' })
  const t = new SimpleTranscript('cursor')
  t.ingest(JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Fix it' }] } }))
  t.ingest(JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }, { type: 'text', text: 'Done' }] } }))
  expect(t.entries.map(e => [e.kind, e.text])).toEqual([['user', 'Fix it'], ['tool', 'Read: a.ts'], ['assistant', 'Done']])
})

test('Pi session is found by id and cwd, and skips thinking blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'he-pi-'))
  const dir = join(root, '---Users-example-app--')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '2026-10-31_s1.jsonl')
  writeFileSync(path, JSON.stringify({ type: 'session', id: 's1', cwd: '/Users/example/app' }) + '\n')
  expect(locatePi(root, 's1')).toBe(path)
  expect(piCandidates(root, '/Users/example/app')[0]).toMatchObject({ path, id: 's1' })
  const t = new SimpleTranscript('pi')
  t.ingest(JSON.stringify({ type: 'session', id: 's1', cwd: '/Users/example/app' }))
  t.ingest(JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: 'Fix it' } }))
  t.ingest(JSON.stringify({ type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }, { type: 'text', text: 'Done' }] } }))
  expect(t.entries.map(e => e.kind)).toEqual(['user', 'tool', 'assistant'])
  expect(t.entries.some(e => e.text.includes('private'))).toBe(false)
})

test('OpenCode reads only the selected session from a read-only SQLite database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'he-oc-'))
  const path = join(root, 'opencode.db')
  const db = new Database(path)
  db.run('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT, time_updated INTEGER)')
  db.run('CREATE TABLE message (id TEXT, data TEXT)')
  db.run('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER)')
  db.query('INSERT INTO session VALUES (?, ?, ?, ?)').run('s1', '/app', null, Date.now())
  db.query('INSERT INTO message VALUES (?, ?)').run('m1', JSON.stringify({ role: 'user' }))
  db.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm1', 's1', JSON.stringify({ type: 'text', text: 'Fix it' }), Date.now())
  db.close()
  expect(locateOpenCode(path, 's1')).toBe(path)
  expect(openCodeCandidates(path, '/app')[0]?.id).toBe('s1')
  const deltas: string[] = []
  const tail = new OpenCodeTail(path, 's1', { onDelta(d) { deltas.push(...d.appended.map(e => e.text)) }, onReset() {}, onFail() {} })
  await tail.load()
  expect(tail.model.entries).toMatchObject([{ id: 'p1', kind: 'user', text: 'Fix it' }])
  tail.startWatching()
  const next = new Database(path)
  next.query('INSERT INTO message VALUES (?, ?)').run('m2', JSON.stringify({ role: 'assistant' }))
  next.query('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p2', 'm2', 's1', JSON.stringify({ type: 'text', text: 'Done' }), Date.now() + 1)
  next.close()
  await Bun.sleep(1100)
  expect(deltas).toEqual(['Done'])
  tail.stop()
})
