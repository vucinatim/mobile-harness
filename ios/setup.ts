import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { HarnessError, missingDependency } from "../core/errors.ts";
import { isPyMobileDeviceTunnelRunning } from "./pymobiledevice.ts";
import { listIOSDevices } from "./devicectl.ts";

const LAUNCH_DAEMON_LABEL =
  "dev.vucinatim.mobile-harness.ios-tunneld";
const LAUNCH_DAEMON_PATH = `/Library/LaunchDaemons/${LAUNCH_DAEMON_LABEL}.plist`;
const DEFAULT_LOG_PATH = "/var/log/mobile-harness-ios-tunneld.log";

export type IOSBootstrapStatus = {
  ready: boolean;
  uvxInstalled: boolean;
  tunnelRunning: boolean;
  checkedDeviceId?: string;
  launchDaemonInstalled: boolean;
  launchDaemonLoaded: boolean;
  canBootstrapAutomatically: boolean;
  requiresRootBootstrap: boolean;
  manualBootstrapCommand?: string;
  launchDaemonPath: string;
  launchDaemonLabel: string;
  nextStep?: string;
};

const getUvxPath = (): string => {
  const uvxPath = Bun.which("uvx");
  if (!uvxPath) {
    throw missingDependency("uvx");
  }

  return uvxPath;
};

const runCommand = (
  command: string[],
  options?: {
    env?: Record<string, string>;
  },
) => {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...options?.env,
    },
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

const runCommandOrThrow = (
  command: string[],
  options?: {
    env?: Record<string, string>;
  },
) => {
  const result = runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new HarnessError(
      "command_failed",
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${command.join(" ")} failed with exit code ${result.exitCode}.`,
      { exitCode: result.exitCode },
    );
  }

  return result;
};

const runSudoCommandOrThrow = (
  command: string[],
  options?: {
    env?: Record<string, string>;
  },
) =>
  runCommandOrThrow(
    ["sudo", "-n", ...command],
    options,
  );

const launchDaemonInstalled = async () => {
  return await Bun.file(LAUNCH_DAEMON_PATH).exists();
};

const launchDaemonLoaded = () => {
  const result = runCommand([
    "launchctl",
    "print",
    `system/${LAUNCH_DAEMON_LABEL}`,
  ]);

  return result.exitCode === 0;
};

const canBootstrapAutomatically = () => {
  const sudoResult = runCommand(["sudo", "-n", "true"]);
  return sudoResult.exitCode === 0;
};

const currentCommandSuggestion = () => {
  const bunPath = Bun.which("bun");
  if (bunPath) {
    return `sudo ${bunPath} run mobile-harness setup ios --bootstrap-system`;
  }

  return "sudo mobile-harness setup ios --bootstrap-system";
};

const readLaunchDaemonLog = async () => {
  try {
    return await Bun.file(DEFAULT_LOG_PATH).text();
  } catch {
    return "";
  }
};

const getBootstrapNextStep = async ({
  daemonLoaded,
  tunnelRunning,
}: {
  daemonLoaded: boolean;
  tunnelRunning: boolean;
}) => {
  if (tunnelRunning) {
    return undefined;
  }

  if (!daemonLoaded) {
    return "Run the one-time bootstrap command with sudo to install and start the iOS tunnel service.";
  }

  const logText = await readLaunchDaemonLog();
  if (logText.includes("Waiting user pairing consent")) {
    return "Unlock the iPhone, tap the trust/pairing prompt if it appears, keep the phone unlocked, then run `mobile-harness setup ios` again.";
  }

  return `Check the launch daemon log at ${DEFAULT_LOG_PATH} for the current iOS tunnel error.`;
};

const buildLaunchDaemonPlist = (uvxPath: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${uvxPath}</string>
    <string>--from</string>
    <string>pymobiledevice3</string>
    <string>pymobiledevice3</string>
    <string>remote</string>
    <string>tunneld</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DEFAULT_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${DEFAULT_LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? ""}</string>
  </dict>
</dict>
</plist>
`;

export const getIOSBootstrapStatus = async (): Promise<IOSBootstrapStatus> => {
  const uvxInstalled = !!Bun.which("uvx");
  const deviceId =
    process.env.MOBILE_HARNESS_IOS_UDID ??
    (await listIOSDevices())
      .find((device) => device.kind === "physical" && device.state === "connected")
      ?.id;
  const tunnelRunning = uvxInstalled && deviceId
    ? isPyMobileDeviceTunnelRunning(deviceId)
    : false;
  const daemonInstalled = await launchDaemonInstalled();
  const daemonLoaded = daemonInstalled ? launchDaemonLoaded() : false;
  const auto = uvxInstalled && canBootstrapAutomatically();
  const nextStep = await getBootstrapNextStep({
    daemonLoaded,
    tunnelRunning,
  });

  return {
    ready: tunnelRunning,
    uvxInstalled,
    tunnelRunning,
    checkedDeviceId: deviceId,
    launchDaemonInstalled: daemonInstalled,
    launchDaemonLoaded: daemonLoaded,
    canBootstrapAutomatically: auto,
    requiresRootBootstrap: uvxInstalled && !tunnelRunning,
    manualBootstrapCommand: uvxInstalled
      ? currentCommandSuggestion()
      : undefined,
    launchDaemonPath: LAUNCH_DAEMON_PATH,
    launchDaemonLabel: LAUNCH_DAEMON_LABEL,
    nextStep,
  };
};

export const bootstrapIOSHost = async () => {
  const uvxPath = getUvxPath();
  const tempPlistPath = path.join(
    os.tmpdir(),
    `mobile-harness-ios-tunneld-${crypto.randomUUID()}.plist`,
  );

  try {
    await Bun.write(tempPlistPath, buildLaunchDaemonPlist(uvxPath));

    runSudoCommandOrThrow([
      "install",
      "-m",
      "644",
      tempPlistPath,
      LAUNCH_DAEMON_PATH,
    ]);

    runCommand(["sudo", "-n", "launchctl", "bootout", "system", LAUNCH_DAEMON_PATH]);
    runSudoCommandOrThrow([
      "launchctl",
      "bootstrap",
      "system",
      LAUNCH_DAEMON_PATH,
    ]);
    runSudoCommandOrThrow([
      "launchctl",
      "kickstart",
      "-k",
      `system/${LAUNCH_DAEMON_LABEL}`,
    ]);
  } finally {
    await rm(tempPlistPath, { force: true });
  }

  const status = await getIOSBootstrapStatus();
  if (!status.tunnelRunning) {
    const pairingHint = status.nextStep;
    throw new HarnessError(
      "command_failed",
      pairingHint
        ? `Installed the iOS tunnel service, but it is not ready yet. ${pairingHint}`
        : "Installed the iOS tunnel service, but it is not running yet. Check the launch daemon log at /var/log/mobile-harness-ios-tunneld.log.",
    );
  }

  return status;
};
