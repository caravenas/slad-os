#!/usr/bin/env node
import { Command } from "commander";
import { loadEnv } from "./core/config.js";
import { exploreCommand } from "./commands/explore.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { planCommand } from "./commands/plan.js";
import { runCommand } from "./commands/run.js";
import { learnCommand } from "./commands/learn.js";
import { evolveCommand } from "./commands/evolve.js";
import {
  sessionStartCommand,
  sessionListCommand,
  sessionUseCommand,
  sessionShowCommand,
} from "./commands/session.js";
import { chatCommand } from "./commands/chat.js";

loadEnv();

const program = new Command();

program
  .name("slad")
  .description("SLAD OS — CLI de agentes para explorar intención y generar Snapshots.")
  .version("0.1.0");

program
  .command("explore")
  .description("Explorer Agent: analiza una intención y devuelve enfoques, riesgos y next steps.")
  .argument("<intent...>", "La intención a explorar (entre comillas o libre)")
  .option("-a, --agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli local: codex/claude)")
  .option("-m, --model <name>", "Override del modelo específico")
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
  .option("-a, --approach <name>", "Nombre (o substring) del approach a elegir del explore.json")
  .option("--agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli local: codex/claude)")
  .option("-m, --model <name>", "Override del modelo específico")
  .option("-o, --output <path>", "Ruta de salida del .md (default: ./snapshots/<fecha>-<slug>.md)")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await snapshotCommand(opts);
  });

program
  .command("plan")
  .description("Planner Agent: convierte un Snapshot en tasks.json ejecutable.")
  .option("-i, --input <path>", "Ruta a un snapshot.md (default: último snapshot de la sesión activa)")
  .option("-a, --agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli local: codex/claude)")
  .option("-m, --model <name>", "Override del modelo específico")
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
  .option("-a, --agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli local: codex/claude)")
  .option("-m, --model <name>", "Override del modelo específico")
  .option("-o, --output <path>", "Ruta de salida del reporte JSON (default: ./runs/<timestamp>-<task>.json)")
  .option("--max-rounds <n>", "Máximo de rounds HITL antes de marcar blocked (default: 3)", parseInt)
  .option("--auto", "Ejecutar el DAG completo de tareas automáticamente")
  .option("--max-tasks <n>", "Budget de ejecuciones en modo --auto (default: 10)", parseInt)
  .option("--json", "Imprimir JSON plano en stdout en lugar del resumen legible")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (taskArg: string | undefined, opts) => {
    await runCommand({ ...opts, task: taskArg ?? opts.task });
  });

program
  .command("learn")
  .description("Learn Agent: captura decisiones, errores y patrones desde un run report.")
  .option("-i, --input <path>", "Ruta a un run report JSON (default: último ./runs/*.json)")
  .option("-a, --agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli local: codex/claude)")
  .option("-m, --model <name>", "Override del modelo específico")
  .option("-o, --output <path>", "Ruta de salida (default: ./learnings/<timestamp>-<task>.md)")
  .option("--json", "Guardar/imprimir JSON en lugar de Markdown")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await learnCommand(opts);
  });

program
  .command("evolve")
  .description("Evolve Agent: propone actualizaciones de wiki/patrones desde artefactos recientes.")
  .option("-a, --agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli local: codex/claude)")
  .option("-m, --model <name>", "Override del modelo específico")
  .option("-o, --output <path>", "Ruta de salida (default: ./evolution/<timestamp>-evolve.md)")
  .option("--apply-wiki", "Append del resultado a $SLAD_WIKI_PATH/slad-os-evolution.md")
  .option("--json", "Guardar/imprimir JSON en lugar de Markdown")
  .option("--skip-session", "Ignorar sesión activa (comportamiento v0.1.0)")
  .action(async (opts) => {
    await evolveCommand(opts);
  });

program
  .command("chat")
  .description("REPL conversacional: explorá, planificá y ejecutá en formato chat.")
  .option("-a, --agent <name>", "Agente local (codex | claude)")
  .option("-p, --provider <name>", "Provider LLM (anthropic | openai | gemini | cli)")
  .option("-m, --model <name>", "Override del modelo específico")
  .action(async (opts) => {
    await chatCommand(opts);
  });

const sessionCmd = program
  .command("session")
  .description("Gestiona sesiones de trabajo: contexto compartido entre comandos.");

sessionCmd
  .command("start <intent...>")
  .description("Crea una nueva sesión y la marca como activa.")
  .action(async (intentParts: string[]) => {
    await sessionStartCommand(intentParts.join(" "));
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
  console.error(err);
  process.exit(1);
});
