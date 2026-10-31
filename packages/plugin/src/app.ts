// App core. GESTURE MAP (every handler is synchronous: it only mutates desired state, then kick()s the renderer)
//   home  (native list) : swipe = firmware list scroll | tap = open pane / more ▼ / ▲ back / exit | double tap = exit
//   chat  (text, event capture) :
//         swipe up/down = older/newer | tap = action menu | double tap = home | long press = hold to dictate (release = stop)
//   listen (text, dictation) : tap = stop | release of the long press = stop | double tap = cancel
//   confirm (text + native list) : tap = send + enter / send / redo / cancel | double tap = cancel
//   menu  (native list) : tap = send item (keys/text), back to chat, header flashes "sent √" | double tap = chat, nothing sent
// ARCHITECTURE: gestures/messages -> state (S, R) + want.gen++ -> kick() -> single-flight renderer pass() that builds the
//   desired View from state, diffs against what the glasses show (`shown`), and issues the minimum glasses calls through the
//   serialized queue in glasses.ts. Latest wins: a pass aborts between calls when want.gen moved.
import { OsEventTypeList, EventSourceType } from '@evenrealities/even_hub_sdk'
import { pxTruncate } from '@evenrealities/pretext'
import type { ChatEntry, QueuedItem, ServerMsg, SubagentSummary } from '@herdr-even/protocol'
import { Conn } from './conn'
import { bindDiag, diag, setDiagCtx, timing, flushTimings } from './diag'
import { buildPage, upgradeBody, upgradeHeader, bridge, load, store, exitApp, BODY, HDR } from './glasses'
import { DG_DEFAULT_BASE, DgStream, buildDgUrl, buildKeyterms, dictStep, type DictEffect, type DictEvent, type DictPhase } from './dictation'
import { feedPcm, micStart, micStop } from './mic'
import { flattenEntries, flattenPrompt, queuedLines, type SubMap } from './chat'
import { ellipsizeLine, geometry, nativeChunk, pagedWindow, tailBytes, toVisualLines } from './fit'
import { mapGlyphs } from './glyphs'
import {
  groupWorkspaces, wsItems, wsKey, wsRowLabel, type WsGroup, type WsItem,
  activityHeader, activityLine, chatHeader, confirmItems, liveNeedsRebuild, nonToolCount, isDoneUnseen, isWorkingAgent, menuItems, queueListItems, paginateHome, paneKey, refKey, rowLabel, sortPanes, subHeader, subItems, subSig, sameView,
  type HomePage, type SubItem, type ConfirmItem, type MenuAction, type MenuItem, type QueueListItem, type PaneRef, type Seen,
} from './model'
import * as ui from './ui'

export type Screen = 'home' | 'ws' | 'chat' | 'menu' | 'subs' | 'listen' | 'confirm' | 'queued'
export type ScrollMode = 'paged' | 'native'

// ---------------------------------------------------------------- state
interface Persisted { v: 1; screen: 'home' | 'ws' | 'chat'; ws?: WsRef | null; open: { origin: string; id: string; subagent?: string } | null; off: number; mode: ScrollMode; homePage: number; seen: Seen }

/** A workspace: machine origin + Herdr session + workspace label. */
export interface WsRef { origin: string; session: string; workspace: string }
export const S = {
  screen: 'home' as Screen,
  open: null as { origin: string; id: string; subagent?: string } | null,
  mode: 'native' as ScrollMode,
  /** Lines hidden below the visible window (0 = live bottom). Unit: visual lines (paged) / logical lines (native). */
  off: 0,
  homePage: 0,
  /** The workspace screen being shown, or the one the open pane was opened from (double tap returns to it). */
  ws: null as WsRef | null,
  seen: {} as Seen,
}

interface ChatState {
  origin: string; id: string
  /** Set when this is a subagent view (read-only transcript of one of the pane's subagents). */
  subagent?: string
  entries: ChatEntry[]; hasOlder: boolean; loaded: boolean
  source: 'transcript' | 'screen'
  prompt: string | null
  newCount: number
  olderPending: boolean
  /** A swipe asked for older content while it was being fetched: scroll once it arrives. */
  scrollOnOlder: boolean
  questionStep: Map<string, number>
}
export const R = {
  conns: [] as Conn[],
  /** Subagents per pane (paneKey), from `subagents` messages; kept across view switches. */
  subs: new Map<string, SubagentSummary[]>(),
  /** Queued messages of the open pane (paneKey), oldest first, from `queue` messages. */
  queues: new Map<string, QueuedItem[]>(),
  chat: null as ChatState | null,
  banner: null as { text: string; until: number } | null,
  flash: null as { text: string; until: number } | null,
}

const BANNER_MS = 4000
const FLASH_MS = 1800
const want = { gen: 0 }

// ---------------------------------------------------------------- persistence (debounced)
let persistTimer: ReturnType<typeof setTimeout> | undefined
export function persist(now = false) {
  clearTimeout(persistTimer)
  const run = () => {
    const p: Persisted = { v: 1, screen: S.screen === 'home' ? 'home' : S.screen === 'ws' ? 'ws' : 'chat', ws: S.ws, open: S.open, off: S.off, mode: S.mode, homePage: S.homePage, seen: S.seen }
    void store('state', JSON.stringify(p))
  }
  if (now) run(); else persistTimer = setTimeout(run, 600)
}
export async function restore() {
  try {
    const raw = await load('state')
    if (!raw) return
    const p = JSON.parse(raw) as Persisted
    if (p.v !== 1) return
    S.mode = p.mode === 'paged' ? 'paged' : 'native'
    S.seen = p.seen ?? {}
    S.homePage = p.homePage ?? 0
    if (p.ws && typeof p.ws.origin === 'string' && typeof p.ws.workspace === 'string') S.ws = { origin: p.ws.origin, session: String(p.ws.session ?? ''), workspace: p.ws.workspace }
    if (p.screen === 'ws' && S.ws) S.screen = 'ws'
    else if (p.screen === 'chat' && p.open) {
      S.open = p.open
      S.screen = 'chat'
      S.off = p.off ?? 0
      R.chat = newChat(p.open.origin, p.open.id, p.open.subagent)
    }
    diag('info', 'restored state', { screen: S.screen, open: S.open, off: S.off, mode: S.mode })
  } catch (e) { diag('warn', `restore failed: ${e}`) }
}
const newChat = (origin: string, id: string, subagent?: string): ChatState =>
  ({ origin, id, subagent, entries: [], hasOlder: false, loaded: false, source: 'transcript', prompt: null, newCount: 0, olderPending: false, scrollOnOlder: false, questionStep: new Map() })

// ---------------------------------------------------------------- derived data
const openConns = () => R.conns.filter(c => c.status === 'open')
export const isMulti = () => openConns().length > 1
export function allRefs(): PaneRef[] {
  const out: PaneRef[] = []
  for (const c of openConns()) for (const pane of c.panes) out.push({ origin: c.origin, machine: c.machine, pane })
  return out
}
const connOf = (origin: string) => R.conns.find(c => c.origin === origin)
export const currentRef = (): PaneRef | undefined => {
  if (!S.open) return undefined
  const c = connOf(S.open.origin)
  const pane = c?.panes.find(p => p.id === S.open!.id)
  return pane && c ? { origin: c.origin, machine: c.machine, pane } : undefined
}

export const openSubs = (): SubagentSummary[] => (S.open ? R.subs.get(paneKey(S.open.origin, S.open.id)) ?? [] : [])
export const openQueue = (): QueuedItem[] => (S.open && !S.open.subagent ? R.queues.get(paneKey(S.open.origin, S.open.id)) ?? [] : [])
const queueSig = () => openQueue().map(q => q.id).join(',')
let subMapCache: { list: SubagentSummary[]; map: Map<string, SubagentSummary> } | null = null
/** Subagents of the open pane by id (identity-cached on the list). */
function subMap(): SubMap {
  const list = openSubs()
  if (!subMapCache || subMapCache.list !== list) subMapCache = { list, map: new Map(list.map(x => [x.id, x])) }
  return subMapCache.map
}
const curSubSig = (c: ChatState) => subSig(c.entries, subMap())
const openReq = (c: ChatState) => ({ t: 'open' as const, pane: c.id, ...(c.subagent ? { subagent: c.subagent } : {}) })

// ---------------------------------------------------------------- chat layout (cached per input signature)
const CHAT_GEO = geometry(BODY.w, BODY.h, BODY.pad)
const HDR_W = HDR.w - 2 * HDR.pad - 4
// Device accepts <= 2000 bytes on textContainerUpgrade; the simulator enforces 999, so `?nativeBytes=990` allows testing there.
const NATIVE_BYTES = Number(new URLSearchParams(location.search).get('nativeBytes')) || 1800
const PROMPT_MAX_LINES = 6

let linesCache: { entries: ChatEntry[]; mode: ScrollMode; sub: string; lines: string[] } | null = null
/** Chat as visual lines (each one rendered row), in both modes, so offsets mean the same thing everywhere. */
function chatLines(c: ChatState): string[] {
  const sub = curSubSig(c)
  if (linesCache && linesCache.entries === c.entries && linesCache.mode === S.mode && linesCache.sub === sub) return linesCache.lines
  const lines = toVisualLines(flattenEntries(c.entries, subMap()), CHAT_GEO.innerW)
  linesCache = { entries: c.entries, mode: S.mode, sub, lines }
  return lines
}
function promptLines(c: ChatState): string[] {
  const q = c.subagent ? [] : queuedLines(openQueue(), CHAT_GEO.innerW)
  if (!c.prompt) return q
  return ['─'.repeat(22), ...toVisualLines(flattenPrompt(c.prompt), CHAT_GEO.innerW).slice(-PROMPT_MAX_LINES), ...q]
}
/** Last paged geometry result, so gesture handlers know whether there is more above. */
let lastView = { atTop: true, step: CHAT_GEO.maxLines - 1, chunk: 20, canOlder: false }

// Native feed (transcript panes): newest message first. The firmware shows an overflowing container from its top
// and only reports swipes at its edges, so the live chunk starts at the newest line: new messages appear where the
// firmware already is, and swiping through ~4 screens is the firmware's own scrolling. At the bottom edge the next
// (older) chunk starts exactly where the view already is. Older chunks are frozen and anchored to the oldest end
// (`fromBottom`), so messages arriving at the top don't move them. Screen-text panes keep bottom-anchored paging.
let F: { fromBottom: number; chunkLen: number; text: string } | null = null
/** Live chunk as last rendered. Rebuilt only when a message arrives or the prompt changes, not on every entry
 *  update, because each rebuild resets the firmware's scroll position to the top. `count` is the number of NON-tool
 *  entries: tool entries alone never rebuild it (the header shows live tool activity instead). `endFromBottom`
 *  anchors where the chunk ends to the oldest end of the feed, so newer lines arriving later don't move it. */
let live = { text: '', count: -1, prompt: null as string | null, sub: '', queue: '', endFromBottom: 0 }
const useFeed = (c: ChatState) => S.mode === 'native' && c.source === 'transcript'
/** Scrolled away from the newest content. */
const away = (c: ChatState) => (useFeed(c) ? F !== null : S.off > 0)
function toLive() { F = null; live.count = -1; live.sub = ''; live.queue = ''; S.off = 0; if (R.chat) R.chat.newCount = 0 }

let feedCache: { entries: ChatEntry[]; sub: string; lines: string[] } | null = null
function feedLines(c: ChatState): string[] {
  const sub = curSubSig(c)
  if (feedCache && feedCache.entries === c.entries && feedCache.sub === sub) return feedCache.lines
  const lines = toVisualLines(flattenEntries([...c.entries].reverse(), subMap()), CHAT_GEO.innerW)
  feedCache = { entries: c.entries, sub, lines }
  return lines
}
function feedChunk(lines: string[], top: number) {
  const ch = nativeChunk(lines, top, lines.length, NATIVE_BYTES)
  return { fromBottom: lines.length - ch.top, chunkLen: ch.chunkEnd - ch.top, text: ch.text }
}

// ---------------------------------------------------------------- views
type View =
  | { kind: 'home'; header: string; items: string[]; sig: string }
  | { kind: 'menu'; header: string; items: string[]; sig: string }
  | { kind: 'chat'; header: string; body: string; sig: string }
  | { kind: 'confirm'; header: string; body: string; items: string[]; sig: string }

let committedHome: { items: string[]; page: HomePage<WsGroup> } | null = null
let homeTimer: ReturnType<typeof setTimeout> | undefined
function computeHome(): HomePage<WsGroup> {
  const groups = groupWorkspaces(allRefs(), S.seen)
  const multi = isMulti()
  const labels = groups.map(g => wsRowLabel(g, multi))
  const page = paginateHome(groups, labels, S.homePage)
  if (page.page !== S.homePage) S.homePage = page.page
  if (!groups.length) page.items[0] = openConns().length ? 'no panes yet' : 'connecting…' // keeps the exit row
  return page
}
/** The list can't be updated in place and a rebuild resets the highlight: coalesce live changes (immediate on user action). */
function homeNow(immediate: boolean): HomePage<WsGroup> {
  const cur = computeHome()
  if (!committedHome || immediate) { committedHome = { items: cur.items, page: cur }; return cur }
  if (cur.items.join('\n') === committedHome.items.join('\n')) { committedHome.page = cur; return cur }
  if (!homeTimer) homeTimer = setTimeout(() => { homeTimer = undefined; committedHome = null; touch() }, 700)
  return committedHome.page
}

/** The workspace screen's group, if it still exists. */
const wsGroup = (w: WsRef | null): WsGroup | undefined => (w ? groupWorkspaces(allRefs(), S.seen).find(g => g.key === wsKey(w.origin, w.session, w.workspace)) : undefined)
let committedWs: { key: string; items: WsItem[]; sig: string } | null = null
let wsTimer: ReturnType<typeof setTimeout> | undefined
/** Same coalescing as the home list: a rebuild resets the highlight, so live changes land at most every 700 ms. */
function wsNow(g: WsGroup | undefined, key: string, immediate: boolean): WsItem[] {
  const cur: WsItem[] = g ? wsItems(g) : [{ label: mapGlyphs('← back'), ref: null }]
  const sig = cur.map(i => i.label).join('\n')
  if (!committedWs || committedWs.key !== key || immediate) { committedWs = { key, items: cur, sig }; return cur }
  if (sig === committedWs.sig) { committedWs.items = cur; return cur }
  if (!wsTimer) wsTimer = setTimeout(() => { wsTimer = undefined; committedWs = null; touch() }, 700)
  return committedWs.items
}
let wsCache: WsItem[] = []

const fitHdr = (s: string) => pxTruncate(mapGlyphs(s).replace(/\s+/g, ' '), HDR_W)
let menuCache: MenuItem[] = []
let subsCache: SubItem[] = []
let queuedCache: QueueListItem[] = []
let confirmCache: ConfirmItem[] = []

function overlayHeader(): string | null {
  const now = Date.now()
  if (R.banner && R.banner.until > now) return R.banner.text
  if (R.flash && R.flash.until > now) return R.flash.text
  return null
}

/** Header of the open chat view: the pane's, or `↳ label · STATUS · workspace` in a subagent view. */
const viewHeader = (ref: PaneRef | undefined) =>
  S.open?.subagent ? subHeader(subMap().get(S.open.subagent), ref, isMulti()) : chatHeader(ref, isMulti())

/** `agent · WORKING · ● tool line` while the (sub)agent works and the newest entry is a tool entry; else null. */
function headerActivity(c: ChatState, ref: PaneRef | undefined, marks: string[]): string | null {
  const line = activityLine(c.entries)
  if (!line) return null
  if (c.subagent) {
    const sub = subMap().get(c.subagent)
    return sub?.status === 'working' ? activityHeader('↳ ' + (sub.label || 'subagent'), line, marks) : null
  }
  const p = ref?.pane
  return p && p.agent && p.status === 'working' ? activityHeader(p.agent, line, marks) : null
}
/** Activity headers change on every tool call: show at most one new one per HDR_MIN_MS (the latest wins on the trailing edge). */
const HDR_MIN_MS = 500
let hdrAct: { text: string; at: number } | null = null
function throttleActivity(text: string): string {
  const now = Date.now()
  if (!hdrAct) { hdrAct = { text, at: now }; return text }
  if (text === hdrAct.text) return text
  if (now - hdrAct.at < HDR_MIN_MS) { kickSoon(hdrAct.at + HDR_MIN_MS - now + 20); return hdrAct.text }
  hdrAct = { text, at: now }
  return text
}

let immediateHome = true
function buildView(): View {
  const over = overlayHeader()
  if (S.screen === 'home') {
    const page = homeNow(immediateHome)
    immediateHome = false
    const n = page.refs.filter(Boolean).length
    const up = openConns().length
    let h = `herdr · ${allRefs().length} panes`
    if (page.pages > 1) h += ` · ${page.page + 1}/${page.pages}`
    if (up < R.conns.length) h += ` · ${up}/${R.conns.length} up`
    void n
    curHome = page
    return { kind: 'home', header: fitHdr(over ?? h), items: page.items, sig: 'list:' + page.items.join('\u0001') }
  }
  if (S.screen === 'ws') {
    const g = wsGroup(S.ws)
    wsCache = wsNow(g, S.ws ? wsKey(S.ws.origin, S.ws.session, S.ws.workspace) : '', false)
    const items = wsCache.map(m => m.label)
    const head = S.ws ? mapGlyphs((isMulti() ? `${g?.machine ?? ''}/` : '') + S.ws.workspace) : 'workspace'
    return { kind: 'menu', header: fitHdr(over ?? `${head} · ${g?.refs.length ?? 0} panes`), items, sig: 'list:' + items.join('\u0001') }
  }
  if (S.screen === 'menu') {
    const ref = currentRef()
    const c = S.open ? connOf(S.open.origin) : undefined
    const blockedOther = sortPanes(allRefs(), S.seen).find(r => r.pane.status === 'blocked' && refKey(r) !== (S.open ? paneKey(S.open.origin, S.open.id) : ''))
    const question = [...(R.chat?.entries ?? [])].reverse().find(e => e.kind === 'question' && !e.answered)
    const questionStep = question && question.kind === 'question' ? R.chat?.questionStep.get(question.id) ?? 0 : 0
    const choice = question && question.kind === 'question' && question.questions[questionStep]
    menuCache = menuItems({
      blocked: ref?.pane.status === 'blocked',
      snippets: c?.snippets ?? [],
      subs: openSubs().length,
      readonly: !!S.open?.subagent,
      dictate: true,
      queued: openQueue().length,
      question: choice && question ? { id: question.id, step: questionStep, options: choice.options, reply: question.reply } : undefined,
      jump: blockedOther ? { label: rowLabel(blockedOther, isMulti(), false), target: refKey(blockedOther) } : undefined,
    })
    const items = menuCache.map(m => m.label)
    return { kind: 'menu', header: fitHdr(over ?? (choice ? `? ${choice.prompt}` : `actions · ${viewHeader(ref)}`)), items, sig: 'list:' + items.join('\u0001') }
  }
  if (S.screen === 'queued') {
    queuedCache = queueListItems(openQueue())
    const items = queuedCache.map(m => m.label)
    return { kind: 'menu', header: fitHdr(over ?? `queued · ${chatHeader(currentRef(), isMulti())}`), items, sig: 'list:' + items.join('\u0001') }
  }
  if (S.screen === 'subs') {
    subsCache = subItems(openSubs())
    const items = subsCache.map(m => m.label)
    return { kind: 'menu', header: fitHdr(over ?? `subagents · ${chatHeader(currentRef(), isMulti())}`), items, sig: 'list:' + items.join('\u0001') }
  }
  if (S.screen === 'listen') {
    // Live partial transcript: always its tail, whole visual lines, so it can never overflow the container.
    const lines = toVisualLines(mapGlyphs(D.text), CHAT_GEO.innerW)
    const fin = D.phase === 'finalizing'
    const body = lines.length ? lines.slice(-CHAT_GEO.maxLines).join('\n') : fin ? '…' : 'speak now…'
    return { kind: 'chat', header: fitHdr(`${fin ? '… finalizing' : '● listening'} · ${paneName()}`), body: tailBytes(body, 900), sig: 'chat' }
  }
  if (S.screen === 'confirm') {
    const lines = toVisualLines(mapGlyphs(D.transcript), CHAT_GEO.innerW)
    const keep = lines.slice(0, CONFIRM_LINES)
    if (lines.length > CONFIRM_LINES) keep[CONFIRM_LINES - 1] = ellipsizeLine(keep[CONFIRM_LINES - 1], CHAT_GEO.innerW)
    const body = keep.join('\n')
    confirmCache = confirmItems(isWorkingAgent(currentRef()?.pane))
    const items = confirmCache.map(i => i.label)
    return { kind: 'confirm', header: fitHdr(over ?? `send to ${paneName()}?`), body, items, sig: `confirm:${items.join(',')}:${body}` }
  }
  // chat
  const c = R.chat
  const ref = currentRef()
  let header = viewHeader(ref)
  let body: string
  if (!c || !c.loaded) {
    const conn = S.open ? connOf(S.open.origin) : undefined
    body = conn?.status === 'open' ? 'loading…' : 'offline · reconnecting…'
  } else if (useFeed(c)) {
    const sub = curSubSig(c)
    const qsig = c.subagent ? '' : queueSig()
    const cur = { count: nonToolCount(c.entries), prompt: c.prompt, sub, queue: qsig }
    if (!F && liveNeedsRebuild(live, cur)) {
      // The prompt (a permission dialog) goes first: it's what needs you. Queued messages sit between it and the newest message.
      const pin = [
        ...(c.prompt ? [...toVisualLines(flattenPrompt(c.prompt), CHAT_GEO.innerW).slice(-PROMPT_MAX_LINES), '─'.repeat(22)] : []),
        ...(c.subagent ? [] : queuedLines(openQueue(), CHAT_GEO.innerW)),
      ]
      const all = [...pin, ...feedLines(c)]
      const ch = nativeChunk(all, 0, all.length, NATIVE_BYTES)
      live = { text: ch.text, ...cur, endFromBottom: feedLines(c).length - Math.max(0, ch.chunkEnd - pin.length) }
    }
    lastView = { atTop: !F, step: 0, chunk: 0, canOlder: c.hasOlder }
    body = (F ? F.text : live.text) || '(empty)'
  } else {
    // Paged: bottom-anchored, one screen per swipe (also used for screen-text panes in native mode).
    const v = pagedWindow(chatLines(c), S.off, CHAT_GEO, promptLines(c))
    if (S.off !== v.off) S.off = v.off
    lastView = { atTop: v.atTop, step: CHAT_GEO.maxLines - 1, chunk: 20, canOlder: c.hasOlder }
    body = v.text || '(empty)'
  }
  let act: string | null = null
  if (c && c.loaded) {
    const marks: string[] = []
    if (away(c) && c.newCount > 0) marks.push(useFeed(c) ? '▲ new' : '▼ new')
    if (c.olderPending) marks.push('…')
    if (S.open && connOf(S.open.origin)?.status !== 'open') marks.push('offline')
    if (S.mode === 'native') marks.push('N')
    // Live tool activity goes in the header: updating it doesn't touch the body's scroll position.
    act = c.source === 'transcript' ? headerActivity(c, ref, marks) : null
    header = act ? throttleActivity(act) : [header, ...marks].join(' · ')
  }
  if (!act) hdrAct = null
  return { kind: 'chat', header: fitHdr(over ?? header), body, sig: 'chat' }
}
let curHome: HomePage<WsGroup> | null = null
const CONFIRM_LINES = 3 // with 4, the last confirm option (cancel) falls partly off-screen
const paneName = () => { const r = currentRef(); return r ? mapGlyphs((isMulti() ? `${r.machine}/` : '') + r.pane.workspace) : 'pane' }

// ---------------------------------------------------------------- renderer (single-flight, latest wins)
const shown = { sig: '', header: '', body: '', homeRefs: [] as (WsGroup | null)[], homeKinds: [] as HomePage['kinds'] }
let running = false
let again = false
let gestures: { kind: string; t0: number }[] = []
let lastView0: View | null = null

export function touch() { want.gen++; kick() }
function gesture(kind: string) { gestures.push({ kind, t0: performance.now() }); if (gestures.length > 30) gestures.shift(); touch() }

export function kick() {
  if (running) { again = true; return }
  running = true
  void (async () => {
    try { do { again = false; await pass() } while (again) }
    catch (e) { diag('error', `render error: ${e}`) }
    finally { running = false }
  })()
}
let softTimer: ReturnType<typeof setTimeout> | undefined
const kickSoon = (ms = 250) => { if (!softTimer) softTimer = setTimeout(() => { softTimer = undefined; touch() }, ms) }

async function pass() {
  const gen = want.gen
  const view = buildView()
  lastView0 = view
  ui.renderPreview(S.screen, S.open ? `${S.open.id}` : '', view.header, view.kind === 'chat' ? view.body : view.kind === 'confirm' ? view.body + '\n' + view.items.join(' | ') : view.items.join('\n'))
  ui.renderStatus(statusInfo())
  syncWarm()
  // Plain browser (dev) or a failed page build: keep the home rows selectable via the phone page's `select row`.
  if (view.kind === 'home' && curHome && shown.sig !== view.sig) { shown.homeRefs = curHome.refs; shown.homeKinds = curHome.kinds }
  if (!bridge) { gestures = []; return }
  const stale = () => want.gen !== gen
  if (view.sig !== shown.sig) {
    shown.sig = ''
    const t0 = performance.now()
    const ok = await buildPage(view.kind === 'chat'
      ? { kind: 'text', header: view.header, body: tailBytes(view.body, 1000) }
      : view.kind === 'confirm'
        ? { kind: 'confirm', header: view.header, body: view.body, items: view.items }
        : { kind: 'list', header: view.header, items: view.items })
    if (!ok) { kickSoon(2000); return }
    timing('page:' + view.kind, performance.now() - t0)
    shown.sig = view.sig
    shown.header = view.header
    shown.body = view.kind === 'chat' ? tailBytes(view.body, 1000) : ''
    if (view.kind === 'home' && curHome) { shown.homeRefs = curHome.refs; shown.homeKinds = curHome.kinds }
    if (stale()) return
  }
  if (view.header !== shown.header) {
    shown.header = view.header
    if (!(await upgradeHeader(view.header))) shown.header = ''
    if (stale()) return
  }
  if (view.kind === 'chat' && view.body !== shown.body) {
    shown.body = view.body
    if (!(await upgradeBody(view.body))) shown.body = ''
    if (stale()) return
  }
  // overlay expiry
  const now = Date.now()
  const exp = Math.min(...[R.banner?.until, R.flash?.until].filter((x): x is number => !!x && x > now))
  if (isFinite(exp)) kickSoon(exp - now + 30)
  const t = performance.now()
  for (const g of gestures) timing(`gesture:${g.kind}->render`, t - g.t0)
  gestures = []
}

function statusInfo(): ui.StatusInfo {
  return {
    conns: R.conns.map(c => ({ origin: c.origin, status: c.status, machine: c.machine, panes: c.panes.length, err: c.lastError, opens: c.opens })),
    screen: S.screen, pane: S.open ? S.open.id : '', mode: S.mode, off: S.off,
    kbd: kbdInfo(), queue: openQueue().map(q => ({ id: q.id, text: q.text })), dg: { src: dgKeySrc, phase: D.phase },
  }
}

// ---------------------------------------------------------------- actions
/** Drop the open pane (unsubscribe, clear chat state). */
function leavePane() {
  abortDictation()
  if (S.open) R.queues.delete(paneKey(S.open.origin, S.open.id))
  if (S.open) R.conns.find(c => c.origin === S.open!.origin)?.send({ t: 'close', id: 'x' + Date.now() })
  S.open = null; R.chat = null; toLive()
}
export function goHome() {
  leavePane()
  S.screen = 'home'; S.ws = null
  immediateHome = true; committedHome = null
  persist(); gesture('home')
}
/** Show a workspace's pane list. */
export function openWorkspace(g: { origin: string; session: string; workspace: string }) {
  leavePane()
  S.ws = { origin: g.origin, session: g.session, workspace: g.workspace }
  S.screen = 'ws'; committedWs = null
  persist(); gesture('ws')
}
/** Back from a pane opened out of a workspace screen: that screen again (home if the workspace is gone). */
function backToWorkspace() {
  if (S.ws && wsGroup(S.ws)) { leavePane(); S.screen = 'ws'; committedWs = null; persist(); gesture('ws-back') } else goHome()
}

/** `fromWs`: opened from the workspace screen, so double tap returns there (otherwise it goes home). */
export function openPane(origin: string, id: string, fromWs = false) {
  if (!fromWs) S.ws = null
  const prev = S.open
  if (prev && prev.origin !== origin) connOf(prev.origin)?.send({ t: 'close', id: 'x' + Date.now() })
  abortDictation()
  R.queues.delete(paneKey(origin, id))
  warmBlockedUntil = 0
  S.open = { origin, id }; S.screen = 'chat'
  R.chat = newChat(origin, id)
  toLive()
  const ref = currentRef()
  if (ref && isDoneUnseen(ref, S.seen)) S.seen[refKey(ref)] = ref.pane.stateSeq
  const c = connOf(origin)
  if (c) void c.request({ t: 'open', pane: id })
  persist(); gesture('open')
}

/** Open one of the open pane's subagents (read-only transcript, same chat view). */
export function openSubagent(subId: string) {
  if (!S.open) return
  S.open = { origin: S.open.origin, id: S.open.id, subagent: subId }; S.screen = 'chat'
  R.chat = newChat(S.open.origin, S.open.id, subId)
  toLive()
  const c = connOf(S.open.origin)
  if (c) void c.request(openReq(R.chat))
  persist(); gesture('open-sub')
}
/** Leave a subagent view: re-open the parent chat. */
function backToParent() { if (S.open?.subagent) openPane(S.open.origin, S.open.id) }

function requestOlder() {
  const c = R.chat
  if (!c || c.olderPending || !c.hasOlder || !c.entries.length) return
  const conn = connOf(c.origin)
  if (!conn) return
  c.olderPending = true
  diag('info', 'older requested', { before: c.entries[0].id, have: c.entries.length })
  void conn.request({ t: 'older', pane: c.id, ...(c.subagent ? { subagent: c.subagent } : {}), before: c.entries[0].id, limit: 50 }).then(r => {
    if (r === null && R.chat === c) { c.olderPending = false; c.scrollOnOlder = false; touch() }
  })
}

function swipe(dir: -1 | 1) {
  // -1 = SCROLL_TOP (swipe up on the temple): older. +1 = SCROLL_BOTTOM: newer.
  const c = R.chat
  if (S.screen !== 'chat' || !c || !c.loaded) return
  if (!useFeed(c)) {
    if (dir < 0) {
      if (!lastView.atTop) S.off += lastView.step
      else if (c.hasOlder) { c.scrollOnOlder = true; requestOlder() }
    } else S.off = Math.max(0, S.off - lastView.step)
  } else {
    // Feed is newest-first: the top edge (-1) is newer, the bottom edge (+1) is older.
    if (dir > 0) feedDown(c)
    else feedUp(c)
    diag('info', 'feed edge', { ...paneCtx(), dir: dir > 0 ? 'bottom→older' : 'top→newer', live: !F, fromBottom: F?.fromBottom, chunkLen: F?.chunkLen })
  }
  if (!away(c)) c.newCount = 0
  persist(); gesture('scroll')
}

/** Bottom edge: continue into older messages with the next chunk, starting where the view already is. */
function feedDown(c: ChatState) {
  const lines = feedLines(c)
  const top = F ? lines.length - F.fromBottom : 0
  const end = F ? top + F.chunkLen : Math.max(0, lines.length - live.endFromBottom)
  if (end >= lines.length) {
    if (c.hasOlder) { c.scrollOnOlder = true; requestOlder() }
    return
  }
  F = feedChunk(lines, Math.max(top + 1, end - CHAT_GEO.maxLines))
}

/** Top edge of an older chunk: one screen newer (one line of overlap); reaching the newest goes live. */
function feedUp(c: ChatState) {
  if (!F) return
  const lines = feedLines(c)
  const top = lines.length - F.fromBottom - (CHAT_GEO.maxLines - 1)
  if (top <= 0) { toLive(); return }
  F = feedChunk(lines, top)
}

function toast(text: string, ms = FLASH_MS) { R.flash = { text, until: Date.now() + ms }; touch() }

function runMenu(item: MenuItem) {
  const a: MenuAction = item.action
  if (a.k === 'back') { S.screen = 'chat'; persist(); gesture('menu-back'); return }
  if (a.k === 'subs') { S.screen = 'subs'; gesture('subs'); return }
  if (a.k === 'parent') { backToParent(); return }
  if (a.k === 'dictate') { startDictation('menu'); return }
  if (a.k === 'queued') { S.screen = 'queued'; gesture('queued'); return }
  if (a.k === 'jump') {
    const t = allRefs().find(r => refKey(r) === a.target)
    if (t) openPane(t.origin, t.pane.id); else { S.screen = 'chat'; toast('pane gone') }
    return
  }
  if (a.k === 'choice') {
    S.screen = 'chat'
    toLive()
    persist(); gesture('menu-choice')
    const chat = R.chat
    void sendToOpen(a.send).then(r => {
      if (r.ok && chat) { chat.questionStep.set(a.question, a.step + 1); if (R.chat === chat) touch() }
    })
    return
  }
  S.screen = 'chat'
  toLive() // snap to the newest content so the effect of the key is visible
  persist(); gesture('menu-send')
  void sendToOpen(a)
}

/** Send keys or text to the open pane through its bridge; flashes the result on the glasses header. */
async function sendToOpen(a: { k: 'keys'; keys: string[] } | { k: 'text'; text: string; enter: boolean; queue?: boolean }): Promise<{ ok: boolean; msg: string }> {
  const o = S.open
  const conn = o ? connOf(o.origin) : undefined
  if (!o || !conn) { toast('no pane'); return { ok: false, msg: 'no pane open' } }
  const req = a.k === 'keys' ? { t: 'keys' as const, pane: o.id, keys: a.keys } : { t: 'text' as const, pane: o.id, text: a.text, enter: a.enter, ...(a.queue ? { queue: true } : {}) }
  const t0 = performance.now()
  const r = await conn.request(req)
  timing('send:' + a.k, performance.now() - t0)
  if (r?.t === 'ok') { const m = a.k === 'text' && a.queue ? 'queued ✓' : 'sent ✓'; toast(m); return { ok: true, msg: m } }
  if (r?.t === 'error') { diag('warn', `send rejected ${r.code}: ${r.message}`); toast(`error: ${r.code}`, 2500); return { ok: false, msg: `error: ${r.code}` } }
  toast('send failed', 2500)
  return { ok: false, msg: 'send failed (no reply)' }
}

// ---------------------------------------------------------------- phone keyboard
export interface KbdInfo { ok: boolean; pane: string; status: string; why: string; working: boolean }
export function kbdInfo(): KbdInfo {
  const o = S.open
  if (!o) return { ok: false, pane: '', status: '', why: 'Open a pane on your glasses to send to it.', working: false }
  if (o.subagent) return { ok: false, pane: '', status: '', why: 'Subagent views are read-only.', working: false }
  if (connOf(o.origin)?.status !== 'open') return { ok: false, pane: '', status: '', why: 'Connection to this machine is down.', working: false }
  const r = currentRef()
  return { ok: true, pane: r ? `${paneName()} · ${r.pane.agent ?? (r.pane.title || 'shell')}` : paneName(), status: r?.pane.status && r.pane.status !== 'unknown' ? r.pane.status.toUpperCase() : '', why: '', working: isWorkingAgent(r?.pane) }
}
/** Phone page: send text (+ enter), or with `queue` hold it until the agent is idle; or a single key. */
export async function sendFromPhone(a: { keys: string[] } | { text: string; queue?: boolean }): Promise<{ ok: boolean; msg: string }> {
  const k = kbdInfo()
  if (!k.ok) return { ok: false, msg: k.why }
  if ('text' in a && !a.text.trim()) return { ok: false, msg: 'nothing to send' }
  if ('text' in a && a.queue && !k.working) return { ok: false, msg: 'agent is not working: use Send' }
  if (S.screen === 'chat') toLive() // snap to the newest content so the effect is visible
  return sendToOpen('keys' in a ? { k: 'keys', keys: a.keys } : { k: 'text', text: a.text, enter: true, ...(a.queue ? { queue: true } : {}) })
}
/** Remove a queued message (glasses list or phone ✕). */
export async function unqueueItem(item: string): Promise<{ ok: boolean; msg: string }> {
  const o = S.open
  const conn = o ? connOf(o.origin) : undefined
  if (!o || !conn) return { ok: false, msg: 'no pane open' }
  const r = await conn.request({ t: 'unqueue', pane: o.id, item })
  if (r?.t === 'ok') { toast('removed ✓'); return { ok: true, msg: 'removed' } }
  if (r?.t === 'error') { toast(r.code === 'unknown_item' ? 'already sent' : `error: ${r.code}`, 2500); return { ok: false, msg: r.code === 'unknown_item' ? 'already delivered' : r.code } }
  toast('remove failed', 2500)
  return { ok: false, msg: 'no reply' }
}

function onListSelect(idx: number, name: string | undefined) {
  if (S.screen === 'home') {
    const refs = shown.homeRefs, kinds = shown.homeKinds
    let i = idx
    if (name !== undefined && committedHome && committedHome.items[idx] !== name) {
      const j = committedHome.items.indexOf(name)
      if (j >= 0) i = j
    }
    const kind = kinds[i]
    if (kind === 'more') { S.homePage++; immediateHome = true; persist(); gesture('home-page'); return }
    if (kind === 'back') { S.homePage = Math.max(0, S.homePage - 1); immediateHome = true; persist(); gesture('home-page'); return }
    if (kind === 'exit') { exit(); return }
    const g = refs[i]
    if (g) { if (g.refs.length === 1) openPane(g.origin, g.refs[0].pane.id); else openWorkspace(g) }
  } else if (S.screen === 'ws') {
    let item = wsCache[idx]
    if (name !== undefined && item && item.label !== name) item = wsCache.find(m => m.label === name) ?? item
    if (!item) return
    if (item.ref) openPane(item.ref.origin, item.ref.pane.id, true); else goHome()
  } else if (S.screen === 'menu') {
    let item = menuCache[idx]
    if (name !== undefined && item && item.label !== name) item = menuCache.find(m => m.label === name) ?? item
    if (item) runMenu(item)
  } else if (S.screen === 'confirm') {
    let item = confirmCache[idx]
    if (name !== undefined && item && item.label !== name) item = confirmCache.find(m => m.label === name) ?? item
    if (item) onConfirm(item.action)
  } else if (S.screen === 'queued') {
    let item = queuedCache[idx]
    if (name !== undefined && item && item.label !== name) item = queuedCache.find(m => m.label === name) ?? item
    if (!item) return
    if (item.id) void unqueueItem(item.id); else { S.screen = 'chat'; gesture('queued-back') }
  } else if (S.screen === 'subs') {
    let item = subsCache[idx]
    if (name !== undefined && item && item.label !== name) item = subsCache.find(m => m.label === name) ?? item
    if (!item) return
    if (item.id) openSubagent(item.id); else { S.screen = 'chat'; gesture('subs-back') }
  }
}

function onTap() {
  if (S.screen === 'chat' && R.chat) { S.screen = 'menu'; gesture('tap-menu') }
  else if (S.screen === 'listen') stopDictation() // fallback toggle: tap starts (menu → dictate), tap again stops
}
/** Double tap steps back: menu → chat → pane list → exit. */
function onDouble() {
  if (S.screen === 'chat') { if (S.open?.subagent) backToParent(); else if (S.ws) backToWorkspace(); else goHome() }
  else if (S.screen === 'ws') goHome()
  else if (S.screen === 'subs') { S.screen = 'chat'; gesture('subs-cancel') }
  else if (S.screen === 'queued') { S.screen = 'menu'; gesture('queued-cancel') }
  else if (S.screen === 'menu') { S.screen = 'chat'; gesture('menu-cancel') }
  else if (S.screen === 'listen' || S.screen === 'confirm') cancelDictation()
  else if (S.screen === 'home') exit()
}
function exit() {
  diag('info', 'exit requested', { screen: S.screen })
  persist()
  void exitApp()
}
/** Long press (left temple): hold to talk. */
function onLong() {
  if (S.screen !== 'chat') return
  if (S.open?.subagent) { toast('subagents are read-only'); return }
  startDictation('long')
}
/** Releasing a long press ends a push-to-talk dictation (a menu-started one is stopped by tap instead). */
function onLongRelease() { if (D.phase === 'listening' && D.trigger === 'long') stopDictation() }

// ---------------------------------------------------------------- dictation
const qp = new URLSearchParams(location.search)
const DG_BASE = qp.get('dgUrl') || DG_DEFAULT_BASE
let dgKey = ''
let dgKeySrc: 'phone' | 'build' | 'none' = 'none'
/** Key order: SDK local storage (set on the phone page), then the build-time VITE_DEEPGRAM_API_KEY. Never logged or sent to a bridge. */
export async function loadDeepgramKey() {
  const stored = (await load('deepgramKey')).trim()
  const env = String(import.meta.env.VITE_DEEPGRAM_API_KEY ?? '').trim()
  dgKey = stored || env
  dgKeySrc = stored ? 'phone' : env ? 'build' : 'none'
  touch()
}
export async function setDeepgramKey(k: string) {
  if (warm) { warm.close(); warm = null } // it was opened with the old key
  await store('deepgramKey', k.trim())
  await loadDeepgramKey()
}
/** `?dgUrl=` (a mock Deepgram) needs no real key. */
const effectiveKey = () => dgKey || (qp.get('dgUrl') ? 'mock-key' : '')

export const D = { phase: 'idle' as DictPhase, id: 0, trigger: 'long' as 'long' | 'menu', stream: null as DgStream | null, text: '', transcript: '', wasWarm: false, err: '', queue: false }
let warm: DgStream | null = null
/** After an idle close (2 min) or a failed socket: don't reopen the warm socket until this time (Infinity = until a pane is opened). */
let warmBlockedUntil = 0
let fgActive = true

const canDictate = () => !!S.open && !S.open.subagent && !!R.chat && (S.screen === 'chat' || S.screen === 'menu')

function newStream(kind: 'warm' | 'press'): DgStream {
  const url = buildDgUrl(DG_BASE, buildKeyterms(allRefs().map(r => r.pane)))
  const s: DgStream = new DgStream(url, effectiveKey(), {
    onOpen: ms => diag('info', 'deepgram socket open', { ms, kind }),
    onClose: (reason, detail) => {
      if (warm === s) {
        warm = null
        if (reason === 'idle') warmBlockedUntil = Infinity
        else if (reason === 'error') { warmBlockedUntil = Date.now() + 30000; diag('warn', 'deepgram warm socket failed', { detail }) }
      }
      if (D.stream === s && D.phase === 'listening' && reason !== 'local') dictError(`deepgram closed (${detail ?? reason})`)
    },
    onError: msg => { if (D.stream === s) dictError(`deepgram ${msg}`); else diag('warn', `deepgram socket ${msg}`) },
  })
  return s
}

/** Keep one warm socket while a chat screen is open and a key is set, so a long press streams immediately. */
function syncWarm() {
  const want = !!effectiveKey() && fgActive && !!S.open && !S.open.subagent && S.screen !== 'home' && D.phase !== 'listening' && D.phase !== 'finalizing'
  if (!want) { if (warm) { warm.close(); warm = null } return }
  if (warm && !warm.dead) return
  if (Date.now() < warmBlockedUntil) return
  warm = newStream('warm')
}

function run(r: { phase: DictPhase; fx: DictEffect[] }) {
  D.phase = r.phase
  for (const fx of r.fx) effect(fx)
}
const step = (ev: DictEvent) => run(dictStep(D.phase, ev))

function effect(fx: DictEffect) {
  switch (fx) {
    case 'noKey': S.screen = 'chat'; toast('set Deepgram key on phone', 3000); break
    case 'beginListen': beginListen(); break
    case 'finalize': doFinalize(); break
    case 'empty': S.screen = 'chat'; toast("didn't catch that", 2500); break
    case 'showConfirm': S.screen = 'confirm'; gesture('confirm'); break
    case 'send': doSend(); break
    case 'abort': abortStream(); break
    case 'error': S.screen = 'chat'; toast(D.err || 'dictation failed', 3000); break
  }
}

export function startDictation(trigger: 'long' | 'menu') {
  D.trigger = trigger
  step({ t: 'start', canDictate: canDictate(), hasKey: !!effectiveKey() })
  if (D.phase === 'idle' && S.screen === 'menu') { S.screen = 'chat'; gesture('dictate-denied') }
}
export const stopDictation = () => step({ t: 'stop' })
export function cancelDictation() { step({ t: 'cancel' }); if (S.screen === 'listen' || S.screen === 'confirm') S.screen = 'chat'; syncWarm(); gesture('dictate-cancel') }
/** Leaving the chat (home, pane gone, foreground exit): drop everything silently. */
function abortDictation() { step({ t: 'leave' }); if (S.screen === 'listen' || S.screen === 'confirm') S.screen = 'chat' }
function dictError(msg: string) {
  D.err = msg.length > 40 ? msg.slice(0, 39) + '…' : msg
  diag('error', `dictation error: ${msg}`)
  step({ t: 'error' })
  syncWarm()
}
function onConfirm(a: ConfirmItem['action']) {
  if (a === 'queue' || a === 'send-now' || a === 'send') { D.queue = a === 'queue'; step({ t: 'send' }) }
  else if (a === 'redo') step({ t: 'redo' })
  else cancelDictation()
}

function abortStream() {
  const s = D.stream
  D.id++ // invalidates in-flight continuations
  D.stream = null
  if (s) { s.abort(); void micStop() } // audioControl(false) on every abort path
}

function beginListen() {
  const id = ++D.id
  D.text = ''; D.transcript = ''; D.err = ''
  S.screen = 'listen'
  let s = warm && !warm.dead ? warm : null
  D.wasWarm = !!s
  if (s) warm = null; else s = newStream('press')
  D.stream = s
  const live = () => D.id === id && (D.phase === 'listening' || D.phase === 'finalizing')
  s.begin(t => { if (live()) { D.text = t; listenTouch() } })
  diag('info', 'dictation start', { trigger: D.trigger, warm: D.wasWarm, socketOpen: s.ready, openMs: s.openMs, ageMs: s.ageMs })
  gesture('dictate')
  void micStart(pcm => { if (D.id === id && D.phase === 'listening') s!.sendPcm(pcm) }).then(ok => {
    if (!ok && D.id === id && D.phase === 'listening') dictError('mic failed')
  })
}

function doFinalize() {
  const id = D.id
  const s = D.stream!
  void micStop() // audioControl(false) (queued behind the current render); Finalize goes out right away
  gesture('dictate-release')
  void (async () => {
    const res = await s.finish()
    if (D.id !== id || D.phase !== 'finalizing') return
    D.stream = null
    // never the transcript text itself
    diag('info', 'dictation done', { warm: D.wasWarm, openMs: s.openMs, pressToFirstPartialMs: res.firstPartialMs, releaseToFinalMs: res.releaseToFinalMs, chars: res.transcript.length, frames: res.frames, error: res.error })
    warmBlockedUntil = 0
    if (res.error && !res.transcript) { dictError(res.error === 'final timeout' ? 'no transcript' : 'deepgram: ' + res.error); return }
    D.transcript = res.transcript
    step({ t: 'final', transcript: res.transcript })
    syncWarm() // a fresh warm socket for the next dictation (or a redo)
  })()
}

function doSend() {
  const text = D.transcript
  D.transcript = ''
  S.screen = 'chat'
  toLive()
  persist(); gesture('dictation-send')
  void sendToOpen({ k: 'text', text, enter: true, ...(D.queue ? { queue: true } : {}) })
  syncWarm()
}

let lastListenTouch = 0
let listenTimer: ReturnType<typeof setTimeout> | undefined
/** Partials arrive faster than the glasses link can take upgrades: at most ~4 renders per second. */
function listenTouch() {
  const dt = Date.now() - lastListenTouch
  if (dt >= 250) { lastListenTouch = Date.now(); touch() }
  else if (!listenTimer) listenTimer = setTimeout(() => { listenTimer = undefined; lastListenTouch = Date.now(); touch() }, 250 - dt)
}

/** Which pane/source/agent device logs are about. */
const paneCtx = (): Record<string, unknown> => ({
  pane: S.open ? (S.open.subagent ? `${S.open.id}>${S.open.subagent}` : S.open.id) : null,
  src: R.chat?.source ?? null,
  agent: currentRef()?.pane.agent ?? null,
})

// ---------------------------------------------------------------- input events
const typeName = (t: number) => OsEventTypeList[t] ?? `UNKNOWN_${t}`
let lastEvAt = 0
function logEv(kind: string, type: number, extra: Record<string, unknown> = {}) {
  const now = performance.now()
  const dt = lastEvAt ? Math.round(now - lastEvAt) : null
  lastEvAt = now
  // scroll behaviour is the point of this log: always carry mode/off/screen and the gap since the previous event
  diag('info', `ev ${kind}:${typeName(type)}`, { ...paneCtx(), screen: S.screen, mode: S.mode, off: S.off, dtMs: dt, ...extra })
}

export function onHubEvent(ev: any) {
  if (ev.audioEvent) { if (ev.audioEvent.audioPcm) feedPcm(ev.audioEvent.audioPcm); return }
  const le = ev.listEvent, te = ev.textEvent, se = ev.sysEvent
  if (le) {
    const t = le.eventType ?? 0
    logEv('list', t, { idx: le.currentSelectItemIndex ?? 0, name: le.currentSelectItemName })
    if (t === OsEventTypeList.CLICK_EVENT) onListSelect(le.currentSelectItemIndex ?? 0, le.currentSelectItemName)
    else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) onDouble()
  }
  if (te) {
    const t = te.eventType ?? 0
    logEv('text', t)
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) swipe(-1)
    else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) swipe(1)
    else if (t === OsEventTypeList.CLICK_EVENT) onTap()
    else if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) onDouble()
  }
  if (se) {
    const t = se.eventType ?? 0
    if (t === OsEventTypeList.IMU_DATA_REPORT) return
    logEv('sys', t, { src: EventSourceType[se.eventSource ?? 0] })
    switch (t) {
      case OsEventTypeList.CLICK_EVENT: if (!le && !te) onTap(); break
      case OsEventTypeList.DOUBLE_CLICK_EVENT: if (!le && !te) onDouble(); break
      case OsEventTypeList.LONG_PRESS_EVENT: onLong(); break
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT: onLongRelease(); break
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: diag('info', 'FOREGROUND_ENTER'); onResume('foreground-enter'); break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT: diag('info', 'FOREGROUND_EXIT'); onBackground(); persist(true); flushTimings(); break
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT: diag('warn', typeName(t)); onBackground(); persist(true); flushTimings(); break
    }
  }
}

/** The plugin lost the foreground: mic off, dictation dropped, warm socket closed. */
function onBackground() {
  fgActive = false
  abortDictation()
  void micStop() // always audioControl(false)
  if (warm) { warm.close(); warm = null }
}

// ---------------------------------------------------------------- bridge messages
function handleMsg(c: Conn, m: ServerMsg) {
  switch (m.t) {
    case 'panes': onPanes(c, m.panes); break
    case 'chat': {
      const ch = R.chat
      if (!ch || ch.origin !== c.origin || !sameView(ch, m)) break
      ch.entries = m.entries; ch.hasOlder = m.hasOlder; ch.loaded = true; ch.olderPending = false
      ch.source = m.source
      if (useFeed(ch)) toLive() // full resync: feed positions are no longer valid
      if (!away(ch)) ch.newCount = 0
      touch(); break
    }
    case 'chat.append': {
      const ch = R.chat
      if (!ch || ch.origin !== c.origin || !sameView(ch, m) || !ch.loaded) break
      const before = chatLines(ch).length
      const known = new Set(ch.entries.map(e => e.id))
      ch.entries = [...ch.entries, ...m.entries.filter(e => !known.has(e.id))]
      if (away(ch)) ch.newCount += m.entries.length // keep the view still, show the marker
      // Paged keeps its window still by counting from the bottom; feed chunks are anchored to the oldest end already.
      if (!useFeed(ch) && S.off > 0) S.off += Math.max(0, chatLines(ch).length - before)
      touch(); break
    }
    case 'chat.update': {
      const ch = R.chat
      if (!ch || ch.origin !== c.origin || !sameView(ch, m) || !ch.loaded) break
      const byId = new Map(m.entries.map(e => [e.id, e]))
      const before = chatLines(ch).length
      ch.entries = ch.entries.map(e => byId.get(e.id) ?? e)
      if (!useFeed(ch) && S.off > 0) S.off = Math.max(0, S.off + (chatLines(ch).length - before)) // grow/shrink below the window only
      touch(); break
    }
    case 'chat.older': {
      const ch = R.chat
      if (!ch || ch.origin !== c.origin || !sameView(ch, m)) break
      const known = new Set(ch.entries.map(e => e.id))
      const feed = useFeed(ch)
      const beforeLen = feed ? feedLines(ch).length : 0
      ch.entries = [...m.entries.filter(e => !known.has(e.id)), ...ch.entries]
      ch.hasOlder = m.hasOlder; ch.olderPending = false
      // Older messages land at the bottom of the feed: keep the current chunk's top where it is.
      if (feed && F) F = { ...F, fromBottom: F.fromBottom + (feedLines(ch).length - beforeLen) }
      else if (feed) live.endFromBottom += feedLines(ch).length - beforeLen
      diag('info', 'older arrived', { n: m.entries.length, hasOlder: m.hasOlder, total: ch.entries.length })
      if (ch.scrollOnOlder && m.entries.length) {
        ch.scrollOnOlder = false
        if (feed) swipe(1)
        else { lastView.atTop = false; swipe(-1) }
      } else { ch.scrollOnOlder = false; touch() }
      break
    }
    case 'prompt': {
      const ch = R.chat
      if (!ch || ch.origin !== c.origin || ch.id !== m.pane || ch.subagent) break
      const had = !!ch.prompt
      ch.prompt = m.text
      if (m.text && !had && away(ch)) ch.newCount++
      touch(); break
    }
    case 'queue': {
      const key = paneKey(c.origin, m.pane)
      if (m.items.length) R.queues.set(key, m.items); else R.queues.delete(key)
      if (S.screen === 'queued' && !openQueue().length) S.screen = 'chat'
      touch(); break
    }
    case 'subagents': {
      R.subs.set(paneKey(c.origin, m.pane), m.subagents)
      touch(); break
    }
    case 'error':
      diag('warn', `bridge error ${m.code}: ${m.message}`, { machine: c.machine })
      if (m.code === 'unknown_subagent' && R.chat?.subagent && R.chat.origin === c.origin) { backToParent(); toast('subagent gone') }
      break
  }
}

function onPanes(c: Conn, panes: Conn['panes']) {
  c.panes = panes
  const prev = c.prevStatus
  const next = new Map(panes.map(p => [p.id, p.status as string]))
  c.prevStatus = next
  c.gotPanes = true
  const openKey = S.open ? paneKey(S.open.origin, S.open.id) : ''
  if (prev) {
    for (const p of panes) {
      if (p.status === 'blocked' && prev.get(p.id) !== 'blocked' && paneKey(c.origin, p.id) !== openKey) {
        const label = `▲ ${isMulti() ? c.machine + '/' : ''}${p.workspace} ${p.agent ?? p.title} BLOCKED`
        R.banner = { text: label, until: Date.now() + BANNER_MS }
        diag('info', 'alert banner', { pane: p.id, machine: c.machine })
      }
    }
  }
  // the pane being viewed is "seen" as long as it is open
  const ref = currentRef()
  if (ref && ref.pane.status === 'done' && S.seen[refKey(ref)] !== ref.pane.stateSeq) { S.seen[refKey(ref)] = ref.pane.stateSeq; persist() }
  if (S.open && S.open.origin === c.origin && !ref) {
    diag('info', 'open pane vanished', { pane: S.open.id })
    abortDictation()
    S.open = null; R.chat = null; toLive()
    if (S.ws && wsGroup(S.ws)) { S.screen = 'ws'; committedWs = null } else { S.screen = 'home'; S.ws = null; immediateHome = true }
    toast('pane closed')
    return
  }
  // a workspace that vanished (all its panes closed): back to home
  if (S.ws && S.ws.origin === c.origin && !wsGroup(S.ws)) {
    if (S.screen === 'ws') { goHome(); return }
    S.ws = null
  }
  touch()
}

function onReady(c: Conn, reconnect: boolean) {
  diag('info', reconnect ? 'reconnected' : 'connected', { machine: c.machine, herdr: c.herdrVersion, opens: c.opens })
  if (R.chat && R.chat.origin === c.origin) void c.request(openReq(R.chat)) // re-open after reconnect (same view)
  touch()
}

// ---------------------------------------------------------------- lifecycle
let lastResume = 0
export function onResume(why: string) {
  if (Date.now() - lastResume < 2000) return
  lastResume = Date.now()
  if (!fgActive) { fgActive = true; warmBlockedUntil = 0 }
  diag('info', `resume ${why}`, { visibility: document.visibilityState, screen: S.screen, conns: R.conns.map(c => c.status) })
  for (const c of R.conns) {
    c.probe()
    if (c.status === 'open' && R.chat && R.chat.origin === c.origin) void c.request(openReq(R.chat))
  }
  shown.sig = '' // the glasses page may have been reset behind our back: rebuild
  touch()
}

export function setMode(m: ScrollMode) {
  if (S.mode === m) return
  S.mode = m; toLive()
  diag('info', 'scroll mode', { mode: m })
  persist(); gesture('mode')
}

/** For the phone page's gesture buttons / automation. */
export const gestures_ = {
  swipeUp: () => swipe(-1), swipeDown: () => swipe(1), tap: () => (S.screen === 'chat' || S.screen === 'listen' ? onTap() : undefined), double: onDouble, long: onLong, release: onLongRelease,
  select: (i: number) => onListSelect(i, undefined),
}

export function boot(origins: string[]) {
  bindDiag(() => R.conns, ui.log)
  setDiagCtx(paneCtx)
  R.conns = origins.map(o => new Conn(o, { onStatus: () => touch(), onMsg: handleMsg, onReady }))
  for (const c of R.conns) c.start()
  window.addEventListener('error', e => diag('error', `uncaught: ${e.message}`))
  window.addEventListener('unhandledrejection', e => diag('error', `unhandled rejection: ${String(e.reason)}`))
  document.addEventListener('visibilitychange', () => {
    diag('info', `visibilitychange -> ${document.visibilityState}`)
    if (document.visibilityState === 'visible') onResume('visible')
    else { persist(true) }
  })
  let lastTick = Date.now()
  let hbAt = 0
  setInterval(() => {
    const now = Date.now()
    if (now - lastTick > 12000) { diag('warn', `timer gap ${now - lastTick}ms (suspended?)`); onResume('timer-gap') }
    lastTick = now
    if (now - hbAt > 30000) { hbAt = now; void store('hb', String(now)) }
    ui.renderStatus(statusInfo())
  }, 5000)
  touch()
}
export const lastViewForTests = () => lastView0
