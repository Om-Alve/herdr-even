import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatus, QueuedItem } from '@herdr-even/protocol'
import { MAX_QUEUE, MessageQueue } from '../src/queue.ts'

// Fake status source + fake clock: no Herdr, no timers (tickMs is huge; tests call evaluateAll()).
function setup(opts: { status?: AgentStatus | null; fail?: number; grace?: number } = {}) {
  const w = {
    status: (opts.status === undefined ? 'working' : opts.status) as AgentStatus | null,
    t: 1_000_000,
    sent: [] as string[],
    failures: opts.fail ?? 0,
    logs: [] as string[],
    changes: [] as { pane: string; ids: string[] }[],
  }
  const q = new MessageQueue({
    status: () => w.status,
    deliver: async (_p, text) => {
      if (w.failures > 0) {
        w.failures--
        throw new Error('boom')
      }
      w.sent.push(text)
    },
    log: (s) => w.logs.push(s),
    now: () => w.t,
    tickMs: 3_600_000,
    vanishGraceMs: opts.grace ?? 0,
  })
  q.onChange((pane, items) => w.changes.push({ pane, ids: items.map((i) => i.text) }))
  const step = async () => {
    q.evaluateAll()
    await Bun.sleep(5)
  }
  return { w, q, step }
}
const P = 'default/w1:p1'

describe('MessageQueue', () => {
  test('restores queued Codex text after a bridge restart and delivers only to the same session', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'he-queue-')), 'queue.json')
    const w = { status: 'working' as AgentStatus, session: 'codex:one', sent: [] as string[] }
    const deps = {
      file,
      status: () => w.status,
      identity: () => w.session,
      deliver: async (_pane: string, text: string) => { w.sent.push(text) },
      tickMs: 3_600_000,
    }
    const first = new MessageQueue(deps)
    first.add(P, 'continue after this turn')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    first.stop()

    const restored = new MessageQueue(deps)
    expect(restored.list(P).map(x => x.text)).toEqual(['continue after this turn'])
    w.status = 'done'
    await restored.evaluate(P)
    expect(w.sent).toEqual(['continue after this turn'])
    expect(restored.list(P)).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).panes).toEqual([])
    restored.stop()

    w.status = 'working'
    const stale = new MessageQueue(deps)
    stale.add(P, 'for old session')
    stale.stop()
    w.session = 'codex:two'
    const changed = new MessageQueue(deps)
    w.status = 'done'
    await changed.evaluate(P)
    expect(changed.list(P)).toEqual([])
    expect(w.sent).toEqual(['continue after this turn'])
    changed.stop()
  })

  test('holds while working, delivers when idle or done', async () => {
    const { w, q, step } = setup()
    const it = q.add(P, 'a')!
    expect(it.ts).toBe(w.t)
    await step()
    expect(w.sent).toEqual([])
    expect(q.list(P).map((i) => i.text)).toEqual(['a'])
    w.status = 'idle'
    await step()
    expect(w.sent).toEqual(['a'])
    expect(q.list(P)).toEqual([])
    q.stop()
  })

  test('delivers right away when already idle or done', async () => {
    for (const s of ['idle', 'done'] as const) {
      const { w, q } = setup({ status: s })
      q.add(P, 'now')
      await Bun.sleep(5)
      expect(w.sent).toEqual(['now'])
      q.stop()
    }
  })

  test('blocked holds, even after being idle', async () => {
    const { w, q, step } = setup({ status: 'blocked' })
    q.add(P, 'a')
    await step()
    expect(w.sent).toEqual([])
    w.status = 'done'
    await step()
    expect(w.sent).toEqual(['a'])
    q.stop()
  })

  test('unknown (non-agent) delivers immediately, all in order', async () => {
    const { w, q } = setup({ status: 'unknown' })
    q.add(P, 'a')
    q.add(P, 'b')
    q.add(P, 'c')
    await Bun.sleep(20)
    expect(w.sent).toEqual(['a', 'b', 'c'])
    q.stop()
  })

  test('one item per idle period; next needs working then idle, or the 20 s fallback', async () => {
    const { w, q, step } = setup({ status: 'idle' })
    q.add(P, 'a')
    q.add(P, 'b')
    q.add(P, 'c')
    await step()
    expect(w.sent).toEqual(['a'])
    w.t += 5_000
    await step()
    expect(w.sent).toEqual(['a']) // still idle, agent hasn't reacted yet
    w.status = 'working'
    await step()
    w.status = 'idle'
    await step()
    expect(w.sent).toEqual(['a', 'b'])
    w.t += 19_000
    await step()
    expect(w.sent).toEqual(['a', 'b'])
    w.t += 1_500 // ~20 s idle since delivery, agent ignored it
    await step()
    expect(w.sent).toEqual(['a', 'b', 'c'])
    q.stop()
  })

  test('a working period seen while the queue was empty still counts', async () => {
    const { w, q, step } = setup({ status: 'idle' })
    q.add(P, 'a')
    await step()
    w.status = 'working'
    await step()
    w.status = 'idle'
    await step()
    q.add(P, 'b')
    await step()
    expect(w.sent).toEqual(['a', 'b'])
    q.stop()
  })

  test('unqueue removes undelivered items only', async () => {
    const { w, q, step } = setup()
    const a = q.add(P, 'a')!
    const b = q.add(P, 'b')!
    expect(q.remove(P, a.id)).toBe(true)
    expect(q.remove(P, a.id)).toBe(false)
    expect(q.remove(P, 'nope')).toBe(false)
    w.status = 'idle'
    await step()
    expect(w.sent).toEqual(['b'])
    expect(q.remove(P, b.id)).toBe(false) // delivered
    q.stop()
  })

  test('pane vanishes: queue dropped, logged, clients told', async () => {
    const { w, q, step } = setup()
    q.add(P, 'a')
    w.status = null
    await step()
    expect(q.list(P)).toEqual([])
    expect(w.logs.some((l) => l.includes('gone'))).toBe(true)
    expect(w.changes.at(-1)).toEqual({ pane: P, ids: [] })
    q.stop()
  })

  test('a briefly missing pane is not dropped within the grace period', async () => {
    const { w, q, step } = setup({ grace: 3000 })
    q.add(P, 'a')
    w.status = null
    await step()
    expect(q.list(P).length).toBe(1)
    w.status = 'idle'
    await step()
    expect(w.sent).toEqual(['a'])
    q.stop()
  })

  test('failed send keeps the item, retries, drops after 3 attempts', async () => {
    const { w, q, step } = setup({ status: 'idle', fail: 2 })
    q.add(P, 'a')
    await step()
    expect(q.list(P).length).toBe(1)
    await step()
    expect(q.list(P).length).toBe(1)
    await step()
    expect(w.sent).toEqual(['a'])

    const t = setup({ status: 'idle', fail: 99 })
    t.q.add(P, 'x')
    await t.step()
    await t.step()
    await t.step()
    expect(t.q.list(P)).toEqual([])
    expect(t.w.sent).toEqual([])
    expect(t.w.logs.some((l) => l.includes('dropping'))).toBe(true)
    q.stop()
    t.q.stop()
  })

  test('caps the queue at 20 items', () => {
    const { q } = setup()
    for (let i = 0; i < MAX_QUEUE; i++) expect(q.add(P, String(i))).not.toBeNull()
    expect(q.add(P, 'x')).toBeNull()
    q.stop()
  })

  test('change notifications: add, deliver, unqueue', async () => {
    const { w, q, step } = setup()
    const a = q.add(P, 'a')!
    q.add(P, 'b')
    q.remove(P, a.id)
    w.status = 'idle'
    await step()
    expect(w.changes.map((c) => c.ids)).toEqual([['a'], ['a', 'b'], ['b'], []])
    q.stop()
  })
})
