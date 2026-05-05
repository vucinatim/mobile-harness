# Capacitor-First iOS Control Plan

## Goal

Add a **safe iOS control contract** for first-party Capacitor apps that matches the Android-facing `mobile-harness` API shape without relying on WDA/XCTest as the default backend.

The key outcome is:

- keep the same high-level commands agents already expect
- make iOS control work through the app-owned bridge we control
- avoid unsafe whole-phone automation on a primary device

This plan is specifically for **our own Capacitor apps**, not arbitrary third-party iOS apps.

## What We Already Have

The iOS Capacitor bridge now gives us:

- device attach
- app launch
- screenshots
- native logs
- canonical `console` timeline events
- canonical `network` timeline events

That means **observability is now real**.

What is still missing is **safe control**.

## Problem

Today iOS and Android are asymmetric:

- Android has observability and a usable control contract
- iOS has observability, but control is still either missing or tied to the unsafe WDA/XCTest path

The old iOS control path froze the phone because it tried to take ownership of the device at the XCTest/WDA layer.

That is the wrong abstraction for a Capacitor-first developer tool.

## Design Principle

The public contract should stay shared.

The backend should differ.

That means we still want the same ideas:

- `ui snapshot`
- `ui click`
- `ui type`
- `ui wait-for`

But on iOS, those should be backed by the **webview/app bridge** first, not by phone-level automation.

## Proposed Control Architecture

## Layer 1: App-owned command bridge

Extend the managed iOS bridge so the app can receive structured control commands from `mobile-harness`.

The bridge should support a tiny command protocol:

- `snapshot`
- `click`
- `type`
- `focus`
- `waitFor`
- `route`

This should be implemented inside the WKWebView context and routed through native only as a transport boundary.

## Layer 2: DOM-first control

For Capacitor apps, the default control backend should be DOM-first.

That means:

- query visible DOM
- identify actions by text, role, attributes, and simple selectors
- dispatch real DOM clicks and input events
- return structured results

This is the correct first path because the UI is fundamentally app web content running inside the WKWebView.

## Layer 3: Minimal native escape hatches

Some app flows will not be fully reachable through DOM control alone.

Only then should we add narrow native hooks, for example:

- file picker test input
- camera test trigger
- native paywall/purchase visibility markers

These should be explicit app-owned hooks, not generic phone puppeteering.

## Layer 4: Experimental fallback

Keep WDA/XCTest or other phone-level automation behind an explicit experimental boundary only.

It should not be the default iOS control backend for real devices.

## Public API Goal

The external `mobile-harness` surface should converge on:

- `ui snapshot`
- `ui click`
- `ui type`
- `ui wait-for`

These commands should work cross-platform, but internally they can route differently:

- Android: current Android backend
- iOS: Capacitor bridge backend

The user and agent should not need a different mental model.

## Phase 1

Define the safe control protocol.

Add a small, versioned message contract between harness and the managed iOS bridge for:

- request id
- command kind
- payload
- result
- error

Acceptance:

- protocol documented
- request/response transport implemented
- one no-op command roundtrip proven on the real app

## Phase 2

Implement `ui snapshot` through the bridge.

This should return a structured webview snapshot suitable for agent use:

- current route/url
- title/screen label
- visible text blocks
- actionable elements
- inputs
- overlays

Acceptance:

- `ui snapshot` works on real iPhone through the bridge
- output is useful for tabs, forms, and paywall screens
- no WDA/XCTest involvement

## Phase 3

Implement `ui click`.

Priority order for matching:

1. explicit selector/id
2. visible text
3. role + text
4. fallback stable locator

The bridge should dispatch real DOM click behavior and return whether the action matched and fired.

Acceptance:

- navigate app tabs on real iPhone
- open chat/history/profile from the harness
- no phone freeze or device-wide automation state

## Phase 4

Implement `ui type`.

This should:

- locate input/textarea/contenteditable targets
- focus them
- set value safely
- dispatch the right input/change events

Acceptance:

- type into a real chat field
- submit a real message through the app
- resulting network and console events appear in the timeline

## Phase 5

Implement `ui wait-for`.

This should poll bridge snapshots, not raw phone automation state.

Support:

- text present
- selector present
- route matches
- network idle or specific request seen

Acceptance:

- wait for screen changes after tab clicks
- wait for chat submission completion
- wait for paywall-related transitions

## Phase 6

Add narrow native test hooks only where web control is insufficient.

Examples:

- camera test trigger
- synthetic file attach
- explicit native purchase/debug markers

These should be:

- dev-only
- explicit
- minimal

Acceptance:

- test a photo flow without whole-phone automation
- keep hooks clearly scoped and removable

## Validation Strategy

Every phase must be validated on the connected real iPhone.

Validation should use actual app flows, not synthetic toy screens.

Recommended progression:

1. tabs
2. history/profile navigation
3. chat input and submit
4. payment/paywall trigger
5. camera or file flow

## What We Should Not Do

- do not rebuild the iOS path around WDA again
- do not add broad retries around unsafe automation ownership
- do not treat screenshots/logs as if they imply control parity
- do not add app-specific hacks when a generic Capacitor bridge command can solve it

## Success Criteria

This phase is done when:

- iOS supports the same high-level control contract as Android
- control works through the Capacitor bridge backend
- the real iPhone remains fully usable while idle
- chat/tab/payment flows can be driven without device-level automation ownership

## Immediate Next Step

Implement Phase 1:

- define the bridge control request/response protocol
- prove one real command roundtrip from harness to app and back

That is the smallest safe step toward true iOS control parity.
