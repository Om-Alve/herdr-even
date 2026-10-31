# herdr-even

An Even G2 companion for Herdr. It shows pane activity and agent transcripts on the glasses, and sends text, key presses, and voice dictation back to the selected pane.

The project has three packages:

- `packages/plugin`: the Even Hub app for the glasses and phone
- `packages/bridge`: a local bridge between Herdr and the app
- `packages/protocol`: shared WebSocket message types

The bridge reads transcripts from Claude Code, Codex, Cursor, OpenCode, and Pi. Queued messages for panes with an agent session ID are saved to a private file in the bridge config directory. After a restart, the bridge sends them only if that pane still belongs to the same agent session.

## Set up

1. Install [Bun](https://bun.sh/) and run `bun install` at the repository root.
2. Configure Herdr and start it on each machine you want to use.
3. Configure and run the bridge using [the bridge guide](packages/bridge/README.md). Keep its listener on loopback and set its `owner` to your Tailscale login.
4. Copy `packages/plugin/.env.example` to `packages/plugin/.env` and set `VITE_BRIDGE_ORIGINS` to your own bridge URLs.
5. In `packages/plugin`, run `bun run pack` to build an Even Hub package. Install a private build through Even Hub.

The plugin's generated `app.json`, local `.env`, binaries, and packaged builds are excluded from Git. Enter a Deepgram key in the phone settings if you use dictation; a build-time key would be embedded in the app bundle.

## Test

Run `bun test` in `packages/plugin` and `packages/bridge`. Run `bun run typecheck` in each package.
