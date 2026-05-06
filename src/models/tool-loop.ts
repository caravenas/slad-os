import type { ModelProvider, ToolUseOptions } from "./index.js";
import type { ChatMessage } from "../core/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolResult, ProviderResponse } from "../tools/types.js";
import type { Scratchpad } from "../context/scratchpad.js";
import { log } from "../core/logger.js";

export interface ToolLoopOpts extends ToolUseOptions {
  /** Maximum tool-use rounds before forcing a final text response (default: 10) */
  maxToolRounds?: number;
  /** Called when the LLM requests a tool call — useful for UI feedback */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** Called when a tool result is ready */
  onToolResult?: (name: string, result: ToolResult) => void;
  /**
   * Scratchpad instance for offloading large tool results to disk.
   * If null/undefined, all results remain in context (original behavior).
   */
  scratchpad?: Scratchpad | null;
}

/**
 * Generic tool-use loop (provider-agnostic).
 *
 * Orchestrates: LLM → tool_use → execute → results → LLM → ... → final text.
 *
 * Each provider handles its own message format for tool results internally.
 * This loop passes results back as user messages in a format both Anthropic
 * and OpenAI can understand (stringified content).
 *
 * Falls back to provider.complete() if the provider doesn't support tool use.
 *
 * When a Scratchpad is provided, large tool results are offloaded to disk and
 * replaced with a compact summary + hint to re-read if needed. This keeps the
 * context window bounded during long multi-round tool use sessions.
 */
export async function toolLoop(
  provider: ModelProvider,
  messages: ChatMessage[],
  executor: ToolExecutor,
  opts: ToolLoopOpts,
): Promise<string> {
  // Fallback: provider without tool use → use plain complete()
  if (!provider.completeWithTools || !provider.supportsToolUse) {
    log.debug("toolLoop: provider no soporta tool use, usando complete() como fallback");
    return provider.complete(messages, opts);
  }

  const maxRounds = opts.maxToolRounds ?? 10;
  // We maintain our own message history that grows with each tool round
  let currentMessages: ChatMessage[] = [...messages];
  let rounds = 0;

  while (rounds < maxRounds) {
    const response: ProviderResponse = await provider.completeWithTools(currentMessages, opts);

    // Done — LLM returned final text
    if (response.type === "text") {
      return response.content;
    }

    // Process each tool call sequentially
    const results: ToolResult[] = [];
    for (const call of response.toolCalls) {
      opts.onToolCall?.(call.name, call.arguments as Record<string, unknown>);
      const result = await executor.execute(call);
      results.push(result);
      opts.onToolResult?.(call.name, result);
    }

    // Append the assistant turn (with tool calls) to the conversation history.
    // We serialize the tool call info as text so it works across both Anthropic
    // and OpenAI conversation formats without provider-specific message types.
    const assistantText = [
      ...(response.textParts.length > 0 ? response.textParts : []),
      ...response.toolCalls.map(
        (tc) => `[tool_call:${tc.name}] ${JSON.stringify(tc.arguments)}`,
      ),
    ].join("\n");

    currentMessages.push({ role: "assistant", content: assistantText });

    // Append tool results as a user message.
    // If a scratchpad is configured, large outputs are offloaded to disk.
    const resultsText = results
      .map((r, i) => {
        const call = response.toolCalls[i]!;
        const header = `[tool_result:${r.toolCallId}] ${r.success ? "✓" : "✗"}`;

        if (opts.scratchpad) {
          // processResult handles threshold check internally and returns either
          // the full output (short) or a summary+hint (long).
          const body = opts.scratchpad.processResult(call, r, rounds);
          return `${header}\n${body}`;
        }

        // No scratchpad: original behavior
        const body = r.success ? r.output : `ERROR: ${r.error}`;
        return `${header}\n${body}`;
      })
      .join("\n\n");

    currentMessages.push({ role: "user", content: resultsText });

    rounds++;
  }

  // Rounds exhausted — ask the LLM to produce a final text response without tools
  log.warn(`toolLoop: ${maxRounds} rounds de tool use alcanzados, cerrando sin más tools`);
  currentMessages.push({
    role: "user",
    content: "Has alcanzado el límite de rounds de tool use. Por favor produce el RunOutput JSON final con lo que lograste hasta ahora.",
  });
  return provider.complete(currentMessages, opts);
}
