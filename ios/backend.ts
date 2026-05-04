import type { HarnessBackend } from "../core/backend.ts";
import { unsupportedCapabilities } from "../core/capabilities.ts";
import { notImplemented } from "../core/errors.ts";
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

export class IOSHarnessBackend implements HarnessBackend {
  async listDevices(): Promise<DeviceSummary[]> {
    return [];
  }

  async createSession(_input: CreateSessionInput): Promise<AppSession> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async getCapabilities(_sessionId: string): Promise<DeviceCapabilities> {
    return unsupportedCapabilities();
  }

  async *tailLogs(
    _sessionId: string,
    _options?: TailLogsOptions,
  ): AsyncIterable<LogEvent> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async captureScreenshot(
    _sessionId: string,
    _options?: ScreenshotOptions,
  ): Promise<Artifact> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async captureWebviewScreenshot(
    _sessionId: string,
    _targetId: string,
    _options?: ScreenshotOptions,
  ): Promise<Artifact> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async listWebviews(_sessionId: string): Promise<WebviewTarget[]> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async attachWebview(_sessionId: string, _targetId: string): Promise<void> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async evalJs(
    _sessionId: string,
    _targetId: string,
    _expression: string,
  ): Promise<EvalResult> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async *streamConsole(
    _sessionId: string,
    _targetId: string,
  ): AsyncIterable<ConsoleEvent> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }

  async *streamNetwork(
    _sessionId: string,
    _targetId: string,
  ): AsyncIterable<NetworkEvent> {
    throw notImplemented("The iOS backend is scaffolded but not implemented yet.");
  }
}
