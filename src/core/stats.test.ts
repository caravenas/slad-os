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

    const stats = getProjectStats(cwd);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.runs, 2);
    assert.equal(stats.learnings, 2);
    // No budget history written → zeros
    assert.deepEqual(stats.budget, {
      totalRuns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUsd: 0,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("getProjectStats includes budget totals from budget-history.jsonl", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "slad-stats-budget-"));
  try {
    const { appendBudgetHistory } = await import("../context/budget-history.js");
    appendBudgetHistory({
      sessionId: "s1", intent: "x", startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z", model: "m", provider: "p",
      inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.01,
      stagesCompleted: ["explore"],
    }, cwd);

    const stats = getProjectStats(cwd);
    assert.equal(stats.budget.totalRuns, 1);
    assert.equal(stats.budget.totalInputTokens, 1000);
    assert.equal(stats.budget.totalOutputTokens, 500);
    assert.ok(Math.abs(stats.budget.totalEstimatedCostUsd - 0.01) < 0.0001);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
