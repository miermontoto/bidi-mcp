# bidi-mcp

MCP server that connects Claude Code to a running Zen/Firefox browser via WebDriver BiDi protocol. Evaluates JS, captures screenshots, reads console logs, and navigates -- all on the user's live browser session.

## Requirements

- Node >= 22 (built-in WebSocket)
- Zen browser (or Firefox) launched with `--remote-debugging-port=9222`

## Tools

| Tool | Description |
|------|-------------|
| `evaluate` | Execute JS in a browser tab |
| `screenshot` | Capture PNG of a tab |
| `navigate` | Go to a URL |
| `reload` | Reload current page |
| `tabs` | List open tabs with context IDs |
| `console_messages` | Get buffered console output (with level filter) |

All tools accept an optional `tab` parameter (browsing context ID from `tabs`). Defaults to the first tab.

## Setup

### 1. Install dependencies

```bash
cd ~/dev/bidi-mcp
pnpm install
```

### 2. Launch the browser with remote debugging

```bash
zen-browser --remote-debugging-port=9222
# or for Firefox:
# firefox --remote-debugging-port=9222
```

Add the flag to your launcher/desktop entry for convenience.

### 3. Register the MCP server

**HTTP mode (recommended)** -- shared across multiple Claude Code instances:

```bash
node server.mjs --http 3100
claude mcp add -s user --transport http zen http://127.0.0.1:3100/mcp
```

**stdio mode** -- one server per Claude Code instance:

```bash
claude mcp add -s user zen -- node /path/to/server.mjs
```

Only one mode should be active at a time since the browser allows a single BiDi session.

### 4. Optional: auto-start the HTTP daemon

Copy `bidi-mcp.service` to `~/.config/systemd/user/` and enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now bidi-mcp.service
```

The service uses `start.sh` which resolves the Node binary via fnm.

### 5. Verify

```bash
claude mcp list   # should show zen as connected
```

## Known issues

**Cloudflare captchas fail.** The BiDi session flags the browser as automated (`navigator.webdriver = true`). Handle captcha pages manually.

**Dead keys / compose keys break (tildes, accents).** The BiDi session sets `focusmanager.testmode=true`, which disables dead key composition. Fix by adding this to `user.js` in every browser profile directory:

```js
user_pref("focusmanager.testmode", false);
```

The included `zen-debug.sh` launcher does this automatically before starting the browser.

**Orphan sessions.** If you see "Maximum number of active sessions", restart the browser. This happens when the MCP server disconnects without calling `session.end` (e.g. crash, `kill -9`).

## Architecture

```
Claude Code --HTTP--> bidi-mcp (port 3100) --WebSocket--> Browser (port 9222/session)
                      [MCP protocol]                      [WebDriver BiDi protocol]
```

The server lazily connects on the first tool call, creates a BiDi session (`session.new`), subscribes to console events, and keeps the WebSocket open. On shutdown it ends the session cleanly (`session.end`) to prevent orphans.

## Files

| File | Purpose |
|------|---------|
| `server.mjs` | MCP server (single file, both stdio and HTTP modes) |
| `start.sh` | Launcher that resolves Node >= 22 via fnm |
| `zen-debug.sh` | Browser launcher with dead key fix + remote debugging flag |
| `bidi-mcp.service` | systemd user service for auto-starting the HTTP daemon |
