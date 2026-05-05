# SLAD OS

## Qué es

CLI orchestrator para AI agents en software development.
Pipeline: `explore -> snapshot -> plan -> run -> learn -> evolve`.
Cada stage produce JSON validado por Zod que el siguiente consume.

## Stack

- TypeScript 5.6 + Node.js 20+ (ESM, `"type": "module"`)
- Zod para schemas de output de agentes
- Commander para CLI
- @inquirer/prompts para HITL
- kleur + ora para output del terminal

## Estructura del proyecto

```
src/
  cli.ts               # Entry point (Commander)
  commands/            # Un archivo por stage del pipeline + chat + session
    explore.ts         # Explorer Agent
    snapshot.ts        # Snapshot Agent
    plan.ts            # Planner Agent
    run.ts             # Builder + Reviewer Agent
    learn.ts           # Learn Agent
    evolve.ts          # Evolve Agent
    chat.ts            # REPL conversacional
    session.ts         # Gestión de sesiones
  agents/
    prompts.ts         # System prompts de todos los agentes
    explorer.ts        # Wiki context caching para explore
  core/
    types.ts           # Todos los Zod schemas (ExploreOutput, PlanTask, RunOutput, etc.)
    config.ts          # .env loading, provider/model resolution
    session.ts         # SessionState CRUD
    hitl.ts            # Question collection + answer formatting
    logger.ts          # Logger con niveles configurables
    context.ts         # Lee AGENTS.md y lo inyecta como contexto
    errors.ts          # Error classes tipadas (SladError, ProviderError, SchemaError, etc.)
  models/
    index.ts           # ModelProvider interface + factory
    anthropic.ts       # Anthropic SDK
    openai.ts          # OpenAI SDK
    gemini.ts          # Google Generative AI SDK
    cli.ts             # Local binary (codex/claude) via subprocess
  cache/
    reusable.ts        # High-level cache API (readOrCreateReusableValue)
    store.ts           # Filesystem cache store (~/.slad-os/cache/v1)
    invalidation.ts    # Content-based invalidation rules
    keys.ts            # Cache key generation
  project/
    project-id.ts      # Deterministic project identity
  harness/
    types.ts           # Interfaces y schemas del harness
    classifier.ts      # Clasificador de comandos por nivel de riesgo
    audit.ts           # AuditLogger LDJSON append-only
    approval.ts        # Confirmación interactiva de acciones peligrosas
    config.ts          # Loader de .slad-os/harness.json
    index.ts           # ExecutionHarness implementation
```

## Convenciones

- Schemas Zod en `core/types.ts`, no dispersos
- Prompts como string constants en `agents/prompts.ts`
- Cada comando exporta `<name>Command(opts)` y una interface `<Name>Opts`
- Tests con `node:test` (no jest, no vitest)
- Español en UI/prompts del CLI, inglés en código (variables, funciones)
- `log.error() + process.exit(1)` para errores fatales en commands
- JSON extraction de LLM responses via `extractJson()` (fence-aware)
- Imports locales con `.js` extension (ESM)

## Comandos útiles

```bash
npm run dev -- explore "tu intención"   # Run sin compilar
npm run build                            # Compila a dist/
npm test                                 # Corre todos los .test.ts
npm run dev -- chat                      # REPL interactivo
```

## Cosas importantes

- **ModelProvider** es la abstracción central. Nunca llamar SDKs directamente desde commands.
- **SessionState** trackea artefactos entre stages. Siempre `appendArtifact()` después de generar output.
- El cache es content-based (hash de inputs). No usar timestamps.
- HITL: los agentes pueden retornar `status: "awaiting_human"` + `questions[]`. El loop en el command se encarga.
- `RunOutput.verification[].command` es lo que el clasificador del harness analiza.
- **ExecutionHarness**: middleware opt-in entre Planner y Builder. Modes: `off` (default), `on`, `strict`. Flag CLI: `--harness=on|strict`.
- **Error classes**: `ProviderError` (retryable en 429/529/500), `SchemaError` (preserva raw output), `ConfigError`, `SessionError`, `HarnessError`.
- **Logger**: `SLAD_LOG_LEVEL=debug|info|warn|error|silent`, `SLAD_LOG_TIMESTAMPS=1`, `SLAD_DEBUG=1` para stack traces.
