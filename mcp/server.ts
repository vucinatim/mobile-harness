import { z } from "zod";
import { HarnessError } from "../core/errors.ts";
import {
  captureSessionWebviewScreenshot,
  clearSessionUi,
  clickSessionUi,
  evalSessionJs,
  inspectSessionUi,
  listSessionWebviews,
  pressSessionUi,
  readSessionConsole,
  readSessionLogs,
  readSessionNetwork,
  readSessionUi,
  snapshotSessionUi,
  typeIntoSessionUi,
  waitForSessionUi,
} from "../core/operations.ts";
import {
  captureSessionScreenshot,
  createSession,
  getSessionCapabilities,
  listDevices,
} from "../core/registry.ts";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type ToolDefinition<Name extends string, Schema extends z.ZodType> = {
  name: Name;
  description: string;
  inputSchema: Schema;
  execute: (
    input: z.output<Schema>,
  ) => Promise<{ text: string; structuredContent: Record<string, unknown> }>;
};

const defineTool = <const Name extends string, Schema extends z.ZodType>(
  tool: ToolDefinition<Name, Schema>,
) => tool;

type AnyToolDefinition = ToolDefinition<string, z.ZodTypeAny>;

const SERVER_NAME = "classology-mobile-harness";
const SERVER_VERSION = "0.1.0";
const JSON_RPC_VERSION = "2.0";
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const boundedReadSchema = z.object({
  maxEvents: z.number().int().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(100).max(10_000).optional(),
});

const uiRoleSchema = z.enum([
  "button",
  "link",
  "tab",
  "back",
  "input",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "text",
  "dialog",
  "unknown",
]);

const uiSnapshotDetailSchema = z.enum(["summary", "standard", "full"]);

const uiSelectorSchema = z
  .object({
    elementId: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    role: uiRoleSchema.optional(),
    name: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      !!(
        value.elementId ||
        value.selector ||
        value.text ||
        value.name ||
        value.placeholder
      ),
    {
      message:
        "At least one selector field is required: elementId, selector, text, name, or placeholder.",
    },
  );

const tools = [
  defineTool({
    name: "mobile_list_devices",
    description:
      "List connected mobile devices supported by the harness across Android and iOS backends.",
    inputSchema: z.object({
      platform: z.enum(["android", "ios", "all"]).optional(),
    }),
    async execute(input) {
      const platform = input.platform ?? "all";
      const devices = await listDevices(platform);

      return {
        text:
          devices.length === 0
            ? "No mobile devices found."
            : `Found ${devices.length} device${devices.length === 1 ? "" : "s"}.`,
        structuredContent: {
          platform,
          devices,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_attach_session",
    description:
      "Create a mobile debugging session for a specific installed app on a connected device.",
    inputSchema: z.object({
      platform: z.enum(["android", "ios"]),
      deviceId: z.string().min(1),
      appId: z.string().min(1),
      launchApp: z.boolean().optional(),
    }),
    async execute(input) {
      const session = await createSession(input.platform, {
        deviceId: input.deviceId,
        appId: input.appId,
        launchApp: input.launchApp,
      });

      return {
        text: `Attached session ${session.id} for ${session.appId} on ${session.deviceId}.`,
        structuredContent: {
          session,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_get_capabilities",
    description:
      "Return the supported debugging capabilities for an existing mobile session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
    }),
    async execute(input) {
      const capabilities = await getSessionCapabilities(input.sessionId);

      return {
        text: `Loaded capabilities for session ${input.sessionId}.`,
        structuredContent: {
          sessionId: input.sessionId,
          capabilities,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_capture_device_screenshot",
    description:
      "Capture a full device screenshot for an attached mobile session.",
    inputSchema: z.object({
      sessionId: z.string().min(1),
      outputPath: z.string().min(1).optional(),
    }),
    async execute(input) {
      const artifact = await captureSessionScreenshot(input.sessionId, {
        outputPath: input.outputPath,
      });

      return {
        text: `Saved device screenshot to ${artifact.path}.`,
        structuredContent: {
          artifact,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_list_webviews",
    description:
      "List debuggable WebView targets for an attached mobile app session.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
    }),
    async execute(input) {
      const targets = await listSessionWebviews(input.sessionId);

      return {
        text:
          targets.length === 0
            ? `No WebView targets found for session ${input.sessionId}.`
            : `Found ${targets.length} WebView target${targets.length === 1 ? "" : "s"}.`,
        structuredContent: {
          sessionId: input.sessionId,
          targets,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_eval_js",
    description:
      "Evaluate a JavaScript expression inside a debuggable WebView target.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      expression: z.string().min(1),
    }),
    async execute(input) {
      const result = await evalSessionJs(
        input.sessionId,
        input.targetId,
        input.expression,
      );

      return {
        text: `Evaluated JavaScript in target ${input.targetId}.`,
        structuredContent: {
          sessionId: input.sessionId,
          targetId: input.targetId,
          result,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_capture_webview_screenshot",
    description:
      "Capture a screenshot of a specific debuggable WebView target.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      outputPath: z.string().min(1).optional(),
    }),
    async execute(input) {
      const artifact = await captureSessionWebviewScreenshot(
        input.sessionId,
        input.targetId,
        {
          outputPath: input.outputPath,
        },
      );

      return {
        text: `Saved WebView screenshot to ${artifact.path}.`,
        structuredContent: {
          artifact,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_read_logs",
    description:
      "Read a bounded batch of native app log events from an attached mobile session.",
    inputSchema: z
      .object({
        sessionId: z.string().min(1),
        filter: z.string().min(1).optional(),
      })
      .extend(boundedReadSchema.shape),
    async execute(input) {
      const events = await readSessionLogs(input.sessionId, input);

      return {
        text: `Read ${events.length} log event${events.length === 1 ? "" : "s"} from session ${input.sessionId}.`,
        structuredContent: {
          sessionId: input.sessionId,
          events,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_read_console",
    description:
      "Read a bounded batch of WebView console events from a target in an attached mobile session.",
    inputSchema: z
      .object({
        sessionId: z.string().min(1).optional(),
        targetId: z.string().min(1).optional(),
      })
      .extend(boundedReadSchema.shape),
    async execute(input) {
      const events = await readSessionConsole(
        input.sessionId,
        input.targetId,
        input,
      );

      return {
        text: `Read ${events.length} console event${events.length === 1 ? "" : "s"} from target ${input.targetId}.`,
        structuredContent: {
          sessionId: input.sessionId,
          targetId: input.targetId,
          events,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_read_network",
    description:
      "Read a bounded batch of WebView network events from a target in an attached mobile session.",
    inputSchema: z
      .object({
        sessionId: z.string().min(1).optional(),
        targetId: z.string().min(1).optional(),
      })
      .extend(boundedReadSchema.shape),
    async execute(input) {
      const events = await readSessionNetwork(
        input.sessionId,
        input.targetId,
        input,
      );

      return {
        text: `Read ${events.length} network event${events.length === 1 ? "" : "s"} from target ${input.targetId}.`,
        structuredContent: {
          sessionId: input.sessionId,
          targetId: input.targetId,
          events,
        },
      };
    },
  }),
  defineTool({
    name: "mobile_ui_snapshot",
    description:
      "Return a compact, agent-usable snapshot of the current mobile WebView UI.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      detail: uiSnapshotDetailSchema.optional(),
    }),
    async execute(input) {
      const result = await snapshotSessionUi(input.sessionId, input.targetId, {
        detail: input.detail,
      });

      return {
        text: `Captured a UI snapshot from target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_inspect",
    description:
      "Inspect a single visible UI element in the current mobile WebView and return targeted details without expanding the full screen snapshot.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      selector: uiSelectorSchema,
    }),
    async execute(input) {
      const result = await inspectSessionUi(
        input.selector,
        input.sessionId,
        input.targetId,
      );

      return {
        text: `Inspected a UI element in target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_click",
    description:
      "Click a visible UI element in the current mobile WebView using a stable element id or selector hints.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      selector: uiSelectorSchema,
    }),
    async execute(input) {
      const result = await clickSessionUi(
        input.selector,
        input.sessionId,
        input.targetId,
      );

      return {
        text: `Clicked a UI element in target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_type",
    description:
      "Type into a visible UI field in the current mobile WebView using a stable element id or selector hints.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      selector: uiSelectorSchema,
      text: z.string(),
      append: z.boolean().optional(),
      submit: z.boolean().optional(),
    }),
    async execute(input) {
      const result = await typeIntoSessionUi(
        input.selector,
        input.text,
        input.sessionId,
        input.targetId,
        {
          append: input.append,
          submit: input.submit,
        },
      );

      return {
        text: `Typed into a UI field in target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_clear",
    description:
      "Clear a visible UI field in the current mobile WebView using a stable element id or selector hints.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      selector: uiSelectorSchema,
    }),
    async execute(input) {
      const result = await clearSessionUi(
        input.selector,
        input.sessionId,
        input.targetId,
      );

      return {
        text: `Cleared a UI field in target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_press",
    description:
      "Press a keyboard key on a visible UI element in the current mobile WebView.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      selector: uiSelectorSchema,
      key: z.string().min(1),
      code: z.string().min(1).optional(),
    }),
    async execute(input) {
      const result = await pressSessionUi(
        input.selector,
        {
          key: input.key,
          code: input.code,
        },
        input.sessionId,
        input.targetId,
      );

      return {
        text: `Pressed ${input.key} on a UI element in target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_read",
    description:
      "Read the current state of a visible UI element in the current mobile WebView.",
    inputSchema: z.object({
      sessionId: z.string().min(1).optional(),
      targetId: z.string().min(1).optional(),
      selector: uiSelectorSchema,
    }),
    async execute(input) {
      const result = await readSessionUi(
        input.selector,
        input.sessionId,
        input.targetId,
      );

      return {
        text: `Read a UI element from target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
  defineTool({
    name: "mobile_ui_wait_for",
    description:
      "Wait for a UI condition such as text, URL, or an element state in the current mobile WebView.",
    inputSchema: z
      .object({
        sessionId: z.string().min(1).optional(),
        targetId: z.string().min(1).optional(),
        element: uiSelectorSchema.optional(),
        text: z.string().min(1).optional(),
        urlIncludes: z.string().min(1).optional(),
        state: z.enum(["visible", "hidden", "enabled", "disabled"]).optional(),
        timeoutMs: z.number().int().min(100).max(30_000).optional(),
        intervalMs: z.number().int().min(25).max(1_000).optional(),
      })
      .refine((value) => !!(value.element || value.text || value.urlIncludes), {
        message: "element, text, or urlIncludes is required.",
      }),
    async execute(input) {
      const result = await waitForSessionUi(
        {
          element: input.element,
          text: input.text,
          urlIncludes: input.urlIncludes,
          state: input.state,
          timeoutMs: input.timeoutMs,
          intervalMs: input.intervalMs,
        },
        input.sessionId,
        input.targetId,
      );

      return {
        text: result.result.satisfied
          ? `UI condition satisfied in target ${result.targetId}.`
          : `UI condition timed out in target ${result.targetId}.`,
        structuredContent: result,
      };
    },
  }),
] as const;

const toolMap = new Map<string, AnyToolDefinition>(
  tools.map((tool) => [tool.name, tool as AnyToolDefinition]),
);

const formatToolSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {
    target: "draft-7",
  });

const createToolResult = (
  text: string,
  structuredContent: Record<string, unknown>,
) => ({
  content: [
    {
      type: "text",
      text,
    },
  ],
  structuredContent,
  isError: false,
});

const toErrorData = (error: unknown) => {
  if (error instanceof HarnessError) {
    return {
      code: error.code,
      details: error.details,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      code: "invalid_input",
      issues: error.issues,
    };
  }

  return undefined;
};

const toToolErrorResult = (error: unknown) => {
  const message =
    error instanceof HarnessError || error instanceof Error
      ? error.message
      : "Unknown tool error.";

  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent: {
      error: {
        message,
        ...toErrorData(error),
      },
    },
    isError: true,
  };
};

const parseProtocolVersion = (value: unknown) => {
  if (
    typeof value === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(
      value as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
  ) {
    return value;
  }

  return DEFAULT_PROTOCOL_VERSION;
};

const createResponse = (id: JsonRpcId, result: unknown) => ({
  jsonrpc: JSON_RPC_VERSION,
  id,
  result,
});

const createErrorResponse = (
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) => ({
  jsonrpc: JSON_RPC_VERSION,
  id,
  error: {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  },
});

const writeMessage = async (message: unknown) => {
  const payload = JSON.stringify(message);
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.from(
    `Content-Length: ${body.byteLength}\r\nContent-Type: application/json\r\n\r\n`,
    "utf8",
  );

  process.stdout.write(Buffer.concat([header, body]));
};

const handleInitialize = async (id: JsonRpcId, params: unknown) => {
  const initializeParams =
    params && typeof params === "object"
      ? (params as { protocolVersion?: unknown })
      : undefined;
  const protocolVersion = parseProtocolVersion(
    typeof initializeParams?.protocolVersion === "string"
      ? initializeParams.protocolVersion
      : undefined,
  );

  await writeMessage(
    createResponse(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        "Android-first mobile debugging harness for Classology. Use device/session tools first, then WebView tools once a session is attached.",
    }),
  );
};

const handleToolsList = async (id: JsonRpcId) => {
  await writeMessage(
    createResponse(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: formatToolSchema(tool.inputSchema),
      })),
    }),
  );
};

const handleToolsCall = async (id: JsonRpcId, params: unknown) => {
  const parsedParams = z
    .object({
      name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(params);

  const tool = toolMap.get(parsedParams.name);
  if (!tool) {
    await writeMessage(
      createErrorResponse(id, -32602, `Unknown tool "${parsedParams.name}".`, {
        name: parsedParams.name,
      }),
    );
    return;
  }

  try {
    const input = tool.inputSchema.parse(parsedParams.arguments ?? {});
    const result = await tool.execute(input);
    await writeMessage(
      createResponse(
        id,
        createToolResult(result.text, result.structuredContent),
      ),
    );
  } catch (error) {
    await writeMessage(createResponse(id, toToolErrorResult(error)));
  }
};

const handleRequest = async (message: JsonRpcRequest) => {
  const id = message.id ?? null;

  try {
    switch (message.method) {
      case "initialize":
        await handleInitialize(id, message.params);
        return;
      case "ping":
        await writeMessage(createResponse(id, {}));
        return;
      case "tools/list":
        await handleToolsList(id);
        return;
      case "tools/call":
        await handleToolsCall(id, message.params);
        return;
      case "notifications/initialized":
        return;
      default:
        if (message.id === undefined) {
          return;
        }

        await writeMessage(
          createErrorResponse(
            id,
            -32601,
            `Method "${message.method}" not found.`,
          ),
        );
    }
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Unhandled MCP server error.";

    await writeMessage(
      createErrorResponse(id, -32603, messageText, toErrorData(error)),
    );
  }
};

const processFrameBuffer = async (buffer: Buffer) => {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return { remaining: buffer };
  }

  const headerText = buffer.subarray(0, headerEnd).toString("utf8");
  const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
  if (!contentLengthMatch) {
    throw new Error("Missing Content-Length header in MCP message.");
  }

  const contentLength = Number.parseInt(contentLengthMatch[1] ?? "", 10);
  const bodyStart = headerEnd + 4;
  const frameLength = bodyStart + contentLength;

  if (buffer.length < frameLength) {
    return { remaining: buffer };
  }

  const body = buffer.subarray(bodyStart, frameLength).toString("utf8");
  const payload = JSON.parse(body) as JsonRpcRequest;
  await handleRequest(payload);

  return { remaining: buffer.subarray(frameLength) };
};

const main = async () => {
  let buffer = Buffer.alloc(0) as Buffer;
  const reader = Bun.stdin.stream().getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer = Buffer.concat([buffer, Buffer.from(value)]) as Buffer;

      while (true) {
        const previousLength = buffer.length;
        const next = await processFrameBuffer(buffer);
        buffer = next.remaining as Buffer;

        if (buffer.length === previousLength) {
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
};

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "Unhandled MCP server error.";
  console.error(message);
  process.exitCode = 1;
}
