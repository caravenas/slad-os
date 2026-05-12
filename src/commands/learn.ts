import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { LEARN_SYSTEM } from "../agents/prompts.js";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { LearnOutput, RunOutput, type ChatMessage, type SessionState } from "../core/types.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { projectContextBlock } from "../core/context.js";
import { SchemaError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { getProvider, type ModelProvider } from "../models/index.js";
import { listArtifacts, readArtifact, writeArtifact } from "../persistence/index.js";
import { artifactDirSync, resetDocsRootCache } from "../persistence/layout.js";
import {
  getActiveSession,
  upsertArtifact,
  saveSession,
  sessionContextBlock,
} from "../core/session.js";

export interface LearnOpts {
  input?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  json?: boolean;
  skipSession?: boolean;
  modelProvider?: ModelProvider;
  cwd?: string;
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

function zodIssueMessages(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string[] {
  return error.issues.map((issue) => `${issue.path.join(".")} — ${issue.message}`);
}

function parseLearnOutput(raw: string): LearnOutput {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = LearnOutput.safeParse(parsed);
  if (!result.success) {
    throw new SchemaError(
      "Learn output no pasa el schema",
      jsonText,
      zodIssueMessages(result.error),
      "learn",
    );
  }
  return result.data;
}

function forceSyntheticLearnIdentity(output: LearnOutput): LearnOutput {
  const synthetic = {
    ...output,
    sourceRun: "session",
    taskId: "all",
  };
  const result = LearnOutput.safeParse(synthetic);
  if (!result.success) {
    throw new SchemaError(
      "Learn output sintético no pasa el schema",
      JSON.stringify(synthetic, null, 2),
      zodIssueMessages(result.error),
      "learn",
    );
  }
  return result.data;
}

// ─── Pure generator (sin UI) ──────────────────────────────────────────────────

export interface GenerateLearnOpts {
  /** Path al run report .md/JSON legacy o al directorio de runs (usa el más reciente) */
  runPath: string;
  provider: Awaited<ReturnType<typeof getProvider>>;
  model?: string;
  cwd?: string;
  /** Token usage callback */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/**
 * Genera un LearnOutput a partir de un run report.
 * Función pura: sin spinners ni console.log, sin HITL interactivo.
 */
export async function generateLearnOutput(opts: GenerateLearnOpts): Promise<LearnOutput> {
  // Resolve: si runPath es un directorio, usar el json más reciente
  let resolvedPath = opts.runPath;
  if (fs.existsSync(opts.runPath) && fs.statSync(opts.runPath).isDirectory()) {
    const latest = await latestRunFile(opts.runPath);
    if (!latest) throw new Error(`No hay run reports en ${opts.runPath}`);
    resolvedPath = latest;
  }

  const run = await readRun(resolvedPath);
  const projectCtx = projectContextBlock(opts.cwd);

  const userContent = [
    projectCtx,
    `Source run path:\n${run.source}`,
    `Run report:\n${JSON.stringify(run.content, null, 2)}`,
  ].filter(Boolean).join("\n\n");

  const raw = await opts.provider.complete(
    [{ role: "user", content: userContent }],
    {
      systemPrompt: LEARN_SYSTEM,
      temperature: 0.2,
      maxTokens: 2200,
      model: opts.model,
      onUsage: opts.onUsage,
    },
  );

  return parseLearnOutput(raw);
}

function latestLegacyJsonFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    // Excluir auto reports y auto-report (no son RunOutput individuales)
    .filter((file) => !/-auto\.json$/.test(file) && !/-auto-report\.json$/.test(file))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

function latestJsonRunFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json") && !/-auto\.json$/.test(file) && !/-auto-report\.json$/.test(file))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

async function latestRunFile(dir: string, cwd = process.cwd()): Promise<string | null> {
  const legacy = latestLegacyJsonFile(dir);
  if (legacy) return legacy;

  const localJson = latestJsonRunFile(dir);
  if (localJson) return localJson;

  const cwdJson = latestJsonRunFile(artifactDirSync("run", cwd));
  if (cwdJson) return cwdJson;

  const refs = await listArtifacts("run");
  return refs
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((ref) => fs.existsSync(ref.path))?.path ?? null;
}

function resolveRunPath(candidate: string, cwd: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

async function readRun(
  input: string | undefined,
  sessionRunPath?: string,
  cwd = process.cwd(),
): Promise<{ source: string; content: RunOutput }> {
  let candidate =
    input ??
    sessionRunPath ??
    await latestRunFile(path.join(cwd, "runs"), cwd) ??
    "";

  if (candidate) candidate = resolveRunPath(candidate, cwd);

  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    candidate = await latestRunFile(candidate, cwd) ?? "";
  }

  const runPath = candidate ? resolveRunPath(candidate, cwd) : "";
  if (!runPath || !fs.existsSync(runPath)) {
    throw new Error("No existe un run report. Usa --input <run.md|run.json> o corre `slad run` primero.");
  }

  const { value } = await readArtifact("run", runPath);
  return { source: runPath, content: value };
}

async function readSessionRuns(
  session: SessionState,
  cwd = process.cwd(),
): Promise<Array<{ source: string; content: RunOutput }>> {
  const runArtifacts = session.artifacts.filter((artifact) => artifact.kind === "run");
  if (runArtifacts.length === 0) {
    throw new Error("La sesión activa no tiene artifacts run. Corre `slad run` primero.");
  }

  const runs: Array<{ source: string; content: RunOutput }> = [];
  for (const artifact of runArtifacts) {
    runs.push(await readRun(artifact.path, undefined, cwd));
  }
  return runs;
}

function formatRunsForPrompt(runs: Array<{ source: string; content: RunOutput }>): string {
  return runs
    .map((run, index) => [
      `Run ${index + 1}`,
      `Source run path:\n${run.source}`,
      `Run report:\n${JSON.stringify(run.content, null, 2)}`,
    ].join("\n\n"))
    .join("\n\n---\n\n");
}

function resolveArtifactPath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function removePreviousLearnArtifacts(session: SessionState, taskId: string, cwd: string): void {
  const paths = new Set(
    session.artifacts
      .filter((artifact) => artifact.kind === "learn")
      .map((artifact) => resolveArtifactPath(artifact.path, cwd)),
  );
  paths.add(path.join(artifactDirSync("learn", cwd), `${session.id}_${taskId}.json`));

  for (const filePath of paths) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  }
}

async function writeLearnArtifact(output: LearnOutput, sessionId: string, cwd: string) {
  const previousCwd = process.cwd();
  try {
    resetDocsRootCache();
    if (previousCwd !== cwd) process.chdir(cwd);
    return await writeArtifact("learn", output, { sessionId });
  } finally {
    if (previousCwd !== cwd) process.chdir(previousCwd);
    resetDocsRootCache();
  }
}

export async function learnCommand(opts: LearnOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const session = opts.skipSession ? null : getActiveSession(cwd);

  if (!opts.input && session) {
    const count = session.artifacts.filter((artifact) => artifact.kind === "run").length;
    if (count > 0) log.dim(`  sesión: usando ${count} run${count === 1 ? "" : "s"}`);
  }

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider);
  const apiKey = opts.modelProvider ? null : getApiKey(providerName);

  if (!opts.modelProvider && providerName !== "cli" && !apiKey) {
    log.error(
      `No se encontró API key para ${providerName}. Define la variable de entorno correspondiente.`,
    );
    process.exit(1);
  }

  let runs: Array<{ source: string; content: RunOutput }>;
  try {
    runs = !opts.input && session
      ? await readSessionRuns(session, cwd)
      : [await readRun(opts.input, undefined, cwd)];
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = opts.modelProvider ?? await getProvider(providerName, apiKey ?? undefined);

  log.title(`Learn · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(runs.length === 1 ? `run: ${runs[0].source}` : `runs: ${runs.length}`);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const userContent = [
    projectContextBlock(cwd),
    `Runs consolidados (${runs.length}) en orden estable de SessionState. Incluye todos los artifacts run de la sesión, sin filtrar por status.`,
    formatRunsForPrompt(runs),
    sessionCtx,
  ].filter(Boolean).join("\n\n");

  const messages: ChatMessage[] = [{ role: "user", content: userContent }];
  const maxRounds = 3;
  let output!: LearnOutput;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Capturando aprendizajes...").start();

  while (rounds <= maxRounds) {
    try {
      raw = await provider.complete(messages, {
        systemPrompt: LEARN_SYSTEM,
        temperature: 0.2,
        maxTokens: 2200,
        model,
      });
    } catch (err) {
      spinner.fail("Falló la captura de aprendizajes");
      log.error((err as Error).message);
      process.exit(1);
    }

    try {
      const parsedOutput = parseLearnOutput(raw);
      output = !opts.input && session
        ? forceSyntheticLearnIdentity(parsedOutput)
        : parsedOutput;
    } catch (err) {
      spinner.fail("Falló la validación de aprendizajes");
      log.error((err as Error).message);
      log.dim(`Respuesta cruda:\n${raw}`);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Aprendizajes listos");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Learn · max rounds HITL alcanzado");
      break;
    }

    spinner.stop();
    printHitlHeader("Learn", output.summary, rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  if (opts.json && !opts.output) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (!opts.json) {
    console.log("");
    console.log(kleur.bold("Summary"));
    console.log("  " + output.summary);
    if (output.openQuestions.length) {
      console.log("\n" + kleur.bold("Open Questions"));
      output.openQuestions.forEach((question) => console.log("  ? " + question));
    }
  }

  if (session) {
    removePreviousLearnArtifacts(session, output.taskId, cwd);
    const ref = await writeLearnArtifact(output, session.id, cwd);
    saveSession(upsertArtifact(session, "learn", ref.path, output.taskId), cwd);
    log.success(`Guardado en ${ref.path}`);
    log.dim(`  sesión: ${session.id}`);
  } else {
    const ref = await writeLearnArtifact(output, "adhoc", cwd);
    if (opts.output) log.warn("--output para learn está deprecado; se escribió en la persistencia MD+YAML.");
    log.success(`Guardado en ${ref.path}`);
  }
}
