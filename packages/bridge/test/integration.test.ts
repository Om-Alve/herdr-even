import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg } from '@herdr-even/protocol'
import { loadConfig } from '../src/config.ts'
import { SessionManager } from '../src/sessions.ts'
import { startServer } from '../src/server.ts'

// A fake Herdr (NDJSON over a unix socket) + a synthetic Claude transcript. Never touches real sessions.
const root = mkdtempSync(join(tmpdir(), 'he-int-'))
const herdrDir = join(root, 'herdr')
const claudeDir = join(root, 'claude')
const codexDir = join(root, 'codex')
const cfgDir = join(root, 'cfg')
mkdirSync(herdrDir, { recursive: true })
mkdirSync(join(claudeDir, '-proj'), { recursive: true })
const SID = 'abcd1234-aaaa-bbbb-cccc-000000000001'
const tfile = join(claudeDir, '-proj', `${SID}.jsonl`)

const rec = (type: string, uuid: string, content: any) =>
  JSON.stringify({ type, uuid, isSidechain: false, timestamp: new Date().toISOString(), message: { content } }) + '\n'
let initial = ''
for (let i = 0; i < 60; i++) initial += rec(i % 2 ? 'assistant' : 'user', `r${i}`, i % 2 ? [{ type: 'text', text: `answer ${i}` }] : `question ${i}`)
writeFileSync(tfile, initial)

// Claude subagents of SID (one running, one finished) and the parent's spawn entry for the running one
const subDir = join(claudeDir, '-proj', SID, 'subagents')
mkdirSync(subDir, { recursive: true })
writeFileSync(join(subDir, 'agent-run1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Build thing', toolUseId: 'toolu_R' }))
writeFileSync(join(subDir, 'agent-run1.jsonl'), JSON.stringify({ type: 'user', uuid: 's1', isSidechain: true, agentId: 'run1', message: { content: 'sub prompt' } }) + '\n' +
  Array.from({ length: 60 }, (_, i) => JSON.stringify({ type: 'assistant', uuid: `sa${i}`, isSidechain: true, agentId: 'run1', message: { content: [{ type: 'text', text: `sub msg ${i}` }] } }) + '\n').join(''))
writeFileSync(join(subDir, 'agent-fin1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Old', toolUseId: 'toolu_F', finished: true }))
writeFileSync(join(subDir, 'agent-fin1.jsonl'), '')
utimesSync(join(subDir, 'agent-fin1.jsonl'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
initial += rec('assistant', 'spawn1', [{ type: 'tool_use', id: 'toolu_R', name: 'Agent', input: { description: 'Build thing', subagent_type: 'general-purpose', prompt: 'p' } }])
writeFileSync(tfile, initial)

// A Codex pane: parent rollout + one finished child
const CSID = 'c0de0000-0000-0000-0000-000000000001'
const cday = join(codexDir, '2026/05/06')
mkdirSync(cday, { recursive: true })
const crec = (type: string, payload: any) => JSON.stringify({ timestamp: '2026-05-06T10:00:00.000Z', type, payload }) + '\n'
const cmsg = (role: string, text: string) => crec('response_item', { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] })
const cfile = join(cday, `rollout-2026-05-06T09-00-00-${CSID}.jsonl`)
writeFileSync(cfile,
  crec('session_meta', { id: CSID, source: 'cli' }) + cmsg('developer', 'rules') + cmsg('user', '<environment_context>x</environment_context>') +
  Array.from({ length: 50 }, (_, i) => cmsg(i % 2 ? 'assistant' : 'user', `codex msg ${i}`)).join('') +
  crec('response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'child_job' }), call_id: 'sp1' }) +
  crec('response_item', { type: 'function_call_output', call_id: 'sp1', output: JSON.stringify({ task_name: '/root/child_job' }) }))
writeFileSync(join(cday, 'rollout-2026-05-06T09-30-00-child0001.jsonl'),
  crec('session_meta', { id: 'child0001', parent_thread_id: CSID, timestamp: '2026-05-06T09:30:00Z', agent_path: '/root/child_job', agent_nickname: 'Erdos',
    source: { subagent: { thread_spawn: { parent_thread_id: CSID, agent_path: '/root/child_job', agent_nickname: 'Erdos' } } } }) +
  crec('event_msg', { type: 'task_started' }) + cmsg('assistant', 'child says hi') + crec('event_msg', { type: 'task_complete' }))

const state = {
  status: 'idle' as string,
  codexStatus: 'idle' as string,
  visible: 'plain',
  recent: 'hello from shell\n$',
  calls: [] as { method: string; params: any }[],
  subs: [] as net.Socket[],
}

function snapshot() {
  return {
    version: '0.9.5',
    workspaces: [{ workspace_id: 'w1', label: 'proj' }],
    tabs: [{ tab_id: 'w1:t1', label: '1' }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'claude', agent_status: state.status, terminal_title_stripped: 'Title' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', agent: null },
      { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'codex', agent_status: state.codexStatus },
    ],
  }
}
const sockServer = net.createServer((c) => {
  let buf = ''
  c.setEncoding('utf8')
  c.on('error', () => {})
  c.on('data', (d: string) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      const reply = (result: any) => c.write(JSON.stringify({ id: msg.id, result }) + '\n')
      state.calls.push({ method: msg.method, params: msg.params })
      switch (msg.method) {
        case 'ping': reply({ type: 'pong', version: '0.9.5' }); break
        case 'session.snapshot': reply({ type: 'session_snapshot', snapshot: snapshot() }); break
        case 'agent.list':
          reply({ agents: [{ pane_id: 'w1:p1', agent: 'claude', agent_status: state.status, agent_session: { source: 'herdr:claude', kind: 'id', value: SID }, state_change_seq: 7, terminal_title_stripped: 'Title' },
            { pane_id: 'w1:p3', agent: 'codex', agent_status: state.codexStatus, agent_session: { source: 'herdr:codex', kind: 'id', value: CSID }, state_change_seq: 3 }] })
          break
        case 'pane.read':
          reply({ type: 'pane_read', read: { pane_id: msg.params.pane_id, text: msg.params.source === 'visible' ? state.visible : state.recent, revision: 0, truncated: false } })
          break
        case 'pane.send_keys': case 'pane.send_text': reply({ type: 'ok' }); break
        case 'events.subscribe': state.subs.push(c); reply({ type: 'subscription_started' }); break
        default: c.write(JSON.stringify({ id: msg.id, error: { code: 'nope', message: 'unsupported' } }) + '\n')
      }
    }
  })
})

let server: ReturnType<typeof startServer>
let mgr: SessionManager
const OWNER = 'me@example.com'
let base = ''

beforeAll(async () => {
  await new Promise<void>((r) => sockServer.listen(join(herdrDir, 'herdr.sock'), r))
  const cfg = loadConfig({ HERDR_EVEN_CONFIG_DIR: cfgDir, HERDR_EVEN_HERDR_DIR: herdrDir, HERDR_EVEN_CLAUDE_DIR: claudeDir, HERDR_EVEN_CODEX_DIR: codexDir, HERDR_EVEN_OWNER: OWNER, HERDR_EVEN_PORT: '0' })
  mgr = new SessionManager(cfg)
  mgr.start()
  server = startServer(cfg, mgr)
  base = `127.0.0.1:${server.port}`
  await Bun.sleep(300)
})
afterAll(() => {
  mgr.stop()
  server.stop(true)
  sockServer.close()
})

class Client {
  inbox: ServerMsg[] = []
  ws!: WebSocket
  n = 0
  static async connect(headers?: Record<string, string>) {
    const c = new Client()
    c.ws = new WebSocket(`ws://${base}/ws`, { headers } as any)
    c.ws.onmessage = (e) => c.inbox.push(JSON.parse(String(e.data)))
    await new Promise((res, rej) => ((c.ws.onopen = res as any), (c.ws.onerror = rej as any)))
    return c
  }
  async waitFor(pred: (m: ServerMsg) => boolean, ms = 4000): Promise<ServerMsg> {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const f = this.inbox.find(pred)
      if (f) return f
      await Bun.sleep(25)
    }
    throw new Error('timeout; inbox=' + JSON.stringify(this.inbox.map((m) => m.t)))
  }
  req(m: any, pred?: (r: ServerMsg) => boolean) {
    const id = `i${++this.n}`
    this.ws.send(JSON.stringify({ ...m, id }))
    return this.waitFor((r) => (r as any).id === id && (!pred || pred(r)))
  }
  close() { this.ws.close() }
}

describe('auth + http', () => {
  test('health + cors', async () => {
    const r = await fetch(`http://${base}/health`)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(await r.json()).toMatchObject({ ok: true, protocol: 2 })
    expect((await fetch(`http://${base}/health`, { method: 'OPTIONS' })).status).toBe(204)
    expect((await fetch(`http://${base}/nope`)).status).toBe(404)
  })
  test('ws: 403 without header / wrong header; ok with owner', async () => {
    expect((await fetch(`http://${base}/ws`)).status).toBe(403)
    expect((await fetch(`http://${base}/ws`, { headers: { 'Tailscale-User-Login': 'evil@example.com' } })).status).toBe(403)
    const c = await Client.connect({ 'Tailscale-User-Login': OWNER })
    const hello: any = await c.waitFor((m) => m.t === 'hello')
    expect(hello.user).toBe(OWNER)
    expect(hello.snippets.length).toBeGreaterThan(0)
    c.close()
  })
})

describe('bridge behaviour', () => {
  let c: Client
  beforeAll(async () => { c = await Client.connect({ 'Tailscale-User-Login': OWNER }) })
  afterAll(() => c.close())

  test('panes mapping', async () => {
    const m: any = await c.waitFor((m) => m.t === 'panes' && (m as any).panes.length === 3)
    expect(m.panes[0]).toMatchObject({ id: 'default/w1:p1', session: 'default', paneId: 'w1:p1', workspace: 'proj', tab: '1', agent: 'claude', status: 'idle', chat: 'transcript', stateSeq: 7, subagents: 0 })
    expect(m.panes[1]).toMatchObject({ id: 'default/w1:p2', agent: null, status: 'unknown', chat: 'screen' })
    expect(m.panes[2]).toMatchObject({ id: 'default/w1:p3', agent: 'codex', chat: 'transcript' })
  })

  test('PaneSummary.subagents counts working subagents and is pushed when it changes', async () => {
    const m: any = await c.waitFor((m) => m.t === 'panes' && (m as any).panes[0]?.subagents === 1, 6000)
    expect(m.panes[0].subagents).toBe(1) // run1 working, fin1 done
    expect(m.panes[2].subagents).toBe(0)
  })

  test('codex transcript pane: entries, paging, subagent list + inline entry', async () => {
    c.inbox.length = 0
    const chat: any = await c.req({ t: 'open', pane: 'default/w1:p3' })
    expect(chat).toMatchObject({ t: 'chat', source: 'transcript', hasOlder: true })
    expect(chat.subagent).toBeUndefined()
    expect(chat.entries).toHaveLength(40)
    const last = chat.entries.at(-1)
    expect(last).toMatchObject({ kind: 'subagent', text: 'Erdos · child job', subagent: 'child0001' })
    expect(JSON.stringify(chat.entries)).not.toContain('rules')
    const subs: any = await c.waitFor((m) => m.t === 'subagents')
    expect(subs.pane).toBe('default/w1:p3')
    expect(subs.subagents).toEqual([{ id: 'child0001', label: 'Erdos', description: 'child job', status: 'done', lastActivity: expect.any(Number) }])
    expect(c.inbox.findIndex((m) => m.t === 'subagents')).toBeGreaterThan(c.inbox.findIndex((m) => m.t === 'chat'))
    const older: any = await c.req({ t: 'older', pane: 'default/w1:p3', before: chat.entries[0].id, limit: 5 })
    expect(older.entries).toHaveLength(5)
    expect(older.subagent).toBeUndefined()
    // open the child
    c.inbox.length = 0
    const sc: any = await c.req({ t: 'open', pane: 'default/w1:p3', subagent: 'child0001' })
    expect(sc).toMatchObject({ t: 'chat', subagent: 'child0001', source: 'transcript', hasOlder: false })
    expect(sc.entries.map((e: any) => e.text)).toEqual(['child says hi'])
    await c.waitFor((m) => m.t === 'subagents')
    expect(((await c.req({ t: 'open', pane: 'default/w1:p3', subagent: 'nope' })) as any).code).toBe('unknown_subagent')
    await c.req({ t: 'close' })
  })

  test('claude subagents: inline entry resolves, open streams the sidechain, paging and live append carry subagent', async () => {
    c.inbox.length = 0
    const chat: any = await c.req({ t: 'open', pane: 'default/w1:p1' })
    expect(chat.entries.at(-1)).toMatchObject({ id: 'spawn1', kind: 'subagent', text: 'general-purpose · Build thing', subagent: 'run1' })
    const subs: any = await c.waitFor((m) => m.t === 'subagents')
    expect(subs.subagents.map((s: any) => [s.id, s.label, s.description, s.status])).toEqual(expect.arrayContaining([
      ['run1', 'general-purpose', 'Build thing', 'working'],
      ['fin1', 'Explore', 'Old', 'done'],
    ]))
    c.inbox.length = 0
    const sc: any = await c.req({ t: 'open', pane: 'default/w1:p1', subagent: 'run1' })
    expect(sc).toMatchObject({ subagent: 'run1', source: 'transcript', hasOlder: true })
    expect(sc.entries).toHaveLength(40)
    expect(sc.entries.at(-1).text).toBe('sub msg 59')
    const older: any = await c.req({ t: 'older', pane: 'default/w1:p1', subagent: 'run1', before: sc.entries[0].id, limit: 10 })
    expect(older).toMatchObject({ t: 'chat.older', subagent: 'run1' })
    expect(older.entries).toHaveLength(10)
    appendFileSync(join(subDir, 'agent-run1.jsonl'), JSON.stringify({ type: 'assistant', uuid: 'live', isSidechain: true, agentId: 'run1', message: { content: [{ type: 'text', text: 'live sub' }] } }) + '\n')
    const app: any = await c.waitFor((m) => m.t === 'chat.append')
    expect(app).toMatchObject({ subagent: 'run1' })
    expect(app.entries[0].text).toBe('live sub')
    // input still targets the pane
    state.calls.length = 0
    expect((await c.req({ t: 'keys', pane: 'default/w1:p1', keys: ['esc'] })).t).toBe('ok')
    expect(state.calls.find((x) => x.method === 'pane.send_keys')!.params).toEqual({ pane_id: 'w1:p1', keys: ['esc'] })
    await c.req({ t: 'close' })
  })

  test('bad messages give errors, not crashes', async () => {
    c.ws.send('garbage')
    await c.waitFor((m) => m.t === 'error' && (m as any).code === 'bad_request')
    expect(((await c.req({ t: 'wat' })) as any).code).toBe('bad_request')
    expect(((await c.req({ t: 'open', pane: 'default/zzz' })) as any).code).toBe('unknown_pane')
    expect(((await c.req({ t: 'keys', pane: 'default/w1:p2', keys: ['ctrl+;'] })) as any).code).toBe('key_not_allowed')
    expect(((await c.req({ t: 'older', pane: 'default/w1:p1' })) as any).code).toBe('bad_request')
    expect((await c.req({ t: 'ping' })).t).toBe('pong')
  })

  test('open transcript: last 40 + paging + live append/update', async () => {
    c.inbox.length = 0
    const chat: any = await c.req({ t: 'open', pane: 'default/w1:p1' })
    expect(chat).toMatchObject({ t: 'chat', source: 'transcript', hasOlder: true })
    expect(chat.entries).toHaveLength(40)
    expect(chat.entries.at(-1).id).toBe('spawn1')
    const older: any = await c.req({ t: 'older', pane: 'default/w1:p1', before: chat.entries[0].id, limit: 30 })
    expect(older.t).toBe('chat.older')
    expect(older.entries).toHaveLength(21)
    expect(older.hasOlder).toBe(false)
    expect(older.entries.at(-1).id).toBe('r20')

    // append, with a partial last line that completes later
    const tool = rec('assistant', 'live1', [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { command: 'npm test' } }])
    appendFileSync(tfile, tool.slice(0, 40))
    await Bun.sleep(1300)
    expect(c.inbox.some((m) => m.t === 'chat.append')).toBe(false)
    appendFileSync(tfile, tool.slice(40))
    const app: any = await c.waitFor((m) => m.t === 'chat.append')
    expect(app.entries[0]).toMatchObject({ id: 'live1', kind: 'tool', text: 'Bash: npm test' })
    appendFileSync(tfile, rec('user', 'live2', [{ type: 'tool_result', tool_use_id: 'T1', content: 'all 3 passed' }]))
    const upd: any = await c.waitFor((m) => m.t === 'chat.update')
    expect(upd.entries[0]).toMatchObject({ id: 'live1', text: 'Bash: npm test\n✓ all 3 passed' })
    await c.req({ t: 'close' })
  })

  test('screen fallback open + update', async () => {
    c.inbox.length = 0
    const chat: any = await c.req({ t: 'open', pane: 'default/w1:p2' })
    expect(chat).toMatchObject({ source: 'screen', hasOlder: false })
    expect(chat.entries[0]).toMatchObject({ id: 'screen', kind: 'screen', text: 'hello from shell\n$' })
    state.recent = 'hello from shell\n$ ls\nfile.txt\n$'
    const u: any = await c.waitFor((m) => m.t === 'chat.update')
    expect(u.entries[0].text).toContain('file.txt')
    await c.req({ t: 'close' })
  })

  test('blocked prompt appears, refreshes, clears', async () => {
    c.inbox.length = 0
    state.status = 'blocked'
    state.visible = 'Run command?\n❯ 1. Yes\n  2. No'
    await c.req({ t: 'open', pane: 'default/w1:p1' })
    // status change arrives via the event stream
    for (const s of state.subs) s.write(JSON.stringify({ event: { type: 'pane.agent_status_changed' } }) + '\n')
    const p: any = await c.waitFor((m) => m.t === 'prompt' && (m as any).text !== null, 5000)
    expect(p.text).toContain('2. No')
    state.visible = 'Run command?\n❯ 1. Yes\n  2. No\n  3. Other'
    await c.waitFor((m) => m.t === 'prompt' && ((m as any).text ?? '').includes('3. Other'), 5000)
    state.status = 'idle'
    for (const s of state.subs) s.write(JSON.stringify({ event: { type: 'pane.agent_status_changed' } }) + '\n')
    const cleared: any = await c.waitFor((m) => m.t === 'prompt' && (m as any).text === null, 5000)
    expect(cleared.pane).toBe('default/w1:p1')
    await c.req({ t: 'close' })
  })

  test('transcript vanishing falls back to screen', async () => {
    c.inbox.length = 0
    await c.req({ t: 'open', pane: 'default/w1:p1' })
    c.inbox.length = 0
    const { rmSync } = await import('node:fs')
    rmSync(tfile)
    const chat: any = await c.waitFor((m) => m.t === 'chat' && (m as any).source === 'screen', 5000)
    expect(chat.entries[0].id).toBe('screen')
    await c.req({ t: 'close' })
  })

  test('input: keys, text, text+enter reach herdr', async () => {
    state.calls.length = 0
    expect((await c.req({ t: 'keys', pane: 'default/w1:p2', keys: ['ctrl+c', 'enter'] })).t).toBe('ok')
    expect((await c.req({ t: 'text', pane: 'default/w1:p2', text: 'ls', enter: true })).t).toBe('ok')
    const sends = state.calls.filter((x) => x.method.startsWith('pane.send'))
    expect(sends.map((s) => s.method)).toEqual(['pane.send_keys', 'pane.send_text', 'pane.send_keys'])
    expect(sends[0]!.params).toEqual({ pane_id: 'w1:p2', keys: ['ctrl+c', 'enter'] })
    expect(sends[1]!.params).toEqual({ pane_id: 'w1:p2', text: 'ls' })
    expect(sends[2]!.params).toEqual({ pane_id: 'w1:p2', keys: ['enter'] })
  })

  test('queue: held while working, `queue` messages to the open view, delivered on idle, unqueue errors', async () => {
    c.inbox.length = 0
    state.status = 'working'
    await c.req({ t: 'open', pane: 'default/w1:p1' })
    await mgr.refreshNow('default/w1:p1')
    const first: any = await c.waitFor((m) => m.t === 'queue')
    expect(first.items).toEqual([])
    expect(c.inbox.findIndex((m) => m.t === 'chat')).toBeLessThan(c.inbox.findIndex((m) => m.t === 'queue'))
    state.calls.length = 0
    expect((await c.req({ t: 'text', pane: 'default/w1:p1', text: 'later', enter: false, queue: true })).t).toBe('ok')
    const q1: any = await c.waitFor((m) => m.t === 'queue' && (m as any).items.length === 1)
    expect(q1.items[0].text).toBe('later')
    const dropMe: any = await c.req({ t: 'text', pane: 'default/w1:p1', text: 'dropme', enter: true, queue: true })
    expect(dropMe.t).toBe('ok')
    const q2: any = await c.waitFor((m) => m.t === 'queue' && (m as any).items.length === 2)
    expect((await c.req({ t: 'unqueue', pane: 'default/w1:p1', item: q2.items[1].id })).t).toBe('ok')
    const err: any = await c.req({ t: 'unqueue', pane: 'default/w1:p1', item: q2.items[1].id })
    expect(err.code).toBe('unknown_item')
    expect(((await c.req({ t: 'text', pane: 'default/w1:p1', text: 'x'.repeat(4001), enter: false, queue: true })) as any).code).toBe('bad_request')
    expect(state.calls.some((x) => x.method === 'pane.send_text')).toBe(false)
    c.inbox.length = 0
    state.status = 'idle'
    for (const s of state.subs) s.write(JSON.stringify({ event: { type: 'pane.agent_status_changed' } }) + '\n')
    await c.waitFor((m) => m.t === 'queue' && (m as any).items.length === 0, 5000)
    const sends = state.calls.filter((x) => x.method.startsWith('pane.send'))
    expect(sends.map((x) => x.method)).toEqual(['pane.send_text', 'pane.send_keys'])
    expect(sends[0]!.params).toEqual({ pane_id: 'w1:p1', text: 'later' })
    expect(sends[1]!.params).toEqual({ pane_id: 'w1:p1', keys: ['enter'] })
    await c.req({ t: 'close' })
  })

  test('Codex queue delivers after rollout completion when Herdr remains working', async () => {
    c.inbox.length = 0
    state.codexStatus = 'working'
    appendFileSync(cfile, crec('event_msg', { type: 'task_started' }))
    await mgr.refreshNow('default/w1:p3')
    await c.req({ t: 'open', pane: 'default/w1:p3' })
    c.inbox.length = 0
    state.calls.length = 0
    expect((await c.req({ t: 'text', pane: 'default/w1:p3', text: 'next task', enter: true, queue: true })).t).toBe('ok')
    await c.waitFor(m => m.t === 'queue' && m.pane === 'default/w1:p3' && m.items.length === 1)
    expect(state.calls.some(x => x.method === 'pane.send_text')).toBe(false)
    appendFileSync(cfile, crec('event_msg', { type: 'task_complete' }))
    await c.waitFor(m => m.t === 'queue' && m.pane === 'default/w1:p3' && m.items.length === 0, 4000)
    expect(state.calls.filter(x => x.method.startsWith('pane.send')).map(x => x.params.pane_id)).toEqual(['w1:p3', 'w1:p3'])
    state.codexStatus = 'idle'
    await c.req({ t: 'close' })
  })

  test('Codex question and choices reach the chat view', async () => {
    appendFileSync(cfile, crec('response_item', { type: 'custom_tool_call', name: 'request_user_input_async', call_id: 'q1', input: JSON.stringify({ questions: [{ title: 'Ship it?', options: ['Now', 'Later'] }] }) }))
    const chat = await c.req({ t: 'open', pane: 'default/w1:p3' })
    expect(chat.t).toBe('chat')
    if (chat.t === 'chat') expect(chat.entries.at(-1)).toMatchObject({ kind: 'question', questions: [{ prompt: 'Ship it?', options: ['Now', 'Later'] }], answered: false, reply: 'message' })
    await c.req({ t: 'close' })
  })

  test('plugin log messages are accepted without reply', async () => {
    c.ws.send(JSON.stringify({ t: 'log', level: 'warn', msg: 'hi', data: { a: 1 } }))
    expect((await c.req({ t: 'ping' })).t).toBe('pong')
    const f = Bun.file(join(cfgDir, 'plugin-log.jsonl'))
    expect(await f.text()).toContain('"msg":"hi"')
  })
})
