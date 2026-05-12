import fs from "node:fs";
import path from "node:path";
import kleur from "kleur";
import {
  createSession,
  getActiveSession,
  getActiveSessionId,
  hasPersistedActiveSession,
  listSessions,
  loadSession,
  setActiveSession,
  saveSession,
  upsertAnswers,
  upsertArtifact,
} from "../core/session.js";
import { log } from "../core/logger.js";
import { SladError } from "../core/errors.js";
import { collectAnswers } from "../core/hitl.js";
import { computePathHash, discoverCliCandidates } from "../models/cli-discovery.js";
import type { DiscoveryResult as DiscoveryResultType } from "../core/types.js";
import { createBootUi, type BootUiOptions } from "../cli/ui.js";
import { artifactDirSync } from "../persistence/layout.js";
import { DiscoveryResult } from "../core/types.js";

type SessionStartDeps = {
  bootUiFactory?: (opts: BootUiOptions) => ReturnType<typeof createBootUi>;
};

function isNonInteractiveArgv(): boolean {
  return process.argv.includes("--non-interactive");
}

function hasInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function shouldRenderVisualBootUiForEnv(opts?: {
  stdoutIsTty?: boolean;
  stderrIsTty?: boolean;
  ci?: string | undefined;
}): boolean {
  const stdoutIsTty = opts?.stdoutIsTty ?? process.stdout.isTTY;
  const stderrIsTty = opts?.stderrIsTty ?? process.stderr.isTTY;
  const ci = opts?.ci ?? process.env.CI;
  return Boolean(stdoutIsTty && stderrIsTty && ci === undefined);
}

function shouldRenderVisualBootUi(): boolean {
  return shouldRenderVisualBootUiForEnv();
}

function computeCurrentPathHash(envPath = process.env.PATH ?? ""): string {
  const entries = envPath.split(path.delimiter).filter(Boolean);
  return computePathHash(entries);
}

/**
 * Internal testing note:
 * Use `SLAD_CLI_DISCOVERY_STRICT_PATH=1` to isolate discovery to PATH-only directories.
 * This keeps test fixtures deterministic by excluding Node bin and ~/.local/bin fallbacks.
 */
function isStrictPathDiscoveryEnabled(): boolean {
  return process.env.SLAD_CLI_DISCOVERY_STRICT_PATH === "1";
}

function discoveryArtifactPath(sessionId: string): string {
  return path.join(artifactDirSync("session"), `${sessionId}_cli-discovery.json`);
}

function renderDiscoveryArtifact(
  sessionId: string,
  discovery: DiscoveryResultType,
): string {
  return JSON.stringify(
    { kind: "cli-discovery", schemaVersion: 1, sessionId, createdAt: new Date().toISOString(), value: discovery },
    null,
    2,
  );
}

function readDiscoveryArtifact(filePath: string): DiscoveryResultType | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const envelope = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return DiscoveryResult.parse(envelope.value ?? envelope);
  } catch {
    return null;
  }
}

function findPreviousDiscoveryArtifactPath(): string | null {
  const sessions = listSessions();
  for (const session of sessions) {
    const artifact = [...session.artifacts]
      .reverse()
      .find((entry) => entry.kind === "cli-discovery");
    if (artifact) return artifact.path;
  }
  return null;
}

function formatDiscoveryList(result: DiscoveryResultType): string {
  if (result.candidates.length === 0) return "ningún CLI encontrado";

  // Dedup por nombre, queda el de mayor score. Filtra ruido (score < 0.5).
  const byName = new Map<string, (typeof result.candidates)[0]>();
  for (const c of result.candidates) {
    const existing = byName.get(c.binary);
    if (!existing || c.confidenceScore > existing.confidenceScore) {
      byName.set(c.binary, c);
    }
  }

  const selectedPath = result.selected?.resolvedPath;
  const MIN_SCORE = 0.5;
  const relevant = [...byName.values()]
    .filter((c) => c.confidenceScore >= MIN_SCORE)
    .sort((a, b) => b.confidenceScore - a.confidenceScore);

  const items = relevant.length > 0 ? relevant : [...byName.values()];
  return items
    .map((c) => (c.resolvedPath === selectedPath ? `${c.binary} (activo)` : c.binary))
    .join(", ");
}

function formatAmbiguityConflicts(result: DiscoveryResultType): string {
  const lines = result.candidates.map((candidate) => {
    const conflicts =
      candidate.conflicts.length > 0 ? ` (conflictos: ${candidate.conflicts.join(", ")})` : "";
    return `- ${candidate.binary}: ${candidate.resolvedPath}${conflicts}`;
  });
  return lines.join("\n");
}

function maybeWarnHeuristicFallback(result: DiscoveryResultType): void {
  const selected = result.selected;
  if (!selected) return;
  const hasValidationSignal = selected.evidence.some((evidence) => evidence.startsWith("signal:"));
  if (!hasValidationSignal) {
    log.warn(
      `autodiscovery CLI usó fallback heurístico para '${selected.binary}' (fuente: score por nombre).`,
    );
  }
}

function buildAmbiguityChoices(result: DiscoveryResultType): string[] {
  return result.candidates.map((candidate) => {
    const score = candidate.confidenceScore.toFixed(2);
    return `${candidate.binary} | ${candidate.resolvedPath} | score=${score}`;
  });
}

function parseChoiceToPath(choice: string): string {
  const parts = choice.split(" | ");
  return parts[1] ?? "";
}

export async function sessionStartCommand(
  intent: string,
  agentOverride?: string,
  deps: SessionStartDeps = {},
): Promise<void> {
  const hasActiveSession = hasPersistedActiveSession();
  const bootUiFactory = deps.bootUiFactory ?? createBootUi;
  const bootUi = bootUiFactory({ enabled: !hasActiveSession && shouldRenderVisualBootUi() });
  let bootSettled = hasActiveSession;

  try {
    if (!hasActiveSession) {
      await bootUi.showBanner();
      bootUi.start("Iniciando sesión...");
      bootUi.milestone("config", "Validando configuración inicial...");
    }
    if (!intent || intent.trim().length < 3) {
      throw new SladError(
        'Intención vacía. Uso: slad session start "<intención>"',
        "SESSION_START_INVALID_INTENT",
      );
    }

    if (hasActiveSession) {
      const resumed = getActiveSession();
      if (!resumed) {
        throw new SladError(
          "No se pudo cargar la sesión activa persistida.",
          "SESSION_START_RESUME_FAILED",
        );
      }
      log.success(`Sesión resumida: ${resumed.id}`);
      log.dim(`  intent: ${resumed.intent}`);
      return;
    }

    bootUi.milestone("config", "Creando estado base de sesión...");
    const session = createSession(intent.trim());
    let updatedSession = session;
    const artifactPath = discoveryArtifactPath(session.id);
    const currentPathHash = computeCurrentPathHash();
    let discovery: DiscoveryResultType;

    // Si se pasa -a/--agent, saltear discovery y pre-seleccionar directo.
    bootUi.milestone("config", "Resolviendo autodiscovery de CLI...");
    if (agentOverride?.trim()) {
      const binary = agentOverride.trim();
      discovery = await discoverCliCandidates({ knownBinaries: [binary] });
      discovery = { ...discovery, pathHash: currentPathHash };
      if (discovery.candidates.length > 0) {
        discovery = { ...discovery, selected: discovery.candidates[0], status: "resolved" };
        log.dim(`  cli-discovery: ${binary} (activo, forzado por --agent)`);
      } else {
        log.warn(
          `  cli-discovery: binario '${binary}' no encontrado en PATH. Continuando sin pre-selección.`,
        );
        discovery = { ...discovery, status: "empty" };
      }
    } else {
      const previousArtifactPath = findPreviousDiscoveryArtifactPath();
      const previous = previousArtifactPath ? readDiscoveryArtifact(previousArtifactPath) : null;

      if (isStrictPathDiscoveryEnabled()) {
        log.dim("  cli-discovery: modo strict-path activo (testing/aislamiento)");
      }

      if (previous && previous.pathHash === currentPathHash) {
        discovery = previous;
        log.dim(`  cli-discovery: ${formatDiscoveryList(discovery)} (reutilizado)`);
      } else {
        discovery = await discoverCliCandidates();
        discovery = { ...discovery, pathHash: currentPathHash };
        log.dim(`  cli-discovery: ${formatDiscoveryList(discovery)}`);
      }
    }

    if (discovery.status === "ambiguous") {
      const hitlAvailable = !isNonInteractiveArgv() && hasInteractiveTty();
      if (!hitlAvailable) {
        throw new SladError(
          [
            "Autodiscovery CLI ambiguo sin HITL disponible.",
            "Conflictos detectados:",
            formatAmbiguityConflicts(discovery),
            "Resolución: ejecutá en TTY interactiva o especificá un agente explícito con --agent <codex|claude|gemini>.",
          ].join("\n"),
          "SESSION_CLI_DISCOVERY_AMBIGUOUS",
          {
            sessionId: session.id,
            nonInteractive: isNonInteractiveArgv(),
            hasTty: hasInteractiveTty(),
          },
        );
      }

      const choices = buildAmbiguityChoices(discovery);
      const question = {
        id: "cli_candidate",
        prompt: "Autodiscovery detectó múltiples CLIs IA. Elegí cuál usar.",
        kind: "choice" as const,
        choices,
        default: choices[0],
        context: "Se guardará en la sesión para evitar ambigüedad en la selección del provider cli.",
        blocking: true,
      };
      const answers = await collectAnswers([question]);
      const selectedPath = parseChoiceToPath(answers.cli_candidate ?? "");
      const selected = discovery.candidates.find((candidate) => candidate.resolvedPath === selectedPath);

      if (!selected) {
        throw new SladError(
          `No se pudo mapear la selección HITL a un candidato válido: '${answers.cli_candidate ?? ""}'.`,
          "SESSION_CLI_DISCOVERY_INVALID_SELECTION",
          { sessionId: session.id },
        );
      }

      discovery = {
        ...discovery,
        selected,
        status: "resolved",
      };
      updatedSession = upsertAnswers(updatedSession, "sessionStart", {
        cli_candidate: answers.cli_candidate ?? "",
      });
      log.success(`autodiscovery CLI resuelto por HITL: ${selected.binary} (${selected.resolvedPath})`);
    }

    bootUi.milestone("fs", "Preparando filesystem de sesión...");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, renderDiscoveryArtifact(session.id, discovery), "utf8");

    bootUi.milestone("persistence", "Persistiendo estado de sesión...");
    updatedSession = upsertArtifact(updatedSession, "cli-discovery", artifactPath);
    saveSession(updatedSession);

    maybeWarnHeuristicFallback(discovery);

    bootUi.succeed(`Sesión creada: ${session.id}`);
    bootSettled = true;
    log.dim(`  intent: ${session.intent}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error iniciando sesión";
    await bootUi.fail(message);
    bootSettled = true;
    throw error;
  } finally {
    if (!bootSettled) {
      bootUi.stop();
    }
  }
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
