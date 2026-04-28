import kleur from "kleur";
import {
  createSession,
  getActiveSession,
  getActiveSessionId,
  listSessions,
  loadSession,
  setActiveSession,
} from "../core/session.js";
import { log } from "../core/logger.js";

export async function sessionStartCommand(intent: string): Promise<void> {
  if (!intent || intent.trim().length < 3) {
    log.error('Intención vacía. Uso: slad session start "<intención>"');
    process.exit(1);
  }
  const session = createSession(intent.trim());
  log.success(`Sesión creada: ${session.id}`);
  log.dim(`  intent: ${session.intent}`);
}

export async function sessionListCommand(): Promise<void> {
  const sessions = listSessions();
  const activeId = getActiveSessionId();

  if (sessions.length === 0) {
    log.dim("No hay sesiones. Creá una con: slad session start \"<intención>\"");
    return;
  }

  console.log("");
  sessions.forEach((s) => {
    const active = s.id === activeId ? kleur.green(" ← activa") : "";
    const phase = s.currentPhase ? kleur.dim(` [${s.currentPhase}]`) : "";
    const artifacts = s.artifacts.length ? kleur.dim(` · ${s.artifacts.length} artefactos`) : "";
    console.log(kleur.bold(s.id) + active + phase + artifacts);
    console.log(kleur.dim(`  ${s.intent}`));
    console.log("");
  });
}

export async function sessionUseCommand(id: string): Promise<void> {
  const session = loadSession(id);
  if (!session) {
    log.error(`No existe la sesión: ${id}`);
    process.exit(1);
  }
  setActiveSession(id);
  log.success(`Sesión activa: ${id}`);
}

export async function sessionShowCommand(): Promise<void> {
  const session = getActiveSession();
  if (!session) {
    log.dim("No hay sesión activa. Creá una con: slad session start \"<intención>\"");
    return;
  }

  console.log("");
  console.log(kleur.bold("Sesión activa"));
  console.log("  " + kleur.cyan(session.id));

  console.log("\n" + kleur.bold("Intent"));
  console.log("  " + session.intent);

  if (session.currentPhase) {
    console.log("\n" + kleur.bold("Fase actual"));
    console.log("  " + session.currentPhase);
  }

  if (session.artifacts.length) {
    console.log("\n" + kleur.bold("Artefactos"));
    session.artifacts.forEach((a) => {
      const taskSuffix = a.taskId ? kleur.dim(` (${a.taskId})`) : "";
      console.log(`  · ${kleur.cyan(a.kind)}${taskSuffix} → ${a.path}`);
    });
  } else {
    console.log("\n" + kleur.dim("  Sin artefactos todavía."));
  }

  if (session.humanAnswers.length) {
    console.log("\n" + kleur.bold("Decisiones HITL"));
    session.humanAnswers.forEach((a) => {
      console.log(`  · [${a.taskId}/${a.questionId}] ${kleur.green(a.answer)}`);
    });
  }
}
