import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, DEFAULT_SNIPPETS } from '../src/config.ts'
import { appendPluginLog } from '../src/plugin-log.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'he-cfg-'))

describe('config', () => {
  test('creates default file when missing; owner unset', () => {
    const d = dir() + '/sub'
    const c = loadConfig({ HERDR_EVEN_CONFIG_DIR: d })
    expect(c.owner).toBeNull()
    expect(c.port).toBe(8791)
    expect(c.host).toBe('127.0.0.1')
    expect(c.snippets).toEqual(DEFAULT_SNIPPETS)
    expect(existsSync(join(d, 'config.json'))).toBe(true)
  })
  test('file + env overrides', () => {
    const d = dir()
    writeFileSync(join(d, 'config.json'), JSON.stringify({ owner: 'a@b.c', port: 9000, snippets: [{ label: 'x', keys: ['ctrl+c'] }, { label: 'bad', keys: ['nope!'] }] }))
    const c = loadConfig({ HERDR_EVEN_CONFIG_DIR: d })
    expect(c.owner).toBe('a@b.c')
    expect(c.port).toBe(9000)
    expect(c.snippets).toEqual([{ label: 'x', keys: ['ctrl+c'] }])
    const c2 = loadConfig({ HERDR_EVEN_CONFIG_DIR: d, HERDR_EVEN_OWNER: 'z@z.z', HERDR_EVEN_PORT: '1234' })
    expect([c2.owner, c2.port]).toEqual(['z@z.z', 1234])
  })
  test('dev noauth only on loopback', () => {
    const d = dir()
    expect(loadConfig({ HERDR_EVEN_CONFIG_DIR: d, HERDR_EVEN_DEV_NOAUTH: '1' }).devNoAuth).toBe(true)
    expect(loadConfig({ HERDR_EVEN_CONFIG_DIR: d, HERDR_EVEN_DEV_NOAUTH: '1', HERDR_EVEN_HOST: '0.0.0.0' }).devNoAuth).toBe(false)
  })
})

describe('plugin log', () => {
  test('appends and rotates past cap', () => {
    const d = dir()
    for (let i = 0; i < 50; i++) appendPluginLog(d, { level: 'info', msg: 'x'.repeat(100), data: { i } }, 2000)
    const f = join(d, 'plugin-log.jsonl')
    expect(JSON.parse(readFileSync(f, 'utf8').split('\n')[0]!).level).toBe('info')
    expect(existsSync(f + '.1')).toBe(true)
    expect(readFileSync(f).length).toBeLessThan(2000)
  })
})
