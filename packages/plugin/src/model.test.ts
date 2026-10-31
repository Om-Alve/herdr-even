import { expect, test } from 'bun:test'
import type { PaneSummary } from '@herdr-even/protocol'
import { flattenEntries } from './chat'
import { queuedLines } from './chat'
import type { ChatEntry } from '@herdr-even/protocol'
import { EXIT_LABEL, activityHeader, activityLine, groupWorkspaces, liveNeedsRebuild, nonToolCount, paneRowLabel, wsItems, wsRowLabel, confirmItems, isWorkingAgent, queueListItems, menuItems, paginateHome, rowLabel, sortPanes, urgency, type PaneRef } from './model'

const mk = (id: string, over: Partial<PaneSummary> = {}, origin = 'o1'): PaneRef => ({
  origin, machine: origin === 'o1' ? 'mbp' : 'lnx',
  pane: { id: `default/${id}`, session: 'default', paneId: id, workspace: 'api', tab: 't', agent: 'claude', status: 'idle', title: 'zsh', chat: 'transcript', subagents: 0, stateSeq: 1, ...over },
})

test('urgency order: blocked, done-unseen, working, idle agents, other', () => {
  const panes = [
    mk('w1:p1', { status: 'idle' }), mk('w1:p2', { status: 'unknown', agent: null }),
    mk('w1:p3', { status: 'working' }), mk('w1:p4', { status: 'done', stateSeq: 7 }),
    mk('w1:p5', { status: 'blocked' }), mk('w1:p6', { status: 'done', stateSeq: 3 }),
  ]
  const seen = { 'o1|default/w1:p6': 3 }
  expect(sortPanes(panes, seen).map(r => r.pane.paneId)).toEqual(['w1:p5', 'w1:p4', 'w1:p3', 'w1:p1', 'w1:p6', 'w1:p2'])
  expect(urgency(panes[5], seen)).toBe(3) // seen done sorts with idle
  expect(urgency(panes[5], {})).toBe(1)
  expect(urgency(panes[5], { 'o1|default/w1:p6': 2 })).toBe(1) // a newer stateSeq is unseen again
})

test('row format', () => {
  expect(rowLabel(mk('w1:p1', { status: 'blocked' }), false)).toBe('api · claude · BLOCKED')
  expect(rowLabel(mk('w1:p1', { status: 'blocked' }), true)).toBe('mbp/api · claude · BLOCKED')
  expect(rowLabel(mk('w1:p2', { agent: null, status: 'unknown', title: 'vim' }), false)).toBe('api · vim')
  const long = rowLabel(mk('w1:p2', { workspace: 'w'.repeat(100) }), false)
  expect(Array.from(long).length).toBeLessThanOrEqual(64)
})

test('home pagination: <=19 panes on one page, more/back otherwise, exit row last on every page', () => {
  const refs = Array.from({ length: 50 }, (_, i) => mk(`w1:p${i}`))
  const labels = refs.map((_, i) => `row ${i}`)
  const one = paginateHome(refs.slice(0, 19), labels, 0)
  expect(one.items.length).toBe(20); expect(one.pages).toBe(1); expect(one.items.at(-1)).toBe(EXIT_LABEL); expect(one.kinds.at(-1)).toBe('exit')
  const p0 = paginateHome(refs, labels, 0)
  expect(p0.items.length).toBe(20); expect(p0.items.at(-2)).toBe('more ▼'); expect(p0.items.at(-1)).toBe(EXIT_LABEL); expect(p0.items[0]).toBe('row 0')
  const p1 = paginateHome(refs, labels, 1)
  expect(p1.items[0]).toBe('▲ back'); expect(p1.items.at(-2)).toBe('more ▼'); expect(p1.items.length).toBe(20)
  const last = paginateHome(refs, labels, 99)
  expect(last.page).toBe(last.pages - 1); expect(last.items.at(-2)).not.toBe('more ▼'); expect(last.items.at(-1)).toBe(EXIT_LABEL)
  expect(paginateHome([], [], 0).items).toEqual(['no panes yet', EXIT_LABEL])
  const seen = new Set<string>()
  for (let pg = 0; pg < last.pages; pg++) paginateHome(refs, labels, pg).refs.forEach(r => r && seen.add(r.pane.id))
  expect(seen.size).toBe(50) // every pane reachable
})

test('menu order', () => {
  const m = menuItems({ blocked: false, snippets: [{ label: 'continue', text: 'continue', enter: true }] })
  expect(m.map(i => i.label)).toEqual(['enter', 'esc', 'ctrl+c', 'y', 'n', '1', '2', '3', 'tab', 'shift+tab', 'up', 'down', 'left', 'right', 'continue', '← back'])
  const b = menuItems({ blocked: true, snippets: [], jump: { label: 'web · claude', target: 'k' } })
  expect(b.slice(0, 6).map(i => i.label)).toEqual(['jump to blocked: web · claude', '1', '2', '3', 'enter', 'esc'])
  expect(b.at(-1)!.label).toBe('← back')
  expect(b.length).toBeLessThanOrEqual(20)
})

test('menu caps at 20 items and keeps back', () => {
  const snips = Array.from({ length: 30 }, (_, i) => ({ label: `s${i}`, keys: ['x'] }))
  const m = menuItems({ blocked: false, snippets: snips, jump: { label: 'a', target: 'k' } })
  expect(m.length).toBe(20); expect(m.at(-1)!.action.k).toBe('back')
})

test('chat flattening', () => {
  const t = flattenEntries([
    { id: '1', kind: 'assistant', text: 'Sure, “let me look”.' },
    { id: '2', kind: 'tool', text: '⏺ Bash: npm test' },
    { id: '3', kind: 'user', text: 'fix it\nplease' },
    { id: '4', kind: 'assistant', text: '⎿ done ✓' },
  ])
  expect(t).toBe('Sure, "let me look".\n\n● Bash: npm test\n\n> fix it\n> please\n\n└ done √')
})
test('consecutive tool lines stay together, messages are separated', () => {
  const t = flattenEntries([
    { id: '1', kind: 'tool', text: 'Read: a.ts' },
    { id: '2', kind: 'tool', text: 'Edit: a.ts' },
    { id: '3', kind: 'assistant', text: 'Done.' },
  ])
  expect(t).toBe('● Read: a.ts\n● Edit: a.ts\n\nDone.')
})
test('markdown markup is stripped from messages', () => {
  const t = flattenEntries([
    { id: '1', kind: 'assistant', text: '## Plan\n**Tau changes.** Use `tau-ai` — see [docs](https://x.y/z).\n```ts\nconst a = 1\n```' },
  ])
  expect(t).toBe('Plan\nTau changes. Use tau-ai — see docs.\nconst a = 1')
})
test('screen entries are kept as is', () => {
  expect(flattenEntries([{ id: 'screen', kind: 'screen', text: 'a\n  b\n\n\n\nc\n' }])).toBe('a\n  b\n\nc')
})
test('tool results are indented, not bulleted', () => {
  expect(flattenEntries([{ id: '1', kind: 'tool', text: '⏺ Bash: ls' }, { id: '2', kind: 'tool', text: '⎿ ok' }])).toBe('● Bash: ls\n  └ ok')
})
test('long rules in screen text are shortened', () => {
  expect(flattenEntries([{ id: 'screen', kind: 'screen', text: '▀'.repeat(120) + '\nok' }])).toBe('───\nok')
})

import type { SubagentSummary } from '@herdr-even/protocol'
import { subHeader, subItems, subRow, subSig } from './model'

const sub = (id: string, over: Partial<SubagentSummary> = {}): SubagentSummary => ({ id, label: 'general-purpose', description: 'Build bridge', status: 'done', ...over })

test('subagent rows: working first, then newest first, back row last, <=64 chars', () => {
  const items = subItems([
    sub('a', { status: 'done', lastActivity: 100, description: 'old' }),
    sub('b', { status: 'done', lastActivity: 300, description: 'newer' }),
    sub('c', { status: 'working', lastActivity: 50, description: 'x'.repeat(200) }),
  ])
  expect(items.map(i => i.id)).toEqual(['c', 'b', 'a', null])
  expect(items[1].label).toBe('general-purpose · DONE · newer')
  expect(items.at(-1)!.label).toBe('← back')
  for (const i of items) expect(Array.from(i.label).length).toBeLessThanOrEqual(64)
  expect(subItems(Array.from({ length: 30 }, (_, i) => sub('s' + i))).length).toBe(20)
  expect(subRow(sub('z', { status: 'unknown' }))).toBe('general-purpose · Build bridge')
})

test('menu: subagents (N) after keys, before snippets; read-only menu in a subagent view', () => {
  const m = menuItems({ blocked: false, snippets: [{ label: 'continue', text: 'c', enter: true }], subs: 3 })
  const labels = m.map(i => i.label)
  expect(labels.indexOf('subagents (3)')).toBe(labels.indexOf('right') + 1)
  expect(labels.indexOf('subagents (3)')).toBe(labels.indexOf('continue') - 1)
  expect(m.find(i => i.label === 'subagents (3)')!.action.k).toBe('subs')
  expect(menuItems({ blocked: false, snippets: [], subs: 0 }).some(i => i.label.startsWith('subagents'))).toBe(false)
  expect(menuItems({ blocked: false, snippets: [], subs: 2, readonly: true }).map(i => i.label)).toEqual(['← back to parent'])
  expect(menuItems({ blocked: true, snippets: [], readonly: true, jump: { label: 'web · claude', target: 'k' } }).map(i => i.action.k)).toEqual(['jump', 'parent'])
  expect(menuItems({ blocked: false, snippets: Array.from({ length: 30 }, (_, i) => ({ label: `s${i}`, keys: ['x'] })), subs: 3 }).length).toBe(20)
})

test('home row shows working-subagent count and truncates the workspace first', () => {
  expect(rowLabel(mk('w1:p1', { status: 'working', subagents: 2 }), false)).toBe('api · claude · WORKING · 2 sub')
  const long = rowLabel(mk('w1:p1', { status: 'working', subagents: 2, workspace: 'w'.repeat(100) }), true)
  expect(Array.from(long).length).toBeLessThanOrEqual(64)
  expect(long.endsWith('claude · WORKING · 2 sub')).toBe(true)
  expect(rowLabel(mk('w1:p1', { status: 'idle', subagents: 0 }), false)).toBe('api · claude · IDLE')
})

test('subagent header and inline entries with live status', () => {
  expect(subHeader(sub('a', { status: 'working' }), mk('w1:p1'), false)).toBe('→ general-purpose · WORKING · api')
  const e = [{ id: '1', kind: 'subagent' as const, text: 'general-purpose · Build bridge', subagent: 'a' }]
  expect(flattenEntries(e)).toBe('→ general-purpose · Build bridge')
  expect(flattenEntries(e, new Map([['a', sub('a', { status: 'working' })]]))).toBe('→ general-purpose · Build bridge · working')
  expect(flattenEntries([{ id: '2', kind: 'subagent', text: '↳ other' }], new Map())).toBe('→ other')
})

test('live rebuild signature changes only when a shown subagent status changes', () => {
  const entries = [{ subagent: 'a' }, {}, { subagent: 'b' }]
  const m = (sa: SubagentSummary['status'], extra?: SubagentSummary) => new Map([['a', sub('a', { status: sa })], ['b', sub('b')], ...(extra ? [[extra.id, extra] as const] : [])])
  expect(subSig(entries, m('working'))).toBe(subSig(entries, m('working', sub('zz', { status: 'working' })))) // unrelated subagent
  expect(subSig(entries, m('working'))).not.toBe(subSig(entries, m('done')))
  expect(subSig(entries, new Map())).toBe('')
})

import { sameView } from './model'
test('stale chat messages for another view are filtered', () => {
  expect(sameView({ id: 'p', subagent: 'a' }, { pane: 'p', subagent: 'a' })).toBe(true)
  expect(sameView({ id: 'p', subagent: 'a' }, { pane: 'p' })).toBe(false) // late parent message in a subagent view
  expect(sameView({ id: 'p' }, { pane: 'p', subagent: 'a' })).toBe(false) // late subagent message back in the parent
  expect(sameView({ id: 'p', subagent: 'a' }, { pane: 'p', subagent: 'b' })).toBe(false)
  expect(sameView({ id: 'p' }, { pane: 'p' })).toBe(true)
  expect(sameView({ id: 'p' }, { pane: 'q' })).toBe(false)
})

test('menu: dictate sits right after the blocked-prompt keys (top of the menu otherwise), only when enabled', () => {
  const labels = (o: Parameters<typeof menuItems>[0]) => menuItems(o).map(i => i.label)
  expect(labels({ blocked: false, snippets: [] }).includes('dictate')).toBe(false)
  expect(labels({ blocked: false, snippets: [], dictate: true }).slice(0, 3)).toEqual(['dictate', 'enter', 'esc'])
  expect(labels({ blocked: true, snippets: [], dictate: true }).slice(0, 7)).toEqual(['1', '2', '3', 'enter', 'esc', 'dictate', 'ctrl+c'])
  const j = menuItems({ blocked: true, snippets: [], dictate: true, jump: { label: 'web · claude', target: 'k' } })
  expect(j[0].action.k).toBe('jump'); expect(j[6].label).toBe('dictate')
  expect(menuItems({ blocked: false, snippets: [], dictate: true })[0].action).toEqual({ k: 'dictate' })
  expect(menuItems({ blocked: false, snippets: [], dictate: true, readonly: true }).some(i => i.label === 'dictate')).toBe(false)
  expect(menuItems({ blocked: false, snippets: Array.from({ length: 30 }, (_, i) => ({ label: `s${i}`, keys: ['x'] })), subs: 3, dictate: true }).length).toBe(20)
})

test('dictation confirm options depend on the pane status', () => {
  const labels = (w: boolean) => confirmItems(w).map(i => i.label)
  expect(labels(true)).toEqual(['queue', 'send now', 'redo', 'cancel'])
  expect(confirmItems(true).map(i => i.action)).toEqual(['queue', 'send-now', 'redo', 'cancel'])
  expect(labels(false)).toEqual(['send', 'redo', 'cancel'])
  expect(confirmItems(false)[0].action).toBe('send')
  expect(isWorkingAgent(mk('p', { status: 'working' }).pane)).toBe(true)
  expect(isWorkingAgent(mk('p', { status: 'blocked' }).pane)).toBe(false)
  expect(isWorkingAgent(mk('p', { status: 'idle' }).pane)).toBe(false)
  expect(isWorkingAgent(mk('p', { status: 'working', agent: null }).pane)).toBe(false) // plain shell
  expect(isWorkingAgent(undefined)).toBe(false)
})

test('menu: cancel queued (N) after dictate, only with a queue; queue list rows', () => {
  const l = (q?: number) => menuItems({ blocked: false, snippets: [], dictate: true, queued: q }).map(i => i.label)
  expect(l(0).some(x => x.startsWith('cancel queued'))).toBe(false)
  expect(l(2).slice(0, 3)).toEqual(['dictate', 'cancel queued (2)', 'enter'])
  expect(menuItems({ blocked: true, snippets: [], dictate: true, queued: 1 }).map(i => i.label).slice(5, 8)).toEqual(['dictate', 'cancel queued (1)', 'ctrl+c'])
  expect(menuItems({ blocked: false, snippets: [], queued: 1, readonly: true, dictate: true }).some(i => i.action.k === 'queued')).toBe(false)
  const rows = queueListItems([{ id: 'a', text: 'run the tests\nplease' }, { id: 'b', text: 'x'.repeat(200) }])
  expect(rows.map(r => r.id)).toEqual(['a', 'b', null])
  expect(rows[0].label).toBe('run the tests please')
  expect(Array.from(rows[1].label).length).toBeLessThanOrEqual(64)
  expect(rows[2].label).toBe('← back')
})

test('Codex questions show their choices in the action menu and transcript', () => {
  const q: ChatEntry = { id: 'q1', kind: 'question', text: 'Ship now?\n  1. Yes\n  2. No', questions: [{ prompt: 'Ship now?', options: ['Yes', 'No'] }], answered: false, reply: 'message' }
  expect(flattenEntries([q])).toBe('? Ship now?\n    1. Yes\n    2. No')
  const items = menuItems({ blocked: false, snippets: [], question: { id: 'q1', step: 0, options: q.questions[0]!.options, reply: q.reply } })
  expect(items.slice(0, 2).map(i => i.label)).toEqual(['1. Yes', '2. No'])
  expect(items[1]!.action).toEqual({ k: 'choice', question: 'q1', step: 0, send: { k: 'text', text: 'No', enter: true } })
  const picker = menuItems({ blocked: false, snippets: [], question: { id: 'q2', step: 0, options: ['Yes', 'No'], reply: 'keys' } })
  expect(picker[1]!.action).toEqual({ k: 'choice', question: 'q2', step: 0, send: { k: 'keys', keys: ['down', 'enter'] } })
  const full = menuItems({ blocked: true, snippets: [], question: { id: 'q1', step: 0, options: ['Yes', 'No', 'Later'], reply: 'message' }, dictate: true, queued: 2, subs: 1, jump: { label: 'other', target: 'p2' } })
  expect(full.length).toBeLessThanOrEqual(20)
  expect(full.at(-1)?.action.k).toBe('back')
})

test('queued items render in the feed as "○ queued: text", <= 2 lines each, blank line after the block', () => {
  expect(queuedLines([], 560)).toEqual([])
  expect(queuedLines([{ text: 'run the tests' }, { text: 'and commit' }], 560)).toEqual(['○ queued: run the tests', '○ queued: and commit', ''])
  const long = queuedLines([{ text: 'word '.repeat(80) }], 560)
  expect(long.length).toBe(3)
  expect(long[1].endsWith('…')).toBe(true)
  expect(long[2]).toBe('')
  expect(queuedLines([{ text: 'a\n\n  b' }], 560)[0]).toBe('○ queued: a b')
})

// ---------------------------------------------------------------- live rebuild rule + header activity
const E = (id: string, kind: Exclude<ChatEntry['kind'], 'question'>, text = id): ChatEntry => ({ id, kind, text })
const sigOf = (entries: ChatEntry[], prompt: string | null = null, sub = '', queue = '') => ({ count: nonToolCount(entries), prompt, sub, queue })

test('live chunk rebuild decision', () => {
  const base = [E('u1', 'user'), E('a1', 'assistant'), E('t1', 'tool', '● Bash: ls')]
  const prev = sigOf(base)
  expect(liveNeedsRebuild(prev, sigOf([...base, E('t2', 'tool'), E('t3', 'tool', '└ ok')]))).toBe(false) // tool-only append
  expect(liveNeedsRebuild(prev, sigOf([...base, E('t2', 'tool'), E('a2', 'assistant')]))).toBe(true)
  expect(liveNeedsRebuild(prev, sigOf([...base, E('s1', 'subagent')]))).toBe(true)
  expect(liveNeedsRebuild(prev, sigOf([...base, E('y1', 'system')]))).toBe(true)
  expect(liveNeedsRebuild(prev, sigOf(base, 'Allow? 1/2'))).toBe(true) // prompt
  expect(liveNeedsRebuild(prev, sigOf(base, null, '', 'q1'))).toBe(true) // queue
  expect(liveNeedsRebuild(prev, sigOf(base, null, 'sub1:done'))).toBe(true) // subagent status
  expect(liveNeedsRebuild(prev, sigOf(base))).toBe(false)
  expect(nonToolCount([E('s', 'screen')])).toBe(1)
})

test('header activity text', () => {
  const es = [E('a1', 'assistant'), E('t1', 'tool', '● Bash: npm test\nmore'), E('t2', 'tool', '└ 3 passed')]
  expect(activityLine(es)).toBe('Bash: npm test') // newest call line, first line only
  expect(activityLine([E('t', 'tool', '└ only result')])).toBe('└ only result')
  expect(activityLine([E('t1', 'tool'), E('a1', 'assistant')])).toBeNull() // newest is not a tool entry
  expect(activityLine([E('t1', 'tool', '⏺ Read: a.ts'), E('t2', 'tool', '⎿ ok')])).toBe('Read: a.ts') // raw result glyph
  expect(activityLine([])).toBeNull()
  expect(activityHeader('codex', 'Bash: npm test')).toBe('codex · WORKING · ● Bash: npm test')
  expect(activityHeader('codex', 'x', ['▲ new', 'N'])).toBe('codex · WORKING · ▲ new · N · ● x')
})

// ---------------------------------------------------------------- workspace grouping
const wk = (id: string, ws: string, over: Partial<PaneSummary> = {}, origin = 'o1') => mk(id, { workspace: ws, ...over }, origin)

test('workspaces: grouping, rollup status, urgency sort', () => {
  const panes = [
    wk('w1:p1', 'api', { status: 'idle' }), wk('w1:p2', 'api', { status: 'working', subagents: 2 }), wk('w1:p3', 'api', { status: 'unknown', agent: null, title: 'zsh' }),
    wk('w2:p1', 'web', { status: 'blocked' }),
    wk('w3:p1', 'docs', { status: 'idle' }),
    wk('w4:p1', 'api', { status: 'done', stateSeq: 9 }, 'o2'), // same label, other machine: separate group
  ]
  const g = groupWorkspaces(panes, {})
  expect(g.map(x => `${x.machine}/${x.workspace}`)).toEqual(['mbp/web', 'lnx/api', 'mbp/api', 'mbp/docs'])
  const api = g.find(x => x.machine === 'mbp' && x.workspace === 'api')!
  expect(api.refs.length).toBe(3)
  expect(api.top.pane.paneId).toBe('w1:p2') // working beats idle
  expect(api.subs).toBe(2)
  expect(api.refs.map(r => r.pane.paneId)).toEqual(['w1:p2', 'w1:p1', 'w1:p3'])
  // a seen done pane rolls up with idle; sorting ties by label
  const seenG = groupWorkspaces([wk('a', 'zz', { status: 'done', stateSeq: 3 }), wk('b', 'aa', { status: 'idle' })], { 'o1|default/a': 3 })
  expect(seenG.map(x => x.workspace)).toEqual(['aa', 'zz'])
})

test('workspace and pane row formats', () => {
  const panes = [wk('w1:p1', 'api', { status: 'idle' }), wk('w1:p2', 'api', { status: 'working', subagents: 2 }), wk('w1:p3', 'api', { status: 'unknown', agent: null, title: 'vim' })]
  const [g] = groupWorkspaces(panes, {})
  expect(wsRowLabel(g, false)).toBe('api · WORKING · 3 · 2 sub')
  expect(wsRowLabel(g, true)).toBe('mbp/api · WORKING · 3 · 2 sub')
  const [shell] = groupWorkspaces([wk('s', 'sh', { status: 'unknown', agent: null })], {})
  expect(wsRowLabel(shell, false)).toBe('sh · 1') // no status for plain shells
  const [blk] = groupWorkspaces([wk('b', 'x', { status: 'blocked' })], {})
  expect(wsRowLabel(blk, false)).toBe('x · BLOCKED · 1')
  const [long] = groupWorkspaces([wk('l', 'w'.repeat(100), { status: 'blocked', subagents: 3 })], {})
  const row = wsRowLabel(long, true)
  expect(Array.from(row).length).toBeLessThanOrEqual(64)
  expect(row.endsWith('· BLOCKED · 1 · 3 sub')).toBe(true)
  expect(paneRowLabel(panes[1])).toBe('claude · WORKING · 2 sub')
  expect(paneRowLabel(panes[2])).toBe('vim')
  const items = wsItems(g)
  expect(items.map(i => i.label)).toEqual(['claude · WORKING · 2 sub', 'claude · IDLE', 'vim', '← back'])
  expect(items[3].ref).toBeNull()
})

test('home paging of workspaces keeps the exit row; single-pane workspaces', () => {
  const panes = Array.from({ length: 30 }, (_, i) => wk(`w${i}:p1`, `ws${String(i).padStart(2, '0')}`, { status: 'idle' }))
  const groups = groupWorkspaces(panes, {})
  expect(groups.every(x => x.refs.length === 1)).toBe(true) // tap opens the pane directly
  const labels = groups.map(x => wsRowLabel(x, false))
  const p0 = paginateHome(groups, labels, 0)
  expect(p0.items.length).toBeLessThanOrEqual(20)
  expect(p0.items.at(-1)).toBe(EXIT_LABEL)
  expect(p0.items.at(-2)).toBe('more ▼')
  const p1 = paginateHome(groups, labels, 1)
  expect(p1.items[0]).toBe('▲ back')
  expect(p1.items.at(-1)).toBe(EXIT_LABEL)
  expect(p1.refs[1]?.workspace).toBeDefined()
})
