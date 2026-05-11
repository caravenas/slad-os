import path from "node:path";
import { loadProjectConfig, loadProjectConfigSync, resolveDocsRoot } from "../core/project-config.js";
import type { ArtifactKind } from "./index.js";

let _docsRoot: string | null = null;

export async function getDocsRoot(): Promise<string> {
  if (_docsRoot) return _docsRoot;
  const cfg = await loadProjectConfig();
  _docsRoot = resolveDocsRoot(cfg);
  return _docsRoot;
}

export function getDocsRootSync(projectRoot: string = process.cwd()): string {
  const cfg = loadProjectConfigSync(projectRoot);
  return resolveDocsRoot(cfg, projectRoot);
}

/** Only for tests — clears the cached docsRoot so env vars / configs are re-read. */
export function resetDocsRootCache(): void {
  _docsRoot = null;
}

export function artifactDirName(kind: ArtifactKind): string {
  switch (kind) {
    case "explore":
      return "explores";
    case "snapshot":
      return "snapshots";
    case "plan":
      return "plans";
    case "run":
      return "runs";
    case "learn":
      return "learnings";
    case "evolve":
      return "evolution";
    case "session":
      return "sessions";
  }
}

export async function artifactDir(kind: ArtifactKind): Promise<string> {
  const root = await getDocsRoot();
  return path.join(root, "log", artifactDirName(kind));
}

export function artifactDirSync(kind: ArtifactKind, projectRoot: string = process.cwd()): string {
  return path.join(getDocsRootSync(projectRoot), "log", artifactDirName(kind));
}

export async function pathForArtifact(
  kind: ArtifactKind,
  sessionId: string,
  key?: string,
): Promise<string> {
  const dir = await artifactDir(kind);
  const suffix = key ? `_${key}` : "";
  return path.join(dir, `${sessionId}${suffix}.md`);
}

export async function timestampedPathForArtifact(
  kind: ArtifactKind,
  sessionId: string,
  isoTimestamp: string,
  key?: string,
): Promise<string> {
  const dir = await artifactDir(kind);
  const safe = isoTimestamp.replace(/[:.]/g, "-");
  const suffix = key ? `_${key}` : "";
  return path.join(dir, `${sessionId}${suffix}__${safe}.md`);
}

export async function pathForRun(sessionId: string, taskId: string): Promise<string> {
  return pathForArtifact("run", sessionId, taskId);
}

export async function timestampedPathForRun(
  sessionId: string,
  taskId: string,
  isoTimestamp: string,
): Promise<string> {
  return timestampedPathForArtifact("run", sessionId, isoTimestamp, taskId);
}

export async function listRunsDir(): Promise<string> {
  return artifactDir("run");
}
