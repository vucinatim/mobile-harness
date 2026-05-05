# iOS Harness Phased Plan

## Goal

Bring iOS to the same public harness surface as Android:

- `session attach`
- `logs`
- `screenshot`
- `ui snapshot`
- `ui inspect`
- `ui click`
- `ui type`
- `ui clear`
- `ui press`
- `ui read`
- `ui wait-for`
- `timeline status`
- `timeline mark`
- `timeline read`
- `timeline reset`
- matching MCP tools and output shapes

This is not a separate iOS product.

It is the same harness product with an iOS backend implementation behind the existing interface.

## Product Principles

### Same API, platform-specific internals

The CLI, MCP tools, storage, and agent mental model should remain shared.

The iOS implementation can differ internally where the platform requires it.

### Real-device validation after every phase

Every phase must end with a real test on the connected iPhone inside the real app.

No phase is complete based on code alone.

### Payment flow as the acceptance test

The primary validation scenario is the real subscription flow in Classology:

1. attach to the iPhone
2. navigate to Profile
3. trigger `Upgrade to Pro`
4. inspect what happened
5. improve the harness only where the real flow exposes a gap

### Keep the first implementation minimal

Do not build speculative abstractions or iOS-only product surfaces.

Add only the internal capability required to make the shared commands work well.

## Non-Goals

- Do not invent a second iOS-specific CLI.
- Do not diverge the MCP surface for iOS.
- Do not front-load deep WebKit automation if native device automation is not stable yet.
- Do not chase simulator-first support before physical-device support is solid.

## Constraints

The current package already exposes the target public surface.

The current missing piece is almost entirely `ios/backend.ts`.

The first implementation should assume:

- physical iPhone first
- locally connected development device
- developer machine has Xcode command-line tools available

## Likely Backend Building Blocks

These are the most likely low-level tools we will need under the hood:

- `xcrun xcdevice list`
- `xcrun devicectl`
- `xcrun simctl` later for simulator support if useful
- `idevicesyslog` only if needed and available
- WebKit inspection hooks later, only after core device automation is working

The exact commands can change, but the public surface should not.

## Phase Plan

## Phase 1: Device Discovery And Session Attach

### Goal

Make `devices list`, `session attach`, `get capabilities`, and timeline auto-start work on a real iPhone.

### Deliverables

- `ios/backend.ts` implements:
  - `listDevices()`
  - `createSession()`
  - `getCapabilities()`
- iPhone appears in:
  - CLI `devices list`
  - MCP `mobile_list_devices`
- `session attach --platform ios --device <id> --app <bundleId>` works
- timeline directory is created in the consuming app repo under:
  - `.mobile-harness/timeline/<session-id>/`

### Scope

This phase does not require working screenshots or UI automation yet.

It only establishes the session lifecycle cleanly.

### Validation

Run against the real connected iPhone:

1. `devices list --platform ios`
2. `session attach --platform ios --device <id> --app ai.classology.app`
3. `timeline status --session <id>`
4. `mobile_list_devices`
5. `mobile_attach_session`

Acceptance:

- device is discoverable
- session attaches successfully
- app install presence is validated
- timeline starts automatically

## Phase 2: Device Screenshot Capture

### Goal

Make `screenshot` work on the real iPhone.

### Deliverables

- `captureScreenshot()` implemented for iOS
- screenshots saved into consuming app artifacts storage
- same artifact shape as Android

### Scope

This is device-level only, not WebView-level screenshotting yet.

### Validation

In the real app:

1. open Profile
2. run `screenshot --session <id>`
3. inspect the saved image
4. navigate to paywall or another screen
5. run it again

Acceptance:

- saved screenshot is current, readable, and correctly oriented
- artifacts land in `.mobile-harness/artifacts/...`

## Phase 3: Native Log Capture Into The Rolling Timeline

### Goal

Make the always-on timeline useful on iOS even before WebKit support exists.

### Deliverables

- `tailLogs()` implemented for iOS
- native logs stream into `timeline.jsonl`
- `timeline read` returns readable summaries
- errors and warnings are normalized reasonably

### Scope

This phase prioritizes reliable app-adjacent logs over perfect completeness.

If multiple logging mechanisms are possible, choose the cleanest one that works reliably on the physical device.

### Validation

In the real app:

1. attach a session
2. use the app manually
3. mark the timeline
4. trigger `Upgrade to Pro`
5. read the timeline window

Acceptance:

- timeline shows native events after the marker
- the agent can answer “what just happened?” from the timeline

## Phase 4: Minimal Native UI Snapshot

### Goal

Make `ui snapshot` work on iOS through native accessibility data, even if the first version is summary-first.

### Deliverables

- `snapshotUi()` implemented for iOS
- output matches the shared `UiSnapshot` shape
- first version should support at least:
  - screen/title approximation
  - primary actions
  - inputs
  - overlays
  - `canGoBack`
  - `blockingMessage`

### Scope

Do not try to perfectly reproduce Android WebView DOM semantics.

The priority is a stable, agent-usable summary in the shared shape.

### Validation

In the real app:

1. snapshot on Profile
2. snapshot on the paywall
3. snapshot after dismissing the paywall

Acceptance:

- summary is readable
- key buttons and overlays are present
- result is useful enough for the agent to choose the next action

## Phase 5: Native UI Targeting And Actions

### Goal

Make the shared action surface work on iOS:

- `ui inspect`
- `ui click`
- `ui type`
- `ui clear`
- `ui press`
- `ui read`

### Deliverables

- selector matching adapted for iOS accessibility snapshots
- action methods implemented
- action recording feeds the timeline like Android

### Scope

Start with the selectors that matter most for the real app:

- `elementId`
- `text`
- `name`
- `placeholder`
- `role`

Only add extra selector complexity if the real payment flow needs it.

### Validation

In the real app:

1. navigate tabs
2. open Profile
3. tap `Upgrade to Pro`
4. dismiss paywall
5. type into a real input somewhere in the app

Acceptance:

- taps are reliable
- selector matching is understandable
- timeline records the actions

## Phase 6: Waits And Stability Layer

### Goal

Make `ui wait-for` reliable enough for repeated real-device flows.

### Deliverables

- `waitForUi()` implemented
- sensible polling strategy
- timeout and interval handling
- snapshot-on-timeout or similar useful failure context

### Scope

This phase is about reducing flakiness, not adding features.

### Validation

In the real app:

1. wait for Profile to load
2. wait for paywall to appear
3. wait for paywall dismissal
4. validate timeout behavior on a deliberately wrong target

Acceptance:

- waits succeed on real transitions
- timeout behavior is readable and actionable

## Phase 7: iOS Payment Flow Validation Pass

### Goal

Use the now-parity harness to validate the real iOS subscription flow end to end.

### Validation Scenario

1. attach session
2. timeline mark
3. `ui snapshot` on Profile
4. `ui click` on `Upgrade to Pro`
5. `ui wait-for` paywall
6. `ui snapshot` paywall
7. proceed through sandbox purchase
8. inspect timeline
9. verify app debug state and backend subscribed state

Acceptance:

- the same harness surface can diagnose the real iOS payment flow
- the agent can explain failures from screenshots, UI state, and timeline reads

## Phase 8: WebKit And Deeper Inspection

### Goal

Only if still needed after the payment validation pass, add deeper iOS WebKit-backed introspection to reach closer parity with Android WebView capabilities.

### Candidate Additions

- `listWebviews()`
- `attachWebview()`
- `evalJs()`
- `streamConsole()`
- `streamNetwork()`
- `captureWebviewScreenshot()`

### Scope

This phase should happen only if the native-first harness is not enough for real debugging.

If native snapshot plus timeline already solves the real product issues well, do not overbuild.

### Validation

Use a real app screen where deeper web content introspection materially improves debugging.

Acceptance:

- deeper WebKit capabilities are justified by real debugging value
- no public API drift from Android

## Phase 9: Polish And Hardening

### Goal

Make the iOS backend feel like a first-class peer to Android.

### Deliverables

- robust error messages
- capability reporting reflects reality
- stable artifact naming
- improved selector diagnostics
- documentation updates
- MCP tool descriptions verified against iOS behavior

### Validation

Run a final parity checklist across CLI and MCP.

Acceptance:

- iOS feels like the same harness product
- the remaining gaps are explicit and intentional

## Real Validation Checklist

Every phase should record:

- exact device used
- exact app bundle id
- exact commands run
- whether validation happened through CLI, MCP, or both
- what failed
- what changed before retry

The bar is not “code compiles”.

The bar is “the command works on the real phone in the real app”.

## Recommended Initial Execution Order

Build and validate in this exact order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8 only if needed
9. Phase 9

This order keeps the system minimal while still converging on real parity.

## Definition Of Done

iOS is done when all of these are true:

- same public CLI surface as Android
- same MCP surface as Android where platform support is intended
- timeline works in the consuming app repo
- screenshots and UI actions work on the real iPhone
- the real iOS payment flow can be debugged effectively through the harness
- remaining platform differences live behind the backend boundary, not in the user-facing interface
