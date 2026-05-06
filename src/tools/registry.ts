import type { ToolDefinition } from "./types.js";
import { readFileDef, readFileExec, writeFileDef, writeFileExec, listDirDef, listDirExec, grepDef, grepExec } from "./definitions/filesystem.js";
import { execDef, execExec } from "./definitions/shell.js";
import { gitStatusDef, gitStatusExec, gitDiffDef, gitDiffExec, gitAddDef, gitAddExec, gitCommitDef, gitCommitExec } from "./definitions/git.js";

export interface RegisteredTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

/** Factory que crea el registry con todas las tools built-in registradas */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Filesystem tools
  registry.register({ definition: readFileDef, execute: readFileExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });
  registry.register({ definition: writeFileDef, execute: writeFileExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });
  registry.register({ definition: listDirDef, execute: listDirExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });
  registry.register({ definition: grepDef, execute: grepExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });

  // Shell tools
  registry.register({ definition: execDef, execute: execExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });

  // Git tools
  registry.register({ definition: gitStatusDef, execute: gitStatusExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });
  registry.register({ definition: gitDiffDef, execute: gitDiffExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });
  registry.register({ definition: gitAddDef, execute: gitAddExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });
  registry.register({ definition: gitCommitDef, execute: gitCommitExec as (args: Record<string, unknown>, cwd: string) => Promise<string> });

  return registry;
}
