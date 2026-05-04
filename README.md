# Mobile Harness

Android-first local developer harness for attaching agents and CLI workflows to mobile devices running the Classology Capacitor app.

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
- shared core types and backend contract
- shared session operations used by both CLI and MCP
- CLI entrypoint
- iOS backend stub
- MCP server with bounded agent-facing read tools

Run:

```bash
bun run mobile-harness devices list
bun run mobile-harness session attach --platform android --device <serial> --app ai.classology.app --launch
bun run mobile-harness logs tail --session <session-id>
bun run mobile-harness screenshot --session <session-id>
bun run mobile-harness webviews list --session <session-id>
bun run mobile-harness webviews screenshot --session <session-id> --target <target-id>
bun run mobile-harness js eval --session <session-id> --target <target-id> --expression "document.title"
bun run mobile-harness console tail --session <session-id> --target <target-id>
bun run mobile-harness network tail --session <session-id> --target <target-id>
```

Run MCP:

```bash
bun run mobile-harness:mcp
```

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

The MCP surface intentionally exposes bounded `read_*` tools for logs, console, and network instead of open-ended tails. That keeps tool calls deterministic for agents while the CLI remains the live streaming interface.
