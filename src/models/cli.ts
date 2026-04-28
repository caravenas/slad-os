import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";

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

function commandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { stdio: "ignore" });
  return result.status === 0;
}

function binaryName(binary: string): string {
  return path.basename(binary).replace(/\.exe$/i, "").toLowerCase();
}

function detectDefaultBinary(): string {
  if (commandExists("codex")) return "codex";
  if (commandExists("claude")) return "claude";
  return "claude";
}

function defaultArgs(binary: string): string[] {
  if (binaryName(binary) === "codex") {
    return ["exec", "--skip-git-repo-check", "--color", "never"];
  }
  return ["--print"];
}

function defaultPromptMode(binary: string): PromptMode {
  return binaryName(binary) === "codex" ? "stdin" : "arg";
}

function defaultModelArg(binary: string): string {
  return binaryName(binary) === "codex" ? "--model" : "--model";
}

function shouldCaptureLastMessageToFile(binary: string): boolean {
  return binaryName(binary) === "codex";
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

export class CLIProvider implements ModelProvider {
  readonly name: ProviderName = "cli";
  private readonly binary: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly promptMode: PromptMode;
  private readonly modelArg: string;
  private readonly captureLastMessageToFile: boolean;

  constructor() {
    this.binary = process.env.SLAD_CLI_BINARY?.trim() || detectDefaultBinary();
    this.args = process.env.SLAD_CLI_ARGS ? parseArgs(process.env.SLAD_CLI_ARGS) : defaultArgs(this.binary);
    this.timeoutMs = Number.parseInt(process.env.SLAD_CLI_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;
    const promptMode = process.env.SLAD_CLI_PROMPT_MODE?.trim() || defaultPromptMode(this.binary);
    this.promptMode = promptMode === "stdin" ? "stdin" : "arg";
    this.modelArg = process.env.SLAD_CLI_MODEL_ARG?.trim() ?? defaultModelArg(this.binary);
    this.captureLastMessageToFile = shouldCaptureLastMessageToFile(this.binary);
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    const args = [...this.args];
    if (this.modelArg && opts.model) {
      args.push(this.modelArg, opts.model);
    }

    const prompt = buildPrompt(messages, opts);
    let promptArgIndex = -1;
    if (this.promptMode === "arg") {
      promptArgIndex = args.length;
      args.push(prompt);
    }
    let outputFilePath: string | null = null;
    if (this.captureLastMessageToFile) {
      outputFilePath = path.join(
        os.tmpdir(),
        `slad-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      args.push("--output-last-message", outputFilePath);
    }
    const displayArgs = [...args];
    if (this.promptMode === "arg" && promptArgIndex >= 0) {
      displayArgs[promptArgIndex] = "<prompt>";
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: [this.promptMode === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
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
        const seconds = Math.round(this.timeoutMs / 1000);
        reject(
          new Error(
            `CLI provider (${this.binary}) timed out after ${seconds}s. ` +
              `Subí el límite con SLAD_CLI_TIMEOUT_MS=<ms> si la tarea es larga.`,
          ),
        );
      }, this.timeoutMs);

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
        reject(new Error(`No se pudo ejecutar el CLI provider "${this.binary}": ${err.message}`));
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const outputFromFile =
          outputFilePath && fs.existsSync(outputFilePath) ? fs.readFileSync(outputFilePath, "utf8").trim() : "";
        cleanupOutputFile(outputFilePath);

        if (code !== 0) {
          const stdoutText = stdout.trim();
          const stderrText = stderr.trim();
          const suffix = [
            stdoutText ? `stdout:\n${stdoutText}` : "",
            stderrText ? `stderr:\n${stderrText}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          reject(
            new Error(
              `CLI provider falló con código ${code ?? `signal ${signal}`}: ${this.binary} ${displayArgs.join(" ")}${
                suffix ? `\n\n${suffix}` : ""
              }`,
            ),
          );
          return;
        }

        const text = outputFromFile || stdout.trim();
        if (!text) {
          const suffix = stderr.trim() ? ` stderr: ${stderr.trim()}` : "";
          reject(new Error(`CLI provider no devolvió output.${suffix}`));
          return;
        }

        resolve(text);
      });

      if (this.promptMode === "stdin") {
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
}
