import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveSession } from "./session.js";
import { computeStatsFromSessions, getProjectStats } from "./stats.js";
import type { SessionState } from "./types.js";

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

test("computeStatsFromSessions counts sessions, run artifacts, and learn artifacts", () => {
  const stats = computeStatsFromSessions([
    session("s1", ["explore", "run", "learn"]),
    session("s2", ["run", "run", "plan"]),
    session("s3", ["learn", "evolve"]),
  ]);

  assert.deepEqual(stats, {
    sessions: 3,
    runs: 3,
    learnings: 2,
  });
});

test("computeStatsFromSessions returns zero totals for an empty project", () => {
  assert.deepEqual(computeStatsFromSessions([]), {
    sessions: 0,
    runs: 0,
    learnings: 0,
  });
});

test("getProjectStats aggregates persisted sessions from an isolated cwd", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-stats-"));
  try {
    saveSession(session("s1", ["run", "learn", "snapshot"]), cwd);
    saveSession(session("s2", ["plan", "run", "evolve", "learn"]), cwd);

    assert.deepEqual(getProjectStats(cwd), {
      sessions: 2,
      runs: 2,
      learnings: 2,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
