import kleur from "kleur";
import { input, select } from "@inquirer/prompts";
import { loadConfig, resolveProvider } from "../core/config.js";
import { log } from "../core/logger.js";
import {
  createSession,
  getActiveSession,
  getActiveSessionId,
  sessionContextBlock,
} from "../core/session.js";
import type { SessionState } from "../core/types.js";
import { exploreCommand } from "./explore.js";
import { snapshotCommand } from "./snapshot.js";
import { planCommand } from "./plan.js";
import { runCommand } from "./run.js";
import { learnCommand } from "./learn.js";
import { evolveCommand } from "./evolve.js";
import { autoCommand } from "./auto.js";
import { sessionShowCommand } from "./session.js";

/**
 * Reference to the real process.exit captured at module load.
 *
 * `safeCall` swaps `process.exit` for a throwing stub while a sub-command
 * runs. If the SIGINT handler (registered inside `chatCommand`) reads
 * `process.exit` lazily, it can pick up that stub when fired during
 * `signal-exit`/inquirer plumbing — the throw escapes from a synchronous
 * event listener and crashes the process.
 *
 * Capturing it once at module load lets the SIGINT handler always exit
 * cleanly regardless of whether safeCall is mid-flight.
 */
const ORIGINAL_PROCESS_EXIT = process.exit.bind(process);

export interface ChatOpts {
  provider?: string;
  agent?: string;
  model?: string;
}

// ─── routing ──────────────────────────────────────────────────────────────────

type ChatAction =
  | { type: "explore"; intent: string }
  | { type: "snapshot" }
  | { type: "plan" }
  | { type: "run-auto" }
  | { type: "run-task"; taskId: string }
  | { type: "run-next" }
  | { type: "learn" }
  | { type: "evolve" }
  | { type: "auto"; intent: string }
  | { type: "status" }
  | { type: "new" }
  | { type: "help" }
  | { type: "next" }
  | { type: "exit" }
  | { type: "unknown"; input: string };

function hasArtifact(session: SessionState | null, kind: string): boolean {
  return session?.artifacts.some((a: { kind: string }) => a.kind === kind) ?? false;
}

export function parseAction(raw: string, session: SessionState | null): ChatAction {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed || /^(siguiente|next|continuar|continue|sí|si|yes|ok|dale)$/i.test(trimmed)) {
    return { type: "next" };
  }
  if (/^(exit|quit|salir|bye|chau|q)$/i.test(trimmed)) return { type: "exit" };
  if (/^(help|ayuda|\?|h)$/i.test(trimmed)) return { type: "help" };
  if (/^(status|estado|show|sesion|sesión)$/i.test(trimmed)) return { type: "status" };
  if (/^(new|nuevo|nueva|reset)$/i.test(trimmed)) return { type: "new" };
  if (/^(evolve|evolucionar?)$/i.test(lower)) return { type: "evolve" };
  if (/^(learn|aprender?)$/i.test(lower)) return { type: "learn" };
  if (/^(plan|planificar?)$/i.test(lower)) return { type: "plan" };
  if (/^snapshot$/i.test(lower)) return { type: "snapshot" };
  if (/^(run\s+--auto|run\s+auto|run\s+todo|ejecutar?\s+todo)$/i.test(lower)) {
    return { type: "run-auto" };
  }
  // "auto <intent>" o "pipeline <intent>" → pipeline completo para ese intent
  const autoMatch = trimmed.match(/^(?:auto|pipeline|completo)\s+(.+)/i);
  if (autoMatch) return { type: "auto", intent: autoMatch[1]! };
  // "auto" a secas (sin intent) → run-auto (compatibilidad previa)
  if (/^auto$/i.test(lower)) return { type: "run-auto" };
  const taskMatch = trimmed.match(/^(?:run\s+)?(T\d+)$/i);
  if (taskMatch) return { type: "run-task", taskId: taskMatch[1].toUpperCase() };
  if (/^(run|ejecutar?)$/i.test(lower)) return { type: "run-next" };

  const exploreMatch = trimmed.match(/^(?:explore?|explorar?)\s+(.+)/i);
  if (exploreMatch) return { type: "explore", intent: exploreMatch[1] };

  // Free text with no session or before first explore → treat as intent
  if (!hasArtifact(session, "explore")) return { type: "explore", intent: trimmed };

  return { type: "unknown", input: trimmed };
}

export function suggestNext(session: SessionState | null): string {
  if (!session || !hasArtifact(session, "explore")) {
    return kleur.dim("Escribí tu intención para empezar, o \"help\" para ver comandos.");
  }
  if (!hasArtifact(session, "snapshot")) {
    return kleur.dim("→ ") + "\"snapshot\"" + kleur.dim(" para generar el mini-spec");
  }
  if (!hasArtifact(session, "plan")) {
    return kleur.dim("→ ") + "\"plan\"" + kleur.dim(" para generar las tareas");
  }
  if (!hasArtifact(session, "run")) {
    return (
      kleur.dim("→ ") +
      "\"run --auto\"" +
      kleur.dim(" para ejecutar todo, o ") +
      "\"run T1\"" +
      kleur.dim(" para una tarea")
    );
  }
  if (!hasArtifact(session, "learn")) {
    return kleur.dim("→ ") + "\"learn\"" + kleur.dim(" para capturar aprendizajes");
  }
  return (
    kleur.dim("→ ") +
    "\"evolve\"" +
    kleur.dim(" para actualizar la wiki, o escribí una nueva intención")
  );
}

// ─── safe command wrapper ─────────────────────────────────────────────────────

export async function safeCall(fn: () => Promise<void>): Promise<boolean> {
  const originalExit = process.exit.bind(process);
  let didExit = false;
  (process as NodeJS.Process).exit = ((code?: number | string | null) => {
    didExit = true;
    throw Object.assign(new Error(`process.exit(${code ?? 0})`), { isProcessExit: true });
  }) as typeof process.exit;

  try {
    await fn();
    return true;
  } catch (err) {
    if (didExit || (err as { isProcessExit?: boolean }).isProcessExit) return false;
    log.error((err as Error).message);
    return false;
  } finally {
    process.exit = originalExit;
  }
}

// ─── help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log("");
  console.log(kleur.bold("Comandos disponibles en el chat:"));
  const cmds: [string, string][] = [
    ["<intención>", "Explorá una intención (o escribí 'explore <texto>')"],
    ["snapshot", "Generá el mini-spec del último explore"],
    ["plan", "Convertí el snapshot en tareas"],
    ["run --auto", "Ejecutá todas las tareas automáticamente"],
    ["run T2", "Ejecutá una tarea específica"],
    ["learn", "Capturá aprendizajes del último run"],
    ["evolve", "Proponé actualizaciones a la wiki"],
    ["next / Enter", "Avanzar al siguiente paso sugerido"],
    ["status", "Ver estado de la sesión activa"],
    ["new", "Empezar una nueva sesión"],
    ["exit", "Salir del chat"],
  ];
  cmds.forEach(([cmd, desc]) => {
    console.log("  " + kleur.cyan(cmd.padEnd(18)) + kleur.gray(desc));
  });
  console.log("");
}

// ─── welcome ──────────────────────────────────────────────────────────────────

function printWelcome(session: SessionState | null): void {
  console.log("");
  console.log(kleur.bold().white("SLAD OS · Chat"));

  if (session) {
    const count = session.artifacts.length;
    console.log(
      kleur.dim("  sesión: ") +
        kleur.cyan(session.id) +
        kleur.dim(` · ${count} artefacto${count !== 1 ? "s" : ""}`),
    );
    console.log(kleur.dim("  intent: ") + session.intent);

    const answers = sessionContextBlock(session);
    if (answers) console.log(kleur.dim(`\n  ${answers.split("\n").join("\n  ")}`));
  } else {
    console.log(kleur.dim("  No hay sesión activa. Tu primera intención creará una."));
  }

  console.log("");
  console.log("  " + suggestNext(session));
  console.log(kleur.dim('  ("help" para ver todos los comandos)'));
  console.log("");
}

// ─── action executor ─────────────────────────────────────────────────────────

async function executeAction(
  action: ChatAction,
  opts: ChatOpts,
  session: SessionState | null,
): Promise<SessionState | null> {
  const base = {
    provider: opts.provider,
    agent: opts.agent,
    model: opts.model,
    skipSession: false,
  };

  switch (action.type) {
    case "explore": {
      if (!session) {
        session = createSession(action.intent);
        log.dim(`  sesión creada: ${session.id}`);
      }
      await safeCall(() => exploreCommand(action.intent, base));
      break;
    }

    case "snapshot":
      await safeCall(() => snapshotCommand(base));
      break;

    case "plan":
      await safeCall(() => planCommand(base));
      break;

    case "run-auto":
      await safeCall(() => runCommand({ ...base, auto: true }));
      break;

    case "run-task":
      await safeCall(() => runCommand({ ...base, task: action.taskId }));
      break;

    case "run-next":
      await safeCall(() => runCommand(base));
      break;

    case "learn":
      await safeCall(() => learnCommand(base));
      break;

    case "evolve":
      await safeCall(() => evolveCommand(base));
      break;

    case "auto":
      await safeCall(() =>
        autoCommand(action.intent, {
          provider: opts.provider,
          agent: opts.agent,
          model: opts.model,
        }),
      );
      break;

    case "status":
      await sessionShowCommand();
      break;

    case "new": {
      const confirmed = await select({
        message: "¿Empezar una nueva sesión?",
        choices: [
          { name: "Sí, nueva sesión", value: true },
          { name: "No, continuar con la actual", value: false },
        ],
      });
      if (confirmed) {
        const newIntent = await input({ message: "Intención para la nueva sesión:" });
        if (newIntent.trim()) {
          session = createSession(newIntent.trim());
          log.success(`Sesión creada: ${session.id}`);
          await safeCall(() => exploreCommand(newIntent.trim(), base));
        }
      }
      break;
    }

    case "next": {
      // Execute the suggested next step automatically
      if (!hasArtifact(session, "explore")) {
        const intent = await input({ message: "¿Cuál es tu intención?" });
        if (intent.trim()) {
          if (!session) {
            session = createSession(intent.trim());
            log.dim(`  sesión creada: ${session.id}`);
          }
          await safeCall(() => exploreCommand(intent.trim(), base));
        }
      } else if (!hasArtifact(session, "snapshot")) {
        await safeCall(() => snapshotCommand(base));
      } else if (!hasArtifact(session, "plan")) {
        await safeCall(() => planCommand(base));
      } else if (!hasArtifact(session, "run")) {
        await safeCall(() => runCommand({ ...base, auto: true }));
      } else if (!hasArtifact(session, "learn")) {
        await safeCall(() => learnCommand(base));
      } else {
        await safeCall(() => evolveCommand(base));
      }
      break;
    }

    case "help":
      printHelp();
      break;

    case "exit":
      break;

    case "unknown":
      console.log(
        kleur.yellow(`  No entendí "${action.input}".`) +
          kleur.dim(' Escribí "help" para ver los comandos disponibles.'),
      );
      break;
  }

  // Reload session from disk after any mutation
  return getActiveSessionId() ? getActiveSession() : session;
}

// ─── main REPL ────────────────────────────────────────────────────────────────

export async function chatCommand(opts: ChatOpts): Promise<void> {
  // Validate provider early
  const config = loadConfig();
  resolveProvider(opts.provider, opts.agent, config.defaultProvider);

  let session = getActiveSession();
  printWelcome(session);

  process.on("SIGINT", () => {
    console.log("\n" + kleur.dim("Hasta luego."));
    // Use the original process.exit captured at module load so that we
    // never accidentally hit safeCall's throwing stub from a sync listener.
    ORIGINAL_PROCESS_EXIT(0);
  });

  while (true) {
    let userInput: string;
    try {
      userInput = await input({ message: kleur.bold().cyan("slad") + kleur.dim(" ›") });
    } catch {
      // SIGINT / EOF
      console.log("\n" + kleur.dim("Hasta luego."));
      break;
    }

    const action = parseAction(userInput, session);
    if (action.type === "exit") {
      console.log(kleur.dim("Hasta luego."));
      break;
    }

    session = await executeAction(action, opts, session);

    // Reload and show next suggestion after each action (except meta commands)
    if (!["help", "status", "exit", "unknown"].includes(action.type)) {
      session = getActiveSessionId() ? getActiveSession() : session;
      console.log("");
      console.log("  " + suggestNext(session));
      console.log("");
    }
  }
}
