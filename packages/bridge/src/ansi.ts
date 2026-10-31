// Strip ANSI CSI / OSC / other escape sequences and stray control chars.
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -\/]*[@-~]/g
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '').replace(CTRL, '')
}
