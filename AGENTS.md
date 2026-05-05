# SLAD OS — Project Context

## Architecture

SLAD OS is a CLI-based AI agent orchestrator for structured software development.
Pipeline: `explore -> snapshot -> plan -> run (xN) -> learn -> evolve`.

Each stage produces typed JSON artifacts validated by Zod schemas.
Artifacts are tracked in SessionState and persist across commands.

## Key Files

- `src/core/types.ts` — All Zod schemas (ExploreOutput, PlanTask, RunOutput, etc.)
- `src/agents/prompts.ts` — System prompts for all agents
- `src/models/index.ts` — ModelProvider interface (vendor abstraction)
- `src/core/session.ts` — Session state CRUD
- `src/core/hitl.ts` — Human-in-the-loop question/answer system
- `src/core/errors.ts` — Typed error classes (SladError, ProviderError, SchemaError, etc.)

## Stack

- TypeScript ESM (import with `.js` extensions), Node 20+
- Zod for schema validation
- Commander for CLI
- @inquirer/prompts for HITL interactions
- kleur + ora for terminal output

## Code Style

- TypeScript ESM (`import from ".js"` extensions always)
- Functional style, minimal classes
- Error handling: throw typed errors (ProviderError, SchemaError), caller decides exit behavior
- All agent outputs must pass their Zod schema (`safeParse` + clear error on failure)
- JSON extraction from LLM responses: `extractJson()` handles markdown fences
- Tests with `node:test`, not jest or vitest

## ModelProvider Interface

All agents communicate exclusively through this interface. Never import SDKs directly from commands.

```typescript
interface ModelProvider {
  complete(messages: ChatMessage[], opts: CompletionOptions): Promise<string>
}
```

Implemented providers: `anthropic`, `openai`, `gemini`, `cli` (local binary).

## Task Format (PlanTask schema)

```typescript
{
  id: string,          // T1, T2, T3...
  title: string,
  description: string,
  type: "research" | "implementation" | "test" | "docs" | "review",
  priority: "high" | "medium" | "low",
  dependsOn: string[], // DAG dependencies
  files: string[],     // file paths this task touches
  acceptanceCriteria: string[]
}
```

## Builder / Run Phase Expectations

When executing a task, produce a `RunOutput` JSON:

```typescript
{
  taskId: string,              // T1, T2...
  status: "completed" | "blocked" | "failed" | "awaiting_human",
  summary: string,
  changedFiles: string[],      // relative paths from project root
  verification: [{
    command: string,           // command to validate the work
    status: "passed" | "failed" | "not_run" | "skipped" | "not_applicable",
    notes: string
  }],
  reviewerNotes: string[],
  followUps: string[],
  questions: Question[],       // populate if status is "awaiting_human"
  humanAnswers: {}
}
```

- Use `verification[].command` to describe what commands validate the work.
- If blocked, set `status: "awaiting_human"` and populate `questions[]`.
- Changed files should be relative paths from project root.

## Project Patterns

- Provider-agnostic: never reference a specific LLM vendor in business logic.
- Cache by content hash, not timestamps. Cache key = hash(snapshot) + hash(inputs) + runtime version.
- HITL answers accumulate in session — don't re-ask resolved questions.
- Logs and audit are append-only.
- The Run phase is the highest-risk execution point — the harness wraps it when enabled.

## ExecutionHarness (optional middleware)

Activated with `--harness=on|strict`. Classifies commands in RunOutput by risk level:
- `read` — safe (cat, ls, grep)
- `workspace` — local writes (git commit, npm install, touch)
- `full` — high risk (rm -rf, sudo, git push --force, npm publish)

In `strict` mode, workspace+full require human approval. In `on` mode, only full requires approval.
Audit log written to `.slad-os/audit.ldjson` (LDJSON, append-only).
