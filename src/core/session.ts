import fs from "node:fs";
import path from "node:path";
import { SessionError } from "./errors.js";
import { SessionState, type SessionArtifactKind, type SessionAnswer } from "./types.js";
import { artifactDirSync } from "../persistence/layout.js";

const ACTIVE_FILE = ".active-session";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

function generateId(intent: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  return `${date}-${time}-${slugify(intent)}`;
}

function sessionsRoot(cwd: string): string {
  return artifactDirSync("session", cwd);
}

function statePath(id: string, cwd: string): string {
  return path.join(sessionsRoot(cwd), `${id}.json`);
}

function legacyStatePath(id: string, cwd: string): string {
  return path.join(cwd, "sessions", id, "state.json");
}

function activeFilePath(cwd: string): string {
  return path.join(sessionsRoot(cwd), ACTIVE_FILE);
}

function legacyActiveFilePath(cwd: string): string {
  return path.join(cwd, ".slad-session");
}

function loadSessionStrict(id: string, cwd = process.cwd()): SessionState {
  const p = statePath(id, cwd);
  const legacy = legacyStatePath(id, cwd);
  const sourcePath = fs.existsSync(p) ? p : legacy;
  if (!fs.existsSync(sourcePath)) {
    throw new SessionError(`Sesión '${id}' sin archivo de estado.`, { sessionId: id, path: p });
  }

  try {
    const text = fs.readFileSync(sourcePath, "utf8");
    const envelope = JSON.parse(text) as Record<string, unknown>;
    const raw = envelope.value ?? envelope;
    return SessionState.parse(raw);
  } catch (err) {
    throw new SessionError(`Sesión '${id}' tiene estado inválido.`, {
      sessionId: id,
      path: sourcePath,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createSession(intent: string, cwd = process.cwd()): SessionState {
  const id = generateId(intent);
  const session: SessionState = {
    id,
    createdAt: new Date().toISOString(),
    intent,
    artifacts: [],
    humanAnswers: [],
    notes: [],
  };
  saveSession(session, cwd);
  setActiveSession(id, cwd);
  return session;
}

export function saveSession(session: SessionState, cwd = process.cwd()): void {
  const p = statePath(session.id, cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const envelope = {
    kind: "session",
    schemaVersion: 1,
    sessionId: session.id,
    createdAt: session.createdAt,
    value: session,
  };
  fs.writeFileSync(p, JSON.stringify(envelope, null, 2), "utf8");
}

export function setActiveSession(id: string, cwd = process.cwd()): void {
  fs.mkdirSync(path.dirname(activeFilePath(cwd)), { recursive: true });
  fs.writeFileSync(activeFilePath(cwd), id + "\n", "utf8");
}

export function getActiveSessionId(cwd = process.cwd()): string | null {
  const p = activeFilePath(cwd);
  if (!fs.existsSync(p)) {
    const legacy = legacyActiveFilePath(cwd);
    if (!fs.existsSync(legacy)) return null;
    return fs.readFileSync(legacy, "utf8").trim() || null;
  }
  return fs.readFileSync(p, "utf8").trim() || null;
}

export function loadSession(id: string, cwd = process.cwd()): SessionState | null {
  const p = statePath(id, cwd);
  const legacy = legacyStatePath(id, cwd);
  if (!fs.existsSync(p) && !fs.existsSync(legacy)) return null;
  try {
    return loadSessionStrict(id, cwd);
  } catch {
    return null;
  }
}

export function getActiveSession(cwd = process.cwd()): SessionState | null {
  const id = getActiveSessionId(cwd);
  if (!id) return null;
  return loadSession(id, cwd);
}

export function hasPersistedActiveSession(cwd = process.cwd()): boolean {
  return getActiveSession(cwd) !== null;
}

export function listSessions(cwd = process.cwd()): SessionState[] {
  const root = sessionsRoot(cwd);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => entry.endsWith(".json") && !entry.includes("_cli-discovery"))
    .map((entry) => loadSessionStrict(path.basename(entry, ".json"), cwd))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function appendArtifact(
  session: SessionState,
  kind: SessionArtifactKind,
  filePath: string,
  taskId?: string,
): SessionState {
  return {
    ...session,
    currentPhase: kind,
    artifacts: [
      ...session.artifacts,
      {
        kind,
        path: filePath,
        createdAt: new Date().toISOString(),
        ...(taskId ? { taskId } : {}),
      },
    ],
  };
}

export function upsertArtifact(
  session: SessionState,
  kind: SessionArtifactKind,
  filePath: string,
  taskId?: string,
): SessionState {
  const replacement = {
    kind,
    path: filePath,
    createdAt: new Date().toISOString(),
    ...(taskId ? { taskId } : {}),
  };
  const firstExistingIndex = session.artifacts.findIndex((artifact) => artifact.kind === kind);
  const filtered = session.artifacts.filter((artifact) => artifact.kind !== kind);
  const insertAt = firstExistingIndex === -1
    ? filtered.length
    : session.artifacts
      .slice(0, firstExistingIndex)
      .filter((artifact) => artifact.kind !== kind).length;

  return {
    ...session,
    currentPhase: kind,
    artifacts: [
      ...filtered.slice(0, insertAt),
      replacement,
      ...filtered.slice(insertAt),
    ],
  };
}

export function appendAnswers(
  session: SessionState,
  taskId: string,
  answers: Record<string, string>,
): SessionState {
  const newAnswers: SessionAnswer[] = Object.entries(answers).map(([questionId, answer]) => ({
    taskId,
    questionId,
    answer,
    askedAt: new Date().toISOString(),
  }));
  return { ...session, humanAnswers: [...session.humanAnswers, ...newAnswers] };
}

export function upsertAnswers(
  session: SessionState,
  taskId: string,
  answers: Record<string, string>,
): SessionState {
  const existing = session.humanAnswers.filter((a) => {
    if (a.taskId !== taskId) return true;
    return !(a.questionId in answers);
  });
  const newAnswers: SessionAnswer[] = Object.entries(answers).map(([questionId, answer]) => ({
    taskId,
    questionId,
    answer,
    askedAt: new Date().toISOString(),
  }));
  return { ...session, humanAnswers: [...existing, ...newAnswers] };
}

export function lastArtifactPath(
  session: SessionState,
  kind: SessionArtifactKind,
): string | undefined {
  return [...session.artifacts].reverse().find((a) => a.kind === kind)?.path;
}

export function sessionContextBlock(session: SessionState): string {
  if (session.humanAnswers.length === 0) return "";
  const lines = session.humanAnswers.map((a) => `- [${a.taskId}/${a.questionId}] ${a.answer}`);
  return `Decisiones humanas previas en esta sesión:\n${lines.join("\n")}`;
}
