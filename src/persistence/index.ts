import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { RunOutput } from "../core/types.js";
import { ParseError } from "../core/errors.js";
import { renderRun } from "./render/run.js";
import { parseRun } from "./parse/run.js";
import {
  pathForRun,
  timestampedPathForRun,
  listRunsDir,
} from "./layout.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ArtifactKind =
  | "explore"
  | "snapshot"
  | "plan"
  | "run"
  | "learn"
  | "evolve"
  | "session";

export type ArtifactByKind = {
  run: RunOutput;
  // Others added in future milestones — map to unknown for now to keep TS happy
  explore: unknown;
  snapshot: unknown;
  plan: unknown;
  learn: unknown;
  evolve: unknown;
  session: unknown;
};

export interface WriteContext {
  sessionId: string;
  /** ISO string; default: new Date().toISOString() */
  createdAt?: string;
}

export interface ArtifactRef<K extends ArtifactKind = ArtifactKind> {
  kind: K;
  path: string;
  sessionId: string;
  taskId?: string;
  createdAt: string;
}

export interface ParseResult<T> {
  value: T;
  warnings: string[];
}

// ─── writeArtifact ────────────────────────────────────────────────────────────

/**
 * Renders value to Markdown+YAML, writes to disk, returns an ArtifactRef.
 * For "run": path is <docsRoot>/log/runs/{sessionId}_{taskId}.md
 * If that path already exists, uses a timestamped variant to preserve history.
 */
export async function writeArtifact<K extends ArtifactKind>(
  kind: K,
  value: ArtifactByKind[K],
  ctx: WriteContext,
): Promise<ArtifactRef<K>> {
  if (kind !== "run") {
    throw new Error(`writeArtifact: kind "${kind}" not implemented in milestone 1`);
  }

  const runOutput = value as RunOutput;
  const createdAt = ctx.createdAt ?? new Date().toISOString();
  const writeCtx: WriteContext = { ...ctx, createdAt };

  const content = renderRun(runOutput, writeCtx);

  // Determine path — use timestamped variant if primary already exists
  const primary = await pathForRun(ctx.sessionId, runOutput.taskId);
  const filePath = existsSync(primary)
    ? await timestampedPathForRun(ctx.sessionId, runOutput.taskId, createdAt)
    : primary;

  // Ensure parent dirs exist
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });

  await writeFile(filePath, content, "utf8");

  return {
    kind,
    path: filePath,
    sessionId: ctx.sessionId,
    taskId: runOutput.taskId,
    createdAt,
  };
}

// ─── readArtifact ─────────────────────────────────────────────────────────────

/**
 * Reads a Markdown+YAML artifact from disk, parses and validates it.
 * Throws ParseError if the file is missing or fundamentally unreadable.
 */
export async function readArtifact<K extends ArtifactKind>(
  kind: K,
  filePath: string,
): Promise<ParseResult<ArtifactByKind[K]>> {
  if (kind !== "run") {
    throw new Error(`readArtifact: kind "${kind}" not implemented in milestone 1`);
  }

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err: any) {
    throw new ParseError(`cannot read artifact file: ${filePath}`, {
      path: filePath,
      phase: "filesystem",
      cause: err,
    });
  }

  const result = parseRun(text, filePath);
  return result as ParseResult<ArtifactByKind[K]>;
}

// ─── listArtifacts ────────────────────────────────────────────────────────────

/**
 * Lists artifact refs from disk for a given kind, optionally filtered by sessionId.
 * Reads minimal frontmatter metadata without full parse.
 */
export async function listArtifacts<K extends ArtifactKind>(
  kind: K,
  filter?: { sessionId?: string },
): Promise<ArtifactRef<K>[]> {
  if (kind !== "run") {
    throw new Error(`listArtifacts: kind "${kind}" not implemented in milestone 1`);
  }

  const dir = await listRunsDir();

  let files: string[];
  try {
    const entries = await readdir(dir);
    files = entries.filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`);
  } catch {
    // Directory doesn't exist yet — return empty list
    return [];
  }

  const refs: ArtifactRef<K>[] = [];

  for (const filePath of files) {
    try {
      const text = await readFile(filePath, "utf8");
      // Quick regex scan of frontmatter for metadata — avoids full YAML parse
      const sessionMatch = text.match(/sessionId:\s*(.+)/);
      const taskMatch = text.match(/taskId:\s*(.+)/);
      const createdAtMatch = text.match(/createdAt:\s*(.+)/);

      const sessionId = sessionMatch?.[1]?.trim() ?? "";
      const taskId = taskMatch?.[1]?.trim() ?? undefined;
      const createdAt = createdAtMatch?.[1]?.trim() ?? "";

      if (filter?.sessionId && sessionId !== filter.sessionId) continue;

      refs.push({ kind, path: filePath, sessionId, taskId, createdAt });
    } catch {
      // Skip unreadable files
    }
  }

  return refs;
}
