// Mock Deepgram streaming server for plugin development. Usage: bun scripts/mock-deepgram.ts [port]  (default 8796)
// Accepts any path + the `token` subprotocol. Binary frames = audio: a growing interim `Results` every ~300 ms while audio
// flows. `Finalize` -> an `is_final` Results (from_finalize) with the text so far; `KeepAlive` is counted; `CloseStream` closes.
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8796)
const WORDS = 'hello herdr please run the unit tests and then show me the failing ones in the api workspace thanks'.split(' ')

type St = { frames: number; words: number; timer?: ReturnType<typeof setInterval>; lastAudio: number; keepAlives: number }
const log = (s: string) => console.log(`[mock-dg] ${s}`)

const results = (text: string, isFinal: boolean, fromFinalize = false) => JSON.stringify({
  type: 'Results', channel_index: [0, 1], duration: 1, start: 0, is_final: isFinal, speech_final: isFinal, from_finalize: fromFinalize,
  channel: { alternatives: [{ transcript: text, confidence: 0.99, words: [] }] },
})

Bun.serve<St>({
  port: PORT,
  fetch(req, server) {
    const u = new URL(req.url)
    if (u.pathname === '/health') return new Response('ok')
    const proto = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim())
    if (!proto.includes('token')) return new Response('missing token subprotocol', { status: 401 })
    log(`connect ${u.pathname} keyterms=${u.searchParams.getAll('keyterm').join('|') || '-'}`)
    // echo the first offered subprotocol like Deepgram does
    return server.upgrade(req, { data: { frames: 0, words: 0, lastAudio: 0, keepAlives: 0 }, headers: { 'Sec-WebSocket-Protocol': 'token' } }) ? undefined : new Response('upgrade failed', { status: 400 })
  },
  websocket: {
    open(ws) {
      ws.data.timer = setInterval(() => {
        if (Date.now() - ws.data.lastAudio > 500) return // no audio recently: stay quiet
        ws.data.words = Math.min(WORDS.length, ws.data.words + 1)
        ws.send(results(WORDS.slice(0, ws.data.words).join(' '), false))
      }, 300)
    },
    message(ws, raw) {
      if (typeof raw !== 'string') { ws.data.frames++; ws.data.lastAudio = Date.now(); return }
      let m: any
      try { m = JSON.parse(raw) } catch { return }
      if (m.type === 'KeepAlive') { ws.data.keepAlives++; log(`KeepAlive #${ws.data.keepAlives}`) }
      else if (m.type === 'Finalize') {
        const text = WORDS.slice(0, ws.data.words).join(' ')
        log(`Finalize -> "${text}" (${ws.data.frames} frames)`)
        ws.send(results(text, true, true))
        ws.data.words = 0; ws.data.frames = 0
      } else if (m.type === 'CloseStream') { log('CloseStream'); ws.send(JSON.stringify({ type: 'Metadata' })); ws.close(1000) }
    },
    close(ws) { clearInterval(ws.data.timer); log('closed') },
  },
})
log(`listening on ws://localhost:${PORT}`)
