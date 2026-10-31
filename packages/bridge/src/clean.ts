import { stripAnsi } from './ansi.ts'

const BOX = '─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬╌╍┄┅┈┉╴╵╶╷▔▁▏▕▀▄▌▐'
const BORDER_ONLY = new RegExp(`^[\\s${BOX}]*$`)
const RULE = new RegExp(`^\\s*[${BOX}]{8,}\\s*$`)
const SIDE_L = new RegExp(`^\\s*[│┃║]\\s?`)
const SIDE_R = new RegExp(`\\s?[│┃║]\\s*$`)

const FOOTER: RegExp[] = [
  /\? for shortcuts/i,
  /esc to interrupt/i,
  /ctrl\+c to (?:quit|exit)/i,
  /press (?:ctrl|esc|enter)\b.*\bto\b/i,
  /context:?\s*\d+%\s*(?:used|left|remaining)/i,
  /\d+%\s*(?:context )?(?:used|left)\b.*$/i,
  /shift\+tab to cycle/i,
  /(?:bypass permissions|accept edits|auto-accept edits|plan mode)\s+(?:on|off)/i,
  /ctrl\+[a-z] to (?:expand|toggle|show|view|edit)/i,
  /\(ctrl\+o to expand\)/i,
  /tab to (?:queue|cycle|expand)/i,
  /^\s*(?:\d+\s+)?(?:tokens?|tok)\b.*\besc\b/i,
]
const SPINNER_GLYPH = /^[\s✻✶✳✢·✽*∗⠁-⣿◐◓◑◒⏺●]*/
// "✻ Thinking… (12s · esc to interrupt)", "· Cogitating… (3s)", "Working…"
const SPINNER_LINE = /^[\s✻✶✳✢·✽*∗⠁-⣿◐◓◑◒]*[A-Z][A-Za-z]+(?:ing)?…(?:\s*\(.*\))?\s*$/
const THINKING = /^\s*(?:thinking|working|generating|processing)(?:\.\.\.|…)?\s*$/i

const squash = (lines: string[]) => {
  const out: string[] = []
  for (const l of lines) {
    if (l.trim() === '') {
      if (out.length && out[out.length - 1] !== '') out.push('')
    } else out.push(l)
  }
  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

const stripSides = (l: string): string => {
  // Only strip a side border when the line looks like it is framed.
  if (SIDE_L.test(l) && SIDE_R.test(l)) return l.replace(SIDE_L, '').replace(SIDE_R, '')
  return l
}

const norm = (text: string) =>
  stripAnsi(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))

/** Light clean: strip frames and blank runs. Used for the blocked prompt (dialog must stay intact). */
export function cleanLight(text: string): string {
  const lines = norm(text)
    .filter((l) => !BORDER_ONLY.test(l) || l.trim() === '')
    .map(stripSides)
    .map((l) => l.replace(/\s+$/, ''))
  return squash(lines).join('\n')
}

/** Last N non-empty lines of the light-cleaned text (blocked prompt). */
export function promptTail(visible: string, n = 15): string {
  const lines = cleanLight(visible).split('\n')
  const nonEmpty: number[] = []
  lines.forEach((l, i) => l.trim() && nonEmpty.push(i))
  const start = nonEmpty.length > n ? nonEmpty[nonEmpty.length - n]! : 0
  return lines.slice(start).join('\n').trim()
}

/** Full screen clean for the chat fallback. `agent` enables input-box removal. */
export function cleanScreen(text: string, opts: { agent?: boolean } = {}): string {
  let lines = norm(text)

  if (opts.agent) {
    // Drop the input box + everything under it. Two shapes:
    //  (a) rule line, prompt line(s), rule line, footer   (new Claude Code)
    //  (b) ╭──╮ │ > … │ ╰──╯ footer                      (classic)
    const tailStart = Math.max(0, lines.length - 16)
    const rules: number[] = []
    for (let i = tailStart; i < lines.length; i++) if (RULE.test(lines[i]!)) rules.push(i)
    if (rules.length >= 2) {
      // first rule of the last pair that encloses the input
      lines = lines.slice(0, rules[rules.length - 2])
    } else if (rules.length === 1 && lines.length - rules[0]! <= 8) {
      lines = lines.slice(0, rules[0])
    }
  }

  lines = lines
    .filter((l) => !BORDER_ONLY.test(l) || l.trim() === '')
    .map(stripSides)
    .filter((l) => {
      if (FOOTER.some((re) => re.test(l))) return false
      if (SPINNER_LINE.test(l) && SPINNER_GLYPH.test(l)) return false
      if (THINKING.test(l)) return false
      return true
    })
    .map((l) => l.replace(/\s+$/, ''))
  return squash(lines).join('\n')
}
