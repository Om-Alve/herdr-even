// Precise text pagination for the proportional G2 firmware font (LVGL), via @evenrealities/pretext.
// Strategy: split every logical line into segments that each fit ONE visual line on their own, then join segments with
// '\n'. Since every segment is an explicit line, the rendered line count equals the segment count exactly, so a page of
// <= maxLines segments can never overflow the container (no scrollbar).
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { utf8Len } from './glyphs'

export const LINE_H = 27

export interface Geometry {
  /** Pixel width available to text (container width minus padding/border on both sides). */
  innerW: number
  /** Whole text lines that fit the container height. */
  maxLines: number
}

export const geometry = (w: number, h: number, inset: number): Geometry => ({
  innerW: w - 2 * inset,
  maxLines: Math.floor((h - 2 * inset) / LINE_H),
})

const SAFETY_PX = 1

function fits(s: string, innerW: number): boolean {
  if (s === '') return true
  return getTextWidth(s) <= innerW - SAFETY_PX && measureTextWrap(s, innerW).lineCount <= 1
}

const segCache = new Map<string, string[]>()

/** Split one logical line (no newlines) into segments that each render on exactly one visual line. */
export function segmentLine(line: string, innerW: number): string[] {
  const key = innerW + '|' + line
  const hit = segCache.get(key)
  if (hit) return hit
  const out = segmentUncached(line.replace(/\s+$/, ''), innerW)
  if (segCache.size > 6000) segCache.clear()
  segCache.set(key, out)
  return out
}

function segmentUncached(line: string, innerW: number): string[] {
  if (fits(line, innerW)) return [line]
  const cps = Array.from(line)
  const out: string[] = []
  let pos = 0
  while (pos < cps.length) {
    const rest = cps.slice(pos)
    const restStr = rest.join('')
    if (fits(restStr, innerW)) { out.push(restStr); break }
    // largest n such that the first n code points fit on one line
    let lo = 1, hi = rest.length
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (fits(rest.slice(0, mid).join(''), innerW)) lo = mid; else hi = mid - 1
    }
    let n = lo
    if (n < rest.length) {
      // prefer breaking after a space within the fitting prefix (but not producing an empty segment)
      let sp = -1
      for (let i = n; i >= 1; i--) if (rest[i] === ' ' || rest[i - 1] === ' ') { sp = rest[i] === ' ' ? i : i; break }
      if (sp > 0) n = sp
    }
    out.push(rest.slice(0, n).join('').replace(/\s+$/, ''))
    pos += n
    while (cps[pos] === ' ') pos++
  }
  return out
}

/** Flatten text to visual lines (each guaranteed to fit one line). */
export function toVisualLines(text: string, innerW: number): string[] {
  const out: string[] = []
  for (const l of text.split('\n')) for (const s of segmentLine(l, innerW)) out.push(s)
  return out
}

/** Pixel-exact line count of a block of text, as the firmware would render it. */
export function renderedLines(text: string, innerW: number): number {
  return text === '' ? 1 : measureTextWrap(text, innerW).lineCount
}

export interface PagedView {
  text: string
  /** `off` clamped to the valid range. */
  off: number
  /** The oldest line is visible. */
  atTop: boolean
  /** Number of visual lines of chat shown. */
  shown: number
}

/**
 * Bottom-anchored window over visual lines. `off` = number of lines hidden below the window.
 * `pinned` lines (e.g. a permission prompt) are appended at the bottom, only when off === 0.
 * Never exceeds maxLines lines nor maxBytes UTF-8 bytes (oldest lines are dropped first).
 */
export function pagedWindow(lines: string[], off: number, geo: Geometry, pinned: string[] = [], maxBytes = 1000): PagedView {
  const pin = off <= 0 ? pinned.slice(-Math.max(0, geo.maxLines - 1)) : []
  const region = geo.maxLines - pin.length
  const maxOff = Math.max(0, lines.length - region)
  const o = Math.min(Math.max(0, off), maxOff)
  const end = lines.length - o
  let start = Math.max(0, end - region)
  let win = lines.slice(start, end)
  const total = () => utf8Len([...win, ...pin].join('\n'))
  while (win.length > 0 && total() > maxBytes) { win.shift(); start++ }
  return { text: [...win, ...pin].join('\n'), off: o, atTop: start === 0, shown: win.length }
}

/** Window for firmware-scrolled ("native") mode: the last whole lines ending `off` lines from the bottom, up to maxBytes. */
export function nativeWindow(lines: string[], off: number, maxBytes: number): { text: string; start: number; end: number; off: number } {
  const o = Math.min(Math.max(0, off), Math.max(0, lines.length - 1))
  const end = lines.length - o
  let bytes = 0
  let start = end
  while (start > 0) {
    const b = utf8Len(lines[start - 1]) + 1
    if (bytes + b > maxBytes && start < end) break
    bytes += b
    start--
  }
  let text = lines.slice(start, end).join('\n')
  while (utf8Len(text) > maxBytes) text = text.slice(Math.ceil(text.length * 0.05) || 1)
  return { text, start, end, off: o }
}

/**
 * Chunk for firmware-scrolled ("native") history, positioned by its TOP line because the firmware always shows an
 * overflowing container from its top: whole lines from `top` towards `end` (exclusive), up to maxBytes.
 */
export function nativeChunk(lines: string[], top: number, end: number, maxBytes: number): { top: number; end: number; chunkEnd: number; text: string } {
  const t = Math.min(Math.max(0, top), Math.max(0, end - 1))
  let bytes = 0
  let i = t
  while (i < end) {
    const b = utf8Len(lines[i]) + 1
    if (bytes + b > maxBytes && i > t) break
    bytes += b
    i++
  }
  return { top: t, end, chunkEnd: i, text: tailBytes(lines.slice(t, i).join('\n'), maxBytes) }
}

/** Cap the UTF-8 size of a string, keeping its tail. */
export function tailBytes(s: string, max: number): string {
  while (utf8Len(s) > max) s = s.slice(Math.ceil(s.length * 0.05) || 1)
  return s
}

/** Make a (one visual line) string end in `…` while still fitting `innerW`. */
export function ellipsizeLine(l: string, innerW: number): string {
  let t = l
  while (t && getTextWidth(t + '…') > innerW - 2) t = t.slice(0, -1)
  return t.trimEnd() + '…'
}
