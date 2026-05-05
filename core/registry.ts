import type { HarnessBackend } from "./backend.ts";
import type {
  AppSession,
  Artifact,
  CreateSessionInput,
  DeviceSummary,
  Platform,
  ScreenshotOptions,
  TailLogsOptions,
} from "./types.ts";
import type { DeviceCapabilities } from "./capabilities.ts";
import { HarnessError } from "./errors.ts";
import { loadSession } from "./storage.ts";
import { ensureTimeline } from "./timeline.ts";
import { AndroidHarnessBackend } from "../android/backend.ts";
import { IOSHarnessBackend } from "../ios/backend.ts";

export const supportedPlatforms = ["android", "ios"] as const;

export const parsePlatform = (value?: string): Platform | "all" => {
  if (!value || value === "all") {
    return "all";
  }

  if (supportedPlatforms.includes(value as Platform)) {
    return value as Platform;
  }

  throw new HarnessError(
    "invalid_input",
    `Unsupported platform "${value}". Expected one of: all, android, ios.`,
    { value },
  );
};

export const createBackends = (): Record<Platform, HarnessBackend> => ({
  android: new AndroidHarnessBackend(),
  ios: new IOSHarnessBackend(),
});

export const listDevices = async (
  platform: Platform | "all",
): Promise<DeviceSummary[]> => {
  const backends = createBackends();

  if (platform === "all") {
    const results = await Promise.allSettled(
      Object.values(backends).map((backend) => backend.listDevices()),
    );

    return results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
  }

  return backends[platform].listDevices();
};

export const createSession = async (
  platform: Platform,
  input: CreateSessionInput,
): Promise<AppSession> => {
  const session = await createBackends()[platform].createSession(input);
  await ensureTimeline(session.id);
  return session;
};

const getBackendForSession = async (sessionId: string): Promise<HarnessBackend> => {
  const session = await loadSession(sessionId);
  return createBackends()[session.platform];
};

export const getSessionCapabilities = async (
  sessionId: string,
): Promise<DeviceCapabilities> => {
  return await (await getBackendForSession(sessionId)).getCapabilities(sessionId);
};

export const tailSessionLogs = async (
  sessionId: string,
  options?: TailLogsOptions,
) => {
  return (await getBackendForSession(sessionId)).tailLogs(sessionId, options);
};

export const captureSessionScreenshot = async (
  sessionId: string,
  options?: ScreenshotOptions,
): Promise<Artifact> => {
  return await (await getBackendForSession(sessionId)).captureScreenshot(
    sessionId,
    options,
  );
};
