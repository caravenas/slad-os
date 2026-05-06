import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getProvider } from "../models/index.js";
import { log } from "../core/logger.js";
import { createSession, saveSession, appendArtifact } from "../core/session.js";
import { BudgetTracker } from "../context/budget.js";
import { Scratchpad } from "../context/scratchpad.js";
import type { AutoReport } from "../context/types.js";
import { createHarness } from "../harness/index.js";
import { loadHarnessConfig } from "../harness/config.js";

import { generateExploreOutput } from "./explore.js";
import { generateSnapshotOutput } from "./snapshot.js";
import { generatePlanOutput } from "./plan.js";
import { generateLearnOutput } from "./learn.js";
import { runAutoLoop } from "./run.js";

export interface AutoOpts {
  provider?: string;
  agent?: string;
  model?: string;
  /** Budget máximo en USD (default: 1.0) */
  maxCost?: number;
  /** Máximo de tasks a ejecutar en run (default: 10) */
  maxTasks?: number;
  /** No ejecutar learn al final */
  skipLearn?: boolean;
  harness?: "off" | "on" | "strict";
  /** Correr explore+snapshot+plan pero NO run */
  dryRun?: boolean;
  json?: boolean;
}

type PipelineStage = "explore" | "snapshot" | "plan" | "run" | "learn";

/** Error interno para detener el pipeline de forma controlada */
class PipelineStop extends Error {
  constructor(
    public readonly stage: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "PipelineStop";
  }
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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

function saveStageArtifact(stage: string, data: unknown): string {
  const dir = path.join(process.cwd(), stageOutputDir(stage));
  const fileName = `${ts()}-${stage}.json`;
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return filePath;
}

function printAutoReport(report: AutoReport, durationMs: number): void {
  const secs = (durationMs / 1000).toFixed(1);
  const statusColor =
    report.status === "completed" ? kleur.green
    : report.status === "partial"   ? kleur.yellow
    : kleur.red;

  console.log(
    kleur.bold("Pipeline ") + statusColor(report.status) + kleur.dim(` · ${secs}s`),
  );
  console.log(kleur.dim(`  stages: ${report.stagesCompleted.join(" → ")}`));
  if (report.stoppedAt) {
    console.log(
      kleur.dim(`  detenido en: ${report.stoppedAt} — ${report.stopReason}`),
    );
  }
}

export async function autoCommand(intent: string, opts: AutoOpts): Promise<void> {
  if (!intent || intent.trim().length < 3) {
    log.error('Intención vacía. Uso: slad auto "<tu intención>"');
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // ── Setup ─────────────────────────────────────────────────────────────────
  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider);
  const apiKey = getApiKey(providerName);

  if (providerName !== "cli" && !apiKey) {
    log.error(`No se encontró API key para ${providerName}.`);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getProvider(providerName, apiKey ?? undefined);

  // ── Session ───────────────────────────────────────────────────────────────
  let session = createSession(intent);

  log.title(`Auto · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`  sesión: ${session.id}`);
  log.dim(`  intent: ${intent}`);
  if (opts.dryRun) log.dim("  modo: dry-run (solo explore+snapshot+plan)");
  if (opts.maxCost !== undefined) log.dim(`  budget: $${opts.maxCost}`);
  console.log("");

  // ── Budget & Scratchpad ───────────────────────────────────────────────────
  const budget = new BudgetTracker(model ?? "_default", opts.maxCost ?? 1.0);
  const scratchpad = new Scratchpad({}, session.id, process.cwd());

  const stagesCompleted: PipelineStage[] = [];
  const artifacts: Record<string, string> = {};
  let stopReason: string | undefined;
  let stoppedAt: string | undefined;

  /** Crea un callback onUsage que registra en el budget del stage dado */
  const makeUsageCb =
    (stage: string) => (inputTokens: number, outputTokens: number) => {
      budget.record(stage, inputTokens, outputTokens);
      const w = budget.warning();
      if (w) log.warn(`  ⚠ ${w}`);
    };

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 1: EXPLORE
    // ══════════════════════════════════════════════════════════════════════════
    const exploreSpinner = ora("Explore · analizando intent...").start();

    const exploreResult = await generateExploreOutput({
      intent,
      provider,
      providerName,
      model,
      wikiPath: config.wikiPath,
      onUsage: makeUsageCb("explore"),
    });
    const exploreOutput = exploreResult.value;

    if (exploreOutput.status === "awaiting_human") {
      exploreSpinner.warn("Explore requiere decisión humana — deteniendo pipeline");
      stoppedAt = "explore";
      stopReason = `HITL requerido: ${exploreOutput.questions.map((q) => q.prompt).join("; ")}`;
    } else {
      exploreSpinner.succeed(
        `Explore · ${exploreOutput.approaches.length} enfoques, ${exploreOutput.risks.length} riesgos`,
      );
    }

    const explorePath = saveStageArtifact("explore", exploreOutput);
    session = appendArtifact(session, "explore", explorePath);
    saveSession(session);
    stagesCompleted.push("explore");
    artifacts["explore"] = explorePath;

    if (exploreOutput.status === "awaiting_human" || budget.isExceeded()) {
      throw new PipelineStop(
        stoppedAt ?? "explore",
        stopReason ?? "Budget excedido después de explore",
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 2: SNAPSHOT
    // ══════════════════════════════════════════════════════════════════════════
    const snapSpinner = ora("Snapshot · generando mini-spec...").start();

    const snapshotOutput = await generateSnapshotOutput({
      exploreOutput,
      approach: undefined, // usa el primer approach (recomendado)
      provider,
      model,
      onUsage: makeUsageCb("snapshot"),
    });

    if (snapshotOutput.status === "awaiting_human") {
      snapSpinner.warn("Snapshot requiere decisión humana — deteniendo pipeline");
      stoppedAt = "snapshot";
      stopReason = `HITL requerido en snapshot`;
    } else {
      snapSpinner.succeed("Snapshot · mini-spec lista");
    }

    const snapshotPath = saveStageArtifact("snapshot", snapshotOutput);
    session = appendArtifact(session, "snapshot", snapshotPath);
    saveSession(session);
    stagesCompleted.push("snapshot");
    artifacts["snapshot"] = snapshotPath;

    if (snapshotOutput.status === "awaiting_human" || budget.isExceeded()) {
      throw new PipelineStop(
        stoppedAt ?? "snapshot",
        stopReason ?? "Budget excedido después de snapshot",
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 3: PLAN
    // ══════════════════════════════════════════════════════════════════════════
    const planSpinner = ora("Plan · generando tasks...").start();

    const planResult = await generatePlanOutput({
      snapshotContent: snapshotOutput.content,
      provider,
      providerName,
      model,
      onUsage: makeUsageCb("plan"),
    });
    const planOutput = planResult.value;

    if (planOutput.status === "awaiting_human") {
      planSpinner.warn("Plan requiere decisión humana — deteniendo pipeline");
      stoppedAt = "plan";
      stopReason = `HITL requerido en plan`;
    } else {
      planSpinner.succeed(`Plan · ${planOutput.tasks.length} tareas generadas`);
    }

    const planPath = saveStageArtifact("plan", planOutput);
    session = appendArtifact(session, "plan", planPath);
    saveSession(session);
    stagesCompleted.push("plan");
    artifacts["plan"] = planPath;

    if (planOutput.status === "awaiting_human" || budget.isExceeded()) {
      throw new PipelineStop(
        stoppedAt ?? "plan",
        stopReason ?? "Budget excedido después de plan",
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 4: RUN (skip si dry-run)
    // ══════════════════════════════════════════════════════════════════════════
    if (opts.dryRun) {
      log.dim("  --dry-run: saltando ejecución de tasks");
      throw new PipelineStop("plan", "Dry run — solo explore+snapshot+plan");
    }

    console.log("");
    log.title("Run · ejecutando tasks");

    const harnessMode = opts.harness ?? "on"; // default "on" en auto (más seguro)
    const harness =
      harnessMode !== "off"
        ? await createHarness(loadHarnessConfig(harnessMode))
        : null;

    try {
      await runAutoLoop(
        planOutput,
        provider,
        model ?? "",
        {
          maxTasks: opts.maxTasks ?? 10,
          maxRounds: 3,
          harness: harnessMode,
          auto: true,
          nonInteractive: true,
          scratchpad,
          onUsage: makeUsageCb("run"),
        },
        session,
        harness,
        true, // useTools
      );
    } finally {
      await harness?.flush();
    }

    stagesCompleted.push("run");
    artifacts["run"] = path.join(process.cwd(), "runs");

    if (budget.isExceeded()) {
      throw new PipelineStop("run", "Budget excedido durante run");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 5: LEARN (opcional)
    // ══════════════════════════════════════════════════════════════════════════
    if (!opts.skipLearn) {
      const learnSpinner = ora("Learn · capturando aprendizajes...").start();

      try {
        const learnOutput = await generateLearnOutput({
          runPath: path.join(process.cwd(), "runs"),
          provider,
          model,
          onUsage: makeUsageCb("learn"),
        });

        learnSpinner.succeed("Learn · aprendizajes capturados");

        const learnPath = saveStageArtifact("learn", learnOutput);
        session = appendArtifact(session, "learn", learnPath);
        saveSession(session);
        stagesCompleted.push("learn");
        artifacts["learn"] = learnPath;
      } catch (err) {
        learnSpinner.warn(`Learn · ${(err as Error).message}`);
        // learn failure no aborta el pipeline — es el stage final
      }
    }
  } catch (err) {
    if (err instanceof PipelineStop) {
      stoppedAt = err.stage;
      stopReason = err.reason;
    } else {
      const lastStage =
        stagesCompleted.length > 0
          ? stagesCompleted[stagesCompleted.length - 1]
          : "explore";
      stoppedAt = lastStage;
      stopReason = (err as Error).message;
      log.error(`Pipeline abortado en ${stoppedAt}: ${stopReason}`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const allExpected: PipelineStage[] = opts.dryRun
    ? ["explore", "snapshot", "plan"]
    : opts.skipLearn
      ? ["explore", "snapshot", "plan", "run"]
      : ["explore", "snapshot", "plan", "run", "learn"];

  const isDryRunStop =
    opts.dryRun && stoppedAt === "plan" && stopReason?.startsWith("Dry run");

  const pipelineStatus: AutoReport["status"] =
    stagesCompleted.length === allExpected.length || isDryRunStop
      ? "completed"
      : stagesCompleted.length > 0
        ? "partial"
        : "failed";

  const report: AutoReport = {
    intent,
    startedAt,
    completedAt,
    durationMs,
    status: pipelineStatus,
    stagesCompleted,
    stoppedAt: isDryRunStop ? undefined : stoppedAt,
    stopReason: isDryRunStop ? undefined : stopReason,
    artifacts,
    budget: budget.getState(),
  };

  // Guardar report
  const reportPath = path.join(process.cwd(), "runs", `${ts()}-auto-report.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  // Print summary
  console.log("");
  printAutoReport(report, durationMs);
  budget.printSummary();

  if (opts.json) {
    console.log("\n" + JSON.stringify(report, null, 2));
  } else {
    log.success(`Reporte: ${reportPath}`);
  }

  // Nota: scratchpad.cleanup() está disponible si querés limpiar los archivos scratch.
  // Por default los dejamos en .slad-os/scratch/<sessionId>/ para debugging.
}
