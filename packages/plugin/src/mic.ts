// Microphone source for dictation: the glasses mics via audioControl, or (`?fakeMic=1`, simulator/dev) generated PCM.
import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { bridge, call } from './glasses'
import { diag } from './diag'

const params = new URLSearchParams(location.search)
export const FAKE_MIC = params.get('fakeMic') === '1'

let sink: ((pcm: Uint8Array) => void) | null = null
let fakeTimer: ReturnType<typeof setInterval> | undefined

/** Audio events from the SDK (onHubEvent) land here. */
export function feedPcm(pcm: Uint8Array) { if (!FAKE_MIC) sink?.(pcm) }

/** 100 ms of 16 kHz s16le mono: a quiet 440 Hz sine. */
function sineFrame(phase: number): Uint8Array {
  const n = 1600
  const out = new Uint8Array(n * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 440 * (phase + i) / 16000) * 2500), true)
  return out
}

export async function micStart(onPcm: (pcm: Uint8Array) => void): Promise<boolean> {
  sink = onPcm
  if (FAKE_MIC) {
    let phase = 0
    clearInterval(fakeTimer)
    fakeTimer = setInterval(() => { onPcm(sineFrame(phase)); phase += 1600 }, 100)
    return true
  }
  if (!bridge) return false
  try {
    const r = await call('audioControl(true)', () => bridge!.audioControl(true, AudioInputSource.Glasses))
    if (r !== true) diag('warn', `audioControl(true) -> ${String(r)}`)
    return r === true
  } catch (e) { diag('warn', `audioControl(true) failed: ${e}`); return false }
}

/** Always safe to call (also from error paths and FOREGROUND_EXIT): sends audioControl(false) even if start never finished. */
export async function micStop(): Promise<void> {
  sink = null
  clearInterval(fakeTimer)
  if (FAKE_MIC || !bridge) return
  await call('audioControl(false)', () => bridge!.audioControl(false), 5000)
}
