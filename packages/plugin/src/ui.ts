// Phone-side page (DOM). Must work in a plain desktop browser without the Even SDK.
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export interface KbdState { ok: boolean; pane: string; status: string; why: string; working: boolean }
export interface StatusInfo {
  conns: { origin: string; status: string; machine: string; panes: number; err: string; opens: number }[]
  screen: string
  pane: string
  mode: string
  off: number
  kbd: KbdState
  queue: { id: string; text: string }[]
  dg: { src: 'phone' | 'build' | 'none'; phase: string }
}

const el = (id: string) => document.getElementById(id)
const show = (id: string, on: boolean) => { const e = el(id); if (e) e.hidden = !on }

let last: StatusInfo | null = null
let dgEditing = false

export function renderStatus(s: StatusInfo) {
  last = s
  const c = el('conns')
  if (c) {
    c.innerHTML = ''
    for (const x of s.conns) {
      const row = document.createElement('span')
      row.className = 'conn' + (x.status === 'open' ? ' open' : '')
      row.title = x.status === 'open' ? `${x.panes} panes` : x.err || x.status
      const dot = document.createElement('span')
      dot.className = 'dot'
      const t = document.createElement('span')
      t.textContent = x.machine || 'machine'
      row.append(dot, t)
      c.appendChild(row)
    }
    if (!s.conns.length) c.textContent = 'no machines configured'
  }
  const sc = el('screen')
  if (sc) sc.textContent = `${s.screen}${s.pane ? ' · ' + s.pane : ''} · off ${s.off}`
  renderKbd(s.kbd)
  renderQueue(s.kbd.ok ? s.queue : [])
  renderDg()
  document.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach(i => { i.checked = i.value === s.mode })
}

/** Voice dictation settings: one line when a key is set, the field when not (or while changing). */
function renderDg() {
  if (!last) return
  const has = last.dg.src !== 'none'
  const editing = !has || dgEditing
  show('dgTitle', !has || dgEditing)
  show('dgOn', has && !dgEditing)
  show('dgEdit', editing)
  show('dgHint', !has)
  show('dgCancel', has)
  show('dgClear', last.dg.src === 'phone')
}
export function toggleDgEdit(on: boolean) {
  dgEditing = on
  renderDg()
  if (on) el('dgKey')?.focus()
}

export function renderPreview(screen: string, pane: string, header: string, body: string) {
  const h = el('pvHeader'), b = el('pvBody')
  if (h) h.textContent = header
  if (b) b.textContent = body
  void screen; void pane
}

export function log(msg: string) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`
  console.log(line)
  const l = el('log')
  if (!l) return
  l.textContent += line + '\n'
  if (l.textContent!.length > 24000) l.textContent = l.textContent!.slice(-16000)
  l.scrollTop = l.scrollHeight
}

/** Composer for the open pane, or one calm line saying why there is none. */
export function renderKbd(k: KbdState) {
  show('composer', k.ok)
  const w = el('kbdWhy')
  if (w) { w.textContent = k.why; w.hidden = k.ok }
  const t = el('kbdTitle')
  if (t) {
    t.textContent = k.pane
    if (k.status) {
      const st = document.createElement('span')
      st.className = 'st' + (k.working ? ' working' : '')
      st.textContent = ' · ' + k.status
      t.appendChild(st)
    }
  }
  show('kbdQueue', k.working) // `Queue` only while the agent is working
}

let msgTimer: ReturnType<typeof setTimeout> | undefined
export function setKbdMsg(msg: string, ok: boolean) {
  const m = el('kbdMsg')
  if (!m) return
  m.textContent = msg
  m.className = ok ? '' : 'bad'
  clearTimeout(msgTimer)
  msgTimer = setTimeout(() => { m.textContent = '' }, 3000)
}

let queueSig = ''
let onUnqueue: (id: string) => void = () => {}
export const setUnqueueHandler = (f: (id: string) => void) => { onUnqueue = f }
/** Queued messages of the open pane, one row each with a ✕ (rebuilt only when the list changes). */
export function renderQueue(items: { id: string; text: string }[]) {
  const box = el('kbdQueueList')
  if (!box) return
  const sig = items.map(i => i.id + ':' + i.text).join('\u0001')
  if (sig === queueSig) return
  queueSig = sig
  box.innerHTML = ''
  box.hidden = !items.length
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'qrow'
    const t = document.createElement('span')
    t.textContent = '○ ' + it.text
    const x = document.createElement('button')
    x.textContent = '✕'
    x.title = 'remove from the queue'
    x.setAttribute('aria-label', 'remove from the queue')
    x.onclick = () => onUnqueue(it.id)
    row.append(t, x)
    box.appendChild(row)
  }
}
