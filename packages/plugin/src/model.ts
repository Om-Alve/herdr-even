import type { AgentStatus, ChatEntry, PaneSummary, Snippet, SubagentSummary } from '@herdr-even/protocol'
import { pxTruncate } from '@evenrealities/pretext'
import { mapGlyphs } from './glyphs'

/** A pane from one machine. `origin` is the stable machine key; `machine` the display label. */
export interface PaneRef { origin: string; machine: string; pane: PaneSummary }

export const paneKey = (origin: string, id: string) => `${origin}|${id}`
export const refKey = (r: PaneRef) => paneKey(r.origin, r.pane.id)

/** seen[key] = stateSeq the user has already looked at. */
export type Seen = Record<string, number>

export const isDoneUnseen = (r: PaneRef, seen: Seen) => r.pane.status === 'done' && seen[refKey(r)] !== r.pane.stateSeq

/** blocked 0 -> done-and-unseen 1 -> working 2 -> idle agents (incl. seen done) 3 -> other panes 4. */
export function urgency(r: PaneRef, seen: Seen): number {
  const p = r.pane
  if (p.status === 'blocked') return 0
  if (isDoneUnseen(r, seen)) return 1
  if (p.status === 'working') return 2
  if (p.agent && (p.status === 'idle' || p.status === 'done')) return 3
  return 4
}

export function sortPanes(refs: PaneRef[], seen: Seen): PaneRef[] {
  return [...refs].sort((a, b) =>
    urgency(a, seen) - urgency(b, seen) ||
    a.machine.localeCompare(b.machine) ||
    a.pane.workspace.localeCompare(b.pane.workspace) ||
    a.pane.tab.localeCompare(b.pane.tab) ||
    a.pane.id.localeCompare(b.pane.id, undefined, { numeric: true }))
}

const STATUS_LABEL: Record<AgentStatus, string> = { idle: 'IDLE', working: 'WORKING', blocked: 'BLOCKED', done: 'DONE', unknown: '' }
export const statusLabel = (s: AgentStatus) => STATUS_LABEL[s] ?? ''

/**
 * `[machine/]workspace · agent-or-title · STATUS[ · N sub]` (no status for plain panes), <= 64 chars and one line of the
 * list. When it doesn't fit, the workspace is truncated first so the status and the sub count stay visible.
 */
export function rowLabel(r: PaneRef, multi: boolean, withStatus = true): string {
  const p = r.pane
  const ws = mapGlyphs((multi ? `${r.machine}/` : '') + p.workspace).replace(/\s+/g, ' ')
  const tail = [p.agent ?? (p.title || 'shell')]
  const st = withStatus ? statusLabel(p.status) : ''
  if (st) tail.push(st)
  if (withStatus && p.subagents > 0) tail.push(`${p.subagents} sub`)
  const tailS = mapGlyphs(tail.join(' · ')).replace(/\s+/g, ' ')
  const build = (w: string) => `${w} · ${tailS}`
  const fits = (s: string) => fitRow(s) === s
  let row = build(ws)
  if (!fits(row)) {
    const chars = Array.from(ws)
    let n = chars.length - 1
    while (n > 0 && !fits(build(chars.slice(0, n).join('') + '..'))) n--
    row = n > 0 ? build(chars.slice(0, n).join('') + '..') : row
  }
  return fitRow(row)
}

/** <= 64 chars and fits the list row width (576 - 2*12 padding, minus the selection border). */
export function fitRow(s: string, maxPx = 530): string {
  let t = Array.from(s).slice(0, 64).join('')
  t = pxTruncate(t, maxPx)
  return t
}

/** Header line for the chat view: `agent · STATUS · workspace`. */
export function chatHeader(r: PaneRef | undefined, multi: boolean): string {
  if (!r) return 'pane gone'
  const p = r.pane
  const st = statusLabel(p.status)
  return mapGlyphs([p.agent ?? (p.title || 'shell'), st, (multi ? `${r.machine}/` : '') + p.workspace].filter(Boolean).join(' · '))
}

/** Working subagents first, then newest first (lastActivity, else later in the list = newer). */
export function sortSubagents(subs: SubagentSummary[]): SubagentSummary[] {
  return subs.map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.status === 'working' ? 0 : 1) - (b.s.status === 'working' ? 0 : 1) || (b.s.lastActivity ?? 0) - (a.s.lastActivity ?? 0) || b.i - a.i)
    .map(x => x.s)
}
export const subStatus = (s: SubagentSummary['status']) => (s === 'unknown' ? '' : s.toUpperCase())
/** `label · STATUS · description`, <= 64 chars. */
export function subRow(s: SubagentSummary): string {
  return fitRow(mapGlyphs([s.label, subStatus(s.status), s.description].filter(Boolean).join(' · ')).replace(/\s+/g, ' '))
}
export const BACK_LABEL = '← back'
export interface SubItem { label: string; id: string | null }
/** The subagent list screen: <= 19 subagent rows and a last `← back` row (id null). */
export function subItems(subs: SubagentSummary[]): SubItem[] {
  return [...sortSubagents(subs).slice(0, MAX_LIST - 1).map(s => ({ label: subRow(s), id: s.id })), { label: mapGlyphs(BACK_LABEL), id: null }]
}
/** Header of a subagent view: `↳ label · STATUS · workspace`. */
export function subHeader(sub: SubagentSummary | undefined, r: PaneRef | undefined, multi: boolean): string {
  const ws = r ? (multi ? `${r.machine}/` : '') + r.pane.workspace : ''
  return mapGlyphs(['↳ ' + (sub?.label ?? 'subagent'), sub ? subStatus(sub.status) : '', ws].filter(Boolean).join(' · '))
}
/** chat* messages carry the view they belong to; late ones for a view that was already left must be dropped. */
export const sameView = (view: { origin?: string; id: string; subagent?: string }, msg: { pane: string; subagent?: string }) =>
  view.id === msg.pane && (view.subagent ?? undefined) === (msg.subagent ?? undefined)

/** Part of the live-chunk rebuild signature: statuses of the subagents the entries refer to. */
export function subSig(entries: { subagent?: string }[], subs: ReadonlyMap<string, SubagentSummary>): string {
  const out: string[] = []
  for (const e of entries) { const st = e.subagent ? subs.get(e.subagent)?.status : undefined; if (st) out.push(e.subagent + ':' + st) }
  return out.join(',')
}

export interface HomePage<T = PaneRef> { items: string[]; refs: (T | null)[]; kinds: ('pane' | 'more' | 'back' | 'exit')[]; page: number; pages: number }

export const MAX_LIST = 20
export const EXIT_LABEL = 'exit herdr-even'

/**
 * Split rows into pages of <= 20 items: a `▲ back` row on every page but the first, a `more ▼` row on every page
 * but the last, and an exit row at the end of every page.
 */
export function paginateHome<T>(sorted: T[], labels: string[], page: number): HomePage<T> {
  const n = sorted.length
  // first pass: page boundaries
  const bounds: [number, number][] = []
  let i = 0
  while (i < n) {
    const hasPrev = bounds.length > 0
    const cap = MAX_LIST - (hasPrev ? 1 : 0) - 1 // - exit row
    if (n - i <= cap) { bounds.push([i, n]); break }
    const take = cap - 1
    bounds.push([i, i + take])
    i += take
  }
  if (bounds.length === 0) bounds.push([0, 0])
  const pg = Math.min(Math.max(0, page), bounds.length - 1)
  const [a, b] = bounds[pg]
  const items: string[] = []
  const refs: (T | null)[] = []
  const kinds: HomePage['kinds'] = []
  if (pg > 0) { items.push('▲ back'); refs.push(null); kinds.push('back') }
  for (let k = a; k < b; k++) { items.push(labels[k]); refs.push(sorted[k]); kinds.push('pane') }
  if (pg < bounds.length - 1) { items.push('more ▼'); refs.push(null); kinds.push('more') }
  if (items.length === 0) { items.push('no panes yet'); refs.push(null); kinds.push('pane') }
  items.push(EXIT_LABEL); refs.push(null); kinds.push('exit')
  return { items, refs, kinds, page: pg, pages: bounds.length }
}

// ---------------------------------------------------------------- workspace grouping
/** One workspace (machine + Herdr session + workspace label) and its panes, most urgent first. */
export interface WsGroup {
  key: string
  origin: string
  machine: string
  session: string
  workspace: string
  refs: PaneRef[]
  /** The most urgent pane: its status is the workspace's rollup. */
  top: PaneRef
  urgency: number
  /** Working subagents summed over its panes. */
  subs: number
}
export const wsKey = (origin: string, session: string, workspace: string) => `${origin}|${session}|${workspace}`

/** Group panes by workspace; groups sorted by urgency, then label. */
export function groupWorkspaces(refs: PaneRef[], seen: Seen): WsGroup[] {
  const map = new Map<string, PaneRef[]>()
  for (const r of sortPanes(refs, seen)) {
    const k = wsKey(r.origin, r.pane.session, r.pane.workspace)
    const a = map.get(k)
    if (a) a.push(r); else map.set(k, [r])
  }
  const out: WsGroup[] = []
  for (const [key, rs] of map) {
    const top = rs[0] // sortPanes puts the most urgent first
    out.push({ key, origin: top.origin, machine: top.machine, session: top.pane.session, workspace: top.pane.workspace, refs: rs, top, urgency: urgency(top, seen), subs: rs.reduce((n, r) => n + (r.pane.subagents || 0), 0) })
  }
  return out.sort((a, b) =>
    a.urgency - b.urgency || a.machine.localeCompare(b.machine) || a.workspace.localeCompare(b.workspace) || a.session.localeCompare(b.session))
}

/** Status label of a workspace row: its most urgent pane's (a done pane the user has seen reads DONE too; plain shells have none). */
export const rollupLabel = (g: WsGroup): string => statusLabel(g.top.pane.status)

/** `[machine/]workspace · STATUS · n[ · N sub]`, <= 64 chars; the workspace name is truncated first. */
export function wsRowLabel(g: WsGroup, multi: boolean): string {
  const ws = mapGlyphs((multi ? `${g.machine}/` : '') + g.workspace).replace(/\s+/g, ' ')
  const tail = mapGlyphs([rollupLabel(g), String(g.refs.length), ...(g.subs > 0 ? [`${g.subs} sub`] : [])].filter(Boolean).join(' · '))
  const build = (w: string) => `${w} · ${tail}`
  const fits = (x: string) => fitRow(x) === x
  let row = build(ws)
  if (!fits(row)) {
    const chars = Array.from(ws)
    let n = chars.length - 1
    while (n > 0 && !fits(build(chars.slice(0, n).join('') + '..'))) n--
    row = n > 0 ? build(chars.slice(0, n).join('') + '..') : row
  }
  return fitRow(row)
}

/** A pane row inside the workspace screen: `agent-or-title · STATUS[ · N sub]`. */
export function paneRowLabel(r: PaneRef): string {
  const p = r.pane
  const st = statusLabel(p.status)
  return fitRow(mapGlyphs([p.agent ?? (p.title || 'shell'), ...(st ? [st] : []), ...(p.subagents > 0 ? [`${p.subagents} sub`] : [])].join(' · ')).replace(/\s+/g, ' '))
}

export interface WsItem { label: string; ref: PaneRef | null }
/** The workspace screen: its panes (<= 19) most urgent first, and a last `← back` row (ref null). */
export function wsItems(g: WsGroup): WsItem[] {
  return [...g.refs.slice(0, MAX_LIST - 1).map(r => ({ label: paneRowLabel(r), ref: r })), { label: mapGlyphs(BACK_LABEL), ref: null }]
}

// ---------------------------------------------------------------- action menu
export type MenuAction =
  | { k: 'keys'; keys: string[] }
  | { k: 'choice'; question: string; step: number; send: { k: 'text'; text: string; enter: true } | { k: 'keys'; keys: string[] } }
  | { k: 'text'; text: string; enter: boolean }
  | { k: 'jump'; target: string }
  | { k: 'back' }
  | { k: 'subs' }
  | { k: 'parent' }
  | { k: 'dictate' }
  | { k: 'queued' }

export interface MenuItem { label: string; action: MenuAction }

const keyItem = (k: string): MenuItem => ({ label: k, action: { k: 'keys', keys: [k] } })
const BASE_KEYS = ['enter', 'esc', 'ctrl+c', 'y', 'n', '1', '2', '3', 'tab', 'shift+tab', 'up', 'down', 'left', 'right']
const BLOCKED_FIRST = ['1', '2', '3', 'enter', 'esc']

export function menuItems(opts: {
  blocked: boolean
  snippets: Snippet[]
  /** Another blocked pane (not the open one): row label + its pane key. */
  jump?: { label: string; target: string }
  /** Number of subagents of the open pane; the `subagents (N)` item shows when > 0. */
  subs?: number
  /** Subagent view: no keys or snippets, just `← back to parent` (and the jump). */
  readonly?: boolean
  /** Show the `dictate` item (fallback for push-to-talk) right after the blocked-prompt keys. */
  dictate?: boolean
  /** Number of queued messages of the open pane; a `cancel queued (N)` item shows (after dictate) when > 0. */
  queued?: number
  question?: { id: string; step: number; options: string[]; reply: 'message' | 'keys' }
}): MenuItem[] {
  if (opts.readonly) {
    const out: MenuItem[] = []
    if (opts.jump) out.push({ label: fitRow(`jump to blocked: ${opts.jump.label}`), action: { k: 'jump', target: opts.jump.target } })
    out.push({ label: mapGlyphs('← back to parent'), action: { k: 'parent' } })
    return out
  }
  const first = opts.blocked ? BLOCKED_FIRST : []
  const rest = BASE_KEYS.filter(k => !first.includes(k))
  const items: MenuItem[] = []
  const question = opts.question
  if (question) items.push(...question.options.map((option, index) => ({
    label: fitRow(mapGlyphs(`${index + 1}. ${option}`)),
    action: { k: 'choice' as const, question: question.id, step: question.step, send: question.reply === 'message'
      ? { k: 'text' as const, text: option, enter: true as const }
      : { k: 'keys' as const, keys: [...Array(index).fill('down'), 'enter'] } },
  })))
  if (opts.jump) items.push({ label: fitRow(`jump to blocked: ${opts.jump.label}`), action: { k: 'jump', target: opts.jump.target } })
  items.push(...first.map(keyItem))
  if (opts.dictate) items.push({ label: 'dictate', action: { k: 'dictate' } })
  if (opts.queued && opts.queued > 0) items.push({ label: `cancel queued (${opts.queued})`, action: { k: 'queued' } })
  items.push(...rest.map(keyItem))
  if (opts.subs && opts.subs > 0) items.push({ label: `subagents (${opts.subs})`, action: { k: 'subs' } })
  if (items.length > MAX_LIST - 1) items.length = MAX_LIST - 1
  const snips: MenuItem[] = opts.snippets.map(s => ({
    label: fitRow(mapGlyphs(s.label)),
    action: s.keys?.length ? { k: 'keys', keys: s.keys } : { k: 'text', text: s.text ?? '', enter: !!s.enter },
  }))
  const room = MAX_LIST - 1 - items.length
  items.push(...snips.slice(0, Math.max(0, room)))
  items.push({ label: mapGlyphs('← back'), action: { k: 'back' } })
  return items
}

// ---------------------------------------------------------------- dictation confirm list
export type ConfirmAction = 'queue' | 'send-now' | 'send' | 'redo' | 'cancel'
export interface ConfirmItem { label: string; action: ConfirmAction }
/** An agent pane that is busy: new text can be queued until it is idle. */
export const isWorkingAgent = (p: { agent: string | null; status: string } | undefined): boolean => !!p && !!p.agent && p.status === 'working'

/** Confirm options: working agent -> queue (default) / send now; otherwise a single `send` (text + enter). */
export function confirmItems(working: boolean): ConfirmItem[] {
  return [
    ...(working
      ? [{ label: 'queue', action: 'queue' as const }, { label: 'send now', action: 'send-now' as const }]
      : [{ label: 'send', action: 'send' as const }]),
    { label: 'redo', action: 'redo' },
    { label: 'cancel', action: 'cancel' },
  ]
}

// ---------------------------------------------------------------- queued messages
export interface QueueListItem { label: string; id: string | null }
/** The `cancel queued` list: <= 19 queued rows (oldest first) and a last `← back` row (id null). */
export function queueListItems(items: { id: string; text: string }[]): QueueListItem[] {
  return [
    ...items.slice(0, MAX_LIST - 1).map(q => ({ label: fitRow(mapGlyphs(q.text).replace(/\s+/g, ' ').trim() || '(empty)'), id: q.id })),
    { label: mapGlyphs(BACK_LABEL), id: null },
  ]
}

// ---------------------------------------------------------------- live feed rebuild rule
/** What the live feed chunk was built from. Each rebuild resets the firmware's scroll position, so keep it rare. */
export interface LiveSig { count: number; prompt: string | null; sub: string; queue: string }
/** Number of entries that are not tool lines (a tool-only append must not rebuild the live chunk). */
export const nonToolCount = (entries: readonly ChatEntry[]): number => { let n = 0; for (const e of entries) if (e.kind !== 'tool') n++; return n }
/** Rebuild the live chunk only when a non-tool entry arrived, or the prompt, the queue or a subagent status changed. */
export const liveNeedsRebuild = (prev: LiveSig, cur: LiveSig): boolean =>
  prev.count !== cur.count || prev.prompt !== cur.prompt || prev.sub !== cur.sub || prev.queue !== cur.queue

// ---------------------------------------------------------------- header activity
/**
 * The tool line to show in the header while the agent works: the newest tool entry, preferring the newest call line
 * over a collapsed result (`└ …`). Null unless the newest entry is a tool entry.
 */
export function activityLine(entries: readonly ChatEntry[]): string | null {
  const last = entries[entries.length - 1]
  if (!last || last.kind !== 'tool') return null
  let pick: ChatEntry = last
  for (let i = entries.length - 1; i >= 0 && entries[i].kind === 'tool'; i--) {
    if (!mapGlyphs(entries[i].text).trimStart().startsWith('└')) { pick = entries[i]; break }
  }
  const line = mapGlyphs(pick.text).split('\n')[0].replace(/^\s*[●○]\s*/, '').replace(/\s+/g, ' ').trim()
  return line || null
}
/**
 * Header while a working agent's newest entry is a tool entry: `agent · WORKING · [marks ·] ● tool line`. `marks`
 * (▲ new, …, offline) stay visible before the tool line. The caller truncates to the header width.
 */
export const activityHeader = (label: string, line: string, marks: string[] = []): string =>
  mapGlyphs([label, 'WORKING', ...marks, `● ${line}`].join(' · '))
