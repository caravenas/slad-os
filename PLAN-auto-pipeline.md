# Plan: `slad auto` — Full Pipeline Automation + Scratchpad Context Management

## Objetivo

Implementar un comando `slad auto` que ejecuta el pipeline completo (explore → snapshot → plan → run → learn) desde un intent en lenguaje natural, con gestión inteligente de contexto vía scratchpad filesystem.

```bash
slad auto "Agregar rate limiting al endpoint /api/users" --provider anthropic
```

Resultado: código implementado, verificado, y aprendizajes capturados — sin intervención humana salvo HITL explícito.

## Contexto Arquitectónico

Actualmente:
- Cada stage es un command independiente que lee un artifact del anterior
- El tool loop en `run` acumula todos los tool results en el conversation context sin límite
- No hay tracking de tokens/costo
- No hay forma de correr el pipeline completo de forma desatendida

Después de este feature:
- `slad auto` orquesta todo el pipeline con un solo comando
- El Scratchpad mantiene el context window bajo control durante tool use
- Token tracking da visibilidad de costo por stage y total
- Abort conditions inteligentes evitan loops infinitos o gasto descontrolado

## Diseño General

### Nuevos archivos a crear

```
src/
  context/
    scratchpad.ts       # Scratchpad filesystem store + summarizer
    budget.ts           # Token budget tracker + cost estimation
    types.ts            # ContextEntry, BudgetState, ScratchpadConfig schemas
  commands/
    auto.ts             # Pipeline orchestrator command
```

### Archivos a modificar

```
src/models/tool-loop.ts    # Integrar scratchpad en el loop
src/models/index.ts        # Agregar tokenCount al response (opcional)
src/models/anthropic.ts    # Extraer usage.input_tokens/output_tokens del response
src/models/openai.ts       # Extraer usage tokens del response
src/cli.ts                 # Registrar comando auto
src/core/types.ts          # Agregar AutoReport schema
src/commands/chat.ts       # Agregar "auto" como action en el REPL
```

---

## Parte 1: Scratchpad Context Management

### T1: Scratchpad Types (`src/context/types.ts`)

```typescript
import { z } from "zod";

/** Configuración del scratchpad */
export const ScratchpadConfig = z.object({
  /** Directorio donde se almacenan los archivos scratch */
  scratchDir: z.string().default(".slad-os/scratch"),
  /** Umbral en caracteres para enviar un result al scratch en vez del context */
  charThreshold: z.number().default(2000),
  /** Umbral en líneas */
  lineThreshold: z.number().default(100),
  /** Máximo de rounds completos a mantener en context (los anteriores se comprimen) */
  maxFullRoundsInContext: z.number().default(4),
  /** Si true, incluir hint al LLM de que puede re-leer desde scratch */
  includeRereadHint: z.boolean().default(true),
});
export type ScratchpadConfig = z.infer<typeof ScratchpadConfig>;

/** Entrada en el scratchpad — metadata de un tool result almacenado */
export const ScratchpadEntry = z.object({
  id: z.string(),
  round: z.number(),
  toolName: z.string(),
  /** Argumentos originales del tool call */
  args: z.record(z.unknown()),
  /** Resumen corto para mantener en context */
  summary: z.string(),
  /** Path al archivo con el resultado completo */
  filePath: z.string(),
  /** Tamaño original en chars */
  originalSize: z.number(),
  /** Timestamp */
  createdAt: z.string(),
});
export type ScratchpadEntry = z.infer<typeof ScratchpadEntry>;

/** Estado del budget de tokens */
export const BudgetState = z.object({
  /** Tokens de input acumulados */
  inputTokens: z.number().default(0),
  /** Tokens de output acumulados */
  outputTokens: z.number().default(0),
  /** Costo estimado en USD */
  estimatedCostUsd: z.number().default(0),
  /** Desglose por stage */
  byStage: z.record(z.string(), z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    estimatedCostUsd: z.number(),
    calls: z.number(),
  })).default({}),
  /** Budget máximo (0 = sin límite) */
  maxCostUsd: z.number().default(0),
  /** Budget máximo de tokens (0 = sin límite) */
  maxTokens: z.number().default(0),
});
export type BudgetState = z.infer<typeof BudgetState>;

/** Report final de una ejecución auto */
export const AutoReport = z.object({
  intent: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  status: z.enum(["completed", "partial", "failed", "aborted"]),
  /** Qué stages completaron */
  stagesCompleted: z.array(z.enum(["explore", "snapshot", "plan", "run", "learn"])),
  /** Stage donde se detuvo (si no completó) */
  stoppedAt: z.string().optional(),
  stopReason: z.string().optional(),
  /** Paths a los artifacts generados */
  artifacts: z.record(z.string(), z.string()).default({}),
  /** Budget consumido */
  budget: BudgetState,
  /** Resumen de tasks ejecutadas en run */
  tasksSummary: z.object({
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }).optional(),
});
export type AutoReport = z.infer<typeof AutoReport>;
```

**Criterio de aceptación:** `npm run typecheck` pasa. Schemas exportados correctamente.

---

### T2: Scratchpad Store (`src/context/scratchpad.ts`)

La implementación core del scratchpad:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { ScratchpadConfig, ScratchpadEntry } from "./types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

/**
 * Scratchpad — filesystem-backed external memory para tool results.
 *
 * Flujo:
 *  1. Recibe un ToolResult del executor
 *  2. Si el output supera el threshold → escribe a disco, retorna summary
 *  3. Si no supera → retorna el output completo (queda en context)
 *
 * El LLM puede re-leer cualquier scratch file usando readFile() si necesita
 * el contenido completo de nuevo.
 */
export class Scratchpad {
  private entries: ScratchpadEntry[] = [];
  private config: ScratchpadConfig;
  private sessionDir: string;

  constructor(config: Partial<ScratchpadConfig> = {}, sessionId: string, cwd: string) {
    this.config = { 
      scratchDir: ".slad-os/scratch",
      charThreshold: 2000,
      lineThreshold: 100,
      maxFullRoundsInContext: 4,
      includeRereadHint: true,
      ...config,
    };
    this.sessionDir = path.join(cwd, this.config.scratchDir, sessionId);
    fs.mkdirSync(this.sessionDir, { recursive: true });
  }

  /**
   * Procesa un tool result. Si es largo, lo guarda en scratch y retorna un summary.
   * Si es corto, retorna el output original tal cual.
   */
  processResult(call: ToolCall, result: ToolResult, round: number): string {
    if (!result.success) {
      // Errors siempre van completos en context (suelen ser cortos y críticos)
      return `ERROR: ${result.error}`;
    }

    const output = result.output;
    const lines = output.split("\n").length;
    const chars = output.length;

    // Si no supera threshold → queda en context completo
    if (chars < this.config.charThreshold && lines < this.config.lineThreshold) {
      return output;
    }

    // Supera threshold → escribir a scratch
    const entry = this.writeToScratch(call, output, round);
    this.entries.push(entry);

    // Retornar summary para el context
    const hint = this.config.includeRereadHint
      ? `\n[Para ver el contenido completo: readFile("${entry.filePath}")]`
      : "";

    return `${entry.summary}${hint}`;
  }

  /**
   * Genera un summary inteligente basado en el tipo de tool y contenido.
   */
  summarize(call: ToolCall, output: string): string {
    const lines = output.split("\n");
    const lineCount = lines.length;
    const charCount = output.length;

    switch (call.name) {
      case "readFile": {
        // Para archivos: mostrar primeras líneas + exports/estructura detectada
        const filePath = call.arguments.path as string;
        const ext = path.extname(filePath);
        const preview = lines.slice(0, 10).join("\n");
        const exports = lines
          .filter(l => /^export\s/.test(l))
          .map(l => l.trim().slice(0, 80))
          .slice(0, 8);
        const exportsBlock = exports.length 
          ? `\nExports detectados:\n${exports.map(e => `  ${e}`).join("\n")}`
          : "";
        return `[readFile:${filePath}] ${lineCount} líneas, ${charCount} chars (${ext})\nPrimeras líneas:\n${preview}\n...${exportsBlock}`;
      }

      case "exec": {
        // Para comandos: primeras y últimas líneas (errores suelen estar al final)
        const cmd = call.arguments.command as string;
        const head = lines.slice(0, 5).join("\n");
        const tail = lines.slice(-5).join("\n");
        const hasError = output.toLowerCase().includes("error") || output.includes("ERR");
        const status = hasError ? "CON ERRORES" : "OK";
        return `[exec:${cmd}] ${status}, ${lineCount} líneas output\nInicio:\n${head}\n...\nFinal:\n${tail}`;
      }

      case "grep": {
        const pattern = call.arguments.pattern as string;
        const matchCount = lines.filter(l => l.trim()).length;
        const preview = lines.slice(0, 10).join("\n");
        return `[grep:${pattern}] ${matchCount} matches encontrados\nPrimeros:\n${preview}\n...`;
      }

      case "listDir": {
        const dirPath = call.arguments.path as string;
        const fileCount = lines.filter(l => l.trim()).length;
        const preview = lines.slice(0, 15).join("\n");
        return `[listDir:${dirPath}] ${fileCount} entradas\n${preview}\n...`;
      }

      default: {
        // Genérico: primeras N líneas
        const preview = lines.slice(0, 8).join("\n");
        return `[${call.name}] ${lineCount} líneas, ${charCount} chars\n${preview}\n...`;
      }
    }
  }

  /**
   * Escribe el output completo al scratch y retorna la entry.
   */
  private writeToScratch(call: ToolCall, output: string, round: number): ScratchpadEntry {
    const id = `r${round}-${call.name}-${Date.now()}`;
    const fileName = `${id}.txt`;
    const filePath = path.join(this.sessionDir, fileName);

    // Escribir con metadata header
    const header = [
      `# Scratchpad: ${call.name}`,
      `# Round: ${round}`,
      `# Args: ${JSON.stringify(call.arguments)}`,
      `# Timestamp: ${new Date().toISOString()}`,
      `# ---`,
      "",
    ].join("\n");

    fs.writeFileSync(filePath, header + output, "utf8");

    const summary = this.summarize(call, output);

    return {
      id,
      round,
      toolName: call.name,
      args: call.arguments as Record<string, unknown>,
      summary,
      filePath: path.relative(path.resolve(this.sessionDir, "../.."), filePath),
      originalSize: output.length,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Comprime rounds antiguos en el historial de mensajes.
   * Retorna un resumen de los rounds que exceden maxFullRoundsInContext.
   */
  compressOldRounds(currentRound: number): string | null {
    const threshold = this.config.maxFullRoundsInContext;
    const oldEntries = this.entries.filter(e => e.round <= currentRound - threshold);
    
    if (oldEntries.length === 0) return null;

    const summary = oldEntries
      .map(e => `  round ${e.round}: ${e.toolName}(${Object.values(e.args)[0] ?? ""}) → ${e.summary.split("\n")[0]}`)
      .join("\n");

    return `[Contexto de rounds anteriores — ${oldEntries.length} tool calls comprimidos]\n${summary}`;
  }

  /** Retorna todas las entries para el report final */
  getEntries(): ScratchpadEntry[] {
    return [...this.entries];
  }

  /** Limpia archivos scratch de esta sesión */
  cleanup(): void {
    if (fs.existsSync(this.sessionDir)) {
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    }
  }
}
```

**Criterio de aceptación:**
- Test: output de 50 chars → queda en context (no va al scratch)
- Test: output de 3000 chars → va al scratch, retorna summary con hint de readFile
- Test: summarize para readFile genera preview con exports
- Test: summarize para exec muestra head+tail y detecta errores

---

### T3: Token Budget Tracker (`src/context/budget.ts`)

```typescript
import type { BudgetState } from "./types.js";
import { log } from "../core/logger.js";

// Precios por 1M tokens (USD) — actualizar según modelo
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-3-5": { input: 0.80, output: 4.0 },
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  // Gemini
  "gemini-2.0-flash": { input: 0.075, output: 0.30 },
  // Fallback
  "_default": { input: 3.0, output: 15.0 },
};

export class BudgetTracker {
  private state: BudgetState;
  private model: string;

  constructor(model: string, maxCostUsd = 0, maxTokens = 0) {
    this.model = model;
    this.state = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      byStage: {},
      maxCostUsd,
      maxTokens,
    };
  }

  /**
   * Registra tokens consumidos por una llamada al provider.
   */
  record(stage: string, inputTokens: number, outputTokens: number): void {
    this.state.inputTokens += inputTokens;
    this.state.outputTokens += outputTokens;

    const pricing = PRICING[this.model] ?? PRICING["_default"];
    const callCost = 
      (inputTokens / 1_000_000) * pricing.input + 
      (outputTokens / 1_000_000) * pricing.output;
    this.state.estimatedCostUsd += callCost;

    // Per-stage accumulator
    if (!this.state.byStage[stage]) {
      this.state.byStage[stage] = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, calls: 0 };
    }
    const s = this.state.byStage[stage];
    s.inputTokens += inputTokens;
    s.outputTokens += outputTokens;
    s.estimatedCostUsd += callCost;
    s.calls += 1;
  }

  /**
   * Verifica si el budget ha sido excedido.
   */
  isExceeded(): boolean {
    if (this.state.maxCostUsd > 0 && this.state.estimatedCostUsd >= this.state.maxCostUsd) {
      return true;
    }
    if (this.state.maxTokens > 0 && (this.state.inputTokens + this.state.outputTokens) >= this.state.maxTokens) {
      return true;
    }
    return false;
  }

  /**
   * Retorna un warning si estamos cerca del límite (>80%).
   */
  warning(): string | null {
    if (this.state.maxCostUsd > 0) {
      const ratio = this.state.estimatedCostUsd / this.state.maxCostUsd;
      if (ratio > 0.8) return `Budget: ${(ratio * 100).toFixed(0)}% consumido ($${this.state.estimatedCostUsd.toFixed(4)} / $${this.state.maxCostUsd})`;
    }
    if (this.state.maxTokens > 0) {
      const total = this.state.inputTokens + this.state.outputTokens;
      const ratio = total / this.state.maxTokens;
      if (ratio > 0.8) return `Tokens: ${(ratio * 100).toFixed(0)}% consumido (${total} / ${this.state.maxTokens})`;
    }
    return null;
  }

  /** Snapshot del estado actual */
  getState(): BudgetState {
    return { ...this.state };
  }

  /** Print summary al terminal */
  printSummary(): void {
    const total = this.state.inputTokens + this.state.outputTokens;
    log.dim(`  tokens: ${total.toLocaleString()} (in: ${this.state.inputTokens.toLocaleString()}, out: ${this.state.outputTokens.toLocaleString()})`);
    log.dim(`  costo estimado: $${this.state.estimatedCostUsd.toFixed(4)}`);
    
    for (const [stage, data] of Object.entries(this.state.byStage)) {
      log.dim(`    ${stage}: ${data.calls} calls, $${data.estimatedCostUsd.toFixed(4)}`);
    }
  }
}
```

**Criterio de aceptación:**
- Test: record() acumula correctamente por stage
- Test: isExceeded() retorna true cuando se pasa el maxCostUsd
- Test: pricing fallback funciona para modelos desconocidos

---

### T4: Integrar Scratchpad en el Tool Loop (`src/models/tool-loop.ts`)

Modificar `toolLoop` para que use el Scratchpad:

```typescript
// Agregar al import:
import { Scratchpad } from "../context/scratchpad.js";
import type { ScratchpadConfig } from "../context/types.js";

// Extender ToolLoopOpts:
export interface ToolLoopOpts extends ToolUseOptions {
  maxToolRounds?: number;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  /** Scratchpad instance (si null, no se usa scratchpad — todo queda en context) */
  scratchpad?: Scratchpad | null;
}

// En el loop, REEMPLAZAR la serialización de tool results:

// ANTES (actual):
// const resultsText = results.map(r => { ... }).join("\n\n");

// DESPUÉS (con scratchpad):
const resultsText = results.map((r, i) => {
  const call = response.toolCalls[i];
  const header = `[tool_result:${r.toolCallId}] ${r.success ? "✓" : "✗"}`;
  
  if (opts.scratchpad && r.success) {
    // El scratchpad decide si truncar o no
    const processed = opts.scratchpad.processResult(call, r, rounds);
    return `${header}\n${processed}`;
  }
  
  // Sin scratchpad: comportamiento original
  const body = r.success ? r.output : `ERROR: ${r.error}`;
  return `${header}\n${body}`;
}).join("\n\n");

// ADEMÁS: antes de cada round, comprimir rounds antiguos si aplica
if (opts.scratchpad && rounds > 0) {
  const compressed = opts.scratchpad.compressOldRounds(rounds);
  if (compressed) {
    // Reemplazar mensajes antiguos por el resumen comprimido
    // (implementación: mantener solo últimos N rounds + compressed summary al inicio)
  }
}
```

**Nota de implementación para la compresión de rounds antiguos:**

El approach más limpio: mantener un array de "active messages" y un "compressed prefix". Antes de cada call al provider, construir:
```
[system] + [compressed_context] + [last N rounds de messages]
```

Esto evita mutar el array de messages original y hace predecible el tamaño del context.

**Criterio de aceptación:**
- Test: tool loop con scratchpad, resultado largo va al scratch, el message contiene solo el summary
- Test: tool loop sin scratchpad (null), funciona igual que antes (backward compatible)
- Test: readFile hint incluye path correcto para re-lectura

---

### T5: Extraer Token Usage de los Providers

#### `src/models/anthropic.ts` — agregar usage al response

```typescript
// Agregar al ProviderResponse type o como side-channel:
// Opción: agregar un campo usage opcional

// En completeWithTools(), después del res:
// res.usage contiene { input_tokens, output_tokens }

// Approach recomendado: callback en opts
export interface ToolUseOptions extends CompletionOptions {
  tools: ToolDefinition[];
  /** Callback para reportar token usage después de cada API call */
  onUsage?: (input: number, output: number) => void;
}

// En AnthropicProvider.completeWithTools():
opts.onUsage?.(res.usage.input_tokens, res.usage.output_tokens);

// En AnthropicProvider.complete():
opts.onUsage?.(res.usage.input_tokens, res.usage.output_tokens);
```

#### `src/models/openai.ts` — similar

```typescript
// res.usage?.prompt_tokens, res.usage?.completion_tokens
opts.onUsage?.(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);
```

**Criterio de aceptación:** `onUsage` callback se invoca con valores correctos en ambos providers.

---

## Parte 2: Pipeline Orchestrator

### T6: Auto Command (`src/commands/auto.ts`)

El orquestador principal:

```typescript
import fs from "node:fs";
import path from "node:path";
import ora from "ora";
import kleur from "kleur";
import { getApiKey, getModel, loadConfig, resolveProvider } from "../core/config.js";
import { getProvider } from "../models/index.js";
import { log } from "../core/logger.js";
import { createSession, saveSession, appendArtifact } from "../core/session.js";
import { BudgetTracker } from "../context/budget.js";
import { Scratchpad } from "../context/scratchpad.js";
import type { AutoReport } from "../context/types.js";

// Importar las funciones core de cada stage (no el command completo)
import { generateExploreOutput } from "./explore.js";
import { generateSnapshotOutput } from "./snapshot.js";
import { generatePlanOutput } from "./plan.js";
import { runAutoLoop } from "./run.js";  // necesita ser exportada
import { generateLearnOutput } from "./learn.js";

export interface AutoOpts {
  provider?: string;
  agent?: string;
  model?: string;
  maxCost?: number;        // Budget máximo en USD (default: 1.0)
  maxTasks?: number;       // Máximo de tasks a ejecutar en run (default: 10)
  skipLearn?: boolean;     // No ejecutar learn al final
  harness?: "off" | "on" | "strict";
  dryRun?: boolean;        // Correr explore+snapshot+plan pero NO run
  json?: boolean;
}

type PipelineStage = "explore" | "snapshot" | "plan" | "run" | "learn";

interface StageResult {
  stage: PipelineStage;
  artifactPath: string;
  data: unknown;
}

export async function autoCommand(intent: string, opts: AutoOpts): Promise<void> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // ── Setup ──
  const config = loadConfig();
  const providerName = resolveProvider(opts.provider, opts.agent, config.defaultProvider);
  const apiKey = getApiKey(providerName);
  if (providerName !== "cli" && !apiKey) {
    log.error(`No se encontró API key para ${providerName}.`);
    process.exit(1);
  }
  const model = opts.model ?? getModel(providerName);
  const provider = await getProvider(providerName, apiKey ?? undefined);

  // ── Session ──
  const session = createSession(intent);
  log.title(`Auto · ${providerName}${model ? ` · ${model}` : ""}`);
  log.dim(`  sesión: ${session.id}`);
  log.dim(`  intent: ${intent}`);
  console.log("");

  // ── Budget & Scratchpad ──
  const budget = new BudgetTracker(model, opts.maxCost ?? 1.0);
  const scratchpad = new Scratchpad({}, session.id, process.cwd());

  const stagesCompleted: PipelineStage[] = [];
  const artifacts: Record<string, string> = {};
  let stopReason: string | undefined;
  let stoppedAt: string | undefined;

  const onUsage = (stage: string) => (input: number, output: number) => {
    budget.record(stage, input, output);
    const warning = budget.warning();
    if (warning) log.warn(`  ${warning}`);
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // STAGE 1: EXPLORE
    // ═══════════════════════════════════════════════════════════════════════
    const exploreSpinner = ora("Explore · analizando intent...").start();
    
    const exploreOutput = await generateExploreOutput({
      intent,
      provider,
      model,
      onUsage: onUsage("explore"),
    });

    if (exploreOutput.status === "awaiting_human") {
      exploreSpinner.warn("Explore requiere decisión humana");
      stopReason = `HITL requerido en explore: ${exploreOutput.questions.map(q => q.prompt).join("; ")}`;
      stoppedAt = "explore";
      // Aún así guardar el artifact parcial
    } else {
      exploreSpinner.succeed(`Explore · ${exploreOutput.approaches.length} enfoques, ${exploreOutput.risks.length} riesgos`);
    }

    const explorePath = saveStageArtifact("explore", exploreOutput, session.id);
    saveSession(appendArtifact(session, "explore", explorePath));
    stagesCompleted.push("explore");
    artifacts.explore = explorePath;

    if (exploreOutput.status === "awaiting_human" || budget.isExceeded()) {
      throw new PipelineStop(stoppedAt ?? "explore", stopReason ?? "Budget excedido");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STAGE 2: SNAPSHOT
    // ═══════════════════════════════════════════════════════════════════════
    const snapSpinner = ora("Snapshot · generando mini-spec...").start();

    const snapshotOutput = await generateSnapshotOutput({
      exploreOutput,
      approach: exploreOutput.approaches[0].name, // Usar primer approach (recomendado)
      provider,
      model,
      onUsage: onUsage("snapshot"),
    });

    snapSpinner.succeed("Snapshot · mini-spec lista");
    const snapshotPath = saveStageArtifact("snapshot", snapshotOutput, session.id);
    saveSession(appendArtifact(session, "snapshot", snapshotPath));
    stagesCompleted.push("snapshot");
    artifacts.snapshot = snapshotPath;

    if (budget.isExceeded()) {
      throw new PipelineStop("snapshot", "Budget excedido después de snapshot");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STAGE 3: PLAN
    // ═══════════════════════════════════════════════════════════════════════
    const planSpinner = ora("Plan · generando tasks...").start();

    const planOutput = await generatePlanOutput({
      snapshotContent: snapshotOutput.content,
      provider,
      model,
      onUsage: onUsage("plan"),
    });

    planSpinner.succeed(`Plan · ${planOutput.tasks.length} tareas generadas`);
    const planPath = saveStageArtifact("plan", planOutput, session.id);
    saveSession(appendArtifact(session, "plan", planPath));
    stagesCompleted.push("plan");
    artifacts.plan = planPath;

    if (budget.isExceeded()) {
      throw new PipelineStop("plan", "Budget excedido después de plan");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STAGE 4: RUN (si no es dry-run)
    // ═══════════════════════════════════════════════════════════════════════
    if (opts.dryRun) {
      log.dim("  --dry-run: saltando ejecución");
      throw new PipelineStop("plan", "Dry run — solo explore+snapshot+plan");
    }

    console.log("");
    log.title("Run · ejecutando tasks");

    await runAutoLoop(planOutput, provider, model, {
      maxTasks: opts.maxTasks ?? 10,
      maxRounds: 3,
      harness: opts.harness ?? "on",  // Default "on" en auto (más seguro)
      auto: true,
      scratchpad,
      budget,
      onUsage: onUsage("run"),
    }, session);

    stagesCompleted.push("run");
    artifacts.run = path.join(process.cwd(), "runs"); // dir con todos los run reports

    if (budget.isExceeded()) {
      throw new PipelineStop("run", "Budget excedido durante run");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STAGE 5: LEARN (opcional)
    // ═══════════════════════════════════════════════════════════════════════
    if (!opts.skipLearn) {
      const learnSpinner = ora("Learn · capturando aprendizajes...").start();
      
      const learnOutput = await generateLearnOutput({
        runDir: path.join(process.cwd(), "runs"),
        provider,
        model,
        onUsage: onUsage("learn"),
      });

      learnSpinner.succeed("Learn · aprendizajes capturados");
      const learnPath = saveStageArtifact("learn", learnOutput, session.id);
      saveSession(appendArtifact(session, "learn", learnPath));
      stagesCompleted.push("learn");
      artifacts.learn = learnPath;
    }

  } catch (err) {
    if (err instanceof PipelineStop) {
      stoppedAt = err.stage;
      stopReason = err.reason;
    } else {
      stoppedAt = stagesCompleted[stagesCompleted.length - 1] ?? "explore";
      stopReason = (err as Error).message;
      log.error(`Pipeline abortado: ${stopReason}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════════════════════
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;
  const allExpected: PipelineStage[] = opts.dryRun 
    ? ["explore", "snapshot", "plan"] 
    : opts.skipLearn 
      ? ["explore", "snapshot", "plan", "run"]
      : ["explore", "snapshot", "plan", "run", "learn"];

  const status = stagesCompleted.length === allExpected.length
    ? "completed"
    : stagesCompleted.length > 0
      ? "partial"
      : "failed";

  const report: AutoReport = {
    intent,
    startedAt,
    completedAt,
    durationMs,
    status,
    stagesCompleted,
    stoppedAt,
    stopReason,
    artifacts,
    budget: budget.getState(),
  };

  // Guardar report
  const reportPath = path.join(process.cwd(), "runs", `${timestamp()}-auto-report.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  // Print summary
  console.log("");
  printAutoReport(report, durationMs);
  budget.printSummary();
  log.success(`Reporte: ${reportPath}`);

  // Cleanup scratchpad (opcional — mantener para debugging)
  // scratchpad.cleanup();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

class PipelineStop extends Error {
  constructor(public stage: string, public reason: string) {
    super(reason);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function saveStageArtifact(stage: string, data: unknown, sessionId: string): string {
  const dir = stageOutputDir(stage);
  const fileName = `${timestamp()}-${stage}.json`;
  const filePath = path.join(process.cwd(), dir, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return filePath;
}

function stageOutputDir(stage: string): string {
  switch (stage) {
    case "explore": return "explores";
    case "snapshot": return "snapshots";
    case "plan": return "tasks";
    case "run": return "runs";
    case "learn": return "learnings";
    default: return stage;
  }
}

function printAutoReport(report: AutoReport, durationMs: number): void {
  const secs = (durationMs / 1000).toFixed(1);
  const statusColor = report.status === "completed" ? kleur.green
    : report.status === "partial" ? kleur.yellow
    : kleur.red;
  
  console.log(kleur.bold("Pipeline ") + statusColor(report.status) + kleur.dim(` · ${secs}s`));
  console.log(kleur.dim(`  stages: ${report.stagesCompleted.join(" → ")}`));
  if (report.stoppedAt) {
    console.log(kleur.dim(`  detenido en: ${report.stoppedAt} — ${report.stopReason}`));
  }
}
```

**Criterio de aceptación:**
- `slad auto "intent" --dry-run` ejecuta explore+snapshot+plan y se detiene
- `slad auto "intent"` ejecuta el pipeline completo
- Se genera un AutoReport JSON con budget y stages
- Budget exceeded detiene el pipeline gracefully

---

### T7: Exportar funciones generadoras de cada stage

Los commands actuales (`explore.ts`, `snapshot.ts`, `plan.ts`, `learn.ts`) mezclan la lógica de generación con la UI (spinner, print, CLI options). Necesitamos exportar funciones puras que el orchestrator pueda llamar.

#### Patrón para cada stage:

```typescript
// En src/commands/explore.ts — la función ya existe como generateExploreOutput()
// Verificar que acepta onUsage callback y retorna ExploreOutput directamente.
// Si no existe, extraerla del command separando UI de lógica.

export interface GenerateExploreOpts {
  intent: string;
  provider: ModelProvider;
  model: string;
  onUsage?: (input: number, output: number) => void;
}

export async function generateExploreOutput(opts: GenerateExploreOpts): Promise<ExploreOutput> {
  // ... lógica pura sin spinners ni console.log
}
```

Hacer lo mismo para:
- `generateSnapshotOutput(opts)` — acepta exploreOutput + approach
- `generatePlanOutput(opts)` — acepta snapshotContent
- `generateLearnOutput(opts)` — acepta runDir o run report

**Nota importante:** NO modificar el behavior de los commands existentes. Los commands siguen funcionando igual desde CLI — solo agregar exports de las funciones puras. El auto command las usa directamente.

**Criterio de aceptación:** Cada stage tiene una función exportada `generate<Stage>Output()` que:
- No hace console.log ni usa spinner
- Acepta `onUsage` callback
- Retorna el output tipado (ExploreOutput, SnapshotOutput, PlanOutput, LearnOutput)
- El command existente sigue funcionando igual (usa la función + agrega UI)

---

### T8: Exportar `runAutoLoop` para uso externo

El `runAutoLoop` actual en `run.ts` está diseñado para uso interactivo (select de retry/skip, spinners). Necesitamos una versión que el pipeline pueda usar programáticamente.

```typescript
// Agregar a run.ts o extraer a un módulo separado:

export interface RunAutoOpts {
  maxTasks?: number;
  maxRounds?: number;
  harness?: "off" | "on" | "strict";
  auto?: boolean;
  scratchpad?: Scratchpad | null;
  budget?: BudgetTracker | null;
  onUsage?: (input: number, output: number) => void;
  /** Si true, en vez de preguntar retry/skip/abort, auto-skip */
  nonInteractive?: boolean;
}

// Modificar runAutoLoop para aceptar nonInteractive mode:
// Cuando nonInteractive=true:
// - Tasks que fallan → auto-skip (no preguntar al usuario)
// - HITL awaiting_human → abort (el pipeline se detiene)
// - Budget exceeded → abort
```

**Criterio de aceptación:** `runAutoLoop` con `nonInteractive: true` no requiere input del usuario. Tasks fallidas se skipean automáticamente.

---

### T9: Registrar comando `auto` en CLI

```typescript
// En src/cli.ts:

import { autoCommand } from "./commands/auto.js";

program
  .command("auto")
  .description("Pipeline completo: de intent a código implementado (explore → snapshot → plan → run → learn).")
  .argument("<intent...>", "La intención a implementar")
  .option("-a, --agent <name>", "Agente local (codex | claude | gemini)")
  .option("-p, --provider <name>", "Provider LLM")
  .option("-m, --model <name>", "Modelo a usar")
  .option("--max-cost <usd>", "Budget máximo en USD (default: 1.0)", parseFloat)
  .option("--max-tasks <n>", "Máximo de tasks a ejecutar (default: 10)", parseInt)
  .option("--harness <mode>", "Modo del harness (off | on | strict)", "on")
  .option("--dry-run", "Solo explore+snapshot+plan, sin ejecutar código")
  .option("--skip-learn", "No ejecutar learn al final")
  .option("--json", "Output JSON del report final")
  .action(async (intentParts: string[], opts) => {
    await autoCommand(intentParts.join(" "), opts);
  });
```

**Criterio de aceptación:** `slad auto --help` muestra todas las opciones. `slad auto "test" --dry-run` ejecuta sin error.

---

### T10: Integrar `auto` en el Chat REPL

```typescript
// En src/commands/chat.ts, agregar a parseAction():

if (/^(auto|pipeline|completo)\s+(.+)/i.test(trimmed)) {
  const match = trimmed.match(/^(?:auto|pipeline|completo)\s+(.+)/i)!;
  return { type: "auto", intent: match[1] };
}

// Y en el executor del chat loop:
case "auto":
  await autoCommand(action.intent, { provider: providerName, model });
  break;
```

**Criterio de aceptación:** Escribir `auto agregar cache a /api/users` en el chat REPL ejecuta el pipeline completo.

---

### T11: Tests

```
src/context/scratchpad.test.ts     # Threshold, summarize, cleanup
src/context/budget.test.ts         # Acumulación, isExceeded, pricing
src/commands/auto.test.ts          # Pipeline con mock provider (verifica stages)
```

**Criterio de aceptación:** `npm test` pasa con todos los tests nuevos.

---

## Orden de Dependencias (DAG)

```
T1 (types) ──────────────────────────────┐
                                          ├── T4 (integrar scratchpad en tool-loop)
T2 (scratchpad store) ───────────────────┘          │
                                                     │
T3 (budget tracker) ────── T5 (token usage) ────────┤
                                                     │
T7 (exportar generate*) ────────────────────────────├── T6 (auto command) ── T9 (CLI)
                                                     │                            │
T8 (runAutoLoop export) ────────────────────────────┘                        T10 (chat)

T11 (tests) depende de todos
```

Ejecución recomendada: T1 → T2 → T3 → T5 → T4 → T7 → T8 → T6 → T9 → T10 → T11

---

## Decisiones de Diseño

1. **Scratchpad path relativo al proyecto**: Los scratch files viven en `.slad-os/scratch/<sessionId>/`. El LLM puede re-leerlos con `readFile(".slad-os/scratch/...")`. Se limpian con `scratchpad.cleanup()` o manualmente.

2. **Budget default $1.0 USD**: Suficiente para un pipeline completo con un intent mediano (explore+snapshot+plan ≈ $0.10, run con 5 tasks y tools ≈ $0.60, learn ≈ $0.05). Para features grandes, pasar `--max-cost 5`.

3. **Harness default "on" en auto**: Más seguro que el default "off" de `slad run` manual. El usuario está menos atento en modo auto, así que comandos `full` requieren aprobación por default.

4. **Non-interactive mode para run**: En auto pipeline, si una task falla, se skipea automáticamente (no pregunta retry/skip/abort). Si hay HITL (awaiting_human), el pipeline se detiene con status "partial" — el usuario puede continuar manualmente después.

5. **Stage functions puras**: Cada stage exporta una función sin side-effects de UI. Los commands existentes las wrappean con spinners/prints. El auto command las usa directamente con su propia UI mínima.

6. **onUsage como callback**: No extender ProviderResponse con usage (breaking change). Usar un callback en CompletionOptions que los providers invocan opcionalmente. Esto mantiene backward-compatibility total.

7. **Approach selection en auto**: Para snapshot, usa automáticamente el primer approach del explore (el recomendado). Si querés control, usá `--dry-run` + revisa + luego `slad run --auto`.

---

## Riesgos

- **generateXxxOutput() no existe como función pura en algunos stages**: El refactor de T7 puede requerir mover lógica significativa. Mitigación: no cambiar el comportamiento del command, solo extraer la parte core.
- **Token counting impreciso**: No todos los providers retornan usage exacta. Gemini por ejemplo no siempre la incluye. Mitigación: pricing fallback + heurística de ~4 chars/token para estimar.
- **Pipeline interrumpido**: Si el proceso muere a mitad, el scratchpad queda sin limpiar. Mitigación: es solo un dir de archivos .txt, no corrompe nada. Cleanup manual con `rm -rf .slad-os/scratch/`.
- **HITL en stages tempranos**: Si el explore o plan retorna `awaiting_human`, el pipeline se detiene. Mitigación: las funciones en auto mode podrían auto-resolver preguntas simples (eg: elegir el approach recomendado). Implementar en v2.

---

## Notas para el ejecutor

- NO agregar dependencias nuevas al package.json. Todo se resuelve con lo existente.
- El scratchpad usa `fs` estándar. No necesita librería adicional.
- Los tests de `auto.test.ts` deben mockear el provider (no hacer API calls reales).
- Mantener español en UI/prompts, inglés en código.
- Tests con `node:test`.
- Imports con `.js` extension (ESM).
- El refactor de T7 es el paso más delicado — asegurarse de no romper los commands existentes.
- Si `generateExploreOutput` ya existe (revisar explore.ts línea 50+), solo asegurarse que acepta `onUsage`.
