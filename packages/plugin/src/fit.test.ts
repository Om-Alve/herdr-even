import { expect, test } from 'bun:test'
import { measureTextWrap } from '@evenrealities/pretext'
import { geometry, nativeChunk, nativeWindow, pagedWindow, renderedLines, segmentLine, toVisualLines } from './fit'
import { utf8Len } from './glyphs'

const geo = geometry(576, 256, 2)
const LOREM =
  'The quick brown fox jumps over the lazy dog while the Claude agent reads src/components/VeryLongComponentName.tsx and /Users/example/project/packages/plugin/src/main.ts'

test('geometry', () => { expect(geo).toEqual({ innerW: 572, maxLines: 9 }) })

test('every segment renders as exactly one line', () => {
  for (const s of toVisualLines(LOREM.repeat(5), geo.innerW)) expect(renderedLines(s, geo.innerW)).toBeLessThanOrEqual(1)
})

test('words are not split when a space is available', () => {
  const segs = segmentLine('word '.repeat(80), geo.innerW)
  expect(segs.length).toBeGreaterThan(1)
  for (const s of segs) expect(s).toBe(s.trim()), expect(s.startsWith('word')).toBe(true), expect(s.endsWith('word')).toBe(true)
})

test('an unbroken long token is hard-split', () => {
  const segs = segmentLine('x'.repeat(300), geo.innerW)
  expect(segs.join('').length).toBe(300)
  for (const s of segs) expect(renderedLines(s, geo.innerW)).toBe(1)
})

test('empty lines survive', () => {
  expect(toVisualLines('a\n\nb', geo.innerW)).toEqual(['a', '', 'b'])
})

test('paged window never overflows the container', () => {
  const lines = toVisualLines(Array.from({ length: 60 }, (_, i) => `${i} ${LOREM}`).join('\n'), geo.innerW)
  for (const off of [0, 1, 8, 9, 20, 100, 1000]) {
    const v = pagedWindow(lines, off, geo)
    expect(measureTextWrap(v.text, geo.innerW).lineCount).toBeLessThanOrEqual(geo.maxLines)
    expect(measureTextWrap(v.text, geo.innerW).height).toBeLessThanOrEqual(geo.maxLines * 27)
    expect(utf8Len(v.text)).toBeLessThanOrEqual(1000)
  }
})

test('off=0 is the newest page; clamping reaches the top', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  expect(pagedWindow(lines, 0, geo).text.split('\n').at(-1)).toBe('line 29')
  const top = pagedWindow(lines, 9999, geo)
  expect(top.atTop).toBe(true)
  expect(top.text.split('\n')[0]).toBe('line 0')
  expect(top.shown).toBe(9)
})

test('pinned prompt takes bottom lines at off=0 only', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  const v = pagedWindow(lines, 0, geo, ['Do you want?', '1. Yes', '2. No'])
  const rows = v.text.split('\n')
  expect(rows.length).toBe(9)
  expect(rows.slice(-3)).toEqual(['Do you want?', '1. Yes', '2. No'])
  expect(rows[5]).toBe('line 29')
  expect(pagedWindow(lines, 3, geo, ['p']).text).not.toContain('p\n')
})

test('byte cap drops the oldest lines first', () => {
  const lines = Array.from({ length: 9 }, () => '└'.repeat(60)) // 180 bytes per line
  const v = pagedWindow(lines, 0, geo)
  expect(utf8Len(v.text)).toBeLessThanOrEqual(1000)
  expect(v.shown).toBeLessThan(9)
})

test('native window respects bytes and offset', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line number ${i} with some text`)
  const w = nativeWindow(lines, 0, 1800)
  expect(utf8Len(w.text)).toBeLessThanOrEqual(1800)
  expect(w.end).toBe(200)
  expect(w.text.endsWith('line number 199 with some text')).toBe(true)
  const older = nativeWindow(lines, 40, 1800)
  expect(older.end).toBe(160)
})

test('native chunk is positioned by its top line and never passes the frozen end', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line number ${i} with some text`)
  const c = nativeChunk(lines, 120, 200, 1800)
  expect(c.top).toBe(120)
  expect(c.text.startsWith('line number 120 ')).toBe(true)
  expect(utf8Len(c.text)).toBeLessThanOrEqual(1800)
  expect(c.chunkEnd).toBeGreaterThan(120)
  const near = nativeChunk(lines, 190, 195, 1800)
  expect(near.chunkEnd).toBe(195) // frozen end: lines that arrived later are not included
  expect(nativeChunk(lines, -4, 200, 1800).top).toBe(0)
})
