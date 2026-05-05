import { HarnessError, missingDependency } from "../core/errors.ts";
import type { LogEvent } from "../core/types.ts";

const TUNNELD_URL = "http://127.0.0.1:49151/";

type TunnelEntry = {
  "tunnel-address"?: string;
  "tunnel-port"?: number;
};

type IOSProcessInfo = {
  pid: number | null;
  name: string | null;
};

const getUvxPath = (): string => {
  const uvxPath = Bun.which("uvx");
  if (!uvxPath) {
    throw missingDependency("uvx");
  }

  return uvxPath;
};

const runPyMobileDeviceCommand = (
  args: string[],
  options?: {
    env?: Record<string, string>;
    outputPath?: string;
    ignoredStderrPatterns?: string[];
  },
): string => {
  const uvxPath = getUvxPath();
  const result = Bun.spawnSync(
    [uvxPath, "--from", "pymobiledevice3", "pymobiledevice3", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options?.env,
      },
    },
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    const message = stderr || stdout;

    if (message.includes("Unable to connect to Tunneld")) {
      throw new HarnessError(
        "command_failed",
        "iOS developer services require pymobiledevice3 tunneld to be running. Start it with: sudo python3 -m pymobiledevice3 remote tunneld",
      );
    }

    throw new HarnessError(
      "command_failed",
      message ||
        `pymobiledevice3 ${args.join(" ")} failed with exit code ${result.exitCode}.`,
      { exitCode: result.exitCode },
    );
  }

  const stderr = result.stderr.toString().trim();
  if (
    stderr.includes("Unable to connect to Tunneld") ||
    (stderr.includes("ERROR ") &&
      !options?.ignoredStderrPatterns?.some((pattern) =>
        stderr.includes(pattern)
      ))
  ) {
    throw new HarnessError(
      "command_failed",
      stderr.includes("Unable to connect to Tunneld")
        ? "iOS developer services require pymobiledevice3 tunneld to be running. Start it with: sudo uvx --from pymobiledevice3 pymobiledevice3 remote tunneld"
        : stderr,
    );
  }

  if (options?.outputPath) {
    const file = Bun.file(options.outputPath);
    if (!file.size) {
      throw new HarnessError(
        "command_failed",
        `pymobiledevice3 did not produce the expected output file at "${options.outputPath}".`,
        { outputPath: options.outputPath },
      );
    }
  }

  return result.stdout.toString();
};

const spawnPyMobileDeviceCommand = (
  args: string[],
  options?: {
    env?: Record<string, string>;
  },
) => {
  const uvxPath = getUvxPath();
  return Bun.spawn(
    [uvxPath, "--from", "pymobiledevice3", "pymobiledevice3", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options?.env,
      },
    },
  );
};

export const hasPyMobileDeviceSupport = () => !!Bun.which("uvx");

export const getPyMobileDeviceRsd = async (
  deviceId: string,
): Promise<{ host: string; port: number } | null> => {
  try {
    const response = await fetch(TUNNELD_URL);
    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as Record<string, TunnelEntry[]>;
    const entry = payload[deviceId]?.[0];
    const host = entry?.["tunnel-address"];
    const port = entry?.["tunnel-port"];

    if (!host || !port) {
      return null;
    }

    return { host, port };
  } catch {
    return null;
  }
};

export const hasPyMobileDeviceTunnel = async (deviceId: string) =>
  (await getPyMobileDeviceRsd(deviceId)) !== null;

export const isPyMobileDeviceTunnelRunning = (deviceId: string) => {
  try {
    runPyMobileDeviceCommand([
      "developer",
      "core-device",
      "get-device-info",
      "--tunnel",
      deviceId,
    ]);
    return true;
  } catch {
    return false;
  }
};

export const captureIOSDeviceScreenshot = async (
  deviceId: string,
  outputPath: string,
) => {
  runPyMobileDeviceCommand(["mounter", "auto-mount", "--tunnel", deviceId], {
    env: {
      PYMOBILEDEVICE3_TUNNEL: deviceId,
      PYMOBILEDEVICE3_UDID: deviceId,
    },
    ignoredStderrPatterns: ["DeveloperDiskImage already mounted"],
  });

  const rsd = await getPyMobileDeviceRsd(deviceId);
  if (!rsd) {
    throw new HarnessError(
      "command_failed",
      "iOS screenshot capture could not resolve the active developer tunnel endpoint. Re-run `mobile-harness setup ios` and accept the trust/pairing prompt on the iPhone if it appears.",
    );
  }

  runPyMobileDeviceCommand(
    [
      "developer",
      "dvt",
      "screenshot",
      "--rsd",
      rsd.host,
      String(rsd.port),
      outputPath,
    ],
    {
      env: {
        PYMOBILEDEVICE3_UDID: deviceId,
      },
      outputPath,
    },
  );
};

export const getIOSAppProcessInfo = (
  deviceId: string,
  appId: string,
): IOSProcessInfo => {
  try {
    const output = runPyMobileDeviceCommand([
      "developer",
      "dvt",
      "proclist",
      "--tunnel",
      deviceId,
    ]).trim();
    const processes = JSON.parse(output) as Array<{
      bundleIdentifier?: string;
      name?: string;
      pid?: number;
    }>;
    const match = processes.find((entry) => entry.bundleIdentifier === appId);

    if (match) {
      return {
        pid:
          typeof match.pid === "number" && Number.isFinite(match.pid) && match.pid > 0
            ? match.pid
            : null,
        name: match.name ?? null,
      };
    }
  } catch {
    // Fall back to pid lookup below.
  }

  try {
    const output = runPyMobileDeviceCommand([
      "developer",
      "dvt",
      "process-id-for-bundle-id",
      "--tunnel",
      deviceId,
      appId,
    ]).trim();

    const pid = Number.parseInt(output, 10);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      name: null,
    };
  } catch {
    return {
      pid: null,
      name: null,
    };
  }
};

export const spawnIOSSyslog = (
  deviceId: string,
  appId: string,
  processInfo = getIOSAppProcessInfo(deviceId, appId),
) => {
  const args = [
    "syslog",
    "live",
    "--tunnel",
    deviceId,
  ];

  if (processInfo.pid) {
    args.push("--pid", String(processInfo.pid));
  } else if (processInfo.name) {
    args.push("--process-name", processInfo.name);
  } else {
    args.push("--format", "json");
  }

  return spawnPyMobileDeviceCommand(args, {
    env: {
      PYMOBILEDEVICE3_TUNNEL: deviceId,
      PYMOBILEDEVICE3_UDID: deviceId,
    },
  });
};

export const parseIOSSyslogLine = (line: string): LogEvent => {
  const normalizedLine = line.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const textMatch = normalizedLine.match(
    /^(\d{4}-\d{2}-\d{2}T\S+)\s+([^\s{]+)(?:\{([^}]*)\})?\[(\d+)\]\s+<([A-Z]+)>:\s+(.*)$/,
  );

  if (textMatch) {
    const [, timestamp, processName, subsystem, pid, level, message] = textMatch;
    return {
      timestamp,
      level: level.toLowerCase(),
      tag: subsystem || `${processName}[${pid}]`,
      message,
    };
  }

  try {
    const payload = JSON.parse(normalizedLine) as {
      timestamp?: string;
      level?: string;
      filename?: string;
      message?: string;
      label?: {
        subsystem?: string;
        category?: string;
      } | null;
    };

    const tag = payload.label?.subsystem || payload.filename;

    return {
      timestamp: payload.timestamp,
      level: payload.level?.toLowerCase(),
      tag,
      message: payload.message ?? normalizedLine,
    };
  } catch {
    return { message: normalizedLine };
  }
};
