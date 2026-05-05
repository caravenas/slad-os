import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import { ProviderError } from "../core/errors.js";

const DEFAULT_MODEL = "MiniMax-M2.7";

export class AnthropicProvider implements ModelProvider {
  readonly name: ProviderName = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    // Anthropic takes `system` separately from the message list.
    const systemFromMessages = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const system = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const chat = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    let res: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      res = await this.client.messages.create({
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.4,
        ...(system ? { system } : {}),
        messages: chat,
      });
    } catch (err: unknown) {
      const apiErr = err as { status?: number; message?: string };
      const retryable =
        apiErr.status === 429 || apiErr.status === 529 || apiErr.status === 500;
      throw new ProviderError(
        apiErr.message ?? "Anthropic API error",
        "anthropic",
        { statusCode: apiErr.status, retryable, cause: err as Error },
      );
    }

    // The SDK returns a union of content blocks; we only care about text.
    const text = res.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return text.trim();
  }
}
