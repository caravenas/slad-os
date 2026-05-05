import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { PlanOutput, type ChatMessage } from "../core/types.js";
import { getProvider } from "../models/index.js";
import { PLANNER_SYSTEM } from "../agents/prompts.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { log } from "../core/logger.js";
import { hashStructured, hashText, readOrCreateReusableValue } from "../cache/reusable.js";
import { projectContextBlock } from "../core/context.js";
import {
  getActiveSession,
  lastArtifactPath,
  appendArtifact,
  saveSession,
  sessionContextBlock,
} from "../core/session.js";

export interface PlanOpts {
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

function readSnapshot(input: string): { content: string; title: string } {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    throw new Error(`No existe el archivo: ${abs}`);
  }
  const content = fs.readFileSync(abs, "utf8");
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(input);
  return { content, title };
}

function parsePlanOutput(raw: string): ReturnType<typeof PlanOutput.parse> {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = PlanOutput.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")} — ${i.message}`).join("\n");
    throw new Error(`Planner output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);
  }
  return result.data;
}

export async function generatePlanOutput(options: {
  snapshotContent: string;
  provider: Awaited<ReturnType<typeof getProvider>>;
  providerName: string;
  model?: string;
  sessionContext?: string;
  cwd?: string;
  cacheRootDir?: string;
}): Promise<{
  value: ReturnType<typeof PlanOutput.parse>;
  cacheStatus: "hit" | "miss";
  userContent: string;
}> {
  const projectCtx = projectContextBlock(options.cwd);
  const userContent = [
    projectCtx,
    `Snapshot:\n\n${options.snapshotContent}`,
    options.sessionContext,
  ].filter(Boolean).join("\n\n");

  const result = await readOrCreateReusableValue({
    cwd: options.cwd,
    rootDir: options.cacheRootDir,
    objectType: "planner",
    snapshotHash: hashText(options.snapshotContent),
    inputSignature: hashStructured({
      command: "plan",
      sessionContext: options.sessionContext ?? "",
    }),
    runtimeVersion: hashStructured({
      command: "plan",
      model: options.model ?? "",
      prompt: PLANNER_SYSTEM,
      provider: options.providerName,
    }),
    producer: async () => {
      const raw = await options.provider.complete([{ role: "user", content: userContent }], {
        systemPrompt: PLANNER_SYSTEM,
        temperature: 0.2,
        maxTokens: 2500,
        model: options.model,
      });
      return parsePlanOutput(raw);
    },
    isCacheable: (output) => output.status === "completed",
  });

  return { ...result, userContent };
}

export async function planCommand(opts: PlanOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();

  // Resolve input from session if not explicit
  const inputPath =
    opts.input ??
    (session ? lastArtifactPath(session, "snapshot") : undefined);

  if (!inputPath) {
    log.error(
      session
        ? "No hay snapshot en la sesión activa. Corré `slad snapshot` primero."
        : "Necesitas --input <snapshot.md>",
    );
    process.exit(1);
  }

  if (!opts.input && session) {
    log.dim(`  sesión: usando snapshot en ${inputPath}`);
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

  let snapshot: { content: string; title: string };
  try {
    snapshot = readSnapshot(inputPath);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const model = opts.model ?? getModel(providerName);
  const provider = await getProvider(providerName, apiKey ?? undefined);

  log.title(`Planner · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`snapshot: ${snapshot.title}`);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const messages: ChatMessage[] = [];
  const maxRounds = 3;
  let output!: ReturnType<typeof PlanOutput.parse>;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Generando plan de tareas...").start();

  while (rounds <= maxRounds) {
    try {
      if (rounds === 0) {
        const result = await generatePlanOutput({
          snapshotContent: snapshot.content,
          provider,
          providerName,
          model,
          sessionContext: sessionCtx,
        });
        output = result.value;
        raw = JSON.stringify(output);
        messages.push({ role: "user", content: result.userContent });
      } else {
        raw = await provider.complete(messages, {
          systemPrompt: PLANNER_SYSTEM,
          temperature: 0.2,
          maxTokens: 2500,
          model,
        });
      }
    } catch (err) {
      spinner.fail("Falló la generación del plan");
      log.error((err as Error).message);
      process.exit(1);
    }

    try {
      output = parsePlanOutput(raw);
    } catch (err) {
      spinner.fail("Falló la validación del plan");
      log.error((err as Error).message);
      log.dim(`Respuesta cruda:\n${raw}`);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Plan listo");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Planner · max rounds HITL alcanzado");
      break;
    }

    spinner.stop();
    printHitlHeader("Planner", output.summary, rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  const json = JSON.stringify(output, null, 2);
  if (opts.json && !opts.output) {
    console.log(json);
    return;
  }

  if (!opts.json) {
    console.log("");
    console.log(kleur.bold("Summary"));
    console.log("  " + output.summary);

    console.log("\n" + kleur.bold("Tasks"));
    output.tasks.forEach((task) => {
      const deps = task.dependsOn.length ? ` deps: ${task.dependsOn.join(", ")}` : "";
      console.log(kleur.cyan(`\n  ${task.id}. ${task.title}`) + kleur.gray(deps));
      console.log("     " + task.description);
      task.acceptanceCriteria.forEach((criterion) => {
        console.log(kleur.green("     ✓ ") + criterion);
      });
    });

    if (output.verification.length) {
      console.log("\n" + kleur.bold("Verification"));
      output.verification.forEach((check) => console.log("  · " + check));
    }

    console.log("\n" + kleur.bold("Recommended First Task"));
    console.log("  → " + output.recommendedFirstTask);
  }

  const outPath = opts.output ?? path.join(process.cwd(), "tasks", "tasks.json");
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, json + "\n", "utf8");
  log.success(`JSON guardado en ${outPath}`);

  if (session) {
    saveSession(appendArtifact(session, "plan", outPath));
    log.dim(`  sesión: ${session.id}`);
  }
}
