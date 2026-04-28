import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getProvider } from "../models/index.js";
import { ExploreOutput, SnapshotOutput, type ChatMessage } from "../core/types.js";
import { SNAPSHOT_SYSTEM } from "../agents/prompts.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { log } from "../core/logger.js";
import {
  getActiveSession,
  lastArtifactPath,
  appendArtifact,
  saveSession,
  sessionContextBlock,
} from "../core/session.js";

export interface SnapshotOpts {
  input?: string;
  intent?: string;
  approach?: string;
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  skipSession?: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return body.trim();
  return body.slice(first, last + 1).trim();
}

function parseSnapshotOutput(raw: string): ReturnType<typeof SnapshotOutput.parse> {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText);
  const result = SnapshotOutput.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")} — ${i.message}`).join("\n");
    throw new Error(`Snapshot output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);
  }
  return result.data;
}

function buildUserContent(opts: SnapshotOpts, sessionCtx: string): { content: string; title: string } {
  if (opts.input) {
    const abs = path.resolve(opts.input);
    if (!fs.existsSync(abs)) throw new Error(`No existe el archivo: ${abs}`);
    const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    const parsed = ExploreOutput.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`El archivo no sigue el schema de ExploreOutput:\n${parsed.error.message}`);
    }
    const exp = parsed.data;

    const chosen = opts.approach
      ? exp.approaches.find((a) => a.name.toLowerCase().includes(opts.approach!.toLowerCase()))
      : exp.approaches[0];

    const parts = [
      `Intent original:\n${exp.intent}`,
      `Reframing:\n${exp.reframing}`,
      chosen
        ? `Enfoque elegido — ${chosen.name}:\n${chosen.summary}\nPros: ${chosen.pros.join("; ")}\nCons: ${chosen.cons.join("; ")}`
        : "",
      exp.risks.length ? `Riesgos conocidos:\n- ${exp.risks.join("\n- ")}` : "",
      exp.openQuestions.length ? `Preguntas abiertas:\n- ${exp.openQuestions.join("\n- ")}` : "",
      `Next step sugerido: ${exp.recommendedNext}`,
      sessionCtx,
    ].filter(Boolean);

    return { content: parts.join("\n\n"), title: exp.intent };
  }

  if (opts.intent) {
    const content = sessionCtx
      ? `Intención: ${opts.intent}\n\n${sessionCtx}`
      : `Intención: ${opts.intent}`;
    return { content, title: opts.intent };
  }

  throw new Error(
    "Necesitas --input <explore.json>, --intent \"<texto>\", o una sesión activa con explore completado.",
  );
}

export async function snapshotCommand(opts: SnapshotOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();

  if (!opts.input && !opts.intent && session) {
    const explorePath = lastArtifactPath(session, "explore");
    if (explorePath) {
      opts = { ...opts, input: explorePath };
      log.dim(`  sesión: usando explore en ${explorePath}`);
    }
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

  const sessionCtx = session ? sessionContextBlock(session) : "";
  let userPayload: { content: string; title: string };
  try {
    userPayload = buildUserContent(opts, sessionCtx);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  log.title(`Snapshot · ${providerName}${model ? ` · ${model}` : ""}`);

  const messages: ChatMessage[] = [{ role: "user", content: userPayload.content }];
  const maxRounds = 3;
  let output!: ReturnType<typeof SnapshotOutput.parse>;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Generando snapshot...").start();

  while (rounds <= maxRounds) {
    try {
      raw = await provider.complete(messages, {
        systemPrompt: SNAPSHOT_SYSTEM,
        temperature: 0.3,
        maxTokens: 1500,
        model,
      });
    } catch (err) {
      spinner.fail("Falló la generación del snapshot");
      log.error((err as Error).message);
      process.exit(1);
    }

    try {
      output = parseSnapshotOutput(raw);
    } catch (err) {
      spinner.fail("Output del snapshot inválido");
      log.error((err as Error).message);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Snapshot listo");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Snapshot · max rounds HITL alcanzado");
      break;
    }

    spinner.stop();
    printHitlHeader("Snapshot", "", rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  const markdown = output.content.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim();

  const outPath =
    opts.output ??
    path.join(
      process.cwd(),
      "snapshots",
      `${new Date().toISOString().slice(0, 10)}-${slugify(userPayload.title)}.md`,
    );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown + "\n", "utf8");
  log.success(`Guardado en ${outPath}`);

  if (session) {
    saveSession(appendArtifact(session, "snapshot", outPath));
    log.dim(`  sesión: ${session.id}`);
  }
}
