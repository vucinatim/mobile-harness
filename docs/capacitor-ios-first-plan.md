# Capacitor-First iOS Plan

## Goal

Make iOS a clean, low-friction developer path for **our own Capacitor apps**.

The primary iOS debugging stack should be:

- device attach
- app launch
- screenshots
- native logs
- app-owned console events
- app-owned network events
- canonical timeline reads

This is a shift in **backend strategy**, not a new product.

The public `mobile-harness` surface should stay shared with Android.

## Why Switch

The original iOS direction leaned too hard on:

- WebDriverAgent / XCTest ownership
- Apple Web Inspector quirks
- Python wrapper behavior we do not control

That path produced:

- weak observability
- unstable automation
- phone freezes
- too much complexity for too little signal

For Capacitor apps we own, there is a much cleaner option:

- instrument the WKWebView ourselves
- emit structured signals from the app
- reuse the existing native-log and timeline architecture

## Product Position

`mobile-harness` is a **developer tool for first-party Capacitor apps**.

That means we should optimize for:

- reliability over universality
- low setup friction
- deterministic app signals
- minimum unsafe phone-side control

We do **not** need to optimize first for arbitrary third-party iOS apps.

## Core Principles

### Same product, different iOS internals

CLI, MCP tools, timeline format, and session model stay shared.

The iOS implementation can differ under the hood if that makes the tool safer and simpler.

### App-owned observability beats remote inspection

If the app can emit structured debug data itself, prefer that over remote inspector hacks.

### One command setup

Users should not hand-edit Swift, storyboard files, or Xcode project wiring.

The package should productize the integration.

### Idempotent setup

Running setup multiple times should be safe.

### Canonical timeline is the source of truth

All useful debugging output should land in `.mobile-harness/timeline/...`.

## Target UX

### First-time setup

From the Capacitor app repo:

```bash
mobile-harness setup capacitor ios
```

This should:

- detect a Capacitor iOS shell
- install or update the minimal native bridge
- wire the custom bridge controller into the app shell
- verify the Xcode project includes the required files
- explain exactly what changed

Optional host bootstrap remains separate:

```bash
mobile-harness setup ios
```

That covers machine-level requirements like tunnel support for screenshots and native logs.

### Normal daily use

```bash
mobile-harness session attach --platform ios --device <udid> --app <bundle-id> --launch
mobile-harness timeline status --session <id>
mobile-harness timeline read --session <id>
```

No manual Web Inspector commands.
No custom Python steps for the main debugging path.

## Proposed iOS Architecture

## Layer 1: Host capabilities

Still use host-side iOS support for:

- device discovery
- app install validation
- app launch
- screenshots
- native syslog capture

This remains the correct place for:

- `devicectl`
- `pymobiledevice3` tunnel-backed screenshot/syslog support

## Layer 2: Capacitor WKWebView bridge

Add a tiny dev-only native bridge in the iOS shell that:

- injects a startup script into the main WKWebView
- captures:
  - `console.log`
  - `console.info`
  - `console.warn`
  - `console.error`
  - `console.debug`
  - `fetch`
  - `XMLHttpRequest`
- posts structured messages to native
- logs those messages with a stable harness prefix

This bridge should be:

- small
- explicit
- versioned
- easy to reinstall

## Layer 3: Timeline synthesis

`mobile-harness` should recognize the structured bridge log lines and convert them into real:

- `console` timeline events
- `network` timeline events

The timeline should not treat these as opaque native text.

## Layer 4: Optional fallback paths

These remain fallback / experimental only:

- WebInspector
- remote CDP bridges
- WDA/XCTest-heavy native automation

They should not be required for normal Capacitor debugging.

## Setup Design

## `mobile-harness setup capacitor ios`

This command should:

1. Detect a Capacitor iOS app layout.
2. Verify required files exist:
   - `native/ios/.../App.xcodeproj`
   - storyboard entrypoint
   - Capacitor bridge controller usage
3. Install bridge files if missing.
4. Update existing bridge files if an older managed version is present.
5. Wire the custom bridge controller into the storyboard or equivalent entrypoint.
6. Ensure the Swift file is included in the Xcode project.
7. Print a concise summary of changes.

### Idempotence rules

- If already installed and current, do nothing.
- If locally modified, fail clearly and explain the conflict.
- Prefer managed marker comments or stable generated blocks where useful.

## Runtime Capability Model

For Capacitor iOS apps with the bridge installed:

- `canReadLogs`: true
- `canCaptureScreenshot`: true
- `canReadConsole`: true
- `canReadNetwork`: true

This support is provided by:

- syslog for native logs
- native bridge synthesis for console/network

It is **not** dependent on Web Inspector.

## Timeline Model

The canonical timeline should contain:

- `nativeLog`
- `console`
- `network`
- `marker`
- `action`
- `error`

Expected behavior:

- JS console errors become real timeline `console` errors
- failed fetch/XHR requests become real timeline `network` failures
- native paywall / RevenueCat / Superwall signals still come through `nativeLog`

This gives one place to reconstruct a flow like:

1. user taps `Upgrade to Pro`
2. JS handler fires
3. request starts
4. request fails or succeeds
5. native SDK logs follow

## What To Instrument

The first bridge version should capture only high-value signals:

- console calls
- fetch request / response / failure
- XHR request / response / failure

After that, optionally add:

- route/screen markers
- app boot marker
- unhandled promise rejections
- `window.onerror`
- explicit paywall trigger markers
- explicit Superwall result markers

Do not front-load large instrumentation surfaces.

## Phase Plan

## Phase 1: Productize native bridge install

Deliverables:

- `mobile-harness setup capacitor ios`
- bridge template assets in the package
- project/storyboard wiring logic
- install verification

Acceptance:

- a Capacitor app repo can be prepared with one command
- rerunning the command is safe

## Phase 2: Promote bridge logs into timeline events

Deliverables:

- stable bridge log prefix/protocol
- structured parsing in timeline ingestion
- real `console` and `network` event synthesis

Acceptance:

- bridge messages show up as first-class timeline events
- not as raw native noise

## Phase 3: Real-device validation in Classology

Deliverables:

- rebuild iOS app with the bridge
- reproduce `Upgrade to Pro`
- confirm canonical timeline shows:
  - JS console signals
  - request lifecycle
  - native paywall / RevenueCat / Superwall logs

Acceptance:

- we can explain why the button did or did not work from the timeline alone

## Phase 4: Capability cleanup

Deliverables:

- iOS capability reporting reflects the new bridge path
- docs and README updated to present Capacitor-first iOS as the primary workflow

Acceptance:

- no ambiguity about how iOS console/network capture works

## Phase 5: Quarantine brittle fallback paths

Deliverables:

- clearly label WebInspector/WDA as fallback or experimental
- remove them from the default developer path

Acceptance:

- normal iOS usage no longer depends on unsafe or flaky automation

## Non-Goals

- Do not make generic third-party iOS app inspection the primary goal.
- Do not make WDA the default iOS path again.
- Do not require manual native file editing as the standard user flow.
- Do not split the product into separate “Capacitor mode” and “generic iOS mode” CLIs.

## Open Questions

1. Should the bridge be enabled only in `DEBUG`, or also in signed dev builds with an explicit config flag?
2. Should bridge events include a protocol version field from day one?
3. Should setup patch the existing app shell directly, or install a tiny Capacitor plugin that owns the bridge?

## Recommendation

Recommendation today:

- enable bridge only for dev/debug builds
- add a versioned payload shape early
- start with direct app-shell wiring because it is smaller and clearer
- later, if multiple apps adopt it, factor the bridge into a reusable Capacitor plugin owned by `mobile-harness`

## Success Criteria

We should consider the switch successful when:

- a Capacitor iOS app can be prepared with one setup command
- the phone stays stable during normal harness use
- `console` and `network` events appear in the canonical timeline
- the team can debug real flows like `Upgrade to Pro` without relying on brittle remote-inspector hacks
