import type { ToolCall, ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ExecutionHarness } from "../harness/types.js";
import { classifyCommand } from "../harness/classifier.js";
import { confirmDangerousAction } from "../harness/approval.js";
import type { CommandClassification, PermissionLevel } from "../harness/types.js";

export interface ExecutorOpts {
  cwd: string;
  harness: ExecutionHarness | null;
  /** Si true, las acciones peligrosas se bloquean sin pedir confirmación interactiva */
  dryRun?: boolean;
}

/**
 * ToolExecutor — el puente crítico entre tool calls del LLM y ejecución real.
 *
 * Flujo:
 *  1. Lookup de la tool en el registry
 *  2. Clasificación de riesgo (usa el harness classifier o permissionLevel base)
 *  3. Si requiere aprobación: pide confirmación al usuario (o bloquea en dryRun)
 *  4. Ejecución de la tool
 *  5. Retorno del ToolResult
 */
export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private opts: ExecutorOpts,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        success: false,
        output: "",
        error: `Tool no encontrada: ${call.name}`,
      };
    }

    // 1. Classify the tool call to determine risk level
    const classification = this.classifyToolCall(call, tool.definition.permissionLevel);

    // 2. Harness gate: check if approval is needed
    if (this.opts.harness && this.opts.harness.requiresApproval([classification])) {
      if (this.opts.dryRun) {
        return {
          toolCallId: call.id,
          success: false,
          output: "",
          error: `[dry-run] Bloqueado: ${call.name} requiere aprobación (nivel ${classification.level})`,
        };
      }

      const approved = await confirmDangerousAction(`tool:${call.name}`, [classification]);
      if (!approved) {
        return {
          toolCallId: call.id,
          success: false,
          output: "",
          error: `Rechazado por el usuario: ${call.name}`,
        };
      }
    }

    // 3. Execute
    try {
      const output = await tool.execute(call.arguments as Record<string, unknown>, this.opts.cwd);
      return { toolCallId: call.id, success: true, output };
    } catch (err) {
      return {
        toolCallId: call.id,
        success: false,
        output: "",
        error: (err as Error).message,
      };
    }
  }

  /**
   * Classify a tool call for harness risk assessment.
   * For "exec" tool, re-classifies based on the actual command string.
   * For other tools, uses the tool's declared permissionLevel.
   */
  private classifyToolCall(call: ToolCall, baseLevel: PermissionLevel): CommandClassification {
    // For exec, let the classifier analyze the actual command content
    if (call.name === "exec" && typeof call.arguments.command === "string") {
      return classifyCommand(call.arguments.command);
    }

    // For other tools, use the declared permission level
    return {
      original: `${call.name}(${JSON.stringify(call.arguments)})`,
      level: baseLevel,
      reason: `Tool ${call.name} (permissionLevel: ${baseLevel})`,
      patterns: [],
    };
  }
}
