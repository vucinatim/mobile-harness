# Canonical Timeline Plan

## Goal

Use one simple default:

- attach a session
- use the app
- ask the harness what just happened

The canonical system should be:

- always on
- bounded
- readable
- session-scoped
- the same for humans and agents

## Problem With The Current Shape

The current event pipeline works, but it is not the right default UX.

Requiring the model or the user to remember an explicit recorder lifecycle adds unnecessary operator overhead.

is too manual and easy to get wrong.

That makes the tool feel flaky even when the underlying event capture is working.

The correct default is a rolling per-session timeline that is already collecting by the time the interesting thing happens.

## Product Decision

The happy path should be:

1. `session attach`
2. timeline buffering starts automatically
3. user or agent interacts with the app
4. agent calls `timeline read`
5. optional `timeline mark` if the user wants a precise anchor

That means:

- `timeline read` is the primary read surface
- `timeline mark` stays optional
- `timeline reset` replaces manual stop/start loops

## Core Model

Each attached session owns one rolling timeline.

The timeline continuously buffers:

- native app logs
- WebView console events
- WebView network events
- harness actions
- optional summary UI snapshots at key points

This buffer is bounded and rotates automatically.

The user and model should think in terms of:

- "recent session history"
- not "special recording runs"

## Design Principles

### One canonical path

The main interface should not branch between multiple operator workflows.

There should be one normal debugging path:

- attach
- inspect current UI
- read recent timeline

### Rolling, not endless

We do not need a giant permanent archive.

We need a useful rolling window that is always fresh and safe to read.

### Summary first

The timeline read path should default to a compact summary.

The agent should not need to parse huge raw logs unless it explicitly asks for detail.

### Manual controls are secondary

Manual controls should still exist, but as maintenance tools:

- `timeline mark`
- `timeline reset`
- `timeline export`
- maybe `timeline pause` later

Not as required setup steps.

### Reuse current capture paths

Do not build a second capture system.

The canonical timeline should reuse:

- existing native log capture
- existing CDP console capture
- existing CDP network capture
- existing UI action hooks

## Minimal Robust Architecture

## Session-owned timeline state

For each attached session:

- create one timeline state file
- create one append-only timeline event file
- create raw stream artifacts only if we decide they add value

The timeline becomes part of session lifecycle, not a separate recording lifecycle.

## Storage boundary

Runtime timeline data should live in the consuming project, not in the package repo.

That means the canonical storage root is:

- `<consumer-project>/.mobile-harness/`

not:

- `<mobile-harness-package>/.mobile-harness/`

This boundary is important because:

- logs, sessions, and artifacts belong to the app being debugged
- multiple projects should be able to use the same package without colliding
- the package repo should remain clean and reusable
- local artifact paths should make sense relative to the app project

The intended layout in the consuming project is:

```txt
.mobile-harness/
  sessions/
  artifacts/
  timeline/
    <session-id>/
      state.json
      timeline.jsonl
```

Optional later additions, only if they solve a real problem:

- `native.log`
- `console.jsonl`
- `network.jsonl`

But `timeline.jsonl` should remain the canonical structured store.

## Worker lifecycle

Workers should start automatically on session attach.

That means:

- one native log worker per session
- one console worker per session when a target is available
- one network worker per session when a target is available

If the WebView target is not available yet:

- native logging should still start
- WebView workers should attach lazily once a target appears

This avoids making target discovery a hard blocker for the entire timeline.

## Bounded storage

Use bounded rolling storage.

Minimal first approach:

- append all events to `timeline.jsonl`
- maintain a bounded logical read window in code
- optionally compact on session attach or reset

Do not rewrite the file on every append.

That causes avoidable concurrency issues.

If later needed, add periodic compaction, not per-event compaction.

## Canonical CLI Surface

The default surface should become:

```bash
mobile-harness session attach --platform android --device <serial> --app <appId>
mobile-harness timeline read [--session <id>] [--since-marker <label>] [--last <n>] [--detail summary|standard|full]
mobile-harness timeline mark [--session <id>] --label <text>
mobile-harness timeline reset [--session <id>]
mobile-harness timeline status [--session <id>]
```

Optional later:

```bash
mobile-harness timeline export [--session <id>] --output <path>
```

## MCP Surface

The MCP surface should mirror the same mental model:

- `mobile_timeline_read`
- `mobile_timeline_mark`
- `mobile_timeline_reset`
- `mobile_timeline_status`

Do not make agents manage a separate recorder lifecycle in the normal path.

## Event Model

Keep the current event kinds:

- `action`
- `marker`
- `console`
- `network`
- `nativeLog`
- `uiSnapshot`
- `screenshot`
- `error`

This model is already good enough.

The main change is lifecycle and surface, not event taxonomy.

## Read Model

## Default read

`timeline read` should return a compact summary by default:

- session id
- target id if present
- active workers
- markers in scope
- recent actions
- high-signal errors
- warnings
- failed network requests
- count of suppressed events

That should be the normal agent payload.

## Detail levels

Keep:

- `summary`
- `standard`
- `full`

### `summary`

Short, high-signal, model-friendly.

### `standard`

Ordered event list with concise event entries.

### `full`

Raw event payloads and artifact paths.

## Markers

Markers stay useful, but optional.

Their role is:

- user says "I just tapped confirm"
- harness inserts `timeline mark --label before-confirm`
- agent reads relative to that marker

They should not be mandatory for ordinary “what just happened” reads.

## Reset semantics

`timeline reset` should be the main way to clear noise before a fresh repro.

That is better than:

- stop
- start

because it preserves the canonical always-on model.

`timeline reset` should:

- clear current timeline events
- preserve session identity
- restart or refresh workers if needed
- optionally insert a reset marker

## Session attach behavior

Session attach should be the canonical bootstrap point.

On `session attach`:

1. create session state
2. initialize empty rolling timeline if none exists
3. start timeline workers automatically
4. try to resolve current WebView target
5. if unavailable, keep retry path lightweight and lazy

This keeps the system simple:

- attached session means timeline is live

## Target handling

This is where robustness matters.

The system must not assume the WebView target is always ready at attach time.

So:

- native logging starts immediately
- WebView event workers start when a target is known
- target refresh can happen when:
  - `ui snapshot`
  - `timeline read`
  - explicit `webviews list`
  - or a small internal retry path

Avoid an always-running aggressive polling loop.

Minimal and proper beats “clever”.

## Raw files

The timeline should remain the main read surface.

But raw underlying files are still useful as secondary artifacts.

If we keep them, use:

- `timeline.jsonl` as canonical structured store
- optional `native.log`, `console.jsonl`, `network.jsonl` later only if they solve a real problem

Do not make a giant single raw log file the main interface.

That would push filtering burden back onto the model.

## Implementation Shape

The final public interface should be:

- attach implicitly starts the timeline
- `timeline status`
- `timeline read`
- `timeline mark`
- `timeline reset`

There should be no separate public `record *` lifecycle.

## Validation Plan

The final workflow must validate like this:

1. attach session
2. use the app manually
3. run `timeline read --last 100`
4. run `timeline mark --label before-confirm`
5. reproduce a problem
6. run `timeline read --since-marker before-confirm`

Success means:

- no explicit start was required
- recent actions are visible
- marker is preserved
- summary is readable
- workers stay alive
- the same path works from:
  - standalone package repo
  - consuming app repo
  - MCP

## Non-goals For This Refactor

Do not expand scope into:

- video recording
- native UI automation
- iOS parity
- database-backed storage
- full-text search system

The point is to simplify the product path, not broaden the product.

## Recommended Next Step

Refactor the current implementation into this shape with the smallest safe changes:

1. automatic timeline startup on `session attach`
2. new `timeline` CLI and MCP surface
3. `timeline reset` instead of manual stop/start
4. update docs to present `timeline *` as the only public workflow

That gives us the robust minimal system we actually want without throwing away the working event pipeline we already built.
