import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  EvolveOutput,
  ExploreOutput,
  LearnOutput,
  PlanOutput,
  RunOutput,
  SessionState,
  SnapshotOutput,
} from "../core/types.js";
import { ParseError } from "../core/errors.js";
import { renderRun } from "./render/run.js";
import { renderExplore } from "./render/explore.js";
import { renderSnapshot } from "./render/snapshot.js";
import { renderPlan } from "./render/plan.js";
import { renderLearn } from "./render/learn.js";
import { renderEvolve } from "./render/evolve.js";
import { renderSession } from "./render/session.js";
import { parseRun } from "./parse/run.js";
import { parseExplore } from "./parse/explore.js";
import { parseSnapshot } from "./parse/snapshot.js";
import { parsePlan } from "./parse/plan.js";
import { parseLearn } from "./parse/learn.js";
import { parseEvolve } from "./parse/evolve.js";
import { parseSession } from "./parse/session.js";
import {
  artifactDir,
  pathForArtifact,
  pathForRun,
  timestampedPathForArtifact,
  timestampedPathForRun,
} from "./layout.js";
import { parseFrontmatter } from "./frontmatter.js";

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
  explore: ExploreOutput;
  snapshot: SnapshotOutput;
  plan: PlanOutput;
  learn: LearnOutput;
  evolve: EvolveOutput;
  session: SessionState;
};

export interface WriteContext {
  sessionId: string;
  /** ISO string; default: new Date().toISOString() */
  createdAt?: string;
  key?: string;
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
  const createdAt = ctx.createdAt ?? new Date().toISOString();
  const writeCtx: WriteContext = { ...ctx, createdAt };

  const content = renderArtifact(kind, value, writeCtx);

  const key = artifactKey(kind, value, ctx.key);
  const primary = kind === "run"
    ? await pathForRun(ctx.sessionId, (value as RunOutput).taskId)
    : await pathForArtifact(kind, ctx.sessionId, key);
  const filePath = existsSync(primary)
    ? kind === "run"
      ? await timestampedPathForRun(ctx.sessionId, (value as RunOutput).taskId, createdAt)
      : await timestampedPathForArtifact(kind, ctx.sessionId, createdAt, key)
    : primary;

  // Ensure parent dirs exist
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });

  await writeFile(filePath, content, "utf8");

  return {
    kind,
    path: filePath,
    sessionId: ctx.sessionId,
    ...(taskIdFor(kind, value) ? { taskId: taskIdFor(kind, value) } : {}),
    createdAt,
  };
}

function renderArtifact<K extends ArtifactKind>(
  kind: K,
  value: ArtifactByKind[K],
  ctx: WriteContext,
): string {
  switch (kind) {
    case "explore":
      return renderExplore(value as ExploreOutput, ctx);
    case "snapshot":
      return renderSnapshot(value as SnapshotOutput, ctx);
    case "plan":
      return renderPlan(value as PlanOutput, ctx);
    case "run":
      return renderRun(value as RunOutput, ctx);
    case "learn":
      return renderLearn(value as LearnOutput, ctx);
    case "evolve":
      return renderEvolve(value as EvolveOutput, ctx);
    case "session":
      return renderSession(value as SessionState, ctx);
  }
}

function parseArtifact<K extends ArtifactKind>(
  kind: K,
  text: string,
  filePath: string,
): ParseResult<ArtifactByKind[K]> {
  switch (kind) {
    case "explore":
      return parseExplore(text, filePath) as ParseResult<ArtifactByKind[K]>;
    case "snapshot":
      return parseSnapshot(text, filePath) as ParseResult<ArtifactByKind[K]>;
    case "plan":
      return parsePlan(text, filePath) as ParseResult<ArtifactByKind[K]>;
    case "run":
      return parseRun(text, filePath) as ParseResult<ArtifactByKind[K]>;
    case "learn":
      return parseLearn(text, filePath) as ParseResult<ArtifactByKind[K]>;
    case "evolve":
      return parseEvolve(text, filePath) as ParseResult<ArtifactByKind[K]>;
    case "session":
      return parseSession(text, filePath) as ParseResult<ArtifactByKind[K]>;
  }
}

function artifactKey<K extends ArtifactKind>(
  kind: K,
  value: ArtifactByKind[K],
  explicit?: string,
): string | undefined {
  if (explicit) return explicit;
  if (kind === "learn") return (value as LearnOutput).taskId;
  return undefined;
}

function taskIdFor<K extends ArtifactKind>(kind: K, value: ArtifactByKind[K]): string | undefined {
  if (kind === "run") return (value as RunOutput).taskId;
  if (kind === "learn") return (value as LearnOutput).taskId;
  return undefined;
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

  return parseArtifact(kind, text, filePath);
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
  const dir = await artifactDir(kind);

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
      const { frontmatter } = parseFrontmatter(text, filePath);
      const sessionId = String(frontmatter.sessionId ?? "");
      const taskId = typeof frontmatter.taskId === "string" ? frontmatter.taskId : undefined;
      const createdAt = String(frontmatter.createdAt ?? "");

      if (filter?.sessionId && sessionId !== filter.sessionId) continue;

      refs.push({ kind, path: filePath, sessionId, taskId, createdAt });
    } catch {
      // Skip unreadable files
    }
  }

  return refs;
}
