import { describe, expect, test } from 'bun:test'
import { ALLOWED_METHODS, HerdrClient } from '../src/herdr.ts'
import { isAllowedKey } from '@herdr-even/protocol'

describe('herdr allowlist', () => {
  test('exact set', () => {
    expect([...ALLOWED_METHODS].sort()).toEqual(
      ['agent.get', 'agent.list', 'events.subscribe', 'pane.get', 'pane.list', 'pane.read', 'pane.send_keys', 'pane.send_text', 'ping', 'session.snapshot'].sort(),
    )
  })
  test('mutating methods are refused before touching any socket', async () => {
    const c = new HerdrClient('/nonexistent/socket')
    for (const m of ['pane.close', 'pane.split', 'workspace.create', 'workspace.close', 'tab.create', 'pane.focus', 'pane.rename', 'agent.start', 'agent.prompt', 'server.stop', 'pane.move']) {
      await expect(c.call(m)).rejects.toMatchObject({ code: 'method_not_allowed' })
    }
  })
  test('unreachable socket gives herdr_unavailable', async () => {
    await expect(new HerdrClient('/nonexistent/socket').call('ping')).rejects.toMatchObject({ code: 'herdr_unavailable' })
  })
})
describe('keys', () => {
  test('allowed / rejected', () => {
    for (const k of ['enter', 'ctrl+c', 'shift+tab', 'y', '1', 'up', 'f5', 'ctrl+alt+d']) expect(isAllowedKey(k)).toBe(true)
    for (const k of ['', 'ctrl+', 'rm -rf', 'ctrl+;', 'enter\n', 'super+a', 'f13']) expect(isAllowedKey(k)).toBe(false)
  })
})
