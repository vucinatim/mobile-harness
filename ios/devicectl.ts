import { rm } from "node:fs/promises";
import type { DeviceKind, DeviceState, DeviceSummary } from "../core/types.ts";
import { HarnessError, missingDependency } from "../core/errors.ts";
import {
  iosPhaseOneCapabilities,
  iosPhaseThreeCapabilities,
} from "../core/capabilities.ts";
import {
  hasPyMobileDeviceSupport,
  isPyMobileDeviceTunnelRunning,
} from "./pymobiledevice.ts";

type DevicectlDevice = {
  identifier: string;
  hardwareProperties?: {
    udid?: string;
    marketingName?: string;
    productType?: string;
    reality?: string;
    platform?: string;
  };
  deviceProperties?: {
    name?: string;
    osVersionNumber?: string;
    bootState?: string;
  };
};

type DevicectlApp = {
  bundleIdentifier?: string;
  name?: string;
  version?: string;
  bundleVersion?: string;
};

type DevicectlListDevicesResult = {
  result?: {
    devices?: DevicectlDevice[];
  };
};

type DevicectlAppsResult = {
  result?: {
    apps?: DevicectlApp[];
  };
};

const getXcrunPath = (): string => {
  const xcrunPath = Bun.which("xcrun");
  if (!xcrunPath) {
    throw missingDependency("xcrun");
  }

  return xcrunPath;
};

const createTempJsonPath = (prefix: string) =>
  `/tmp/mobile-harness-${prefix}-${crypto.randomUUID()}.json`;

const runDevicectlJsonCommand = async <T>(args: string[]): Promise<T> => {
  const xcrunPath = getXcrunPath();
  const jsonOutputPath = createTempJsonPath("devicectl");

  try {
    const result = Bun.spawnSync(
      [xcrunPath, "devicectl", ...args, "--json-output", jsonOutputPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      const stdout = result.stdout.toString().trim();
      throw new HarnessError(
        "command_failed",
        stderr ||
          stdout ||
          `xcrun devicectl ${args.join(" ")} failed with exit code ${result.exitCode}.`,
        { exitCode: result.exitCode },
      );
    }

    const file = Bun.file(jsonOutputPath);
    if (!(await file.exists())) {
      throw new HarnessError(
        "command_failed",
        "xcrun devicectl did not produce the expected JSON output file.",
      );
    }

    return (await file.json()) as T;
  } finally {
    try {
      await rm(jsonOutputPath, { force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
  }
};

const parseDeviceKind = (device: DevicectlDevice): DeviceKind => {
  return device.hardwareProperties?.reality === "simulated"
    ? "simulator"
    : "physical";
};

const parseDeviceState = (device: DevicectlDevice): DeviceState => {
  const bootState = device.deviceProperties?.bootState;
  if (bootState === "booted") {
    return "connected";
  }

  return "disconnected";
};

const toDeviceSummary = (device: DevicectlDevice): DeviceSummary => {
  const udid = device.hardwareProperties?.udid;
  const identifier = udid || device.identifier;
  const name = device.deviceProperties?.name || identifier;
  const marketingName = device.hardwareProperties?.marketingName;
  const productType = device.hardwareProperties?.productType;

  return {
    id: identifier,
    platform: "ios",
    kind: parseDeviceKind(device),
    name,
    osVersion: device.deviceProperties?.osVersionNumber,
    model: marketingName || productType,
    state: parseDeviceState(device),
    capabilities:
      hasPyMobileDeviceSupport() && identifier
        ? isPyMobileDeviceTunnelRunning(identifier)
      ? iosPhaseThreeCapabilities()
        : iosPhaseOneCapabilities()
        : iosPhaseOneCapabilities(),
  };
};

export const listIOSDevices = async (): Promise<DeviceSummary[]> => {
  const result = await runDevicectlJsonCommand<DevicectlListDevicesResult>([
    "list",
    "devices",
    "--filter",
    "hardwareProperties.platform == 'iOS'",
  ]);

  const devices = result.result?.devices ?? [];
  return devices.map(toDeviceSummary);
};

export const getIOSDevice = async (
  deviceId: string,
): Promise<DeviceSummary | null> => {
  const devices = await listIOSDevices();
  return devices.find((device) => device.id === deviceId) ?? null;
};

export const ensureIOSAppInstalled = async (
  deviceId: string,
  appId: string,
): Promise<void> => {
  const result = await runDevicectlJsonCommand<DevicectlAppsResult>([
    "device",
    "info",
    "apps",
    "--device",
    deviceId,
    "--bundle-id",
    appId,
  ]);

  const apps = result.result?.apps ?? [];
  if (apps.length === 0) {
    throw new HarnessError(
      "invalid_input",
      `App "${appId}" is not installed on iOS device "${deviceId}".`,
      { deviceId, appId },
    );
  }
};

export const launchIOSApp = async (
  deviceId: string,
  appId: string,
): Promise<void> => {
  await runDevicectlJsonCommand([
    "device",
    "process",
    "launch",
    "--device",
    deviceId,
    appId,
  ]);
};
