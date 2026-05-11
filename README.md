# slad-os

CLI de **SLAD OS** — Spec-Light Agentic Dev OS.

Un **pipeline tipado** para coding agents. Cada intención atraviesa stages auditables —
`explore → snapshot → plan → run → learn → evolve` — y produce artefactos JSON
validados por Zod que el siguiente stage consume como input.

No es un runner de agentes en paralelo. Es lo opuesto: **profundidad, no throughput.**
Un task estructurado y verificable — con HITL nativo, cache content-based, y un loop de
aprendizaje (`learn` + `evolve`) que destila decisiones del run a la wiki del proyecto.

Provider-agnostic: Claude, OpenAI, Gemini o un binario local (Codex / Claude Code)
detrás de la misma interfaz `ModelProvider`. Cambiar de proveedor es un flag de CLI,
no una reescritura.

Primera versión (`0.1.0`): comandos `explore`, `snapshot`, `plan`, `run`, `learn` y `evolve`.

---

## ¿Qué es?

SLAD OS es un **pipeline estructurado para coding agents**, operado desde la terminal. Cada stage es un agente especializado con un schema de salida validado por Zod, y el output de uno se convierte en input tipado del siguiente. En vez de hablar directamente con un LLM y construir prompts a mano, modelas la intención como un artefacto que atraviesa transformaciones verificables.

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

### ¿En qué se diferencia de Conductor y otros runners de agentes paralelos?

Hay una nueva ola de tooling para coding agents (Conductor, multi-agent IDEs, etc.)
que comparte la palabra "orquestar" pero resuelve un problema **distinto**.
SLAD OS no compite con esas herramientas — opera en otra dimensión.

| Eje | Runners paralelos (Conductor, etc.) | SLAD OS |
|-----|-------------------------------------|---------|
| **Topología** | Horizontal: N agentes en paralelo, cada uno en su worktree | Vertical: un task atraviesa stages tipados secuencialmente |
| **Unidad de trabajo** | Tarea → agente → diff → PR | Intención → stages → artefactos JSON validados |
| **Estado** | Worktrees + diffs en disco | `SessionState` + Zod schemas + `docs/log/` inspeccionable |
| **Foco** | Throughput (lanzar más tareas a la vez) | Calidad y auditabilidad (cada decisión queda externalizada) |
| **HITL** | Review final del PR | Pausa/pregunta en cualquier stage; respuestas inyectadas en los siguientes |
| **Learning loop** | No | `learn` + `evolve` destilan patrones del run a la wiki del proyecto |
| **Provider** | Wraps Claude Code / Codex como agentes | Abstrae Anthropic / OpenAI / Gemini / binario local detrás de `ModelProvider` |
| **Forma** | App GUI (típicamente macOS) | CLI cross-platform |

**No compiten — se componen.** Cada agente que un runner paralelo dispara podría
ejecutar una pipeline SLAD por dentro: el runner aporta aislamiento por worktree,
SLAD aporta verificación tipada y aprendizaje stage-a-stage.

Heurística rápida:

- *"Quiero lanzar 5 tareas a 5 agentes a la vez sin que se pisen"* → un runner paralelo.
- *"Quiero que cada tarea produzca artefactos estructurados, auditables, y que el sistema aprenda del run"* → SLAD OS.

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
La mayoría de los flujos con agentes son una caja negra. `slad` hace lo opuesto: cada decisión queda externalizada en un artefacto Markdown+YAML bajo `docs/log/`. Puedes revisar el explore antes de generar el spec, el plan antes de ejecutar, y cada run antes de aprender de él. El humano está en el loop en los puntos que importan, no monitoreando un proceso opaco.

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

La sesión activa se persiste en `docs/log/sessions/.active-session`. Todos los comandos sin
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
slad explore "..." --json
```

Output por defecto en sesión: `<docsRoot>/log/explores/<sessionId>.md`.

### `slad snapshot`

Genera un Snapshot Markdown (mini-spec de 1 página) a partir de:
- un artifact `explore.md` previo (flujo recomendado), o
- una intención suelta.

```bash
# Flujo completo:
slad explore "memoria por proyecto" --agent codex
slad snapshot --approach "vector"

# Atajo:
slad snapshot --intent "memoria por proyecto" --agent codex
```

Output por defecto: `<docsRoot>/log/snapshots/<sessionId>.md`.

### `slad plan`

Convierte un Snapshot en un `plan.md`: tareas atómicas, dependencias, archivos
probables, criterios de aceptación y checks de verificación.

```bash
slad plan
slad plan --input ./docs/log/snapshots/<sessionId>.md --agent codex
slad plan --input ./docs/log/snapshots/<sessionId>.md --json
```

Output por defecto: `<docsRoot>/log/plans/<sessionId>.md`.

### `slad run`

Ejecuta una tarea de un `plan.md` con el loop Builder + Reviewer y guarda un
reporte Markdown con YAML frontmatter en `<docsRoot>/log/runs/`. Si no pasás
`--task`, usa `recommendedFirstTask`.

```bash
slad run
slad run --task T3
slad run --agent codex --input ./docs/log/plans/<sessionId>.md --task T1
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
slad learn --agent codex --input ./docs/log/runs/<sessionId>_T1.md --json
```

Output por defecto: `<docsRoot>/log/learnings/<sessionId>_<taskId>.md`.

### `slad evolve`

Revisa artefactos recientes bajo `docs/log/` y
propone actualizaciones para wiki/patrones.

```bash
slad evolve --agent codex
slad evolve --agent codex --apply-wiki
```

Output por defecto: `<docsRoot>/log/evolution/<sessionId>.md`. Con `--apply-wiki`,
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

Roadmap detallado con estado por fase, production blockers y priorización: [`roadmap.md`](roadmap.md).

### Features implementadas

- [x] Pipeline completo: `explore` → `snapshot` → `plan` → `run` → `learn` → `evolve`
- [x] `auto` — pipeline intent→código en un comando con budget, scratchpad y auto-resolve HITL
- [x] `chat` — REPL conversacional con sugerencias de siguiente paso
- [x] `session` — gestión de sesiones multi-artefacto con contexto persistente
- [x] `stats` — totales de sesiones, runs y learnings
- [x] HITL universal — todos los agentes pausan y piden input; auto-resolve en modo auto
- [x] Tool use real — readFile, writeFile, listDir, grep, exec, git ops vía tool-loop genérico
- [x] Scratchpad — offloading de tool results grandes a disco con summary en context
- [x] Budget tracker — token/cost tracking por stage y modelo con warnings y abort
- [x] Git change detection — muestra archivos modificados por cada tarea
- [x] Resume detection — `run --auto` detecta tasks completadas y ofrece resumir
- [x] Follow-up execution — ejecución de follow-ups sugeridos por el agente
- [x] Harness de seguridad — clasificador, audit log, approval, 3 modes
- [x] Persistence layer — Markdown+YAML frontmatter con renderers/parsers por tipo
- [x] Multi-provider — Anthropic, OpenAI, Gemini, CLI (Codex/Claude) con tool use
- [x] CLI discovery — detección automática de binarios locales con cache
- [x] Cache content-based — store, keys, invalidation, reusable API
- [x] `--dry-run` en auto — explore+snapshot+plan sin ejecutar código
- [ ] Indexación dinámica del codebase
- [ ] MCP server expose (para Claude Code / Cursor)
- [ ] UI Desktop (brief listo en `docs/ui-prototype-brief.md`)
- [ ] Plugin system
- [ ] Evals por agente
- [ ] CI/CD + npm publish
