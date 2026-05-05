import { HarnessError } from "../core/errors.ts";
import {
  captureSessionWebviewScreenshot,
  clearSessionUi,
  clickSessionUi,
  evalSessionJs,
  inspectSessionUi,
  listSessionWebviews,
  pressSessionUi,
  readSessionUi,
  resolveSessionId,
  snapshotSessionUi,
  streamSessionConsole,
  streamSessionNetwork,
  tapSessionUi,
  typeIntoSessionUi,
  waitForSessionUi,
} from "../core/operations.ts";
import { loadSession } from "../core/storage.ts";
import {
  getTimelineStatus,
  markTimeline,
  readTimeline,
  runRecordingWorker,
  resetTimeline,
} from "../core/timeline.ts";
import type {
  RecorderWorkerKind,
  RecordingReadDetail,
} from "../core/timeline-types.ts";
import { createSession, listDevices, parsePlatform } from "../core/registry.ts";
import { captureSessionScreenshot, tailSessionLogs } from "../core/registry.ts";
import { setupCapacitorIOSBridge } from "../ios/capacitor-setup.ts";
import { bootstrapIOSHost, getIOSBootstrapStatus } from "../ios/setup.ts";
import { bootstrapWda, getInstalledWdaRunnerBundleId } from "../ios/wda.ts";
import { ensureIOSBridgeCollector, runIOSBridgeCollector } from "../ios/bridge-collector.ts";
import type {
  AppSession,
  DeviceSummary,
  WebviewTarget,
} from "../core/types.ts";
import type {
  UiElementSnapshot,
  UiSelector,
  UiSnapshot,
  UiSnapshotDetail,
  UiTapOptions,
  UiWaitCondition,
} from "../core/ui-types.ts";

type ExplicitPlatform = Exclude<ReturnType<typeof parsePlatform>, "all">;

type CommandOptions = {
  platform: ReturnType<typeof parsePlatform>;
  json: boolean;
};

const printHelp = () => {
  console.log(`Mobile Harness

Usage:
  bun run mobile-harness devices list [--platform android|ios|all] [--json]
  bun run mobile-harness session attach --platform android|ios --device <serial> --app <appId> [--launch] [--json]
  bun run mobile-harness setup ios [--json]
  bun run mobile-harness setup ios --bootstrap-system [--json]
  bun run mobile-harness setup ios --bootstrap-wda [--device <udid>] [--team-id <TEAMID>] [--bundle-id <bundleId>] [--json]
  bun run mobile-harness setup capacitor ios [--project-root <path>] [--json]
  bun run mobile-harness logs tail [--session <id>] [--filter <text>]
  bun run mobile-harness screenshot [--session <id>] [--output <path>] [--json]
  bun run mobile-harness webviews list [--session <id>] [--json]
  bun run mobile-harness webviews screenshot [--session <id>] [--target <id>] [--output <path>] [--json]
  bun run mobile-harness js eval [--session <id>] [--target <id>] --expression <code> [--json]
  bun run mobile-harness console tail [--session <id>] [--target <id>] [--json]
  bun run mobile-harness network tail [--session <id>] [--target <id>] [--json]
  bun run mobile-harness timeline status [--session <id>] [--json]
  bun run mobile-harness timeline reset [--session <id>] [--target <id>] [--json]
  bun run mobile-harness timeline mark [--session <id>] --label <text> [--note <text>] [--json]
  bun run mobile-harness timeline read [--session <id>] [--since-marker <label>] [--last <n>] [--detail summary|standard|full] [--errors-only] [--json]
  bun run mobile-harness ui snapshot [--session <id>] [--target <id>] [--detail summary|standard|full] [--json]
  bun run mobile-harness ui inspect [--session <id>] [--target <id>] (--element <id> | --text <text> | --name <name> | --placeholder <text> | --selector <css>) [--role <role>] [--json]
  bun run mobile-harness ui click [--session <id>] [--target <id>] (--element <id> | --text <text> | --name <name> | --placeholder <text> | --selector <css>) [--role <role>] [--json]
  bun run mobile-harness ui tap [--session <id>] [--target <id>] --x <px> --y <px> [--json]
  bun run mobile-harness ui type [--session <id>] [--target <id>] (--element <id> | --name <name> | --placeholder <text> | --selector <css>) --text <value> [--append] [--submit] [--json]
  bun run mobile-harness ui clear [--session <id>] [--target <id>] (--element <id> | --name <name> | --placeholder <text> | --selector <css>) [--json]
  bun run mobile-harness ui press [--session <id>] [--target <id>] (--element <id> | --text <text> | --name <name> | --placeholder <text> | --selector <css>) --key <key> [--code <code>] [--json]
  bun run mobile-harness ui read [--session <id>] [--target <id>] (--element <id> | --text <text> | --name <name> | --placeholder <text> | --selector <css>) [--role <role>] [--json]
  bun run mobile-harness ui wait-for [--session <id>] [--target <id>] [--text <text> | --url <substring> | selector flags] [--state visible|hidden|enabled|disabled] [--timeout <ms>] [--interval <ms>] [--json]

Notes:
  Session defaults to the most recent attached session when omitted.
  Session attach automatically starts the rolling session timeline.
  WebView target defaults to the single attached or only available target when omitted.
`);
};

const parseOptions = (args: string[]): CommandOptions => {
  let platform: ReturnType<typeof parsePlatform> = "all";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--platform") {
      platform = parsePlatform(args[index + 1]);
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  return { platform, json };
};

const formatDevicesTable = (devices: DeviceSummary[]) =>
  devices.map((device) => ({
    id: device.id,
    platform: device.platform,
    kind: device.kind,
    state: device.state,
    name: device.name,
    model: device.model ?? "",
  }));

const runDevicesList = async (args: string[]) => {
  const options = parseOptions(args);
  const devices = await listDevices(options.platform);

  if (options.json) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }

  if (devices.length === 0) {
    console.log("No devices found.");
    return;
  }

  console.table(formatDevicesTable(devices));
};

type SessionAttachOptions = {
  platform: ExplicitPlatform;
  deviceId: string;
  appId: string;
  launchApp: boolean;
  json: boolean;
};

const parseSessionAttachOptions = (args: string[]): SessionAttachOptions => {
  let platform: ReturnType<typeof parsePlatform> = "all";
  let deviceId = "";
  let appId = "";
  let launchApp = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--launch") {
      launchApp = true;
      continue;
    }

    if (arg === "--platform") {
      platform = parsePlatform(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--device") {
      deviceId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--app") {
      appId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  if (platform !== "android" && platform !== "ios") {
    throw new HarnessError(
      "invalid_input",
      "Session attachment requires an explicit --platform value of android or ios.",
    );
  }

  if (!deviceId) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --device <serial>.",
    );
  }

  if (!appId) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --app <appId>.",
    );
  }

  return { platform, deviceId, appId, launchApp, json };
};

const printSession = (session: AppSession) => {
  console.log(`Attached session ${session.id}`);
  console.log(`  platform: ${session.platform}`);
  console.log(`  device:   ${session.deviceId}`);
  console.log(`  app:      ${session.appId}`);
  console.log(`  started:  ${session.startedAt}`);
  console.log(`  timeline: active`);
};

const runSessionAttach = async (args: string[]) => {
  const options = parseSessionAttachOptions(args);
  const session = await createSession(options.platform, {
    deviceId: options.deviceId,
    appId: options.appId,
    launchApp: options.launchApp,
  });

  if (options.json) {
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  printSession(session);
};

const runSetupIOS = async (args: string[]) => {
  let json = false;
  let bootstrapSystem = false;
  let bootstrapWdaRunner = false;
  let deviceId: string | undefined;
  let teamId: string | undefined;
  let bundleId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--bootstrap-system") {
      bootstrapSystem = true;
      continue;
    }

    if (arg === "--bootstrap-wda") {
      bootstrapWdaRunner = true;
      continue;
    }

    if (arg === "--device") {
      deviceId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--team-id") {
      teamId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--bundle-id") {
      bundleId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  if (bootstrapSystem) {
    const isRoot =
      typeof process.getuid === "function" ? process.getuid() === 0 : false;

    if (!isRoot) {
      const status = await getIOSBootstrapStatus();
      throw new HarnessError(
        "invalid_input",
        `System bootstrap must be run as root. Re-run once with: ${status.manualBootstrapCommand ?? "sudo mobile-harness setup ios --bootstrap-system"}`,
      );
    }

    const status = await bootstrapIOSHost();
    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log("Installed and started the iOS tunneld launch daemon.");
    console.log(`Label: ${status.launchDaemonLabel}`);
    console.log(`Path:  ${status.launchDaemonPath}`);
    return;
  }

  if (bootstrapWdaRunner) {
    const status = await getIOSBootstrapStatus();
    const resolvedDeviceId = deviceId ?? status.checkedDeviceId;
    if (!resolvedDeviceId) {
      throw new HarnessError(
        "invalid_input",
        "Could not determine the connected iPhone for WDA bootstrap. Pass --device <udid>.",
      );
    }

    const result = await bootstrapWda(resolvedDeviceId, {
      teamId,
      bundleId,
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Installed the iOS WDA runner.");
    console.log(`Device:      ${resolvedDeviceId}`);
    console.log(`Bundle:      ${result.xctrunnerBundleId}`);
    console.log(`Source:      ${result.sourceRoot}`);
    console.log(`Built app:   ${result.appPath}`);
    console.log("If iOS shows an untrusted developer prompt, trust the developer in Settings -> General -> VPN & Device Management, then retry the UI command.");
    return;
  }

  const status = await getIOSBootstrapStatus();
  const installedWdaRunner = status.ready && status.checkedDeviceId
    ? await getInstalledWdaRunnerBundleId(status.checkedDeviceId)
    : null;

  if (status.ready) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            ...status,
            wdaInstalledBundleId: installedWdaRunner,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log("iOS host bootstrap is ready.");
    console.log(`Tunnel: ${status.tunnelRunning ? "running" : "stopped"}`);
    console.log(`WDA:    ${installedWdaRunner ?? "not installed"}`);
    return;
  }

  if (status.canBootstrapAutomatically) {
    const nextStatus = await bootstrapIOSHost();
    if (json) {
      console.log(JSON.stringify(nextStatus, null, 2));
      return;
    }

    console.log("Installed and started the iOS tunneld launch daemon.");
    console.log(`Label: ${nextStatus.launchDaemonLabel}`);
    console.log(`Path:  ${nextStatus.launchDaemonPath}`);
    return;
  }

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log("iOS host bootstrap is not ready yet.");
  console.log(`uvx installed:   ${status.uvxInstalled ? "yes" : "no"}`);
  console.log(`tunnel running:  ${status.tunnelRunning ? "yes" : "no"}`);
  console.log(`daemon installed:${status.launchDaemonInstalled ? "yes" : "no"}`);
  console.log("");
  if (status.nextStep) {
    console.log(status.nextStep);
    console.log("");
  }
  console.log("Run this once:");
  console.log(
    status.manualBootstrapCommand ??
      "sudo mobile-harness setup ios --bootstrap-system",
  );
};

const runSetupCapacitorIOS = async (args: string[]) => {
  let json = false;
  let projectRoot: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--project-root") {
      projectRoot = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  const result = await setupCapacitorIOSBridge(projectRoot);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.changedFiles.length === 0) {
    console.log("Capacitor iOS bridge is already current.");
  } else {
    console.log("Installed the Capacitor iOS mobile-harness bridge.");
  }
  console.log(`Project: ${result.projectRoot}`);
  console.log(`Module:  ${result.moduleName}`);
  console.log(`Bridge:  ${result.bridgeFilePath}`);
  if (result.changedFiles.length > 0) {
    console.log("Changed:");
    for (const filePath of result.changedFiles) {
      console.log(`  - ${filePath}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
};

type SessionRefOptions = {
  sessionId?: string;
  json: boolean;
};

const parseSessionRefOptions = (args: string[]): SessionRefOptions => {
  let sessionId: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  return { sessionId, json };
};

type TailLogsCliOptions = {
  sessionId?: string;
  filter?: string;
};

const parseTailLogsOptions = (args: string[]): TailLogsCliOptions => {
  let sessionId: string | undefined;
  let filter: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--filter") {
      filter = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  return { sessionId, filter };
};

const runLogsTail = async (args: string[]) => {
  const options = parseTailLogsOptions(args);
  const resolvedSessionId = await resolveSessionId(options.sessionId);
  const stream = await tailSessionLogs(resolvedSessionId, {
    filter: options.filter,
  });

  for await (const event of stream) {
    console.log(event.message);
  }
};

type ScreenshotCliOptions = {
  sessionId?: string;
  outputPath?: string;
  json: boolean;
};

const parseScreenshotOptions = (args: string[]): ScreenshotCliOptions => {
  let sessionId: string | undefined;
  let outputPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--output") {
      outputPath = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  return { sessionId, outputPath, json };
};

const runScreenshot = async (args: string[]) => {
  const options = parseScreenshotOptions(args);
  const resolvedSessionId = await resolveSessionId(options.sessionId);
  const artifact = await captureSessionScreenshot(resolvedSessionId, {
    outputPath: options.outputPath,
  });

  if (options.json) {
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

  console.log(`Saved screenshot to ${artifact.path}`);
};

const formatWebviewsTable = (targets: WebviewTarget[]) =>
  targets.map((target) => ({
    id: target.id,
    attached: target.attached,
    title: target.title ?? "",
    url: target.url ?? "",
  }));

const runWebviewsList = async (args: string[]) => {
  const options = parseSessionRefOptions(args);
  const targets = await listSessionWebviews(options.sessionId);

  if (options.json) {
    console.log(JSON.stringify(targets, null, 2));
    return;
  }

  if (targets.length === 0) {
    console.log("No WebView targets found.");
    return;
  }

  console.table(formatWebviewsTable(targets));
};

type TargetRefOptions = {
  sessionId?: string;
  targetId?: string;
  detail?: UiSnapshotDetail;
  json: boolean;
};

const parseTargetRefOptions = (args: string[]): TargetRefOptions => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let detail: UiSnapshotDetail | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--detail") {
      const value = args[index + 1] ?? "";
      if (value !== "summary" && value !== "standard" && value !== "full") {
        throw new HarnessError(
          "invalid_input",
          'Invalid --detail value. Use "summary", "standard", or "full".',
        );
      }
      detail = value;
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  return { sessionId, targetId, detail, json };
};

const runWebviewScreenshot = async (args: string[]) => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let outputPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--output") {
      outputPath = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  const artifact = await captureSessionWebviewScreenshot(sessionId, targetId, {
    outputPath,
  });

  if (json) {
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

  console.log(`Saved WebView screenshot to ${artifact.path}`);
};

type JsEvalOptions = {
  sessionId?: string;
  targetId?: string;
  expression: string;
  json: boolean;
};

const parseJsEvalOptions = (args: string[]): JsEvalOptions => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let expression = "";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--expression") {
      expression = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  if (!expression) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --expression <code>.",
    );
  }

  return { sessionId, targetId, expression, json };
};

const runJsEval = async (args: string[]) => {
  const options = parseJsEvalOptions(args);
  const result = await evalSessionJs(
    options.sessionId,
    options.targetId,
    options.expression,
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value, null, 2),
  );
};

const runConsoleTail = async (args: string[]) => {
  const options = parseTargetRefOptions(args);
  const stream = await streamSessionConsole(options.sessionId, options.targetId);

  for await (const event of stream) {
    if (options.json) {
      console.log(JSON.stringify(event));
      continue;
    }

    console.log(`[${event.type}] ${event.args.join(" ")}`.trim());
  }
};

const runNetworkTail = async (args: string[]) => {
  const options = parseTargetRefOptions(args);
  const stream = await streamSessionNetwork(options.sessionId, options.targetId);

  for await (const event of stream) {
    if (options.json) {
      console.log(JSON.stringify(event));
      continue;
    }

    if (event.stage === "request") {
      console.log(`[request] ${event.method} ${event.url}`);
      continue;
    }

    if (event.stage === "response") {
      console.log(
        `[response] ${event.status ?? ""} ${event.method} ${event.url}`.trim(),
      );
      continue;
    }

    console.log(
      `[failed] ${event.method} ${event.url} ${event.errorText ?? ""}`.trim(),
    );
  }
};

type RecordBaseOptions = {
  sessionId?: string;
  targetId?: string;
  json: boolean;
};

const parseRecordBaseOptions = (args: string[]): RecordBaseOptions => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  return { sessionId, targetId, json };
};

const runTimelineReset = async (args: string[]) => {
  const options = parseRecordBaseOptions(args);
  const sessionId = await resolveSessionId(options.sessionId);
  const state = await resetTimeline(sessionId, options.targetId);
  const session = await loadSession(sessionId);
  if (session.platform === "ios" && session.integrations?.capacitorIOSBridge) {
    await ensureIOSBridgeCollector();
  }

  if (options.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(`Reset timeline for session ${state.sessionId}`);
  console.log(`Target: ${state.targetId}`);
};

const runTimelineStatus = async (args: string[]) => {
  const options = parseRecordBaseOptions(args);
  const sessionId = await resolveSessionId(options.sessionId);
  const status = await getTimelineStatus(sessionId);

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status) {
    console.log(`No timeline found for session ${sessionId}.`);
    return;
  }

  console.log(`Session: ${status.sessionId}`);
  console.log(`Active:  ${status.active ? "yes" : "no"}`);
  console.log(`Target:  ${status.targetId}`);
  console.log(`Started: ${status.startedAt}`);
  if (status.stoppedAt) {
    console.log(`Stopped: ${status.stoppedAt}`);
  }
  console.log("");
  console.table(status.workers);
};

const runTimelineMark = async (args: string[]) => {
  let sessionId: string | undefined;
  let json = false;
  let label = "";
  let note: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--label") {
      label = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--note") {
      note = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  if (!label) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --label <text>.",
    );
  }

  const resolvedSessionId = await resolveSessionId(sessionId);
  const event = await markTimeline(resolvedSessionId, label, note);

  if (json) {
    console.log(JSON.stringify(event, null, 2));
    return;
  }

  console.log(`Added marker "${event.label}" to session ${resolvedSessionId}.`);
};

const runTimelineRead = async (args: string[]) => {
  let sessionId: string | undefined;
  let json = false;
  let sinceMarker: string | undefined;
  let last: number | undefined;
  let detail: RecordingReadDetail | undefined;
  let errorsOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--since-marker") {
      sinceMarker = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--last") {
      last = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--detail") {
      const value = args[index + 1] ?? "";
      if (value !== "summary" && value !== "standard" && value !== "full") {
        throw new HarnessError(
          "invalid_input",
          'Invalid --detail value. Use "summary", "standard", or "full".',
        );
      }
      detail = value;
      index += 1;
      continue;
    }
    if (arg === "--errors-only") {
      errorsOnly = true;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  const resolvedSessionId = await resolveSessionId(sessionId);
  const result = await readTimeline(resolvedSessionId, {
    sinceMarker,
    last,
    detail,
    errorsOnly,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Session: ${resolvedSessionId}`);
  console.log(`Active:  ${result.summary.active ? "yes" : "no"}`);
  console.log(`Events:  ${result.summary.returnedEvents}/${result.summary.totalEvents}`);
  if (sinceMarker) {
    console.log(`Since:   marker "${sinceMarker}"`);
  }

  if (result.summary.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    console.table(result.summary.errors);
  }

  if (result.summary.networkFailures.length > 0) {
    console.log("");
    console.log("Network failures:");
    console.table(result.summary.networkFailures);
  }

  if (result.summary.actions.length > 0) {
    console.log("");
    console.log("Actions:");
    console.table(result.summary.actions);
  }

  if (result.events && result.events.length > 0) {
    console.log("");
    console.log("Events:");
    console.table(
      result.events.map((event) => ({
        timestamp: event.timestamp,
        kind: event.kind,
        severity: event.severity,
        summary: event.summary,
      })),
    );
  }
};

const runRecordWorker = async (args: string[]) => {
  const [kind, ...rest] = args;
  if (
    kind !== "nativeLog" &&
    kind !== "console" &&
    kind !== "network"
  ) {
    throw new HarnessError(
      "invalid_input",
      `Unknown timeline worker kind "${kind ?? ""}".`,
    );
  }

  let sessionId = "";
  let targetId = "";

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--session") {
      sessionId = rest[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--target") {
      targetId = rest[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  if (!sessionId || !targetId) {
    throw new HarnessError(
      "invalid_input",
      "timeline worker requires --session <id> and --target <id>.",
    );
  }

  await runRecordingWorker(kind as RecorderWorkerKind, sessionId, targetId);
};

type UiSelectorOptions = {
  selector: UiSelector;
  json: boolean;
  sessionId?: string;
  targetId?: string;
};

type UiTapCliOptions = {
  point: UiTapOptions;
  json: boolean;
  sessionId?: string;
  targetId?: string;
};

const parseUiSelectorOptions = (
  args: string[],
  options?: {
    allowText?: boolean;
  },
): UiSelectorOptions => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let json = false;
  let elementId: string | undefined;
  let selector: string | undefined;
  let text: string | undefined;
  let role: UiSelector["role"];
  let name: string | undefined;
  let placeholder: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--element") {
      elementId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--selector") {
      selector = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--text" && options?.allowText !== false) {
      text = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--role") {
      role = (args[index + 1] as UiSelector["role"]) ?? undefined;
      index += 1;
      continue;
    }

    if (arg === "--name") {
      name = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--placeholder") {
      placeholder = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  const uiSelector: UiSelector = {
    elementId,
    selector,
    text,
    role,
    name,
    placeholder,
  };

  if (!elementId && !selector && !text && !name && !placeholder) {
    throw new HarnessError(
      "invalid_input",
      "A UI selector is required. Pass --element, --selector, --text, --name, or --placeholder.",
    );
  }

  return {
    sessionId,
    targetId,
    selector: uiSelector,
    json,
  };
};

const parseUiTapOptions = (args: string[]): UiTapCliOptions => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let json = false;
  let x: number | undefined;
  let y: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--x") {
      x = Number.parseFloat(args[index + 1] ?? "");
      index += 1;
      continue;
    }

    if (arg === "--y") {
      y = Number.parseFloat(args[index + 1] ?? "");
      index += 1;
      continue;
    }

    throw new HarnessError("invalid_input", `Unknown option "${arg}".`, {
      arg,
    });
  }

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new HarnessError(
      "invalid_input",
      "ui tap requires numeric --x <px> and --y <px> values.",
    );
  }

  return {
    sessionId,
    targetId,
    point: { x: x!, y: y! },
    json,
  };
};

const printUiElements = (elements: UiElementSnapshot[]) => {
  console.table(
    elements.map((element) => ({
      id: element.id,
      role: element.role,
      text: element.text ?? "",
      name: element.name ?? "",
      placeholder: element.placeholder ?? "",
      value: element.value ?? "",
      enabled: element.enabled,
      visible: element.visible,
      x: element.bounds?.x ?? "",
      y: element.bounds?.y ?? "",
      width: element.bounds?.width ?? "",
      height: element.bounds?.height ?? "",
    })),
  );
};

const printUiSnapshotSummary = (snapshot: UiSnapshot) => {
  console.log(`Screen:  ${snapshot.screen}`);
  console.log(`Route:   ${snapshot.route}`);
  console.log(`URL:     ${snapshot.url}`);
  console.log(`Title:   ${snapshot.title}`);
  console.log(`Status:  ${snapshot.status}`);
  if (snapshot.selectedTab) {
    console.log(`Tab:     ${snapshot.selectedTab}`);
  }
  console.log(`Back:    ${snapshot.canGoBack ? "yes" : "no"}`);
  if (snapshot.blockingMessage) {
    console.log(`Blocker: ${snapshot.blockingMessage}`);
  }

  if (snapshot.primaryActions.length > 0) {
    console.log("");
    console.log("Primary actions:");
    console.table(
      snapshot.primaryActions.map((action) => ({
        id: action.id,
        role: action.role,
        label: action.label,
        enabled: action.enabled,
        selected: action.selected ?? false,
      })),
    );
  }

  if (snapshot.inputs.length > 0) {
    console.log("");
    console.log("Inputs:");
    console.table(
      snapshot.inputs.map((input) => ({
        id: input.id,
        kind: input.kind,
        name: input.name ?? "",
        label: input.label ?? "",
        placeholder: input.placeholder ?? "",
        valuePreview: input.valuePreview ?? "",
        empty: input.empty,
        focused: input.focused,
      })),
    );
  }
};

const runUiSnapshot = async (args: string[]) => {
  const options = parseTargetRefOptions(args);
  const resolved = await snapshotSessionUi(options.sessionId, options.targetId, {
    detail: options.detail,
  });

  if (options.json) {
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }

  console.log(`Session: ${resolved.sessionId}`);
  console.log(`Target:  ${resolved.targetId}`);
  printUiSnapshotSummary(resolved.snapshot);

  if (resolved.snapshot.elements && resolved.snapshot.elements.length > 0) {
    console.log("");
    console.log("Elements:");
    printUiElements(resolved.snapshot.elements);
  }

  if (resolved.snapshot.textBlocks && resolved.snapshot.textBlocks.length > 0) {
    console.log("");
    console.log("Text blocks:");
    console.table(
      resolved.snapshot.textBlocks.map((block) => ({
        id: block.id,
        kind: block.kind,
        text: block.text,
      })),
    );
  }
};

const runUiInspect = async (args: string[]) => {
  const options = parseUiSelectorOptions(args);
  const result = await inspectSessionUi(
    options.selector,
    options.sessionId,
    options.targetId,
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Session: ${result.sessionId}`);
  console.log(`Target:  ${result.targetId}`);
  console.log(`Screen:  ${result.result.screen}`);
  console.log(`Route:   ${result.result.route}`);
  console.log(`Title:   ${result.result.title}`);
  console.log("");
  console.table([
    {
      id: result.result.matchedElement.id,
      role: result.result.matchedElement.role,
      text: result.result.matchedElement.text ?? "",
      label: result.result.matchedElement.label ?? "",
      name: result.result.matchedElement.name ?? "",
      placeholder: result.result.matchedElement.placeholder ?? "",
      value: result.result.matchedElement.value ?? "",
      enabled: result.result.matchedElement.enabled,
      visible: result.result.matchedElement.visible,
      x: result.result.matchedElement.bounds?.x ?? "",
      y: result.result.matchedElement.bounds?.y ?? "",
      width: result.result.matchedElement.bounds?.width ?? "",
      height: result.result.matchedElement.bounds?.height ?? "",
    },
  ]);
};

const runUiClick = async (args: string[]) => {
  const options = parseUiSelectorOptions(args);
  const result = await clickSessionUi(
    options.selector,
    options.sessionId,
    options.targetId,
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Clicked ${result.result.matchedElement?.role ?? "element"} on target ${result.targetId}.`,
  );
};

const runUiTap = async (args: string[]) => {
  const options = parseUiTapOptions(args);
  const result = await tapSessionUi(
    options.point,
    options.sessionId,
    options.targetId,
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Tapped (${options.point.x}, ${options.point.y}) on target ${result.targetId}.`);
};

const runUiType = async (args: string[]) => {
  let text = "";
  let append = false;
  let submit = false;
  const selectorArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--text") {
      text = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--append") {
      append = true;
      continue;
    }
    if (arg === "--submit") {
      submit = true;
      continue;
    }

    if (!arg) {
      continue;
    }

    selectorArgs.push(arg);
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        selectorArgs.push(next);
        index += 1;
      }
    }
  }

  if (!text) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --text <value>.",
    );
  }

  const selectorOptions = parseUiSelectorOptions(selectorArgs, {
    allowText: false,
  });

  const result = await typeIntoSessionUi(
    selectorOptions.selector,
    text,
    selectorOptions.sessionId,
    selectorOptions.targetId,
    { append, submit },
  );

  if (selectorOptions.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Typed into ${result.result.matchedElement?.role ?? "element"} on target ${result.targetId}.`,
  );
};

const runUiClear = async (args: string[]) => {
  const options = parseUiSelectorOptions(args);
  const result = await clearSessionUi(
    options.selector,
    options.sessionId,
    options.targetId,
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Cleared ${result.result.matchedElement?.role ?? "element"} on target ${result.targetId}.`,
  );
};

const runUiPress = async (args: string[]) => {
  let key = "";
  let code: string | undefined;
  const selectorArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--key") {
      key = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--code") {
      code = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (!arg) {
      continue;
    }

    selectorArgs.push(arg);
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        selectorArgs.push(next);
        index += 1;
      }
    }
  }

  if (!key) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --key <key>.",
    );
  }

  const selectorOptions = parseUiSelectorOptions(selectorArgs);

  const result = await pressSessionUi(
    selectorOptions.selector,
    { key, code },
    selectorOptions.sessionId,
    selectorOptions.targetId,
  );

  if (selectorOptions.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Pressed ${key} on ${result.result.matchedElement?.role ?? "element"} in target ${result.targetId}.`,
  );
};

const runUiRead = async (args: string[]) => {
  const options = parseUiSelectorOptions(args);
  const result = await readSessionUi(
    options.selector,
    options.sessionId,
    options.targetId,
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify(result.result.matchedElement, null, 2));
};

const runUiWaitFor = async (args: string[]) => {
  let sessionId: string | undefined;
  let targetId: string | undefined;
  let json = false;
  let text: string | undefined;
  let urlIncludes: string | undefined;
  let state: UiWaitCondition["state"];
  let timeoutMs: number | undefined;
  let intervalMs: number | undefined;
  let selectorArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      sessionId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetId = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--text") {
      text = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--url") {
      urlIncludes = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--state") {
      state = (args[index + 1] as UiWaitCondition["state"]) ?? undefined;
      index += 1;
      continue;
    }

    if (arg === "--timeout") {
      timeoutMs = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (arg === "--interval") {
      intervalMs = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      continue;
    }

    if (!arg) {
      continue;
    }

    selectorArgs.push(arg);
    if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        selectorArgs.push(next);
        index += 1;
      }
    }
  }

  const condition: UiWaitCondition = {
    text,
    urlIncludes,
    state,
    timeoutMs,
    intervalMs,
  };

  if (selectorArgs.length > 0) {
    condition.element = parseUiSelectorOptions(selectorArgs).selector;
  }

  if (!condition.text && !condition.urlIncludes && !condition.element) {
    throw new HarnessError(
      "invalid_input",
      "ui wait-for requires --text, --url, or a UI selector.",
    );
  }

  const result = await waitForSessionUi(condition, sessionId, targetId);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    result.result.satisfied
      ? `Condition satisfied after ${result.result.elapsedMs}ms.`
      : `Condition timed out after ${result.result.elapsedMs}ms.`,
  );
};

const main = async () => {
  const args = process.argv.slice(2);
  const [command, subcommand, subsubcommand] = args;

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "devices" && subcommand === "list") {
    await runDevicesList(args.slice(2));
    return;
  }

  if (command === "session" && subcommand === "attach") {
    await runSessionAttach(args.slice(2));
    return;
  }

  if (command === "setup" && subcommand === "ios") {
    await runSetupIOS(args.slice(2));
    return;
  }

  if (command === "setup" && subcommand === "capacitor" && subsubcommand === "ios") {
    await runSetupCapacitorIOS(args.slice(3));
    return;
  }

  if (command === "logs" && subcommand === "tail") {
    await runLogsTail(args.slice(2));
    return;
  }

  if (command === "screenshot") {
    await runScreenshot(args.slice(1));
    return;
  }

  if (command === "webviews" && subcommand === "list") {
    await runWebviewsList(args.slice(2));
    return;
  }

  if (command === "webviews" && subcommand === "screenshot") {
    await runWebviewScreenshot(args.slice(2));
    return;
  }

  if (command === "js" && subcommand === "eval") {
    await runJsEval(args.slice(2));
    return;
  }

  if (command === "console" && subcommand === "tail") {
    await runConsoleTail(args.slice(2));
    return;
  }

  if (command === "network" && subcommand === "tail") {
    await runNetworkTail(args.slice(2));
    return;
  }

  if (command === "timeline" && subcommand === "status") {
    await runTimelineStatus(args.slice(2));
    return;
  }

  if (command === "timeline" && subcommand === "reset") {
    await runTimelineReset(args.slice(2));
    return;
  }

  if (command === "timeline" && subcommand === "mark") {
    await runTimelineMark(args.slice(2));
    return;
  }

  if (command === "timeline" && subcommand === "read") {
    await runTimelineRead(args.slice(2));
    return;
  }

  if (command === "__timeline-worker") {
    await runRecordWorker(args.slice(1));
    return;
  }

  if (command === "__ios-bridge-collector") {
    await runIOSBridgeCollector();
    return;
  }

  if (command === "ui" && subcommand === "snapshot") {
    await runUiSnapshot(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "inspect") {
    await runUiInspect(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "click") {
    await runUiClick(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "tap") {
    await runUiTap(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "type") {
    await runUiType(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "clear") {
    await runUiClear(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "press") {
    await runUiPress(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "read") {
    await runUiRead(args.slice(2));
    return;
  }

  if (command === "ui" && subcommand === "wait-for") {
    await runUiWaitFor(args.slice(2));
    return;
  }

  if (command === "ui" && subsubcommand === "--help") {
    printHelp();
    return;
  }

  throw new HarnessError(
    "invalid_input",
    `Unknown command "${args.join(" ")}".`,
  );
};

try {
  await main();
} catch (error) {
  if (error instanceof HarnessError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
