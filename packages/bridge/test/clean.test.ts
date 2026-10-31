import { describe, expect, test } from 'bun:test'
import { cleanScreen, promptTail } from '../src/clean.ts'

const R = '─'.repeat(40)
describe('cleanScreen', () => {
  test('agent: drops input box, footer, spinner; keeps content; collapses blanks', () => {
    const raw = ['Hello world', '', '', '', 'Result: 42', '✻ Thinking… (12s · esc to interrupt)', R, '❯ ', R, '  ? for shortcuts', '  Context: 23% used'].join('\n')
    expect(cleanScreen(raw, { agent: true })).toBe('Hello world\n\nResult: 42')
  })
  test('classic framed box and borders', () => {
    const raw = ['│ some text │', '╭────────────╮', '│ > hi       │', '╰────────────╯', '  esc to interrupt'].join('\n')
    const out = cleanScreen(raw, { agent: false })
    expect(out).toBe('some text\n> hi')
  })
  test('non-agent keeps shell content', () => {
    expect(cleanScreen('$ ls\na  b\n$ ')).toBe('$ ls\na  b\n$')
  })
  test('strips ANSI', () => {
    expect(cleanScreen('\u001b[31mred\u001b[0m')).toBe('red')
  })
})
describe('promptTail', () => {
  test('keeps the last 15 non-empty lines and the dialog intact', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    lines.push('╭──────────╮', '│ Do you want to proceed? │', '│ ❯ 1. Yes │', '│   2. No │', '╰──────────╯', '', '')
    const out = promptTail(lines.join('\n'), 15).split('\n')
    expect(out.filter((l) => l.trim()).length).toBe(15)
    expect(out.join('\n')).toContain('Do you want to proceed?')
    expect(out.join('\n')).toContain('2. No')
    expect(out.join('\n')).not.toContain('╭')
  })
})
