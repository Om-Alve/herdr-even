// Glyph mapping for the G2 firmware font. `getAdvW(cp) === 0` means the glyph is missing and would be silently dropped.
import { getAdvW } from '@evenrealities/pretext'

const MAP: Record<string, string> = {
  '⏺': '●', '◉': '●', '🔴': '●', '🟢': '●', '🟡': '○',
  '⎿': '└', '⎾': '└', '⏐': '│', '║': '│',
  '✓': '√', '✔': '√', '☑': '√', '✅': '√',
  '✗': '×', '✘': '×', '✕': '×', '✖': '×', '❌': '×', '☒': '×',
  '❯': '>', '❱': '>', '⟩': '>', '❮': '<', '⟨': '<',
  '✻': '*', '✶': '*', '✳': '*', '✢': '*', '✽': '*', '✺': '*', '✱': '*', '✦': '*',
  '▪': '·', '▫': '·', '◦': '·', '‣': '·', '⁃': '·', '∙': '·', '⋅': '·',
  '▸': '▶', '⏵': '▶', '▾': '▼', '▴': '▲', '◂': '◀', '♦': '◆',
  '↳': '→', '↩': '←', '↪': '→', '⇐': '←', '⏎': '<', '↵': '<', '␣': '_',
  '⚠': '!', 'ℹ': 'i', '☐': '□', '⏸': '|', '⏏': '^', '‒': '–',
  '“': '"', '”': '"', '‘': "'", '’': "'", // supported by the font, but ASCII is narrower and safer
  '`': "'", // the only printable-ASCII character the font lacks
  '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ', '\u200a': ' ',
}
// zero-width / formatting characters: never visible, never replaced by '?'
const INVISIBLE = /[\u200b-\u200f\u2060\u2066-\u2069\ufe00-\ufe0f\ufeff\u0300-\u036f]/g
const BRAILLE = /[\u2800-\u28ff]/g

/** Horizontal-ish glyphs -> '─', vertical-ish -> '│' (e.g. '▀' rules and '╹' cursor bars from TUIs). */
function blockOrBox(cp: number): string {
  if (cp >= 0x2580 && cp <= 0x2587) return '─'
  if (cp === 0x2594 || cp === 0x2574 || cp === 0x2576 || cp === 0x257c || cp === 0x257e) return '─'
  if (cp >= 0x2500 && cp <= 0x250b) return '─'
  return '│'
}

const cache = new Map<string, string>()
function mapChar(ch: string): string {
  const hit = cache.get(ch)
  if (hit !== undefined) return hit
  const cp = ch.codePointAt(0)!
  let out: string
  const m = MAP[ch]
  if (m !== undefined) out = m
  else if (getAdvW(ch.codePointAt(0)!) > 0) out = ch
  else if (cp >= 0x2500 && cp <= 0x259f) out = blockOrBox(cp) // box drawing / block elements the font lacks
  else {
    // try a compatibility decomposition (e.g. fullwidth forms), else '?'
    const d = ch.normalize('NFKD').replace(INVISIBLE, '')
    out = d !== ch && [...d].every(c => getAdvW(c.codePointAt(0)!) > 0) ? d : '?'
  }
  cache.set(ch, out)
  return out
}

/** Replace characters the firmware font lacks with supported ones; strip ANSI/control characters and tabs. */
export function mapGlyphs(text: string): string {
  const t = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(INVISIBLE, '')
    .replace(BRAILLE, '*')
  let out = ''
  for (const ch of t) out += ch === '\n' || ch === ' ' ? ch : mapChar(ch)
  return out
}

export const utf8Len = (s: string): number => new TextEncoder().encode(s).length
