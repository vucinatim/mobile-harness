import path from "node:path";
import { spawn } from "node:child_process";
import { createBackends } from "./registry.ts";
import { HarnessError } from "./errors.ts";
import { loadSession } from "./storage.ts";
import {
  appendRecordingEvent,
  clearRecordingEvents,
  loadRecordingState,
  readRecordingEvents,
  saveRecordingState,
} from "./timeline-store.ts";
import type {
  ActionRecordingEvent,
  BaseRecordingEvent,
  ConsoleRecordingEvent,
  ErrorRecordingEvent,
  MarkerRecordingEvent,
  NativeLogRecordingEvent,
  NetworkRecordingEvent,
  RecorderConfig,
  RecorderWorkerKind,
  RecordingEvent,
  RecordingReadOptions,
  RecordingReadResult,
  RecordingReadSummary,
  RecordingSeverity,
  RecordingState,
  UiSnapshotRecordingEvent,
} from "./timeline-types.ts";
import { defaultRecorderConfig } from "./timeline-types.ts";
import type { ConsoleEvent, LogEvent, NetworkEvent, WebviewTarget } from "./types.ts";

const getCliEntryPath = () =>
  path.resolve(import.meta.dir, "../cli/index.ts");

const spawnWorker = (
  kind: RecorderWorkerKind,
  sessionId: string,
  targetId: string,
): number => {
  const cliPath = getCliEntryPath();
  const worker = spawn(
    process.execPath,
    [
      cliPath,
      "__timeline-worker",
      kind,
      "--session",
      sessionId,
      "--target",
      targetId,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    },
  );

  worker.unref();

  if (!worker.pid || !Number.isFinite(worker.pid)) {
    throw new HarnessError(
      "command_failed",
      `Could not start ${kind} timeline worker.`,
    );
  }

  return worker.pid;
};

const stopWorker = (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore already-dead workers.
  }
};

const isPidRunning = (pid?: number) => {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const getBackendForSession = async (sessionId: string) => {
  const session = await loadSession(sessionId);
  return createBackends()[session.platform];
};

const applyTargetAndWorkerState = async (
  state: RecordingState,
  targetId?: string,
) => {
  const nextState: RecordingState = {
    ...state,
    targetId: targetId ?? state.targetId,
    workers: { ...state.workers },
  };

  if (nextState.config.nativeLogs && !isPidRunning(nextState.workers.nativeLog)) {
    nextState.workers.nativeLog = spawnWorker(
      "nativeLog",
      nextState.sessionId,
      nextState.targetId ?? "native-only",
    );
  }

  if (nextState.targetId) {
    if (
      nextState.config.console &&
      !isPidRunning(nextState.workers.console)
    ) {
      nextState.workers.console = spawnWorker(
        "console",
        nextState.sessionId,
        nextState.targetId,
      );
    }

    if (
      nextState.config.network &&
      !isPidRunning(nextState.workers.network)
    ) {
      nextState.workers.network = spawnWorker(
        "network",
        nextState.sessionId,
        nextState.targetId,
      );
    }
  }

  await saveRecordingState(nextState);
  return nextState;
};

const resolveRecordingTarget = async (
  sessionId: string,
  targetId?: string,
): Promise<WebviewTarget> => {
  const backend = await getBackendForSession(sessionId);
  const targets = await backend.listWebviews(sessionId);

  if (targets.length === 0) {
    throw new HarnessError(
      "invalid_input",
      `No WebView targets were found for session "${sessionId}".`,
      { sessionId },
    );
  }

  if (targetId) {
    const explicitTarget = targets.find((entry) => entry.id === targetId);
    if (!explicitTarget) {
      throw new HarnessError(
        "invalid_input",
        `WebView target "${targetId}" was not found for session "${sessionId}".`,
        { sessionId, targetId },
      );
    }

    return explicitTarget;
  }

  const attachedTargets = targets.filter((entry) => entry.attached);
  if (attachedTargets.length === 1) {
    return attachedTargets[0]!;
  }

  if (targets.length === 1) {
    return targets[0]!;
  }

  throw new HarnessError(
    "invalid_input",
    `Multiple WebView targets are available for session "${sessionId}". Pass --target <id>.`,
    { sessionId, targetCount: targets.length },
  );
};

const createBaseEvent = <K extends RecordingEvent["kind"]>(
  sessionId: string,
  kind: K,
  source: BaseRecordingEvent["source"],
  severity: RecordingSeverity,
  summary: string,
  detail?: string,
): BaseRecordingEvent & { kind: K } => ({
  id: crypto.randomUUID(),
  sessionId,
  timestamp: new Date().toISOString(),
  kind,
  source,
  severity,
  summary,
  detail,
});

export const appendRecordingEventForSession = async (
  sessionId: string,
  event: RecordingEvent,
) => {
  await appendRecordingEvent(event);
};

const appendSynthesizedError = async (
  sessionId: string,
  summary: string,
  detail: string | undefined,
  errorKind: ErrorRecordingEvent["errorKind"],
  source: ErrorRecordingEvent["source"],
  raw?: unknown,
) => {
  const event: ErrorRecordingEvent = {
    ...createBaseEvent(sessionId, "error", source, "error", summary, detail),
    errorKind,
    raw,
  };

  await appendRecordingEventForSession(sessionId, event);
};

const shouldCaptureSnapshot = (
  state: RecordingState,
  trigger: "marker" | "error" | "action",
) => {
  if (trigger === "marker") {
    return state.config.uiSnapshots === "markers";
  }

  if (trigger === "error") {
    return state.config.uiSnapshots === "errors";
  }

  return state.config.uiSnapshots === "all-actions";
};

const captureSummarySnapshot = async (state: RecordingState) => {
  if (!state.targetId) {
    return;
  }

  const backend = await getBackendForSession(state.sessionId);
  const snapshot = await backend.snapshotUi(state.sessionId, state.targetId, {
    detail: "summary",
  });
  const event: UiSnapshotRecordingEvent = {
    ...createBaseEvent(
      state.sessionId,
      "uiSnapshot",
      "webview",
      "info",
      `Captured UI snapshot on ${snapshot.route}.`,
    ),
    snapshot,
  };
  await appendRecordingEventForSession(state.sessionId, event);
};

export const getRecordingStatus = async (sessionId: string) => {
  const state = await loadRecordingState(sessionId);
  if (!state) {
    return null;
  }

  const workers = Object.fromEntries(
    Object.entries(state.workers).map(([kind, pid]) => [
      kind,
      pid
        ? {
            pid,
            running: isPidRunning(pid),
          }
        : null,
    ]),
  );

  return {
    ...state,
    workers,
  };
};

const activateTimeline = async (
  sessionId: string,
  targetId?: string,
  config?: Partial<RecorderConfig>,
  options?: {
    resetEvents?: boolean;
    insertSystemMarker?: boolean;
  },
) => {
  let resolvedTargetId: string | undefined;
  try {
    resolvedTargetId = (await resolveRecordingTarget(sessionId, targetId)).id;
  } catch (error) {
    if (!(error instanceof HarnessError)) {
      throw error;
    }

    const nativeLogsEnabled = config?.nativeLogs ?? defaultRecorderConfig().nativeLogs;
    if (!nativeLogsEnabled) {
      throw error;
    }
  }
  const mergedConfig = {
    ...defaultRecorderConfig(),
    ...config,
  };

  if (options?.resetEvents) {
    await clearRecordingEvents(sessionId);
  }

  const state: RecordingState = {
    sessionId,
    targetId: resolvedTargetId,
    startedAt: new Date().toISOString(),
    active: true,
    config: mergedConfig,
    workers: {},
  };

  if (mergedConfig.console && resolvedTargetId) {
    state.workers.console = spawnWorker("console", sessionId, resolvedTargetId);
  }

  if (mergedConfig.network && resolvedTargetId) {
    state.workers.network = spawnWorker("network", sessionId, resolvedTargetId);
  }

  if (mergedConfig.nativeLogs) {
    state.workers.nativeLog = spawnWorker(
      "nativeLog",
      sessionId,
      resolvedTargetId ?? "native-only",
    );
  }

  await saveRecordingState(state);

  if (options?.insertSystemMarker) {
    const startMarker: MarkerRecordingEvent = {
      ...createBaseEvent(
        sessionId,
        "marker",
        "system",
        "info",
        "Timeline activated for session.",
      ),
      label: "timeline-started",
    };

    await appendRecordingEventForSession(sessionId, startMarker);
    if (shouldCaptureSnapshot(state, "marker")) {
      await captureSummarySnapshot(state);
    }
  }

  return state;
};

export const ensureTimeline = async (
  sessionId: string,
  targetId?: string,
  config?: Partial<RecorderConfig>,
) => {
  const existing = await loadRecordingState(sessionId);

  if (!existing?.active) {
    return await activateTimeline(sessionId, targetId, config, {
      resetEvents: !existing,
      insertSystemMarker: !existing,
    });
  }

  let resolvedTargetId = targetId ?? existing.targetId;
  const shouldRefreshTarget =
    !!targetId ||
    !existing.targetId ||
    (existing.config.console && !isPidRunning(existing.workers.console)) ||
    (existing.config.network && !isPidRunning(existing.workers.network));

  if (shouldRefreshTarget) {
    try {
      resolvedTargetId = (await resolveRecordingTarget(sessionId, targetId)).id;
    } catch {
      resolvedTargetId = targetId ?? existing.targetId;
    }
  }

  return await applyTargetAndWorkerState(existing, resolvedTargetId);
};

export const resetTimeline = async (
  sessionId: string,
  targetId?: string,
  config?: Partial<RecorderConfig>,
) => {
  const existing = await loadRecordingState(sessionId);
  if (existing?.active) {
    for (const pid of Object.values(existing.workers)) {
      if (pid) {
        stopWorker(pid);
      }
    }
  }

  const state = await activateTimeline(sessionId, targetId, config, {
    resetEvents: true,
    insertSystemMarker: false,
  });

  const resetMarker: MarkerRecordingEvent = {
    ...createBaseEvent(
      sessionId,
      "marker",
      "system",
      "info",
      "Timeline reset.",
    ),
    label: "timeline-reset",
  };

  await appendRecordingEventForSession(sessionId, resetMarker);
  if (shouldCaptureSnapshot(state, "marker")) {
    await captureSummarySnapshot(state);
  }

  return state;
};

export const deactivateTimeline = async (sessionId: string) => {
  const state = await loadRecordingState(sessionId);
  if (!state) {
    throw new HarnessError(
      "invalid_input",
      `No timeline was found for session "${sessionId}".`,
      { sessionId },
    );
  }

  for (const pid of Object.values(state.workers)) {
    if (pid) {
      stopWorker(pid);
    }
  }

  const nextState: RecordingState = {
    ...state,
    active: false,
    stoppedAt: new Date().toISOString(),
  };
  await saveRecordingState(nextState);

  return nextState;
};

export const getTimelineStatus = getRecordingStatus;

export const markTimeline = async (
  sessionId: string,
  label: string,
  note?: string,
) => {
  const state = await ensureTimeline(sessionId);

  const event: MarkerRecordingEvent = {
    ...createBaseEvent(
      sessionId,
      "marker",
      "cli",
      "info",
      `Marker: ${label}`,
      note,
    ),
    label,
    note,
  };

  await appendRecordingEventForSession(sessionId, event);

  if (shouldCaptureSnapshot(state, "marker")) {
    await captureSummarySnapshot(state);
  }

  return event;
};

const formatSelectorSummary = (selectorSummary?: string, actionName?: string) =>
  selectorSummary
    ? `${actionName ?? "action"} on ${selectorSummary}`
    : actionName ?? "action";

export const appendTimelineActionIfActive = async (
  sessionId: string,
  input: {
    actionName: string;
    selectorSummary?: string;
    resultSummary?: string;
  },
) => {
  const state = await loadRecordingState(sessionId);
  if (!state?.active) {
    return;
  }

  const event: ActionRecordingEvent = {
    ...createBaseEvent(
      sessionId,
      "action",
      "cli",
      "info",
      formatSelectorSummary(input.selectorSummary, input.actionName),
      input.resultSummary,
    ),
    actionName: input.actionName,
    selectorSummary: input.selectorSummary,
    resultSummary: input.resultSummary,
  };

  await appendRecordingEventForSession(sessionId, event);

  if (shouldCaptureSnapshot(state, "action")) {
    await captureSummarySnapshot(state);
  }
};

const isNetworkFailure = (event: NetworkEvent) =>
  event.stage === "failed" ||
  (event.stage === "response" && typeof event.status === "number" && event.status >= 400);

const toConsoleText = (event: ConsoleEvent) => event.args.join(" ").trim();

const summarizeNativeLog = (event: LogEvent) => {
  const prefix = event.tag ? `[${event.tag}] ` : "";
  const maxLength = 220;
  const message =
    event.message.length > maxLength
      ? `${event.message.slice(0, maxLength - 1)}…`
      : event.message;
  return `${prefix}${message}`;
};

const shouldSynthesizeNativeError = (event: LogEvent, severity: RecordingSeverity) => {
  if (severity === "error") {
    return true;
  }

  if (severity === "warn") {
    return /\b(exception|fatal|crash|failed)\b/i.test(event.message);
  }

  return false;
};

export const appendTimelineConsoleEvent = async (
  sessionId: string,
  event: ConsoleEvent,
) => {
  const text = toConsoleText(event);
  const recordingEvent: ConsoleRecordingEvent = {
    ...createBaseEvent(
      sessionId,
      "console",
      "webview",
      event.type === "error" ? "error" : event.type === "warn" ? "warn" : "info",
      `[console:${event.type}] ${text || "(empty)"}`,
      text,
    ),
    level: event.type,
    text,
    raw: event,
  };
  await appendRecordingEventForSession(sessionId, recordingEvent);

  if (event.type === "error") {
    await appendSynthesizedError(
      sessionId,
      `[console] ${text || "Console error"}`,
      text,
      "console",
      "webview",
      event,
    );
  }
};

export const appendTimelineNetworkEvent = async (
  sessionId: string,
  event: NetworkEvent,
) => {
  const summary =
    event.stage === "response"
      ? `[network:${event.stage}] ${event.method} ${event.url} -> ${event.status ?? "unknown"}`
      : event.stage === "failed"
        ? `[network:${event.stage}] ${event.method} ${event.url} -> ${event.errorText ?? "failed"}`
        : `[network:${event.stage}] ${event.method} ${event.url}`;

  const recordingEvent: NetworkRecordingEvent = {
    ...createBaseEvent(
      sessionId,
      "network",
      "webview",
      isNetworkFailure(event) ? "error" : "info",
      summary,
    ),
    requestId: event.id,
    stage: event.stage,
    method: event.method,
    url: event.url,
    status: event.status,
    errorText: event.errorText,
    raw: event,
  };
  await appendRecordingEventForSession(sessionId, recordingEvent);

  if (isNetworkFailure(event)) {
    await appendSynthesizedError(
      sessionId,
      summary,
      event.errorText,
      "network",
      "webview",
      event,
    );
  }
};

export const appendTimelineNativeLogEvent = async (
  sessionId: string,
  event: LogEvent,
) => {
  const level = event.level?.toLowerCase();
  const severity: RecordingSeverity =
    level === "error"
      ? "error"
      : level === "warn"
        ? "warn"
        : level === "debug"
          ? "debug"
          : "info";

  const recordingEvent: NativeLogRecordingEvent = {
    ...createBaseEvent(
      sessionId,
      "nativeLog",
      "android",
      severity,
      `[native${level ? `:${level}` : ""}] ${summarizeNativeLog(event)}`,
      event.message,
    ),
    level: event.level,
    message: event.message,
    raw: event,
  };
  await appendRecordingEventForSession(sessionId, recordingEvent);

  if (shouldSynthesizeNativeError(event, severity)) {
    await appendSynthesizedError(
      sessionId,
      `[native] ${summarizeNativeLog(event)}`,
      event.message,
      "nativeLog",
      "android",
      event,
    );
  }
};

const selectEventsForRead = (
  events: RecordingEvent[],
  options?: RecordingReadOptions,
) => {
  let selected = [...events];

  if (options?.sinceMarker) {
    const marker = [...selected]
      .reverse()
      .find(
        (event): event is MarkerRecordingEvent =>
          event.kind === "marker" && event.label === options.sinceMarker,
      );
    if (marker) {
      selected = selected.filter(
        (event) => event.timestamp >= marker.timestamp,
      );
    }
  }

  if (options?.kinds?.length) {
    const kinds = new Set(options.kinds);
    selected = selected.filter((event) => kinds.has(event.kind));
  }

  if (options?.errorsOnly) {
    selected = selected.filter(
      (event) =>
        event.kind === "error" ||
        event.severity === "error" ||
        event.severity === "warn",
    );
  }

  if (options?.last && options.last > 0) {
    selected = selected.slice(-options.last);
  }

  return selected;
};

const buildReadSummary = (
  state: RecordingState | null,
  allEvents: RecordingEvent[],
  selectedEvents: RecordingEvent[],
  returnedEvents: RecordingEvent[],
): RecordingReadSummary => {
  const markers = selectedEvents
    .filter((event): event is MarkerRecordingEvent => event.kind === "marker")
    .map((event) => ({ label: event.label, timestamp: event.timestamp }));
  const actions = selectedEvents
    .filter((event): event is ActionRecordingEvent => event.kind === "action")
    .map((event) => ({ summary: event.summary, timestamp: event.timestamp }));
  const errors = selectedEvents
    .filter((event): event is ErrorRecordingEvent => event.kind === "error")
    .map((event) => ({
      summary: event.summary,
      timestamp: event.timestamp,
      kind: event.errorKind,
    }));
  const warnings = selectedEvents
    .filter((event) => event.severity === "warn")
    .map((event) => ({
      summary: event.summary,
      timestamp: event.timestamp,
      kind: event.kind,
    }));
  const networkFailures = selectedEvents
    .filter(
      (event): event is NetworkRecordingEvent =>
        event.kind === "network" &&
        (event.stage === "failed" ||
          (event.stage === "response" &&
            typeof event.status === "number" &&
            event.status >= 400)),
    )
    .map((event) => ({
      summary: event.summary,
      timestamp: event.timestamp,
    }));

  return {
    sessionId: state?.sessionId ?? "",
    active: state?.active ?? false,
    startedAt: state?.startedAt,
    stoppedAt: state?.stoppedAt,
    targetId: state?.targetId,
    totalEvents: allEvents.length,
    returnedEvents: returnedEvents.length,
    suppressedEvents: Math.max(0, allEvents.length - returnedEvents.length),
    markers,
    actions,
    errors,
    warnings,
    networkFailures,
  };
};

export const readTimeline = async (
  sessionId: string,
  options?: RecordingReadOptions,
): Promise<RecordingReadResult> => {
  const state = await ensureTimeline(sessionId);
  const allEvents = await readRecordingEvents(sessionId);
  const maxEvents = state?.config.maxEvents ?? defaultRecorderConfig().maxEvents;
  const selectedEvents = selectEventsForRead(allEvents, options);
  let returnedEvents = selectedEvents.slice(-maxEvents);

  if (selectedEvents.length > maxEvents) {
    const preservedMarkers = selectedEvents.filter(
      (event): event is MarkerRecordingEvent => event.kind === "marker",
    );

    if (preservedMarkers.length > 0) {
      const keepIds = new Set(preservedMarkers.map((event) => event.id));
      const tail = selectedEvents
        .filter((event) => !keepIds.has(event.id))
        .slice(-(maxEvents - preservedMarkers.length));
      returnedEvents = [...preservedMarkers, ...tail].sort((left, right) =>
        left.timestamp.localeCompare(right.timestamp),
      );
    }
  }
  const detail = options?.detail ?? "summary";
  const summary = buildReadSummary(state, allEvents, selectedEvents, returnedEvents);

  return {
    state,
    summary,
    events: detail === "summary" ? undefined : returnedEvents,
  };
};

export const runRecordingWorker = async (
  kind: RecorderWorkerKind,
  sessionId: string,
  targetId: string,
) => {
  const state = await loadRecordingState(sessionId);
  if (!state?.active) {
    return;
  }

  const backend = await getBackendForSession(sessionId);

  if (kind === "nativeLog") {
    for await (const event of backend.tailLogs(sessionId)) {
      await appendTimelineNativeLogEvent(sessionId, event);
    }
    return;
  }

  if (kind === "console") {
    for await (const event of backend.streamConsole(sessionId, targetId)) {
      await appendTimelineConsoleEvent(sessionId, event);
    }
    return;
  }

  for await (const event of backend.streamNetwork(sessionId, targetId)) {
    await appendTimelineNetworkEvent(sessionId, event);
  }
};
