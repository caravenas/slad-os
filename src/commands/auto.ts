import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getProvider } from "../models/index.js";
import { log } from "../core/logger.js";
import { createSession, loadSession, saveSession, appendArtifact } from "../core/session.js";
import { BudgetTracker } from "../context/budget.js";
import { Scratchpad } from "../context/scratchpad.js";
import type { AutoReport } from "../context/types.js";
import { createHarness } from "../harness/index.js";
import { loadHarnessConfig } from "../harness/config.js";

import { generateLearnOutput } from "./learn.js";
import { runAutoLoop } from "./run.js";
import { hitlLoop } from "../core/hitl-loop.js";
import {
  autoResolveExplore,
  autoResolveGeneric,
  autoResolvePlan,
} from "../core/hitl-auto-resolve.js";
import {
  EXPLORER_SYSTEM,
  SNAPSHOT_SYSTEM,
  PLANNER_SYSTEM,
} from "../agents/prompts.js";
import { ProviderError } from "../core/errors.js";
import { ExploreOutput, SnapshotOutput, PlanOutput, LearnOutput } from "../core/types.js";
import { readWikiContextCached } from "../agents/explorer.js";
import { projectContextBlock } from "../core/context.js";
import { getDocsRoot, listRunsDir } from "../persistence/layout.js";
import { writeArtifact, readArtifact } from "../persistence/index.js";
import { saveAutoCheckpoint, clearAutoCheckpoint, loadAutoCheckpoint } from "./auto-checkpoint.js";
import { appendBudgetHistory } from "../context/budget-history.js";
import { select } from "@inquirer/prompts";

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
  /** Resumir desde el último checkpoint sin preguntar */
  resume?: boolean;
  /** Ignorar checkpoints y empezar de cero */
  fresh?: boolean;
  /** Test seam: inject a pre-built provider to avoid real API calls */
  _provider?: import("../models/index.js").ModelProvider;
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

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

async function saveStageArtifact(
  stage: Exclude<PipelineStage, "run">,
  sessionId: string,
  data: unknown,
): Promise<string> {
  switch (stage) {
    case "explore":
      return (await writeArtifact("explore", ExploreOutput.parse(data), { sessionId })).path;
    case "snapshot":
      return (await writeArtifact("snapshot", SnapshotOutput.parse(data), { sessionId })).path;
    case "plan":
      return (await writeArtifact("plan", PlanOutput.parse(data), { sessionId })).path;
    case "learn":
      return (await writeArtifact("learn", LearnOutput.parse(data), { sessionId })).path;
  }
}

async function saveAutoReport(report: AutoReport): Promise<string> {
  const reportPath = path.join(await getDocsRoot(), "log", "auto", `${ts()}-auto-report.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    [
      "---",
      "kind: auto-report",
      "schemaVersion: 1",
      `createdAt: ${new Date().toISOString()}`,
      "---",
      "",
      "# Auto Report",
      "",
      "```json",
      JSON.stringify(report, null, 2),
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  return reportPath;
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

  let provider: import("../models/index.js").ModelProvider;
  let model: string | undefined;
  if (opts._provider) {
    provider = opts._provider;
    model = opts.model;
  } else {
    const apiKey = getApiKey(providerName);
    if (providerName !== "cli" && !apiKey) {
      log.error(`No se encontró API key para ${providerName}.`);
      process.exit(1);
    }
    model = opts.model ?? getModel(providerName);
    provider = await getProvider(providerName, apiKey ?? undefined);
  }

  // ── Fail-fast: Builder needs file-writing capability (unless dry-run) ──
  // Same logic as runCommand. The `cli` provider is exempt because the
  // spawned binary (codex/claude) handles its own file operations.
  // Injected test providers (_provider) bypass this check.
  if (!opts.dryRun && !opts._provider && providerName !== "cli" && !provider.supportsToolUse) {
    throw new ProviderError(
      `El provider "${providerName}" no soporta tool use, así que el Builder no podría escribir archivos. ` +
      `Usá uno de:\n` +
      `  · --provider anthropic  (requiere ANTHROPIC_API_KEY)\n` +
      `  · --provider openai     (requiere OPENAI_API_KEY)\n` +
      `  · --agent codex         (requiere binario codex local)\n` +
      `  · --agent claude        (requiere binario claude local)\n` +
      `O agregá --dry-run si solo querés explore+snapshot+plan.`,
      providerName,
      { retryable: false },
    );
  }

  // ── Checkpoint resume detection ───────────────────────────────────────────
  let resumeCheckpoint: ReturnType<typeof loadAutoCheckpoint> = null;
  if (!opts.fresh) {
    const existing = loadAutoCheckpoint();
    if (existing && existing.intent === intent) {
      if (opts.resume) {
        resumeCheckpoint = existing;
      } else {
        const choice = await select({
          message: `Encontré un pipeline incompleto para esta intención (último stage: ${existing.lastStageCompleted}). ¿Qué hacemos?`,
          choices: [
            { name: `Resumir desde ${existing.lastStageCompleted} (continuar donde quedó)`, value: "resume" as const },
            { name: "Empezar de cero (ignorar checkpoint)", value: "fresh" as const },
          ],
          default: "resume",
        });
        if (choice === "resume") resumeCheckpoint = existing;
        else clearAutoCheckpoint();
      }
    }
  } else {
    clearAutoCheckpoint();
  }

  // ── Session ───────────────────────────────────────────────────────────────
  let session = resumeCheckpoint
    ? (loadSession(resumeCheckpoint.sessionId) ?? createSession(intent))
    : createSession(intent);

  log.title(`Auto · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`  sesión: ${session.id}`);
  log.dim(`  intent: ${intent}`);
  if (resumeCheckpoint) log.dim(`  resumiendo desde: ${resumeCheckpoint.lastStageCompleted}`);
  if (opts.dryRun) log.dim("  modo: dry-run (solo explore+snapshot+plan)");
  if (opts.maxCost !== undefined) log.dim(`  budget: $${opts.maxCost}`);
  console.log("");

  // ── Budget & Scratchpad ───────────────────────────────────────────────────
  const budget = new BudgetTracker(
    model ?? "_default",
    opts.maxCost ?? 1.0,
    0,
    resumeCheckpoint?.budgetState,
  );
  const scratchpad = new Scratchpad({}, session.id, process.cwd());

  const stagesCompleted: PipelineStage[] = resumeCheckpoint
    ? (resumeCheckpoint.lastStageCompleted === "explore" ? ["explore"]
      : resumeCheckpoint.lastStageCompleted === "snapshot" ? ["explore", "snapshot"]
      : resumeCheckpoint.lastStageCompleted === "plan" ? ["explore", "snapshot", "plan"]
      : resumeCheckpoint.lastStageCompleted === "run" ? ["explore", "snapshot", "plan", "run"]
      : ["explore", "snapshot", "plan", "run", "learn"])
    : [];
  const artifacts: Record<string, string> = resumeCheckpoint ? { ...resumeCheckpoint.artifacts } : {};
  let stopReason: string | undefined;
  let stoppedAt: string | undefined;

  /** Crea un callback onUsage que registra en el budget del stage dado */
  const makeUsageCb =
    (stage: string) => (inputTokens: number, outputTokens: number) => {
      budget.record(stage, inputTokens, outputTokens);
      const w = budget.warning();
      if (w) log.warn(`  ⚠ ${w}`);
    };

  /** Retorna true si el stage ya estaba completado (resume) */
  const alreadyDone = (stage: PipelineStage) => stagesCompleted.includes(stage);

  // ── Load resumed stage outputs ─────────────────────────────────────────────
  let resumedExploreOutput: ExploreOutput | null = null;
  let resumedSnapshotOutput: SnapshotOutput | null = null;
  let resumedPlanOutput: PlanOutput | null = null;

  if (resumeCheckpoint) {
    if (artifacts["explore"]) {
      try {
        resumedExploreOutput = (await readArtifact("explore", artifacts["explore"])).value;
      } catch { /* ignore — will re-run explore */ }
    }
    if (artifacts["snapshot"]) {
      try {
        resumedSnapshotOutput = (await readArtifact("snapshot", artifacts["snapshot"])).value;
      } catch { /* ignore — will re-run snapshot */ }
    }
    if (artifacts["plan"]) {
      try {
        resumedPlanOutput = (await readArtifact("plan", artifacts["plan"])).value;
      } catch { /* ignore — will re-run plan */ }
    }
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 1: EXPLORE (con HITL interactivo)
    // ══════════════════════════════════════════════════════════════════════════
    let exploreOutput: ExploreOutput;

    if (alreadyDone("explore") && resumedExploreOutput) {
      ora().succeed("Explore · retomado desde checkpoint");
      exploreOutput = resumedExploreOutput;
    } else {
      const exploreSpinner = ora("Explore · analizando intent...").start();

      const wikiContext = await readWikiContextCached(config.wikiPath);
      const exploreProjectCtx = projectContextBlock();
      const exploreUserContent = [
        wikiContext.text
          ? `Contexto de la wiki del usuario (solo referencia):\n\n${wikiContext.text}\n\n---\n`
          : "",
        exploreProjectCtx,
        `Intención del usuario:\n${intent}`,
      ].filter(Boolean).join("\n\n");

      exploreSpinner.stop(); // Stop before hitlLoop (may need interactive I/O)

      const exploreHitl = await hitlLoop(
        provider,
        [{ role: "user", content: exploreUserContent }],
        {
          stageName: "Explorer",
          maxRounds: 3,
          completionOpts: {
            systemPrompt: EXPLORER_SYSTEM,
            temperature: 0.5,
            maxTokens: 2048,
            model,
            onUsage: makeUsageCb("explore"),
          },
          parse: (raw) => ExploreOutput.parse(JSON.parse(extractJson(raw))),
          autoResolve: autoResolveExplore,
        },
      );
      exploreOutput = exploreHitl.output;

      if (exploreOutput.status === "awaiting_human") {
        log.warn("  Explore · HITL agotado, quedaron preguntas sin resolver");
        stoppedAt = "explore";
        stopReason = `HITL sin resolver: ${exploreOutput.questions.map((q) => q.prompt).join("; ")}`;
      } else {
        ora().succeed(
          `Explore · ${exploreOutput.approaches.length} enfoques, ${exploreOutput.risks.length} riesgos`,
        );
        if (exploreHitl.rounds > 0) log.dim(`    (${exploreHitl.rounds} rondas HITL)`);
      }

      const explorePath = await saveStageArtifact("explore", session.id, exploreOutput);
      session = appendArtifact(session, "explore", explorePath);
      saveSession(session);
      stagesCompleted.push("explore");
      artifacts["explore"] = explorePath;
      saveAutoCheckpoint({ intent, sessionId: session.id, lastStageCompleted: "explore", artifacts: { ...artifacts }, budgetState: budget.getState(), savedAt: new Date().toISOString() });
    }

    if (exploreOutput.status === "awaiting_human" || budget.isExceeded()) {
      throw new PipelineStop(
        stoppedAt ?? "explore",
        stopReason ?? "Budget excedido después de explore",
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 2: SNAPSHOT (con HITL interactivo)
    // ══════════════════════════════════════════════════════════════════════════
    let snapshotOutput: SnapshotOutput;

    if (alreadyDone("snapshot") && resumedSnapshotOutput) {
      ora().succeed("Snapshot · retomado desde checkpoint");
      snapshotOutput = resumedSnapshotOutput;
    } else {
      const chosenApproach = exploreOutput.approaches[0];
      const snapshotProjectCtx = projectContextBlock();
      const snapshotUserContent = [
        snapshotProjectCtx,
        `Intent original:\n${exploreOutput.intent}`,
        `Reframing:\n${exploreOutput.reframing}`,
        chosenApproach
          ? `Enfoque elegido — ${chosenApproach.name}:\n${chosenApproach.summary}\nPros: ${chosenApproach.pros.join("; ")}\nCons: ${chosenApproach.cons.join("; ")}`
          : "",
        exploreOutput.risks.length
          ? `Riesgos conocidos:\n- ${exploreOutput.risks.join("\n- ")}`
          : "",
        exploreOutput.openQuestions.length
          ? `Preguntas abiertas:\n- ${exploreOutput.openQuestions.join("\n- ")}`
          : "",
        `Next step sugerido: ${exploreOutput.recommendedNext}`,
      ].filter(Boolean).join("\n\n");

      const snapshotHitl = await hitlLoop(
        provider,
        [{ role: "user", content: snapshotUserContent }],
        {
          stageName: "Snapshot",
          maxRounds: 3,
          completionOpts: {
            systemPrompt: SNAPSHOT_SYSTEM,
            temperature: 0.3,
            maxTokens: 1500,
            model,
            onUsage: makeUsageCb("snapshot"),
          },
          parse: (raw) => SnapshotOutput.parse(JSON.parse(extractJson(raw))),
          autoResolve: autoResolveGeneric,
        },
      );
      snapshotOutput = snapshotHitl.output;

      if (snapshotOutput.status === "awaiting_human") {
        log.warn("  Snapshot · HITL agotado, quedaron preguntas sin resolver");
        stoppedAt = "snapshot";
        stopReason = `HITL sin resolver en snapshot`;
      } else {
        ora().succeed("Snapshot · mini-spec lista");
        if (snapshotHitl.rounds > 0) log.dim(`    (${snapshotHitl.rounds} rondas HITL)`);
      }

      const snapshotPath = await saveStageArtifact("snapshot", session.id, snapshotOutput);
      session = appendArtifact(session, "snapshot", snapshotPath);
      saveSession(session);
      stagesCompleted.push("snapshot");
      artifacts["snapshot"] = snapshotPath;
      saveAutoCheckpoint({ intent, sessionId: session.id, lastStageCompleted: "snapshot", artifacts: { ...artifacts }, budgetState: budget.getState(), savedAt: new Date().toISOString() });
    }

    if (snapshotOutput.status === "awaiting_human" || budget.isExceeded()) {
      throw new PipelineStop(
        stoppedAt ?? "snapshot",
        stopReason ?? "Budget excedido después de snapshot",
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STAGE 3: PLAN (con HITL interactivo)
    // ══════════════════════════════════════════════════════════════════════════
    let planOutput: PlanOutput;

    if (alreadyDone("plan") && resumedPlanOutput) {
      ora().succeed("Plan · retomado desde checkpoint");
      planOutput = resumedPlanOutput;
    } else {
      const planProjectCtx = projectContextBlock();
      const planUserContent = [
        planProjectCtx,
        `Snapshot:\n\n${snapshotOutput.content}`,
      ].filter(Boolean).join("\n\n");

      const planHitl = await hitlLoop(
        provider,
        [{ role: "user", content: planUserContent }],
        {
          stageName: "Planner",
          maxRounds: 3,
          completionOpts: {
            systemPrompt: PLANNER_SYSTEM,
            temperature: 0.2,
            maxTokens: 2500,
            model,
            onUsage: makeUsageCb("plan"),
          },
          parse: (raw) => PlanOutput.parse(JSON.parse(extractJson(raw))),
          autoResolve: autoResolvePlan,
        },
      );
      planOutput = planHitl.output;

      if (planOutput.status === "awaiting_human") {
        log.warn("  Plan · HITL agotado, quedaron preguntas sin resolver");
        stoppedAt = "plan";
        stopReason = `HITL sin resolver en plan`;
      } else {
        ora().succeed(`Plan · ${planOutput.tasks.length} tareas generadas`);
        if (planHitl.rounds > 0) log.dim(`    (${planHitl.rounds} rondas HITL)`);
      }

      const planPath = await saveStageArtifact("plan", session.id, planOutput);
      session = appendArtifact(session, "plan", planPath);
      saveSession(session);
      stagesCompleted.push("plan");
      artifacts["plan"] = planPath;
      saveAutoCheckpoint({ intent, sessionId: session.id, lastStageCompleted: "plan", artifacts: { ...artifacts }, budgetState: budget.getState(), savedAt: new Date().toISOString() });
    }

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
          nonInteractive: false, // HITL interactivo en auto mode
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
    artifacts["run"] = await listRunsDir();
    saveAutoCheckpoint({ intent, sessionId: session.id, lastStageCompleted: "run", artifacts: { ...artifacts }, budgetState: budget.getState(), savedAt: new Date().toISOString() });

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
          runPath: await listRunsDir(),
          provider,
          model,
          onUsage: makeUsageCb("learn"),
        });

        learnSpinner.succeed("Learn · aprendizajes capturados");

        const learnPath = await saveStageArtifact("learn", session.id, learnOutput);
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

  const reportPath = await saveAutoReport(report);

  // Clear checkpoint when pipeline completes fully (no partial/failed)
  if (pipelineStatus === "completed") clearAutoCheckpoint();

  // Persist budget history for cross-session stats
  const budgetFinal = budget.getState();
  appendBudgetHistory({
    sessionId: session.id,
    intent,
    startedAt,
    completedAt,
    model: model ?? "_default",
    provider: providerName,
    inputTokens: budgetFinal.inputTokens,
    outputTokens: budgetFinal.outputTokens,
    estimatedCostUsd: budgetFinal.estimatedCostUsd,
    stagesCompleted,
  });

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
