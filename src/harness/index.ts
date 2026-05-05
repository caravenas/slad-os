import path from "node:path";
import type { PlanTask, RunOutput } from "../core/types.js";
import type {
  ExecutionHarness,
  HarnessConfig,
  CommandClassification,
  HookVerdict,
  PreTaskHook,
  PostTaskHook,
} from "./types.js";
import { classifyRunOutput, highestLevel } from "./classifier.js";
import { AuditLogger } from "./audit.js";

// ─── Factory ──────────────────────────────────────────────────────────────────

export async function createHarness(config: HarnessConfig): Promise<ExecutionHarness> {
  const audit = config.auditLog ? new AuditLogger(config.auditLogPath) : null;

  const preHooks = await loadHooks<PreTaskHook>(config.preTaskHooks);
  const postHooks = await loadHooks<PostTaskHook>(config.postTaskHooks);

  return {
    config,

    async beforeTask(task: PlanTask, sessionId: string | null): Promise<HookVerdict> {
      audit?.log({
        timestamp: new Date().toISOString(),
        sessionId,
        taskId: task.id,
        kind: "task_start",
        data: { title: task.title, files: task.files },
      });

      // Run pre-hooks in order. The first deny wins.
      for (const hook of preHooks) {
        const verdict = await hook.execute({
          task,
          sessionId,
          permissionLevel: config.maxPermission,
          sessionPermissions: config.maxPermission,
        });

        audit?.log({
          timestamp: new Date().toISOString(),
          sessionId,
          taskId: task.id,
          kind: "hook_verdict",
          data: { hook: hook.name, verdict },
        });

        if (verdict.action !== "allow") return verdict;
      }

      return { action: "allow" };
    },

    classifyOutput(output: RunOutput): CommandClassification[] {
      return classifyRunOutput(output);
    },

    requiresApproval(classifications: CommandClassification[]): boolean {
      if (config.mode === "off") return false;
      const highest = highestLevel(classifications);

      // strict: workspace and full require approval
      // on: only full requires approval
      if (config.mode === "strict") return highest !== "read";
      return highest === "full";
    },

    async afterTask(task: PlanTask, output: RunOutput, durationMs: number): Promise<void> {
      const classifications = classifyRunOutput(output);

      for (const c of classifications) {
        audit?.log({
          timestamp: new Date().toISOString(),
          sessionId: null,
          taskId: task.id,
          kind: "command_classified",
          data: c,
        });
      }

      audit?.log({
        timestamp: new Date().toISOString(),
        sessionId: null,
        taskId: task.id,
        kind: "task_end",
        data: {
          status: output.status,
          durationMs,
          changedFiles: output.changedFiles,
        },
      });

      // Run post-hooks (non-blocking)
      for (const hook of postHooks) {
        await hook.execute({
          task,
          output,
          classifications,
          durationMs,
          changedFiles: output.changedFiles,
        });
      }
    },

    async flush(): Promise<void> {
      await audit?.flush();
    },
  };
}

// ─── Dynamic hook loader ──────────────────────────────────────────────────────

async function loadHooks<T>(paths: string[]): Promise<T[]> {
  const hooks: T[] = [];
  for (const p of paths) {
    try {
      const mod = await import(path.resolve(p));
      hooks.push(mod.default as T);
    } catch (err) {
      console.warn(
        `Warning: no se pudo cargar hook ${p}: ${(err as Error).message}`,
      );
    }
  }
  return hooks;
}

// Re-export for convenience
export type { ExecutionHarness, HarnessConfig, HarnessMode } from "./types.js";
