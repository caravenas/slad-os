# Project Cache v1

## Objetivo

Definir un contrato minimo de cache local por proyecto para SLAD OS v1 que:

- aisle lecturas y escrituras entre proyectos;
- permita invalidacion deterministica;
- sea inspeccionable y borrable manualmente;
- limite la adopcion inicial a CLI, Planner y agents.

Esta spec cierra solo el alcance v1. No define sincronizacion entre maquinas, deduplicacion cross-project ni integracion obligatoria con UI/MCP.

## Decisiones cerradas en v1

Esta spec fija cuatro decisiones para desbloquear implementacion sin acoplar capas antes de tiempo:

1. Objetos incluidos/excluidos: v1 solo persiste `retrieved_context`, `agent_outputs`, `snapshots` y `artifacts_metadata`; embeddings, eventos y otros estados de alto volumen o contrato inestable quedan fuera.
2. Clave de proyecto: `projectId` se deriva de una identidad local persistida por proyecto y no solo de la ruta actual, priorizando aislamiento fuerte entre clones, forks y carpetas no git.
3. Invalidacion: toda reutilizacion exige coincidencia de `snapshot_hash`, `input_signature`, `tool_version`/`runtime_version`, `schema_version` y ausencia de cambios en archivos relevantes.
4. Consumidores iniciales: solo CLI, Planner y agents leen/escriben en v1; UI y MCP quedan fuera de escritura y no forman parte del contrato de adopcion inicial.

## Objetos incluidos en v1

La cache v1 puede persistir unicamente estos namespaces:

1. `retrieved_context`
2. `agent_outputs`
3. `snapshots`
4. `artifacts_metadata`

Definicion minima por tipo:

- `retrieved_context`: contexto derivado o recuperado para un flujo puntual, junto con metadata suficiente para invalidarlo por cambios de inputs y archivos relevantes.
- `agent_outputs`: salidas estructuradas o texto final reutilizable de Planner y agents cuando la misma entrada semantica deberia producir el mismo resultado reutilizable.
- `snapshots`: snapshot materializado o su representacion canonica cuando derive del mismo intent/contexto y siga siendo valido por firma de inputs.
- `artifacts_metadata`: indices livianos sobre artefactos generados por el flujo, sin guardar aqui el artefacto fuente si ya existe como archivo canonico fuera del cache.

## Objetos excluidos en v1

Quedan explicitamente fuera de scope en v1:

- embeddings;
- eventos de runtime o de streaming;
- transcripts completos de sesiones;
- logs operativos;
- respuestas parciales o chunks de providers;
- deduplicacion global entre proyectos;
- sincronizacion o restore entre maquinas;
- cualquier estado de UI Control Center o MCP.

Razon: estos objetos tienen volumen, frecuencia o contratos mas inestables y aumentarian el acoplamiento antes de estabilizar la identidad de proyecto y la invalidacion.

## Estrategia de `projectId`

`projectId` es la clave de aislamiento primaria y debe ser estable para ejecuciones repetidas del mismo proyecto local.

Estado actual de implementacion:

- la resolucion vive en `src/project/project-id.ts`;
- la metadata local del proyecto se persiste en `<project-root>/.slad-os/project-id.json`;
- el registro global de bootstrap se persiste en `<cache-root>/registrations/<hash>.json`;
- el namespace persistido del cache usa el `projectId` resuelto desde esa identidad.

Regla v1:

1. Resolver la raiz del proyecto.
2. Si existe repositorio git, usar la raiz del repo como unidad de proyecto.
3. Si no existe git, usar la carpeta de trabajo invocada como unidad de proyecto.
4. Persistir metadata local del proyecto para no depender solo de la ruta fisica actual.
5. Derivar `projectId` a partir de esa metadata persistida; la ruta actual solo actua como input de bootstrap, no como identidad final.

Persistencia minima requerida para bootstrap:

- antes de resolver `projectId`, la CLI/runtime debe poder leer o crear un registro bootstrap en un namespace global de cache, por ejemplo `<cache-root>/registrations/<root_fingerprint>.json`;
- ese registro bootstrap guarda al menos `local_project_uid`, `projectId`, `projectRoot`, `projectKind`, `rootFingerprint` y `gitRemoteUrl` cuando exista;
- la identidad local del proyecto se persiste en `<project-root>/.slad-os/project-id.json`;
- el namespace global de cache persiste metadata paralela en `projects/<projectId>/project.json` para inspeccion manual del storage.

Inputs minimos de derivacion/persistencia:

- `project_root`: ruta absoluta normalizada detectada en el bootstrap;
- `git_root`: raiz del repo cuando exista;
- `git_remote_origin` cuando exista, solo como señal adicional y no como identidad exclusiva;
- `local_project_uid`: UUID persistido localmente en metadata del proyecto/cache, creado una sola vez;
- `schema_version`: version del formato de identidad/cache.

Decision operativa v1:

- la identidad efectiva implementada es `projectId = <projectKind>:<hash(version + local_project_uid + projectKind + git_remote_origin?)>`;
- `local_project_uid` es obligatorio y es la pieza que evita colisiones entre clones/forks nominalmente equivalentes en el filesystem o contra el mismo remote;
- una vez emitido `local_project_uid`, la reutilizacion normal del proyecto debe recuperar esa identidad desde `.slad-os/project-id.json` o `registrations/` antes de considerar la ruta actual como fuente de verdad;
- en monorepo, el `projectId` se resuelve al repo raiz por defecto;
- en forks o clones distintos, diferentes `local_project_uid` producen distinto `projectId` aunque el remote coincida;
- en carpetas no git, mover la carpeta no debe mezclar namespaces: si el bootstrap permite reconciliar la nueva ruta con el mismo `local_project_uid`, se conserva el `projectId`; si no, se crea una identidad nueva;
- si el bootstrap no puede reconciliar la carpeta actual con un registro previo, debe crear una nueva identidad local antes que reutilizar una dudosa.

Esto prioriza aislamiento fuerte local por encima de compartir cache entre clones.

## Reglas de invalidacion v1

Cada entrada reutilizable debe indexarse, como minimo, por:

- `snapshot_hash`;
- `input_signature`;
- `tool_version` o `runtime_version`;
- `schema_version`.

La regla de hit v1 es estricta: solo hay hit cuando coinciden todas las claves anteriores y no hubo cambios en archivos relevantes del tipo cacheado.

Invalidacion minima obligatoria:

1. Cambio de `snapshot_hash` => miss.
2. Cambio de `input_signature` => miss.
3. Cambio de `tool_version` o `runtime_version` => miss.
4. Cambio de `schema_version` => miss.
5. Cambio en archivos relevantes => miss para `retrieved_context` y cualquier derivado que dependa de ese contexto.

Regla de archivos relevantes:

- para `retrieved_context`, el producer debe persistir un manifiesto de archivos observados por ese flujo;
- la validez requiere que path, hash o mtime/size canonico de cada archivo observado siga coincidiendo;
- si el flujo no puede enumerar archivos relevantes con confianza, debe degradar a miss en vez de servir contexto stale.

`input_signature` debe representar los inputs semanticos del flujo, por ejemplo: prompt normalizado, flags relevantes, selector de provider/model, artifact source y cualquier parametro que cambie el resultado reutilizable.

Contrato operativo minimo para estas claves:

- `snapshot_hash`: hash estable del snapshot o intent materializado usado por el flujo;
- `input_signature`: hash estable de los inputs semanticos normalizados del producer;
- `tool_version`: version de la CLI o del paquete que define el contrato del producer;
- `runtime_version`: identificador de runtime efectivo cuando cambie semantica de ejecucion, por ejemplo provider, modelo o version de prompt;
- si un flujo no distingue `tool_version` de `runtime_version`, puede persistir ambos dentro del mismo sobre de metadata, pero debe invalidar ante cambio de cualquiera de las dos dimensiones.

Decision de contrato v1:

- este documento define el contrato minimo de `snapshot_hash`, `input_signature`, `tool_version` y `runtime_version` para cache, aunque otras capas todavia no lo compartan de forma global;
- si un entrypoint aun no expone una de estas dimensiones por separado, debe materializar un valor canonico equivalente dentro de la metadata del producer antes de escribir cache;
- ningun consumer v1 puede asumir semantica mas debil que este contrato.

Conjunto minimo de archivos relevantes por flujo:

- `retrieved_context`: archivos explicitamente leidos, listados o resumidos para construir el contexto reutilizable;
- `agent_outputs`: no requiere manifiesto propio si depende de `retrieved_context` cacheado valido; si lee archivos extra fuera de ese contexto, debe agregarlos a su propio manifiesto;
- `snapshots`: archivos fuente usados para materializar el snapshot cuando el snapshot no sea puramente input-driven;
- `artifacts_metadata`: solo los archivos canonicos cuyos metadatos se indexan.

Regla conservadora v1: si hay duda sobre si un archivo afecto el resultado, se incluye en el manifiesto. Si no puede incluirse de forma confiable, corresponde miss.

## Hits y misses

Hay hit de cache solo cuando se cumplen todas estas condiciones:

- el flujo resuelve el mismo `projectId`;
- coincide la `reuseKey`, que hoy agrupa `snapshot_hash`, `input_signature`, `tool_version`, `runtime_version` y `schema_version`;
- si existe manifiesto de archivos relevantes, todos siguen presentes y con el mismo hash, tamaño y `mtimeMs`;
- el producer marcaria esa salida como reutilizable.

Hay miss de cache cuando ocurre cualquiera de estas condiciones:

- cambia el snapshot materializado usado por el flujo;
- cambian los inputs semanticos del producer;
- cambia la version de la CLI o la version efectiva de runtime;
- cambia cualquier archivo relevante o desaparece;
- el flujo genera una salida no cacheable;
- todavia no existe una entrada para esa `reuseKey` dentro del namespace del proyecto.

Estado actual de adopcion:

- `src/commands/plan.ts` ya usa `readOrCreateReusableValue()` con `objectType: "planner"`;
- el contrato v1 sigue acotado a CLI/Planner/agents;
- no todos los namespaces conceptuales de la spec tienen writers activos todavia.

## Consumidores iniciales

Consumidores autorizados en v1:

- CLI commands;
- Planner;
- agents invocados por los flujos de CLI.

Permisos v1:

- CLI/Planner/agents pueden leer y escribir bajo el mismo `projectId`;
- UI Control Center y MCP pueden quedar completamente fuera o limitarse a lectura futura, pero v1 no les exige ni les autoriza escritura;
- ningun consumer fuera de CLI/Planner/agents puede crear, mutar o invalidar entradas de cache en v1.

Fuera de escritura en v1:

- UI Control Center;
- MCP server;
- integraciones externas futuras;
- runtime/event bus futuro fuera de los entrypoints anteriores.

Esto evita fijar demasiado pronto contratos compartidos con capas que todavia no estan estabilizadas.

## Estructura on-disk

La cache v1 debe vivir separada del codigo fuente y del arbol canonico de artefactos del proyecto. La ubicacion exacta puede ser global del usuario, pero siempre namespaced por `projectId`.

Regla operativa:

- `<cache-root>` vive fuera del workspace del proyecto y fuera de directorios versionados del repo;
- ejemplos validos: un directorio de estado de usuario o de runtime dedicado a SLAD OS;
- ejemplos invalidos: cualquier ruta dentro del repo activo, `src/`, `dist/`, `snapshots/`, `tasks/` o carpetas canonicas de artefactos del proyecto.

Layout on-disk actual:

```text
<cache-root>/
  registrations/
    <root_fingerprint_hash>.json
  projects/
    <project-namespace>/
      project.json
      objects/
        <object-namespace>/
          object.json
          entries/
            <entry-namespace>.json
```

Requisitos:

- `<cache-root>` no vive dentro de `src/`, `dist/`, `snapshots/`, `tasks/` ni otros directorios de codigo fuente;
- cada namespace de objeto se guarda en subdirectorios separados bajo `objects/`;
- el contenido debe ser inspeccionable manualmente con archivos legibles o metadata simple;
- borrar `projects/<project-namespace>/` limpia solo la cache de ese proyecto sin tocar codigo fuente ni cache de otros proyectos.

Archivos que hoy existen por contrato operativo:

- `<project-root>/.slad-os/project-id.json`: identidad local persistida del proyecto;
- `<cache-root>/registrations/<hash>.json`: bootstrap global para reencontrar la identidad;
- `<cache-root>/projects/<project-namespace>/project.json`: metadata del namespace del proyecto y politica GC;
- `<cache-root>/projects/<project-namespace>/objects/<object-namespace>/object.json`: metadata del namespace del tipo de objeto;
- `<cache-root>/projects/<project-namespace>/objects/<object-namespace>/entries/<entry>.json`: entradas persistidas con `key`, `projectId`, `objectType`, `value`, `storedAt` y eventualmente `expiresAt`.

Regla practica para ubicar namespaces:

- `<project-namespace>` no es el `projectId` crudo; es un segmento derivado con nombre normalizado y hash;
- `<object-namespace>` tampoco es el `objectType` crudo; sigue la misma regla;
- para encontrar el directorio correcto, hay que abrir cada `project.json` u operar con una busqueda por contenido sobre `projectId`, no asumir coincidencia literal de nombres.

Mapeo actual de tipos de objeto:

- la spec conceptual enumera `retrieved_context`, `agent_outputs`, `snapshots` y `artifacts_metadata`;
- la implementacion actual acepta cualquier `objectType` string y hoy el writer activo usa `planner`;
- para inspeccion operativa v1, el namespace concreto a revisar depende del consumer real que este escribiendo.

## GC y limites operativos v1

v1 no requiere TTL ni cuotas activas. La politica minima aceptada es borrado manual documentado por proyecto.

Decision cerrada:

- la politica minima de GC en v1 es exclusivamente borrado manual por proyecto;
- no se exige TTL, cuotas ni compactacion automatica en la implementacion inicial.
- la implementacion debe dejar esta politica visible en el namespace persistido del proyecto para que un operador pueda inspeccionarla sin leer codigo;
- los consumers v1 no deben depender de expiracion temporal para mantener consistencia: la validez se decide por identidad e invalidacion deterministica, no por edad.

Consecuencias aceptadas en v1:

- el almacenamiento puede crecer;
- no se garantiza reclaim automatico;
- producers deben evitar guardar payloads innecesariamente grandes cuando baste con metadata.
- el reclaim soportado por contrato es borrar manualmente `projects/<project-namespace>/`; esa operacion debe preservar codigo fuente y la cache de otros proyectos.
- cualquier soporte tecnico de expiracion puntual en el storage se considera detalle interno no adoptado por el contrato v1 mientras no exista una politica de quotas/TTL compartida por los consumers.

TTL/cuotas quedan para una version posterior una vez que el contrato de identidad e invalidacion este estable.

## Inspeccion y limpieza manual

Inspeccion minima por proyecto:

1. Abrir `<project-root>/.slad-os/project-id.json` y anotar `projectId`.
2. Buscar ese `projectId` dentro de `<cache-root>/projects/*/project.json` para ubicar el namespace correcto.
3. Revisar `project.json`, `object.json` y `entries/*.json` del namespace que interese.

Limpieza manual por proyecto:

1. Identificar el directorio `<cache-root>/projects/<project-namespace>/`.
2. Borrar solo ese directorio.
3. No borrar el repo ni artefactos canonicos como `src/`, `dist/`, `snapshots/`, `tasks/`, `runs/` o `learnings/`.

Ejemplo con el root por defecto:

```bash
find ~/.slad-os/cache/v1/projects -name project.json -print -exec grep -H '\"projectId\"' {} \;
rm -rf ~/.slad-os/cache/v1/projects/<project-namespace>
```

Limites explicitos de v1:

- no hay CLI dedicada para listar ni limpiar cache;
- no hay GC automatico ni cuotas;
- no hay sharing entre proyectos;
- no hay sharing entre maquinas;
- no se documenta estabilidad de nombres de namespace derivados, solo la separacion por proyecto y tipo de objeto;
- los entrypoints fuera de CLI/Planner/agents no deben escribir en esta cache;
- hoy no existe cobertura de adopcion operativa para todos los tipos conceptuales de la spec, solo el contrato base de aislamiento e invalidacion.
