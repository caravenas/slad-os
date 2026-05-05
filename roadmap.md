# 15.1 Estado actual por fase (repo real)

| Fase | Completado | Falta | Prioridad | Próximo entregable |
|------|------------|-------|-----------|--------------------|
| **Fase 1 — Pipeline tipado base** | Stages `explore` → `snapshot` → `plan` → `run` → `learn` → `evolve` implementados como comandos de Commander; schemas Zod en `core/types.ts` (`ExploreOutput`, `PlanTask`, `RunOutput`, etc.); JSON extraction fence-aware vía `extractJson()`; tests unitarios para `plan`, `explore`, `chat`. | Tests de integración para `learn` y `evolve`; suite E2E que valide el pipeline completo sobre un repo sintético reproducible; smoke test del binario `slad`. | Alta | Suite E2E con fixture de repo controlado que ejecute `explore → run` y valide artefactos en SessionState. |
| **Fase 2 — Multi-provider** | `ModelProvider` interface + factory; providers `anthropic`, `openai`, `gemini`, `cli` (codex/claude vía subprocess); resolución por `.env` y CLI flags; `ProviderError` con flag `retryable` (429/529/500). | Backoff exponencial configurable; fallback automático provider-to-provider; token accounting + cost tracking por sesión; soporte streaming para feedback en vivo. | Alta | Token accounting + fallback automático cuando el provider primario devuelve 5xx/429. |
| **Fase 3 — Sesiones y HITL** | `SessionState` CRUD con `appendArtifact()`; loop HITL `awaiting_human` + `questions[]` con `@inquirer/prompts`; `AGENTS.md` injection vía `core/context.ts`; `core/inventory.ts` para describir proyecto. | Persistencia robusta multi-proceso; resumibilidad cross-session (`session restore`); diff entre sesiones; branch/fork de sesión para experimentación. | Alta | Comando `session restore <id>` + `session diff` para comparar runs. |
| **Fase 4 — Cache & observabilidad** | Cache content-based en `~/.slad-os/cache/v1` (`store.ts`, `keys.ts`, `invalidation.ts`, `reusable.ts`) con tests; logger configurable (`SLAD_LOG_LEVEL`, `SLAD_DEBUG`); `project-id` determinista. | Métricas de hit rate; instrumentación OTEL; correlation IDs cross-stage; dashboard CLI/web para visualizar runs; export de trazas. | Media | Métricas básicas (cache hit, latencia por stage, tokens) emitidas en formato consumible. |
| **Fase 5 — Harness de seguridad** | Clasificador `low/med/high` (`classifier.ts`); `AuditLogger` LDJSON append-only (`audit.ts`); `approval.ts` HITL; modes `off` / `on` / `strict` vía flag `--harness`; loader `.slad-os/harness.json`. | Sandboxing real (no solo aprobación HITL); DSL de políticas declarativas; allowlist/blocklist por proyecto; integración con `firejail` o contenedores; tests de evasión. | Alta | Sandbox de ejecución (docker o `firejail`) + DSL de políticas en `harness.json`. |
| **Fase 6 — Evals de calidad** | Tests unitarios con `node:test` en cache, harness, core, commands, project, cli; template de snapshot. | Golden outputs por stage; métricas de calidad (`plan_completeness`, `run_success_rate`, schema_pass_rate); regression suite; benchmark dataset reproducible; baseline contra el cual comparar runs. | Crítica | Benchmark dataset + script de evals reproducible con baseline versionado. |
| **Fase 7 — Distribución y producto** | Build TS a `dist/`; `prepublishOnly` con typecheck; `bin/slad-os.js`; package listo en `npm` (no publicado aún). | CI/CD (GitHub Actions: typecheck + test + build matrix); changelog automatizado (changesets); README robusto; docs site; primera release en `npm`. | Alta | Pipeline CI/CD + primera release pública `slad-os@0.1.0` en npm + README completo. |
| **Fase 8 — Extensibilidad** | Estructura modular por carpetas (`agents/`, `commands/`, `models/`, `harness/`) con interfaces claras. | API de plugins para custom agents/commands; hooks pre/post stage; registry de skills; soporte para lenguajes adicionales (no solo TS). | Media (post-MVP) | API de plugins documentada + un plugin de referencia (e.g. `slad-plugin-python`). |

---

# 15.2 Pasos para cerrar un MVP sólido para productivo

Más allá de las fases 1-7, hay un set de "production blockers" que típicamente no aparecen en un roadmap funcional pero son los que separan un proyecto interesante de uno usable por terceros:

## A. Confiabilidad

1. **Determinismo y reproducibilidad** — fijar `temperature: 0` por defecto en stages críticos (`plan`, `run`), seed configurable, snapshots de prompts versionados.
2. **Idempotencia del pipeline** — si re-ejecutas un stage con los mismos inputs, debe producir el mismo output (vía cache content-based, ya parcialmente resuelto).
3. **Manejo de fallos parciales** — si `run` falla a mitad de pipeline, poder reanudar desde donde se quedó sin re-ejecutar stages anteriores.
4. **Timeouts y circuit breakers** — cap por stage (e.g. `plan` no puede tomar > 5 min), límite global por sesión.

## B. Costos y consumo

5. **Budget caps** — `slad --budget=$5` aborta la sesión si supera el límite; warning al 80%.
6. **Token telemetry persistente** — log de tokens por stage / provider / model para análisis de cost-per-task.
7. **Cache aggressiveness configurable** — `--cache=strict|loose|off` para balancear costo vs. frescura.

## C. Observabilidad

8. **Trazas estructuradas** — cada stage emite span con metadata (provider, model, tokens, duration, cache_hit). Compatible con OTEL para enviar a Honeycomb/Datadog si el usuario quiere.
9. **Replay de sesiones** — `slad session replay <id>` re-renderiza un run pasado paso a paso (útil para debugging y demos).
10. **Modo `--explain`** — imprime decisiones del orquestador (por qué eligió tal provider, por qué invalidó cache, por qué activó el harness).

## D. Seguridad

11. **Secret scanning en context** — antes de mandar contexto al LLM, escanear por secretos (API keys, passwords) y redactarlos.
12. **Sandboxing real del harness** — comandos `high` siempre corren en contenedor o `firejail`, sin acceso a `~/.ssh`, `~/.aws`, etc.
13. **Audit log inmutable** — opcional: append-only con hash chaining (cada entry referencia hash del anterior) para detectar tampering.

## E. UX y DX

14. **README + docs site** — hoy no hay README en root; necesario para adopción externa.
15. **Quickstart en < 60 segundos** — `npx slad-os explore "fix bug X"` debe funcionar sin setup más allá de un `.env`.
16. **Mensajes de error accionables** — si `ANTHROPIC_API_KEY` falta, el error debe decir exactamente qué archivo crear y qué línea agregar.
17. **Modo `--dry-run`** — simula el pipeline sin llamar a LLMs (útil para CI y para ver qué prompts se enviarían).

## F. Distribución

18. **CI/CD GitHub Actions** — matrix de Node 20/22 × macOS/Linux/Windows; release automática en tag.
19. **Changelog automatizado** — `changesets` para semver disciplinado.
20. **Plugin/extension manifest** — formato estable para que terceros publiquen `slad-plugin-*` en npm.

## G. Validación con usuarios reales

21. **Beta cerrada con 3-5 power users** — validar sobre repos reales de los usuarios, no fixtures sintéticos.
22. **Feedback loop estructurado** — comando `slad feedback <session_id>` que envía (con consent) el run a un endpoint para análisis.

---

## Sugerencia de priorización

Si el objetivo es **lanzar un MVP público en npm** que genere tracción:

**Bloque crítico (semanas 1-3):**
- Fase 1 (E2E tests)
- Fase 7 (CI/CD + README + primera release)
- Pasos A.1, A.2, A.3 (determinismo + reanudación)
- Paso E.14 (README), E.15 (quickstart)

**Bloque de confianza (semanas 4-6):**
- Fase 6 (evals con baseline)
- Fase 5 completar (sandboxing real)
- Pasos B.5 (budget), C.8 (trazas estructuradas)

**Post-MVP (mes 2+):**
- Fase 8 (plugins)
- Pasos C.9 (replay), G.21 (beta cerrada)

Las **Fases 2, 3, 4** se pueden completar incrementalmente en paralelo según dolor real de uso.
