import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { toolLoop } from "./tool-loop.js";
import type { ToolLoopOpts } from "./tool-loop.js";
import { ToolExecutor } from "../tools/executor.js";
import { createDefaultRegistry } from "../tools/registry.js";
import type { ModelProvider, ToolUseOptions } from "./index.js";
import type { ChatMessage } from "../core/types.js";
import type { ProviderResponse } from "../tools/types.js";

// ─── Mock provider helpers ────────────────────────────────────────────────────

function makeTextProvider(text: string): ModelProvider {
  return {
    name: "anthropic",
    supportsToolUse: true,
    async complete(_msgs, _opts) {
      return text;
    },
    async completeWithTools(_msgs, _opts): Promise<ProviderResponse> {
      return { type: "text", content: text };
    },
  };
}

function makeToolThenTextProvider(toolName: string, toolArgs: Record<string, unknown>, finalText: string): ModelProvider {
  let calls = 0;
  return {
    name: "anthropic",
    supportsToolUse: true,
    async complete(_msgs, _opts) {
      return finalText;
    },
    async completeWithTools(_msgs, _opts): Promise<ProviderResponse> {
      calls++;
      if (calls === 1) {
        return {
          type: "tool_use",
          toolCalls: [{ id: `tc-${calls}`, name: toolName, arguments: toolArgs }],
          textParts: [],
        };
      }
      return { type: "text", content: finalText };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const cwd = os.tmpdir();

describe("toolLoop", () => {
  test("returns text directly when provider responds with text on first call", async () => {
    const provider = makeTextProvider('{"taskId":"T1","status":"completed","summary":"done"}');
    const registry = createDefaultRegistry();
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const messages: ChatMessage[] = [{ role: "user", content: "do the task" }];
    const opts: ToolUseOptions = { tools: registry.definitions() };

    const result = await toolLoop(provider, messages, executor, opts);
    assert.match(result, /"status":"completed"/);
  });

  test("falls back to complete() for providers without tool use", async () => {
    const provider: ModelProvider = {
      name: "gemini",
      supportsToolUse: false,
      async complete(_msgs, _opts) {
        return "fallback response";
      },
    };
    const registry = createDefaultRegistry();
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    const opts: ToolUseOptions = { tools: registry.definitions() };

    const result = await toolLoop(provider, messages, executor, opts);
    assert.equal(result, "fallback response");
  });

  test("executes one tool round then returns final text", async () => {
    const provider = makeToolThenTextProvider(
      "exec",
      { command: "echo tool-was-called" },
      '{"taskId":"T2","status":"completed","summary":"ran tool"}',
    );
    const registry = createDefaultRegistry();
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    const opts: ToolLoopOpts = { tools: registry.definitions(), maxToolRounds: 5 };

    const toolCallNames: string[] = [];
    const result = await toolLoop(provider, messages, executor, {
      ...opts,
      onToolCall: (name) => { toolCallNames.push(name); },
    });

    assert.deepEqual(toolCallNames, ["exec"]);
    assert.match(result, /"status":"completed"/);
  });

  test("onToolResult callback is called with result", async () => {
    const provider = makeToolThenTextProvider(
      "exec",
      { command: "echo callback-test" },
      '{"taskId":"T3","status":"completed","summary":"ok"}',
    );
    const registry = createDefaultRegistry();
    const executor = new ToolExecutor(registry, { cwd, harness: null });
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    const results: Array<{ name: string; success: boolean }> = [];

    await toolLoop(provider, messages, executor, {
      tools: registry.definitions(),
      onToolResult: (name, result) => { results.push({ name, success: result.success }); },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].name, "exec");
    assert.ok(results[0].success);
  });
});
