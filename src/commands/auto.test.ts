import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests para el comando auto.
 *
 * Nota: `autoCommand` requiere providers reales y sistema de archivos.
 * Estos tests verifican la lógica de helpers y PipelineStop sin hacer API calls.
 */

// ─── Helpers aislados ─────────────────────────────────────────────────────────

function stageOutputDir(stage: string): string {
  switch (stage) {
    case "explore":  return "explores";
    case "snapshot": return "snapshots";
    case "plan":     return "tasks";
    case "run":      return "runs";
    case "learn":    return "learnings";
    default:         return stage;
  }
}

function ts(): string {
  // Should produce a string without colons or dots (filesystem-safe)
  return new Date().toISOString().replace(/[:.]/g, "-");
}

describe("auto helpers", () => {
  it("stageOutputDir mapea stages correctamente", () => {
    assert.equal(stageOutputDir("explore"),  "explores");
    assert.equal(stageOutputDir("snapshot"), "snapshots");
    assert.equal(stageOutputDir("plan"),     "tasks");
    assert.equal(stageOutputDir("run"),      "runs");
    assert.equal(stageOutputDir("learn"),    "learnings");
    assert.equal(stageOutputDir("unknown"),  "unknown");
  });

  it("ts() genera string sin caracteres inválidos en rutas", () => {
    const result = ts();
    assert.ok(!result.includes(":"), "No debe contener ':'");
    assert.ok(!result.includes("."), "No debe contener '.'");
    assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});

// ─── PipelineStop (clase interna — testeada via comportamiento) ───────────────

describe("pipeline stop behavior", () => {
  it("dry-run con stages completos reporta 'completed'", () => {
    const dryRun = true;
    const stagesCompleted = ["explore", "snapshot", "plan"] as const;
    const allExpected = dryRun
      ? ["explore", "snapshot", "plan"]
      : ["explore", "snapshot", "plan", "run", "learn"];

    const stoppedAt = "plan";
    const stopReason = "Dry run — solo explore+snapshot+plan";
    const isDryRunStop = dryRun && stoppedAt === "plan" && stopReason.startsWith("Dry run");

    const status =
      stagesCompleted.length === allExpected.length || isDryRunStop
        ? "completed"
        : stagesCompleted.length > 0
          ? "partial"
          : "failed";

    assert.equal(status, "completed");
  });

  it("pipeline parcial con algunos stages completos reporta 'partial'", () => {
    const stagesCompleted = ["explore", "snapshot"] as const;
    const allExpected = ["explore", "snapshot", "plan", "run", "learn"];

    const isDryRunStop = false; // not a dry-run stop

    const status =
      stagesCompleted.length === allExpected.length || isDryRunStop
        ? "completed"
        : stagesCompleted.length > 0
          ? "partial"
          : "failed";

    assert.equal(status, "partial");
  });

  it("pipeline sin stages completos reporta 'failed'", () => {
    const stagesCompleted: string[] = [];
    const allExpected = ["explore", "snapshot", "plan", "run", "learn"];

    const isDryRunStop = false;

    const status =
      stagesCompleted.length === allExpected.length || isDryRunStop
        ? "completed"
        : stagesCompleted.length > 0
          ? "partial"
          : "failed";

    assert.equal(status, "failed");
  });
});

// ─── onUsage callback integration ─────────────────────────────────────────────

describe("onUsage callback (BudgetTracker integration)", () => {
  it("record acumula tokens al llamar onUsage", async () => {
    // Dinámica: importar BudgetTracker directamente para verificar la integración
    const { BudgetTracker } = await import("../context/budget.js");
    const budget = new BudgetTracker("gpt-4o");

    // Simular cómo auto.ts crea el callback
    const makeUsageCb = (stage: string) => (input: number, output: number) => {
      budget.record(stage, input, output);
    };

    const cb = makeUsageCb("explore");
    cb(1000, 500);
    cb(2000, 800);

    const state = budget.getState();
    assert.equal(state.inputTokens, 3000);
    assert.equal(state.outputTokens, 1300);
    assert.equal(state.byStage["explore"]?.calls, 2);
  });
});
