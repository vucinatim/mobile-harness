import { appendFile, readFile, truncate } from "node:fs/promises";
import { getTimelineFilePath } from "./storage.ts";
import type { RecordingEvent, RecordingState } from "./timeline-types.ts";

const STATE_FILE = "state.json";
const EVENTS_FILE = "events.jsonl";

export const getRecordingStatePath = async (sessionId: string) =>
  await getTimelineFilePath(sessionId, STATE_FILE);

export const getRecordingEventsPath = async (sessionId: string) =>
  await getTimelineFilePath(sessionId, EVENTS_FILE);

export const saveRecordingState = async (state: RecordingState) => {
  const filePath = await getRecordingStatePath(state.sessionId);
  await Bun.write(filePath, JSON.stringify(state, null, 2));
};

export const loadRecordingState = async (
  sessionId: string,
): Promise<RecordingState | null> => {
  const filePath = await getRecordingStatePath(sessionId);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return null;
  }

  return (await file.json()) as RecordingState;
};

export const clearRecordingEvents = async (sessionId: string) => {
  const filePath = await getRecordingEventsPath(sessionId);
  const file = Bun.file(filePath);

  if (await file.exists()) {
    await truncate(filePath, 0);
    return;
  }

  await Bun.write(filePath, "");
};

export const appendRecordingEvent = async (event: RecordingEvent) => {
  const filePath = await getRecordingEventsPath(event.sessionId);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
};

export const readRecordingEvents = async (
  sessionId: string,
): Promise<RecordingEvent[]> => {
  const filePath = await getRecordingEventsPath(sessionId);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return [];
  }

  const contents = await readFile(filePath, "utf8");
  const events: RecordingEvent[] = [];

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed) as RecordingEvent);
    } catch {
      // Workers append newline-delimited JSON in the background. If a read races
      // with an in-flight append, the final line may be incomplete. Skip it.
      continue;
    }
  }

  return events;
};
