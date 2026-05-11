# slad-os

CLI de **SLAD OS** — Spec-Light Agentic Dev OS.

Convierte intención en Snapshots y orquesta agentes especializados sobre múltiples
providers de LLM (Claude, OpenAI, Gemini o un binario local vía CLI como Codex/Claude Code).

Primera versión (`0.1.0`): comandos `explore`, `snapshot`, `plan`, `run`, `learn` y `evolve`.

---

## ¿Qué es?

Es un **orquestador de agentes de IA para desarrollo de software**, operado desde la terminal. La idea central: en vez de hablar directamente con un LLM y construir prompts a mano, `slad` define un pipeline estructurado donde cada paso tiene un agente especializado con un schema de salida validado.

El flujo completo es:

```
intención → explore → snapshot → plan → run (×N) → learn → evolve
```

Cada comando produce un artefacto JSON concreto que el siguiente consume. Todo queda ligado por una `SessionState` que persiste entre comandos.

### Qué hace cada agente

| Agente | Rol |
|--------|-----|
| **Explorer** | Reframing de la intención, enfoques con pros/cons, riesgos |
| **Snapshot** | Mini-spec de una página (el "qué construir", no el "cómo") |
| **Planner** | Descompone el spec en tareas atómicas con dependencias DAG |
| **Builder/Reviewer** | Ejecuta cada tarea y la revisa en el mismo loop |
| **Learn** | Destila decisiones, errores y patrones del run en la wiki |
| **Evolve** | Propone actualizaciones a los patrones del proyecto |

### Ventajas del modelo Spec-Light

**El LLM nunca ve la intención cruda.**
Antes de escribir código, el Explorer reformula el problema y expone ambigüedades. Esto captura el problema real antes de que el agente empiece a construir la solución equivocada.

**Outputs tipados y validados.**
Cada agente devuelve JSON parseado por un schema Zod. Si el LLM alucina una estructura inválida, el error es claro e inmediato.

**HITL como ciudadano de primera clase.**
Cualquier agente puede pausar y preguntar. Las respuestas se acumulan en la sesión y se inyectan como contexto en los pasos siguientes — el agente no repite preguntas ya contestadas.

**Provider-agnostic.**
La interfaz `ModelProvider` desacopla completamente la lógica de negocio del vendor. Cambiar de Claude a Codex a Gemini es un flag de CLI, no una reescritura.

**DAG de tareas, no lista plana.**
`run --auto` respeta dependencias entre tareas, hace cascade de skips cuando una falla, y permite resume sin re-ejecutar lo que ya está hecho.

**Cache fuerte.**
Las salidas de los agentes se cachean por contenido (hash del snapshot + inputs + versión del prompt). Si no cambió nada, no gasta tokens.

**Decisiones inspeccionables.**
La mayoría de los flujos con agentes son una caja negra. `slad` hace lo opuesto: cada decisión queda externalizada en un artefacto concreto. Puedes revisar el `explore.json` antes de generar el spec, el spec antes de planificar, el `tasks.json` antes de ejecutar. El humano está en el loop en los puntos que importan, no monitoreando un proceso opaco.

---

## Install

### Local

```bash
npm install
npm run build
npm link        # expone `slad` globalmente en tu shell
slad --help
```

En desarrollo puedes usar `tsx` sin compilar:

```bash
npm run dev -- explore "quiero un sistema de memoria por proyecto"
```

### Remoto con GitHub

Si el repo está en GitHub, puedes ejecutarlo sin publicar en npm. El script
`prepare` compila `dist/` al instalar desde Git:

```bash
npx github:caravenas/slad-os --help
npx github:caravenas/slad-os explore "quiero persistir memoria por proyecto" --agent codex
```

Si el repo es privado, necesitas tener `git` autenticado contra GitHub en la
máquina que ejecuta `npx`.

### Publicado en npm

Cuando el paquete esté publicado:

```bash
npx slad-os --help
npx slad-os explore "quiero persistir memoria por proyecto" --agent codex
```

Para instalarlo globalmente:

```bash
npm install -g slad-os
slad --help
```

## Config

Variables de entorno (cualquier combinación):

```bash
# Defaults del CLI
export SLAD_DEFAULT_PROVIDER=cli
export SLAD_WIKI_PATH=/Users/tu-usuario/Projects/brainstorming

export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=...

# Modelo por defecto. Para probar este proyecto:
export SLAD_MODEL=MiniMax-M2.7
```

También puedes fijar modelos por provider. Estas variables tienen prioridad sobre
`SLAD_MODEL`:

```bash
export ANTHROPIC_MODEL=MiniMax-M2.7
export OPENAI_MODEL=gpt-4o
export GEMINI_MODEL=gemini-1.5-pro
```

Soporte de tool use por provider:

| Provider | Tool use (Builder) | Notas |
|---|---|---|
| `anthropic` | ✅ | Function calling nativo |
| `openai` | ✅ | Function calling nativo |
| `gemini` | ✅ | Function calling nativo (`@google/generative-ai`) |
| `cli` | ❌ | El agente agentic corre en el subprocess |

Para usar un binario local en vez de una API key:

```bash
export SLAD_CLI_BINARY=codex
export SLAD_CLI_ARGS='exec --skip-git-repo-check --color never'
export SLAD_CLI_PROMPT_MODE=stdin
export SLAD_CLI_MODEL_ARG=--model
export CLI_MODEL=
export SLAD_CLI_INHERIT_API_KEYS=false
```

La forma recomendada de usar esos binarios es con `--agent codex` o
`--agent claude`. Internamente, `slad` traduce eso al provider `cli`.
Con `codex`, usa `codex exec` y captura el último mensaje final para no mezclarlo
con logs del runner. Con `claude`, usa `claude --print`. Si el CLI local no acepta
`--model`, deja `SLAD_CLI_MODEL_ARG` vacío. Si no defines `SLAD_CLI_BINARY`,
`slad` intenta auto-detectar `codex` y luego `claude`. Por defecto, el subprocess
no hereda API keys del `.env`; esto evita que Claude Code o Codex usen una key
inválida en vez de tu login local.

Todas las configs viven en `.env` en el cwd (ver `.env.example`). Si defines
`SLAD_WIKI_PATH`, el Explorer inyecta el `index.md` como contexto ligero y
`evolve --apply-wiki` hace append en esa wiki.

### Timeout del CLI provider

Cuando usás `--agent codex` o `--agent claude`, el subprocess puede tardar varios
minutos. El timeout por defecto es de 30 minutos. Podés ajustarlo por tarea con:

```bash
export SLAD_CLI_TIMEOUT_MS=3600000   # 1 hora
```

El timeout aplica a **cada llamada individual** al agente, no a toda la sesión.
Si una tarea supera el límite, `slad` muestra los archivos modificados hasta ese
momento (git change detection) para que puedas decidir si descartarlos o no.

## Cache v1

SLAD OS mantiene una cache local por proyecto con aislamiento fuerte. La identidad
del proyecto se persiste en `<project-root>/.slad-os/project-id.json`, y la cache
on-disk vive fuera del repo en `~/.slad-os/cache/v1` por defecto.

Qué se cachea en v1:
- namespaces conceptuales `retrieved_context`, `agent_outputs`, `snapshots` y `artifacts_metadata`;
- en la implementacion actual, el writer operativo ya integrado usa `objectType: "planner"`.

Cuándo hay hit:
- mismo `projectId`;
- misma clave de reuse (`snapshot_hash`, `input_signature`, `tool_version`, `runtime_version`, `schema_version`);
- mismos archivos relevantes cuando el flujo registra manifiesto.

Cuándo hay miss:
- cambia el snapshot, inputs, version de CLI/runtime o archivos relevantes;
- no existe entrada previa para esa clave dentro del namespace del proyecto.

Inspección manual:

```bash
cat ./.slad-os/project-id.json
find ~/.slad-os/cache/v1/projects -name project.json -print -exec grep -H '"projectId"' {} \;
```

Limpieza manual por proyecto:

```bash
rm -rf ~/.slad-os/cache/v1/projects/<project-namespace>
```

Eso borra solo la cache persistida de ese proyecto. No toca `src/`, `dist/`,
`snapshots/`, `tasks/`, `docs/` ni otros archivos fuente o artefactos canonicos.

Límites de v1:
- no hay GC automatico, TTL operativo ni cuotas;
- no hay sharing cross-project ni cross-machine;
- UI/MCP no forman parte de la escritura en v1.

Detalle operativo y límites completos: `docs/cache/project-cache-v1.md`.

## Contexto del proyecto (`AGENTS.md`)

Crea un archivo `AGENTS.md` en la raíz del proyecto y todos los agentes lo
inyectarán automáticamente como contexto en cada llamada al LLM.

Es el lugar donde documentás la arquitectura, patrones clave, decisiones importantes
y convenciones del proyecto. Con esto, un agente que nunca vio el codebase puede
entender cómo está organizado y seguir los mismos patrones al implementar algo nuevo.

```
AGENTS.md             ← leído automáticamente por explore, snapshot, plan,
                         run, learn y evolve
```

Qué incluir:
- Visión general del proyecto y stack técnico
- Interfaces y abstracciones clave (con ejemplos de código breves)
- Cómo agregar nuevos componentes (providers, comandos, agentes)
- Convenciones y decisiones de diseño importantes

El archivo se limita a 8.000 caracteres al inyectarse. Si crece demasiado, priorizá
las secciones que más contexto dan al agente para implementar features nuevos.

> **Disciplina recomendada:** después de cada feature significativo, corre
> `slad evolve` para que el agente proponga qué actualizar en `AGENTS.md` y la wiki.

## Human-in-the-Loop (HITL)

Todos los agentes (`explore`, `snapshot`, `plan`, `run`, `learn`, `evolve`) soportan
un modo interactivo donde el agente puede pausar y pedirte información antes de
continuar.

Cuando un agente necesita input, devuelve `status: "awaiting_human"` junto con una
lista de preguntas. `slad` las presenta una a una en la terminal y luego reenvía tus
respuestas al agente para que continúe. El loop se repite hasta máximo 3 rondas.

Tipos de pregunta soportados:
- **`free`** — texto libre
- **`choice`** — lista de opciones (select)
- **`confirm`** — sí / no
- **`ranking`** — ordenar una lista separada por comas

Las respuestas HITL se guardan en la sesión activa (`humanAnswers`) y se inyectan
como contexto en las tareas siguientes, de modo que el agente no repita preguntas
ya contestadas.

## Uso

### `slad chat` — modo conversacional

La forma más fluida de usar SLAD OS. Abre un REPL interactivo que guía el flujo
completo `explore → snapshot → plan → run → learn → evolve` con sugerencias
automáticas del siguiente paso.

```bash
slad chat
slad chat --agent codex
slad chat --agent claude --model claude-opus-4-5
```

Comandos dentro del chat:

| Comando | Descripción |
|---------|-------------|
| `<intención>` | Explorá una intención (crea sesión automáticamente) |
| `explore <texto>` | Forma explícita del explore |
| `snapshot` | Generá el mini-spec del último explore |
| `plan` | Convertí el snapshot en tareas |
| `run --auto` | Ejecutá todas las tareas automáticamente |
| `run T2` | Ejecutá una tarea específica |
| `learn` | Capturá aprendizajes del último run |
| `evolve` | Proponé actualizaciones a la wiki |
| `next` / Enter | Avanzá al siguiente paso sugerido |
| `status` | Ver estado de la sesión activa |
| `new` | Empezar una nueva sesión |
| `help` | Ver todos los comandos |
| `exit` / `quit` | Salir del chat |

El chat reconoce variantes en español e inglés (`siguiente`, `continuar`, `salir`,
`nuevo`, etc.). Si escribís texto libre antes del primer `explore`, lo interpreta
directamente como intención.

### `slad session` — gestión de sesiones

Una sesión agrupa todos los artefactos de una intención (explore → snapshot → plan
→ runs → learn → evolve) y persiste las respuestas HITL para inyectarlas como
contexto en pasos futuros.

```bash
slad session start "quiero implementar autenticación JWT"   # crea y activa sesión
slad session list                                           # lista todas las sesiones
slad session use <session-id>                               # activa una sesión existente
slad session show                                           # detalle de la sesión activa
```

La sesión activa se persiste en `.slad-session` (cwd). Todos los comandos sin
`--skip-session` leen y actualizan esa sesión automáticamente.

### `slad explore`

Analiza una intención y devuelve reframing, enfoques, riesgos, preguntas abiertas
y próximo paso.

```bash
slad explore "quiero persistir memoria por proyecto en mis agentes"
slad explore "..." --agent codex
slad explore "..." --agent codex --model gpt-5.4
slad explore "..." --agent claude
slad explore "..." --provider openai
slad explore "..." --output ./out/explore.json --json
```

### `slad snapshot`

Genera un Snapshot Markdown (mini-spec de 1 página) a partir de:
- un `explore.json` previo (flujo recomendado), o
- una intención suelta.

```bash
# Flujo completo:
slad explore "memoria por proyecto" --agent codex --output ./out/explore.json
slad snapshot --input ./out/explore.json --approach "vector"

# Atajo:
slad snapshot --intent "memoria por proyecto" --agent codex
```

Output por defecto: `./snapshots/<fecha>-<slug>.md`.

### `slad plan`

Convierte un Snapshot en `tasks.json`: tareas atómicas, dependencias, archivos
probables, criterios de aceptación y checks de verificación.

```bash
slad plan --input ./snapshots/2026-04-22-como-implementar-un-subprocess-model.md
slad plan --input ./snapshots/feature.md --agent codex --output ./tasks/tasks.json
slad plan --input ./snapshots/feature.md --json
```

Output por defecto: `./tasks/tasks.json`.

### `slad run`

Ejecuta una tarea de `tasks.json` con el loop Builder + Reviewer y guarda un
reporte Markdown con YAML frontmatter en `<docsRoot>/log/runs/`. Si no pasás
`--task`, usa `recommendedFirstTask`.

```bash
slad run
slad run --task T3
slad run --agent codex --input ./tasks/tasks.json --task T1
SLAD_DOCS_PATH=/tmp/slad-docs slad run --agent codex --task T1
slad run --agent codex --task T1 --json
```

Output por defecto: `<docsRoot>/log/runs/<sessionId>_<taskId>.md`.
`--output` está deprecated y se ignora; usa `SLAD_DOCS_PATH` o
`.slad-os/config.json` para cambiar el destino.

#### Auto-loop (`--auto`)

Ejecuta todas las tareas del plan en orden topológico (respetando `dependsOn`) con
prioridad de `high` a `low`.

```bash
slad run --auto
slad run --auto --agent codex --max-tasks 5
```

Al terminar cada tarea, `slad` muestra los archivos que cambiaron según `git status`
para que veas qué trabajo realizó el agente antes de continuar.

Si una tarea falla o queda bloqueada, el loop pregunta:
- **Reintentar** — vuelve a ejecutar la misma tarea
- **Omitir** — marca la tarea como skipped (y hace cascade a sus dependientes)
- **Abortar** — detiene el loop y muestra el resumen

**Resume detection:** si la sesión activa ya tiene runs completados de una ejecución
anterior, el loop detecta cuáles tareas ya terminaron y ofrece:
- **Resumir** — hace skip de las completadas y continúa desde la siguiente pendiente
- **Empezar de cero** — re-ejecuta todo

### `slad learn`

Convierte un reporte de `run` en conocimiento persistente: decisiones, errores,
patrones, preguntas abiertas y follow-ups.

```bash
slad learn
slad learn --agent codex --input ./docs/log/runs/<sessionId>_T1.md
slad learn --agent codex --input ./docs/log/runs/<sessionId>_T1.md --output ./learnings/T1.md
```

Output por defecto: `./learnings/<timestamp>-<task>.md`.

### `slad evolve`

Revisa artefactos recientes (`snapshots/`, `tasks/`, `learnings/` y reportes legacy en `runs/`) y
propone actualizaciones para wiki/patrones.

```bash
slad evolve --agent codex
slad evolve --agent codex --output ./evolution/subprocess-model.md
slad evolve --agent codex --apply-wiki
```

Output por defecto: `./evolution/<timestamp>-evolve.md`. Con `--apply-wiki`,
hace append en `$SLAD_WIKI_PATH/slad-os-evolution.md`.

## Arquitectura

```
src/
├── cli.ts              # entry — commander
├── commands/           # handlers por comando
│   ├── chat.ts         # REPL conversacional con parseAction / suggestNext
│   ├── session.ts      # start / list / use / show
│   ├── explore.ts
│   ├── snapshot.ts
│   ├── plan.ts
│   ├── run.ts          # executeTask + runAutoLoop (DAG + resume)
│   ├── learn.ts
│   └── evolve.ts
├── agents/             # prompts + lógica de cada agente
├── models/             # adapters por provider (ModelProvider interface)
├── core/
│   ├── hitl.ts         # askQuestion / collectAnswers / formatAnswersForPrompt
│   ├── session.ts      # SessionState: create / load / save / appendArtifact
│   ├── config.ts
│   ├── logger.ts
│   └── types.ts        # schemas zod (Question, ExploreOutput, PlanOutput, …)
├── cache/              # reusable.ts — cache on-disk por proyecto
└── templates/          # plantillas Markdown (Snapshot)
```

El seam clave es `ModelProvider`: todos los agentes hablan con esa interfaz,
no con los SDKs de los vendors. Cambiar de Claude a OpenAI es un flag.

`SessionState` es el hilo conductor que atraviesa todos los comandos: cada artefacto
generado (explore, snapshot, plan, run, learn, evolve) queda registrado con su path
y las respuestas HITL se acumulan para inyectarse en los pasos siguientes.

## Roadmap

### Estado actual por fase (repo real)

| Fase | Completado | Falta | Prioridad | Próximo entregable |
|------|------------|-------|-----------|--------------------|
| **Fase 1 — Pipeline tipado base** | Stages `explore` → `snapshot` → `plan` → `run` → `learn` → `evolve` implementados como comandos de Commander; schemas Zod en `core/types.ts` (`ExploreOutput`, `PlanTask`, `RunOutput`, etc.); JSON extraction fence-aware vía `extractJson()`; tests unitarios para `plan`, `explore`, `chat`. | Tests de integración para `learn` y `evolve`; suite E2E que valide el pipeline completo sobre un repo sintético reproducible; smoke test del binario `slad`. | Alta | Suite E2E con fixture de repo controlado que ejecute `explore → run` y valide artefactos en `SessionState`. |
| **Fase 2 — Multi-provider** | `ModelProvider` interface + factory; providers `anthropic`, `openai`, `gemini`, `cli` (codex/claude vía subprocess); resolución por `.env` y CLI flags; `ProviderError` con flag `retryable` (429/529/500). | Backoff exponencial configurable; fallback automático provider-to-provider; token accounting + cost tracking por sesión; soporte streaming para feedback en vivo. | Alta | Token accounting + fallback automático cuando el provider primario devuelve 5xx/429. |
| **Fase 3 — Sesiones y HITL** | `SessionState` CRUD con `appendArtifact()`; loop HITL `awaiting_human` + `questions[]` con `@inquirer/prompts`; `AGENTS.md` injection vía `core/context.ts`; `core/inventory.ts` para describir proyecto. | Persistencia robusta multi-proceso; resumibilidad cross-session (`session restore`); diff entre sesiones; branch/fork de sesión para experimentación. | Alta | Comando `session restore <id>` + `session diff` para comparar runs. |
| **Fase 4 — Cache & observabilidad** | Cache content-based en `~/.slad-os/cache/v1` (`store.ts`, `keys.ts`, `invalidation.ts`, `reusable.ts`) con tests; logger configurable (`SLAD_LOG_LEVEL`, `SLAD_DEBUG`); `project-id` determinista. | Métricas de hit rate; instrumentación OTEL; correlation IDs cross-stage; dashboard CLI/web para visualizar runs; export de trazas. | Media | Métricas básicas (cache hit, latencia por stage, tokens) emitidas en formato consumible. |
| **Fase 5 — Harness de seguridad** | Clasificador `low/med/high` (`classifier.ts`); `AuditLogger` LDJSON append-only (`audit.ts`); `approval.ts` HITL; modes `off` / `on` / `strict` vía flag `--harness`; loader `.slad-os/harness.json`. | Sandboxing real (no solo aprobación HITL); DSL de políticas declarativas; allowlist/blocklist por proyecto; integración con `firejail` o contenedores; tests de evasión. | Alta | Sandbox de ejecución (docker o `firejail`) + DSL de políticas en `harness.json`. |
| **Fase 6 — Evals de calidad** | Tests unitarios con `node:test` en cache, harness, core, commands, project, cli; template de snapshot. | Golden outputs por stage; métricas de calidad (`plan_completeness`, `run_success_rate`, schema_pass_rate); regression suite; benchmark dataset reproducible; baseline contra el cual comparar runs. | Crítica | Benchmark dataset + script de evals reproducible con baseline versionado. |
| **Fase 7 — Distribución y producto** | Build TS a `dist/`; `prepublishOnly` con typecheck; `bin/slad-os.js`; package listo en `npm` (no publicado aún). | CI/CD (GitHub Actions: typecheck + test + build matrix); changelog automatizado (changesets); README robusto; docs site; primera release en `npm`. | Alta | Pipeline CI/CD + primera release pública `slad-os@0.1.0` en npm + docs site. |
| **Fase 8 — Extensibilidad** | Estructura modular por carpetas (`agents/`, `commands/`, `models/`, `harness/`) con interfaces claras. | API de plugins para custom agents/commands; hooks pre/post stage; registry de skills; soporte para lenguajes adicionales (no solo TS). | Media (post-MVP) | API de plugins documentada + un plugin de referencia (e.g. `slad-plugin-python`). |

### Features implementadas

- [x] `explore` — Explorer Agent con output estructurado
- [x] `snapshot` — generador de mini-spec
- [x] `plan` — Planner Agent → `tasks.json`
- [x] `run` — Builder + Reviewer loop
- [x] `run --auto` — auto-loop con DAG topológico y resume detection
- [x] `learn` — captura decisiones en la wiki
- [x] `evolve` — actualiza la wiki automáticamente
- [x] `chat` — REPL conversacional con sugerencias de siguiente paso
- [x] `session` — gestión de sesiones multi-artefacto con contexto persistente
- [x] HITL universal — todos los agentes pueden pausar y pedir input al humano
- [x] Git change detection — muestra archivos modificados por cada tarea
- [ ] Indexación dinámica del codebase — inyectar archivos relevantes por tarea automáticamente (sin `AGENTS.md` manual)
- [ ] MCP server expose (para Claude Code / Cursor)
- [ ] Evals por agente

### Harness Engineering (v0.3)

Inspirado en el paradigma de _Harness Engineering_ (OpenAI Symphony): convertir
el pipeline en una "fábrica" reproducible donde cada sesión corre aislada, el
entorno se levanta de forma determinista, y la verificación produce evidencia
inspeccionable sin clonar el repo.

**Tier 1 — cimientos del harness**

- [ ] **Git Worktrees** — aislamiento por sesión para ejecución paralela del Builder sin colisiones de estado
- [ ] **Bootability stage** — detección determinista de scripts de setup, env vars y dependencias antes del `run`
- [ ] **Playwright CRI verifier** — evidencia visual (video/screenshots) como artefacto del Reviewer, sin overhead de MCP

**Tier 2 — extensiones cuando Tier 1 esté maduro**

- [ ] **Ticket-driven mode** — trigger del pipeline desde transiciones de estado en Linear / GitHub Issues
- [ ] **`workflow.mmd` export** — diagrama Mermaid renderizable del pipeline configurado por proyecto
- [ ] **Observability ContextProvider** — inyección de logs/métricas reales (Grafana/Datadog/Sentry) como contexto del Explorer

Plan de implementación detallado: [`docs/implementation-plan-harness-engineering.md`](docs/implementation-plan-harness-engineering.md).

## Pasos hacia un MVP productivo

Más allá de las fases 1-7, hay un set de _production blockers_ que típicamente no aparecen en un roadmap funcional pero son los que separan un proyecto interesante de uno usable por terceros.

### A. Confiabilidad

1. **Determinismo y reproducibilidad** — fijar `temperature: 0` por defecto en stages críticos (`plan`, `run`), seed configurable, snapshots de prompts versionados.
2. **Idempotencia del pipeline** — si re-ejecutas un stage con los mismos inputs, debe producir el mismo output (vía cache content-based, ya parcialmente resuelto).
3. **Manejo de fallos parciales** — si `run` falla a mitad de pipeline, poder reanudar desde donde se quedó sin re-ejecutar stages anteriores.
4. **Timeouts y circuit breakers** — cap por stage (e.g. `plan` no puede tomar > 5 min), límite global por sesión.

### B. Costos y consumo

5. **Budget caps** — `slad --budget=$5` aborta la sesión si supera el límite; warning al 80%.
6. **Token telemetry persistente** — log de tokens por stage / provider / model para análisis de cost-per-task.
7. **Cache aggressiveness configurable** — `--cache=strict|loose|off` para balancear costo vs. frescura.

### C. Observabilidad

8. **Trazas estructuradas** — cada stage emite span con metadata (provider, model, tokens, duration, cache_hit). Compatible con OTEL para enviar a Honeycomb/Datadog.
9. **Replay de sesiones** — `slad session replay <id>` re-renderiza un run pasado paso a paso (útil para debugging y demos).
10. **Modo `--explain`** — imprime decisiones del orquestador (por qué eligió tal provider, por qué invalidó cache, por qué activó el harness).

### D. Seguridad

11. **Secret scanning en context** — antes de mandar contexto al LLM, escanear por secretos (API keys, passwords) y redactarlos.
12. **Sandboxing real del harness** — comandos `high` siempre corren en contenedor o `firejail`, sin acceso a `~/.ssh`, `~/.aws`, etc.
13. **Audit log inmutable** — opcional: append-only con hash chaining (cada entry referencia hash del anterior) para detectar tampering.

### E. UX y DX

14. **Quickstart en < 60 segundos** — `npx slad-os explore "fix bug X"` debe funcionar sin setup más allá de un `.env`.
15. **Mensajes de error accionables** — si `ANTHROPIC_API_KEY` falta, el error debe decir exactamente qué archivo crear y qué línea agregar.
16. **Modo `--dry-run`** — simula el pipeline sin llamar a LLMs (útil para CI y para ver qué prompts se enviarían).

### F. Distribución

17. **CI/CD GitHub Actions** — matrix de Node 20/22 × macOS/Linux/Windows; release automática en tag.
18. **Changelog automatizado** — `changesets` para semver disciplinado.
19. **Plugin/extension manifest** — formato estable para que terceros publiquen `slad-plugin-*` en npm.

### G. Validación con usuarios reales

20. **Beta cerrada con 3-5 power users** — validar sobre repos reales de los usuarios, no fixtures sintéticos.
21. **Feedback loop estructurado** — comando `slad feedback <session_id>` que envía (con consent) el run a un endpoint para análisis.

### Sugerencia de priorización

Si el objetivo es **lanzar un MVP público en npm** que genere tracción:

**Bloque crítico (semanas 1-3):** Fase 1 (E2E tests), Fase 7 (CI/CD + primera release), pasos A.1 / A.2 / A.3 (determinismo + reanudación), paso E.14 (quickstart).

**Bloque de confianza (semanas 4-6):** Fase 6 (evals con baseline), Fase 5 completar (sandboxing real), pasos B.5 (budget) y C.8 (trazas estructuradas).

**Post-MVP (mes 2+):** Fase 8 (plugins), pasos C.9 (replay) y G.20 (beta cerrada).

Las **Fases 2, 3, 4** se pueden completar incrementalmente en paralelo según dolor real de uso.
