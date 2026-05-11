import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { FunctionDeclarationsTool } from "@google/generative-ai";
import type { ModelProvider, ToolUseOptions } from "./index.js";
import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";
import type { ProviderResponse, ToolDefinition } from "../tools/types.js";
import { ProviderError } from "../core/errors.js";

const DEFAULT_MODEL = "gemini-1.5-pro";

// Maps SLAD's parameter types to Gemini's SchemaType enum
const TYPE_MAP: Record<string, SchemaType> = {
  string: SchemaType.STRING,
  number: SchemaType.NUMBER,
  boolean: SchemaType.BOOLEAN,
  array: SchemaType.ARRAY,
};

function toGeminiTools(defs: ToolDefinition[]): FunctionDeclarationsTool[] {
  return [
    {
      functionDeclarations: defs.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: Object.fromEntries(
            t.parameters.map((p) => [
              p.name,
              {
                type: TYPE_MAP[p.type] ?? SchemaType.STRING,
                description: p.description,
                ...(p.enum ? { enum: p.enum } : {}),
              },
            ]),
          ),
          required: t.parameters.filter((p) => p.required !== false).map((p) => p.name),
        },
      })),
    },
  ];
}

function fromGeminiResponse(
  res: Awaited<ReturnType<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["generateContent"]>>,
): ProviderResponse {
  const functionCalls = res.response.functionCalls();

  if (functionCalls && functionCalls.length > 0) {
    return {
      type: "tool_use",
      toolCalls: functionCalls.map((fc, i) => ({
        id: `gemini-tc-${i}-${fc.name}`,
        name: fc.name,
        arguments: fc.args as Record<string, unknown>,
      })),
      textParts: [],
    };
  }

  return { type: "text", content: res.response.text().trim() };
}

export class GeminiProvider implements ModelProvider {
  readonly name: ProviderName = "gemini";
  readonly supportsToolUse = true;
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<string> {
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
      const retryable = apiErr.status === 429 || apiErr.status === 500;
      throw new ProviderError(
        apiErr.message ?? "Gemini API error",
        "gemini",
        { statusCode: apiErr.status, retryable, cause: err as Error },
      );
    }
    return res.response.text().trim();
  }

  async completeWithTools(messages: ChatMessage[], opts: ToolUseOptions): Promise<ProviderResponse> {
    const systemFromMessages = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const systemInstruction = opts.systemPrompt ?? systemFromMessages ?? undefined;

    const model = this.client.getGenerativeModel({
      model: opts.model ?? DEFAULT_MODEL,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxTokens ?? 4096,
      },
    });

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const tools = toGeminiTools(opts.tools);

    let res: Awaited<ReturnType<typeof model.generateContent>>;
    try {
      res = await model.generateContent({ contents, tools });
    } catch (err: unknown) {
      const apiErr = err as { status?: number; message?: string };
      const retryable = apiErr.status === 429 || apiErr.status === 500;
      throw new ProviderError(
        apiErr.message ?? "Gemini API error",
        "gemini",
        { statusCode: apiErr.status, retryable, cause: err as Error },
      );
    }

    return fromGeminiResponse(res);
  }
}
