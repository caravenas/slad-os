import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition, ProviderResponse } from "../tools/types.js";
import type { ToolUseOptions } from "./index.js";
import type { ChatMessage } from "../core/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sampleTools: ToolDefinition[] = [
  {
    name: "write_file",
    description: "Write content to a file",
    permissionLevel: "read" as const,
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "content", type: "string", description: "File content", required: true },
    ],
  },
  {
    name: "read_file",
    description: "Read a file",
    permissionLevel: "read" as const,
    parameters: [
      { name: "path", type: "string", description: "File path", required: true },
      { name: "encoding", type: "string", description: "Encoding", required: false, enum: ["utf8", "base64"] },
    ],
  },
];

const messages: ChatMessage[] = [{ role: "user", content: "do something" }];

// ─── Mock SDK factory ─────────────────────────────────────────────────────────

function makeMockSDK(responseOverride?: {
  text?: () => string;
  functionCalls?: () => Array<{ name: string; args: object }> | undefined;
}) {
  const defaultResponse = {
    text: () => "hello from gemini",
    functionCalls: () => undefined,
    ...responseOverride,
  };

  return {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: defaultResponse,
      }),
    }),
  };
}

// ─── Unit: toGeminiTools mapping ──────────────────────────────────────────────

describe("GeminiProvider — tool definition mapping", () => {
  test("supportsToolUse is true", async () => {
    // We can test this without hitting the network by importing and checking
    const { GeminiProvider } = await import("./gemini.js");
    const p = new GeminiProvider("fake-key");
    assert.equal(p.supportsToolUse, true);
  });
});

// ─── Unit: completeWithTools with mock SDK ────────────────────────────────────

describe("GeminiProvider.completeWithTools — mock SDK", () => {
  test("returns text response when model emits no function calls", async () => {
    const { GeminiProvider } = await import("./gemini.js");
    const provider = new GeminiProvider("fake-key");

    // Replace the internal client with a mock
    const mockClient = makeMockSDK({ text: () => "final answer", functionCalls: () => undefined });
    (provider as unknown as { client: unknown }).client = mockClient;

    const opts: ToolUseOptions = { tools: sampleTools };
    const result: ProviderResponse = await provider.completeWithTools(messages, opts);

    assert.equal(result.type, "text");
    assert.equal((result as { type: "text"; content: string }).content, "final answer");
  });

  test("returns tool_use response when model emits function calls", async () => {
    const { GeminiProvider } = await import("./gemini.js");
    const provider = new GeminiProvider("fake-key");

    const mockClient = makeMockSDK({
      text: () => { throw new Error("should not be called"); },
      functionCalls: () => [
        { name: "write_file", args: { path: "foo.ts", content: "hello" } },
      ],
    });
    (provider as unknown as { client: unknown }).client = mockClient;

    const opts: ToolUseOptions = { tools: sampleTools };
    const result: ProviderResponse = await provider.completeWithTools(messages, opts);

    assert.equal(result.type, "tool_use");
    const toolResult = result as { type: "tool_use"; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; textParts: string[] };
    assert.equal(toolResult.toolCalls.length, 1);
    assert.equal(toolResult.toolCalls[0].name, "write_file");
    assert.deepEqual(toolResult.toolCalls[0].arguments, { path: "foo.ts", content: "hello" });
    assert.deepEqual(toolResult.textParts, []);
  });

  test("tool call IDs are unique strings", async () => {
    const { GeminiProvider } = await import("./gemini.js");
    const provider = new GeminiProvider("fake-key");

    const mockClient = makeMockSDK({
      functionCalls: () => [
        { name: "read_file", args: { path: "a.ts" } },
        { name: "write_file", args: { path: "b.ts", content: "x" } },
      ],
    });
    (provider as unknown as { client: unknown }).client = mockClient;

    const opts: ToolUseOptions = { tools: sampleTools };
    const result = await provider.completeWithTools(messages, opts) as { type: "tool_use"; toolCalls: Array<{ id: string }> };

    assert.equal(result.type, "tool_use");
    assert.equal(result.toolCalls.length, 2);
    const ids = result.toolCalls.map((tc) => tc.id);
    assert.notEqual(ids[0], ids[1]);
    assert.ok(typeof ids[0] === "string" && ids[0].length > 0);
  });

  test("wraps SDK errors as ProviderError", async () => {
    const { GeminiProvider } = await import("./gemini.js");
    const { ProviderError } = await import("../core/errors.js");
    const provider = new GeminiProvider("fake-key");

    const mockClient = {
      getGenerativeModel: () => ({
        generateContent: async () => { throw { status: 429, message: "rate limited" }; },
      }),
    };
    (provider as unknown as { client: unknown }).client = mockClient;

    const opts: ToolUseOptions = { tools: sampleTools };
    await assert.rejects(
      () => provider.completeWithTools(messages, opts),
      (err) => err instanceof ProviderError && err.message === "rate limited",
    );
  });
});

// ─── Integration: toolLoop + GeminiProvider ───────────────────────────────────

describe("toolLoop integration with GeminiProvider mock", () => {
  test("runs a full tool-use round and returns final text", async () => {
    const { GeminiProvider } = await import("./gemini.js");
    const { toolLoop } = await import("./tool-loop.js");
    const { ToolExecutor } = await import("../tools/executor.js");
    const { createDefaultRegistry } = await import("../tools/registry.js");
    const os = await import("node:os");

    const provider = new GeminiProvider("fake-key");

    let callCount = 0;
    const mockClient = {
      getGenerativeModel: () => ({
        generateContent: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              response: {
                functionCalls: () => [{ name: "exec", args: { command: "echo integration-test" } }],
                text: () => "",
              },
            };
          }
          return {
            response: {
              functionCalls: () => undefined,
              text: () => '{"taskId":"T1","status":"completed","summary":"done"}',
            },
          };
        },
      }),
    };
    (provider as unknown as { client: unknown }).client = mockClient;

    const registry = createDefaultRegistry();
    const executor = new ToolExecutor(registry, { cwd: os.default.tmpdir(), harness: null });
    const msgs: ChatMessage[] = [{ role: "user", content: "do the task" }];

    const result = await toolLoop(provider, msgs, executor, { tools: registry.definitions() });

    assert.match(result, /"status":"completed"/);
    assert.equal(callCount, 2);
  });
});
