import net from 'node:net'

// SAFETY: method allowlist enforced here, before anything touches a socket.
// No create/close/split/focus/rename/move/prompt/start/server.* — ever.
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'ping',
  'session.snapshot',
  'agent.list',
  'agent.get',
  'pane.read',
  'pane.get',
  'pane.list',
  'events.subscribe',
  'pane.send_keys',
  'pane.send_text',
])

export class HerdrError extends Error {
  constructor(message: string, public code: string = 'herdr_error') {
    super(message)
  }
}

export function assertAllowed(method: string): void {
  if (!ALLOWED_METHODS.has(method)) throw new HerdrError(`herdr method not allowed: ${method}`, 'method_not_allowed')
}

/** Line-splitting helper for NDJSON streams. */
export function lineSplitter(onLine: (line: string) => void) {
  let buf = ''
  return (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  }
}

export class HerdrClient {
  constructor(public readonly socketPath: string, private timeoutMs = 3000) {}

  /** One short-lived connection per request: robust against stale sockets and Herdr restarts. */
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    try {
      assertAllowed(method)
    } catch (e) {
      return Promise.reject(e)
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let done = false
      const sock = net.createConnection(this.socketPath)
      const finish = (err: Error | null, val?: any) => {
        if (done) return
        done = true
        clearTimeout(timer)
        sock.destroy()
        err ? reject(err) : resolve(val)
      }
      const timer = setTimeout(() => finish(new HerdrError(`herdr ${method} timed out`, 'herdr_unavailable')), this.timeoutMs)
      sock.setEncoding('utf8')
      sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'))
      sock.on(
        'data',
        lineSplitter((line) => {
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            return
          }
          if (msg.id !== id) return
          if (msg.error) finish(new HerdrError(`herdr ${method}: ${msg.error.code ?? ''} ${msg.error.message ?? ''}`.trim(), msg.error.code ?? 'herdr_error'))
          else finish(null, msg.result)
        }),
      )
      sock.on('error', (e) => finish(new HerdrError(`herdr socket: ${e.message}`, 'herdr_unavailable')))
      sock.on('close', () => finish(new HerdrError(`herdr socket closed (${method})`, 'herdr_unavailable')))
    })
  }

  /** Persistent subscription connection. Returns a handle with close(). */
  subscribe(
    subscriptions: { type: string; pane_id?: string }[],
    h: {
      onStarted: () => void
      onEvent: (ev: any) => void
      /** Called exactly once when the connection ends or errors (incl. events_lost). */
      onEnd: (reason: string) => void
    },
  ): { close: () => void } {
    assertAllowed('events.subscribe')
    let ended = false
    const sock = net.createConnection(this.socketPath)
    const end = (reason: string) => {
      if (ended) return
      ended = true
      sock.destroy()
      h.onEnd(reason)
    }
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } }) + '\n'))
    sock.on(
      'data',
      lineSplitter((line) => {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.error) return end(`${msg.error.code ?? 'error'}: ${msg.error.message ?? ''}`)
        if (msg.result?.type === 'subscription_started') return h.onStarted()
        const ev = msg.event ?? msg
        try {
          h.onEvent(ev)
        } catch {}
      }),
    )
    sock.on('error', (e) => end(e.message))
    sock.on('close', () => end('closed'))
    return {
      close() {
        if (ended) return
        ended = true
        sock.destroy()
      },
    }
  }
}
