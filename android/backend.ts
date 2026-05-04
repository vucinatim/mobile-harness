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
import {
  evaluateAndroidWebview,
  listAndroidWebviews,
  streamAndroidConsole,
  streamAndroidNetwork,
  validateAndroidWebviewTarget,
} from "./cdp.ts";

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

  async listWebviews(sessionId: string): Promise<WebviewTarget[]> {
    const session = await loadSession(sessionId);
    return await listAndroidWebviews(
      session.deviceId,
      session.appId,
      sessionId,
    );
  }

  async attachWebview(sessionId: string, targetId: string): Promise<void> {
    const session = await loadSession(sessionId);
    await validateAndroidWebviewTarget(session.deviceId, session.appId, targetId);
  }

  async evalJs(
    sessionId: string,
    targetId: string,
    expression: string,
  ): Promise<EvalResult> {
    const session = await loadSession(sessionId);
    return await evaluateAndroidWebview(
      session.deviceId,
      session.appId,
      targetId,
      expression,
    );
  }

  async *streamConsole(
    sessionId: string,
    targetId: string,
  ): AsyncIterable<ConsoleEvent> {
    const session = await loadSession(sessionId);
    yield* streamAndroidConsole(session.deviceId, session.appId, targetId);
  }

  async *streamNetwork(
    sessionId: string,
    targetId: string,
  ): AsyncIterable<NetworkEvent> {
    const session = await loadSession(sessionId);
    yield* streamAndroidNetwork(session.deviceId, session.appId, targetId);
  }
}
