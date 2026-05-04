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
} from "./types.ts";
import type { DeviceCapabilities } from "./capabilities.ts";

export interface HarnessBackend {
  listDevices(): Promise<DeviceSummary[]>;
  createSession(input: CreateSessionInput): Promise<AppSession>;
  getCapabilities(sessionId: string): Promise<DeviceCapabilities>;
  tailLogs(
    sessionId: string,
    options?: TailLogsOptions,
  ): AsyncIterable<LogEvent>;
  captureScreenshot(
    sessionId: string,
    options?: ScreenshotOptions,
  ): Promise<Artifact>;
  listWebviews(sessionId: string): Promise<WebviewTarget[]>;
  attachWebview(sessionId: string, targetId: string): Promise<void>;
  evalJs(
    sessionId: string,
    targetId: string,
    expression: string,
  ): Promise<EvalResult>;
  streamConsole(
    sessionId: string,
    targetId: string,
  ): AsyncIterable<ConsoleEvent>;
  streamNetwork(
    sessionId: string,
    targetId: string,
  ): AsyncIterable<NetworkEvent>;
}
