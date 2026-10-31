import { expect, test } from 'bun:test'
import { getAdvW } from '@evenrealities/pretext'
import { mapGlyphs } from './glyphs'

test('maps Claude Code glyphs', () => {
  expect(mapGlyphs('⏺ Bash(ls)\n  ⎿  done ✓')).toBe('● Bash(ls)\n  └  done √')
  expect(mapGlyphs('❯ hello ✻ thinking')).toBe('> hello * thinking')
})
test('curly quotes to ASCII, dashes kept', () => {
  expect(mapGlyphs('“hi” it’s – fine — ok…')).toBe('"hi" it\'s – fine — ok…')
})
test('braille spinners and ANSI are removed', () => {
  expect(mapGlyphs('\x1b[31m⠋ loading\x1b[0m')).toBe('* loading')
})
test('every output char is supported by the font', () => {
  const nasty = '⏺⎿✓✗❯✻⠋▪↳⚠⌘⌃⇧🤖日本語é​️\ttab'
  for (const ch of mapGlyphs(nasty)) if (ch !== '\n') expect(getAdvW(ch.codePointAt(0)!) > 0).toBe(true)
})
test('unknown glyphs become ?', () => {
  expect(mapGlyphs('a⌘b')).toBe('a?b')
})
test('tabs and CR', () => {
  expect(mapGlyphs('a\tb\r\nc')).toBe('a  b\nc')
})
test('backtick (not in the font) becomes an apostrophe', () => { expect(mapGlyphs('`x`')).toBe("'x'") })
test('block elements and box fragments from TUIs', () => {
  expect(mapGlyphs('▀▀▀╹')).toBe('───│')
})
