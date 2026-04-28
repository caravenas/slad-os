import type { ChatMessage, CompletionOptions, ProviderName } from "../core/types.js";

/**
 * Minimal contract every provider must satisfy.
 * This is the seam that isolates the rest of the CLI from vendor SDKs.
 */
export interface ModelProvider {
  readonly name: ProviderName;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<string>;
}

export async function getProvider(name: ProviderName, apiKey?: string): Promise<ModelProvider> {
  switch (name) {
    case "anthropic": {
      if (!apiKey) throw new Error("Anthropic provider requiere ANTHROPIC_API_KEY.");
      const { AnthropicProvider } = await import("./anthropic.js");
      return new AnthropicProvider(apiKey);
    }
    case "openai": {
      if (!apiKey) throw new Error("OpenAI provider requiere OPENAI_API_KEY.");
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider(apiKey);
    }
    case "gemini": {
      if (!apiKey) throw new Error("Gemini provider requiere GEMINI_API_KEY o GOOGLE_API_KEY.");
      const { GeminiProvider } = await import("./gemini.js");
      return new GeminiProvider(apiKey);
    }
    case "cli": {
      const { CLIProvider } = await import("./cli.js");
      return new CLIProvider();
    }
  }
}
