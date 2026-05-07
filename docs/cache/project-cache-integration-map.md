# Project Cache Integration Map

## Scope of this inventory

This map covers the current SLAD OS entrypoints that could produce or consume cache in v1, limited to the code that exists today under `src/`.

Current repo reality:

- there is no `packages/`, `apps/` or standalone `cli/` directory;
- there is no explicit contract named `retrieved_context`, `agent_outputs`, `snapshots` or `artifacts_metadata` in code yet;
- the current durable contract is the session artifact model in `src/core/types.ts` and `src/core/session.ts`;
- there is an existing in-memory cache abstraction in `src/cache/store.ts`, but nothing in `src/` imports it today.

This means v1 cache integration should be layered onto existing commands and artifact/session contracts, not onto a pre-existing cache pipeline.

## Existing durable contracts

### Session artifacts

`src/core/types.ts` defines the only stable persisted artifact envelope currently used across commands:

- `SessionArtifactKind`: `explore | snapshot | plan | run | learn | evolve`
- `SessionArtifact`: `{ kind, path, createdAt, taskId? }`
- `SessionState`: `{ id, createdAt, intent, currentPhase?, artifacts[], humanAnswers[], notes[] }`

`src/core/session.ts` persists those records under:

- `sessions/<session-id>/state.json`
- `.slad-session` for the active session pointer

This is the closest existing contract to `artifacts_metadata`. If cache v1 needs an index of reusable outputs, this module is the safest place to reuse or extend metadata shape without inventing a parallel incompatible envelope.

### Structured outputs already normalized in code

`src/core/types.ts` also defines normalized payloads for command outputs:

- `ExploreOutput`
- `PlanOutput`
- `RunOutput`
- `LearnOutput`
- `EvolveOutput`

These are runtime data contracts, but only some are written to disk today by commands.

## Inventory of producers by artifact/cache-relevant object

### `snapshots`

Primary producer today:

- `src/commands/snapshot.ts`

Behavior:

- builds input from an `ExploreOutput` JSON file or direct intent;
- adds session human-answer context via `sessionContextBlock()`;
- asks the model for markdown;
- writes the canonical snapshot file to `snapshots/<date>-<slug>.md`;
- registers it in session state with `appendArtifact(session, "snapshot", outPath)`.

Related producers/readers:

- `src/commands/chat.ts` can trigger `snapshotCommand()`;
- `src/commands/plan.ts` consumes the last snapshot artifact or an explicit `--input`.

Likely cache mapping in v1:

- canonical file in `snapshots/` remains source of truth;
- cache namespace `snapshots` should store either a reusable rendered snapshot payload or metadata pointing to the canonical file plus validation material.

### `agent_outputs`

There is no object named `agent_outputs` today, but the closest producers are:

- `src/agents/explorer.ts` returning `ExploreOutput`
- `src/commands/plan.ts` producing `PlanOutput`
- `src/commands/run.ts` producing `RunOutput`
- `src/commands/learn.ts` producing `LearnOutput`
- `src/commands/evolve.ts` producing `EvolveOutput`

Durable writes today:

- `exploreCommand()` writes `out/explore.json` when a session exists, or a user-specified path;
- `planCommand()` writes `tasks/tasks.json`;
- `runCommand()` writes MD+YAML run artifacts to `<docsRoot>/log/runs/`;
- `learnCommand()` writes `learnings/<timestamp>-<task>.md` or JSON;
- `evolveCommand()` writes `evolution/<timestamp>-evolve.md` or JSON.

For v1 adoption limited to CLI/Planner/agents, the most natural `agent_outputs` writers are:

- `src/agents/explorer.ts` for normalized exploration output;
- `src/commands/plan.ts` for planner output;
- `src/commands/run.ts` for builder/reviewer output only if reuse is intentionally allowed for repeated identical task executions.

Lower-priority writers that can stay read-only or uncached initially:

- `src/commands/learn.ts`
- `src/commands/evolve.ts`

### `artifacts_metadata`

Closest producer today:

- `src/core/session.ts` through `appendArtifact()` and `saveSession()`

Indirect producers:

- every command that calls `appendArtifact()`:
  - `src/commands/explore.ts`
  - `src/commands/snapshot.ts`
  - `src/commands/plan.ts`
  - `src/commands/run.ts`
  - `src/commands/learn.ts`
  - `src/commands/evolve.ts`

Current persisted metadata includes:

- artifact kind;
- artifact path;
- creation timestamp;
- optional task id for run artifacts.

Missing today relative to cache needs:

- no `projectId`;
- no cache key;
- no input signature;
- no snapshot hash;
- no runtime/provider version metadata;
- no file relevance manifest.

### `retrieved_context`

There is no explicit retrieval pipeline today. The nearest current context producers are:

- `src/agents/explorer.ts::readWikiContext()`
  - reads `<wikiPath>/index.md`
  - truncates to 6000 chars
  - injects text directly into the prompt
- `src/core/session.ts::sessionContextBlock()`
  - derives reusable context from `session.humanAnswers`
- `src/commands/evolve.ts::buildContext()`
  - reads recent files from `snapshots/`, `tasks/`, legacy `runs/`, `learnings/`
  - concatenates them into a prompt context block

These are the strongest candidates for future `retrieved_context` producers because they already materialize prompt context from local sources.

Important gap:

- none of these flows currently capture which files were read in a reusable machine-readable manifest.

## Current consumers and suggested cache adoption order

### Write in v1

These are the best first writers for v1 cache:

1. `src/commands/plan.ts`
   - stable single input file (`snapshot.md`)
   - deterministic enough to key by snapshot hash + model/runtime settings
   - already writes a canonical JSON artifact
2. `src/commands/snapshot.ts`
   - stable enough when driven by explicit intent or `explore.json`
   - canonical output already exists under `snapshots/`
3. `src/agents/explorer.ts` or `src/commands/explore.ts`
   - useful for caching retrieved wiki context plus normalized explore output
   - needs clearer invalidation if wiki context participates
4. `src/core/session.ts`
   - should likely write cache-adjacent metadata or indexes if artifact lookup becomes cache-backed

### Read in v1

These should read cache in v1 after or alongside the writers above:

1. `src/commands/plan.ts`
2. `src/commands/snapshot.ts`
3. `src/commands/explore.ts`
4. `src/commands/chat.ts`
   - only indirectly, because it delegates to the commands above

### Read later, avoid writing in initial rollout

These flows should probably stay out of cache writes in the initial rollout:

1. `src/commands/run.ts`
   - task execution is the most semantically unstable flow
   - repeated runs may depend on repo mutations, human answers and external checks
2. `src/commands/learn.ts`
3. `src/commands/evolve.ts`
4. `src/commands/session.ts`

Reason:

- they either aggregate many upstream artifacts, depend on mutable workspace state, or are mostly orchestration/UI over other producers.

## CLI and orchestration entrypoints that matter

### CLI root

`src/cli.ts` is the top-level entrypoint for all cache-relevant flows:

- `explore`
- `snapshot`
- `plan`
- `run`
- `learn`
- `evolve`
- `chat`
- `session *`

If cache configuration needs CLI flags or environment bootstrapping, this file is one probable integration point.

### Chat orchestration

`src/commands/chat.ts` is an orchestration layer, not a primary producer.

It matters because:

- it auto-creates sessions for new intents;
- it advances through `explore -> snapshot -> plan -> run`;
- it should inherit whatever cache behavior those commands use rather than introducing a separate cache path.

### Run orchestration

`src/commands/run.ts` orchestrates single-task and auto-loop execution over `PlanOutput`.

It matters for cache design because:

- it serializes `RunOutput` through the persistence layer to `<docsRoot>/log/runs/`;
- it persists human answers into `SessionState`;
- it is the only flow with explicit HITL rounds;
- cache integration here is risky and should probably start as read-only or be deferred.

## Probable modules for `projectId`, cache keys and on-disk directory resolution

### Best place to resolve `projectId`

Current implementation:

- `src/project/project-id.ts`

Why this is the right integration point:

- it already resolves `projectRoot` from `cwd`;
- it distinguishes `git` vs `directory` projects;
- it persists stable metadata in `.slad-os/project-id.json`;
- it returns the full envelope `{ projectId, projectRoot, metadataPath, metadata, projectKind }`.

Recommendation:

- keep `projectId` resolution in `src/project/project-id.ts`;
- make commands that become cache writers call `resolveProjectId()` at the boundary where they decide cache read/write behavior;
- keep `src/core/session.ts` project-local, but avoid duplicating project identity logic there.

### Best place to resolve cache root and on-disk namespaces

Current implementation:

- `src/cache/store.ts`

What already exists there:

- `defaultCacheRootFromHome()` -> `~/.slad-os/cache/v1`
- `resolveCacheRoot()`
- `resolveProjectCacheDir()`
- `resolveCacheObjectDir()`
- `resolveCacheEntryPath()`
- `createProjectCacheStore()` wired to `resolveProjectId()`

Implication for v1:

- do not introduce another path-resolution module unless the store contract proves insufficient;
- extend `src/cache/store.ts` or add narrowly scoped helpers beside it for namespace-specific metadata;
- keep commands out of path construction details and route all on-disk resolution through `src/cache/store.ts`.

### Best place to compute cache keys and invalidation envelopes

Primary candidates:

- new helpers adjacent to the existing cache layer, for example:
  - `src/cache/keys.ts`
  - `src/cache/contracts.ts`

Why:

- current command modules inline prompt/input assembly;
- hashing and cache-key normalization should not be reimplemented inside each command;
- these helpers can reuse `src/cache/store.ts` and `src/project/project-id.ts` without changing command contracts.

## Inputs already available for cache keys

The current codebase already exposes several useful key dimensions:

- provider name from `resolveProvider()` in `src/core/config.ts`
- model name from `getModel()` in `src/core/config.ts`
- command input paths in:
  - `src/commands/snapshot.ts`
  - `src/commands/plan.ts`
  - `src/commands/learn.ts`
  - `src/commands/run.ts`
- session human answers via `sessionContextBlock()` in `src/core/session.ts`
- selected task payload from `PlanOutput` in `src/commands/run.ts`

What is still missing:

- stable hash helpers for file content and normalized inputs;
- producer-specific runtime version markers;
- file manifests for retrieved context producers.

## Risks and compatibility notes discovered during mapping

- `src/cache/store.ts` already defines the project/object/key directory layout, but no command reads or writes through it yet.
- `src/commands/explore.ts` defaults to `out/explore.json` only when a session exists; cache write/read logic should not assume all commands already have stable canonical output paths outside sessions.
- `src/commands/run.ts` mixes execution report persistence with interactive HITL loops, making it the least safe first integration point.
- `src/commands/evolve.ts::buildContext()` and `src/agents/explorer.ts::readWikiContext()` are the only real "retrieval" behaviors today, but neither records input file manifests.
- session artifacts are project-local today because they live under `process.cwd()`, which is convenient but not enough for strong cache isolation across clones/forks once cache moves outside the repo.

## Recommended integration sequence from current code

1. Reuse `src/project/project-id.ts` as the single source of truth for `projectId`.
2. Reuse `src/cache/store.ts` as the single source of truth for cache root and per-project object paths.
3. Cache `snapshot` and `plan` first because their inputs and outputs are already file-based and stable.
4. Add `retrieved_context` manifests for wiki/file readers before caching explorer/evolve-style context.
5. Decide separately whether `run` should ever write cache in v1 or only consume upstream cached artifacts.
