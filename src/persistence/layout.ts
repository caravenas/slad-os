import path from "node:path";
import { loadProjectConfig, resolveDocsRoot } from "../core/project-config.js";

let _docsRoot: string | null = null;

export async function getDocsRoot(): Promise<string> {
  if (_docsRoot) return _docsRoot;
  const cfg = await loadProjectConfig();
  _docsRoot = resolveDocsRoot(cfg);
  return _docsRoot;
}

/** Only for tests — clears the cached docsRoot so env vars / configs are re-read. */
export function resetDocsRootCache(): void {
  _docsRoot = null;
}

export async function pathForRun(sessionId: string, taskId: string): Promise<string> {
  const root = await getDocsRoot();
  return path.join(root, "log", "runs", `${sessionId}_${taskId}.md`);
}

export async function timestampedPathForRun(
  sessionId: string,
  taskId: string,
  isoTimestamp: string,
): Promise<string> {
  const root = await getDocsRoot();
  const safe = isoTimestamp.replace(/:/g, "-");
  return path.join(root, "log", "runs", `${sessionId}_${taskId}__${safe}.md`);
}

export async function listRunsDir(): Promise<string> {
  const root = await getDocsRoot();
  return path.join(root, "log", "runs");
}
