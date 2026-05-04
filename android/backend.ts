import type { HarnessBackend } from "../core/backend.ts";
import { androidDeviceCapabilities } from "../core/capabilities.ts";
import { HarnessError, notImplemented } from "../core/errors.ts";
import { readLines } from "../core/stream.ts";
import {
  getArtifactPath,
  loadSession,
  saveSession,
} from "../core/storage.ts";
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
import {
  captureAndroidDeviceScreenshot,
  ensureAndroidPackageInstalled,
  getAndroidDevice,
  launchAndroidApp,
  listAndroidDevices,
  spawnAndroidLogcat,
} from "./adb.ts";

export class AndroidHarnessBackend implements HarnessBackend {
  async listDevices(): Promise<DeviceSummary[]> {
    return await listAndroidDevices();
  }

  async createSession(input: CreateSessionInput): Promise<AppSession> {
    const device = await getAndroidDevice(input.deviceId);
    if (!device) {
      throw new HarnessError(
        "invalid_input",
        `Android device "${input.deviceId}" was not found.`,
        { deviceId: input.deviceId },
      );
    }

    if (device.state !== "connected") {
      throw new HarnessError(
        "invalid_input",
        `Android device "${input.deviceId}" is not connected.`,
        { deviceId: input.deviceId, state: device.state },
      );
    }

    ensureAndroidPackageInstalled(input.deviceId, input.appId);

    if (input.launchApp) {
      launchAndroidApp(input.deviceId, input.appId);
    }

    const session: AppSession = {
      id: crypto.randomUUID(),
      deviceId: input.deviceId,
      platform: "android",
      appId: input.appId,
      startedAt: new Date().toISOString(),
    };

    await saveSession(session);
    return session;
  }

  async getCapabilities(_sessionId: string): Promise<DeviceCapabilities> {
    return androidDeviceCapabilities();
  }

  async *tailLogs(
    sessionId: string,
    options?: TailLogsOptions,
  ): AsyncIterable<LogEvent> {
    const session = await loadSession(sessionId);
    const subprocess = spawnAndroidLogcat(session.deviceId, session.appId);

    if (!(subprocess.stdout instanceof ReadableStream)) {
      throw new HarnessError(
        "command_failed",
        "adb did not expose stdout for logcat streaming.",
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

        yield { message: line };
      }
    } finally {
      subprocess.kill();
    }
  }

  async captureScreenshot(
    sessionId: string,
    options?: ScreenshotOptions,
  ): Promise<Artifact> {
    const session = await loadSession(sessionId);
    const createdAt = new Date().toISOString();
    const outputPath =
      options?.outputPath ??
      (await getArtifactPath(
        sessionId,
        `device-screenshot-${createdAt.replaceAll(":", "-")}.png`,
      ));

    await captureAndroidDeviceScreenshot(session.deviceId, outputPath);

    return {
      type: "screenshot",
      path: outputPath,
      createdAt,
    };
  }

  async listWebviews(_sessionId: string): Promise<WebviewTarget[]> {
    throw notImplemented(
      "Android WebView discovery is not implemented yet. Phase 2 will add CDP target discovery.",
    );
  }

  async attachWebview(_sessionId: string, _targetId: string): Promise<void> {
    throw notImplemented(
      "Android WebView attachment is not implemented yet. Phase 2 will add CDP attachment.",
    );
  }

  async evalJs(
    _sessionId: string,
    _targetId: string,
    _expression: string,
  ): Promise<EvalResult> {
    throw notImplemented(
      "Android JavaScript evaluation is not implemented yet. Phase 2 will add CDP Runtime.evaluate support.",
    );
  }

  async *streamConsole(
    _sessionId: string,
    _targetId: string,
  ): AsyncIterable<ConsoleEvent> {
    throw notImplemented(
      "Android console streaming is not implemented yet. Phase 2 will add CDP console event support.",
    );
  }

  async *streamNetwork(
    _sessionId: string,
    _targetId: string,
  ): AsyncIterable<NetworkEvent> {
    throw notImplemented(
      "Android network streaming is not implemented yet. Phase 2 will add CDP network event support.",
    );
  }
}
