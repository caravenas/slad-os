import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { LEARN_SYSTEM } from "../agents/prompts.js";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { LearnOutput, RunOutput, type ChatMessage } from "../core/types.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { projectContextBlock } from "../core/context.js";
import { log } from "../core/logger.js";
import { getProvider } from "../models/index.js";
import {
  getActiveSession,
  lastArtifactPath,
  appendArtifact,
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
}

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

function latestJsonFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

function readRun(input: string | undefined, sessionRunPath?: string): { source: string; content: RunOutput } {
  const runPath = path.resolve(
    input ??
    sessionRunPath ??
    latestJsonFile(path.join(process.cwd(), "runs")) ??
    "",
  );
  if (!runPath || !fs.existsSync(runPath)) {
    throw new Error("No existe un run report. Usa --input <runs/run.json> o corre `slad run` primero.");
  }
  const raw = JSON.parse(fs.readFileSync(runPath, "utf8"));
  return { source: runPath, content: RunOutput.parse(raw) };
}

function renderLearning(output: LearnOutput): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- None");
  return [
    `# ${output.wikiEntryTitle}`,
    "",
    `Source run: ${output.sourceRun}`,
    `Task: ${output.taskId}`,
    "",
    "## Summary",
    output.summary,
    "",
    "## Decisions",
    list(output.decisions),
    "",
    "## Errors / Blockers",
    list(output.errors),
    "",
    "## Patterns",
    list(output.patterns),
    "",
    "## Open Questions",
    list(output.openQuestions),
    "",
    "## Follow-ups",
    list(output.followUps),
    "",
  ].join("\n");
}

export async function learnCommand(opts: LearnOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();
  const sessionRunPath = session ? lastArtifactPath(session, "run") : undefined;

  if (!opts.input && sessionRunPath) {
    log.dim(`  sesión: usando run en ${sessionRunPath}`);
  }

  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider);
  const apiKey = getApiKey(providerName);

  if (providerName !== "cli" && !apiKey) {
    log.error(
      `No se encontró API key para ${providerName}. Define la variable de entorno correspondiente.`,
    );
    process.exit(1);
  }

  let run: { source: string; content: RunOutput };
  try {
    run = readRun(opts.input, sessionRunPath);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getProvider(providerName, apiKey ?? undefined);

  log.title(`Learn · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`run: ${run.source}`);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const userContent = [
    projectContextBlock(),
    `Source run path:\n${run.source}`,
    `Run report:\n${JSON.stringify(run.content, null, 2)}`,
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
      const jsonText = extractJson(raw);
      const parsed = JSON.parse(jsonText);
      const result = LearnOutput.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join(".")} — ${i.message}`).join("\n");
        throw new Error(`Learn output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);
      }
      output = result.data;
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

  const outPath =
    opts.output ?? path.join(process.cwd(), "learnings", `${timestamp()}-${output.taskId}.md`);
  const content = opts.json ? JSON.stringify(output, null, 2) + "\n" : renderLearning(output);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, content, "utf8");
  log.success(`Guardado en ${outPath}`);

  if (session) {
    saveSession(appendArtifact(session, "learn", outPath));
    log.dim(`  sesión: ${session.id}`);
  }
}
