import type { ChatEntry, SubagentSummary } from '@herdr-even/protocol'
import { mapGlyphs } from './glyphs'
import { ellipsizeLine, toVisualLines } from './fit'

const clean = (t: string) =>
  mapGlyphs(t).split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')

const prefixLines = (t: string, first: string, rest: string) =>
  t.split('\n').map((l, i) => (i === 0 ? first : rest) + l).join('\n')

/** Drop markdown markup the glasses can't render (emphasis, inline code, fences, headings, link targets). */
export const stripMarkdown = (t: string) =>
  t
    .split('\n')
    .filter(l => !/^\s*(```|~~~)/.test(l))
    .map(l => l.replace(/^(\s*)#{1,6}\s+/, '$1'))
    .join('\n')
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')
    .replace(/__(?=\S)([^_\n]*?\S)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((?:https?:|\/|\.)[^)\s]*\)/g, '$1')

export type SubMap = ReadonlyMap<string, SubagentSummary>

/** One entry as glasses text. `subs` supplies the live status of subagent entries. */
export function flattenEntry(e: ChatEntry, subs?: SubMap): string {
  const text = clean(e.kind === 'assistant' || e.kind === 'user' ? stripMarkdown(e.text) : e.text)
  switch (e.kind) {
    case 'user': return prefixLines(text, '> ', '> ')
    case 'tool': {
      if (text.startsWith('└')) return prefixLines(text, '  ', '    ') // collapsed tool result: indent under its call
      const t = text.replace(/^[●○]\s*/, '')
      return prefixLines(t, '● ', '  ')
    }
    case 'subagent': {
      let t = text.replace(/^[→↳]\s*/, '')
      const st = e.subagent ? subs?.get(e.subagent)?.status : undefined
      if (st && !t.split('\n')[0].toLowerCase().endsWith(st)) { const [h, ...r] = t.split('\n'); t = [`${h} · ${st}`, ...r].join('\n') }
      return prefixLines(t, '→ ', '  ') // '↳' is not in the firmware font: mapGlyphs turns it into '→'
    }
    case 'system': return prefixLines(text, '~ ', '  ')
    case 'question': return prefixLines(text, '? ', '  ')
    case 'screen': return text.replace(/([─━═])\1{5,}/g, '$1$1$1') // long horizontal rules waste a whole row
    default: return text // assistant
  }
}

/** Entries -> text. A blank line separates messages; consecutive tool lines stay together as one block. */
export function flattenEntries(entries: ChatEntry[], subs?: SubMap): string {
  const parts: string[] = []
  let prev: ChatEntry['kind'] | null = null
  for (const e of entries) {
    const t = flattenEntry(e, subs)
    if (t === '' && e.kind !== 'screen') continue
    if (prev && !(prev === 'tool' && e.kind === 'tool')) parts.push('')
    parts.push(t)
    prev = e.kind
  }
  return parts.join('\n')
}

/** Prompt text (permission dialog) as glasses text. */
export const flattenPrompt = (t: string) => clean(t)

export const QUEUED_PREFIX = '○ queued: '
/** Queued messages as visual lines for the feed: each item <= maxLines lines (tail cut with `…`), a blank line after the block. */
export function queuedLines(items: { text: string }[], innerW: number, maxLines = 2): string[] {
  const out: string[] = []
  for (const q of items) {
    const lines = toVisualLines(QUEUED_PREFIX + mapGlyphs(q.text).replace(/\s+/g, ' ').trim(), innerW)
    if (lines.length > maxLines) { const k = lines.slice(0, maxLines); k[maxLines - 1] = ellipsizeLine(k[maxLines - 1], innerW); out.push(...k) } else out.push(...lines)
  }
  if (out.length) out.push('')
  return out
}
