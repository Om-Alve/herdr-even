import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { ChatModel, Delta } from './model.ts'

export interface TailHandlers {
  onDelta: (d: Delta) => void
  /** File was truncated/replaced: the model was rebuilt; resend the whole window. */
  onReset: () => void
  /** File vanished or is unparseable: caller should fall back to screen mode. */
  onFail: (reason: string) => void
}

/** Tails an agent JSONL transcript (Claude or Codex, via `makeModel`) by byte offset; buffers partial last lines. */
export class TranscriptTail {
  model: ChatModel
  private offset = 0
  private partial: Buffer = Buffer.alloc(0)
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private again = false
  private dead = false

  constructor(public path: string, private h: TailHandlers, private makeModel: () => ChatModel) {
    this.model = makeModel()
  }

  /** Initial full load. Throws on failure (caller falls back to screen). */
  async load(): Promise<void> {
    this.model = this.makeModel()
    this.partial = Buffer.alloc(0)
    // read in 4 MB slices, yielding to the event loop in between, so a huge transcript neither stalls the server
    // nor sits in memory as one buffer
    const fh = await open(this.path, 'r')
    try {
      const size = (await fh.stat()).size
      const buf = Buffer.alloc(Math.min(size, 4 << 20) || 1)
      let at = 0
      while (at < size) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, at)
        if (bytesRead <= 0) break
        at += bytesRead
        this.consume(buf.subarray(0, bytesRead), false)
        if (at < size) await new Promise((r) => setImmediate(r))
      }
      this.offset = at
      if (size > 0 && this.model.goodLines === 0 && this.model.badLines > 0) throw new Error('transcript unparseable')
    } finally {
      await fh.close()
    }
  }

  startWatching() {
    try {
      this.watcher = watch(this.path, () => void this.poll())
      this.watcher.on('error', () => {})
    } catch {}
    this.timer = setInterval(() => void this.poll(), 1000)
  }

  stop() {
    this.dead = true
    this.watcher?.close()
    if (this.timer) clearInterval(this.timer)
  }

  private consume(chunk: Buffer, emit: boolean) {
    let data = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk
    const delta: Delta = { appended: [], updated: [] }
    let start = 0
    for (;;) {
      const nl = data.indexOf(10, start)
      if (nl < 0) break
      const d = this.model.ingest(data.subarray(start, nl).toString('utf8'))
      delta.appended.push(...d.appended)
      delta.updated.push(...d.updated)
      start = nl + 1
    }
    this.partial = Buffer.from(data.subarray(start))
    if (emit && (delta.appended.length || delta.updated.length)) {
      // an update to an entry appended in the same batch is already reflected in the append
      const appendedIds = new Set(delta.appended.map((e) => e.id))
      const latest = new Map(this.model.entries.map((e) => [e.id, e]))
      delta.appended = delta.appended.map((e) => latest.get(e.id) ?? e)
      delta.updated = delta.updated.filter((e) => !appendedIds.has(e.id))
      if (delta.appended.length || delta.updated.length) this.h.onDelta(delta)
    }
  }

  private async poll() {
    if (this.dead) return
    if (this.busy) {
      this.again = true
      return
    }
    this.busy = true
    try {
      let st
      try {
        st = await stat(this.path)
      } catch (e: any) {
        this.fail(`transcript gone: ${e?.code ?? e}`)
        return
      }
      if (st.size < this.offset) {
        // truncated/rewritten
        await this.load()
        if (!this.dead) this.h.onReset()
      } else if (st.size > this.offset) {
        const fh = await open(this.path, 'r')
        try {
          const len = st.size - this.offset
          const buf = Buffer.alloc(len)
          const { bytesRead } = await fh.read(buf, 0, len, this.offset)
          this.offset += bytesRead
          if (!this.dead) this.consume(buf.subarray(0, bytesRead), true)
        } finally {
          await fh.close()
        }
      }
    } catch (e: any) {
      this.fail(`transcript read failed: ${e?.message ?? e}`)
    } finally {
      this.busy = false
      if (this.again && !this.dead) {
        this.again = false
        void this.poll()
      }
    }
  }

  private fail(reason: string) {
    if (this.dead) return
    this.stop()
    this.h.onFail(reason)
  }
}
