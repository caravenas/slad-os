import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ModelProvider } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import { ProviderError } from "../core/errors.js";

const DEFAULT_MODEL = "gemini-1.5-pro";

export class GeminiProvider implements ModelProvider {
  readonly name: ProviderName = "gemini";
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
    // Gemini expects a separate systemInstruction and user/model turns.
    const systemFromMessages = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const systemInstruction = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const model = this.client.getGenerativeModel({
      model: opts.model ?? DEFAULT_MODEL,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 4096,
      },
    });

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    let res: Awaited<ReturnType<typeof model.generateContent>>;
    try {
      res = await model.generateContent({ contents });
    } catch (err: unknown) {
      const apiErr = err as { status?: number; message?: string };
      const retryable =
        apiErr.status === 429 || apiErr.status === 500;
      throw new ProviderError(
        apiErr.message ?? "Gemini API error",
        "gemini",
        { statusCode: apiErr.status, retryable, cause: err as Error },
      );
    }
    return res.response.text().trim();
  }
}
