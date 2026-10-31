// Mock herdr-even bridge for plugin development (no auth, no Herdr). Usage: bun scripts/mock-bridge.ts [port]  (default 8798)
// Debug endpoints: GET /debug/flip?pane=<id>   toggle a pane blocked <-> working now
//                  GET /debug/status?pane=<id>&s=<status>
//                  GET /debug/sub?s=working|done   set the live subagent (pane 1) status; `working` restarts its ~40 s timer (SUB_FLIP_MS)
import type { ChatEntry, ClientMsg, PaneSummary, QueuedItem, ServerMsg, SubagentSummary } from '../../protocol/src/index'
import { PROTOCOL_VERSION, isAllowedKey } from '../../protocol/src/index'

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8798)
const MACHINE = process.env.MACHINE ?? 'mock-mac'

const mkPane = (n: number, over: Partial<PaneSummary>): PaneSummary => ({
  id: `default/w1:p${n}`, session: 'default', paneId: `w1:p${n}`, workspace: 'api', tab: '1', agent: 'claude', status: 'idle',
  title: 'claude', chat: 'transcript', subagents: 0, stateSeq: 1, ...over,
})
const panes: PaneSummary[] = [
  mkPane(1, { workspace: 'api', status: 'working', subagents: 1 }), // flips to blocked every ~30 s; has 3 subagents (1 working)
  mkPane(2, { workspace: 'web', status: 'working' }), // long chat
  mkPane(3, { workspace: 'docs', agent: 'codex', title: 'codex', status: 'idle' }),
  mkPane(4, { workspace: 'infra', status: 'done', stateSeq: 5 }),
  mkPane(5, { workspace: 'shell', agent: null, status: 'unknown', title: 'zsh ~/code', chat: 'screen' }),
  mkPane(6, { workspace: 'ml-train', status: 'blocked', stateSeq: 3 }),
  mkPane(7, { workspace: 'ops', agent: 'cursor', title: 'cursor', status: 'idle', chat: 'screen' }),
  // `api` has 3 panes (workspace screen); the other workspaces have one (opens directly)
  mkPane(8, { workspace: 'api', agent: 'codex', title: 'codex', status: 'working' }), // like pane 2: a tool entry every ~2 s, an assistant message every ~20 s
  mkPane(9, { workspace: 'api', agent: null, status: 'unknown', title: 'zsh ~/api', chat: 'screen' }),
]

const PROMPT = `Bash command

  npm run deploy -- --env production

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for npm run commands
  3. No, and tell Claude what to do differently (esc)`

const prompts = new Map<string, string>([['default/w1:p6', PROMPT]])

// ---- fake transcripts
const TOOLS = ['Bash: npm test', 'Read: src/index.ts', 'Edit: src/app.ts', 'Grep: "TODO" src/', 'Bash: git status', 'Write: README.md', 'Bash: bun run build']
const ASSIST = [
  'I’ll start by reading the failing test to understand what the handler is expected to return, then look at the implementation.',
  'Found it. The handler returns `undefined` when the session is missing instead of a 404 – that’s why the test times out. Let me fix that and add a regression test.',
  'All 42 tests pass now ✓. One thing worth flagging: the retry loop in `src/client.ts` swallows errors after the third attempt, which will hide real failures in production. Want me to change it to rethrow?',
  'Here is the plan:\n1. Extract the parser into its own module\n2. Add unit tests for edge cases (empty input, unicode “smart quotes”, very long lines that need to wrap across several rows on the glasses)\n3. Wire it into the CLI',
  'Done. ⎿ summarised: 3 files changed, 87 insertions(+), 12 deletions(-).',
]
const USER = ['fix the failing test in the session handler', 'yes please rethrow', 'can you also update the docs?', 'run the whole suite again', 'looks good, commit it']

function fakeChat(paneId: string, n: number): ChatEntry[] {
  const out: ChatEntry[] = []
  const t0 = Date.now() - n * 60000
  for (let i = 0; i < n; i++) {
    const ts = t0 + i * 60000
    const phase = i % 7
    let kind: ChatEntry['kind'] = 'assistant', text = ''
    if (phase === 0) { kind = 'user'; text = USER[(i / 7 | 0) % USER.length] }
    else if (phase === 1 || phase === 3 || phase === 5) { kind = 'tool'; text = `⏺ ${TOOLS[(i * 3) % TOOLS.length]}` }
    else if (phase === 2) { kind = 'tool'; text = '⎿ ok (exit 0)' }
    else { text = `[${i}] ${ASSIST[(i / 7 | 0) % ASSIST.length]}` }
    out.push({ id: `${paneId}#${i}`, kind, text, ts })
  }
  return out
}
const chats = new Map<string, ChatEntry[]>()
for (const p of panes) if (p.chat === 'transcript') chats.set(p.id, fakeChat(p.id, p.workspace === 'web' ? 160 : p.id.endsWith('p8') ? 80 : p.workspace === 'infra' ? 12 : 60))

// ---- subagents (protocol v2): pane 1 has three; `sa-live` is working, appends an entry every ~10 s and flips to done after ~40 s
const SUB_PANE = 'default/w1:p1'
const SUB_FLIP_MS = Number(process.env.SUB_FLIP_MS ?? 40000)
const now0 = Date.now()
const subs: SubagentSummary[] = [
  { id: 'sa-old', label: 'Explore', description: 'Map the protocol package', status: 'done', lastActivity: now0 - 600000 },
  { id: 'sa-mid', label: 'general-purpose', description: 'Write unit tests for the parser', status: 'done', lastActivity: now0 - 120000 },
  { id: 'sa-live', label: 'general-purpose', description: 'Build bridge', status: 'working', lastActivity: now0 },
]
const subChats = new Map<string, ChatEntry[]>()
for (const sa of subs) subChats.set(sa.id, fakeChat(`${SUB_PANE}~${sa.id}`, sa.status === 'working' ? 30 : 18))
{ // inline spawn entries near the end of the parent chat
  const parent = chats.get(SUB_PANE)!
  subs.forEach((sa, i) => {
    const at = parent.length - 7 + i * 2
    parent[at] = { id: `${SUB_PANE}#sub-${sa.id}`, kind: 'subagent', text: `${sa.label} · ${sa.description}`, ts: parent[at].ts, subagent: sa.id }
  })
}
const subWorking = () => subs.filter(x => x.status === 'working').length
const sendSubs = (c: Client) => send(c, { t: 'subagents', pane: SUB_PANE, subagents: subs })
let subFlipTimer: ReturnType<typeof setTimeout> | undefined
function setSub(status: 'working' | 'done') {
  const sa = subs.find(x => x.id === 'sa-live')!
  clearTimeout(subFlipTimer)
  if (sa.status !== status) { sa.status = status; sa.lastActivity = Date.now() }
  if (status === 'working') subFlipTimer = setTimeout(() => setSub('done'), SUB_FLIP_MS)
  panes[0].subagents = subWorking(); panes[0].stateSeq++
  for (const c of clients) { if (c.open === SUB_PANE) sendSubs(c) }
  broadcastPanes()
}
subFlipTimer = setTimeout(() => setSub('done'), SUB_FLIP_MS)
setInterval(() => { // the working subagent produces output
  const sa = subs[2]
  if (sa.status !== 'working') return
  const e = entry(`sub#${seq++}`, 'assistant', `[${seq}] progress: still building the bridge, finished another module and now wiring tests so this line wraps on the glasses`)
  subChats.get(sa.id)!.push(e); sa.lastActivity = e.ts
  for (const c of clients) if (c.open === SUB_PANE && c.sub === sa.id) send(c, { t: 'chat.append', pane: SUB_PANE, subagent: sa.id, entries: [e] })
}, 10000)

let screenTick = 0
const screenText = (p: PaneSummary) =>
  p.workspace === 'shell'
    ? `om@mbp ~/code % ls\nREADME.md  package.json  src  node_modules\nom@mbp ~/code % git status\nOn branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\nom@mbp ~/code % echo tick ${screenTick}\ntick ${screenTick}\nom@mbp ~/code % ▌`
    : `Cursor agent · opencode\n\n● Reading files ⠋\n  src/components/VeryLongComponentName.tsx\n  tick ${screenTick}\n\n│ Add a follow-up │`

// ---- clients
type Client = { ws: import('bun').ServerWebSocket<unknown>; open: string | null; sub?: string }
const clients = new Set<Client>()
const send = (c: Client, m: ServerMsg) => c.ws.send(JSON.stringify(m))
const broadcastPanes = () => { for (const c of clients) send(c, { t: 'panes', panes }) }
const entry = (id: string, kind: Exclude<ChatEntry['kind'], 'question'>, text: string): ChatEntry => ({ id, kind, text, ts: Date.now() })
let seq = 1000
function appendTo(paneId: string, e: ChatEntry) {
  const arr = chats.get(paneId); if (!arr) return
  arr.push(e)
  for (const c of clients) if (c.open === paneId) send(c, { t: 'chat.append', pane: paneId, entries: [e] })
}
// ---- queued messages (text with queue:true): held while the pane's agent is working, delivered when it turns idle/done
const queues = new Map<string, QueuedItem[]>()
let qseq = 1
const sendQueue = (paneId: string) => { for (const c of clients) if (c.open === paneId && !c.sub) send(c, { t: 'queue', pane: paneId, items: queues.get(paneId) ?? [] }) }
function flushQueue(p: PaneSummary) {
  const q = queues.get(p.id)
  if (!q?.length) return
  queues.delete(p.id)
  sendQueue(p.id)
  q.forEach((it, i) => setTimeout(() => appendTo(p.id, entry(`t#${seq++}`, 'user', `${it.text} ⏎ (queued)`)), 200 * i))
}
const setStatus = (p: PaneSummary, s: PaneSummary['status']) => {
  if (p.status === s) return
  const was = p.status
  p.status = s; p.stateSeq++
  if (was === 'working' && (s === 'idle' || s === 'done')) flushQueue(p)
  if (s === 'blocked') {
    prompts.set(p.id, PROMPT)
    for (const c of clients) if (c.open === p.id) send(c, { t: 'prompt', pane: p.id, text: PROMPT })
  } else {
    prompts.delete(p.id)
    for (const c of clients) if (c.open === p.id) send(c, { t: 'prompt', pane: p.id, text: null })
  }
  broadcastPanes()
}

setInterval(() => { // pane 1 flips to blocked every ~30 s, back after ~12 s
  const p = panes[0]
  setStatus(p, p.status === 'blocked' ? 'working' : 'blocked')
}, 30000)
setInterval(() => { // live activity in pane 2 (new entries) and screen panes
  screenTick++
  for (const c of clients) {
    const p = panes.find(x => x.id === c.open)
    if (p?.chat === 'screen') send(c, { t: 'chat.update', pane: p.id, entries: [{ id: 'screen', kind: 'screen', text: screenText(p) }] })
  }
  // working panes: a tool call every tick (~2 s, alternating call / result), an assistant message every 10th tick (~20 s)
  for (const id of ['default/w1:p2', 'default/w1:p8']) {
    if (panes.find(x => x.id === id)?.status !== 'working') continue
    if (screenTick % 10 === 0) appendTo(id, entry(`live#${seq++}`, 'assistant', `live update ${screenTick}: still working on it, this line is a bit longer so it wraps on the glasses display`))
    else appendTo(id, entry(`tool#${seq++}`, 'tool', screenTick % 2 ? `⏺ ${TOOLS[screenTick % TOOLS.length]}` : '⎿ ok (exit 0)'))
  }
}, 2000)

function chatReply(c: Client, p: PaneSummary, id?: string) {
  if (p.chat === 'screen') { send(c, { t: 'chat', id, pane: p.id, source: 'screen', entries: [{ id: 'screen', kind: 'screen', text: screenText(p) }], hasOlder: false }); return }
  const all = chats.get(p.id) ?? []
  const win = all.slice(-40)
  send(c, { t: 'chat', id, pane: p.id, source: 'transcript', entries: win, hasOlder: all.length > win.length })
}

function onMsg(c: Client, m: ClientMsg) {
  const pane = 'pane' in m ? panes.find(p => p.id === m.pane) : undefined
  const needPane = () => { if (!pane) { send(c, { t: 'error', id: 'id' in m ? m.id : undefined, code: 'unknown_pane', message: `no pane ${'pane' in m ? m.pane : ''}` }); return false } return true }
  switch (m.t) {
    case 'ping': send(c, { t: 'pong', id: m.id }); break
    case 'log': console.log(`[plugin ${m.level}] ${m.msg}${m.data !== undefined ? ' ' + JSON.stringify(m.data) : ''}`); break
    case 'close': c.open = null; c.sub = undefined; send(c, { t: 'ok', id: m.id }); break
    case 'open':
      if (!needPane()) break
      if (m.subagent !== undefined) {
        const sa = pane!.id === SUB_PANE ? subs.find(x => x.id === m.subagent) : undefined
        if (!sa) { send(c, { t: 'error', id: m.id, code: 'unknown_subagent', message: `no subagent ${m.subagent}` }); break }
        c.open = pane!.id; c.sub = sa.id
        const all = subChats.get(sa.id)!
        const win = all.slice(-40)
        send(c, { t: 'chat', id: m.id, pane: pane!.id, subagent: sa.id, source: 'transcript', entries: win, hasOlder: all.length > win.length })
        sendSubs(c)
        break
      }
      c.open = pane!.id; c.sub = undefined
      chatReply(c, pane!, m.id)
      send(c, { t: 'queue', pane: pane!.id, items: queues.get(pane!.id) ?? [] })
      if (pane!.id === SUB_PANE) sendSubs(c)
      if (pane!.status === 'blocked') send(c, { t: 'prompt', pane: pane!.id, text: prompts.get(pane!.id) ?? PROMPT })
      break
    case 'older': {
      if (!needPane()) break
      if (m.subagent !== undefined && !subChats.has(m.subagent)) { send(c, { t: 'error', id: m.id, code: 'unknown_subagent', message: `no subagent ${m.subagent}` }); break }
      const all = (m.subagent !== undefined ? subChats.get(m.subagent) : chats.get(pane!.id)) ?? []
      const idx = all.findIndex(e => e.id === m.before)
      const lim = m.limit ?? 50
      const entries = idx <= 0 ? [] : all.slice(Math.max(0, idx - lim), idx)
      setTimeout(() => send(c, { t: 'chat.older', id: m.id, pane: pane!.id, subagent: m.subagent, entries, hasOlder: idx - lim > 0 }), 120)
      break
    }
    case 'keys': {
      if (!needPane()) break
      if (!m.keys.every(isAllowedKey)) { send(c, { t: 'error', id: m.id, code: 'key_not_allowed', message: m.keys.join(' ') }); break }
      send(c, { t: 'ok', id: m.id })
      appendTo(pane!.id, entry(`k#${seq++}`, 'user', `[keys] ${m.keys.join(' ')}`))
      if (pane!.status === 'blocked' && ['1', '2', '3', 'enter', 'y', 'esc'].some(k => m.keys.includes(k))) setTimeout(() => setStatus(pane!, 'working'), 400)
      break
    }
    case 'text': {
      if (!needPane()) break
      send(c, { t: 'ok', id: m.id })
      if (m.queue && pane!.agent && pane!.status === 'working') {
        const q = queues.get(pane!.id) ?? []
        q.push({ id: `q${qseq++}`, text: m.text, ts: Date.now() })
        queues.set(pane!.id, q)
        sendQueue(pane!.id)
        break
      }
      appendTo(pane!.id, entry(`t#${seq++}`, 'user', `${m.text}${m.enter || m.queue ? ' ⏎' : ''}`))
      break
    }
    case 'unqueue': {
      if (!needPane()) break
      const q = queues.get(pane!.id) ?? []
      const i = q.findIndex(x => x.id === m.item)
      if (i < 0) { send(c, { t: 'error', id: m.id, code: 'unknown_item', message: `no queued item ${m.item}` }); break }
      q.splice(i, 1)
      if (!q.length) queues.delete(pane!.id)
      send(c, { t: 'ok', id: m.id })
      sendQueue(pane!.id)
      break
    }
  }
}

Bun.serve({
  port: PORT,
  fetch(req, server) {
    const u = new URL(req.url)
    const cors = { 'Access-Control-Allow-Origin': '*' }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Headers': '*' } })
    if (u.pathname === '/health') return Response.json({ ok: true, protocol: PROTOCOL_VERSION, machine: MACHINE }, { headers: cors })
    if (u.pathname === '/debug/flip' || u.pathname === '/debug/status') {
      const p = panes.find(x => x.id === (u.searchParams.get('pane') ?? panes[0].id)) ?? panes.find(x => x.paneId === u.searchParams.get('pane'))
      if (!p) return new Response('no pane', { status: 404, headers: cors })
      setStatus(p, (u.searchParams.get('s') as PaneSummary['status']) ?? (p.status === 'blocked' ? 'working' : 'blocked'))
      return Response.json({ ok: true, status: p.status }, { headers: cors })
    }
    if (u.pathname === '/debug/sub') { setSub(u.searchParams.get('s') === 'working' ? 'working' : 'done'); return Response.json({ ok: true, subs }, { headers: cors }) }
    if (u.pathname === '/ws' && server.upgrade(req)) return undefined
    return new Response('not found', { status: 404, headers: cors })
  },
  websocket: {
    open(ws) {
      const c: Client = { ws, open: null };
      (ws as any).c = c
      clients.add(c)
      console.log(`[mock] client connected (${clients.size})`)
      send(c, { t: 'hello', protocol: PROTOCOL_VERSION, machine: MACHINE, herdrVersion: 'mock', user: 'mock@local', snippets: [
        { label: 'continue', text: 'continue', enter: true },
        { label: 'run tests', text: 'run the tests', enter: true },
        { label: 'git status', text: 'git status', enter: true },
        { label: 'clear', keys: ['ctrl+l'] },
      ] })
      send(c, { t: 'panes', panes })
    },
    message(ws, raw) {
      const c = (ws as any).c as Client
      let m: ClientMsg
      try { m = JSON.parse(String(raw)) } catch { return }
      onMsg(c, m)
    },
    close(ws) { clients.delete((ws as any).c); console.log(`[mock] client gone (${clients.size})`) },
  },
})
console.log(`[mock] herdr-even mock bridge on http://localhost:${PORT} (machine ${MACHINE})`)
