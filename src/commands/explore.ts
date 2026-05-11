import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getProvider } from "../models/index.js";
import { EXPLORER_SYSTEM } from "../agents/prompts.js";
import { ExploreOutput, type ChatMessage } from "../core/types.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { log } from "../core/logger.js";
import { SchemaError } from "../core/errors.js";
import { getActiveSession, appendArtifact, saveSession } from "../core/session.js";
import { writeArtifact } from "../persistence/index.js";
import { readWikiContextCached } from "../agents/explorer.js";
import { hashStructured, hashText, readOrCreateReusableValue } from "../cache/reusable.js";
import { projectContextBlock } from "../core/context.js";

export interface ExploreOpts {
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

function parseExploreOutput(raw: string): ReturnType<typeof ExploreOutput.parse> {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = ExploreOutput.safeParse(parsed);
  if (!result.success) {
    throw new SchemaError(
      "Explorer output no pasa el schema",
      jsonText,
      result.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`),
      "explore",
    );
  }
  return result.data;
}

export async function generateExploreOutput(options: {
  intent: string;
  provider: Awaited<ReturnType<typeof getProvider>>;
  providerName: string;
  model?: string;
  wikiPath?: string;
  cwd?: string;
  cacheRootDir?: string;
  /** Token usage callback — llamado después de cada API call */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}): Promise<{
  value: ReturnType<typeof ExploreOutput.parse>;
  cacheStatus: "hit" | "miss";
  userContent: string;
}> {
  const wikiContext = await readWikiContextCached(options.wikiPath, {
    cwd: options.cwd,
    cacheRootDir: options.cacheRootDir,
  });
  const projectCtx = projectContextBlock(options.cwd);
  const userContent = [
    wikiContext.text ? `Contexto de la wiki del usuario (solo referencia):\n\n${wikiContext.text}\n\n---\n` : "",
    projectCtx,
    `Intención del usuario:\n${options.intent}`,
  ].filter(Boolean).join("\n\n");

  const result = await readOrCreateReusableValue({
    cwd: options.cwd,
    rootDir: options.cacheRootDir,
    objectType: "agent_outputs",
    snapshotHash: hashText(userContent),
    inputSignature: hashStructured({
      command: "explore",
      intent: options.intent,
      wikiPath: options.wikiPath ? path.resolve(options.wikiPath) : null,
    }),
    runtimeVersion: hashStructured({
      command: "explore",
      model: options.model ?? "",
      prompt: EXPLORER_SYSTEM,
      provider: options.providerName,
    }),
    producer: async () => {
      const raw = await options.provider.complete(
        [{ role: "user", content: userContent }],
        {
          systemPrompt: EXPLORER_SYSTEM,
          temperature: 0.5,
          maxTokens: 2048,
          model: options.model,
          onUsage: options.onUsage,
        },
      );
      return parseExploreOutput(raw);
    },
    isCacheable: (output) => output.status === "completed",
  });

  return { ...result, userContent };
}

export async function exploreCommand(intent: string, opts: ExploreOpts): Promise<void> {
  if (!intent || intent.trim().length < 3) {
    log.error('Intención vacía. Uso: slad explore "<tu intención>"');
    process.exit(1);
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

  const model = opts.model ?? getModel(providerName);
  const provider = await getProvider(providerName, apiKey ?? undefined);

  log.title(`Explorer · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`intent: ${intent}`);
  const messages: ChatMessage[] = [];
  const maxRounds = 3;
  let output!: ReturnType<typeof ExploreOutput.parse>;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Explorando el espacio de soluciones...").start();

  while (rounds <= maxRounds) {
    try {
      if (rounds === 0) {
        const result = await generateExploreOutput({
          intent,
          provider,
          providerName,
          model,
          wikiPath: config.wikiPath,
        });
        output = result.value;
        raw = JSON.stringify(output);
        messages.push({ role: "user", content: result.userContent });
      } else {
        raw = await provider.complete(messages, {
          systemPrompt: EXPLORER_SYSTEM,
          temperature: 0.5,
          maxTokens: 2048,
          model,
        });
        output = parseExploreOutput(raw);
      }
    } catch (err) {
      spinner.fail("Falló la exploración");
      log.error((err as Error).message);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Exploración completada");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Explorer · max rounds HITL alcanzado");
      break;
    }

    spinner.stop();
    printHitlHeader("Explorer", "", rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  console.log("");
  console.log(kleur.bold("Reframing"));
  console.log("  " + output.reframing);

  console.log("\n" + kleur.bold("Approaches"));
  output.approaches.forEach((a, i) => {
    console.log(kleur.cyan(`\n  ${i + 1}. ${a.name}`));
    console.log("     " + a.summary);
    a.pros.forEach((p) => console.log(kleur.green("     + ") + p));
    a.cons.forEach((c) => console.log(kleur.red("     − ") + c));
  });

  if (output.risks.length) {
    console.log("\n" + kleur.bold("Risks"));
    output.risks.forEach((r) => console.log("  · " + r));
  }

  if (output.openQuestions.length) {
    console.log("\n" + kleur.bold("Open Questions"));
    output.openQuestions.forEach((q) => console.log("  ? " + q));
  }

  console.log("\n" + kleur.bold("Recommended Next"));
  console.log("  → " + output.recommendedNext);

  const session = opts.skipSession ? null : getActiveSession();

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (session) {
    const ref = await writeArtifact("explore", output, { sessionId: session.id });
    saveSession(appendArtifact(session, "explore", ref.path));
    log.success(`Guardado en ${ref.path}`);
    log.dim(`  sesión: ${session.id}`);
  } else if (opts.output) {
    const ref = await writeArtifact("explore", output, { sessionId: "adhoc" });
    log.warn("--output para explore está deprecado; se escribió en la persistencia MD+YAML.");
    log.success(`Guardado en ${ref.path}`);
  }
}
