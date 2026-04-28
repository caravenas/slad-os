import Anthropic from "@anthropic-ai/sdk";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";

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

    const res = await this.client.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.4,
      ...(system ? { system } : {}),
      messages: chat,
    });

    // The SDK returns a union of content blocks; we only care about text.
    const text = res.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return text.trim();
  }
}
