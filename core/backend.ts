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
} from "./ui-types.ts";

export interface HarnessBackend {
  listDevices(): Promise<DeviceSummary[]>;
  createSession(input: CreateSessionInput): Promise<AppSession>;
  cleanupSession(sessionId: string): Promise<void>;
  getCapabilities(sessionId: string): Promise<DeviceCapabilities>;
  tailLogs(
    sessionId: string,
    options?: TailLogsOptions,
  ): AsyncIterable<LogEvent>;
  captureScreenshot(
    sessionId: string,
    options?: ScreenshotOptions,
  ): Promise<Artifact>;
  captureWebviewScreenshot(
    sessionId: string,
    targetId: string,
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
  snapshotUi(
    sessionId: string,
    targetId: string,
    options?: UiSnapshotOptions,
  ): Promise<UiSnapshot>;
  inspectUi(
    sessionId: string,
    targetId: string,
    selector: UiSelector,
  ): Promise<UiInspectResult>;
  clickUi(
    sessionId: string,
    targetId: string,
    selector: UiSelector,
  ): Promise<UiActionResult>;
  tapUi(
    sessionId: string,
    targetId: string,
    options: UiTapOptions,
  ): Promise<UiActionResult>;
  typeIntoUi(
    sessionId: string,
    targetId: string,
    selector: UiSelector,
    text: string,
    options?: UiTypeOptions,
  ): Promise<UiActionResult>;
  clearUi(
    sessionId: string,
    targetId: string,
    selector: UiSelector,
  ): Promise<UiActionResult>;
  pressUi(
    sessionId: string,
    targetId: string,
    selector: UiSelector,
    options: UiPressOptions,
  ): Promise<UiActionResult>;
  readUi(
    sessionId: string,
    targetId: string,
    selector: UiSelector,
  ): Promise<UiReadResult>;
  waitForUi(
    sessionId: string,
    targetId: string,
    condition: UiWaitCondition,
  ): Promise<UiWaitResult>;
}
