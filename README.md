# Mobile Harness

Android-first local developer harness for attaching agents and CLI workflows to hybrid mobile apps running on physical devices.

Current runtime requirement:

- Bun for the CLI and MCP entrypoints
- `adb` for Android device discovery, logs, screenshots, and DevTools socket forwarding

This package is intentionally Bun-native today. Publishing to npm is still straightforward, but consumers should expect a Bun runtime until the package is explicitly ported to Node.

Current scaffold status:

- Android device discovery via `adb`
- Android session attach with install validation and optional app launch
- Android `logcat` tailing for attached sessions
- Android device screenshot capture
- Android WebView target discovery via forwarded devtools socket
- Android JavaScript evaluation over CDP WebSocket
- Android WebView screenshot capture over CDP
- Android WebView console streaming over CDP
- Android WebView network streaming over CDP
- session-scoped rolling timeline with markers and buffered reads
- shared core types and backend contract
- shared session operations used by both CLI and MCP
- CLI entrypoint
- iOS backend stub
- MCP server with bounded agent-facing read tools

Install from GitHub today:

```bash
bun add -d github:vucinatim/mobile-harness
```

Planned npm package name:

```bash
vucinatim-mobile-harness
```

Run:

```bash
mobile-harness devices list
mobile-harness session attach --platform android --device <serial> --app com.example.app --launch
mobile-harness logs tail --session <session-id>
mobile-harness screenshot --session <session-id>
mobile-harness webviews list --session <session-id>
mobile-harness webviews screenshot --session <session-id> --target <target-id>
mobile-harness js eval --session <session-id> --target <target-id> --expression "document.title"
mobile-harness console tail --session <session-id> --target <target-id>
mobile-harness network tail --session <session-id> --target <target-id>
mobile-harness timeline mark --session <session-id> --label "before confirm and solve"
mobile-harness timeline read --session <session-id> --since-marker "before confirm and solve"
mobile-harness timeline reset --session <session-id>
mobile-harness timeline status --session <session-id>
```

Run MCP:

```bash
mobile-harness-mcp
```

Local development in another app repo:

```bash
cd /path/to/your-app
MOBILE_HARNESS_PATH=../mobile-harness bun run mobile-harness devices list
```

The cleanest consumer pattern is a thin wrapper script that prefers a local checkout when present and otherwise falls back to the installed package. That gives you instant updates during parallel development without committing machine-local link dependencies.

Example app-level scripts:

```json
{
  "scripts": {
    "mobile-harness": "bash scripts/mobile-harness.sh",
    "mobile-harness:mcp": "bash scripts/mobile-harness-mcp.sh"
  }
}
```

Publishing:

- The repo includes GitHub Actions CI on pushes and pull requests.
- npm publishing is set up as a tag-based workflow on `v*` tags.
- The intended npm package name is `vucinatim-mobile-harness`.
- To activate npm publishing, add an `NPM_TOKEN` repository secret in GitHub, then push a version tag such as `v0.1.0`.

Session attach automatically starts the rolling timeline for that session. Timeline data lives in the consuming project's `.mobile-harness/` directory, not in this package repo.

Current MCP tools:

- `mobile_list_devices`
- `mobile_attach_session`
- `mobile_get_capabilities`
- `mobile_capture_device_screenshot`
- `mobile_list_webviews`
- `mobile_eval_js`
- `mobile_capture_webview_screenshot`
- `mobile_read_logs`
- `mobile_read_console`
- `mobile_read_network`
- `mobile_timeline_status`
- `mobile_timeline_reset`
- `mobile_timeline_mark`
- `mobile_timeline_read`

The canonical debugging path is session attach plus the rolling timeline tools.

The MCP surface intentionally exposes bounded `read_*` tools for logs, console, and network instead of open-ended tails. That keeps tool calls deterministic for agents while the CLI remains the live streaming interface.
