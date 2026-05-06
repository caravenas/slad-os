#!/usr/bin/env node
import { Command } from "commander";
import { loadEnv } from "./core/config.js";
import { exploreCommand } from "./commands/explore.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { planCommand } from "./commands/plan.js";
import { runCommand } from "./commands/run.js";
import { learnCommand } from "./commands/learn.js";
import { evolveCommand } from "./commands/evolve.js";
import { autoCommand } from "./commands/auto.js";
import {
  sessionStartCommand,
  sessionListCommand,
  sessionUseCommand,
  sessionShowCommand,
} from "./commands/session.js";
import { chatCommand } from "./commands/chat.js";
import { log } from "./core/logger.js";
import { SladError } from "./core/errors.js";
import { getFormattedCliVersion } from "./cli/version.js";

loadEnv();

const cliVersion = await getFormattedCliVersion();
const program = new Command();

program
  .name("slad")
  .description("SLAD OS — CLI de agentes para explorar intención y generar Snapshots.")
  .version(cliVersion)
  .addHelpText(
    "after",
    `
Pipeline:

  $ slad session start "agregar autenticación" -a gemini
  $ slad explore "agregar autenticación" -a gemini
  $ slad snapshot -a gemini
  $ slad plan -a gemini
  $ slad run T1 -a gemini
  $ slad learn -a gemini
  $ slad evolve -a gemini

Modo conversacional (independiente del pipeline):

  $ slad chat -a gemini
`,
  );

program
  .command("version")
  .description("Imprime la versión de SLAD OS.")
  .action(() => {
    process.stdout.write(`${cliVersion}\n`);
  });

program
  .command("explore")
  .description("Explorer Agent: analiza una intención y devuelve enfoques, riesgos y next steps.")
  .argument("<intent...>", "La intención a explorar (entre comillas o libre)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Guardar el resultado como JSON en esta ruta")
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (intentParts: string[], opts) => {
    const intent = intentParts.join(" ");
    await exploreCommand(intent, opts);
  });

program
  .command("snapshot")
  .description("Genera un Snapshot (mini-spec) a partir de un explore.json o de una intención.")
  .option("-i, --input <path>", "Ruta a un explore.json (output de `slad explore --output`)")
  .option("--intent <text>", "Intención directa si no hay input previo")
  .option("--approach <name>", "Nombre (o substring) del approach a elegir del explore.json")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida del .md (default: ./snapshots/<fecha>-<slug>.md)")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await snapshotCommand(opts);
  });

program
  .command("plan")
  .description("Planner Agent: convierte un Snapshot en tasks.json ejecutable.")
  .option("-i, --input <path>", "Ruta a un snapshot.md (default: último snapshot de la sesión activa)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida del JSON (default: ./tasks/tasks.json)")
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await planCommand(opts);
  });

program
  .command("run")
  .description("Builder + Reviewer: ejecuta una tarea de tasks.json y guarda un reporte.")
  .argument("[task]", "Task id a ejecutar (ej. T2). Alternativa a --task")
  .option("-i, --input <path>", "Ruta a tasks.json (default: ./tasks/tasks.json)")
  .option("-t, --task <id>", "Task id a ejecutar (default: recommendedFirstTask)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida del reporte JSON (default: ./runs/<timestamp>-<task>.json)")
  .option("--max-rounds <n>", "Máximo de rounds HITL antes de marcar blocked (default: 3)", parseInt)
  .option("--auto", "Ejecutar el DAG completo de tareas automáticamente")
  .option("--max-tasks <n>", "Budget de ejecuciones en modo --auto (default: 10)", parseInt)
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .option("--harness <mode>", "Modo del arnés de seguridad (off | on | strict)", "off")
  .option("--tools", "Habilitar tool use: el agente ejecuta código real (default si el provider lo soporta)")
  .option("--no-tools", "Deshabilitar tool use: modo advisory (describe qué haría sin ejecutar)")
  .action(async (taskArg: string | undefined, opts) => {
    await runCommand({ ...opts, task: taskArg ?? opts.task });
  });

program
  .command("learn")
  .description("Learn Agent: captura decisiones, errores y patrones desde un run report.")
  .option("-i, --input <path>", "Ruta a un run report JSON (default: último ./runs/*.json)")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida (default: ./learnings/<timestamp>-<task>.md)")
  .option("--json", "Guardar/imprimir JSON en lugar de Markdown")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await learnCommand(opts);
  });

program
  .command("evolve")
  .description("Evolve Agent: propone actualizaciones de wiki/patrones desde artefactos recientes.")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .option("-o, --output <path>", "Ruta de salida (default: ./evolution/<timestamp>-evolve.md)")
  .option("--apply-wiki", "Append del resultado a $SLAD_WIKI_PATH/slad-os-evolution.md")
  .option("--json", "Guardar/imprimir JSON en lugar de Markdown")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await evolveCommand(opts);
  });

program
  .command("auto")
  .description(
    "Pipeline completo: de intent a código implementado (explore → snapshot → plan → run → learn).",
  )
  .argument("<intent...>", "La intención a implementar")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar")
  .option("--max-cost <usd>", "Budget máximo en USD (default: 1.0)", parseFloat)
  .option("--max-tasks <n>", "Máximo de tasks a ejecutar (default: 10)", parseInt)
  .option("--harness <mode>", "Modo del arnés de seguridad (off | on | strict)", "on")
  .option("--dry-run", "Solo explore+snapshot+plan, sin ejecutar código")
  .option("--skip-learn", "No ejecutar learn al final")
  .option("--json", "Output JSON del report final")
  .action(async (intentParts: string[], opts) => {
    await autoCommand(intentParts.join(" "), {
      provider: opts.provider,
      agent: opts.agent,
      model: opts.model,
      maxCost: opts.maxCost,
      maxTasks: opts.maxTasks,
      harness: opts.harness,
      dryRun: opts.dryRun,
      skipLearn: opts.skipLearn,
      json: opts.json,
    });
  });

program
  .command("chat")
  .description("REPL conversacional: explorá, planificá y ejecutá en formato chat.")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM: anthropic | openai | gemini | cli  [default: $SLAD_DEFAULT_PROVIDER]")
  .option("-m, --model <name>", "Modelo a usar (ej. claude-sonnet-4-5, gpt-4o, gemini-2.0-flash)  [default: $SLAD_MODEL / $<PROVIDER>_MODEL]")
  .action(async (opts) => {
    await chatCommand(opts);
  });

const sessionCmd = program
  .command("session")
  .description("Gestiona sesiones de trabajo: contexto compartido entre comandos.");

sessionCmd
  .command("start <intent...>")
  .description("Crea una nueva sesión y la marca como activa.")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini) — pre-selecciona sin pasar por discovery")
  .action(async (intentParts: string[], opts) => {
    await sessionStartCommand(intentParts.join(" "), opts.agent);
  });

sessionCmd
  .command("list")
  .description("Lista todas las sesiones en el proyecto.")
  .action(async () => {
    await sessionListCommand();
  });

sessionCmd
  .command("use <id>")
  .description("Cambia la sesión activa.")
  .action(async (id: string) => {
    await sessionUseCommand(id);
  });

sessionCmd
  .command("show")
  .description("Muestra el estado de la sesión activa.")
  .action(async () => {
    await sessionShowCommand();
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof SladError) {
    log.error(`[${err.code}] ${err.message}`, err);
    if (Object.keys(err.context).length > 0) {
      log.debug("Context", err.context);
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
