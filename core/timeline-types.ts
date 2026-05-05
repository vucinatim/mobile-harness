import type { UiSnapshot } from "./ui-types.ts";

export type RecordingEventKind =
  | "action"
  | "marker"
  | "console"
  | "network"
  | "nativeLog"
  | "uiSnapshot"
  | "screenshot"
  | "error";

export type RecordingSeverity = "debug" | "info" | "warn" | "error";

export type RecordingSource = "cli" | "mcp" | "android" | "webview" | "system";

export type RecorderWorkerKind = "nativeLog" | "console" | "network";

export type RecorderSnapshotPolicy = "off" | "markers" | "errors" | "all-actions";

export type RecorderScreenshotPolicy = "off" | "errors" | "markers";

export type RecorderConfig = {
  console: boolean;
  network: boolean;
  nativeLogs: boolean;
  uiSnapshots: RecorderSnapshotPolicy;
  screenshots: RecorderScreenshotPolicy;
  maxEvents: number;
  nativeLogFilter?: string[];
};

export type RecordingState = {
  sessionId: string;
  targetId?: string;
  startedAt: string;
  stoppedAt?: string;
  active: boolean;
  config: RecorderConfig;
  workers: Partial<Record<RecorderWorkerKind, number>>;
};

export type BaseRecordingEvent = {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: RecordingEventKind;
  source: RecordingSource;
  severity: RecordingSeverity;
  summary: string;
  detail?: string;
  artifactPath?: string;
  raw?: unknown;
};

export type ActionRecordingEvent = BaseRecordingEvent & {
  kind: "action";
  actionName: string;
  selectorSummary?: string;
  resultSummary?: string;
};

export type MarkerRecordingEvent = BaseRecordingEvent & {
  kind: "marker";
  label: string;
  note?: string;
};

export type ConsoleRecordingEvent = BaseRecordingEvent & {
  kind: "console";
  level: "log" | "warn" | "error" | "debug" | "info";
  text: string;
};

export type NetworkRecordingEvent = BaseRecordingEvent & {
  kind: "network";
  requestId: string;
  stage: "request" | "response" | "failed";
  method: string;
  url: string;
  status?: number;
  errorText?: string;
};

export type NativeLogRecordingEvent = BaseRecordingEvent & {
  kind: "nativeLog";
  level?: string;
  message: string;
};

export type UiSnapshotRecordingEvent = BaseRecordingEvent & {
  kind: "uiSnapshot";
  snapshot: UiSnapshot;
};

export type ScreenshotRecordingEvent = BaseRecordingEvent & {
  kind: "screenshot";
  scope: "device" | "webview";
};

export type ErrorRecordingEvent = BaseRecordingEvent & {
  kind: "error";
  errorKind: "console" | "network" | "nativeLog" | "action" | "system";
};

export type RecordingEvent =
  | ActionRecordingEvent
  | MarkerRecordingEvent
  | ConsoleRecordingEvent
  | NetworkRecordingEvent
  | NativeLogRecordingEvent
  | UiSnapshotRecordingEvent
  | ScreenshotRecordingEvent
  | ErrorRecordingEvent;

export type RecordingReadDetail = "summary" | "standard" | "full";

export type RecordingReadOptions = {
  sinceMarker?: string;
  last?: number;
  detail?: RecordingReadDetail;
  kinds?: RecordingEventKind[];
  errorsOnly?: boolean;
};

export type RecordingReadSummary = {
  sessionId: string;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  targetId?: string;
  totalEvents: number;
  returnedEvents: number;
  suppressedEvents: number;
  markers: Array<{ label: string; timestamp: string }>;
  actions: Array<{ summary: string; timestamp: string }>;
  errors: Array<{ summary: string; timestamp: string; kind: string }>;
  warnings: Array<{ summary: string; timestamp: string; kind: string }>;
  networkFailures: Array<{ summary: string; timestamp: string }>;
};

export type RecordingReadResult = {
  state: RecordingState | null;
  summary: RecordingReadSummary;
  events?: RecordingEvent[];
};

export type TimelineReadOptions = RecordingReadOptions;
export type TimelineReadResult = RecordingReadResult;

export const defaultRecorderConfig = (): RecorderConfig => ({
  console: true,
  network: true,
  nativeLogs: true,
  uiSnapshots: "markers",
  screenshots: "off",
  maxEvents: 1000,
});
