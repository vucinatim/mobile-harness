import { HarnessError } from "../core/errors.ts";
import { ensureIOSBridgeCollector, IOS_BRIDGE_COLLECTOR_PORT } from "./bridge-collector.ts";

const IOS_BRIDGE_CONTROL_REQUEST_PATH = "/__mobile_harness/control/request";

type IOSBridgeEvalResponse =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error?: {
        message?: string;
        name?: string;
        stack?: string;
      };
    };

export const invokeIOSBridgeEval = async (
  appId: string,
  expression: string,
  timeoutMs = 8_000,
): Promise<unknown> => {
  await ensureIOSBridgeCollector();

  const response = await fetch(
    `http://127.0.0.1:${IOS_BRIDGE_COLLECTOR_PORT}${IOS_BRIDGE_CONTROL_REQUEST_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appId,
        timeoutMs,
        command: {
          kind: "eval",
          expression,
        },
      }),
    },
  );

  if (response.status === 504) {
    throw new HarnessError(
      "command_failed",
      `Timed out waiting for iOS bridge response after ${timeoutMs}ms.`,
      { appId, timeoutMs },
    );
  }

  if (!response.ok) {
    throw new HarnessError(
      "command_failed",
      `iOS bridge control request failed with HTTP ${response.status}.`,
      { appId, status: response.status },
    );
  }

  const payload = (await response.json()) as IOSBridgeEvalResponse;
  if (!payload.ok) {
    throw new HarnessError(
      "command_failed",
      payload.error?.message || "The iOS bridge command failed.",
      {
        appId,
        errorName: payload.error?.name,
      },
    );
  }

  return payload.value;
};
