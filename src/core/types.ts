import { z } from "zod";

export const ProviderName = z.enum(["anthropic", "openai", "gemini", "cli"]);
export type ProviderName = z.infer<typeof ProviderName>;

export const AgentName = z.enum(["codex", "claude"]);
export type AgentName = z.infer<typeof AgentName>;

export const MessageRole = z.enum(["system", "user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRole>;

export const ChatMessage = z.object({
  role: MessageRole,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const CompletionOptions = z.object({
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),
});
export type CompletionOptions = z.infer<typeof CompletionOptions>;

// ─── Question — must be defined before any output schema that references it ───

export const QuestionKind = z.enum(["free", "choice", "confirm", "ranking"]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const Question = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  kind: QuestionKind,
  choices: z.array(z.string()).optional(),
  default: z
    .union([z.string(), z.boolean(), z.number()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v))),
  blocking: z.boolean().default(true),
  context: z.string().optional(),
});
export type Question = z.infer<typeof Question>;

// ─── Agent output schemas ─────────────────────────────────────────────────────

export const ExploreOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  intent: z.string(),
  reframing: z.string(),
  approaches: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string(),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
      }),
    )
    .min(1),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  recommendedNext: z.string(),
  questions: z.array(Question).default([]),
});
export type ExploreOutput = z.infer<typeof ExploreOutput>;

export const SnapshotOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  content: z.string().default(""),
  questions: z.array(Question).default([]),
});
export type SnapshotOutput = z.infer<typeof SnapshotOutput>;

export const PlanTask = z.object({
  id: z.string().regex(/^T\d+$/),
  title: z.string(),
  description: z.string(),
  type: z.enum(["research", "implementation", "test", "docs", "review"]),
  priority: z.enum(["high", "medium", "low"]),
  dependsOn: z.array(z.string().regex(/^T\d+$/)).default([]),
  files: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  snapshot: z.string(),
  summary: z.string(),
  tasks: z.array(PlanTask).default([]),
  verification: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  recommendedFirstTask: z.string().regex(/^T\d+$/).optional(),
  questions: z.array(Question).default([]),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

export const RunOutput = z.object({
  taskId: z.string().regex(/^T\d+$/),
  status: z.enum(["completed", "blocked", "failed", "awaiting_human"]),
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  verification: z
    .array(
      z.object({
        command: z.string(),
        status: z
          .string()
          .transform((v) =>
            (["passed", "failed", "not_run", "skipped", "not_applicable"] as const).includes(
              v as never,
            )
              ? (v as "passed" | "failed" | "not_run" | "skipped" | "not_applicable")
              : ("not_run" as const),
          ),
        notes: z.string().default(""),
      }),
    )
    .default([]),
  reviewerNotes: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  questions: z.array(Question).default([]),
  humanAnswers: z.record(z.string(), z.string()).default({}),
});
export type RunOutput = z.infer<typeof RunOutput>;

export const LearnOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  sourceRun: z.string(),
  taskId: z.string().regex(/^T\d+$/),
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  wikiEntryTitle: z.string(),
  questions: z.array(Question).default([]),
});
export type LearnOutput = z.infer<typeof LearnOutput>;

export const EvolveOutput = z.object({
  status: z.enum(["completed", "awaiting_human"]).default("completed"),
  title: z.string(),
  summary: z.string(),
  proposedUpdates: z
    .array(
      z.object({
        target: z.string(),
        changeType: z
          .string()
          .transform((v) =>
            (["create", "update", "append"] as const).includes(v as never)
              ? (v as "create" | "update" | "append")
              : ("update" as const),
          ),
        rationale: z.string().default(""),
        content: z.string().default(""),
      }),
    )
    .default([]),
  patternUpdates: z.array(z.string()).default([]),
  snapshotUpdates: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
  questions: z.array(Question).default([]),
});
export type EvolveOutput = z.infer<typeof EvolveOutput>;

// ─── Session ──────────────────────────────────────────────────────────────────

export const SessionArtifactKind = z.enum([
  "explore",
  "snapshot",
  "plan",
  "run",
  "learn",
  "evolve",
]);
export type SessionArtifactKind = z.infer<typeof SessionArtifactKind>;

export const SessionArtifact = z.object({
  kind: SessionArtifactKind,
  path: z.string(),
  createdAt: z.string().datetime(),
  taskId: z.string().optional(),
});
export type SessionArtifact = z.infer<typeof SessionArtifact>;

export const SessionAnswer = z.object({
  taskId: z.string(),
  questionId: z.string(),
  answer: z.string(),
  askedAt: z.string().datetime(),
});
export type SessionAnswer = z.infer<typeof SessionAnswer>;

export const SessionState = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  intent: z.string(),
  currentPhase: SessionArtifactKind.optional(),
  artifacts: z.array(SessionArtifact).default([]),
  humanAnswers: z.array(SessionAnswer).default([]),
  notes: z.array(z.string()).default([]),
});
export type SessionState = z.infer<typeof SessionState>;

export const DevAgentConfig = z.object({
  defaultProvider: ProviderName.default("anthropic"),
  wikiPath: z
    .string()
    .optional()
    .describe("Ruta absoluta a la wiki para inyectar contexto (index.md)"),
});
export type DevAgentConfig = z.infer<typeof DevAgentConfig>;
