import { HarnessError } from "../core/errors.ts";
import type {
  UiActionResult,
  UiInspectResult,
  UiTapOptions,
  UiPressOptions,
  UiReadResult,
  UiSelector,
  UiSnapshot,
  UiSnapshotOptions,
  UiTypeOptions,
  UiWaitCondition,
  UiWaitResult,
} from "../core/ui-types.ts";
import { buildUiExpression, type WebviewUiCommand } from "../android/ui.ts";
import { invokeIOSBridgeEval } from "./bridge-control.ts";

const executeIOSBridgeUiCommand = async <T>(
  appId: string,
  command: WebviewUiCommand,
): Promise<T> => {
  const timeoutMs =
    command.type === "waitFor"
      ? (command.condition.timeoutMs ?? 5_000) + 2_000
      : 8_000;
  return (await invokeIOSBridgeEval(
    appId,
    buildUiExpression(command),
    timeoutMs,
  )) as T;
};

const wrapUiError = (error: unknown): never => {
  if (error instanceof HarnessError) {
    throw error;
  }

  if (error instanceof Error) {
    throw new HarnessError("command_failed", error.message);
  }

  throw new HarnessError("command_failed", "Unknown iOS bridge UI command failure.");
};

export const snapshotIOSBridgeUi = async (
  appId: string,
  options?: UiSnapshotOptions,
): Promise<UiSnapshot> => {
  try {
    return await executeIOSBridgeUiCommand<UiSnapshot>(appId, {
      type: "snapshot",
      options,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const inspectIOSBridgeUi = async (
  appId: string,
  selector: UiSelector,
): Promise<UiInspectResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiInspectResult>(appId, {
      type: "inspect",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const clickIOSBridgeUi = async (
  appId: string,
  selector: UiSelector,
): Promise<UiActionResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiActionResult>(appId, {
      type: "click",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const tapIOSBridgeUi = async (
  appId: string,
  point: UiTapOptions,
): Promise<UiActionResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiActionResult>(appId, {
      type: "tap",
      point,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const typeIntoIOSBridgeUi = async (
  appId: string,
  selector: UiSelector,
  text: string,
  options?: UiTypeOptions,
): Promise<UiActionResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiActionResult>(appId, {
      type: "type",
      selector,
      text,
      options,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const clearIOSBridgeUi = async (
  appId: string,
  selector: UiSelector,
): Promise<UiActionResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiActionResult>(appId, {
      type: "clear",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const pressIOSBridgeUi = async (
  appId: string,
  selector: UiSelector,
  options: UiPressOptions,
): Promise<UiActionResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiActionResult>(appId, {
      type: "press",
      selector,
      options,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const readIOSBridgeUi = async (
  appId: string,
  selector: UiSelector,
): Promise<UiReadResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiReadResult>(appId, {
      type: "read",
      selector,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};

export const waitForIOSBridgeUi = async (
  appId: string,
  condition: UiWaitCondition,
): Promise<UiWaitResult> => {
  try {
    return await executeIOSBridgeUiCommand<UiWaitResult>(appId, {
      type: "waitFor",
      condition,
    });
  } catch (error) {
    return wrapUiError(error);
  }
};
