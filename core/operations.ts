import { createBackends, tailSessionLogs } from "./registry.ts";
import { HarnessError } from "./errors.ts";
import { listSessions, loadSession } from "./storage.ts";
import { appendTimelineActionIfActive } from "./timeline.ts";
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
} from "./ui-types.ts";

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

const summarizeSelector = (selector: UiSelector): string | undefined => {
  if ("elementId" in selector && selector.elementId) {
    return `element:${selector.elementId}`;
  }

  if ("name" in selector && selector.name) {
    return `name:${selector.name}`;
  }

  if ("placeholder" in selector && selector.placeholder) {
    return `placeholder:${selector.placeholder}`;
  }

  if ("text" in selector && selector.text) {
    return selector.role
      ? `${selector.role}:${selector.text}`
      : `text:${selector.text}`;
  }

  if ("selector" in selector && selector.selector) {
    return `selector:${selector.selector}`;
  }

  return undefined;
};

const summarizeActionResult = (result: UiActionResult): string | undefined => {
  const matched = result.matchedElement;
  if (!matched) {
    return undefined;
  }

  return matched.text ?? matched.name ?? matched.placeholder ?? matched.label;
};

export const resolveSessionId = async (sessionId?: string): Promise<string> => {
  if (sessionId) {
    await loadSession(sessionId);
    return sessionId;
  }

  const sessions = await listSessions();
  const latestSession = sessions[0];
  if (!latestSession) {
    throw new HarnessError(
      "invalid_input",
      "No harness session was found. Attach a session first or pass --session <id>.",
    );
  }

  return latestSession.id;
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
  sessionId?: string,
): Promise<WebviewTarget[]> => {
  const resolvedSessionId = await resolveSessionId(sessionId);
  return await (await getBackendForSession(resolvedSessionId)).listWebviews(
    resolvedSessionId,
  );
};

export const resolveWebviewTarget = async (
  sessionId?: string,
  targetId?: string,
): Promise<{ sessionId: string; target: WebviewTarget }> => {
  const resolvedSessionId = await resolveSessionId(sessionId);
  const targets = await listSessionWebviews(resolvedSessionId);

  if (targets.length === 0) {
    throw new HarnessError(
      "invalid_input",
      `No WebView targets were found for session "${resolvedSessionId}".`,
      { sessionId: resolvedSessionId },
    );
  }

  if (targetId) {
    const explicitTarget = targets.find((target) => target.id === targetId);
    if (!explicitTarget) {
      throw new HarnessError(
        "invalid_input",
        `WebView target "${targetId}" was not found for session "${resolvedSessionId}".`,
        { sessionId: resolvedSessionId, targetId },
      );
    }

    return { sessionId: resolvedSessionId, target: explicitTarget };
  }

  const attachedTargets = targets.filter((target) => target.attached);
  if (attachedTargets.length === 1) {
    return { sessionId: resolvedSessionId, target: attachedTargets[0]! };
  }

  if (targets.length === 1) {
    return { sessionId: resolvedSessionId, target: targets[0]! };
  }

  throw new HarnessError(
    "invalid_input",
    `Multiple WebView targets are available for session "${resolvedSessionId}". Pass --target <id>.`,
    { sessionId: resolvedSessionId, targetCount: targets.length },
  );
};

export const captureSessionWebviewScreenshot = async (
  sessionId?: string,
  targetId?: string,
  options?: ScreenshotOptions,
): Promise<Artifact> => {
  const resolved = await resolveWebviewTarget(sessionId, targetId);
  return await (
    await getBackendForSession(resolved.sessionId)
  ).captureWebviewScreenshot(resolved.sessionId, resolved.target.id, options);
};

export const evalSessionJs = async (
  sessionId: string | undefined,
  targetId: string | undefined,
  expression: string,
): Promise<EvalResult> => {
  const resolved = await resolveWebviewTarget(sessionId, targetId);
  return await (
    await getBackendForSession(resolved.sessionId)
  ).evalJs(resolved.sessionId, resolved.target.id, expression);
};

export const streamSessionConsole = async (
  sessionId?: string,
  targetId?: string,
): Promise<AsyncIterable<ConsoleEvent>> => {
  const resolved = await resolveWebviewTarget(sessionId, targetId);
  return (await getBackendForSession(resolved.sessionId)).streamConsole(
    resolved.sessionId,
    resolved.target.id,
  );
};

export const streamSessionNetwork = async (
  sessionId?: string,
  targetId?: string,
): Promise<AsyncIterable<NetworkEvent>> => {
  const resolved = await resolveWebviewTarget(sessionId, targetId);
  return (await getBackendForSession(resolved.sessionId)).streamNetwork(
    resolved.sessionId,
    resolved.target.id,
  );
};

export const readSessionLogs = async (
  sessionId: string | undefined,
  options?: TailLogsOptions & BoundedReadOptions,
): Promise<LogEvent[]> => {
  const resolvedSessionId = await resolveSessionId(sessionId);
  return await collectBoundedStream(
    await tailSessionLogs(resolvedSessionId, { filter: options?.filter }),
    options,
  );
};

export const readSessionConsole = async (
  sessionId?: string,
  targetId?: string,
  options?: BoundedReadOptions,
): Promise<ConsoleEvent[]> => {
  return await collectBoundedStream(
    await streamSessionConsole(sessionId, targetId),
    options,
  );
};

export const readSessionNetwork = async (
  sessionId?: string,
  targetId?: string,
  options?: BoundedReadOptions,
): Promise<NetworkEvent[]> => {
  return await collectBoundedStream(
    await streamSessionNetwork(sessionId, targetId),
    options,
  );
};

export const snapshotSessionUi = async (
  sessionId?: string,
  targetId?: string,
  options?: UiSnapshotOptions,
): Promise<{
  sessionId: string;
  targetId: string;
  snapshot: UiSnapshot;
}> => {
  const resolvedSessionId = await resolveSessionId(sessionId);
  const backend = await getBackendForSession(resolvedSessionId);

  try {
    const resolved = await resolveWebviewTarget(resolvedSessionId, targetId);
    const snapshot = await backend.snapshotUi(
      resolved.sessionId,
      resolved.target.id,
      options,
    );

    return {
      sessionId: resolved.sessionId,
      targetId: resolved.target.id,
      snapshot,
    };
  } catch (error) {
    const session = await loadSession(resolvedSessionId);
    const capabilities = await backend.getCapabilities(resolvedSessionId);
    if (session.platform !== "ios" || !capabilities.canAutomateNativeUi) {
      throw error;
    }

    const snapshot = await backend.snapshotUi(
      resolvedSessionId,
      targetId ?? "native",
      options,
    );

    return {
      sessionId: resolvedSessionId,
      targetId: targetId ?? "native",
      snapshot,
    };
  }
};

const resolveUiTarget = async (
  sessionId?: string,
  targetId?: string,
): Promise<{
  sessionId: string;
  targetId: string;
}> => {
  const resolvedSessionId = await resolveSessionId(sessionId);
  const backend = await getBackendForSession(resolvedSessionId);

  try {
    const resolved = await resolveWebviewTarget(resolvedSessionId, targetId);
    return {
      sessionId: resolved.sessionId,
      targetId: resolved.target.id,
    };
  } catch (error) {
    const session = await loadSession(resolvedSessionId);
    const capabilities = await backend.getCapabilities(resolvedSessionId);
    if (session.platform !== "ios" || !capabilities.canAutomateNativeUi) {
      throw error;
    }

    return {
      sessionId: resolvedSessionId,
      targetId: targetId ?? "native",
    };
  }
};

export const inspectSessionUi = async (
  selector: UiSelector,
  sessionId?: string,
  targetId?: string,
): Promise<{
  sessionId: string;
  targetId: string;
  result: UiInspectResult;
}> => {
  const resolved = await resolveUiTarget(sessionId, targetId);
  const result = await (
    await getBackendForSession(resolved.sessionId)
  ).inspectUi(resolved.sessionId, resolved.targetId, selector);

  return {
    sessionId: resolved.sessionId,
    targetId: resolved.targetId,
    result,
  };
};

const performUiAction = async (
  action:
    | {
        type: "click";
        selector: UiSelector;
      }
    | {
        type: "tap";
        point: UiTapOptions;
      }
    | {
        type: "type";
        selector: UiSelector;
        text: string;
        options?: UiTypeOptions;
      }
    | {
        type: "clear";
        selector: UiSelector;
      },
  sessionId?: string,
  targetId?: string,
): Promise<{
  sessionId: string;
  targetId: string;
  result: UiActionResult;
}> => {
  const resolved = await resolveUiTarget(sessionId, targetId);
  const backend = await getBackendForSession(resolved.sessionId);
  let result: UiActionResult;

  if (action.type === "click") {
    result = await backend.clickUi(
      resolved.sessionId,
      resolved.targetId,
      action.selector,
    );
  } else if (action.type === "tap") {
    result = await backend.tapUi(
      resolved.sessionId,
      resolved.targetId,
      action.point,
    );
  } else if (action.type === "type") {
    result = await backend.typeIntoUi(
      resolved.sessionId,
      resolved.targetId,
      action.selector,
      action.text,
      action.options,
    );
  } else {
    result = await backend.clearUi(
      resolved.sessionId,
      resolved.targetId,
      action.selector,
    );
  }

  await appendTimelineActionIfActive(resolved.sessionId, {
    actionName: action.type === "type" ? "ui.type" : `ui.${action.type}`,
    selectorSummary: action.type === "tap"
      ? `point:${action.point.x},${action.point.y}`
      : summarizeSelector(action.selector),
    resultSummary: summarizeActionResult(result),
  });

  return {
    sessionId: resolved.sessionId,
    targetId: resolved.targetId,
    result,
  };
};

const performUiRead = async (
  selector: UiSelector,
  sessionId?: string,
  targetId?: string,
): Promise<{
  sessionId: string;
  targetId: string;
  result: UiReadResult;
}> => {
  const resolved = await resolveUiTarget(sessionId, targetId);
  const result = await (
    await getBackendForSession(resolved.sessionId)
  ).readUi(resolved.sessionId, resolved.targetId, selector);

  return {
    sessionId: resolved.sessionId,
    targetId: resolved.targetId,
    result,
  };
};

const performUiPress = async (
  selector: UiSelector,
  options: UiPressOptions,
  sessionId?: string,
  targetId?: string,
): Promise<{
  sessionId: string;
  targetId: string;
  result: UiActionResult;
}> => {
  const resolved = await resolveUiTarget(sessionId, targetId);
  const result = await (
    await getBackendForSession(resolved.sessionId)
  ).pressUi(resolved.sessionId, resolved.targetId, selector, options);

  await appendTimelineActionIfActive(resolved.sessionId, {
    actionName: "ui.press",
    selectorSummary: summarizeSelector(selector),
    resultSummary: summarizeActionResult(result),
  });

  return {
    sessionId: resolved.sessionId,
    targetId: resolved.targetId,
    result,
  };
};

export const clickSessionUi = async (
  selector: UiSelector,
  sessionId?: string,
  targetId?: string,
) => {
  return await performUiAction({ type: "click", selector }, sessionId, targetId);
};

export const tapSessionUi = async (
  point: UiTapOptions,
  sessionId?: string,
  targetId?: string,
) => {
  return await performUiAction({ type: "tap", point }, sessionId, targetId);
};

export const typeIntoSessionUi = async (
  selector: UiSelector,
  text: string,
  sessionId?: string,
  targetId?: string,
  options?: UiTypeOptions,
) => {
  return await performUiAction(
    { type: "type", selector, text, options },
    sessionId,
    targetId,
  );
};

export const clearSessionUi = async (
  selector: UiSelector,
  sessionId?: string,
  targetId?: string,
) => {
  return await performUiAction({ type: "clear", selector }, sessionId, targetId);
};

export const readSessionUi = async (
  selector: UiSelector,
  sessionId?: string,
  targetId?: string,
) => {
  return await performUiRead(selector, sessionId, targetId);
};

export const pressSessionUi = async (
  selector: UiSelector,
  options: UiPressOptions,
  sessionId?: string,
  targetId?: string,
) => {
  return await performUiPress(selector, options, sessionId, targetId);
};

export const waitForSessionUi = async (
  condition: UiWaitCondition,
  sessionId?: string,
  targetId?: string,
): Promise<{
  sessionId: string;
  targetId: string;
  result: UiWaitResult;
}> => {
  const resolved = await resolveUiTarget(sessionId, targetId);
  const result = await (
    await getBackendForSession(resolved.sessionId)
  ).waitForUi(resolved.sessionId, resolved.targetId, condition);

  return {
    sessionId: resolved.sessionId,
    targetId: resolved.targetId,
    result,
  };
};
