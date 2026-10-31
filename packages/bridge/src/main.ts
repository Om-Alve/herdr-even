import { loadConfig } from './config.ts'
import { SessionManager } from './sessions.ts'
import { startOrExit, startServer, machineName } from './server.ts'

const ts = () => new Date().toISOString().slice(11, 23)
const log = (s: string) => console.log(`${ts()} ${s}`)

process.on('uncaughtException', (e) => console.error(`${ts()} uncaught: ${e?.stack ?? e}`))
process.on('unhandledRejection', (e) => console.error(`${ts()} unhandled: ${e}`))

let cfg
try {
  cfg = loadConfig()
} catch (e: any) {
  console.error(e.message)
  process.exit(1)
}

if (!cfg.owner && !cfg.devNoAuth) {
  console.error(
    'herdr-even: refusing to start, no owner configured.\n' +
      '  Set "owner" (your Tailscale login, e.g. you@example.com) in ~/.config/herdr-even/config.json\n' +
      '  or HERDR_EVEN_OWNER. For local testing only: HERDR_EVEN_DEV_NOAUTH=1 (127.0.0.1 only).',
  )
  process.exit(1)
}
if (cfg.devNoAuth) {
  console.warn('\n' + '!'.repeat(72))
  console.warn('!! HERDR_EVEN_DEV_NOAUTH=1: AUTH DISABLED. Anyone who can reach this port can')
  console.warn('!! read and TYPE INTO your terminals. Loopback only. Never use with tailscale serve.')
  console.warn('!'.repeat(72) + '\n')
}

const mgr = new SessionManager(cfg)
// Bind the port first: if it fails we exit before touching Herdr sockets, and launchd/systemd retry.
const server = startOrExit(() => startServer(cfg, mgr, log), (m) => console.error(`${ts()} ${m}`))
mgr.start()
log(`herdr-even bridge on http://${cfg.host}:${server.port} as "${machineName()}" owner=${cfg.owner ?? '(dev: none)'}`)

const shutdown = () => {
  mgr.stop()
  server.stop(true)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
