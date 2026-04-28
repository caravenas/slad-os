import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { AgentName, DevAgentConfig, ProviderName, type ProviderName as ProviderNameType } from "./types.js";

const DEFAULT_MODELS: Record<ProviderNameType, string> = {
  anthropic: "MiniMax-M2.7",
  openai: "gpt-4o",
  gemini: "gemini-1.5-pro",
  cli: "",
};

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Load environment variables from the project-level .env.
 */
export function loadEnv(cwd: string = process.cwd()): void {
  const localEnv = path.join(cwd, ".env");

  if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv, override: true });
}

/**
 * Resolve config from environment variables.
 * CLI flags are still applied by callers before using these defaults.
 */
export function loadConfig(): DevAgentConfig {
  return DevAgentConfig.parse({
    defaultProvider: envValue("SLAD_DEFAULT_PROVIDER"),
    wikiPath: envValue("SLAD_WIKI_PATH"),
  });
}

/**
 * Pull the API key for a given provider from the environment.
 * Returns null if missing — commands decide how to handle it.
 */
export function getApiKey(provider: ProviderNameType): string | null {
  switch (provider) {
    case "anthropic":
      return envValue("ANTHROPIC_API_KEY") ?? null;
    case "openai":
      return envValue("OPENAI_API_KEY") ?? null;
    case "gemini":
      return envValue("GEMINI_API_KEY") ?? envValue("GOOGLE_API_KEY") ?? null;
    case "cli":
      return null;
  }
}

/**
 * Resolve the model from environment variables.
 * Provider-specific vars win over the shared fallback.
 */
export function getModel(provider: ProviderNameType): string {
  switch (provider) {
    case "anthropic":
      return envValue("ANTHROPIC_MODEL") ?? envValue("SLAD_MODEL") ?? DEFAULT_MODELS.anthropic;
    case "openai":
      return envValue("OPENAI_MODEL") ?? envValue("SLAD_MODEL") ?? DEFAULT_MODELS.openai;
    case "gemini":
      return envValue("GEMINI_MODEL") ?? envValue("GOOGLE_MODEL") ?? envValue("SLAD_MODEL") ?? DEFAULT_MODELS.gemini;
    case "cli":
      return envValue("CLI_MODEL") ?? DEFAULT_MODELS.cli;
  }
}

export function resolveProvider(
  provider: string | undefined,
  agent: string | undefined,
  defaultProvider: ProviderNameType,
): ProviderNameType {
  if (!agent) {
    return ProviderName.parse(provider ?? defaultProvider);
  }

  const selectedAgent = AgentName.parse(agent);
  process.env.SLAD_DEFAULT_PROVIDER = "cli";
  process.env.SLAD_CLI_MODEL_ARG = "--model";
  process.env.SLAD_CLI_INHERIT_API_KEYS ??= "false";

  switch (selectedAgent) {
    case "codex":
      process.env.SLAD_CLI_BINARY = "codex";
      process.env.SLAD_CLI_ARGS = "exec --skip-git-repo-check --color never";
      process.env.SLAD_CLI_PROMPT_MODE = "stdin";
      process.env.CLI_MODEL = "";
      return "cli";
    case "claude":
      process.env.SLAD_CLI_BINARY = "claude";
      process.env.SLAD_CLI_ARGS = "--print";
      process.env.SLAD_CLI_PROMPT_MODE = "arg";
      if (!envValue("CLI_MODEL")) process.env.CLI_MODEL = "sonnet";
      return "cli";
  }
}
