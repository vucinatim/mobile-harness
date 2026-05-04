import { createBackends, tailSessionLogs } from "./registry.ts";
import { loadSession } from "./storage.ts";
import type {
  Artifact,
  ConsoleEvent,
  EvalResult,
  LogEvent,
  NetworkEvent,
  ScreenshotOptions,
  TailLogsOptions,
  WebviewTarget,
} from "./types.ts";

export type BoundedReadOptions = {
  maxEvents?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_TIMEOUT_MS = 2_000;

const getBackendForSession = async (sessionId: string) => {
  const session = await loadSession(sessionId);
  return createBackends()[session.platform];
};

const waitForNextValue = async <T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export const collectBoundedStream = async <T>(
  stream: AsyncIterable<T>,
  options?: BoundedReadOptions,
): Promise<T[]> => {
  const iterator = stream[Symbol.asyncIterator]();
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const items: T[] = [];

  try {
    while (items.length < maxEvents) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const next = await waitForNextValue(iterator, remainingMs);
      if (next === null || next.done) {
        break;
      }

      items.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }

  return items;
};

export const listSessionWebviews = async (
  sessionId: string,
): Promise<WebviewTarget[]> => {
  return await (await getBackendForSession(sessionId)).listWebviews(sessionId);
};

export const captureSessionWebviewScreenshot = async (
  sessionId: string,
  targetId: string,
  options?: ScreenshotOptions,
): Promise<Artifact> => {
  return await (await getBackendForSession(sessionId)).captureWebviewScreenshot(
    sessionId,
    targetId,
    options,
  );
};

export const evalSessionJs = async (
  sessionId: string,
  targetId: string,
  expression: string,
): Promise<EvalResult> => {
  return await (await getBackendForSession(sessionId)).evalJs(
    sessionId,
    targetId,
    expression,
  );
};

export const streamSessionConsole = async (
  sessionId: string,
  targetId: string,
): Promise<AsyncIterable<ConsoleEvent>> => {
  return (await getBackendForSession(sessionId)).streamConsole(
    sessionId,
    targetId,
  );
};

export const streamSessionNetwork = async (
  sessionId: string,
  targetId: string,
): Promise<AsyncIterable<NetworkEvent>> => {
  return (await getBackendForSession(sessionId)).streamNetwork(
    sessionId,
    targetId,
  );
};

export const readSessionLogs = async (
  sessionId: string,
  options?: TailLogsOptions & BoundedReadOptions,
): Promise<LogEvent[]> => {
  return await collectBoundedStream(
    await tailSessionLogs(sessionId, { filter: options?.filter }),
    options,
  );
};

export const readSessionConsole = async (
  sessionId: string,
  targetId: string,
  options?: BoundedReadOptions,
): Promise<ConsoleEvent[]> => {
  return await collectBoundedStream(
    await streamSessionConsole(sessionId, targetId),
    options,
  );
};

export const readSessionNetwork = async (
  sessionId: string,
  targetId: string,
  options?: BoundedReadOptions,
): Promise<NetworkEvent[]> => {
  return await collectBoundedStream(
    await streamSessionNetwork(sessionId, targetId),
    options,
  );
};
