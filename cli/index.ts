import type { AppSession, DeviceSummary } from "../core/types.ts";
import { HarnessError } from "../core/errors.ts";
import {
  captureSessionScreenshot,
  createSession,
  listDevices,
  parsePlatform,
  tailSessionLogs,
} from "../core/registry.ts";

type ExplicitPlatform = Exclude<ReturnType<typeof parsePlatform>, "all">;

type CommandOptions = {
  platform: ReturnType<typeof parsePlatform>;
  json: boolean;
};

const printHelp = () => {
  console.log(`Mobile Harness

Usage:
  bun run mobile-harness devices list [--platform android|ios|all] [--json]
  bun run mobile-harness session attach --platform android --device <serial> --app <appId> [--launch] [--json]
  bun run mobile-harness logs tail --session <id> [--filter <text>]
  bun run mobile-harness screenshot --session <id> [--output <path>] [--json]

Examples:
  bun run mobile-harness devices list
  bun run mobile-harness devices list --platform android
  bun run mobile-harness devices list --json
  bun run mobile-harness session attach --platform android --device emulator-5554 --app ai.classology.app --launch
  bun run mobile-harness logs tail --session <session-id>
  bun run mobile-harness screenshot --session <session-id>
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
      const value = args[index + 1];
      platform = parsePlatform(value);
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

type TailLogsCliOptions = {
  sessionId: string;
  filter?: string;
};

const parseTailLogsOptions = (args: string[]): TailLogsCliOptions => {
  let sessionId = "";
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

  if (!sessionId) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --session <id>.",
    );
  }

  return { sessionId, filter };
};

const runLogsTail = async (args: string[]) => {
  const options = parseTailLogsOptions(args);
  const stream = await tailSessionLogs(options.sessionId, {
    filter: options.filter,
  });

  for await (const event of stream) {
    console.log(event.message);
  }
};

type ScreenshotCliOptions = {
  sessionId: string;
  outputPath?: string;
  json: boolean;
};

const parseScreenshotOptions = (args: string[]): ScreenshotCliOptions => {
  let sessionId = "";
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

  if (!sessionId) {
    throw new HarnessError(
      "invalid_input",
      "Missing required option --session <id>.",
    );
  }

  return { sessionId, outputPath, json };
};

const runScreenshot = async (args: string[]) => {
  const options = parseScreenshotOptions(args);
  const artifact = await captureSessionScreenshot(options.sessionId, {
    outputPath: options.outputPath,
  });

  if (options.json) {
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

  console.log(`Saved screenshot to ${artifact.path}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const [command, subcommand] = args;

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

  if (command === "logs" && subcommand === "tail") {
    await runLogsTail(args.slice(2));
    return;
  }

  if (command === "screenshot") {
    await runScreenshot(args.slice(1));
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
