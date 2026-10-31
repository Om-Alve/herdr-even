import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const sdkVersion = JSON.parse(readFileSync('node_modules/@evenrealities/even_hub_sdk/package.json', 'utf8')).version

export default defineConfig({
  // 5192: 5173, 5190 and 5191 are taken on the dev machine
  server: { host: true, port: Number(process.env.PORT ?? 5192), strictPort: true },
  build: { target: 'esnext' },
  define: { __SDK_VERSION__: JSON.stringify(sdkVersion) },
})
