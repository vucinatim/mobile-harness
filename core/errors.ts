export type HarnessErrorCode =
  | "missing_dependency"
  | "unsupported_platform"
  | "unsupported_capability"
  | "not_implemented"
  | "invalid_input"
  | "command_failed";

export class HarnessError extends Error {
  override readonly name = "HarnessError";

  constructor(
    readonly code: HarnessErrorCode,
    message: string,
    readonly details?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
  }
}

export const missingDependency = (dependency: string) =>
  new HarnessError(
    "missing_dependency",
    `Required dependency "${dependency}" was not found in PATH.`,
    { dependency },
  );

export const unsupportedCapability = (
  capability: string,
  platform: string,
) =>
  new HarnessError(
    "unsupported_capability",
    `Capability "${capability}" is not supported for platform "${platform}".`,
    { capability, platform },
  );

export const notImplemented = (message: string) =>
  new HarnessError("not_implemented", message);
