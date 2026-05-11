# Soporte Markdown en Pipeline y Patrones de Testeo

## Summary
Se ha validado con éxito la transición de artifacts de ejecución (runs) desde formato JSON legacy a Markdown con YAML/frontmatter. Esta evolución permite que el comando `learn` reconstruya contexto desde archivos legibles y editables por humanos sin perder compatibilidad. Se proponen nuevos patrones de testeo para comandos de agentes basados en inyección de dependencias (provider/cwd) y aserciones semánticas.

## Proposed Updates
### docs/architecture/artifacts.md
Change: create
Rationale: Documentar la transición a Markdown+YAML como estándar de persistencia para artifacts del pipeline.

```markdown
# Artifacts del Pipeline

SLAD OS evoluciona de archivos `.json` planos a archivos `.md` con frontmatter YAML para mejorar la legibilidad y trazabilidad.

## Formatos Soportados
- **Legacy**: `docs/log/runs/*.json`. Soportado para compatibilidad hacia atrás en lectura.
- **Moderno**: `docs/log/{kind}/*.md`. Usa frontmatter delimitado por `---` seguido de contenido Markdown.

## Resolución de Artifacts
El sistema prioriza artifacts referenciados en la sesión (`SessionState`). Si no hay referencia, comandos como `learn` buscan el archivo más reciente en el sistema de archivos, priorizando formatos legacy durante la transición si no se encuentran archivos modernos.
```

### docs/patterns/testing.md
Change: create
Rationale: Estandarizar el enfoque de tests de integración para comandos que interactúan con LLMs.

```markdown
# Patrones de Testeo

## Tests de Integración de Comandos
Para probar comandos como `explore`, `plan`, `run` o `learn` sin depender de red o costos de API:

1. **Inyección de Dependencias**: Los comandos deben aceptar un `modelProvider` opcional y un `cwd` para aislar el sistema de archivos.
2. **Fixtures Temporales**: Usar directorios temporales y `process.chdir` (restaurando en un bloque `finally`) para simular estados de proyecto.
3. **Fake Providers**: Implementar un provider que capture los mensajes enviados y devuelva respuestas JSON predefinidas que cumplan con los esquemas de Zod.
4. **Aserciones Semánticas**: No comparar prompts exactos (son frágiles). Validar que los datos clave del artifact de entrada estén presentes en los mensajes y que el output resultante sea válido.
5. **Limpieza**: Siempre usar `finally` para borrar archivos temporales y evitar efectos secundarios entre tests.
```

## Pattern Updates
- Uso de 'testability seams': Inyectar modelProvider y cwd en todos los comandos HITL.
- Colocación de tests: Mantener archivos `.test.ts` junto al código fuente en `src/`.
- Aserciones semánticas: Validar contenido lógico en lugar de snapshots de texto en interacciones con LLM.

## Snapshot Updates
- None

## Next Actions
- Aplicar el patrón de inyección (provider/cwd) a `exploreCommand`, `planCommand` y `runCommand`.
- Establecer un cronograma de deprecación para el soporte de lectura de artifacts `.json` legacy.
- Migrar otros artifacts (snapshot, plan) al formato Markdown+YAML si aún no lo están.
