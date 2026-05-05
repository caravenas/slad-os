import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ModelProvider } from "./index.js";
import { getActiveSession } from "../core/session.js";
import { parseCliDiscoveryAnswer } from "../core/config.js";
import { log } from "../core/logger.js";
import { DiscoveryResult, type ChatMessage, type CompletionOptions, type DiscoveryResult as DiscoveryResultType, type ProviderName } from "../core/types.js";
import { CliFallbackError, ProviderError } from "../core/errors.js";

const DEFAULT_TIMEOUT_MS = 1_800_000;
const API_KEY_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];
const MODEL_ENV_NAMES = [
  "SLAD_MODEL",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
  "GEMINI_MODEL",
  "GOOGLE_MODEL",
  "CLI_MODEL",
];
type PromptMode = "arg" | "stdin";
type AdapterId = "codex" | "claude" | "gemini";
type CliFailureContext = {
  code: number | null;
  signal: NodeJS.Signals | null;
  binary: string;
  displayArgs: string[];
  stdout: string;
  stderr: string;
};

type CliAdapterOutput = {
  stdout: string;
  stderr: string;
  outputFromFile: string;
};

export interface CliAdapter {
  readonly id: string;
  defaultArgs(): string[];
  defaultPromptMode(): PromptMode;
  supportsPromptMode(mode: PromptMode): boolean;
  shouldProbeRuntimeCapability(): boolean;
  modelArg(): string;
  shouldCaptureLastMessageToFile(): boolean;
  normalizeOutput(output: CliAdapterOutput): string;
  mapSpawnError(binary: string, error: Error): ProviderError;
  mapFailure(context: CliFailureContext): ProviderError;
}

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function binaryName(binary: string): string {
  return path.basename(binary).replace(/\.exe$/i, "").toLowerCase();
}

const KNOWN_CLI_BINARIES = ["codex", "gemini", "claude"] as const;

function detectDefaultBinary(): string {
  const found = KNOWN_CLI_BINARIES.filter(commandExists);

  if (found.length === 0) {
    log.warn("cli-discovery: no se encontró ningún CLI local (codex, gemini, claude). Usando \"claude\" como fallback.");
    return "claude";
  }

  const list = found.map((b, i) => (i === 0 ? `${b} (activo)` : b)).join(", ");
  log.info(`cli-discovery: ${list}`);
  return found[0];
}

function formatFailureSuffix(stdout: string, stderr: string): string {
  return [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n\n");
}

const claudeAdapter: CliAdapter = {
  id: "claude",
  defaultArgs: () => ["--print"],
  defaultPromptMode: () => "arg",
  supportsPromptMode: (mode) => mode === "arg",
  shouldProbeRuntimeCapability: () => false,
  modelArg: () => "--model",
  shouldCaptureLastMessageToFile: () => false,
  normalizeOutput: ({ stdout }) => stdout.trim(),
  mapSpawnError: (binary, error) =>
    new ProviderError(`No se pudo ejecutar el CLI provider "${binary}": ${error.message}`, "cli", {
      retryable: false,
      cause: error,
    }),
  mapFailure: ({ code, signal, binary, displayArgs, stdout, stderr }) => {
    const suffix = formatFailureSuffix(stdout, stderr);
    return new ProviderError(
      `CLI provider falló con código ${code ?? `signal ${signal}`}: ${binary} ${displayArgs.join(" ")}${
        suffix ? `\n\n${suffix}` : ""
      }`,
      "cli",
      { retryable: false },
    );
  },
};

const codexAdapter: CliAdapter = {
  id: "codex",
  defaultArgs: () => ["exec", "--skip-git-repo-check", "--color", "never"],
  defaultPromptMode: () => "stdin",
  supportsPromptMode: (mode) => mode === "stdin" || mode === "arg",
  shouldProbeRuntimeCapability: () => false,
  modelArg: () => "--model",
  shouldCaptureLastMessageToFile: () => true,
  normalizeOutput: ({ outputFromFile, stdout }) => (outputFromFile || stdout).trim(),
  mapSpawnError: (binary, error) =>
    new ProviderError(`No se pudo ejecutar el CLI provider "${binary}": ${error.message}`, "cli", {
      retryable: false,
      cause: error,
    }),
  mapFailure: ({ code, signal, binary, displayArgs, stdout, stderr }) => {
    const suffix = formatFailureSuffix(stdout, stderr);
    return new ProviderError(
      `CLI provider falló con código ${code ?? `signal ${signal}`}: ${binary} ${displayArgs.join(" ")}${
        suffix ? `\n\n${suffix}` : ""
      }`,
      "cli",
      { retryable: false },
    );
  },
};

const geminiAdapter: CliAdapter = {
  id: "gemini",
  defaultArgs: () => [],
  defaultPromptMode: () => "arg",
  supportsPromptMode: (mode) => mode === "stdin" || mode === "arg",
  shouldProbeRuntimeCapability: () => true,
  modelArg: () => "--model",
  shouldCaptureLastMessageToFile: () => false,
  normalizeOutput: ({ stdout }) => stdout.trim(),
  mapSpawnError: (binary, error) =>
    new ProviderError(`No se pudo ejecutar el CLI provider "${binary}": ${error.message}`, "cli", {
      retryable: false,
      cause: error,
    }),
  mapFailure: ({ code, signal, binary, displayArgs, stdout, stderr }) => {
    const suffix = formatFailureSuffix(stdout, stderr);
    return new ProviderError(
      `CLI provider falló con código ${code ?? `signal ${signal}`}: ${binary} ${displayArgs.join(" ")}${
        suffix ? `\n\n${suffix}` : ""
      }`,
      "cli",
      { retryable: false },
    );
  },
};

type RuntimeCapability = {
  supportsStdin: boolean;
  supportsArg: boolean;
};

const runtimeCapabilityCache = new Map<string, RuntimeCapability>();

function probeBinary(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return `${stdout}\n${stderr}`.toLowerCase();
}

function detectRuntimeCapabilityFromTexts(binary: string, helpText: string, versionText: string): RuntimeCapability {
  const combined = `${helpText}\n${versionText}`.toLowerCase();
  const supportsStdin = /stdin|read from standard input|from stdin|\b-\b/.test(combined);
  const supportsArg = /prompt|message|text|<prompt>|input/.test(combined) || binaryName(binary) === "claude";
  return { supportsStdin, supportsArg };
}

function detectRuntimeCapability(binary: string): RuntimeCapability {
  const cached = runtimeCapabilityCache.get(binary);
  if (cached) return cached;

  // Negative path: si el binario no existe o no responde, usamos defaults conservadores.
  if (!commandExists(binary)) {
    const conservative = { supportsStdin: false, supportsArg: true };
    runtimeCapabilityCache.set(binary, conservative);
    return conservative;
  }

  // Positive path: inspección de help/version sin depender de SDKs.
  const helpText = probeBinary(binary, ["--help"]);
  const versionText = probeBinary(binary, ["--version"]);
  const capability = detectRuntimeCapabilityFromTexts(binary, helpText, versionText);
  runtimeCapabilityCache.set(binary, capability);
  return capability;
}

function adapterForBinary(binary: string): CliAdapter {
  switch (binaryName(binary)) {
    case "codex":
      return codexAdapter;
    case "gemini":
      return geminiAdapter;
    default:
      return claudeAdapter;
  }
}

function detectAdapterIdForModel(model: string | undefined): AdapterId | null {
  if (!model?.trim()) return null;
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gemini")) return "gemini";
  return null;
}

function defaultBinaryForAdapter(adapterId: AdapterId): string {
  if (adapterId === "codex") return "codex";
  if (adapterId === "gemini") return "gemini";
  return "claude";
}

function cleanupOutputFile(outputFilePath: string | null): void {
  if (!outputFilePath || !fs.existsSync(outputFilePath)) return;
  fs.rmSync(outputFilePath, { force: true });
}

function parseArgs(input: string | undefined): string[] {
  if (!input?.trim()) return [];

  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "\\" && i + 1 < input.length) {
      current += input[i + 1];
      i += 1;
      continue;
    }
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

function buildPrompt(messages: ChatMessage[], opts: CompletionOptions): string {
  const sections: string[] = [];

  if (opts.systemPrompt) {
    sections.push(`System:\n${opts.systemPrompt}`);
  }

  const messageText = messages
    .map((message) => `${message.role}:\n${message.content}`)
    .join("\n\n");

  if (messageText) sections.push(`Messages:\n${messageText}`);
  return sections.join("\n\n---\n\n").trim();
}

function buildProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.SLAD_CLI_INHERIT_API_KEYS === "true") return env;

  for (const name of API_KEY_ENV_NAMES) {
    delete env[name];
  }
  for (const name of MODEL_ENV_NAMES) {
    delete env[name];
  }
  return env;
}

type ExecuteCliOptions = {
  binary: string;
  args: string[];
  prompt: string;
  promptMode: PromptMode;
  timeoutMs: number;
  captureLastMessageToFile: boolean;
  adapter: CliAdapter;
};

type CliResolutionSource = "humanAnswer" | "config" | "heuristic";

type FallbackReason = "binary_missing" | "auth_invalid" | "not_eligible";

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.toLowerCase();
  return String(err).toLowerCase();
}

function classifyGeminiFallbackReason(err: unknown): FallbackReason {
  const text = normalizeErrorMessage(err);
  if (
    text.includes("enoent") ||
    text.includes("not found") ||
    text.includes("no such file") ||
    text.includes("could not find")
  ) {
    return "binary_missing";
  }
  if (
    text.includes("unauth") ||
    text.includes("not authenticated") ||
    text.includes("login") ||
    text.includes("api key") ||
    text.includes("credential") ||
    text.includes("permission denied")
  ) {
    return "auth_invalid";
  }
  return "not_eligible";
}

function shouldFallbackFromGemini(err: unknown): boolean {
  const reason = classifyGeminiFallbackReason(err);
  return reason === "binary_missing" || reason === "auth_invalid";
}

function fallbackReasonMessage(reason: FallbackReason): string {
  if (reason === "binary_missing") return "gemini no está instalado o no está en PATH";
  if (reason === "auth_invalid") return "gemini no está autenticado o tiene credenciales inválidas";
  return "fallo no clasificable para fallback automático";
}

export const __cliInternals = {
  adapterForBinary,
  detectRuntimeCapability,
  detectRuntimeCapabilityFromTexts,
  classifyGeminiFallbackReason,
  shouldFallbackFromGemini,
  runtimeCapabilityCache,
};

async function executeCli({
  binary,
  args,
  prompt,
  promptMode,
  timeoutMs,
  captureLastMessageToFile,
  adapter,
}: ExecuteCliOptions): Promise<string> {
  let promptArgIndex = -1;
  if (promptMode === "arg") {
    promptArgIndex = args.length;
    args.push(prompt);
  }

  let outputFilePath: string | null = null;
  if (captureLastMessageToFile) {
    outputFilePath = path.join(
      os.tmpdir(),
      `slad-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    args.push("--output-last-message", outputFilePath);
  }

  const displayArgs = [...args];
  if (promptMode === "arg" && promptArgIndex >= 0) {
    displayArgs[promptArgIndex] = "<prompt>";
  }

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: [promptMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
      env: buildProcessEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      cleanupOutputFile(outputFilePath);
      const seconds = Math.round(timeoutMs / 1000);
      reject(
        new Error(
          `CLI provider (${binary}) timed out after ${seconds}s. ` +
            `Subí el límite con SLAD_CLI_TIMEOUT_MS=<ms> si la tarea es larga.`,
        ),
      );
    }, timeoutMs);

    if (!child.stdout || !child.stderr) {
      clearTimeout(timeout);
      cleanupOutputFile(outputFilePath);
      reject(new Error("CLI provider no pudo abrir stdout/stderr del proceso hijo."));
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupOutputFile(outputFilePath);
      reject(adapter.mapSpawnError(binary, err));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const outputFromFile =
        outputFilePath && fs.existsSync(outputFilePath) ? fs.readFileSync(outputFilePath, "utf8").trim() : "";
      cleanupOutputFile(outputFilePath);

      const stdoutText = stdout.trim();
      const stderrText = stderr.trim();
      if (code !== 0) {
        reject(
          adapter.mapFailure({
            code,
            signal,
            binary,
            displayArgs,
            stdout: stdoutText,
            stderr: stderrText,
          }),
        );
        return;
      }

      const text = adapter.normalizeOutput({
        stdout: stdoutText,
        stderr: stderrText,
        outputFromFile,
      });
      if (!text) {
        const suffix = stderrText ? ` stderr: ${stderrText}` : "";
        reject(
          new ProviderError(`CLI provider no devolvió output.${suffix}`, "cli", {
            retryable: false,
          }),
        );
        return;
      }

      resolve(text);
    });

    if (promptMode === "stdin") {
      if (!child.stdin) {
        clearTimeout(timeout);
        cleanupOutputFile(outputFilePath);
        reject(new Error("CLI provider no pudo abrir stdin del proceso hijo."));
        return;
      }
      child.stdin.end(prompt);
    }
  });
}

export class CLIProvider implements ModelProvider {
  readonly name: ProviderName = "cli";
  private readonly configuredBinary: string | null;
  private readonly configuredArgs: string[] | null;
  private readonly configuredPromptMode: PromptMode | null;
  private readonly configuredModelArg: string | null;
  private readonly timeoutMs: number;
  private readonly discovery: DiscoveryResultType | null;
  private readonly humanAnswers: Record<string, string>;

  constructor() {
    this.configuredBinary = process.env.SLAD_CLI_BINARY?.trim() || null;
    this.configuredArgs = process.env.SLAD_CLI_ARGS ? parseArgs(process.env.SLAD_CLI_ARGS) : null;
    this.timeoutMs = Number.parseInt(process.env.SLAD_CLI_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;
    const configuredPromptMode = process.env.SLAD_CLI_PROMPT_MODE?.trim();
    this.configuredPromptMode = configuredPromptMode === "stdin" || configuredPromptMode === "arg" ? configuredPromptMode : null;
    this.configuredModelArg = process.env.SLAD_CLI_MODEL_ARG?.trim() || null;
    this.discovery = this.loadDiscoveryResult();
    this.humanAnswers = this.loadHumanAnswers();
  }

  private loadDiscoveryResult(): DiscoveryResultType | null {
    const session = getActiveSession();
    if (!session) return null;
    const artifactPath =
      [...session.artifacts].reverse().find((entry) => entry.kind === "cli-discovery")?.path ?? null;
    if (!artifactPath || !fs.existsSync(artifactPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      const parsed = DiscoveryResult.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private loadHumanAnswers(): Record<string, string> {
    const session = getActiveSession();
    if (!session) return {};
    const values: Record<string, string> = {};
    for (const answer of session.humanAnswers) {
      values[answer.questionId] = answer.answer;
    }
    return values;
  }

  private findHumanAnswerBinary(name: string): string | null {
    const direct = parseCliDiscoveryAnswer(this.humanAnswers[`cli-discovery:${name}`]);
    if (direct) return direct;
    if (name !== "default") {
      const wildcard = parseCliDiscoveryAnswer(this.humanAnswers["cli-discovery:default"]);
      if (wildcard) return wildcard;
    }
    return null;
  }

  private pickHeuristicBinary(fallbackBinary: string): string {
    if (!this.discovery) return fallbackBinary;
    if (this.discovery.selected?.binary) return this.discovery.selected.binary;
    if (this.discovery.candidates.length === 0) return fallbackBinary;
    const sorted = [...this.discovery.candidates].sort((a, b) => {
      if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
      if (a.binary !== b.binary) return a.binary.localeCompare(b.binary);
      return a.resolvedPath.localeCompare(b.resolvedPath);
    });
    return sorted[0]?.binary ?? fallbackBinary;
  }

  private resolveBinary(model: string | undefined): { binary: string; source: CliResolutionSource } {
    const detectedAdapterId = detectAdapterIdForModel(model);
    const answerName = detectedAdapterId ?? "default";
    const humanAnswerBinary = this.findHumanAnswerBinary(answerName);
    if (humanAnswerBinary) return { binary: humanAnswerBinary, source: "humanAnswer" };
    if (this.configuredBinary) return { binary: this.configuredBinary, source: "config" };
    // Solo llegar acá si no hay override explícito — ahora sí tiene sentido hacer discovery.
    const fallbackBinary = detectedAdapterId ? defaultBinaryForAdapter(detectedAdapterId) : detectDefaultBinary();
    return { binary: this.pickHeuristicBinary(fallbackBinary), source: "heuristic" };
  }

  private resolveExecutionContext(model: string | undefined): {
    binary: string;
    adapter: CliAdapter;
    args: string[];
    promptMode: PromptMode;
    modelArg: string;
    captureLastMessageToFile: boolean;
  } {
    const resolution = this.resolveBinary(model);
    const binary = resolution.binary;
    const adapter = adapterForBinary(binary);
    const args = this.configuredArgs ? [...this.configuredArgs] : adapter.defaultArgs();
    const modelArg = this.configuredModelArg ?? adapter.modelArg();
    const defaultMode = adapter.defaultPromptMode();
    const preferredMode = this.configuredPromptMode ?? defaultMode;
    let promptMode = adapter.supportsPromptMode(preferredMode) ? preferredMode : defaultMode;

    if (adapter.shouldProbeRuntimeCapability()) {
      const capability = detectRuntimeCapability(binary);
      if (promptMode === "stdin" && !capability.supportsStdin && capability.supportsArg) {
        promptMode = "arg";
      }
      if (this.configuredPromptMode === null && promptMode === defaultMode && defaultMode !== "stdin" && capability.supportsStdin) {
        promptMode = "stdin";
      }
    }

    log.info(`cli · usando ${binary} (${resolution.source})`);
    log.debug("cli binary resolved", {
      source: resolution.source,
      binary,
      model: model ?? "",
      hasDiscovery: Boolean(this.discovery),
    });

    return {
      binary,
      adapter,
      args,
      promptMode,
      modelArg,
      captureLastMessageToFile: adapter.shouldCaptureLastMessageToFile(),
    };
  }

  private resolveFallbackChain(model: string | undefined): Array<{
    binary: string;
    adapter: CliAdapter;
    args: string[];
    promptMode: PromptMode;
    modelArg: string;
    captureLastMessageToFile: boolean;
  }> {
    const primary = this.resolveExecutionContext(model);
    if (primary.adapter.id !== "gemini") return [primary];

    const chain = [primary];
    const fallbackAdapters: AdapterId[] = ["codex", "claude"];
    for (const adapterId of fallbackAdapters) {
      const binary = defaultBinaryForAdapter(adapterId);
      if (chain.some((entry) => entry.binary === binary)) continue;
      const adapter = adapterForBinary(binary);
      const args = this.configuredArgs ? [...this.configuredArgs] : adapter.defaultArgs();
      const modelArg = this.configuredModelArg ?? adapter.modelArg();
      const defaultMode = adapter.defaultPromptMode();
      const preferredMode = this.configuredPromptMode ?? defaultMode;
      const promptMode = adapter.supportsPromptMode(preferredMode) ? preferredMode : defaultMode;
      chain.push({
        binary,
        adapter,
        args,
        promptMode,
        modelArg,
        captureLastMessageToFile: adapter.shouldCaptureLastMessageToFile(),
      });
    }
    return chain;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    const prompt = buildPrompt(messages, opts);
    const chain = this.resolveFallbackChain(opts.model);
    const attempted: string[] = [];
    const reasons: string[] = [];
    let lastError: Error | null = null;

    for (let i = 0; i < chain.length; i += 1) {
      const context = chain[i];
      attempted.push(context.binary);
      if (context.modelArg && opts.model) {
        context.args.push(context.modelArg, opts.model);
      }
      try {
        const output = await executeCli({
          binary: context.binary,
          args: context.args,
          prompt,
          promptMode: context.promptMode,
          timeoutMs: this.timeoutMs,
          captureLastMessageToFile: context.captureLastMessageToFile,
          adapter: context.adapter,
        });
        if (i > 0) {
          process.stderr.write(
            `[slad][cli] fallback aplicado: gemini -> ${context.adapter.id}. Motivos: ${reasons.join(" | ")}\n`,
          );
        }
        return output;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (i === 0 && context.adapter.id === "gemini" && shouldFallbackFromGemini(lastError)) {
          const reason = classifyGeminiFallbackReason(lastError);
          reasons.push(fallbackReasonMessage(reason));
          continue;
        }
        throw lastError;
      }
    }

    throw new CliFallbackError(
      `Fallback automático desde gemini agotado. Intentos: ${attempted.join(" -> ")}. Motivos: ${reasons.join(" | ") || "sin motivo clasificado"}.`,
      { attempted, reasons, cause: lastError ?? undefined },
    );
  }
}
