// Generates app.json from .env (VITE_BRIDGE_ORIGINS): the network whitelist is exactly the bridge origins.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const env = {}
for (const f of ['.env', '.env.local']) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const origins = (process.env.VITE_BRIDGE_ORIGINS ?? env.VITE_BRIDGE_ORIGINS ?? '')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
const whitelist = [...new Set([...origins, 'https://api.deepgram.com', 'wss://api.deepgram.com'])]
// One version to bump per release: package.json's (Even Hub rejects re-uploading an existing version).
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const app = {
  package_id: 'com.herdreven.glasses',
  edition: '202601',
  name: 'herdr-even',
  version,
  min_sdk_version: '0.0.16',
  entrypoint: 'index.html',
  permissions: [
    { name: 'network', desc: 'Reach the herdr-even bridge on each of your machines over your tailnet, and Deepgram for voice dictation.', whitelist },
    { name: 'g2-microphone', desc: 'Capture the glasses microphone for voice dictation.' },
  ],
  supported_languages: ['en'],
}
writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n')
console.log('app.json written; whitelist =', whitelist.join(', '))
