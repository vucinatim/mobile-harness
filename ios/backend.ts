import type { HarnessBackend } from "../core/backend.ts";
import {
  iosCapacitorBridgeCapabilities,
  iosPhaseOneCapabilities,
  iosPhaseFourCapabilities,
  iosPhaseThreeCapabilities,
} from "../core/capabilities.ts";
import { HarnessError, notImplemented } from "../core/errors.ts";
import { getArtifactPath, loadSession, saveSession } from "../core/storage.ts";
import { readRecordingEvents } from "../core/timeline-store.ts";
import type {
  AppSession,
  Artifact,
  ConsoleEvent,
  CreateSessionInput,
  DeviceSummary,
  EvalResult,
  LogEvent,
  NetworkEvent,
  ScreenshotOptions,
  TailLogsOptions,
  WebviewTarget,
} from "../core/types.ts";
import type { DeviceCapabilities } from "../core/capabilities.ts";
import type {
  UiActionResult,
  UiInspectResult,
  UiTapOptions,
  UiPressOptions,
  UiReadResult,
  UiSelector,
  UiSnapshot,
  UiSnapshotOptions,
  UiTypeOptions,
  UiWaitCondition,
  UiWaitResult,
} from "../core/ui-types.ts";
import {
  ensureIOSAppInstalled,
  getIOSDevice,
  launchIOSApp,
  listIOSDevices,
} from "./devicectl.ts";
import { hasInstalledCapacitorIOSBridge } from "./capacitor-setup.ts";
import {
  captureIOSDeviceScreenshot,
  getIOSAppProcessInfo,
  hasPyMobileDeviceTunnel,
  parseIOSSyslogLine,
  hasPyMobileDeviceSupport,
  spawnIOSSyslog,
} from "./pymobiledevice.ts";
import { readLines } from "../core/stream.ts";
import {
  clearWdaUi,
  clickWdaUi,
  createWdaSnapshot,
  getInstalledWdaRunnerBundleId,
  inspectWdaUi,
  listWdaItems,
  pressWdaUi,
  readWdaUi,
  stopWdaWorkerForSession,
  tapWdaUi,
  typeIntoWdaUi,
  waitForWdaUi,
} from "./wda.ts";
import { invokeIOSBridgeEval } from "./bridge-control.ts";
import {
  clearIOSBridgeUi,
  clickIOSBridgeUi,
  inspectIOSBridgeUi,
  pressIOSBridgeUi,
  readIOSBridgeUi,
  snapshotIOSBridgeUi,
  tapIOSBridgeUi,
  typeIntoIOSBridgeUi,
  waitForIOSBridgeUi,
} from "./bridge-ui.ts";

export class IOSHarnessBackend implements HarnessBackend {
  private isCapacitorBridgeTarget(session: AppSession, targetId: string) {
    return (
      session.integrations?.capacitorIOSBridge === true &&
      targetId === "capacitor-ios-bridge"
    );
  }

  private async waitForRunningAppProcess(deviceId: string, appId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const processInfo = getIOSAppProcessInfo(deviceId, appId);
      if (processInfo.name || processInfo.pid) {
        return processInfo;
      }

      await Bun.sleep(500);
    }

    return getIOSAppProcessInfo(deviceId, appId);
  }

  async listDevices(): Promise<DeviceSummary[]> {
    return await listIOSDevices();
  }

  async cleanupSession(sessionId: string): Promise<void> {
    await stopWdaWorkerForSession(sessionId);
  }

  async createSession(input: CreateSessionInput): Promise<AppSession> {
    const device = await getIOSDevice(input.deviceId);
    if (!device) {
      throw new HarnessError(
        "invalid_input",
        `iOS device "${input.deviceId}" was not found.`,
        { deviceId: input.deviceId },
      );
    }

    if (device.state !== "connected") {
      throw new HarnessError(
        "invalid_input",
        `iOS device "${input.deviceId}" is not connected.`,
        { deviceId: input.deviceId, state: device.state },
      );
    }

    await ensureIOSAppInstalled(input.deviceId, input.appId);

    if (input.launchApp) {
      await launchIOSApp(input.deviceId, input.appId);
      const processInfo = await this.waitForRunningAppProcess(
        input.deviceId,
        input.appId,
      );
      if (!processInfo.name && !processInfo.pid) {
        throw new HarnessError(
          "command_failed",
          `Launched "${input.appId}" on iOS device "${input.deviceId}", but the app process did not become available.`,
          { deviceId: input.deviceId, appId: input.appId },
        );
      }

      await Bun.sleep(500);
    }

    const session: AppSession = {
      id: crypto.randomUUID(),
      deviceId: input.deviceId,
      platform: "ios",
      appId: input.appId,
      startedAt: new Date().toISOString(),
    };

    const bridgeProject = await hasInstalledCapacitorIOSBridge(process.cwd());
    if (bridgeProject) {
      session.projectRoot = bridgeProject.projectRoot;
      session.integrations = {
        capacitorIOSBridge: true,
      };
    }

    await saveSession(session);
    return session;
  }

  async getCapabilities(_sessionId: string): Promise<DeviceCapabilities> {
    const session = await loadSession(_sessionId);
    if (
      !hasPyMobileDeviceSupport() ||
      !(await hasPyMobileDeviceTunnel(session.deviceId))
    ) {
      return iosPhaseOneCapabilities();
    }

    const installedWdaRunner = await getInstalledWdaRunnerBundleId(session.deviceId);
    const hasCapacitorBridge = session.integrations?.capacitorIOSBridge === true;

    if (hasCapacitorBridge && !installedWdaRunner) {
      return iosCapacitorBridgeCapabilities();
    }

    return installedWdaRunner
      ? iosPhaseFourCapabilities()
      : hasCapacitorBridge
        ? iosCapacitorBridgeCapabilities()
        : iosPhaseThreeCapabilities();
  }

  async *tailLogs(
    sessionId: string,
    options?: TailLogsOptions,
  ): AsyncIterable<LogEvent> {
    if (!hasPyMobileDeviceSupport()) {
      throw new HarnessError(
        "missing_dependency",
        'iOS log capture requires the optional "uvx" runtime so the harness can invoke pymobiledevice3.',
      );
    }

    const session = await loadSession(sessionId);
    const processInfo = await this.waitForRunningAppProcess(
      session.deviceId,
      session.appId,
    );

    const subprocess = spawnIOSSyslog(
      session.deviceId,
      session.appId,
      processInfo,
    );

    if (!(subprocess.stdout instanceof ReadableStream)) {
      throw new HarnessError(
        "command_failed",
        "pymobiledevice3 did not expose stdout for iOS syslog streaming.",
      );
    }

    try {
      for await (const line of readLines(subprocess.stdout)) {
        if (!line.trim()) {
          continue;
        }

        if (options?.filter && !line.includes(options.filter)) {
          continue;
        }

        yield parseIOSSyslogLine(line);
      }
    } finally {
      subprocess.kill();
    }
  }

  async captureScreenshot(
    sessionId: string,
    _options?: ScreenshotOptions,
  ): Promise<Artifact> {
    if (!hasPyMobileDeviceSupport()) {
      throw new HarnessError(
        "missing_dependency",
        'iOS screenshots require the optional "uvx" runtime so the harness can invoke pymobiledevice3.',
      );
    }

    const session = await loadSession(sessionId);
    const createdAt = new Date().toISOString();
    const outputPath =
      _options?.outputPath ??
      (await getArtifactPath(
        sessionId,
        `device-screenshot-${createdAt.replaceAll(":", "-")}.png`,
      ));

    await captureIOSDeviceScreenshot(session.deviceId, outputPath);

    return {
      type: "screenshot",
      scope: "device",
      path: outputPath,
      createdAt,
    };
  }

  async captureWebviewScreenshot(
    _sessionId: string,
    _targetId: string,
    _options?: ScreenshotOptions,
  ): Promise<Artifact> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async listWebviews(_sessionId: string): Promise<WebviewTarget[]> {
    const session = await loadSession(_sessionId);
    if (session.integrations?.capacitorIOSBridge) {
      return [
        {
          id: "capacitor-ios-bridge",
          sessionId: _sessionId,
          title: "Capacitor iOS Bridge",
          attached: true,
        },
      ];
    }

    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async attachWebview(_sessionId: string, _targetId: string): Promise<void> {
    const session = await loadSession(_sessionId);
    if (session.integrations?.capacitorIOSBridge && _targetId === "capacitor-ios-bridge") {
      return;
    }

    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async evalJs(
    _sessionId: string,
    _targetId: string,
    _expression: string,
  ): Promise<EvalResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return {
        value: await invokeIOSBridgeEval(session.appId, _expression),
      };
    }

    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async *streamConsole(
    _sessionId: string,
    _targetId: string,
  ): AsyncIterable<ConsoleEvent> {
    const session = await loadSession(_sessionId);
    if (session.integrations?.capacitorIOSBridge && _targetId === "capacitor-ios-bridge") {
      let cursor = (await readRecordingEvents(_sessionId)).length;
      for (;;) {
        const events = await readRecordingEvents(_sessionId);
        if (cursor < events.length) {
          for (const event of events.slice(cursor)) {
            if (event.kind === "console") {
              yield {
                type: event.level,
                args: event.text ? [event.text] : [],
                timestamp: event.timestamp,
              };
            }
          }
          cursor = events.length;
        }

        await Bun.sleep(250);
      }
      return;
    }

    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async *streamNetwork(
    _sessionId: string,
    _targetId: string,
  ): AsyncIterable<NetworkEvent> {
    const session = await loadSession(_sessionId);
    if (session.integrations?.capacitorIOSBridge && _targetId === "capacitor-ios-bridge") {
      let cursor = (await readRecordingEvents(_sessionId)).length;
      for (;;) {
        const events = await readRecordingEvents(_sessionId);
        if (cursor < events.length) {
          for (const event of events.slice(cursor)) {
            if (event.kind === "network") {
              yield {
                id: event.requestId,
                stage: event.stage,
                method: event.method,
                url: event.url,
                status: event.status,
                errorText: event.errorText,
              };
            }
          }
          cursor = events.length;
        }

        await Bun.sleep(250);
      }
      return;
    }

    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async snapshotUi(
    _sessionId: string,
    _targetId: string,
    _options?: UiSnapshotOptions,
  ): Promise<UiSnapshot> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await snapshotIOSBridgeUi(session.appId, _options);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI snapshot requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    const rawElements = await listWdaItems(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
    );
    return createWdaSnapshot(rawElements, _options?.detail ?? "summary");
  }

  async inspectUi(
    _sessionId: string,
    _targetId: string,
    _selector: UiSelector,
  ): Promise<UiInspectResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await inspectIOSBridgeUi(session.appId, _selector);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI inspect requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await inspectWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _selector,
    );
  }

  async clickUi(
    _sessionId: string,
    _targetId: string,
    _selector: UiSelector,
  ): Promise<UiActionResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await clickIOSBridgeUi(session.appId, _selector);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI click requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await clickWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _selector,
    );
  }

  async tapUi(
    _sessionId: string,
    _targetId: string,
    _options: UiTapOptions,
  ): Promise<UiActionResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await tapIOSBridgeUi(session.appId, _options);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI tap requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await tapWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _options,
    );
  }

  async typeIntoUi(
    _sessionId: string,
    _targetId: string,
    _selector: UiSelector,
    _text: string,
    _options?: UiTypeOptions,
  ): Promise<UiActionResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await typeIntoIOSBridgeUi(
        session.appId,
        _selector,
        _text,
        _options,
      );
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI typing requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await typeIntoWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _selector,
      _text,
      _options,
    );
  }

  async clearUi(
    _sessionId: string,
    _targetId: string,
    _selector: UiSelector,
  ): Promise<UiActionResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await clearIOSBridgeUi(session.appId, _selector);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI clear requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await clearWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _selector,
    );
  }

  async pressUi(
    _sessionId: string,
    _targetId: string,
    _selector: UiSelector,
    _options: UiPressOptions,
  ): Promise<UiActionResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await pressIOSBridgeUi(session.appId, _selector, _options);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI press requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await pressWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _selector,
      _options,
    );
  }

  async readUi(
    _sessionId: string,
    _targetId: string,
    _selector: UiSelector,
  ): Promise<UiReadResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await readIOSBridgeUi(session.appId, _selector);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI read requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await readWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _selector,
    );
  }

  async waitForUi(
    _sessionId: string,
    _targetId: string,
    _condition: UiWaitCondition,
  ): Promise<UiWaitResult> {
    const session = await loadSession(_sessionId);
    if (this.isCapacitorBridgeTarget(session, _targetId)) {
      return await waitForIOSBridgeUi(session.appId, _condition);
    }

    const xctrunnerBundleId = await getInstalledWdaRunnerBundleId(session.deviceId);
    if (!xctrunnerBundleId) {
      throw new HarnessError(
        "command_failed",
        "iOS native UI wait requires the WDA bootstrap. Run `mobile-harness setup ios --bootstrap-wda` first.",
      );
    }
    return await waitForWdaUi(
      _sessionId,
      session.deviceId,
      session.appId,
      xctrunnerBundleId,
      _condition,
    );
  }
}
