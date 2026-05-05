import path from "node:path";
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { HarnessError } from "../core/errors.ts";

const BRIDGE_FILE_NAME = "MobileHarnessBridgeViewController.swift";
const BRIDGE_CLASS_NAME = "MobileHarnessBridgeViewController";
const BRIDGE_MANAGED_MARKER =
  "// MOBILE_HARNESS_MANAGED_CAPACITOR_IOS_BRIDGE v7";

const INSTALLER_FILE_NAME = "MobileHarnessBridgeInstaller.swift";
const INSTALLER_MANAGED_MARKER =
  "// MOBILE_HARNESS_MANAGED_CAPACITOR_IOS_BRIDGE v2";
const APP_DELEGATE_INSTALL_CALL =
  "MobileHarnessBridgeInstaller.installIfPossible()";

const LEGACY_APP_SPECIFIC_BRIDGE_FILE_NAME = "ClassologyBridgeViewController.swift";

export type CapacitorIOSSetupResult = {
  projectRoot: string;
  iosRoot: string;
  xcodeprojPath: string;
  moduleName: string;
  bridgeFilePath: string;
  storyboardPath: string;
  pbxprojPath: string;
  changedFiles: string[];
  warnings: string[];
  installed: boolean;
};

type CapacitorIOSProject = {
  projectRoot: string;
  iosRoot: string;
  xcodeprojPath: string;
  pbxprojPath: string;
  appDir: string;
  appDelegatePath: string;
  bridgeFilePath: string;
  installerFilePath: string;
  storyboardPath: string;
  moduleName: string;
};

const exists = async (targetPath: string) => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const randomPbxId = () =>
  crypto.randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase();

const findProjectRoot = async (startPath: string) => {
  let current = path.resolve(startPath);

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    const nativeIOSPath = path.join(current, "native", "ios");

    if (await exists(packageJsonPath) && await exists(nativeIOSPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new HarnessError(
        "invalid_input",
        "Could not locate a Capacitor app project root from the current directory. Re-run from the app repo or pass --project-root <path>.",
      );
    }

    current = parent;
  }
};

const findXcodeprojPaths = async (
  currentDir: string,
  depth = 0,
): Promise<string[]> => {
  if (depth > 4) {
    return [];
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".xcodeproj")) {
      results.push(entryPath);
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await findXcodeprojPaths(entryPath, depth + 1)));
    }
  }

  return results;
};

const detectCapacitorIOSProject = async (
  requestedProjectRoot?: string,
): Promise<CapacitorIOSProject> => {
  const projectRoot = await findProjectRoot(
    requestedProjectRoot ?? process.cwd(),
  );
  const iosRoot = path.join(projectRoot, "native", "ios");
  const xcodeprojCandidates = await findXcodeprojPaths(iosRoot);

  if (xcodeprojCandidates.length === 0) {
    throw new HarnessError(
      "invalid_input",
      `Could not find an .xcodeproj under ${iosRoot}.`,
    );
  }

  const xcodeprojPath =
    xcodeprojCandidates.find((candidate) =>
      path.basename(candidate) === "App.xcodeproj"
    ) ?? xcodeprojCandidates[0];
  const moduleName = path.basename(xcodeprojPath, ".xcodeproj");
  const projectDir = path.dirname(xcodeprojPath);
  const appDir = path.join(projectDir, moduleName);
  const appDelegatePath = path.join(appDir, "AppDelegate.swift");
  const pbxprojPath = path.join(xcodeprojPath, "project.pbxproj");
  const storyboardPath = path.join(appDir, "Base.lproj", "Main.storyboard");
  const bridgeFilePath = path.join(appDir, BRIDGE_FILE_NAME);
  const installerFilePath = path.join(appDir, INSTALLER_FILE_NAME);

  if (
    !(await exists(path.join(projectRoot, "capacitor.config.ts"))) &&
    !(await exists(path.join(projectRoot, "capacitor.config.json"))) &&
    !(await exists(path.join(projectRoot, "capacitor.config.js")))
  ) {
    throw new HarnessError(
      "invalid_input",
      `Could not find a capacitor config file in ${projectRoot}.`,
    );
  }

  for (const requiredPath of [
    appDelegatePath,
    pbxprojPath,
    storyboardPath,
  ]) {
    if (!(await exists(requiredPath))) {
      throw new HarnessError(
        "invalid_input",
        `Required iOS file is missing: ${requiredPath}.`,
      );
    }
  }

  return {
    projectRoot,
    iosRoot,
    xcodeprojPath,
    pbxprojPath,
    appDir,
    appDelegatePath,
    bridgeFilePath,
    installerFilePath,
    storyboardPath,
    moduleName,
  };
};

export const findCapacitorIOSProject = detectCapacitorIOSProject;

export const hasInstalledCapacitorIOSBridge = async (
  requestedProjectRoot?: string,
) => {
  try {
    const project = await detectCapacitorIOSProject(requestedProjectRoot);
    if (!(await exists(project.bridgeFilePath))) {
      return null;
    }

    const [bridgeSource, storyboardSource, appDelegateSource] = await Promise.all([
      readFile(project.bridgeFilePath, "utf8"),
      readFile(project.storyboardPath, "utf8"),
      readFile(project.appDelegatePath, "utf8"),
    ]);

    if (!bridgeSource.includes(BRIDGE_MANAGED_MARKER)) {
      return null;
    }

    if (
      !storyboardSource.includes(`customClass="${BRIDGE_CLASS_NAME}"`) ||
      !storyboardSource.includes(`customModule="${project.moduleName}"`)
    ) {
      return null;
    }

    return project;
  } catch {
    return null;
  }
};

const loadBridgeTemplate = async () => {
  const templateUrl = new URL(
    "./templates/MobileHarnessBridgeViewController.swift.template",
    import.meta.url,
  );
  return await Bun.file(templateUrl).text();
};

const ensureStoryboardBridge = (
  storyboardText: string,
  moduleName: string,
) => {
  const pattern =
    /<viewController\b([^>]*?)sceneMemberID="viewController"\s*\/>/;
  const match = storyboardText.match(pattern);
  if (!match) {
    throw new HarnessError(
      "invalid_input",
      "Could not locate the initial UIViewController entry in Main.storyboard.",
    );
  }

  let attributes = match[1] ?? "";
  attributes = attributes.replace(/\scustomClass="[^"]*"/g, "");
  attributes = attributes.replace(/\scustomModule="[^"]*"/g, "");
  attributes = attributes.replace(/\scustomModuleProvider="[^"]*"/g, "");
  attributes = ` ${attributes.replace(/\s+/g, " ").trim()}`;
  attributes +=
    ` customClass="${BRIDGE_CLASS_NAME}" customModule="${moduleName}" customModuleProvider="target"`;

  const replacement =
    `<viewController${attributes} sceneMemberID="viewController"/>`;
  const nextText = storyboardText.replace(pattern, replacement);

  return {
    changed: nextText !== storyboardText,
    text: nextText,
  };
};

const ensureAppDelegateDefault = (appDelegateSource: string) => {
  let nextSource = appDelegateSource;
  const installLine = `        ${APP_DELEGATE_INSTALL_CALL}\n`;
  nextSource = nextSource.replace(installLine, "");
  nextSource = nextSource.replace(APP_DELEGATE_INSTALL_CALL, "");
  const bootstrapPattern =
    /\n[ \t]*\/\/ MOBILE_HARNESS_MANAGED_CAPACITOR_IOS_BOOTSTRAP v1[\s\S]*?#endif\n?/m;
  nextSource = nextSource.replace(bootstrapPattern, "\n");

  return {
    changed: nextSource !== appDelegateSource,
    text: nextSource,
  };
};

const insertAfter = (sourceText: string, marker: string, snippet: string) => {
  const markerIndex = sourceText.indexOf(marker);
  if (markerIndex === -1) {
    throw new HarnessError(
      "invalid_input",
      `Could not find required Xcode project marker: ${marker}`,
    );
  }

  const insertIndex = markerIndex + marker.length;
  return `${sourceText.slice(0, insertIndex)}${snippet}${sourceText.slice(insertIndex)}`;
};

const ensurePbxprojBridge = (pbxprojText: string) => {
  let nextText = pbxprojText;
  let changed = false;

  const fileRefPattern = new RegExp(
    `([A-F0-9]{24}) /\\* ${BRIDGE_FILE_NAME.replace(".", "\\.")} \\*/ = \\{isa = PBXFileReference;`,
  );
  const buildFilePattern = new RegExp(
    `([A-F0-9]{24}) /\\* ${BRIDGE_FILE_NAME.replace(".", "\\.")} in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ([A-F0-9]{24}) /\\* ${BRIDGE_FILE_NAME.replace(".", "\\.")} \\*/; \\};`,
  );

  let fileRefId = nextText.match(fileRefPattern)?.[1];
  if (!fileRefId) {
    fileRefId = randomPbxId();
    nextText = insertAfter(
      nextText,
      "/* Begin PBXFileReference section */\n",
      `\t\t${fileRefId} /* ${BRIDGE_FILE_NAME} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${BRIDGE_FILE_NAME}; sourceTree = "<group>"; };\n`,
    );
    changed = true;
  }

  let buildFileId = nextText.match(buildFilePattern)?.[1];
  if (!buildFileId) {
    buildFileId = randomPbxId();
    nextText = insertAfter(
      nextText,
      "/* Begin PBXBuildFile section */\n",
      `\t\t${buildFileId} /* ${BRIDGE_FILE_NAME} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${BRIDGE_FILE_NAME} */; };\n`,
    );
    changed = true;
  }

  const appGroupEntry = `\t\t\t\t${fileRefId} /* ${BRIDGE_FILE_NAME} */,`;
  if (!nextText.includes(appGroupEntry)) {
    nextText = nextText.replace(
      /(\t\t\tchildren = \(\n(?:[\s\S]*?)\t\t\t\t504EC3071FED79650016851F \/\* AppDelegate\.swift \*\/,\n)/,
      `$1${appGroupEntry}\n`,
    );
    changed = true;
  }

  const sourcesEntry = `\t\t\t\t${buildFileId} /* ${BRIDGE_FILE_NAME} in Sources */,`;
  if (!nextText.includes(sourcesEntry)) {
    nextText = nextText.replace(
      /(\t\t\tfiles = \(\n(?:[\s\S]*?)\t\t\t\t504EC3081FED79650016851F \/\* AppDelegate\.swift in Sources \*\/,\n)/,
      `$1${sourcesEntry}\n`,
    );
    changed = true;
  }

  return {
    changed,
    text: nextText,
  };
};

const stripFileFromPbxproj = (pbxprojText: string, fileName: string) => {
  const lines = pbxprojText.split("\n");
  const filteredLines = lines.filter((line) => !line.includes(fileName));

  return {
    changed: filteredLines.length !== lines.length,
    text: filteredLines.join("\n"),
  };
};

export const setupCapacitorIOSBridge = async (
  projectRoot?: string,
): Promise<CapacitorIOSSetupResult> => {
  const project = await detectCapacitorIOSProject(projectRoot);
  const changedFiles: string[] = [];
  const warnings: string[] = [];
  const desiredBridgeSource = await loadBridgeTemplate();

  const existingBridgeSource = await Bun.file(project.bridgeFilePath).text().catch(
    () => "",
  );

  if (!existingBridgeSource) {
    await writeFile(project.bridgeFilePath, desiredBridgeSource, "utf8");
    changedFiles.push(project.bridgeFilePath);
  } else if (existingBridgeSource === desiredBridgeSource) {
    // current
  } else if (existingBridgeSource.includes("MOBILE_HARNESS_MANAGED_CAPACITOR_IOS_BRIDGE")) {
    await writeFile(project.bridgeFilePath, desiredBridgeSource, "utf8");
    changedFiles.push(project.bridgeFilePath);
  } else {
    throw new HarnessError(
      "invalid_input",
      `Refusing to overwrite unmanaged file at ${project.bridgeFilePath}. Rename or remove it, then re-run setup.`,
    );
  }

  if (await exists(project.installerFilePath)) {
    const installerSource = await readFile(project.installerFilePath, "utf8")
      .catch(() => "");
    if (installerSource.includes(INSTALLER_MANAGED_MARKER)) {
      await unlink(project.installerFilePath);
      changedFiles.push(project.installerFilePath);
    } else {
      warnings.push(
        `Legacy unmanaged bridge file left untouched: ${project.installerFilePath}`,
      );
    }
  }

  const legacyAppSpecificBridgePath = path.join(
    project.appDir,
    LEGACY_APP_SPECIFIC_BRIDGE_FILE_NAME,
  );
  if (await exists(legacyAppSpecificBridgePath)) {
    warnings.push(
      `Legacy unmanaged bridge file left untouched: ${legacyAppSpecificBridgePath}`,
    );
  }

  const [storyboardText, appDelegateSource, pbxprojText] = await Promise.all([
    readFile(project.storyboardPath, "utf8"),
    readFile(project.appDelegatePath, "utf8"),
    readFile(project.pbxprojPath, "utf8"),
  ]);

  const storyboardResult = ensureStoryboardBridge(
    storyboardText,
    project.moduleName,
  );
  if (storyboardResult.changed) {
    await writeFile(project.storyboardPath, storyboardResult.text, "utf8");
    changedFiles.push(project.storyboardPath);
  }

  const normalizedAppDelegate = ensureAppDelegateDefault(appDelegateSource);
  if (normalizedAppDelegate.changed) {
    await writeFile(project.appDelegatePath, normalizedAppDelegate.text, "utf8");
    changedFiles.push(project.appDelegatePath);
  }

  const strippedInstallerPbxproj = stripFileFromPbxproj(
    pbxprojText,
    INSTALLER_FILE_NAME,
  );
  const strippedLegacyPbxproj = stripFileFromPbxproj(
    strippedInstallerPbxproj.text,
    LEGACY_APP_SPECIFIC_BRIDGE_FILE_NAME,
  );
  const pbxprojResult = ensurePbxprojBridge(strippedLegacyPbxproj.text);
  if (
    strippedInstallerPbxproj.changed ||
    strippedLegacyPbxproj.changed ||
    pbxprojResult.changed
  ) {
    await writeFile(project.pbxprojPath, pbxprojResult.text, "utf8");
    changedFiles.push(project.pbxprojPath);
  }

  return {
    projectRoot: project.projectRoot,
    iosRoot: project.iosRoot,
    xcodeprojPath: project.xcodeprojPath,
    moduleName: project.moduleName,
    bridgeFilePath: project.bridgeFilePath,
    storyboardPath: project.storyboardPath,
    pbxprojPath: project.pbxprojPath,
    changedFiles,
    warnings,
    installed: changedFiles.length > 0,
  };
};
