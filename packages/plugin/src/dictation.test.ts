import { expect, test } from 'bun:test'
import { applyResult, buildDgUrl, buildKeyterms, dictStep, newTranscript, transcriptText, type DictEvent, type DictPhase } from './dictation'

const res = (transcript: string, is_final: boolean, extra: object = {}) => ({ type: 'Results', is_final, channel: { alternatives: [{ transcript }] }, ...extra })

test('transcript: interim replaces interim, finals accumulate, interim appended', () => {
  const t = newTranscript()
  applyResult(t, res('hel', false)); expect(transcriptText(t)).toBe('hel')
  applyResult(t, res('hello wor', false)); expect(transcriptText(t)).toBe('hello wor')
  applyResult(t, res('Hello world.', true)); expect(transcriptText(t)).toBe('Hello world.')
  applyResult(t, res('run the', false)); expect(transcriptText(t)).toBe('Hello world. run the')
  applyResult(t, res('Run the tests.', true)); expect(transcriptText(t)).toBe('Hello world. Run the tests.')
  expect(t.interim).toBe('')
})

test('transcript: empty finals and non-Results messages are harmless; from_finalize is reported', () => {
  const t = newTranscript()
  expect(applyResult(t, { type: 'Metadata' }).changed).toBe(false)
  expect(applyResult(t, { type: 'SpeechStarted' }).changed).toBe(false)
  expect(applyResult(t, null).changed).toBe(false)
  applyResult(t, res('partial', false))
  const r = applyResult(t, res('', true, { from_finalize: true }))
  expect(r).toEqual({ changed: true, fromFinalize: true, text: '' })
  expect(transcriptText(t)).toBe('') // an empty final clears the stale interim
  expect(applyResult(t, res('x', true)).fromFinalize).toBe(false)
  expect(applyResult(t, { type: 'Results', is_final: false, channel: {} }).changed).toBe(true) // missing alternatives -> ''
})

test('keyterms: workspaces, agents, title words; deduped, filtered, capped', () => {
  const panes = [
    { workspace: 'api', agent: 'claude', title: 'zsh', tab: '1' },
    { workspace: 'ml-train', agent: 'codex', title: 'claude', tab: 'Training Run' },
    { workspace: 'API', agent: 'claude', title: 'vim ~/code/herdr', tab: '2' },
    { workspace: 'shell', agent: null, title: 'zsh', tab: '' },
  ]
  const k = buildKeyterms(panes)
  expect(k.slice(0, 4)).toEqual(['api', 'ml-train', 'claude', 'codex'])
  expect(k).toContain('Training'); expect(k).toContain('herdr'); expect(k).toContain('vim')
  expect(k).not.toContain('zsh'); expect(k).not.toContain('1')
  expect(new Set(k.map(x => x.toLowerCase())).size).toBe(k.length)
  const many = Array.from({ length: 50 }, (_, i) => ({ workspace: `workspace${i}`, agent: null, title: '', tab: '' }))
  expect(buildKeyterms(many).length).toBe(20)
  expect(buildKeyterms([])).toEqual([])
})

test('Deepgram URL: required params + url-encoded keyterms', () => {
  const u = buildDgUrl('wss://api.deepgram.com', ['api', 'ml train', 'c++&x'])
  expect(u.startsWith('wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&punctuate=true')).toBe(true)
  expect(u).toContain('&keyterm=api&keyterm=ml%20train&keyterm=c%2B%2B%26x')
  expect(buildDgUrl('ws://localhost:8796/', [])).toBe('ws://localhost:8796/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&punctuate=true')
})

const START: DictEvent = { t: 'start', canDictate: true, hasKey: true }
function walk(events: DictEvent[], from: DictPhase = 'idle') {
  let p = from
  const fx: string[] = []
  for (const e of events) { const r = dictStep(p, e); p = r.phase; fx.push(...r.fx) }
  return { p, fx }
}

test('state machine: happy paths', () => {
  expect(walk([START, { t: 'stop' }, { t: 'final', transcript: 'hi' }, { t: 'send' }])).toEqual({ p: 'idle', fx: ['beginListen', 'finalize', 'showConfirm', 'send'] })
  expect(walk([START, { t: 'stop' }, { t: 'final', transcript: 'hi' }, { t: 'cancel' }])).toEqual({ p: 'idle', fx: ['beginListen', 'finalize', 'showConfirm', 'abort'] })
  const redo = walk([START, { t: 'stop' }, { t: 'final', transcript: 'hi' }, { t: 'redo' }])
  expect(redo).toEqual({ p: 'listening', fx: ['beginListen', 'finalize', 'showConfirm', 'beginListen'] })
})

test('state machine: no key, cannot dictate, empty transcript, ignored events', () => {
  expect(walk([{ t: 'start', canDictate: true, hasKey: false }])).toEqual({ p: 'idle', fx: ['noKey'] })
  expect(walk([{ t: 'start', canDictate: false, hasKey: true }])).toEqual({ p: 'idle', fx: [] })
  expect(walk([START, { t: 'stop' }, { t: 'final', transcript: '  ' }])).toEqual({ p: 'idle', fx: ['beginListen', 'finalize', 'empty'] })
  expect(walk([START, START])).toEqual({ p: 'listening', fx: ['beginListen'] }) // second press while listening
  expect(walk([START, { t: 'stop' }, { t: 'stop' }]).fx).toEqual(['beginListen', 'finalize'])
  expect(walk([{ t: 'stop' }, { t: 'send' }, { t: 'final', transcript: 'x' }, { t: 'redo' }])).toEqual({ p: 'idle', fx: [] })
  expect(walk([START, { t: 'final', transcript: 'x' }]).p).toBe('listening') // final before release is ignored
  expect(walk([START, { t: 'send' }]).p).toBe('listening')
})

test('state machine: error and leave paths end idle from every phase and abort', () => {
  for (const from of ['listening', 'finalizing', 'confirm'] as DictPhase[]) {
    expect(dictStep(from, { t: 'error' })).toEqual({ phase: 'idle', fx: ['abort', 'error'] })
    expect(dictStep(from, { t: 'leave' })).toEqual({ phase: 'idle', fx: ['abort'] })
    expect(dictStep(from, { t: 'cancel' })).toEqual({ phase: 'idle', fx: ['abort'] })
  }
  expect(dictStep('idle', { t: 'error' })).toEqual({ phase: 'idle', fx: [] })
  expect(dictStep('idle', { t: 'leave' })).toEqual({ phase: 'idle', fx: [] })
})
