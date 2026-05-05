# Suggestions

## Persistent iOS automation worker

The current iOS WDA path still pays too much cold-start cost per command and is also where most flakiness lives. The next high-impact refactor should keep one per-session iOS automation worker alive with:

- a persistent tunnel-backed service provider
- a persistent WDA client/session
- command-level timeouts and retries inside that worker
- a simple request/response transport from the CLI/backend layer

That would cut most of the current latency and remove the repeated session bring-up cost from `ui snapshot`, `ui click`, `ui type`, and `ui wait-for`.

## iOS Web Observability

For our own Capacitor apps, iOS web console/network capture should prefer a small native WKWebView debug bridge over Apple Web Inspector automation when the remote-inspector path proves brittle. A dev-only bridge can mirror structured `console` and `fetch`/`XMLHttpRequest` events into native logs, and the existing timeline can promote those records into first-class `console` and `network` events without taking risky phone-side automation ownership.

## Managed Capacitor bridge cleanup

Now that `mobile-harness setup capacitor ios` installs a generic managed bridge, we should add one explicit cleanup/migration pass for older app-specific bridge prototypes. The current installer correctly leaves unmanaged legacy files alone, but a future managed migration command should be able to detect a known legacy bridge, swap the storyboard/Xcode references, and remove the redundant file once the generic bridge is proven in a real app.

## Prefer a managed bridge controller over post-launch installer hooks

The AppDelegate-driven bridge installer compiled and deployed cleanly, but the real iPhone validation still produced zero `mobile-harness` or `MHDBG` signal even after explicit live-reload and raw syslog checks. That is strong evidence that "find the live `CAPBridgeViewController` after launch and patch it" is the wrong center of gravity for Capacitor iOS. The cleaner next refactor is to go back to one managed `CAPBridgeViewController` subclass as the canonical setup path:

- install a single managed `MobileHarnessBridgeViewController.swift`
- point `Main.storyboard` at that class
- remove all late bridge injection / lifecycle observer complexity
- validate the bridge at the actual `capacitorDidLoad()` boundary

That path is smaller, more deterministic, and a better fit for a Capacitor-first developer tool.

## Capacitor-first iOS control contract

Now that iOS web observability is real through the managed WKWebView bridge, the next high-impact step is to build the missing **safe control contract** on top of that bridge instead of going back to WDA/XCTest. The right path is:

- define a tiny request/response bridge protocol
- implement DOM-first `ui snapshot`, `ui click`, `ui type`, and `ui wait-for`
- add narrow native dev hooks only where web control is not enough

That keeps the public `mobile-harness` surface aligned with Android while making the iOS backend safe for a real primary device.
