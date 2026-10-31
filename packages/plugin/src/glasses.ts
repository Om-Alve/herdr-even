// Everything that touches the Even SDK: the serialized call queue, page create/rebuild/upgrade, local storage.
import {
  waitForEvenAppBridge, type EvenAppBridge,
  TextContainerProperty, ListContainerProperty, ListItemContainerProperty,
  CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { diag, timing } from './diag'

export let bridge: EvenAppBridge | null = null

export async function initBridge(): Promise<EvenAppBridge | null> {
  try {
    bridge = await Promise.race([waitForEvenAppBridge(), new Promise<null>(r => setTimeout(() => r(null), 4000))])
  } catch (e) { diag('warn', `bridge error: ${e}`); bridge = null }
  return bridge
}

let tail: Promise<unknown> = Promise.resolve()
/** Serialize every Even bridge call with a per-call timeout (a flaky BLE hop can hang ~30 s). */
export function call<T>(label: string, fn: () => Promise<T>, timeoutMs = 10000): Promise<T | undefined> {
  const run = async () => {
    const t0 = performance.now()
    try {
      const r = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs))])
      timing(label, performance.now() - t0)
      return r
    } catch (e) {
      diag('error', `glasses call ${label} failed: ${e}`)
      return undefined
    }
  }
  const p = tail.then(run, run)
  tail = p
  return p as Promise<T | undefined>
}

// ---------------------------------------------------------------- storage
export async function store(key: string, value: string) {
  if (bridge) await call(`setLocalStorage`, () => bridge!.setLocalStorage(key, value), 5000)
  try { localStorage.setItem(key, value) } catch { /* */ }
}
export async function load(key: string): Promise<string> {
  if (bridge) {
    const v = await call(`getLocalStorage`, () => bridge!.getLocalStorage(key), 5000)
    if (v) return v
  }
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

// ---------------------------------------------------------------- pages
// Layout: a 32px header strip (never captures events; also carries banners/flashes) above one full-width body that captures.
export const HDR = { x: 0, y: 0, w: 576, h: 32, pad: 2 }
export const BODY = { x: 0, y: 32, w: 576, h: 256, pad: 2 }
const HDR_ID = 1, BODY_ID = 2

const hdrContainer = (content: string) => new TextContainerProperty({
  xPosition: HDR.x, yPosition: HDR.y, width: HDR.w, height: HDR.h, borderWidth: 0, borderColor: 0, paddingLength: HDR.pad,
  containerID: HDR_ID, containerName: 'hdr', content: content || ' ', isEventCapture: 0,
})
const bodyContainer = (content: string) => new TextContainerProperty({
  xPosition: BODY.x, yPosition: BODY.y, width: BODY.w, height: BODY.h, borderWidth: 0, borderColor: 0, paddingLength: BODY.pad,
  containerID: BODY_ID, containerName: 'body', content: content || ' ', isEventCapture: 1,
})
const listContainer = (items: string[], y = BODY.y, h = BODY.h) => new ListContainerProperty({
  xPosition: BODY.x, yPosition: y, width: BODY.w, height: h, borderWidth: 0, borderColor: 0, paddingLength: 2,
  containerID: BODY_ID, containerName: 'list', isEventCapture: 1,
  itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items }),
})

let started = false

export type PageSpec = { header: string } & (
  | { kind: 'text'; body: string }
  | { kind: 'list'; items: string[] }
  /** Dictation confirm: a read-only text container (the transcript) above a native list that captures events. */
  | { kind: 'confirm'; body: string; items: string[] }
)

/** Confirm page: the transcript container is as tall as its lines (<= 4), the native list (4 rows, ~40 px each) gets the rest. */
const confirmGeo = (body: string) => {
  const lines = Math.max(1, Math.min(4, body.split('\n').length))
  const h = lines * 27 + 4
  const listY = HDR.h + h + 2
  return { h, listY, listH: 288 - listY }
}

/** Create (first time, with rebuild fallback after a WebView reload) or rebuild the whole page. */
export async function buildPage(p: PageSpec): Promise<boolean> {
  if (!bridge) return false
  const cfg = p.kind === 'text'
    ? { containerTotalNum: 2, textObject: [hdrContainer(p.header), bodyContainer(p.body)] }
    : p.kind === 'confirm'
      ? (() => {
        const g = confirmGeo(p.body)
        return {
        containerTotalNum: 3,
        textObject: [hdrContainer(p.header), new TextContainerProperty({
          xPosition: 0, yPosition: HDR.h, width: BODY.w, height: g.h, borderWidth: 0, borderColor: 0, paddingLength: 2,
          containerID: 3, containerName: 'transcript', content: p.body || ' ', isEventCapture: 0,
        })],
        listObject: [listContainer(p.items, g.listY, g.listH)],
        }
      })()
      : { containerTotalNum: 2, textObject: [hdrContainer(p.header)], listObject: [listContainer(p.items)] }
  if (!started) {
    const code = await call('createStartUpPageContainer', () => bridge!.createStartUpPageContainer(new CreateStartUpPageContainer(cfg)))
    if (code === 0) { started = true; return true }
    // e.g. the WebView reloaded while the glasses session persisted: the startup page already exists
    const ok = await call('rebuildPageContainer(fallback)', () => bridge!.rebuildPageContainer(new RebuildPageContainer(cfg)))
    diag('info', `createStartUpPageContainer=${String(code)}; rebuild fallback=${String(ok)}`)
    started = ok === true
    return started
  }
  const ok = await call('rebuildPageContainer', () => bridge!.rebuildPageContainer(new RebuildPageContainer(cfg)))
  return ok === true
}

/** Close the plugin's glasses page; mode 1 lets the Even app's foreground layer decide (it may confirm first). */
export async function exitApp(): Promise<void> {
  if (bridge) await call('shutDownPageContainer', () => bridge!.shutDownPageContainer(1))
}

export const upgradeHeader = (content: string) => upgrade(HDR_ID, 'hdr', content, 'upgrade:hdr')
export const upgradeBody = (content: string) => upgrade(BODY_ID, 'body', content, 'upgrade:body')
async function upgrade(id: number, name: string, content: string, label: string): Promise<boolean> {
  if (!bridge) return false
  const r = await call(label, () => bridge!.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content: content || ' ', contentOffset: 0, contentLength: 0 })))
  return r === true
}
