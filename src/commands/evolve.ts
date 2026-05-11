import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { EVOLVE_SYSTEM } from "../agents/prompts.js";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { EvolveOutput, type ChatMessage } from "../core/types.js";
import { collectAnswers, formatAnswersForPrompt, printHitlHeader } from "../core/hitl.js";
import { projectContextBlock } from "../core/context.js";
import { log } from "../core/logger.js";
import { getProvider } from "../models/index.js";
import { getActiveSession, appendArtifact, saveSession, sessionContextBlock } from "../core/session.js";
import { writeArtifact } from "../persistence/index.js";
import { getDocsRoot } from "../persistence/layout.js";

export interface EvolveOpts {
  provider?: string;
  agent?: string;
  model?: string;
  output?: string;
  applyWiki?: boolean;
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

function readFiles(dir: string, ext: string, maxFiles: number): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(ext))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, maxFiles)
    .map((file) => `File: ${file}\n\n${fs.readFileSync(file, "utf8")}`);
}

function learnContractContext(): string {
  return [
    "Consolidated learn contract:",
    "- sourceRun=session marks a session-level synthesis, not a filesystem path.",
    "- taskId=all is a valid LearnOutput task id for consolidated session learnings.",
    "- Treat taskId=all as evidence across the session, not as a PlanTask dependency.",
  ].join("\n");
}

async function buildContext(): Promise<string> {
  const docsRoot = await getDocsRoot();
  const logRoot = path.join(docsRoot, "log");
  const sections = [
    ["Snapshots", readFiles(path.join(logRoot, "snapshots"), ".md", 3)],
    ["Plans", readFiles(path.join(logRoot, "plans"), ".md", 2)],
    ["Runs", readFiles(path.join(logRoot, "runs"), ".md", 5)],
    ["Learnings", readFiles(path.join(logRoot, "learnings"), ".md", 5)],
  ];

  return sections
    .map(([title, files]) => {
      const content = files as string[];
      const body = title === "Learnings"
        ? [learnContractContext(), content.length ? content.join("\n\n---\n\n") : "None"].join("\n\n")
        : content.length ? content.join("\n\n---\n\n") : "None";
      return `## ${title}\n\n${body}`;
    })
    .join("\n\n====\n\n");
}

function renderEvolution(output: EvolveOutput): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- None");
  const updates = output.proposedUpdates.length
    ? output.proposedUpdates
        .map((update) =>
          [
            `### ${update.target}`,
            `Change: ${update.changeType}`,
            `Rationale: ${update.rationale}`,
            "",
            "```markdown",
            update.content,
            "```",
          ].join("\n"),
        )
        .join("\n\n")
    : "None";

  return [
    `# ${output.title}`,
    "",
    "## Summary",
    output.summary,
    "",
    "## Proposed Updates",
    updates,
    "",
    "## Pattern Updates",
    list(output.patternUpdates),
    "",
    "## Snapshot Updates",
    list(output.snapshotUpdates),
    "",
    "## Next Actions",
    list(output.nextActions),
    "",
  ].join("\n");
}

function appendWikiUpdate(wikiPath: string, markdown: string): string {
  const outPath = path.join(wikiPath, "slad-os-evolution.md");
  const prefix = fs.existsSync(outPath) ? "\n\n---\n\n" : "";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, prefix + markdown, "utf8");
  return outPath;
}

export async function evolveCommand(opts: EvolveOpts): Promise<void> {
  const session = opts.skipSession ? null : getActiveSession();

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

  log.title(`Evolve · ${providerName}${model ? ` · ${model}` : ""}`);

  const sessionCtx = session ? sessionContextBlock(session) : "";
  const context = [projectContextBlock(), await buildContext(), sessionCtx]
    .filter(Boolean)
    .join("\n\n====\n\n");

  const messages: ChatMessage[] = [{ role: "user", content: context }];
  const maxRounds = 3;
  let output!: EvolveOutput;
  let raw = "";
  let rounds = 0;
  const spinner = ora("Proponiendo evolución de wiki/patrones...").start();

  while (rounds <= maxRounds) {
    try {
      raw = await provider.complete(messages, {
        systemPrompt: EVOLVE_SYSTEM,
        temperature: 0.25,
        maxTokens: 3000,
        model,
      });
    } catch (err) {
      spinner.fail("Falló la evolución");
      log.error((err as Error).message);
      process.exit(1);
    }

    try {
      const jsonText = extractJson(raw);
      const parsed = JSON.parse(jsonText);
      const result = EvolveOutput.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `  ${i.path.join(".")} — ${i.message}`).join("\n");
        throw new Error(`Evolve output no pasa el schema:\n${issues}\n\nJSON recibido:\n${jsonText}`);
      }
      output = result.data;
    } catch (err) {
      spinner.fail("Falló la validación de evolución");
      log.error((err as Error).message);
      log.dim(`Respuesta cruda:\n${raw}`);
      process.exit(1);
    }

    if (output.status !== "awaiting_human" || output.questions.length === 0) {
      spinner.succeed("Evolución lista");
      break;
    }

    if (rounds >= maxRounds) {
      spinner.warn("Evolve · max rounds HITL alcanzado");
      break;
    }

    spinner.stop();
    printHitlHeader("Evolve", output.summary, rounds + 1, maxRounds);
    const answers = await collectAnswers(output.questions);
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: formatAnswersForPrompt(answers) });
    rounds++;
  }

  if (opts.json && !opts.output && !opts.applyWiki) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (!opts.json) {
    console.log("");
    console.log(kleur.bold("Summary"));
    console.log("  " + output.summary);
    if (output.nextActions.length) {
      console.log("\n" + kleur.bold("Next Actions"));
      output.nextActions.forEach((action) => console.log("  · " + action));
    }
  }

  const markdown = renderEvolution(output);
  const ref = await writeArtifact("evolve", output, { sessionId: session?.id ?? "adhoc" });
  if (opts.output) log.warn("--output para evolve está deprecado; se escribió en la persistencia MD+YAML.");
  log.success(`Guardado en ${ref.path}`);

  if (opts.applyWiki) {
    if (!config.wikiPath) {
      log.error("No hay wikiPath configurado. Define SLAD_WIKI_PATH en .env para usar --apply-wiki.");
      process.exit(1);
    }
    const wikiOut = appendWikiUpdate(config.wikiPath, markdown);
    log.success(`Wiki actualizada en ${wikiOut}`);
  }

  if (session) {
    saveSession(appendArtifact(session, "evolve", ref.path));
    log.dim(`  sesión: ${session.id}`);
  }
}
