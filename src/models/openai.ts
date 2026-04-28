import OpenAI from "openai";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";

const DEFAULT_MODEL = "gpt-4o";

export class OpenAIProvider implements ModelProvider {
  readonly name: ProviderName = "openai";
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    const withSystem: ChatMessage[] = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages.filter((m) => m.role !== "system")]
      : messages;

    const res = await this.client.chat.completions.create({
      model: opts.model ?? DEFAULT_MODEL,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 4096,
      messages: withSystem.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const text = res.choices[0]?.message?.content ?? "";
    return text.trim();
  }
}
