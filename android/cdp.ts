import { HarnessError } from "../core/errors.ts";
import type {
  ConsoleEvent,
  EvalResult,
  NetworkEvent,
  WebviewTarget,
} from "../core/types.ts";
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
  method?: string;
  params?: Record<string, unknown>;
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

type CdpRemoteObject = {
  type?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
};

type AsyncQueueController<T> = {
  push: (value: T) => void;
  finish: (error?: Error) => void;
  iterate: () => AsyncIterable<T>;
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

const createAsyncQueue = <T>(): AsyncQueueController<T> => {
  const values: T[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  let error: Error | null = null;

  const wake = () => {
    const waiter = waiters.shift();
    waiter?.();
  };

  return {
    push(value) {
      if (closed) {
        return;
      }

      values.push(value);
      wake();
    },
    finish(nextError) {
      if (closed) {
        return;
      }

      closed = true;
      error = nextError ?? null;
      wake();
    },
    async *iterate() {
      while (true) {
        if (values.length > 0) {
          const next = values.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
        }

        if (closed) {
          if (error) {
            throw error;
          }
          return;
        }

        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
  };
};

const getTargetDebuggerUrl = async (
  deviceId: string,
  appId: string,
  targetId: string,
): Promise<{ webSocketDebuggerUrl: string; cleanup: () => void }> => {
  const forwarded = getForwardedDevtoolsSession(deviceId, appId);

  try {
    const entries = await fetchDevtoolsList(forwarded.localPort);
    const target = entries.find((entry) => entry.id === targetId);

    if (!target?.webSocketDebuggerUrl) {
      forwarded.cleanup();
      throw new HarnessError(
        "invalid_input",
        `WebView target "${targetId}" was not found.`,
        { targetId },
      );
    }

    return {
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      cleanup: forwarded.cleanup,
    };
  } catch (error) {
    forwarded.cleanup();
    throw error;
  }
};

const cdpValueToString = (value: CdpRemoteObject): string => {
  if (value.value !== undefined) {
    return typeof value.value === "string"
      ? value.value
      : JSON.stringify(value.value);
  }

  return value.unserializableValue ?? value.description ?? value.type ?? "";
};

const mapConsoleType = (value: string): ConsoleEvent["type"] => {
  switch (value) {
    case "warning":
    case "warn":
      return "warn";
    case "error":
    case "assert":
      return "error";
    case "debug":
      return "debug";
    case "info":
      return "info";
    default:
      return "log";
  }
};

const streamCdpEvents = async function* <T>(
  webSocketDebuggerUrl: string,
  setupCommands: Array<{ method: string; params?: Record<string, unknown> }>,
  onPayload: (payload: CdpEvaluationResponse) => T | null,
  connectionErrorMessage: string,
): AsyncIterable<T> {
  const queue = createAsyncQueue<T>();
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;

  socket.onopen = () => {
    for (const command of setupCommands) {
      socket.send(
        JSON.stringify({
          id: nextId,
          method: command.method,
          params: command.params,
        }),
      );
      nextId += 1;
    }
  };

  socket.onerror = () => {
    queue.finish(new HarnessError("command_failed", connectionErrorMessage));
  };

  socket.onclose = () => {
    queue.finish();
  };

  socket.onmessage = (event) => {
    const payload = JSON.parse(
      typeof event.data === "string" ? event.data : event.data.toString(),
    ) as CdpEvaluationResponse;

    if (payload.error?.message) {
      queue.finish(new HarnessError("command_failed", payload.error.message));
      return;
    }

    if (!payload.method) {
      return;
    }

    const mapped = onPayload(payload);
    if (mapped) {
      queue.push(mapped);
    }
  };

  try {
    yield* queue.iterate();
  } finally {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close();
    }
  }
};

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

export const streamAndroidConsole = async function* (
  deviceId: string,
  appId: string,
  targetId: string,
): AsyncIterable<ConsoleEvent> {
  const { webSocketDebuggerUrl, cleanup } = await getTargetDebuggerUrl(
    deviceId,
    appId,
    targetId,
  );

  try {
    yield* streamCdpEvents<ConsoleEvent>(
      webSocketDebuggerUrl,
      [{ method: "Runtime.enable" }, { method: "Log.enable" }],
      (payload) => {
        if (payload.method === "Runtime.consoleAPICalled") {
          const params = payload.params as
            | {
                type?: string;
                args?: CdpRemoteObject[];
                timestamp?: number;
              }
            | undefined;

          return {
            type: mapConsoleType(params?.type ?? "log"),
            args: (params?.args ?? []).map(cdpValueToString),
            timestamp:
              typeof params?.timestamp === "number"
                ? new Date(params.timestamp).toISOString()
                : undefined,
          };
        }

        if (payload.method === "Runtime.exceptionThrown") {
          const params = payload.params as
            | {
                exceptionDetails?: {
                  text?: string;
                  exception?: CdpRemoteObject;
                };
                timestamp?: number;
              }
            | undefined;

          const details = params?.exceptionDetails;
          return {
            type: "error",
            args: [
              details?.exception
                ? cdpValueToString(details.exception)
                : details?.text ?? "Runtime exception",
            ],
            timestamp:
              typeof params?.timestamp === "number"
                ? new Date(params.timestamp).toISOString()
                : undefined,
          };
        }

        if (payload.method === "Log.entryAdded") {
          const params = payload.params as
            | {
                entry?: {
                  level?: string;
                  text?: string;
                  timestamp?: number;
                };
              }
            | undefined;

          const entry = params?.entry;
          if (!entry?.text) {
            return null;
          }

          return {
            type: mapConsoleType(entry.level ?? "log"),
            args: [entry.text],
            timestamp:
              typeof entry.timestamp === "number"
                ? new Date(entry.timestamp).toISOString()
                : undefined,
          };
        }

        return null;
      },
      "Could not connect to the WebView debugger WebSocket.",
    );
  } finally {
    cleanup();
  }
};

export const streamAndroidNetwork = async function* (
  deviceId: string,
  appId: string,
  targetId: string,
): AsyncIterable<NetworkEvent> {
  const { webSocketDebuggerUrl, cleanup } = await getTargetDebuggerUrl(
    deviceId,
    appId,
    targetId,
  );
  const requests = new Map<string, { method: string; url: string }>();

  try {
    yield* streamCdpEvents<NetworkEvent>(
      webSocketDebuggerUrl,
      [{ method: "Network.enable" }],
      (payload) => {
        if (payload.method === "Network.requestWillBeSent") {
          const params = payload.params as
            | {
                requestId?: string;
                request?: {
                  method?: string;
                  url?: string;
                };
              }
            | undefined;

          const requestId = params?.requestId;
          const method = params?.request?.method;
          const url = params?.request?.url;
          if (!requestId || !method || !url) {
            return null;
          }

          requests.set(requestId, { method, url });
          return {
            id: requestId,
            stage: "request",
            method,
            url,
          };
        }

        if (payload.method === "Network.responseReceived") {
          const params = payload.params as
            | {
                requestId?: string;
                response?: {
                  url?: string;
                  status?: number;
                };
              }
            | undefined;

          const requestId = params?.requestId;
          if (!requestId) {
            return null;
          }

          const knownRequest = requests.get(requestId);
          return {
            id: requestId,
            stage: "response",
            method: knownRequest?.method ?? "UNKNOWN",
            url: params?.response?.url ?? knownRequest?.url ?? "",
            status: params?.response?.status,
          };
        }

        if (payload.method === "Network.loadingFailed") {
          const params = payload.params as
            | {
                requestId?: string;
                errorText?: string;
              }
            | undefined;

          const requestId = params?.requestId;
          if (!requestId) {
            return null;
          }

          const knownRequest = requests.get(requestId);
          return {
            id: requestId,
            stage: "failed",
            method: knownRequest?.method ?? "UNKNOWN",
            url: knownRequest?.url ?? "",
            errorText: params?.errorText,
          };
        }

        return null;
      },
      "Could not connect to the WebView debugger WebSocket.",
    );
  } finally {
    cleanup();
  }
};
