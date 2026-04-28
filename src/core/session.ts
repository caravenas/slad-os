import fs from "node:fs";
import path from "node:path";
import { SessionState, type SessionArtifactKind, type SessionAnswer } from "./types.js";

const SESSIONS_DIR = "sessions";
const ACTIVE_FILE = ".slad-session";

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
  return path.join(cwd, SESSIONS_DIR);
}

function statePath(id: string, cwd: string): string {
  return path.join(sessionsRoot(cwd), id, "state.json");
}

function activeFilePath(cwd: string): string {
  return path.join(cwd, ACTIVE_FILE);
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
  fs.writeFileSync(p, JSON.stringify(session, null, 2) + "\n", "utf8");
}

export function setActiveSession(id: string, cwd = process.cwd()): void {
  fs.writeFileSync(activeFilePath(cwd), id + "\n", "utf8");
}

export function getActiveSessionId(cwd = process.cwd()): string | null {
  const p = activeFilePath(cwd);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").trim() || null;
}

export function loadSession(id: string, cwd = process.cwd()): SessionState | null {
  const p = statePath(id, cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return SessionState.parse(raw);
  } catch {
    return null;
  }
}

export function getActiveSession(cwd = process.cwd()): SessionState | null {
  const id = getActiveSessionId(cwd);
  if (!id) return null;
  return loadSession(id, cwd);
}

export function listSessions(cwd = process.cwd()): SessionState[] {
  const root = sessionsRoot(cwd);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => fs.statSync(path.join(root, entry)).isDirectory())
    .map((entry) => loadSession(entry, cwd))
    .filter((s): s is SessionState => s !== null)
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
