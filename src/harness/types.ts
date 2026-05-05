import { z } from "zod";
import type { PlanTask, RunOutput } from "../core/types.js";

export { PlanTask, RunOutput };

// ─── Permission levels ────────────────────────────────────────────────────────

export const PermissionLevel = z.enum(["read", "workspace", "full"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

// ─── Command classification ───────────────────────────────────────────────────

export const CommandClassification = z.object({
  original: z.string(),
  level: PermissionLevel,
  reason: z.string(),
  patterns: z.array(z.string()).default([]),
});
export type CommandClassification = z.infer<typeof CommandClassification>;

// ─── Hook verdicts ────────────────────────────────────────────────────────────

export type HookVerdict =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; patch: Partial<PlanTask> };

// ─── Hook interfaces ──────────────────────────────────────────────────────────

export interface PreTaskContext {
  task: PlanTask;
  sessionId: string | null;
  permissionLevel: PermissionLevel;
  /** Permissions assigned to this session */
  sessionPermissions: PermissionLevel;
}

export interface PostTaskContext {
  task: PlanTask;
  output: RunOutput;
  /** Classifications of commands detected in the output */
  classifications: CommandClassification[];
  durationMs: number;
  changedFiles: string[];
}

export interface PreTaskHook {
  name: string;
  /** Runs before sending the task to the Builder. Can block or modify. */
  execute(ctx: PreTaskContext): Promise<HookVerdict>;
}

export interface PostTaskHook {
  name: string;
  /** Runs after receiving the RunOutput. Cannot block, only audit. */
  execute(ctx: PostTaskContext): Promise<void>;
}

// ─── Harness config ───────────────────────────────────────────────────────────

export const HarnessMode = z.enum(["off", "on", "strict"]);
export type HarnessMode = z.infer<typeof HarnessMode>;

export const HarnessConfig = z.object({
  mode: HarnessMode.default("off"),

  /** Maximum permission level for the session */
  maxPermission: PermissionLevel.default("workspace"),

  /** Commands/patterns that always require human approval */
  alwaysApprove: z.array(z.string()).default([
    "rm -rf",
    "sudo",
    "shutdown",
    "DROP TABLE",
    "git push --force",
    "npm publish",
  ]),

  /** Directories allowed for write access (workspace mode) */
  allowedWritePaths: z.array(z.string()).default(["./src", "./tests", "./docs"]),

  /** Enable LDJSON audit log */
  auditLog: z.boolean().default(true),

  /** Audit log file path */
  auditLogPath: z.string().default(".slad-os/audit.ldjson"),

  /** Custom hooks (paths to ESM modules) */
  preTaskHooks: z.array(z.string()).default([]),
  postTaskHooks: z.array(z.string()).default([]),
});
export type HarnessConfig = z.infer<typeof HarnessConfig>;

// ─── ExecutionHarness interface ───────────────────────────────────────────────

export interface ExecutionHarness {
  readonly config: HarnessConfig;

  /** Evaluates whether a task can run. Runs pre-task hooks. */
  beforeTask(task: PlanTask, sessionId: string | null): Promise<HookVerdict>;

  /** Classifies commands found in the Builder output. */
  classifyOutput(output: RunOutput): CommandClassification[];

  /** Checks whether the output requires interactive approval. */
  requiresApproval(classifications: CommandClassification[]): boolean;

  /** Records the result in the audit log. Runs post-task hooks. */
  afterTask(task: PlanTask, output: RunOutput, durationMs: number): Promise<void>;

  /** Flush the audit log (call on shutdown). */
  flush(): Promise<void>;
}
