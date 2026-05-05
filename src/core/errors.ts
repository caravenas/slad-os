/**
 * Typed error classes for SLAD OS.
 * Allows granular catch blocks and structured error reporting with context.
 */

/**
 * Base error for SLAD OS. All custom classes inherit from this.
 */
export class SladError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "SladError";
    this.code = code;
    this.context = context;
  }
}

/**
 * Communication error with the LLM provider.
 * Includes provider name, status code if applicable, and whether it's retryable.
 */
export class ProviderError extends SladError {
  readonly provider: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    provider: string,
    opts: { statusCode?: number; retryable?: boolean; cause?: Error } = {},
  ) {
    super(message, "PROVIDER_ERROR", { provider, statusCode: opts.statusCode });
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable ?? false;
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * CLI fallback error that preserves all attempted adapters and root causes.
 */
export class CliFallbackError extends ProviderError {
  readonly attempted: string[];
  readonly reasons: string[];

  constructor(message: string, opts: { attempted: string[]; reasons: string[]; cause?: Error }) {
    super(message, "cli", { retryable: false, cause: opts.cause });
    this.name = "CliFallbackError";
    this.attempted = opts.attempted;
    this.reasons = opts.reasons;
  }
}

/**
 * Parsing/validation error for LLM output.
 * Preserves the raw text that failed and the Zod issues.
 */
export class SchemaError extends SladError {
  readonly rawOutput: string;
  readonly zodIssues: string[];

  constructor(
    message: string,
    rawOutput: string,
    zodIssues: string[],
    stage?: string,
  ) {
    super(message, "SCHEMA_ERROR", { stage, issueCount: zodIssues.length });
    this.name = "SchemaError";
    this.rawOutput = rawOutput;
    this.zodIssues = zodIssues;
  }
}

/**
 * Configuration error (missing API key, invalid provider, etc.)
 */
export class ConfigError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "CONFIG_ERROR", context);
    this.name = "ConfigError";
  }
}

/**
 * Session error (session not found, missing artifact, etc.)
 */
export class SessionError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "SESSION_ERROR", context);
    this.name = "SessionError";
  }
}

/**
 * Harness error (task blocked, hook failed, etc.)
 */
export class HarnessError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "HARNESS_ERROR", context);
    this.name = "HarnessError";
  }
}

/**
 * CLI version resolution error (missing package.json, invalid JSON, missing version field).
 */
export class VersionError extends SladError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, "VERSION_ERROR", context);
    this.name = "VersionError";
  }
}

/**
 * Determines whether an error is retryable (e.g. rate limit).
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  return false;
}
