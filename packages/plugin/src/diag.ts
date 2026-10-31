// Diagnostics: local log (phone page) + rate-limited `log` messages to the bridges.
import type { Conn } from './conn'

type Level = 'info' | 'warn' | 'error'
let conns: () => Conn[] = () => []
let sink: (line: string) => void = () => {}
/** Which pane the device is looking at; attached to `ev`, `feed edge` and `timings` logs. */
let ctxFn: () => Record<string, unknown> = () => ({})
export const setDiagCtx = (f: () => Record<string, unknown>) => { ctxFn = f }
export const diagCtx = () => ctxFn()
export const bindDiag = (c: () => Conn[], s: (line: string) => void) => { conns = c; sink = s }

// token bucket: burst 25, refill 2/s
let tokens = 25
let last = Date.now()
let dropped = 0

export function diag(level: Level, msg: string, data?: unknown) {
  sink(`${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${data !== undefined ? ' ' + safe(data) : ''}`)
  const now = Date.now()
  tokens = Math.min(25, tokens + ((now - last) / 1000) * 2)
  last = now
  if (tokens < 1) { dropped++; return }
  tokens -= 1
  const extra = dropped ? { ...(typeof data === 'object' && data ? (data as object) : data === undefined ? {} : { data }), droppedLogs: dropped } : data
  const open = conns().filter(c => c.status === 'open')
  if (!open.length) return
  dropped = 0
  for (const c of open) c.send({ t: 'log', level, msg, data: extra })
}

function safe(d: unknown) { try { return JSON.stringify(d) } catch { return String(d) } }

// ---- aggregated timings: per-call samples, flushed at most every 10 s (slow calls immediately)
const samples = new Map<string, number[]>()
let flushTimer: ReturnType<typeof setTimeout> | undefined
export function timing(name: string, ms: number) {
  const a = samples.get(name) ?? []
  a.push(Math.round(ms))
  if (a.length > 200) a.shift()
  samples.set(name, a)
  if (ms > 800) diag('warn', `slow ${name}`, { ms: Math.round(ms) })
  if (!flushTimer) flushTimer = setTimeout(flushTimings, 10000)
}
export function flushTimings() {
  flushTimer = undefined
  if (!samples.size) return
  const out: Record<string, { n: number; p50: number; max: number }> = {}
  for (const [k, a] of samples) {
    const s = [...a].sort((x, y) => x - y)
    out[k] = { n: s.length, p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] }
  }
  samples.clear()
  diag('info', 'timings', { ...out, ctx: ctxFn() })
}
