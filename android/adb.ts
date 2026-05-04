import type { DeviceKind, DeviceState, DeviceSummary } from "../core/types.ts";
import { androidDeviceCapabilities } from "../core/capabilities.ts";
import { HarnessError, missingDependency } from "../core/errors.ts";

type AdbDeviceLine = {
  serial: string;
  state: DeviceState;
  kind: DeviceKind;
  model?: string;
  name: string;
};

const getAdbPath = (): string => {
  const adbPath = Bun.which("adb");
  if (!adbPath) {
    throw missingDependency("adb");
  }

  return adbPath;
};

export const runAdbCommand = (args: string[]): string => {
  const adbPath = getAdbPath();
  const result = Bun.spawnSync([adbPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new HarnessError(
      "command_failed",
      stderr || `adb ${args.join(" ")} failed with exit code ${result.exitCode}.`,
      { exitCode: result.exitCode },
    );
  }

  return result.stdout.toString();
};

const runAdbForDevice = (deviceId: string, args: string[]): string => {
  return runAdbCommand(["-s", deviceId, ...args]);
};

const tryRunAdbForDevice = (
  deviceId: string,
  args: string[],
): string | null => {
  try {
    return runAdbForDevice(deviceId, args);
  } catch {
    return null;
  }
};

const parseState = (value?: string): DeviceState => {
  switch (value) {
    case "device":
      return "connected";
    case "unauthorized":
      return "unauthorized";
    case "offline":
      return "disconnected";
    default:
      return "unknown";
  }
};

const parseKind = (serial: string): DeviceKind => {
  return serial.startsWith("emulator-") ? "emulator" : "physical";
};

const parseProperties = (tokens: string[]): Record<string, string> => {
  const properties: Record<string, string> = {};

  for (const token of tokens) {
    const separatorIndex = token.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = token.slice(0, separatorIndex);
    const value = token.slice(separatorIndex + 1);
    properties[key] = value;
  }

  return properties;
};

const parseDeviceLine = (line: string): AdbDeviceLine | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  const serial = tokens[0];
  if (!serial) {
    return null;
  }

  const state = parseState(tokens[1]);
  const properties = parseProperties(tokens.slice(2));
  const model = properties.model?.replace(/_/g, " ");
  const name = model || properties.device || serial;

  return {
    serial,
    state,
    kind: parseKind(serial),
    model,
    name,
  };
};

export const listAndroidDevices = async (): Promise<DeviceSummary[]> => {
  const output = runAdbCommand(["devices", "-l"]);
  const lines = output
    .split("\n")
    .slice(1)
    .map(parseDeviceLine)
    .filter((device): device is AdbDeviceLine => device !== null);

  return lines.map((device) => ({
    id: device.serial,
    platform: "android",
    kind: device.kind,
    name: device.name,
    model: device.model,
    state: device.state,
    capabilities: androidDeviceCapabilities(),
  }));
};

export const removeAdbForward = (deviceId: string, localPort: number) => {
  try {
    runAdbCommand(["-s", deviceId, "forward", "--remove", `tcp:${localPort}`]);
  } catch {
    // Ignore cleanup failures for ephemeral forwarded ports.
  }
};

export const getAndroidDevice = async (
  deviceId: string,
): Promise<DeviceSummary | null> => {
  const devices = await listAndroidDevices();
  return devices.find((device) => device.id === deviceId) ?? null;
};

export const ensureAndroidPackageInstalled = (
  deviceId: string,
  appId: string,
) => {
  const output = runAdbForDevice(deviceId, ["shell", "pm", "path", appId]).trim();
  if (!output.startsWith("package:")) {
    throw new HarnessError(
      "invalid_input",
      `App "${appId}" is not installed on device "${deviceId}".`,
      { deviceId, appId },
    );
  }
};

export const launchAndroidApp = (deviceId: string, appId: string) => {
  runAdbForDevice(deviceId, [
    "shell",
    "monkey",
    "-p",
    appId,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
};

export const getAndroidAppPid = (
  deviceId: string,
  appId: string,
): string | null => {
  const output = tryRunAdbForDevice(deviceId, [
    "shell",
    "pidof",
    appId,
  ])?.trim();
  if (!output) {
    return null;
  }

  return output.split(/\s+/)[0] ?? null;
};

export const captureAndroidDeviceScreenshot = async (
  deviceId: string,
  outputPath: string,
) => {
  const adbPath = getAdbPath();
  const subprocess = Bun.spawn(
    [adbPath, "-s", deviceId, "exec-out", "screencap", "-p"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (!subprocess.stdout) {
    throw new HarnessError(
      "command_failed",
      "adb did not expose stdout for screenshot capture.",
    );
  }

  const screenshotBuffer = await new Response(subprocess.stdout).arrayBuffer();
  const exitCode = await subprocess.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(subprocess.stderr).text();
    throw new HarnessError(
      "command_failed",
      stderr.trim() ||
        `adb screenshot capture failed with exit code ${exitCode}.`,
      { exitCode },
    );
  }

  await Bun.write(outputPath, screenshotBuffer);
};

export const spawnAndroidLogcat = (
  deviceId: string,
  appId: string,
): Bun.Subprocess => {
  const adbPath = getAdbPath();
  const pid = getAndroidAppPid(deviceId, appId);
  const args = ["-s", deviceId, "logcat", "-v", "time"];

  if (pid) {
    args.push("--pid", pid);
  }

  return Bun.spawn([adbPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
};
