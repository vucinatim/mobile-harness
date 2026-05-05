#!/usr/bin/env python3

import argparse
import asyncio
import json
import logging
import os
import sys
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from defusedxml import ElementTree as DefusedET

from pymobiledevice3.cli.cli_common import _tunneld
from pymobiledevice3.cli.developer.wda import wait_for_xctest_app
from pymobiledevice3.exceptions import WdaError
from pymobiledevice3.services.wda import WdaServiceClient


CLICKABLE_TYPES = {
    "XCUIElementTypeButton",
    "XCUIElementTypeIcon",
    "XCUIElementTypeCell",
    "XCUIElementTypeLink",
    "XCUIElementTypeSwitch",
    "XCUIElementTypeTextField",
    "XCUIElementTypeSecureTextField",
    "XCUIElementTypeImage",
}

HARDWARE_KEYS = {"home", "lock", "volumeup", "volumedown"}
RETRYABLE_WDA_SNIPPETS = (
    "WDA response did not contain headers terminator",
    "Connection reset by peer",
    "Failed to connect to service port.",
    "Got RstStreamFrame",
    "Runner DTX connection closed before _XCT_didFinishExecutingTestPlan",
    "test runner likely terminated itself mid-plan",
    "WDA did not become reachable on port 8100",
)
WDA_IDLE_TIMEOUT_SECONDS = 5.0
WDA_SESSION_IDLE_TIMEOUT_SECONDS = 1.0


@dataclass
class FlatElement:
    index: int
    xpath: str
    type: str
    name: str | None
    label: str | None
    value: str | None
    enabled: str | None
    visible: str | None
    hittable: str | None
    rect: dict[str, str] | None

    def to_json(self) -> dict[str, Any]:
      return {
          "index": self.index,
          "id": f"ios-wda:{self.index}",
          "xpath": self.xpath,
          "type": self.type,
          "name": self.name,
          "label": self.label,
          "value": self.value,
          "enabled": self.enabled,
          "visible": self.visible,
          "hittable": self.hittable,
          "rect": self.rect,
      }


def normalize_loggers() -> None:
    logging.basicConfig(level=logging.ERROR)
    for name in [
        "pymobiledevice3",
        "asyncio",
    ]:
        logging.getLogger(name).setLevel(logging.ERROR)


def bool_attr(value: str | None) -> bool:
    return value == "true"


def flatten_tree(root: DefusedET.Element) -> list[FlatElement]:
    items: list[FlatElement] = []

    def walk(element: DefusedET.Element, xpath: str) -> None:
        attrs = element.attrib
        rect = {
            "x": attrs.get("x"),
            "y": attrs.get("y"),
            "width": attrs.get("width"),
            "height": attrs.get("height"),
        }
        if all(value is None for value in rect.values()):
            rect = None

        if attrs.get("name") or attrs.get("label") or attrs.get("value") or rect:
            items.append(
                FlatElement(
                    index=len(items),
                    xpath=xpath,
                    type=element.tag,
                    name=attrs.get("name"),
                    label=attrs.get("label"),
                    value=attrs.get("value"),
                    enabled=attrs.get("enabled"),
                    visible=attrs.get("visible"),
                    hittable=attrs.get("hittable"),
                    rect=rect,
                )
            )

        sibling_counts: dict[str, int] = {}
        for child in list(element):
            sibling_counts[child.tag] = sibling_counts.get(child.tag, 0) + 1
            child_xpath = f"{xpath}/{child.tag}[{sibling_counts[child.tag]}]"
            walk(child, child_xpath)

    walk(root, f"/{root.tag}[1]")
    return items


async def create_client(device_id: str, xctrunner: str):
    service_provider = await _tunneld(device_id)
    if service_provider is None:
        raise RuntimeError(f'No iOS device was available for tunnel lookup: "{device_id}"')

    runner_task = await wait_for_xctest_app(service_provider, xctrunner)
    client = WdaServiceClient(service_provider=service_provider)
    return service_provider, runner_task, client


async def close_client(service_provider, runner_task) -> None:
    runner_task.cancel()
    with suppress(asyncio.CancelledError):
        await runner_task
    await service_provider.close()


async def start_session_with_retry(
    client: WdaServiceClient,
    app_id: str,
    attempts: int = 8,
) -> str:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return await client.start_session(bundle_id=app_id)
        except Exception as error:  # noqa: BLE001
            last_error = error
            await asyncio.sleep(min(1.0, 0.2 * (attempt + 1)))

    assert last_error is not None
    raise RuntimeError(
        f'Failed to start a WDA session for app "{app_id}".'
    ) from last_error


async def run_request(
    client: WdaServiceClient,
    session_id: str,
    request: dict[str, Any],
) -> Any:
    command = request["command"]

    if command == "ping":
        return {"status": "ok"}

    if command == "dump":
        source = await client.get_source(session_id=session_id)
        root = DefusedET.fromstring(source)
        return [item.to_json() for item in flatten_tree(root)]

    if command == "click-xpath":
        xpath = request.get("xpath")
        if not xpath:
            raise RuntimeError("xpath is required for click-xpath")
        element_id = await client.find_element(using="xpath", value=xpath, session_id=session_id)
        await client.click(element_id=element_id, session_id=session_id)
        return {"ok": True}

    if command == "tap-point":
        x = request.get("x")
        y = request.get("y")
        if x is None or y is None:
            raise RuntimeError("x and y are required for tap-point")
        await client.swipe(x, y, x, y, duration=0.05, session_id=session_id)
        return {"ok": True}

    if command == "type-xpath":
        xpath = request.get("xpath")
        if not xpath:
            raise RuntimeError("xpath is required for type-xpath")
        text = request.get("text", "")
        clear_first = bool(request.get("clear_first"))
        existing_value = request.get("existing_value")
        submit = bool(request.get("submit"))
        element_id = await client.find_element(using="xpath", value=xpath, session_id=session_id)
        await client.click(element_id=element_id, session_id=session_id)
        if clear_first and existing_value:
            await client.send_keys("\b" * max(len(existing_value), 1), session_id=session_id)
        payload = f"{text}\n" if submit else text
        if payload:
            await client.send_keys(payload, session_id=session_id)
        return {"ok": True}

    if command == "press-key":
        key = request.get("key")
        if not key:
            raise RuntimeError("key is required for press-key")

        normalized = str(key).lower()
        if normalized in HARDWARE_KEYS:
            await client.press_button(normalized, session_id=session_id)
            return {"ok": True}

        mapping = {
            "enter": "\n",
            "return": "\n",
            "tab": "\t",
            "backspace": "\b",
            "delete": "\b",
            "space": " ",
        }
        payload = mapping.get(normalized)
        if payload is None:
            raise RuntimeError(f'Unsupported iOS key press: "{key}"')

        await client.send_keys(payload, session_id=session_id)
        return {"ok": True}

    raise RuntimeError(f'Unsupported WDA request command: "{command}"')


async def dump_elements(device_id: str, xctrunner: str, app_id: str) -> list[dict[str, Any]]:
    async def run_once() -> list[dict[str, Any]]:
        service_provider, runner_task, client = await create_client(device_id, xctrunner)
        try:
            session_id = await start_session_with_retry(client, app_id)
            return await run_request(client, session_id, {"command": "dump"})
        finally:
            await close_client(service_provider, runner_task)

    return await run_with_retry(run_once)


async def click_xpath(device_id: str, xctrunner: str, app_id: str, xpath: str) -> None:
    async def run_once() -> None:
        service_provider, runner_task, client = await create_client(device_id, xctrunner)
        try:
            session_id = await start_session_with_retry(client, app_id)
            await run_request(client, session_id, {"command": "click-xpath", "xpath": xpath})
        finally:
            await close_client(service_provider, runner_task)

    await run_with_retry(run_once)


async def tap_point(
    device_id: str,
    xctrunner: str,
    app_id: str,
    x: int,
    y: int,
) -> None:
    async def run_once() -> None:
        service_provider, runner_task, client = await create_client(device_id, xctrunner)
        try:
            session_id = await start_session_with_retry(client, app_id)
            await run_request(client, session_id, {"command": "tap-point", "x": x, "y": y})
        finally:
            await close_client(service_provider, runner_task)

    await run_with_retry(run_once)


async def type_xpath(
    device_id: str,
    xctrunner: str,
    app_id: str,
    xpath: str,
    text: str,
    clear_first: bool,
    existing_value: str | None,
    submit: bool,
) -> None:
    async def run_once() -> None:
        service_provider, runner_task, client = await create_client(device_id, xctrunner)
        try:
            session_id = await start_session_with_retry(client, app_id)
            await run_request(
                client,
                session_id,
                {
                    "command": "type-xpath",
                    "xpath": xpath,
                    "text": text,
                    "clear_first": clear_first,
                    "existing_value": existing_value,
                    "submit": submit,
                },
            )
        finally:
            await close_client(service_provider, runner_task)

    await run_with_retry(run_once)


async def press_key(
    device_id: str,
    xctrunner: str,
    app_id: str,
    key: str,
) -> None:
    async def run_once() -> None:
        service_provider, runner_task, client = await create_client(device_id, xctrunner)
        try:
            session_id = await start_session_with_retry(client, app_id)
            await run_request(client, session_id, {"command": "press-key", "key": key})
        finally:
            await close_client(service_provider, runner_task)

    await run_with_retry(run_once)


def is_retryable_error(error: Exception) -> bool:
    message = str(error)
    return any(snippet in message for snippet in RETRYABLE_WDA_SNIPPETS)


async def run_with_retry(operation, attempts: int = 4):
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return await operation()
        except Exception as error:  # noqa: BLE001
            last_error = error
            if attempt == attempts - 1 or not is_retryable_error(error):
                raise
            await asyncio.sleep(0.4 * (attempt + 1))

    assert last_error is not None
    raise last_error


class PersistentWdaBridge:
    def __init__(self, device_id: str, xctrunner: str, app_id: str) -> None:
        self.device_id = device_id
        self.xctrunner = xctrunner
        self.app_id = app_id
        self.service_provider = None
        self.runner_task = None
        self.client = None
        self.session_id: str | None = None
        self.lock = asyncio.Lock()
        self.last_session_use: float | None = None

    async def ensure_session(self) -> None:
        if self.client is not None and self.session_id is not None:
            return

        self.service_provider, self.runner_task, self.client = await create_client(
            self.device_id,
            self.xctrunner,
        )
        self.session_id = await start_session_with_retry(self.client, self.app_id)

    async def reset(self) -> None:
        if self.service_provider is not None and self.runner_task is not None:
            await close_client(self.service_provider, self.runner_task)
        self.service_provider = None
        self.runner_task = None
        self.client = None
        self.session_id = None
        self.last_session_use = None

    async def release_if_idle(self, now: float) -> None:
        if self.service_provider is None or self.last_session_use is None:
            return
        if self.lock.locked():
            return
        if now - self.last_session_use < WDA_SESSION_IDLE_TIMEOUT_SECONDS:
            return
        await self.reset()

    async def execute(self, request: dict[str, Any]) -> Any:
        if request.get("command") == "ping":
            return {
                "status": "ok",
                "has_session": self.session_id is not None,
            }

        async with self.lock:
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    await self.ensure_session()
                    assert self.client is not None
                    assert self.session_id is not None
                    result = await run_request(self.client, self.session_id, request)
                    self.last_session_use = asyncio.get_running_loop().time()
                    return result
                except Exception as error:  # noqa: BLE001
                    last_error = error
                    await self.reset()
                    if attempt == 2 or not is_retryable_error(error):
                        raise
                    await asyncio.sleep(0.4 * (attempt + 1))

            assert last_error is not None
            raise last_error


async def serve_bridge(
    socket_path: str,
    device_id: str,
    xctrunner: str,
    app_id: str,
) -> None:
    bridge = PersistentWdaBridge(device_id, xctrunner, app_id)
    loop = asyncio.get_running_loop()
    last_activity = loop.time()
    active_clients = 0
    stop_event = asyncio.Event()

    with suppress(FileNotFoundError):
        os.unlink(socket_path)

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        nonlocal active_clients, last_activity
        active_clients += 1
        last_activity = loop.time()
        try:
            line = await reader.readline()
            if not line:
                return

            request = json.loads(line.decode("utf-8"))
            result = await bridge.execute(request)
            writer.write(
                json.dumps({"ok": True, "result": result}, separators=(",", ":")).encode("utf-8")
                + b"\n"
            )
            await writer.drain()
        except Exception as error:  # noqa: BLE001
            writer.write(
                json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")).encode(
                    "utf-8"
                )
                + b"\n"
            )
            await writer.drain()
        finally:
            active_clients = max(0, active_clients - 1)
            last_activity = loop.time()
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()

    server = await asyncio.start_unix_server(handle_client, path=socket_path)

    async def watch_for_idle() -> None:
        nonlocal last_activity
        while not stop_event.is_set():
            await asyncio.sleep(0.5)
            await bridge.release_if_idle(loop.time())
            if active_clients > 0:
                continue
            if loop.time() - last_activity < WDA_IDLE_TIMEOUT_SECONDS:
                continue
            stop_event.set()
            server.close()
            break

    try:
        async with server:
            watchdog = asyncio.create_task(watch_for_idle())
            try:
                await stop_event.wait()
            finally:
                watchdog.cancel()
                with suppress(asyncio.CancelledError):
                    await watchdog
                with suppress(Exception):
                    await server.wait_closed()
    finally:
        await bridge.reset()
        with suppress(FileNotFoundError):
            os.unlink(socket_path)


async def main_async() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["dump", "click-xpath", "tap-point", "type-xpath", "press-key", "serve"])
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--xctrunner", required=True)
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--socket")
    parser.add_argument("--xpath")
    parser.add_argument("--text", default="")
    parser.add_argument("--clear-first", action="store_true")
    parser.add_argument("--existing-value")
    parser.add_argument("--submit", action="store_true")
    parser.add_argument("--key")
    parser.add_argument("--x", type=int)
    parser.add_argument("--y", type=int)
    args = parser.parse_args()

    normalize_loggers()

    try:
        if args.command == "serve":
            if not args.socket:
                raise RuntimeError("--socket is required for serve")
            await serve_bridge(args.socket, args.device_id, args.xctrunner, args.app_id)
        elif args.command == "dump":
            print(json.dumps(await dump_elements(args.device_id, args.xctrunner, args.app_id)))
        elif args.command == "click-xpath":
            if not args.xpath:
                raise RuntimeError("--xpath is required for click-xpath")
            await click_xpath(args.device_id, args.xctrunner, args.app_id, args.xpath)
            print(json.dumps({"ok": True}))
        elif args.command == "tap-point":
            if args.x is None or args.y is None:
                raise RuntimeError("--x and --y are required for tap-point")
            await tap_point(args.device_id, args.xctrunner, args.app_id, args.x, args.y)
            print(json.dumps({"ok": True}))
        elif args.command == "type-xpath":
            if not args.xpath:
                raise RuntimeError("--xpath is required for type-xpath")
            await type_xpath(
                args.device_id,
                args.xctrunner,
                args.app_id,
                args.xpath,
                args.text,
                args.clear_first,
                args.existing_value,
                args.submit,
            )
            print(json.dumps({"ok": True}))
        elif args.command == "press-key":
            if not args.key:
                raise RuntimeError("--key is required for press-key")
            await press_key(args.device_id, args.xctrunner, args.app_id, args.key)
            print(json.dumps({"ok": True}))
    except WdaError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print(str(error), file=sys.stderr)
        return 1

    return 0


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    raise SystemExit(main())
