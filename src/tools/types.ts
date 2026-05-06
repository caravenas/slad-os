import { z } from "zod";
import { PermissionLevel } from "../harness/types.js";

// ─── Tool definition schemas ──────────────────────────────────────────────────

export const ToolParameterType = z.enum(["string", "number", "boolean", "array"]);
export type ToolParameterType = z.infer<typeof ToolParameterType>;

export const ToolParameter = z.object({
  name: z.string(),
  type: ToolParameterType,
  description: z.string(),
  required: z.boolean().default(true),
  enum: z.array(z.string()).optional(),
});
export type ToolParameter = z.infer<typeof ToolParameter>;

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.array(ToolParameter),
  /** Permission level required to execute this tool */
  permissionLevel: PermissionLevel,
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

// ─── Tool call / result ───────────────────────────────────────────────────────

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  toolCallId: z.string(),
  success: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

// ─── Provider response union ──────────────────────────────────────────────────

/** What the provider returns when it wants to use a tool */
export interface ProviderToolResponse {
  type: "tool_use";
  toolCalls: ToolCall[];
  /** Partial text before/after tool calls (for Anthropic's mixed content) */
  textParts: string[];
}

/** What the provider returns when it's done (final text) */
export interface ProviderTextResponse {
  type: "text";
  content: string;
}

export type ProviderResponse = ProviderToolResponse | ProviderTextResponse;
