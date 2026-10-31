import { hostname } from 'node:os'
import {
  PROTOCOL_VERSION,
  isAllowedKey,
  type ClientMsg,
  type ErrorCode,
  type Health,
  type ServerMsg,
} from '@herdr-even/protocol'
import type { Config } from './config.ts'
import { HerdrError } from './herdr.ts'
import type { SubagentInfo } from './model.ts'
import { MAX_ITEM_CHARS, MAX_QUEUE } from './queue.ts'
import { PaneView } from './pane-view.ts'
import { appendPluginLog } from './plugin-log.ts'
import type { SessionManager } from './sessions.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export const machineName = () => hostname().split('.')[0] || 'machine'

class Fail extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message)
  }
}

interface WsData {
  user: string | null
  view: PaneView | null
  unsub?: () => void
  unsubQueue?: () => void
}

/**
 * Run a startup step; if it throws (port in use, bad bind address, ...), log and exit non-zero so launchd / systemd
 * restart the process instead of leaving a half-alive bridge that serves nothing.
 */
export function startOrExit<T>(start: () => T, log: (s: string) => void = console.error, exit: (code: number) => never = process.exit): T {
  try {
    return start()
  } catch (e: any) {
    log(`herdr-even: failed to start: ${e?.message ?? e}; exiting so the service manager can retry`)
    return exit(1)
  }
}

export function startServer(cfg: Config, mgr: SessionManager, log: (s: string) => void = () => {}) {
  const machine = machineName()

  const authorized = (req: Request): boolean => {
    if (cfg.devNoAuth) return true
    return !!cfg.owner && req.headers.get('tailscale-user-login') === cfg.owner
  }

  const server = Bun.serve<WsData>({
    port: cfg.port,
    hostname: cfg.host,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      if (url.pathname === '/health' && req.method === 'GET') {
        const body: Health = { ok: true, protocol: PROTOCOL_VERSION, machine }
        return new Response(JSON.stringify(body), { headers: { ...CORS, 'content-type': 'application/json' } })
      }
      if (url.pathname === '/ws') {
        if (!authorized(req)) {
          log(`ws rejected (login=${req.headers.get('tailscale-user-login') ?? 'none'})`)
          return new Response('forbidden', { status: 403, headers: CORS })
        }
        const ok = srv.upgrade(req, { data: { user: req.headers.get('tailscale-user-login'), view: null } satisfies WsData })
        return ok ? undefined : new Response('upgrade failed', { status: 400, headers: CORS })
      }
      return new Response('not found', { status: 404, headers: CORS })
    },
    websocket: {
      open(ws) {
        const send = (m: ServerMsg) => {
          try {
            ws.send(JSON.stringify(m))
          } catch {}
        }
        send({
          t: 'hello',
          protocol: PROTOCOL_VERSION,
          machine,
          herdrVersion: mgr.herdrVersion,
          user: ws.data.user,
          snippets: cfg.snippets,
        })
        send({ t: 'panes', panes: mgr.panes() })
        ws.data.unsub = mgr.onPanes((panes) => {
          send({ t: 'panes', panes })
          const v = ws.data.view
          if (v && !v.update(mgr.get(v.paneId))) {
            ws.data.view = null
            v.dispose()
            send({ t: 'error', code: 'unknown_pane', message: `pane ${v.paneId} is gone` })
          }
        })
        ws.data.unsubQueue = mgr.queue.onChange((pane, items) => {
          if (ws.data.view?.paneId === pane) send({ t: 'queue', pane, items })
        })
        log('client connected')
      },
      close(ws) {
        ws.data.unsub?.()
        ws.data.unsubQueue?.()
        ws.data.view?.dispose()
        ws.data.view = null
        log('client disconnected')
      },
      async message(ws, raw) {
        const send = (m: ServerMsg) => {
          try {
            ws.send(JSON.stringify(m))
          } catch {}
        }
        let id: string | undefined
        try {
          const msg = parse(raw)
          id = typeof (msg as any).id === 'string' ? (msg as any).id : undefined
          await handle(ws, msg, send)
        } catch (e: any) {
          if (e instanceof Fail) send({ t: 'error', id, code: e.code, message: e.message })
          else if (e instanceof HerdrError)
            send({ t: 'error', id, code: e.code === 'herdr_unavailable' ? 'herdr_unavailable' : 'herdr_error', message: e.message })
          else send({ t: 'error', id, code: 'internal', message: String(e?.message ?? e) })
        }
      },
    },
  })

  function parse(raw: string | Buffer): ClientMsg {
    let m: any
    try {
      m = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch {
      throw new Fail('bad_request', 'invalid JSON')
    }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') throw new Fail('bad_request', 'missing "t"')
    return m as ClientMsg
  }

  const needId = (m: any): string => {
    if (typeof m.id !== 'string' || !m.id) throw new Fail('bad_request', 'missing "id"')
    return m.id
  }
  const needPane = (m: any) => {
    if (typeof m.pane !== 'string' || !m.pane) throw new Fail('bad_request', 'missing "pane"')
    const info = mgr.get(m.pane)
    if (!info) throw new Fail('unknown_pane', `unknown pane: ${m.pane}`)
    return info
  }

  async function handle(ws: Bun.ServerWebSocket<WsData>, msg: ClientMsg, send: (m: ServerMsg) => void) {
    const m = msg as any
    switch (msg.t) {
      case 'ping':
        return send({ t: 'pong', id: needId(m) })
      case 'log':
        if (typeof m.msg !== 'string') throw new Fail('bad_request', 'log needs msg')
        appendPluginLog(cfg.configDir, { level: ['info', 'warn', 'error'].includes(m.level) ? m.level : 'info', msg: m.msg, data: m.data })
        return
      case 'open': {
        const id = needId(m)
        const info = needPane(m)
        let sub: SubagentInfo | null = null
        if (m.subagent !== undefined) {
          if (typeof m.subagent !== 'string' || !m.subagent) throw new Fail('bad_request', 'subagent must be a string')
          sub = await info.subagents.find(info.summary.agent, info.sessionId, info.transcript, m.subagent)
          if (!sub) throw new Fail('unknown_subagent', `unknown subagent: ${m.subagent.slice(0, 80)}`)
        }
        ws.data.view?.dispose()
        const view = new PaneView(m.pane, info, send, sub)
        ws.data.view = view
        await view.start(id)
        if (ws.data.view === view) send({ t: 'queue', pane: m.pane, items: mgr.queue.list(m.pane) })
        return
      }
      case 'close': {
        const id = needId(m)
        ws.data.view?.dispose()
        ws.data.view = null
        return send({ t: 'ok', id })
      }
      case 'older': {
        const id = needId(m)
        needPane(m)
        if (typeof m.before !== 'string') throw new Fail('bad_request', 'older needs before')
        const v = ws.data.view
        const same = v && v.paneId === m.pane && v.subagentId === (typeof m.subagent === 'string' ? m.subagent : undefined)
        const r = same ? v.older(m.before, typeof m.limit === 'number' ? m.limit : undefined) : { entries: [], hasOlder: false }
        return send({ t: 'chat.older', id, pane: m.pane, ...(typeof m.subagent === 'string' ? { subagent: m.subagent } : {}), entries: r.entries, hasOlder: r.hasOlder })
      }
      case 'keys': {
        const id = needId(m)
        if (!Array.isArray(m.keys) || m.keys.length === 0 || m.keys.length > 64) throw new Fail('bad_request', 'keys must be a non-empty array')
        for (const k of m.keys) if (typeof k !== 'string' || !isAllowedKey(k)) throw new Fail('key_not_allowed', `key not allowed: ${String(k).slice(0, 40)}`)
        const info = needPane(m)
        await info.client.call('pane.send_keys', { pane_id: info.summary.paneId, keys: m.keys })
        mgr.nudge(m.pane)
        return send({ t: 'ok', id })
      }
      case 'text': {
        const id = needId(m)
        if (typeof m.text !== 'string' || m.text.length === 0 || m.text.length > 8000) throw new Fail('bad_request', 'text must be a non-empty string (<= 8000 chars)')
        needPane(m)
        if (m.queue === true) {
          if (m.text.length > MAX_ITEM_CHARS) throw new Fail('bad_request', `queued text must be <= ${MAX_ITEM_CHARS} chars`)
          await mgr.refreshNow(m.pane) // don't act on a status that's up to a debounce interval stale
          if (!mgr.queue.add(m.pane, m.text)) throw new Fail('bad_request', `queue is full (${MAX_QUEUE} messages)`)
          return send({ t: 'ok', id })
        }
        await mgr.sendText(m.pane, m.text, m.enter === true)
        return send({ t: 'ok', id })
      }
      case 'unqueue': {
        const id = needId(m)
        needPane(m)
        if (typeof m.item !== 'string' || !m.item) throw new Fail('bad_request', 'unqueue needs item')
        if (!mgr.queue.remove(m.pane, m.item)) throw new Fail('unknown_item', `unknown queued item: ${m.item.slice(0, 40)}`)
        return send({ t: 'ok', id })
      }
      default:
        throw new Fail('bad_request', `unknown message type: ${(msg as any).t}`)
    }
  }

  return server
}
