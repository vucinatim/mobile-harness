import { HarnessError } from "../core/errors.ts";
import type { EvalResult, WebviewTarget } from "../core/types.ts";
import {
  getAndroidAppPid,
  removeAdbForward,
  runAdbCommand,
} from "./adb.ts";

type AndroidDevtoolsListEntry = {
  id: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  description?: string;
};

type ForwardedDevtoolsSession = {
  localPort: number;
  cleanup: () => void;
};

type CdpEvaluationResponse = {
  id?: number;
  result?: {
    result?: {
      type?: string;
      value?: unknown;
      description?: string;
      unserializableValue?: string;
    };
  };
  error?: {
    message?: string;
  };
};

const getWebviewSocketName = (pid: string) =>
  `localabstract:webview_devtools_remote_${pid}`;

const parseAttachedFlag = (description?: string): boolean => {
  if (!description) {
    return false;
  }

  try {
    const parsed = JSON.parse(description) as { attached?: boolean };
    return parsed.attached ?? false;
  } catch {
    return false;
  }
};

const forwardAndroidDevtoolsSocket = (
  deviceId: string,
  pid: string,
): ForwardedDevtoolsSession => {
  const socketName = getWebviewSocketName(pid);
  const output = runAdbCommand([
    "-s",
    deviceId,
    "forward",
    "tcp:0",
    socketName,
  ]).trim();

  const localPort = Number.parseInt(output, 10);
  if (!Number.isFinite(localPort)) {
    throw new HarnessError(
      "command_failed",
      `Could not parse adb forwarded port from output "${output}".`,
      { output },
    );
  }

  return {
    localPort,
    cleanup: () => {
      removeAdbForward(deviceId, localPort);
    },
  };
};

const getForwardedDevtoolsSession = (
  deviceId: string,
  appId: string,
): ForwardedDevtoolsSession => {
  const pid = getAndroidAppPid(deviceId, appId);
  if (!pid) {
    throw new HarnessError(
      "invalid_input",
      `App "${appId}" is not running on device "${deviceId}".`,
      { deviceId, appId },
    );
  }

  return forwardAndroidDevtoolsSocket(deviceId, pid);
};

const fetchDevtoolsList = async (
  localPort: number,
): Promise<AndroidDevtoolsListEntry[]> => {
  const response = await fetch(`http://127.0.0.1:${localPort}/json/list`);
  if (!response.ok) {
    throw new HarnessError(
      "command_failed",
      `Could not fetch devtools target list from local port ${localPort}.`,
      { localPort, status: response.status },
    );
  }

  return (await response.json()) as AndroidDevtoolsListEntry[];
};

const mapTarget = (
  entry: AndroidDevtoolsListEntry,
  sessionId: string,
): WebviewTarget => ({
  id: entry.id,
  sessionId,
  title: entry.title,
  url: entry.url,
  attached: parseAttachedFlag(entry.description),
});

const getTargetEntry = async (
  deviceId: string,
  appId: string,
  targetId: string,
): Promise<AndroidDevtoolsListEntry> => {
  const forwarded = getForwardedDevtoolsSession(deviceId, appId);

  try {
    const entries = await fetchDevtoolsList(forwarded.localPort);
    const target = entries.find((entry) => entry.id === targetId);

    if (!target || !target.webSocketDebuggerUrl) {
      throw new HarnessError(
        "invalid_input",
        `WebView target "${targetId}" was not found.`,
        { targetId },
      );
    }

    return target;
  } finally {
    forwarded.cleanup();
  }
};

const evaluateOverWebSocket = (
  webSocketDebuggerUrl: string,
  expression: string,
): Promise<EvalResult> =>
  new Promise((resolve, reject) => {
    const requestId = 1;
    const socket = new WebSocket(webSocketDebuggerUrl);

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          id: requestId,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
          },
        }),
      );
    };

    socket.onerror = () => {
      reject(
        new HarnessError(
          "command_failed",
          "Could not connect to the WebView debugger WebSocket.",
        ),
      );
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString(),
      ) as CdpEvaluationResponse;

      if (payload.id !== requestId) {
        return;
      }

      socket.close();

      if (payload.error?.message) {
        reject(new HarnessError("command_failed", payload.error.message));
        return;
      }

      const result = payload.result?.result;
      if (!result) {
        reject(
          new HarnessError(
            "command_failed",
            "CDP evaluation completed without a result payload.",
          ),
        );
        return;
      }

      resolve({
        value:
          result.value ??
          result.unserializableValue ??
          result.description ??
          null,
      });
    };
  });

export const listAndroidWebviews = async (
  deviceId: string,
  appId: string,
  sessionId: string,
): Promise<WebviewTarget[]> => {
  const forwarded = getForwardedDevtoolsSession(deviceId, appId);

  try {
    const entries = await fetchDevtoolsList(forwarded.localPort);
    return entries
      .filter((entry) => entry.type === "page")
      .map((entry) => mapTarget(entry, sessionId));
  } finally {
    forwarded.cleanup();
  }
};

export const validateAndroidWebviewTarget = async (
  deviceId: string,
  appId: string,
  targetId: string,
) => {
  await getTargetEntry(deviceId, appId, targetId);
};

export const evaluateAndroidWebview = async (
  deviceId: string,
  appId: string,
  targetId: string,
  expression: string,
): Promise<EvalResult> => {
  const forwarded = getForwardedDevtoolsSession(deviceId, appId);

  try {
    const entries = await fetchDevtoolsList(forwarded.localPort);
    const target = entries.find((entry) => entry.id === targetId);

    if (!target?.webSocketDebuggerUrl) {
      throw new HarnessError(
        "invalid_input",
        `WebView target "${targetId}" was not found.`,
        { targetId },
      );
    }

    return await evaluateOverWebSocket(target.webSocketDebuggerUrl, expression);
  } finally {
    forwarded.cleanup();
  }
};
