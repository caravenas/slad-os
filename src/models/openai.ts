import OpenAI from "openai";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import { ProviderError } from "../core/errors.js";

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

    let res: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
    try {
      res = await this.client.chat.completions.create({
        model: opts.model ?? DEFAULT_MODEL,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 4096,
        messages: withSystem.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });
    } catch (err: unknown) {
      const apiErr = err as { status?: number; message?: string };
      const retryable =
        apiErr.status === 429 || apiErr.status === 500;
      throw new ProviderError(
        apiErr.message ?? "OpenAI API error",
        "openai",
        { statusCode: apiErr.status, retryable, cause: err as Error },
      );
    }

    const text = res.choices[0]?.message?.content ?? "";
    return text.trim();
  }
}
