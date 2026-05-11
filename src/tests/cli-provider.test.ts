import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { __cliInternals } from "../models/cli.js";

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
}

describe("CLIProvider internals", () => {
  beforeEach(() => {
    mock.restoreAll();
    restoreEnv();
    __cliInternals.runtimeCapabilityCache.clear();
  });

  it("supports adapter/mode matrix for codex, claude and gemini", () => {
    const codex = __cliInternals.adapterForBinary("codex");
    const claude = __cliInternals.adapterForBinary("claude");
    const gemini = __cliInternals.adapterForBinary("gemini");

    assert.equal(codex.supportsPromptMode("stdin"), true);
    assert.equal(codex.supportsPromptMode("arg"), true);
    assert.equal(claude.supportsPromptMode("stdin"), false);
    assert.equal(claude.supportsPromptMode("arg"), true);
    assert.equal(gemini.supportsPromptMode("stdin"), true);
    assert.equal(gemini.supportsPromptMode("arg"), true);
  });

  it("detects runtime capabilities from --help/--version (positive)", () => {
    const capability = __cliInternals.detectRuntimeCapabilityFromTexts(
      "gemini",
      "Use stdin for input, or provide <prompt>",
      "v1.0.0",
    );
    assert.deepEqual(capability, { supportsStdin: true, supportsArg: true, supportsOutputLastMessage: false });
  });

  it("detects runtime capabilities from --help/--version (negative)", () => {
    const capability = __cliInternals.detectRuntimeCapabilityFromTexts("gemini", "Usage: gemini [input]", "v1.0.0");
    assert.deepEqual(capability, { supportsStdin: false, supportsArg: true, supportsOutputLastMessage: false });
  });

  it("detects --output-last-message support in codex help", () => {
    const capability = __cliInternals.detectRuntimeCapabilityFromTexts(
      "codex",
      "exec [options]\n  --output-last-message <file>  write last assistant message to file\n  --skip-git-repo-check",
      "v1.0.0",
    );
    assert.equal(capability.supportsOutputLastMessage, true);
  });

  it("detects absence of --output-last-message in older codex", () => {
    const capability = __cliInternals.detectRuntimeCapabilityFromTexts(
      "codex",
      "exec [options]\n  --skip-git-repo-check\n  --color <mode>",
      "v0.9.0",
    );
    assert.equal(capability.supportsOutputLastMessage, false);
  });

  it("classifies fallback for missing gemini binary", () => {
    const err = new Error("spawn gemini ENOENT");
    assert.equal(__cliInternals.classifyGeminiFallbackReason(err), "binary_missing");
    assert.equal(__cliInternals.shouldFallbackFromGemini(err), true);
  });

  it("classifies fallback for invalid gemini auth", () => {
    const err = new Error("Not authenticated. Please login or provide API key");
    assert.equal(__cliInternals.classifyGeminiFallbackReason(err), "auth_invalid");
    assert.equal(__cliInternals.shouldFallbackFromGemini(err), true);
  });

  it("does not fallback for unrelated gemini failures", () => {
    const err = new Error("unexpected parser panic");
    assert.equal(__cliInternals.classifyGeminiFallbackReason(err), "not_eligible");
    assert.equal(__cliInternals.shouldFallbackFromGemini(err), false);
  });

  it("normalizes codex output preserving JSON/extractJson-compatible shape", () => {
    const codex = __cliInternals.adapterForBinary("codex");
    const normalized = codex.normalizeOutput({
      stdout: "ignored stdout",
      stderr: "",
      outputFromFile: '```json\n{"ok":true}\n```\n',
    });

    assert.equal(normalized, '```json\n{"ok":true}\n```');
  });
});
