import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import ora from "ora";
import kleur from "kleur";
import { BUILDER_REVIEWER_SYSTEM } from "../agents/prompts.js";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { PlanOutput, RunOutput, type PlanTask } from "../core/types.js";
import { select } from "@inquirer/prompts";
import type { Scratchpad } from "../context/scratchpad.js";
import type { BudgetTracker } from "../context/budget.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { projectContextBlock } from "../core/context.js";
import { log } from "../core/logger.js";
import { SchemaError, SladError, isRetryable } from "../core/errors.js";
import { createHarness } from "../harness/index.js";
import { loadHarnessConfig } from "../harness/config.js";
import type { ExecutionHarness } from "../harness/types.js";
import { confirmDangerousAction } from "../harness/approval.js";
import { getProvider } from "../models/index.js";
import { toolLoop } from "../models/tool-loop.js";
import { ToolExecutor } from "../tools/executor.js";
import { createDefaultRegistry } from "../tools/registry.js";
import type { ChatMessage, SessionState } from "../core/types.js";
import type { ModelProvider } from "../models/index.js";
import {
  getActiveSession,
  lastArtifactPath,
  appendArtifact,
  appendAnswers,
  saveSession,
  sessionContextBlock,
} from "../core/session.js";

export interface RunOpts {
  input?: string;
  task?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  json?: boolean;
  maxRounds?: number;
  auto?: boolean;
  maxTasks?: number;
  skipSession?: boolean;
  harness?: "off" | "on" | "strict";
  /** Habilitar tool use (ejecución real de código). Default: true si el provider lo soporta */
  tools?: boolean;
  /**
   * Modo no-interactivo para uso programático (ej. desde `slad auto`).
   * Cuando true:
   * - Tasks fallidas → auto-skip (sin preguntar retry/skip/abort)
   * - HITL awaiting_human → el loop se detiene retornando false
   * - No se pregunta resume/fresh al detectar completadas previas
   */
  nonInteractive?: boolean;
  /** Scratchpad para offloading de tool results grandes (usado en auto pipeline) */
  scratchpad?: Scratchpad | null;
  /** Budget tracker para visibilidad de costo (usado en auto pipeline) */
  budget?: BudgetTracker | null;
  /** Token usage callback (usado en auto pipeline) */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_TASKS = 10;

// ─── utilities ────────────────────────────────────────────────────────────────

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readPlan(planInput: string | undefined): ReturnType<typeof PlanOutput.parse> {
  const planPath = path.resolve(planInput ?? path.join(process.cwd(), "tasks", "tasks.json"));
  if (!fs.existsSync(planPath)) {
    throw new Error(`No existe el archivo de tasks: ${planPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(planPath, "utf8"));
  return PlanOutput.parse(raw);
}

function pickTask(plan: ReturnType<typeof PlanOutput.parse>, taskId: string | undefined): PlanTask {
  const id = taskId ?? plan.recommendedFirstTask;
  const task = plan.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No existe la tarea ${id} en el plan.`);
  return task;
}

function buildUserContent(
  plan: ReturnType<typeof PlanOutput.parse>,
  task: PlanTask,
  sessionCtx: string,
): string {
  return [
    projectContextBlock(),
    `Plan summary:\n${plan.summary}`,
    `Selected task:\n${JSON.stringify(task, null, 2)}`,
    plan.verification.length
      ? `Plan-level verification:\n${plan.verification.map((i) => `- ${i}`).join("\n")}`
      : "",
    plan.risks.length ? `Known risks:\n${plan.risks.map((i) => `- ${i}`).join("\n")}` : "",
    plan.openQuestions.length
      ? `Open questions:\n${plan.openQuestions.map((i) => `- ${i}`).join("\n")}`
      : "",
    sessionCtx,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseRunOutput(raw: string): RunOutput {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = RunOutput.safeParse(parsed);
  if (!result.success) {
    throw new SchemaError(
      "Run output no pasa el schema",
      jsonText,
      result.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`),
      "run",
    );
  }
  return result.data;
}

// ─── git change detection ─────────────────────────────────────────────────────

type GitSnapshot = Map<string, string>;

function gitStatusSnapshot(): GitSnapshot | null {
  try {
    const out = execSync("git status --porcelain", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const map: GitSnapshot = new Map();
    for (const line of out.split("\n").filter(Boolean)) {
      // Format: "XY path" where XY is the 2-char status code
      const code = line.slice(0, 2);
      const filePath = line.slice(3);
      map.set(filePath, code);
    }
    return map;
  } catch {
    return null; // not a git repo, or git not installed
  }
}

function printNewChanges(before: GitSnapshot | null, taskId: string): void {
  if (!before) return;
  const after = gitStatusSnapshot();
  if (!after) return;

  const newOrChanged: Array<{ path: string; code: string }> = [];
  for (const [filePath, code] of after) {
    if (before.get(filePath) !== code) {
      newOrChanged.push({ path: filePath, code: code.trim() || "??" });
    }
  }
  if (newOrChanged.length === 0) return;

  console.log("");
  console.log(kleur.dim(`  ${taskId} cambios sin commitear:`));
  for (const { path: p, code } of newOrChanged) {
    const colored =
      code === "??" ? kleur.cyan(code) : code.startsWith("D") ? kleur.red(code) : kleur.yellow(code);
    console.log(`  ${colored}  ${p}`);
  }
}

// ─── single task execution (with HITL loop) ───────────────────────────────────

interface TaskResult {
  output: RunOutput;
  outPath: string;
  humanAnswers: Record<string, string>;
}

interface ExecuteTaskExtras {
  scratchpad?: Scratchpad | null;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

async function executeTask(
  task: PlanTask,
  plan: ReturnType<typeof PlanOutput.parse>,
  provider: ModelProvider,
  model: string,
  maxRounds: number,
  sessionCtx: string,
  outputDir: string,
  harness: ExecutionHarness | null = null,
  useTools = true,
  extras: ExecuteTaskExtras = {},
): Promise<TaskResult> {
  const taskStart = Date.now();

  // ── PRE-TASK: check if task can run ──
  if (harness) {
    const verdict = await harness.beforeTask(task, null);
    if (verdict.action === "deny") {
      const blockedOutput: RunOutput = {
        taskId: task.id,
        status: "blocked",
        summary: `Harness denied: ${verdict.reason}`,
        changedFiles: [],
        verification: [],
        reviewerNotes: [`Harness denied execution: ${verdict.reason}`],
        followUps: [],
        questions: [],
        humanAnswers: {},
      };
      const outPath = `${outputDir}/${timestamp()}-${task.id}.json`;
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(blockedOutput, null, 2) + "\n", "utf8");
      return { output: blockedOutput, outPath, humanAnswers: {} };
    }
    if (verdict.action === "modify") {
      task = { ...task, ...verdict.patch };
    }
  }

  const messages: ChatMessage[] = [
    { role: "user", content: buildUserContent(plan, task, sessionCtx) },
  ];
  const allHumanAnswers: Record<string, string> = {};
  let output!: RunOutput;
  let raw = "";
  let rounds = 0;

  const spinner = ora();

  while (rounds <= maxRounds) {
    spinner.start(
      rounds === 0 ? `${task.id} · ${task.title}` : `${task.id} reanudando (round ${rounds})...`,
    );

    try {
      const toolsEnabled = useTools && provider.supportsToolUse;
      if (toolsEnabled) {
        const registry = createDefaultRegistry();
        const executor = new ToolExecutor(registry, {
          cwd: process.cwd(),
          harness,
        });
        raw = await toolLoop(provider, messages, executor, {
          systemPrompt: BUILDER_REVIEWER_SYSTEM,
          temperature: 0.2,
          maxTokens: 4096,
          model,
          tools: registry.definitions(),
          maxToolRounds: 10,
          scratchpad: extras.scratchpad ?? null,
          onUsage: extras.onUsage,
          onToolCall: (name, args) => {
            const firstArg = Object.values(args)[0];
            const argPreview = typeof firstArg === "string" ? firstArg.slice(0, 40) : "";
            spinner.text = `${task.id} · ${name}(${argPreview})`;
          },
        });
      } else {
        raw = await provider.complete(messages, {
          systemPrompt: BUILDER_REVIEWER_SYSTEM,
          temperature: 0.2,
          maxTokens: 3000,
          model,
          onUsage: extras.onUsage,
        });
      }
    } catch (err) {
      if (isRetryable(err) && rounds < maxRounds) {
        spinner.text = `${task.id} · rate limited, reintentando en 5s...`;
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      spinner.fail(`${task.id} · falló la llamada al provider`);
      throw err;
    }

    try {
      output = parseRunOutput(raw);
    } catch (err) {
      spinner.fail(`${task.id} · output inválido`);
      throw err;
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      const icon = output.status === "completed" ? "✓" : "✗";
      const color = output.status === "completed" ? kleur.green : kleur.red;
      spinner.stopAndPersist({ symbol: color(icon), text: `${task.id} · ${task.title}` });
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn(`${task.id} · max rounds HITL alcanzado`);
      output = {
        ...output,
        status: "blocked",
        reviewerNotes: [
          ...output.reviewerNotes,
          `HITL: se agotaron los ${maxRounds} rounds sin resolución.`,
        ],
      };
      break;
    }

    spinner.stop();
    printHitlHeader(task.id, output.summary, rounds + 1, maxRounds);

    const answers = await collectAnswers(output.questions);
    Object.assign(allHumanAnswers, answers);

    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  output = { ...output, humanAnswers: allHumanAnswers };

  // ── POST-OUTPUT: classify + approval ──
  if (harness && output.status !== "blocked") {
    const classifications = harness.classifyOutput(output);

    if (harness.requiresApproval(classifications)) {
      const approved = await confirmDangerousAction(task.id, classifications);
      if (!approved) {
        output = {
          ...output,
          status: "blocked",
          reviewerNotes: [
            ...output.reviewerNotes,
            "Harness: acción peligrosa rechazada por el usuario",
          ],
        };
      }
    }

    await harness.afterTask(task, output, Date.now() - taskStart);
  }

  const outPath = path.join(outputDir, `${timestamp()}-${task.id}.json`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");

  return { output, outPath, humanAnswers: allHumanAnswers };
}

// ─── topological sort & DAG helpers ──────────────────────────────────────────

type TaskStatus = "pending" | "done" | "skipped" | "failed";
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

function nextRunnableTask(
  tasks: PlanTask[],
  state: Map<string, TaskStatus>,
): PlanTask | null {
  const runnable = tasks.filter(
    (t) =>
      (state.get(t.id) ?? "pending") === "pending" &&
      t.dependsOn.every((dep) => state.get(dep) === "done"),
  );
  if (runnable.length === 0) return null;
  return runnable.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      tasks.indexOf(a) - tasks.indexOf(b),
  )[0];
}

function autoSkipDependents(
  tasks: PlanTask[],
  state: Map<string, TaskStatus>,
  skippedId: string,
): string[] {
  const skipped: string[] = [];
  const cascade = (id: string) => {
    for (const t of tasks) {
      if (t.dependsOn.includes(id) && (state.get(t.id) ?? "pending") === "pending") {
        state.set(t.id, "skipped");
        skipped.push(t.id);
        cascade(t.id);
      }
    }
  };
  cascade(skippedId);
  return skipped;
}

// ─── auto-loop ────────────────────────────────────────────────────────────────

interface TaskReport {
  taskId: string;
  title: string;
  status: "done" | "skipped" | "failed";
  skippedReason?: "dependency" | "user";
  durationMs: number;
  output?: RunOutput;
}

function findCompletedTaskIds(session: SessionState | null, tasks: PlanTask[]): Set<string> {
  if (!session) return new Set();
  const taskIds = new Set(tasks.map((t) => t.id));
  const completed = new Set<string>();
  for (const artifact of session.artifacts) {
    if (artifact.kind !== "run" || !artifact.taskId) continue;
    if (!taskIds.has(artifact.taskId)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(artifact.path, "utf8"));
      const parsed = RunOutput.safeParse(raw);
      if (parsed.success && parsed.data.status === "completed") {
        completed.add(artifact.taskId);
      }
    } catch {
      // artifact missing or unreadable — treat as not completed
    }
  }
  return completed;
}

export async function runAutoLoop(
  plan: ReturnType<typeof PlanOutput.parse>,
  provider: ModelProvider,
  model: string,
  opts: RunOpts,
  session: SessionState | null,
  harness: ExecutionHarness | null = null,
  useTools = true,
): Promise<void> {
  const { tasks } = plan;
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxTasks = opts.maxTasks ?? DEFAULT_MAX_TASKS;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const state = new Map<string, TaskStatus>(tasks.map((t) => [t.id, "pending"]));

  // Resume detection: si la sesión tiene runs completed previos, ofrecer skip
  const previouslyDone = findCompletedTaskIds(session, tasks);
  if (previouslyDone.size > 0) {
    const sortedIds = [...previouslyDone].sort((a, b) =>
      Number(a.slice(1)) - Number(b.slice(1)),
    );
    console.log(
      kleur.dim(
        `  Tareas ya completadas en esta sesión: ${kleur.cyan(sortedIds.join(", "))}`,
      ),
    );

    if (opts.nonInteractive) {
      // Auto-resume en modo no-interactivo
      log.dim("  auto: resumiendo desde la siguiente pendiente");
      for (const id of previouslyDone) state.set(id, "done");
    } else {
      const action = await select({
        message: "¿Cómo querés seguir?",
        choices: [
          { name: "Resumir desde la siguiente pendiente (skip las completadas)", value: "resume" as const },
          { name: "Empezar de cero (re-ejecutar todo)", value: "fresh" as const },
        ],
        default: "resume",
      });
      if (action === "resume") {
        for (const id of previouslyDone) state.set(id, "done");
      }
    }
  }

  const taskReports: TaskReport[] = [];
  let executions = 0;
  let currentSession = session;

  // Pre-mark tasks whose initial deps are already skipped/failed
  let pending = true;
  while (pending) {
    pending = false;
    for (const t of tasks) {
      if ((state.get(t.id) ?? "pending") === "pending") {
        const blockedDep = t.dependsOn.find((d) => {
          const s = state.get(d) ?? "pending";
          return s === "skipped" || s === "failed";
        });
        if (blockedDep) {
          state.set(t.id, "skipped");
          pending = true;
        }
      }
    }
  }

  console.log("");
  console.log(kleur.bold("Plan") + kleur.dim(` · ${tasks.length} tareas`));
  tasks.forEach((t) => {
    const deps = t.dependsOn.length ? kleur.dim(` ← ${t.dependsOn.join(", ")}`) : "";
    console.log(`  ${kleur.dim(t.id)} ${t.title}${deps}`);
  });
  console.log("");

  while (executions < maxTasks) {
    const task = nextRunnableTask(tasks, state);
    if (!task) break;

    const sessionCtx = currentSession ? sessionContextBlock(currentSession) : "";
    const taskStart = Date.now();
    const gitBefore = gitStatusSnapshot();

    let result: TaskResult;
    try {
      result = await executeTask(
        task,
        plan,
        provider,
        model,
        maxRounds,
        sessionCtx,
        path.join(process.cwd(), "runs"),
        harness,
        useTools,
        { scratchpad: opts.scratchpad, onUsage: opts.onUsage },
      );
    } catch (err) {
      if (err instanceof SladError) {
        log.error(`Error ejecutando ${task.id}: ${err.message}`, err);
        log.debug("Error context", err.context);
      } else {
        log.error(`Error ejecutando ${task.id}: ${(err as Error).message}`);
      }
      printNewChanges(gitBefore, task.id);
      state.set(task.id, "failed");
      taskReports.push({ taskId: task.id, title: task.title, status: "failed", durationMs: Date.now() - taskStart });
      executions++;

      if (opts.nonInteractive) {
        // Auto-skip en modo no-interactivo
        log.dim(`  auto: skip ${task.id} (error de ejecución)`);
        const cascaded = autoSkipDependents(tasks, state, task.id);
        if (cascaded.length) log.dim(`  Auto-skip dependientes: ${cascaded.join(", ")}`);
        continue;
      }

      const exceptionAction = await askFailAction(task.id, "failed");
      if (exceptionAction === "abort") break;
      if (exceptionAction === "skip") {
        const cascaded = autoSkipDependents(tasks, state, task.id);
        if (cascaded.length) log.dim(`  Auto-skip dependientes: ${cascaded.join(", ")}`);
      }
      continue;
    }

    printNewChanges(gitBefore, task.id);

    executions++;
    const durationMs = Date.now() - taskStart;
    const { output, outPath, humanAnswers } = result;

    if (currentSession) {
      let updated = appendArtifact(currentSession, "run", outPath, task.id);
      if (Object.keys(humanAnswers).length > 0) {
        updated = appendAnswers(updated, task.id, humanAnswers);
      }
      saveSession(updated);
      currentSession = updated;
    }

    if (output.status === "completed") {
      state.set(task.id, "done");
      taskReports.push({ taskId: task.id, title: task.title, status: "done", durationMs, output });
    } else {
      state.set(task.id, output.status === "failed" ? "failed" : "failed");
      taskReports.push({ taskId: task.id, title: task.title, status: "failed", durationMs, output });

      if (opts.nonInteractive) {
        // Auto-skip en modo no-interactivo: no preguntar retry/skip/abort
        log.dim(`  auto: skip ${task.id} (${output.status})`);
        const cascaded = autoSkipDependents(tasks, state, task.id);
        if (cascaded.length) log.dim(`  Auto-skip dependientes: ${cascaded.join(", ")}`);
        continue;
      }

      let action = await askFailAction(task.id, output.status, output);

      if (action === "followup") {
        const fuText = await selectFollowUp(output.followUps);
        const fuTask = buildFollowUpTask(fuText, task, plan);
        console.log(kleur.dim(`\n  Ejecutando follow-up como ${fuTask.id}: ${fuTask.title}`));
        const fuSessionCtx = currentSession ? sessionContextBlock(currentSession) : "";
        try {
          const fuResult = await executeTask(
            fuTask,
            plan,
            provider,
            model,
            maxRounds,
            fuSessionCtx,
            path.join(process.cwd(), "runs"),
            harness,
            useTools,
          );
          if (currentSession) {
            const updated = appendArtifact(currentSession, "run", fuResult.outPath, fuTask.id);
            saveSession(updated);
            currentSession = updated;
          }
          log.success(`Follow-up ${fuTask.id} completado. JSON guardado en ${fuResult.outPath}`);
        } catch (err) {
          log.error(`Follow-up ${fuTask.id} falló: ${(err as Error).message}`);
        }
        // Re-ask without the followup option (para no entrar en loop infinito)
        action = await askFailAction(task.id, output.status);
      }

      if (action === "retry") {
        state.set(task.id, "pending");
        taskReports.pop();
        continue;
      }
      if (action === "abort") break;
      // skip
      const cascaded = autoSkipDependents(tasks, state, task.id);
      if (cascaded.length) log.dim(`  Auto-skip dependientes: ${cascaded.join(", ")}`);
    }
  }

  // Remaining pending tasks that couldn't run (blocked by failed deps or budget)
  for (const t of tasks) {
    if ((state.get(t.id) ?? "pending") === "pending") {
      state.set(t.id, "skipped");
      taskReports.push({
        taskId: t.id,
        title: t.title,
        status: "skipped",
        skippedReason: "dependency",
        durationMs: 0,
      });
    }
  }

  // Aggregate skipped (already in state but not yet in reports from auto-skip)
  for (const t of tasks) {
    if (state.get(t.id) === "skipped" && !taskReports.find((r) => r.taskId === t.id)) {
      taskReports.push({
        taskId: t.id,
        title: t.title,
        status: "skipped",
        skippedReason: "dependency",
        durationMs: 0,
      });
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;
  const summary = {
    total: tasks.length,
    completed: taskReports.filter((r) => r.status === "done").length,
    skipped: taskReports.filter((r) => r.status === "skipped").length,
    failed: taskReports.filter((r) => r.status === "failed").length,
  };

  const autoReport = { planSnapshot: plan.snapshot, startedAt, completedAt, durationMs, summary, taskReports };
  const autoPath = path.join(process.cwd(), "runs", `${timestamp()}-auto.json`);
  fs.mkdirSync(path.dirname(autoPath), { recursive: true });
  fs.writeFileSync(autoPath, JSON.stringify(autoReport, null, 2) + "\n", "utf8");

  printAutoSummary(summary, durationMs, executions >= maxTasks);
  log.success(`Reporte guardado en ${autoPath}`);

  if (executions >= maxTasks) {
    log.warn(`Budget de ${maxTasks} ejecuciones agotado. Usá --max-tasks N para ampliar.`);
  }
}

type FailAction = "retry" | "skip" | "abort" | "followup";

async function askFailAction(
  taskId: string,
  status: string,
  output?: RunOutput,
): Promise<FailAction> {
  console.log("");
  type Choice = { name: string; value: FailAction };
  const choices: Choice[] = [
    { name: "Saltar esta tarea (y sus dependientes)", value: "skip" },
    { name: "Reintentar", value: "retry" },
    { name: "Abortar el loop", value: "abort" },
  ];
  if (output?.followUps.length) {
    choices.unshift({
      name: `Ejecutar un follow-up (${output.followUps.length} disponible${output.followUps.length > 1 ? "s" : ""})`,
      value: "followup",
    });
  }
  return select({
    message: `Tarea ${taskId} → ${kleur.red(status)}. ¿Qué hacemos?`,
    choices,
  });
}

async function selectFollowUp(followUps: string[]): Promise<string> {
  return select({
    message: "Seleccioná el follow-up a ejecutar:",
    choices: followUps.map((fu, i) => ({
      name: fu,
      value: fu,
      short: `FU${i + 1}`,
    })),
  });
}

function generateFollowUpTaskId(plan: ReturnType<typeof PlanOutput.parse>): string {
  const nums = plan.tasks
    .map((t) => parseInt(t.id.slice(1)))
    .filter((n) => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `T${max + 1}`;
}

function buildFollowUpTask(
  followUpText: string,
  parentTask: PlanTask,
  plan: ReturnType<typeof PlanOutput.parse>,
): PlanTask {
  const title =
    followUpText.length > 80 ? followUpText.slice(0, 77) + "..." : followUpText;
  return {
    id: generateFollowUpTaskId(plan),
    title,
    description: `Follow-up de ${parentTask.id}: ${followUpText}`,
    type: "implementation",
    priority: "high",
    dependsOn: [],
    files: parentTask.files,
    acceptanceCriteria: [followUpText],
  };
}

function printAutoSummary(
  summary: { total: number; completed: number; skipped: number; failed: number },
  durationMs: number,
  budgetExhausted: boolean,
): void {
  const secs = (durationMs / 1000).toFixed(1);
  console.log("");
  const parts = [
    kleur.green(`${summary.completed} completadas`),
    summary.skipped ? kleur.yellow(`${summary.skipped} saltadas`) : null,
    summary.failed ? kleur.red(`${summary.failed} fallidas`) : null,
    kleur.dim(`${secs}s`),
  ].filter(Boolean);
  console.log(kleur.bold(budgetExhausted ? "⚠ Loop pausado" : "✓ Loop completado") + " · " + parts.join(" · "));
}

// ─── print single-task result ─────────────────────────────────────────────────

function printSingleResult(output: RunOutput, humanAnswers: Record<string, string>): void {
  console.log("");
  console.log(kleur.bold("Status"));
  console.log("  " + output.status);
  console.log("\n" + kleur.bold("Summary"));
  console.log("  " + output.summary);

  if (Object.keys(humanAnswers).length) {
    console.log("\n" + kleur.bold("Decisiones HITL"));
    Object.entries(humanAnswers).forEach(([id, val]) => console.log(`  · ${id}: ${val}`));
  }
  if (output.changedFiles.length) {
    console.log("\n" + kleur.bold("Changed Files"));
    output.changedFiles.forEach((f) => console.log("  · " + f));
  }
  if (output.verification.length) {
    console.log("\n" + kleur.bold("Verification"));
    output.verification.forEach((c) => console.log(`  · ${c.status} · ${c.command} — ${c.notes}`));
  }
  if (output.followUps.length) {
    console.log("\n" + kleur.bold("Follow-ups"));
    output.followUps.forEach((i) => console.log("  · " + i));
  }
}

// ─── main command ─────────────────────────────────────────────────────────────

export async function runCommand(opts: RunOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();
  const planInput = opts.input ?? (session ? lastArtifactPath(session, "plan") : undefined);
  if (!opts.input && session && planInput) log.dim(`  sesión: usando plan en ${planInput}`);

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider);
  const apiKey = getApiKey(providerName);

  if (providerName !== "cli" && !apiKey) {
    log.error(`No se encontró API key para ${providerName}. Define la variable de entorno correspondiente.`);
    process.exit(1);
  }

  let plan: ReturnType<typeof PlanOutput.parse>;
  try {
    plan = readPlan(planInput);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getProvider(providerName, apiKey ?? undefined);

  log.title(`Run · ${providerName}${model ? ` · ${model}` : ""}`);

  // ── Initialize harness if enabled ──
  const harnessMode = opts.harness ?? "off";
  const harness =
    harnessMode !== "off"
      ? await createHarness(loadHarnessConfig(harnessMode))
      : null;

  if (harness) {
    log.dim(`  harness: ${harnessMode}`);
  }

  if (opts.auto) {
    try {
      await runAutoLoop(plan, provider, model, opts, session, harness, opts.tools !== false);
    } finally {
      await harness?.flush();
    }
    return;
  }

  // ── single-task mode ──
  let task: PlanTask;
  try {
    task = pickTask(plan, opts.task);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
  log.dim(`task: ${task.id} · ${task.title}`);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const gitBefore = gitStatusSnapshot();
  let result: TaskResult;
  try {
    result = await executeTask(
      task,
      plan,
      provider,
      model,
      opts.maxRounds ?? DEFAULT_MAX_ROUNDS,
      sessionCtx,
      path.join(process.cwd(), "runs"),
      harness,
      opts.tools !== false,
    );
  } catch (err) {
    printNewChanges(gitBefore, task.id);
    log.error((err as Error).message);
    await harness?.flush(); // flush before exit since finally won't run after process.exit
    process.exit(1);
  }

  printNewChanges(gitBefore, task.id);

  let { output, outPath, humanAnswers } = result;

  if (opts.json && !opts.output) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (!opts.json) printSingleResult(output, humanAnswers);

  const finalPath = opts.output ?? outPath;
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(outPath, opts.output);
  }
  log.success(`JSON guardado en ${finalPath}`);

  let currentSession = session;
  if (currentSession) {
    let updated = appendArtifact(currentSession, "run", finalPath, task.id);
    if (Object.keys(humanAnswers).length > 0) {
      updated = appendAnswers(updated, task.id, humanAnswers);
    }
    saveSession(updated);
    currentSession = updated;
    log.dim(`  sesión: ${currentSession.id}`);
  }

  // ── Follow-up execution (single-task mode) ──
  if (!opts.json && output.followUps.length > 0) {
    let keepRunning = true;
    while (keepRunning) {
      const fuText = await selectFollowUp([
        ...output.followUps,
        kleur.dim("─ Salir"),
      ]);
      if (fuText === kleur.dim("─ Salir")) break;

      const fuTask = buildFollowUpTask(fuText, task, plan);
      console.log(kleur.dim(`\n  Ejecutando follow-up como ${fuTask.id}: ${fuTask.title}`));
      const fuSessionCtx = currentSession ? sessionContextBlock(currentSession) : "";
      try {
        const fuResult = await executeTask(
          fuTask,
          plan,
          provider,
          model,
          opts.maxRounds ?? DEFAULT_MAX_ROUNDS,
          fuSessionCtx,
          path.join(process.cwd(), "runs"),
          harness,
          opts.tools !== false,
        );
        if (currentSession) {
          const updated = appendArtifact(currentSession, "run", fuResult.outPath, fuTask.id);
          saveSession(updated);
          currentSession = updated;
        }
        printSingleResult(fuResult.output, fuResult.humanAnswers);
        log.success(`Follow-up ${fuTask.id} guardado en ${fuResult.outPath}`);
        // Si el follow-up tuvo sus propios follow-ups, ofrecerlos también
        if (fuResult.output.followUps.length > 0) {
          output = { ...fuResult.output };
        } else {
          keepRunning = false;
        }
      } catch (err) {
        log.error(`Follow-up ${fuTask.id} falló: ${(err as Error).message}`);
        keepRunning = false;
      }
    }
  }

  await harness?.flush();
}
