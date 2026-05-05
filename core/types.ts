import type { DeviceCapabilities } from "./capabilities.ts";

export type Platform = "android" | "ios";

export type DeviceKind = "physical" | "emulator" | "simulator";

export type DeviceState =
  | "connected"
  | "disconnected"
  | "unauthorized"
  | "unknown";

export type DeviceSummary = {
  id: string;
  platform: Platform;
  kind: DeviceKind;
  name: string;
  osVersion?: string;
  model?: string;
  state: DeviceState;
  capabilities: DeviceCapabilities;
};

export type AppSession = {
  id: string;
  deviceId: string;
  platform: Platform;
  appId: string;
  startedAt: string;
  projectRoot?: string;
  integrations?: {
    capacitorIOSBridge?: boolean;
  };
};

export type WebviewTarget = {
  id: string;
  sessionId: string;
  title?: string;
  url?: string;
  attached: boolean;
};

export type Artifact =
  | {
      type: "screenshot";
      scope: "device" | "webview";
      path: string;
      createdAt: string;
    }
  | { type: "log"; path: string; createdAt: string }
  | { type: "network"; path: string; createdAt: string }
  | { type: "console"; path: string; createdAt: string };

export type LogEvent = {
  timestamp?: string;
  level?: string;
  tag?: string;
  message: string;
};

export type ConsoleEvent = {
  type: "log" | "warn" | "error" | "debug" | "info";
  args: string[];
  timestamp?: string;
};

export type NetworkEvent = {
  id: string;
  stage: "request" | "response" | "failed";
  method: string;
  url: string;
  status?: number;
  errorText?: string;
};

export type EvalResult = {
  value: unknown;
};

export type CreateSessionInput = {
  deviceId: string;
  appId: string;
  launchApp?: boolean;
};

export type TailLogsOptions = {
  filter?: string;
};

export type ScreenshotOptions = {
  outputPath?: string;
};
