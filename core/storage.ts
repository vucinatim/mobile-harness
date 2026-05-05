import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "./errors.ts";
import type { AppSession, Platform } from "./types.ts";

type SessionRecord = AppSession & {
  platform: Platform;
};

const harnessRoot = path.join(process.cwd(), ".mobile-harness");
const sessionsDir = path.join(harnessRoot, "sessions");
const artifactsDir = path.join(harnessRoot, "artifacts");
const timelineDir = path.join(harnessRoot, "timeline");

const ensureDir = async (dirPath: string) => {
  await mkdir(dirPath, { recursive: true });
};

const sessionFilePath = (sessionId: string) =>
  path.join(sessionsDir, `${sessionId}.json`);

export const ensureHarnessStorage = async () => {
  await ensureDir(sessionsDir);
  await ensureDir(artifactsDir);
  await ensureDir(timelineDir);
};

export const saveSession = async (session: SessionRecord) => {
  await ensureHarnessStorage();
  await Bun.write(sessionFilePath(session.id), JSON.stringify(session, null, 2));
};

export const loadSession = async (sessionId: string): Promise<SessionRecord> => {
  const file = Bun.file(sessionFilePath(sessionId));
  if (!(await file.exists())) {
    throw new HarnessError(
      "invalid_input",
      `Session "${sessionId}" was not found.`,
      { sessionId },
    );
  }

  return (await file.json()) as SessionRecord;
};

export const listSessions = async (): Promise<SessionRecord[]> => {
  await ensureHarnessStorage();
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const file = Bun.file(path.join(sessionsDir, entry.name));
        return (await file.json()) as SessionRecord;
      }),
  );

  return sessions.sort(
    (left, right) =>
      new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
  );
};

export const getArtifactPath = async (
  sessionId: string,
  filename: string,
): Promise<string> => {
  await ensureHarnessStorage();
  const dir = path.join(artifactsDir, sessionId);
  await ensureDir(dir);
  return path.join(dir, filename);
};

export const getTimelineDir = async (sessionId: string): Promise<string> => {
  await ensureHarnessStorage();
  const dir = path.join(timelineDir, sessionId);
  await ensureDir(dir);
  return dir;
};

export const getTimelineFilePath = async (
  sessionId: string,
  filename: string,
): Promise<string> => {
  const dir = await getTimelineDir(sessionId);
  return path.join(dir, filename);
};
