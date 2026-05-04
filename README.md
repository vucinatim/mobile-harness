# Mobile Harness

Android-first local developer harness for attaching agents and CLI workflows to mobile devices running the Classology Capacitor app.

Current scaffold status:

- Android device discovery via `adb`
- Android session attach with install validation and optional app launch
- Android `logcat` tailing for attached sessions
- Android device screenshot capture
- shared core types and backend contract
- CLI entrypoint
- iOS backend stub
- MCP server stub

Run:

```bash
bun run mobile-harness devices list
bun run mobile-harness session attach --platform android --device <serial> --app ai.classology.app --launch
bun run mobile-harness logs tail --session <session-id>
bun run mobile-harness screenshot --session <session-id>
```
