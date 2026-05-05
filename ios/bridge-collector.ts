import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { appendRecordingEvent } from "../core/timeline-store.ts";
import { HarnessError } from "../core/errors.ts";
import { getHarnessRootPath, listSessions } from "../core/storage.ts";
import { loadRecordingState } from "../core/timeline-store.ts";
import type {
  BaseRecordingEvent,
  ConsoleRecordingEvent,
  ErrorRecordingEvent,
  NetworkRecordingEvent,
  RecordingEvent,
  RecordingSeverity,
} from "../core/timeline-types.ts";
import type { ConsoleEvent, NetworkEvent } from "../core/types.ts";

export const IOS_BRIDGE_COLLECTOR_PORT = 49152;
const IOS_BRIDGE_COLLECTOR_PATH = "/__mobile_harness/collect";
const IOS_BRIDGE_COLLECTOR_HEALTH_PATH = "/__mobile_harness/health";
const IOS_BRIDGE_CONTROL_REQUEST_PATH = "/__mobile_harness/control/request";
const IOS_BRIDGE_CONTROL_NEXT_PATH = "/__mobile_harness/control/next";
const IOS_BRIDGE_CONTROL_RESULT_PATH = "/__mobile_harness/control/result";
const IOS_BRIDGE_COLLECTOR_STATE_FILE = "ios-bridge-collector.json";
const IOS_BRIDGE_COLLECTOR_PROTOCOL_VERSION = 2;

type CollectorState = {
  pid: number;
  port: number;
  startedAt: string;
};

type CollectorHealthPayload = {
  ok?: boolean;
  protocolVersion?: number;
};

type BridgeEnvelope = {
  appId?: string;
  event?: {
    kind?: "console" | "network";
    level?: ConsoleEvent["type"];
    args?: unknown[];
    timestamp?: string;
    id?: string;
    stage?: NetworkEvent["stage"];
    method?: string;
    url?: string;
    status?: number;
    errorText?: string;
  };
};

type BridgeControlCommand =
  | {
      id: string;
      kind: "eval";
      expression: string;
    };

type BridgeControlRequestBody = {
  appId?: string;
  timeoutMs?: number;
  command?: {
    kind?: "eval";
    expression?: string;
  };
};

type BridgeControlResultBody = {
  appId?: string;
  commandId?: string;
  ok?: boolean;
  value?: unknown;
  error?: {
    message?: string;
    name?: string;
    stack?: string;
  };
};

type BridgePendingResult = {
  resolve: (value: BridgeControlResultBody) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingCommandsByAppId = new Map<string, BridgeControlCommand[]>();
const waitingCommandPollsByAppId = new Map<
  string,
  Array<(command: BridgeControlCommand | null) => void>
>();
const pendingResultsByCommandId = new Map<string, BridgePendingResult>();

const collectorStatePath = () =>
  path.join(getHarnessRootPath(), IOS_BRIDGE_COLLECTOR_STATE_FILE);

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

const getCliEntryPath = () => path.resolve(import.meta.dir, "../cli/index.ts");

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

const toConsoleText = (event: ConsoleEvent) => event.args.join(" ").trim();

const isNetworkFailure = (event: NetworkEvent) =>
  event.stage === "failed" ||
  (event.stage === "response" &&
    typeof event.status === "number" &&
    event.status >= 400);

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

  await appendRecordingEvent(event);
};

const appendTimelineConsoleEvent = async (
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
  await appendRecordingEvent(recordingEvent);

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

const appendTimelineNetworkEvent = async (
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
  await appendRecordingEvent(recordingEvent);

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

const resolveActiveBridgeSessionId = async (appId: string) => {
  const sessions = await listSessions();
  const matches = sessions.filter(
    (session) =>
      session.platform === "ios" &&
      session.appId === appId &&
      session.integrations?.capacitorIOSBridge === true,
  );

  for (const session of matches) {
    const recordingState = await loadRecordingState(session.id);
    if (
      recordingState?.active &&
      (recordingState.config.console || recordingState.config.network)
    ) {
      return session.id;
    }
  }

  return null;
};

const normalizeConsoleArgs = (args: unknown[] | undefined) =>
  Array.isArray(args)
    ? args.map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )
    : [];

const handleEnvelope = async (payload: BridgeEnvelope) => {
  if (!payload.appId || !payload.event?.kind) {
    return false;
  }

  const sessionId = await resolveActiveBridgeSessionId(payload.appId);
  if (!sessionId) {
    return false;
  }

  if (payload.event.kind === "console") {
    const level = payload.event.level;
    await appendTimelineConsoleEvent(sessionId, {
      type:
        level === "debug" ||
        level === "info" ||
        level === "warn" ||
        level === "error"
          ? level
          : "log",
      args: normalizeConsoleArgs(payload.event.args),
      timestamp: payload.event.timestamp,
    });
    return true;
  }

  if (
    payload.event.kind === "network" &&
    payload.event.id &&
    payload.event.stage &&
    payload.event.method &&
    payload.event.url
  ) {
    await appendTimelineNetworkEvent(sessionId, {
      id: payload.event.id,
      stage: payload.event.stage,
      method: payload.event.method,
      url: payload.event.url,
      status: payload.event.status,
      errorText: payload.event.errorText,
    });
    return true;
  }

  return false;
};

const enqueueBridgeCommand = (
  appId: string,
  command: BridgeControlCommand,
) => {
  const waiters = waitingCommandPollsByAppId.get(appId);
  if (waiters && waiters.length > 0) {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(command);
      return;
    }
  }

  const queue = pendingCommandsByAppId.get(appId) ?? [];
  queue.push(command);
  pendingCommandsByAppId.set(appId, queue);
};

const awaitNextBridgeCommand = async (
  appId: string,
  timeoutMs: number,
): Promise<BridgeControlCommand | null> => {
  const queue = pendingCommandsByAppId.get(appId);
  if (queue && queue.length > 0) {
    const next = queue.shift() ?? null;
    if (queue.length === 0) {
      pendingCommandsByAppId.delete(appId);
    }
    return next;
  }

  return await new Promise<BridgeControlCommand | null>((resolve) => {
    const timer = setTimeout(() => {
      const waiters = waitingCommandPollsByAppId.get(appId);
      if (waiters) {
        const index = waiters.indexOf(resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        if (waiters.length === 0) {
          waitingCommandPollsByAppId.delete(appId);
        }
      }
      resolve(null);
    }, timeoutMs);

    const waiters = waitingCommandPollsByAppId.get(appId) ?? [];
    waiters.push((command) => {
      clearTimeout(timer);
      resolve(command);
    });
    waitingCommandPollsByAppId.set(appId, waiters);
  });
};

const awaitBridgeControlResult = async (
  command: BridgeControlCommand,
  timeoutMs: number,
) => {
  return await new Promise<BridgeControlResultBody>((resolve) => {
    const timer = setTimeout(() => {
      pendingResultsByCommandId.delete(command.id);
      resolve({
        commandId: command.id,
        ok: false,
        error: {
          message: `Timed out waiting for bridge command ${command.id}.`,
          name: "TimeoutError",
        },
      });
    }, timeoutMs);

    pendingResultsByCommandId.set(command.id, {
      resolve,
      timer,
    });
  });
};

const resolveBridgeControlResult = (payload: BridgeControlResultBody) => {
  if (!payload.commandId) {
    return false;
  }

  const pending = pendingResultsByCommandId.get(payload.commandId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timer);
  pendingResultsByCommandId.delete(payload.commandId);
  pending.resolve(payload);
  return true;
};

const readCollectorState = async (): Promise<CollectorState | null> => {
  const stateFile = Bun.file(collectorStatePath());
  if (!(await stateFile.exists())) {
    return null;
  }

  try {
    return (await stateFile.json()) as CollectorState;
  } catch {
    return null;
  }
};

const readCollectorHealth = async (): Promise<CollectorHealthPayload | null> => {
  try {
    const response = await fetch(
      `http://127.0.0.1:${IOS_BRIDGE_COLLECTOR_PORT}${IOS_BRIDGE_COLLECTOR_HEALTH_PATH}`,
    );
    if (!response.ok) {
      return null;
    }

    return (await response.json()) as CollectorHealthPayload;
  } catch {
    return null;
  }
};

const isCollectorHealthy = async () => {
  const health = await readCollectorHealth();
  return (
    health?.ok === true &&
    health.protocolVersion === IOS_BRIDGE_COLLECTOR_PROTOCOL_VERSION
  );
};

const stopCollectorProcess = async (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isPidRunning(pid)) {
      return;
    }

    await Bun.sleep(100);
  }
};

export const ensureIOSBridgeCollector = async () => {
  await mkdir(getHarnessRootPath(), { recursive: true });

  if (await isCollectorHealthy()) {
    return;
  }

  const existingState = await readCollectorState();
  if (existingState) {
    if (isPidRunning(existingState.pid)) {
      await stopCollectorProcess(existingState.pid);
    }

    await rm(collectorStatePath(), { force: true });
  }

  const collector = spawn(
    process.execPath,
    [getCliEntryPath(), "__ios-bridge-collector"],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    },
  );
  collector.unref();

  if (!collector.pid) {
    throw new HarnessError(
      "command_failed",
      "Could not start the iOS Capacitor bridge collector.",
    );
  }

  await writeFile(
    collectorStatePath(),
    JSON.stringify(
      {
        pid: collector.pid,
        port: IOS_BRIDGE_COLLECTOR_PORT,
        startedAt: new Date().toISOString(),
      } satisfies CollectorState,
      null,
      2,
    ),
    "utf8",
  );

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isCollectorHealthy()) {
      return;
    }

    await Bun.sleep(250);
  }

  throw new HarnessError(
    "command_failed",
    "Started the iOS Capacitor bridge collector, but it did not become healthy.",
  );
};

export const runIOSBridgeCollector = async () => {
  const server = Bun.serve({
    port: IOS_BRIDGE_COLLECTOR_PORT,
    hostname: "0.0.0.0",
    fetch: async (request) => {
      const url = new URL(request.url);

      if (
        request.method === "GET" &&
        url.pathname === IOS_BRIDGE_COLLECTOR_HEALTH_PATH
      ) {
        return Response.json({
          ok: true,
          protocolVersion: IOS_BRIDGE_COLLECTOR_PROTOCOL_VERSION,
        } satisfies CollectorHealthPayload);
      }

      if (
        request.method === "GET" &&
        url.pathname === IOS_BRIDGE_CONTROL_NEXT_PATH
      ) {
        const appId = url.searchParams.get("appId") ?? "";
        const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? "25000");
        if (!appId) {
          return new Response("missing appId", { status: 400 });
        }

        const command = await awaitNextBridgeCommand(
          appId,
          Number.isFinite(timeoutMs) ? timeoutMs : 25_000,
        );
        if (!command) {
          return new Response(null, { status: 204 });
        }

        return Response.json(command);
      }

      if (
        request.method === "POST" &&
        url.pathname === IOS_BRIDGE_CONTROL_REQUEST_PATH
      ) {
        let payload: BridgeControlRequestBody;
        try {
          payload = (await request.json()) as BridgeControlRequestBody;
        } catch {
          return new Response("invalid json", { status: 400 });
        }

        if (
          !payload.appId ||
          payload.command?.kind !== "eval" ||
          !payload.command.expression
        ) {
          return new Response("invalid control request", { status: 400 });
        }

        const command: BridgeControlCommand = {
          id: crypto.randomUUID(),
          kind: "eval",
          expression: payload.command.expression,
        };

        enqueueBridgeCommand(payload.appId, command);
        const result = await awaitBridgeControlResult(
          command,
          payload.timeoutMs ?? 8_000,
        );

        if (!result.ok) {
          if (result.error?.name === "TimeoutError") {
            return Response.json(result, { status: 504 });
          }
        }

        return Response.json(result);
      }

      if (
        request.method === "POST" &&
        url.pathname === IOS_BRIDGE_CONTROL_RESULT_PATH
      ) {
        let payload: BridgeControlResultBody;
        try {
          payload = (await request.json()) as BridgeControlResultBody;
        } catch {
          return new Response("invalid json", { status: 400 });
        }

        resolveBridgeControlResult(payload);
        return new Response(null, { status: 204 });
      }

      if (
        request.method !== "POST" ||
        url.pathname !== IOS_BRIDGE_COLLECTOR_PATH
      ) {
        return new Response("not found", { status: 404 });
      }

      let payload: BridgeEnvelope;
      try {
        payload = (await request.json()) as BridgeEnvelope;
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      await handleEnvelope(payload);
      return new Response(null, { status: 204 });
    },
  });

  const shutdown = async () => {
    server.stop(true);
    await rm(collectorStatePath(), { force: true });
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise(() => {});
};
