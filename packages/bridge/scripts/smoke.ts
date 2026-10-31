// WS smoke test. Usage:
//   HERDR_EVEN_DEV_NOAUTH=1 HERDR_EVEN_PORT=8799 bun src/main.ts &
//   bun scripts/smoke.ts [--port 8799] [--input]
// Default mode is READ-ONLY against whatever sessions are live.
// --input additionally drives ONLY the throwaway session `herdr-even-test` (must already be running:
//   `herdr --session herdr-even-test server`); it creates a workspace there via the Herdr socket directly.
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, PaneSummary, ServerMsg, SubagentSummary } from '@herdr-even/protocol'

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] ?? d : d
}
const PORT = Number(arg('port', '8799'))
const INPUT = process.argv.includes('--input')
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const inbox: ServerMsg[] = []
let waiters: ((m: ServerMsg) => void)[] = []
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data)) as ServerMsg
  inbox.push(m)
  for (const w of waiters) w(m)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}
function waitFor(pred: (m: ServerMsg) => boolean, ms = 5000): Promise<ServerMsg> {
  const found = inbox.find(pred)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for message')), ms)
    const w = (m: ServerMsg) => {
      if (pred(m)) {
        clearTimeout(to)
        waiters = waiters.filter((x) => x !== w)
        resolve(m)
      }
    }
    waiters.push(w)
  })
}
let n = 0
const req = (m: any, pred?: (r: ServerMsg) => boolean, ms?: number) => {
  const id = `r${++n}`
  ws.send(JSON.stringify({ ...m, id }))
  return waitFor(pred ? (r) => pred(r) && (r as any).id === id : (r) => (r as any).id === id, ms)
}
const short = (s: string, k = 90) => (s.length > k ? s.slice(0, k - 1) + '…' : s).replace(/\n/g, ' ⏎ ')
const show = (es: ChatEntry[], max = 6) => {
  for (const e of es.slice(-max)) console.log(`    [${e.kind}] ${short(e.text)}`)
}

async function herdrCall(sock: string, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock)
    let b = ''
    c.setEncoding('utf8')
    c.on('connect', () => c.write(JSON.stringify({ id: 'x', method, params }) + '\n'))
    c.on('data', (d: string) => {
      b += d
      if (b.includes('\n')) {
        c.destroy()
        const r = JSON.parse(b.split('\n')[0]!)
        r.error ? reject(new Error(r.error.message)) : resolve(r.result)
      }
    })
    c.on('error', reject)
  })
}

await new Promise((r) => (ws.onopen = r as any))
const hello = (await waitFor((m) => m.t === 'hello')) as any
check(hello.protocol === 2 && !!hello.machine, `hello machine=${hello.machine} herdr=${hello.herdrVersion} snippets=${hello.snippets.length}`)
await sleep(1500)
let panes = ((inbox.filter((m) => m.t === 'panes').pop() as any)?.panes ?? []) as PaneSummary[]
console.log(`panes: ${panes.length}`)
for (const p of panes.slice(0, 8)) console.log(`  ${p.id}  ${p.workspace}/${p.tab}  ${p.agent ?? '-'} ${p.status} chat=${p.chat} "${short(p.title, 40)}"`)

const pong = await req({ t: 'ping' })
check(pong.t === 'pong', 'ping/pong')

// bad messages must give an error, not a crash
ws.send('not json')
check((await waitFor((m) => m.t === 'error' && (m as any).code === 'bad_request')).t === 'error', 'bad JSON -> error')
const nopane = await req({ t: 'open', pane: 'default/nope:p9' })
check(nopane.t === 'error' && (nopane as any).code === 'unknown_pane', 'unknown pane -> unknown_pane')
const badKey = await req({ t: 'keys', pane: panes[0]?.id ?? 'x/y', keys: ['ctrl+;'] })
check(badKey.t === 'error' && (badKey as any).code === 'key_not_allowed', 'disallowed key -> key_not_allowed (nothing sent)')

if (!INPUT) {
  // every transcript pane, Claude and Codex: open, check entries, page older, read its subagents
  const withSubs: { pane: PaneSummary; subs: SubagentSummary[] }[] = []
  for (const kind of ['claude', 'codex']) {
    const tps = panes.filter((p) => p.chat === 'transcript' && p.agent === kind)
    if (!tps.length) console.log(`NOTE: no ${kind} transcript pane found`)
    let first = true
    for (const tp of tps) {
      console.log(`\nopen ${kind} pane ${tp.id} (${tp.status}, summary.subagents=${tp.subagents})`)
      inbox.length = 0
      const c = (await req({ t: 'open', pane: tp.id })) as any
      const ok = c.t === 'chat' && c.source === 'transcript' && c.subagent === undefined
      check(ok && c.entries.length > 0, `${kind} transcript chat: ${c.entries?.length} entries hasOlder=${c.hasOlder}`)
      const subsMsg = (await waitFor((m) => m.t === 'subagents' && (m as any).pane === tp.id)) as any
      check(inbox.findIndex((m) => m.t === 'subagents') > inbox.findIndex((m) => m.t === 'chat'), '  subagents sent after chat')
      const subs: SubagentSummary[] = subsMsg.subagents
      console.log(`  subagents: ${subs.length} (${subs.filter((x) => x.status === 'working').length} working)`)
      for (const x of subs.slice(0, 4)) console.log(`    ${x.id.slice(0, 12)} ${x.label} · ${short(x.description, 40)} [${x.status}]`)
      if (subs.length) withSubs.push({ pane: tp, subs })
      if (first || subs.length) {
        if (first) show(c.entries)
        const inline = (c.entries as ChatEntry[]).filter((e) => e.kind === 'subagent')
        if (inline.length) {
          console.log('  inline subagent entries:')
          for (const e of inline.slice(-3)) console.log(`    [subagent] ${short(e.text)} -> ${e.subagent ?? '(unresolved)'}`)
        }
      }
      if (first && c.hasOlder) {
        const o = (await req({ t: 'older', pane: tp.id, before: c.entries[0].id, limit: 20 })) as any
        check(o.t === 'chat.older' && o.entries.length > 0 && o.entries.length <= 20, `  older: ${o.entries.length} entries hasOlder=${o.hasOlder}`)
        console.log('  older sample:')
        show(o.entries, 3)
        const o2 = (await req({ t: 'older', pane: tp.id, before: o.entries[0].id, limit: 20 })) as any
        check(o2.t === 'chat.older' && (o2.entries.length === 0 || o2.entries.at(-1).id !== o.entries[0].id), '  older pages backwards')
      }
      first = false
      await req({ t: 'close' })
    }
  }
  // the pane-level working count agrees with the list shape
  for (const { pane } of withSubs) check(typeof pane.subagents === 'number', `PaneSummary.subagents is a number for ${pane.id}`)

  // open one subagent per agent kind and page it
  const seen = new Set<string>()
  for (const { pane, subs } of withSubs) {
    const kind = pane.agent!
    if (seen.has(kind)) continue
    seen.add(kind)
    const sub = subs.at(-1)!
    console.log(`\nopen ${kind} subagent ${sub.id.slice(0, 12)} of ${pane.id}`)
    const c = (await req({ t: 'open', pane: pane.id, subagent: sub.id })) as any
    check(c.t === 'chat' && c.subagent === sub.id && c.source === 'transcript', `subagent chat: ${c.entries?.length} entries hasOlder=${c.hasOlder}`)
    show(c.entries, 4)
    if (c.hasOlder) {
      const o = (await req({ t: 'older', pane: pane.id, subagent: sub.id, before: c.entries[0].id, limit: 10 })) as any
      check(o.t === 'chat.older' && o.subagent === sub.id && o.entries.length > 0, `  subagent older: ${o.entries.length} entries`)
    }
    const bad = await req({ t: 'open', pane: pane.id, subagent: 'does-not-exist' })
    check(bad.t === 'error' && (bad as any).code === 'unknown_subagent', '  unknown subagent -> unknown_subagent')
    await req({ t: 'close' })
  }
  if (!withSubs.length) console.log('NOTE: no pane with subagents found; subagent open not exercised')

  const sp = panes.find((p) => !p.agent) ?? panes.find((p) => p.chat === 'screen')
  if (sp) {
    console.log(`\nopen screen pane ${sp.id}`)
    const c = (await req({ t: 'open', pane: sp.id })) as any
    check(c.t === 'chat' && c.source === 'screen' && c.entries[0]?.id === 'screen', `screen chat: ${c.entries[0]?.text.length} chars`)
    console.log('  ' + short(c.entries[0]?.text.split('\n').slice(-3).join('\n') ?? '', 200))
    await req({ t: 'close' })
  }
} else {
  const TEST = join(homedir(), '.config/herdr/sessions/herdr-even-test/herdr.sock')
  const ws0 = await herdrCall(TEST, 'workspace.create', { label: 'bridge-test', focus: false })
  console.log('created test workspace', JSON.stringify(ws0).slice(0, 120))
  await sleep(12_000) // bridge rescans sessions every 10 s
  panes = ((inbox.filter((m) => m.t === 'panes').pop() as any)?.panes ?? []) as PaneSummary[]
  const tp = panes.find((p) => p.session === 'herdr-even-test')
  check(!!tp, `bridge discovered test session pane ${tp?.id}`)
  if (tp) {
    const c = (await req({ t: 'open', pane: tp.id })) as any
    check(c.t === 'chat' && c.source === 'screen', 'test pane opens as screen')
    const r1 = await req({ t: 'text', pane: tp.id, text: 'echo herdr-even-$((40+2))', enter: true })
    check(r1.t === 'ok', 'text+enter ok')
    await sleep(2500)
    const upd = inbox.filter((m) => m.t === 'chat.update' && (m as any).pane === tp.id).map((m: any) => m.entries[0].text)
    check(upd.some((t) => t.includes('herdr-even-42')), 'chat.update carries command output (screen polling)')
    const r2 = await req({ t: 'text', pane: tp.id, text: 'sleep 30' })
    const r3 = await req({ t: 'keys', pane: tp.id, keys: ['enter'] })
    await sleep(500)
    const r4 = await req({ t: 'keys', pane: tp.id, keys: ['ctrl+c'] })
    check(r2.t === 'ok' && r3.t === 'ok' && r4.t === 'ok', 'keys enter / ctrl+c ok')
    await req({ t: 'text', pane: tp.id, text: 'echo after-int-$((1+1))', enter: true })
    await sleep(2500)
    const read = await herdrCall(TEST, 'pane.read', { pane_id: tp.paneId, source: 'recent_unwrapped', format: 'text', strip_ansi: true })
    const txt: string = read.read.text
    check(txt.includes('after-int-2'), 'ctrl+c interrupted sleep and next command ran (via pane.read)')
    await req({ t: 'close' })
  }
}
ws.send(JSON.stringify({ t: 'log', level: 'info', msg: 'smoke finished', data: { failures } }))
await sleep(200)
ws.close()
console.log(failures ? `\n${failures} FAILED` : '\nall smoke checks passed')
process.exit(failures ? 1 : 0)
