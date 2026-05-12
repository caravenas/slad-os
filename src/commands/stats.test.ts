import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionError } from "../core/errors.js";
import { saveSession } from "../core/session.js";
import type { SessionState } from "../core/types.js";
import { statsCommand } from "./stats.js";

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slad-stats-command-"));
}

function session(id: string, artifactKinds: SessionState["artifacts"][number]["kind"][]): SessionState {
  return {
    id,
    createdAt: "2026-05-06T00:00:00.000Z",
    intent: `Intent ${id}`,
    artifacts: artifactKinds.map((kind, index) => ({
      kind,
      path: `sessions/${id}/artifacts/${index}.json`,
      createdAt: "2026-05-06T00:00:00.000Z",
    })),
    humanAnswers: [],
    notes: [],
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let output = "";
  const originalWrite = process.stdout.write;

  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const callback = args.find((arg): arg is (err?: Error) => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}

test("stats --json prints parseable numeric totals from isolated sessions", { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const project = makeTempProject();

  try {
    process.chdir(project);
    saveSession(session("s1", ["run", "learn", "snapshot"]));
    saveSession(session("s2", ["plan", "run", "learn"]));

    const output = await captureStdout(() => statsCommand({ json: true }));
    const parsed = JSON.parse(output) as Record<string, unknown>;

    assert.deepEqual(Object.keys(parsed).sort(), ["budget", "learnings", "runs", "sessions"]);
    assert.equal(parsed.sessions, 2);
    assert.equal(parsed.runs, 2);
    assert.equal(parsed.learnings, 2);
    assert.equal(typeof parsed.sessions, "number");
    assert.equal(typeof parsed.runs, "number");
    assert.equal(typeof parsed.learnings, "number");
    assert.equal(typeof parsed.budget, "object");
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("stats prints human-readable Sessions, Runs, and Learnings totals", { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const project = makeTempProject();

  try {
    process.chdir(project);
    saveSession(session("s1", ["run", "learn"]));

    const output = await captureStdout(() => statsCommand());

    assert.match(output, /Sessions:/);
    assert.match(output, /Runs:/);
    assert.match(output, /Learnings:/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("stats fails explicitly when a persisted session is corrupt", { concurrency: false }, async () => {
  const originalCwd = process.cwd();
  const project = makeTempProject();

  try {
    process.chdir(project);
    const corruptStatePath = path.join(project, "docs", "log", "sessions", "corrupt.md");
    fs.mkdirSync(path.dirname(corruptStatePath), { recursive: true });
    fs.writeFileSync(corruptStatePath, "---\n: invalid yaml\n---\n", "utf8");

    await assert.rejects(() => statsCommand({ json: true }), (err: unknown) => {
      assert.equal(err instanceof SessionError, true);
      assert.match((err as Error).message, /estado inválido/);
      return true;
    });
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});
