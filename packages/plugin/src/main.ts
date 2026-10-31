import { bridge, initBridge, load, call } from './glasses'
import { boot, onHubEvent, restore, setMode, gestures_, S, R, touch, onResume, loadDeepgramKey, setDeepgramKey, sendFromPhone, unqueueItem } from './app'
import { diag } from './diag'
import * as ui from './ui'

const ORIGINS = (import.meta.env.VITE_BRIDGE_ORIGINS ?? '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)

async function main() {
  // Developer tools (glasses preview, gestures, scroll mode, log) only with ?debug=1
  if (new URLSearchParams(location.search).get('debug') === '1') {
    ui.$('dev').hidden = false
    ui.$('meta').textContent = `origins: ${ORIGINS.join(', ') || '(none)'} | sdk ${__SDK_VERSION__}`
    ui.$('modeRow').addEventListener('change', e => {
      const t = e.target as HTMLInputElement
      if (t.name === 'mode') setMode(t.value as 'paged' | 'native')
    })
    const g = gestures_
    const wire = (id: string, fn: () => void) => { ui.$(id).onclick = fn }
    wire('gUp', g.swipeUp); wire('gDown', g.swipeDown); wire('gTap', g.tap); wire('gDouble', g.double); wire('gLong', g.long)
    ui.$('gSel').onclick = () => g.select(Number(ui.$<HTMLInputElement>('gIdx').value) || 0)
  }
  const g = gestures_

  // phone keyboard: same protocol messages as the glasses menu
  const kt = ui.$<HTMLTextAreaElement>('kbdText')
  const kbdSend = async (a: Parameters<typeof sendFromPhone>[0]) => {
    const r = await sendFromPhone(a)
    ui.setKbdMsg(r.msg, r.ok)
    if (r.ok && 'text' in a) kt.value = '' // clear after a successful text send
  }
  ui.$('kbdSend').onclick = () => void kbdSend({ text: kt.value })
  ui.$('kbdQueue').onclick = () => void kbdSend({ text: kt.value, queue: true })
  ui.setUnqueueHandler(id => void unqueueItem(id).then(r => ui.setKbdMsg(r.msg, r.ok)))
  ui.$('kbdKeys').addEventListener('click', e => {
    const k = (e.target as HTMLElement).closest('button')?.dataset.key
    if (k) void kbdSend({ keys: [k] })
  })
  // Deepgram key: stored with setLocalStorage via the app; never shown, logged or sent to a bridge
  const dk = ui.$<HTMLInputElement>('dgKey')
  ui.$('dgSave').onclick = () => { const v = dk.value.trim(); dk.value = ''; if (v) { ui.toggleDgEdit(false); void setDeepgramKey(v) } }
  ui.$('dgClear').onclick = () => { dk.value = ''; ui.toggleDgEdit(false); void setDeepgramKey('') }
  ui.$('dgChange').onclick = () => ui.toggleDgEdit(true)
  ui.$('dgCancel').onclick = () => { dk.value = ''; ui.toggleDgEdit(false) }

  await initBridge()
  if (!bridge) ui.log('no Even bridge: running as a plain page (glasses calls disabled)')

  const prev = Number(await load('hb'))
  await restore()
  await loadDeepgramKey()
  const qmode = new URLSearchParams(location.search).get('mode') // debug: ?mode=native|paged
  if (qmode === 'native' || qmode === 'paged') S.mode = qmode
  boot(ORIGINS)
  diag('info', 'load', { heartbeatGapMs: prev ? Date.now() - prev : null, visibility: document.visibilityState, screen: S.screen, ua: navigator.userAgent.slice(0, 80) })

  if (bridge) {
    bridge.onEvenHubEvent(onHubEvent)
    void call('getDeviceInfo', () => bridge!.getDeviceInfo(), 5000).then(di => di && diag('info', 'device', JSON.parse(JSON.stringify(di))))
  }
  ;(window as any).__herdr = { S, R, touch, onResume, ...g }
}
main().catch(e => { ui.log(`fatal: ${e}`); console.error(e) })
