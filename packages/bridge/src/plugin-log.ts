import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_CAP = 5 * 1024 * 1024

export function appendPluginLog(configDir: string, rec: { level: string; msg: string; data?: unknown }, cap = LOG_CAP) {
  try {
    mkdirSync(configDir, { recursive: true })
    const file = join(configDir, 'plugin-log.jsonl')
    try {
      if (statSync(file).size > cap / 2) renameSync(file, file + '.1')
    } catch {}
    let line: string
    try {
      line = JSON.stringify({ ts: Date.now(), ...rec })
    } catch {
      line = JSON.stringify({ ts: Date.now(), level: rec.level, msg: rec.msg })
    }
    appendFileSync(file, line.slice(0, 64 * 1024) + '\n')
  } catch {}
}
