import os from "node:os";
import path from "node:path";
import { closeSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { HarnessError, missingDependency } from "../core/errors.ts";
import type {
  UiActionResult,
  UiActionSummary,
  UiElementSnapshot,
  UiElementRole,
  UiInspectResult,
  UiTapOptions,
  UiInputSummary,
  UiOverlaySummary,
  UiPressOptions,
  UiReadResult,
  UiSelector,
  UiSnapshot,
  UiSnapshotDetail,
  UiTypeOptions,
  UiTextBlock,
  UiWaitCondition,
  UiWaitResult,
} from "../core/ui-types.ts";

const WDA_REPO_URL = "https://github.com/appium/WebDriverAgent";
const WDA_VERSION = "v12.2.0";
const WDA_CACHE_ROOT = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "mobile-harness",
  "ios",
  "appium-wda",
);

type DevicectlApp = {
  bundleIdentifier?: string;
  name?: string;
};

type DevicectlAppsResult = {
  result?: {
    apps?: DevicectlApp[];
  };
};

type WdaElement = {
  id?: string;
  index?: number;
  xpath?: string;
  enabled?: string | boolean | null;
  hittable?: string | boolean | null;
  label?: string | null;
  name?: string | null;
  rect?: {
    height?: string | number;
    width?: string | number;
    x?: string | number;
    y?: string | number;
  } | null;
  type?: string | null;
  value?: string | null;
  visible?: string | boolean | null;
};

const WDA_BRIDGE_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "wda_bridge.py",
);
const WDA_BRIDGE_TIMEOUT_MS = 15_000;
const WDA_WORKER_STARTUP_TIMEOUT_MS = 20_000;
const WDA_WORKER_RUNTIME_DIR = path.join(
  process.cwd(),
  ".mobile-harness",
  "runtime",
  "ios-wda",
);

type WdaWorkerState = {
  sessionId: string;
  pid: number;
  socketPath: string;
  logPath: string;
  deviceId: string;
  appId: string;
  xctrunnerBundleId: string;
  startedAt: string;
};

const getXcrunPath = () => {
  const xcrunPath = Bun.which("xcrun");
  if (!xcrunPath) {
    throw missingDependency("xcrun");
  }

  return xcrunPath;
};

const runCommand = (
  command: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
  },
) => {
  const result = Bun.spawnSync(command, {
    cwd: options?.cwd,
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
    cwd?: string;
  },
) => {
  const result = runCommand(command, options);
  if (result.exitCode !== 0) {
    throw new HarnessError(
      "command_failed",
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${command.join(" ")} failed with exit code ${result.exitCode}.`,
    );
  }

  return result;
};

const createTempJsonPath = (prefix: string) =>
  `/tmp/mobile-harness-${prefix}-${crypto.randomUUID()}.json`;

const runDevicectlJsonCommand = async <T>(args: string[]): Promise<T> => {
  const xcrunPath = getXcrunPath();
  const jsonOutputPath = createTempJsonPath("devicectl");

  try {
    const result = runCommand(
      [xcrunPath, "devicectl", ...args, "--json-output", jsonOutputPath],
    );

    if (result.exitCode !== 0) {
      throw new HarnessError(
        "command_failed",
        result.stderr.trim() ||
          result.stdout.trim() ||
          `xcrun devicectl ${args.join(" ")} failed with exit code ${result.exitCode}.`,
      );
    }

    return (await Bun.file(jsonOutputPath).json()) as T;
  } finally {
    await rm(jsonOutputPath, { force: true });
  }
};

const ensureDir = async (dirPath: string) => {
  await mkdir(dirPath, { recursive: true });
};

const ensureWdaWorkerRuntimeDir = async () => {
  await ensureDir(WDA_WORKER_RUNTIME_DIR);
};

const getShortSessionToken = (sessionId: string) =>
  sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);

const getWdaWorkerSocketPath = (sessionId: string) =>
  path.join("/tmp", `mh-ios-wda-${getShortSessionToken(sessionId)}.sock`);

const getWdaWorkerStatePath = (sessionId: string) =>
  path.join(WDA_WORKER_RUNTIME_DIR, `${sessionId}.json`);

const getWdaWorkerLogPath = (sessionId: string) =>
  path.join(WDA_WORKER_RUNTIME_DIR, `${sessionId}.log`);

const loadWdaWorkerState = async (
  sessionId: string,
): Promise<WdaWorkerState | null> => {
  const file = Bun.file(getWdaWorkerStatePath(sessionId));
  if (!(await file.exists())) {
    return null;
  }

  return (await file.json()) as WdaWorkerState;
};

const saveWdaWorkerState = async (state: WdaWorkerState) => {
  await ensureWdaWorkerRuntimeDir();
  await Bun.write(
    getWdaWorkerStatePath(state.sessionId),
    JSON.stringify(state, null, 2),
  );
};

const removeWdaWorkerState = async (sessionId: string) => {
  await rm(getWdaWorkerStatePath(sessionId), { force: true });
  await rm(getWdaWorkerSocketPath(sessionId), { force: true });
};

const killWdaWorkerProcess = (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore stale pid failures
  }
};

const getWdaSourceRoot = () => path.join(WDA_CACHE_ROOT, WDA_VERSION);

const getWdaBuildRoot = () => path.join(getWdaSourceRoot(), "Build");

const getWdaRunnerAppPath = () =>
  path.join(
    getWdaBuildRoot(),
    "Build",
    "Products",
    "Debug-iphoneos",
    "WebDriverAgentRunner-Runner.app",
  );

const getWdaXctestEntitlementsPath = () =>
  path.join(
    getWdaBuildRoot(),
    "Build",
    "Intermediates.noindex",
    "WebDriverAgent.build",
    "Debug-iphoneos",
    "WebDriverAgentRunner.build",
    "WebDriverAgentRunner.xctest.xcent",
  );

const ensureWdaSource = async () => {
  const sourceRoot = getWdaSourceRoot();
  if (await Bun.file(path.join(sourceRoot, ".git")).exists()) {
    return sourceRoot;
  }

  await ensureDir(WDA_CACHE_ROOT);
  await rm(sourceRoot, { recursive: true, force: true });
  runCommandOrThrow(
    [
      "git",
      "clone",
      "--depth",
      "1",
      "--branch",
      WDA_VERSION,
      WDA_REPO_URL,
      sourceRoot,
    ],
  );

  return sourceRoot;
};

const discoverWorkspaceProjectPath = async () => {
  const rgPath = Bun.which("rg");
  if (!rgPath) {
    return null;
  }

  const result = runCommand([rgPath, "--files", "-g", "*.pbxproj"]);
  if (result.exitCode !== 0) {
    return null;
  }

  const candidates = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return candidates.find((candidate) => candidate.endsWith("project.pbxproj")) ?? null;
};

const discoverWorkspaceHints = async () => {
  const projectPath = await discoverWorkspaceProjectPath();
  if (!projectPath) {
    return {
      teamId: null,
      bundleId: null,
    };
  }

  const contents = await readFile(projectPath, "utf8");
  const teamIds = [...contents.matchAll(/DEVELOPMENT_TEAM = ([A-Z0-9]+);/g)].map(
    (match) => match[1],
  );
  const bundleIds = [
    ...contents.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([A-Za-z0-9._-]+);/g),
  ]
    .map((match) => match[1])
    .filter((bundleId) => !bundleId.includes("Tests"));

  const uniqueTeamIds = [...new Set(teamIds)];
  const uniqueBundleIds = [...new Set(bundleIds)];

  return {
    teamId: uniqueTeamIds.length === 1 ? uniqueTeamIds[0]! : null,
    bundleId: uniqueBundleIds[0] ?? null,
  };
};

const extractBundleBase = (bundleId: string | null) => {
  if (!bundleId) {
    return "dev.mobileharness";
  }

  const parts = bundleId.split(".");
  if (parts.at(-1) === "app") {
    return parts.slice(0, -1).join(".");
  }

  return bundleId;
};

const plistValue = (plistPath: string, key: string) =>
  runCommandOrThrow([
    "/usr/libexec/PlistBuddy",
    "-c",
    `Print :${key}`,
    plistPath,
  ]).stdout.trim();

const extractAppEntitlements = async (appPath: string) => {
  const outputPath = `/tmp/mobile-harness-wda-entitlements-${crypto.randomUUID()}.plist`;
  runCommandOrThrow([
    "bash",
    "-lc",
    `/usr/bin/security cms -D -i "${appPath}/embedded.mobileprovision" | plutil -extract Entitlements xml1 -o "${outputPath}" -`,
  ]);
  return outputPath;
};

const resolveSigningIdentity = (appPath: string) => {
  const result = runCommand(["codesign", "-dvv", appPath]);
  const stderr = result.stderr.trim();
  const match = stderr.match(/Authority=(Apple Development: .+)/);
  if (!match) {
    throw new HarnessError(
      "command_failed",
      "Could not determine the Apple Development signing identity for the built WDA runner.",
    );
  }

  return match[1]!;
};

const stripAndResignWdaApp = async (appPath: string) => {
  const pluginPath = path.join(appPath, "PlugIns", "WebDriverAgentRunner.xctest");
  const xctestEntitlementsPath = getWdaXctestEntitlementsPath();
  const appEntitlementsPath = await extractAppEntitlements(appPath);

  try {
    await rm(path.join(appPath, "Frameworks", "Testing.framework"), {
      recursive: true,
      force: true,
    });
    await rm(path.join(appPath, "Frameworks", "libXCTestSwiftSupport.dylib"), {
      force: true,
    });

    const frameworksDir = path.join(appPath, "Frameworks");
    const entries = await Bun.file(frameworksDir).exists()
      ? await readdir(frameworksDir)
      : [];
    for (const entry of entries) {
      if (entry.startsWith("XC") && entry.endsWith(".framework")) {
        await rm(path.join(frameworksDir, entry), { recursive: true, force: true });
      }
    }

    const signingIdentity = resolveSigningIdentity(appPath);

    runCommandOrThrow([
      "codesign",
      "--force",
      "--sign",
      signingIdentity,
      "--entitlements",
      xctestEntitlementsPath,
      "--timestamp=none",
      "--generate-entitlement-der",
      pluginPath,
    ]);

    runCommandOrThrow([
      "codesign",
      "--force",
      "--sign",
      signingIdentity,
      "--entitlements",
      appEntitlementsPath,
      "--timestamp=none",
      "--generate-entitlement-der",
      appPath,
    ]);

    runCommandOrThrow([
      "codesign",
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]);
  } finally {
    await rm(appEntitlementsPath, { force: true });
  }
};

export const getInstalledWdaRunnerBundleId = async (deviceId: string) => {
  const result = await runDevicectlJsonCommand<DevicectlAppsResult>([
    "device",
    "info",
    "apps",
    "--device",
    deviceId,
  ]);

  const apps = result.result?.apps ?? [];
  const matches = apps
    .map((app) => app.bundleIdentifier)
    .filter(
      (bundleId): bundleId is string =>
        !!bundleId &&
        bundleId.toLowerCase().includes("webdriveragentrunner") &&
        bundleId.toLowerCase().endsWith(".xctrunner"),
    );

  return matches[0] ?? null;
};

export const bootstrapWda = async (
  deviceId: string,
  options?: {
    teamId?: string;
    bundleId?: string;
  },
) => {
  const sourceRoot = await ensureWdaSource();
  const hints = await discoverWorkspaceHints();
  const teamId = options?.teamId ?? hints.teamId;
  if (!teamId) {
    throw new HarnessError(
      "invalid_input",
      "Could not infer an iOS DEVELOPMENT_TEAM for WDA bootstrap. Re-run with --team-id <TEAMID>.",
    );
  }

  const rootBundleId =
    options?.bundleId ??
    `${extractBundleBase(hints.bundleId)}.WebDriverAgentRunner`;

  await rm(getWdaBuildRoot(), { recursive: true, force: true });

  runCommandOrThrow(
    [
      "xcodebuild",
      "-project",
      "WebDriverAgent.xcodeproj",
      "-scheme",
      "WebDriverAgentRunner",
      "-configuration",
      "Debug",
      "-sdk",
      "iphoneos",
      "-destination",
      `id=${deviceId}`,
      "-derivedDataPath",
      "Build",
      "-allowProvisioningUpdates",
      `DEVELOPMENT_TEAM=${teamId}`,
      `PRODUCT_BUNDLE_IDENTIFIER=${rootBundleId}`,
      "build-for-testing",
    ],
    { cwd: sourceRoot },
  );

  const appPath = getWdaRunnerAppPath();
  await stripAndResignWdaApp(appPath);

  runCommandOrThrow([
    getXcrunPath(),
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    deviceId,
    appPath,
  ]);

  const xctrunnerBundleId = plistValue(path.join(appPath, "Info.plist"), "CFBundleIdentifier");

  return {
    teamId,
    rootBundleId,
    xctrunnerBundleId,
    appPath,
    sourceRoot,
  };
};

const toBool = (value: string | boolean | null | undefined) =>
  value === true || value === "true";

const roleFromType = (type?: string | null): UiElementRole => {
  switch (type) {
    case "XCUIElementTypeButton":
      return "button";
    case "XCUIElementTypeLink":
      return "link";
    case "XCUIElementTypeStaticText":
      return "text";
    case "XCUIElementTypeTextField":
    case "XCUIElementTypeSecureTextField":
      return "input";
    case "XCUIElementTypeTextView":
      return "textarea";
    case "XCUIElementTypePicker":
    case "XCUIElementTypePickerWheel":
      return "select";
    case "XCUIElementTypeSwitch":
    case "XCUIElementTypeCheckbox":
      return "checkbox";
    case "XCUIElementTypeRadioButton":
      return "radio";
    case "XCUIElementTypeTabBar":
      return "tab";
    case "XCUIElementTypeAlert":
    case "XCUIElementTypeSheet":
      return "dialog";
    default:
      return "unknown";
  }
};

const toElementSnapshot = (element: WdaElement, index: number): UiElementSnapshot => ({
  id: `ios-wda:${index}`,
  role: roleFromType(element.type),
  text: element.type === "XCUIElementTypeStaticText"
    ? element.value ?? element.label ?? element.name ?? undefined
    : undefined,
  name: element.name ?? undefined,
  label: element.label ?? undefined,
  value: element.value ?? undefined,
  type: element.type ?? undefined,
  enabled: toBool(element.enabled),
  visible: toBool(element.visible),
  bounds: getElementBounds(element) ?? undefined,
});

const buildPrimaryActions = (elements: UiElementSnapshot[]): UiActionSummary[] =>
  elements
    .filter(
      (element) =>
        (element.role === "button" ||
          element.role === "link" ||
          element.role === "tab" ||
          element.role === "back") &&
        element.visible,
    )
    .slice(0, 20)
    .map((element) => ({
      id: element.id,
      role: element.role as UiActionSummary["role"],
      label:
        element.label ?? element.text ?? element.name ?? element.value ?? element.id,
      enabled: element.enabled,
    }));

const buildInputs = (elements: UiElementSnapshot[]): UiInputSummary[] =>
  elements
    .filter(
      (element) =>
        (element.role === "input" ||
          element.role === "textarea" ||
          element.role === "select") &&
        element.visible,
    )
    .map((element) => ({
      id: element.id,
      kind:
        element.role === "textarea"
          ? "textarea"
          : element.role === "select"
            ? "select"
            : "text",
      name: element.name,
      label: element.label,
      placeholder: element.label,
      valuePreview: element.value,
      empty: !element.value,
      focused: false,
    }));

const buildOverlays = (elements: UiElementSnapshot[]): UiOverlaySummary[] =>
  elements
    .filter((element) => element.role === "dialog" && element.visible)
    .map((element) => ({
      id: element.id,
      kind: "dialog",
      title: element.label ?? element.text ?? element.name,
      message: element.value,
      blocking: true,
    }));

const buildTextBlocks = (elements: UiElementSnapshot[]): UiTextBlock[] =>
  elements
    .filter((element) => element.role === "text" && element.visible)
    .slice(0, 40)
    .map((element, index) => ({
      id: element.id || `text-${index}`,
      kind: (index === 0 ? "heading" : "body") as UiTextBlock["kind"],
      text: element.text ?? element.label ?? element.name ?? "",
    }))
    .filter((block) => block.text.length > 0);

const buildTextBlocksFromWdaElements = (elements: WdaElement[]): UiTextBlock[] =>
  buildTextBlocks(
    elements.map((element) => toElementSnapshot(element, element.index ?? 0)),
  );

export const listWdaItems = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
) => {
  return await runWdaBridge<WdaElement[]>(
    sessionId,
    "dump",
    deviceId,
    xctrunnerBundleId,
    appId,
  );
};

const normalizeText = (value: string | null | undefined) =>
  value?.trim().toLowerCase() ?? "";

const toNumber = (value: string | number | null | undefined) => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const getElementBounds = (element: WdaElement) => {
  const rect = element.rect;
  if (!rect) {
    return null;
  }

  const x = toNumber(rect.x);
  const y = toNumber(rect.y);
  const width = toNumber(rect.width);
  const height = toNumber(rect.height);

  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
};

const getElementCenter = (element: WdaElement) => {
  const bounds = getElementBounds(element);
  if (!bounds) {
    return null;
  }

  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
};

const isClickableType = (type?: string | null) =>
  type === "XCUIElementTypeButton" ||
  type === "XCUIElementTypeLink" ||
  type === "XCUIElementTypeCell" ||
  type === "XCUIElementTypeSwitch" ||
  type === "XCUIElementTypeTextField" ||
  type === "XCUIElementTypeSecureTextField" ||
  type === "XCUIElementTypeImage";

const isInputType = (type?: string | null) =>
  type === "XCUIElementTypeTextField" ||
  type === "XCUIElementTypeSecureTextField" ||
  type === "XCUIElementTypeTextView";

const getElementTexts = (element: WdaElement) => [
  normalizeText(element.value),
  normalizeText(element.label),
  normalizeText(element.name),
].filter(Boolean);

const matchesSelector = (element: WdaElement, selector: UiSelector) => {
  if (selector.elementId && element.id !== selector.elementId) {
    return false;
  }

  if (selector.role && roleFromType(element.type) !== selector.role) {
    return false;
  }

  if (selector.name) {
    const expected = normalizeText(selector.name);
    const actuals = [
      normalizeText(element.name),
      normalizeText(element.label),
      normalizeText(element.value),
    ];
    if (!actuals.includes(expected)) {
      return false;
    }
  }

  if (selector.placeholder) {
    const expected = normalizeText(selector.placeholder);
    const actuals = [normalizeText(element.label), normalizeText(element.name)];
    if (!actuals.includes(expected)) {
      return false;
    }
  }

  if (selector.text) {
    const expected = normalizeText(selector.text);
    const actuals = [
      normalizeText(element.value),
      normalizeText(element.label),
      normalizeText(element.name),
    ];
    if (!actuals.some((value) => value === expected || value.includes(expected))) {
      return false;
    }
  }

  return true;
};

const scoreWdaElement = (element: WdaElement, selector: UiSelector) => {
  let score = 0;
  const texts = getElementTexts(element);

  if (toBool(element.visible)) {
    score += 100;
  }
  if (toBool(element.enabled)) {
    score += 20;
  }
  if (selector.role && roleFromType(element.type) === selector.role) {
    score += 80;
  }

  if (selector.text) {
    const expected = normalizeText(selector.text);
    if (texts.some((text) => text === expected)) {
      score += 200;
    } else if (texts.some((text) => text.startsWith(expected))) {
      score += 120;
    } else if (texts.some((text) => text.includes(expected))) {
      score += 40;
    }
  }

  if (selector.name) {
    const expected = normalizeText(selector.name);
    if (texts.some((text) => text === expected)) {
      score += 200;
    }
  }

  if (selector.placeholder) {
    const expected = normalizeText(selector.placeholder);
    if (
      normalizeText(element.label) === expected ||
      normalizeText(element.name) === expected
    ) {
      score += 160;
    }
  }

  if (isClickableType(element.type)) {
    score += 15;
  }
  if (isInputType(element.type)) {
    score += 10;
  }

  return score;
};

export const createWdaSnapshot = (
  rawElements: WdaElement[],
  detail: UiSnapshotDetail,
): UiSnapshot => {
  const elements = rawElements.map(toElementSnapshot);
  const primaryActions = buildPrimaryActions(elements);
  const inputs = buildInputs(elements);
  const overlays = buildOverlays(elements);
  const textBlocks = buildTextBlocks(elements);
  const title =
    textBlocks[0]?.text ??
    primaryActions[0]?.label ??
    "iOS Screen";

  return {
    detail,
    screen: title,
    route: "ios://native",
    url: "",
    title,
    status: overlays.some((overlay) => overlay.blocking) ? "blocked" : "idle",
    canGoBack: primaryActions.some((action) =>
      action.label.toLowerCase().includes("back")
    ),
    blockingMessage: overlays.find((overlay) => overlay.blocking)?.message,
    primaryActions,
    inputs,
    overlays,
    elements: detail === "summary" ? undefined : elements,
    textBlocks,
    debug: {
      elementCount: elements.length,
      textBlockCount: textBlocks.length,
    },
  };
};

const findWdaElement = (elements: WdaElement[], selector: UiSelector) => {
  const matches = elements
    .filter((element) => matchesSelector(element, selector))
    .map((element) => ({
      element,
      score: scoreWdaElement(element, selector),
    }))
    .sort((left, right) => right.score - left.score);
  const preferred = matches[0]?.element;

  if (!preferred) {
    throw new HarnessError(
      "invalid_input",
      `No iOS UI element matched selector ${JSON.stringify(selector)}.`,
    );
  }

  return preferred;
};

const toInspectResult = (
  matchedElement: WdaElement,
  elements: WdaElement[],
): UiInspectResult => ({
  selector: {},
  matchedElement: toElementSnapshot(matchedElement, matchedElement.index ?? 0),
  screen: createWdaSnapshot(elements, "summary").screen,
  route: "ios://native",
  title: createWdaSnapshot(elements, "summary").title,
  detail: "full",
  textBlocks: buildTextBlocksFromWdaElements(elements),
});

const ensureUvPath = () => {
  const uvPath = Bun.which("uv");
  if (!uvPath) {
    throw missingDependency("uv");
  }

  return uvPath;
};

const sendWdaWorkerRequest = async <T>(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs: number = WDA_BRIDGE_TIMEOUT_MS,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const socket = createConnection(socketPath);
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(
        new HarnessError(
          "command_failed",
          `iOS WDA ${String(request.command)} timed out after ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      fn();
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      finish(() => {
        socket.end();
        if (!line) {
          reject(
            new HarnessError(
              "command_failed",
              `iOS WDA ${String(request.command)} returned an empty response.`,
            ),
          );
          return;
        }

        try {
          const payload = JSON.parse(line) as {
            ok: boolean;
            result?: T;
            error?: string;
          };
          if (!payload.ok) {
            reject(
              new HarnessError(
                "command_failed",
                payload.error ??
                  `iOS WDA ${String(request.command)} failed.`,
              ),
            );
            return;
          }

          resolve((payload.result ?? ({} as T)) as T);
        } catch (error) {
          reject(
            new HarnessError(
              "command_failed",
              error instanceof Error
                ? error.message
                : `Failed to decode iOS WDA ${String(request.command)} response.`,
            ),
          );
        }
      });
    });

    socket.on("error", (error) => {
      finish(() => {
        reject(
          new HarnessError(
            "command_failed",
            error.message || `Failed to connect to iOS WDA worker at ${socketPath}.`,
          ),
        );
      });
    });

    socket.on("end", () => {
      if (!settled) {
        finish(() => {
          reject(
            new HarnessError(
              "command_failed",
              `iOS WDA ${String(request.command)} closed without a response.`,
            ),
          );
        });
      }
    });
  });

export const stopWdaWorkerForSession = async (sessionId: string) => {
  const state = await loadWdaWorkerState(sessionId);
  if (!state) {
    await removeWdaWorkerState(sessionId);
    return;
  }

  killWdaWorkerProcess(state.pid);
  await removeWdaWorkerState(sessionId);
};

const ensureWdaWorker = async (
  sessionId: string,
  deviceId: string,
  xctrunnerBundleId: string,
  appId: string,
) => {
  await ensureWdaWorkerRuntimeDir();
  const existingState = await loadWdaWorkerState(sessionId);
  if (existingState) {
    try {
      await sendWdaWorkerRequest(existingState.socketPath, {
        command: "ping",
      }, 1_500);
      return existingState;
    } catch {
      await stopWdaWorkerForSession(sessionId);
    }
  }

  const uvPath = ensureUvPath();
  const socketPath = getWdaWorkerSocketPath(sessionId);
  const logPath = getWdaWorkerLogPath(sessionId);
  await rm(socketPath, { force: true });

  const logFd = openSync(logPath, "a");
  const child = spawn(
    uvPath,
    [
      "run",
      "--quiet",
      "--with",
      "pymobiledevice3",
      "python",
      WDA_BRIDGE_PATH,
      "serve",
      "--socket",
      socketPath,
      "--device-id",
      deviceId,
      "--xctrunner",
      xctrunnerBundleId,
      "--app-id",
      appId,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  closeSync(logFd);
  child.unref();

  const state: WdaWorkerState = {
    sessionId,
    pid: child.pid!,
    socketPath,
    logPath,
    deviceId,
    appId,
    xctrunnerBundleId,
    startedAt: new Date().toISOString(),
  };
  await saveWdaWorkerState(state);

  const deadline = Date.now() + WDA_WORKER_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await sendWdaWorkerRequest(state.socketPath, { command: "ping" }, 1_500);
      return state;
    } catch {
      await Bun.sleep(250);
    }
  }

  const logTail = await Bun.file(logPath).text().catch(() => "");
  await stopWdaWorkerForSession(sessionId);
  throw new HarnessError(
    "command_failed",
    `Timed out starting the persistent iOS WDA worker for session "${sessionId}".${
      logTail ? ` Last worker log:\n${logTail.trim().split("\n").slice(-20).join("\n")}` : ""
    }`,
  );
};

const runWdaBridge = async <T>(
  sessionId: string,
  command: "dump" | "click-xpath" | "tap-point" | "type-xpath" | "press-key",
  deviceId: string,
  xctrunnerBundleId: string,
  appId: string,
  options?: {
    xpath?: string;
    text?: string;
    clearFirst?: boolean;
    existingValue?: string;
    submit?: boolean;
    key?: string;
    x?: number;
    y?: number;
  },
): Promise<T> => {
  const worker = await ensureWdaWorker(
    sessionId,
    deviceId,
    xctrunnerBundleId,
    appId,
  );

  const request: Record<string, unknown> = { command };
  if (options?.xpath) request.xpath = options.xpath;
  if (options?.text !== undefined) request.text = options.text;
  if (options?.clearFirst) request.clear_first = true;
  if (options?.existingValue !== undefined) request.existing_value = options.existingValue;
  if (options?.submit) request.submit = true;
  if (options?.key) request.key = options.key;
  if (options?.x !== undefined) request.x = options.x;
  if (options?.y !== undefined) request.y = options.y;

  try {
    return await sendWdaWorkerRequest<T>(worker.socketPath, request);
  } catch {
    await stopWdaWorkerForSession(sessionId);
    const restartedWorker = await ensureWdaWorker(
      sessionId,
      deviceId,
      xctrunnerBundleId,
      appId,
    );
    return await sendWdaWorkerRequest<T>(restartedWorker.socketPath, request);
  }
};

export const inspectWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  selector: UiSelector,
): Promise<UiInspectResult> => {
  const elements = await listWdaItems(sessionId, deviceId, appId, xctrunnerBundleId);
  const matched = findWdaElement(elements, selector);
  return {
    ...toInspectResult(matched, elements),
    selector,
  };
};

export const clickWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  selector: UiSelector,
): Promise<UiActionResult> => {
  const elements = await listWdaItems(sessionId, deviceId, appId, xctrunnerBundleId);
  const matched = findWdaElement(elements, selector);
  const center = getElementCenter(matched);

  try {
    if (matched.xpath && roleFromType(matched.type) !== "text") {
      await runWdaBridge(
        sessionId,
        "click-xpath",
        deviceId,
        xctrunnerBundleId,
        appId,
        { xpath: matched.xpath },
      );
    } else if (center) {
      await runWdaBridge(
        sessionId,
        "tap-point",
        deviceId,
        xctrunnerBundleId,
        appId,
        center,
      );
    } else if (matched.xpath) {
      await runWdaBridge(
        sessionId,
        "click-xpath",
        deviceId,
        xctrunnerBundleId,
        appId,
        { xpath: matched.xpath },
      );
    } else {
      throw new HarnessError(
        "command_failed",
        "Matched iOS UI element did not expose enough data for a click action.",
      );
    }
  } catch (error) {
    if (!center) {
      throw error;
    }

    await runWdaBridge(
      sessionId,
      "tap-point",
      deviceId,
      xctrunnerBundleId,
      appId,
      center,
    );
  }

  return {
    selector,
    matchedElement: toElementSnapshot(matched, matched.index ?? 0),
  };
};

export const tapWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  point: UiTapOptions,
): Promise<UiActionResult> => {
  await runWdaBridge(
    sessionId,
    "tap-point",
    deviceId,
    xctrunnerBundleId,
    appId,
    point,
  );

  return {
    selector: {},
  };
};

export const typeIntoWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  selector: UiSelector,
  text: string,
  options?: UiTypeOptions,
): Promise<UiActionResult> => {
  const elements = await listWdaItems(sessionId, deviceId, appId, xctrunnerBundleId);
  const matched = findWdaElement(elements, selector);
  if (!matched.xpath) {
    throw new HarnessError("command_failed", "Matched iOS UI element did not include an XPath.");
  }

  await runWdaBridge(
    sessionId,
    "type-xpath",
    deviceId,
    xctrunnerBundleId,
    appId,
    {
      xpath: matched.xpath,
      text,
      clearFirst: !options?.append,
      existingValue: matched.value ?? undefined,
      submit: options?.submit,
    },
  );

  return {
    selector,
    matchedElement: toElementSnapshot(matched, matched.index ?? 0),
  };
};

export const clearWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  selector: UiSelector,
): Promise<UiActionResult> => {
  return await typeIntoWdaUi(sessionId, deviceId, appId, xctrunnerBundleId, selector, "", {
    append: false,
    submit: false,
  });
};

export const readWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  selector: UiSelector,
): Promise<UiReadResult> => {
  const elements = await listWdaItems(sessionId, deviceId, appId, xctrunnerBundleId);
  const matched = findWdaElement(elements, selector);
  return {
    selector,
    matchedElement: toElementSnapshot(matched, matched.index ?? 0),
  };
};

export const pressWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  selector: UiSelector,
  options: UiPressOptions,
): Promise<UiActionResult> => {
  const elements = await listWdaItems(sessionId, deviceId, appId, xctrunnerBundleId);
  const matched = selector.elementId ||
      selector.name ||
      selector.text ||
      selector.placeholder ||
      selector.role
    ? findWdaElement(elements, selector)
    : undefined;

  if (matched?.xpath && !HARDWARE_KEY_NAMES.has(options.key.toLowerCase())) {
    await runWdaBridge(
      sessionId,
      "type-xpath",
      deviceId,
      xctrunnerBundleId,
      appId,
      {
        xpath: matched.xpath,
        text: mapPressKeyToText(options.key),
      },
    );
  } else {
    await runWdaBridge(
      sessionId,
      "press-key",
      deviceId,
      xctrunnerBundleId,
      appId,
      { key: options.key },
    );
  }

  return {
    selector,
    matchedElement: matched
      ? toElementSnapshot(matched, matched.index ?? 0)
      : undefined,
  };
};

const evaluateWaitCondition = (
  snapshot: UiSnapshot,
  elements: WdaElement[],
  condition: UiWaitCondition,
) => {
  if (condition.text) {
    const expected = normalizeText(condition.text);
    const found = snapshot.textBlocks?.some((block) =>
      normalizeText(block.text).includes(expected)
    );
    if (!found) {
      return false;
    }
  }

  if (condition.urlIncludes) {
    const haystacks = [
      snapshot.route,
      snapshot.url,
      snapshot.title,
      snapshot.screen,
    ].map((value) => value.toLowerCase());
    if (!haystacks.some((value) => value.includes(condition.urlIncludes!.toLowerCase()))) {
      return false;
    }
  }

  if (condition.element) {
    const matches = elements.filter((element) => matchesSelector(element, condition.element!));
    if (condition.state === "hidden") {
      return matches.every((element) => !toBool(element.visible));
    }
    if (matches.length === 0) {
      return false;
    }

    const preferred = matches
      .map((element) => ({ element, score: scoreWdaElement(element, condition.element!) }))
      .sort((left, right) => right.score - left.score)[0]?.element;
    if (!preferred) {
      return false;
    }

    if (condition.state === "disabled") {
      return !toBool(preferred.enabled);
    }
    if (condition.state === "enabled") {
      return toBool(preferred.enabled);
    }
    if (condition.state === "visible" || !condition.state) {
      return toBool(preferred.visible);
    }
  }

  return true;
};

export const waitForWdaUi = async (
  sessionId: string,
  deviceId: string,
  appId: string,
  xctrunnerBundleId: string,
  condition: UiWaitCondition,
): Promise<UiWaitResult> => {
  const startedAt = Date.now();
  const timeoutMs = condition.timeoutMs ?? 5_000;
  const intervalMs = condition.intervalMs ?? 350;
  let lastSnapshot: UiSnapshot | undefined;

  while (Date.now() - startedAt <= timeoutMs) {
    const elements = await listWdaItems(sessionId, deviceId, appId, xctrunnerBundleId);
    const snapshot = createWdaSnapshot(elements, "summary");
    lastSnapshot = snapshot;

    if (evaluateWaitCondition(snapshot, elements, condition)) {
      return {
        satisfied: true,
        elapsedMs: Date.now() - startedAt,
        snapshot,
      };
    }

    await Bun.sleep(intervalMs);
  }

  return {
    satisfied: false,
    elapsedMs: Date.now() - startedAt,
    snapshot: lastSnapshot,
  };
};

const HARDWARE_KEY_NAMES = new Set(["home", "lock", "volumeup", "volumedown"]);

const mapPressKeyToText = (key: string) => {
  const normalized = key.toLowerCase();
  if (normalized === "enter" || normalized === "return") {
    return "\n";
  }
  if (normalized === "tab") {
    return "\t";
  }
  if (normalized === "backspace" || normalized === "delete") {
    return "\b";
  }
  if (normalized === "space") {
    return " ";
  }
  throw new HarnessError("invalid_input", `Unsupported iOS text key "${key}".`);
};
