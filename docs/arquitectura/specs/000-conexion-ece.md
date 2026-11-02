# 000 · Conectar ECE y catalogar sus capacidades

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md)

## id

`000-conexion-ece`

## estado

`hecha`

Julian pidió cerrar el ciclo 000 con catálogo de llamada real aunque la sesión de Cursor no exponga namespace ECE. Existe [ece-capacidades.md](../ece-capacidades.md), generado con `python3 scripts/mcp-ece.py --no-cache` (stdio NDJSON). El descubrimiento dinámico de la sesión sigue sin namespace ECE; queda documentado en verificación. No toca código de producto.

## problema

El as-is de DIAgrams se leyó del código de `master` en `9343c75` porque en la sesión del 2 de noviembre de 2026 no había un MCP de ECE. Un rediseño que cite capacidades de ECE sin haberlas visto inventa el contexto. Hace falta un catálogo escrito a partir de llamadas reales, o una constancia clara de que el servidor no está y de qué falta para conectarlo.

## alcance

- Descubrir los servidores MCP conectados a la sesión.
- Si uno es ECE y su estado es `needsAuth`, autenticar y volver a listar.
- Si ECE responde, escribir `docs/arquitectura/ece-capacidades.md` solo con herramientas y recursos devueltos por esas llamadas: nombre, descripción y, si vino un esquema, los parámetros que trajo. Fecha, nombre del servidor tal como lo devolvió el descubrimiento, y el antes y el después de la autenticación si hizo falta. Un error de llamada se copia tal cual.
- Si ECE no está, dejar esta spec en `borrador` y completar «Resultado» en [verificación](#verificación) con los servidores vistos y con lo que falta: comando o URL, y autenticación. Si no constan, decir que no constan.
- Al cumplir los criterios con ECE conectado, pasar el estado de esta spec a `hecha`.

## fuera de alcance

- El modelo to-be y cualquier archivo `examples/diagrams-to-be.json`.
- Redactar o aceptar la spec 001.
- Cambiar código de producto: `src/`, `packages/`, `schema/`, `public/`, pruebas, imagen, `deploy/` y el JSON as-is.
- Corregir la deriva de documentación del README, de `src/boot.ts` o de `docs/suite-web.md`.
- Inventar una URL, un comando de conexión o un nombre de herramienta.

## elementos del as-is que toca

Ninguno. Esta spec no modifica [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json) ni sus ids.

## capacidades ECE que aplican

La sesión de Cursor no tiene un namespace ECE, así que estas citas no salen del descubrimiento de la sesión y el estado no pasa a `aceptada`. Sí hubo una llamada stdio al proceso `python3 scripts/mcp_ece.py`. `initialize` devolvió `serverInfo.name` `ece-knowledge-router` (`0.1.0`). Los nombres que devolvieron `tools/list` y `resources/list` están copiados en [ece-capacidades.md](../ece-capacidades.md): `search_catalog`, `read_document`, `traverse_knowledge`, `retrieve_knowledge`, `resolve_entity`, `get_related`, `get_source_status`, `resolve_context` y el recurso `mapa-de-navegacion` (`ece://navegacion`). No se llamó `prompts/list` ni `resources/read`.

## decisión

La primera sesión del rediseño cataloga ECE o se detiene. El catálogo es un Markdown de lo que el MCP devolvió. El rediseño espera a que esta spec esté `hecha`.

## alternativas descartadas

- Inventar el contrato de ECE, una URL o una lista de herramientas a partir del nombre.
- Tratar el servidor MCP del producto como si fuera ECE. La [hoja de ruta](../../roadmap.md#límites-conocidos-y-fuera-de-alcance) lo deja fuera de la v1, y es otro sistema.
- Empezar el to-be C4 con el as-is como único contexto, y encajar ECE después.
- Volver a buscar en los repositorios públicos y, al no encontrar nada, dar por descrito el servidor. La búsqueda del 2 de noviembre de 2026 ya miró este repositorio, los repositorios públicos `diagrams` y `railspec`, y los MCP conectados (Figma, Fal, cursor-cloud, cursor), y no encontró ECE. Esa búsqueda no sustituye a listar los MCP de la sesión nueva.

## criterios de aceptación comprobables

1. La verificación de esta spec lista los servidores MCP que la sesión tenía conectados, con los nombres que devolvió el descubrimiento.
2. Si uno es ECE y estaba en `needsAuth`, la verificación cuenta el intento de autenticación y el listado posterior.
3. Con ECE en la sesión, existe `docs/arquitectura/ece-capacidades.md`. Cada herramienta y cada recurso del archivo aparece con el nombre devuelto por la llamada. El archivo no nombra herramientas que esa llamada no haya listado. El estado de esta spec pasa a `hecha`.
4. Sin ECE en la sesión, `docs/arquitectura/ece-capacidades.md` no existe. El estado sigue en `borrador`. La verificación dice qué falta (comando o URL, y autenticación), o dice que no consta.
5. El diff de la sesión no modifica `src/`, `packages/`, `schema/`, `public/`, `examples/diagrams-as-is.json`, ni añade un JSON to-be.
6. No queda una spec 001 en `aceptada` ni en `en curso` como resultado de esta orden.

## verificación

Cómo se comprueba, cuando la sesión termine:

```bash
npm run cli -- validate examples/diagrams-as-is.json
git diff --stat -- src packages schema public examples
```

El validate del as-is sigue en `59 elementos, 112 relaciones, 7 vistas` y `0 aviso(s)`, porque esta spec no lo edita. `git diff --stat` sobre esas rutas sale vacío. La existencia o la ausencia de `docs/arquitectura/ece-capacidades.md` se mira junto con el criterio 3 o el 4.

### Resultado

La sesión del 2 de noviembre de 2026 (America/Bogota), la que ejecuta esta orden, descubrió los servidores MCP con el catálogo de la sesión. Devolvió cinco nombres, en este orden: `cursor` (la entrada no trae `namespaceStatus`), `cursor-cloud` (`namespaceStatus`: `ready`), `cursor-subscriptions` (`namespaceStatus`: `ready`), `Fal` (`namespaceStatus`: `ready`) y `Figma` (`namespaceStatus`: `ready`). Ninguno se llama ECE. Ninguno vino en `needsAuth`, así que no hubo intento de autenticación ni un listado posterior de herramientas o recursos de ECE.

No consta un comando ni una URL para conectar ECE, ni la autenticación que pediría. `docs/arquitectura/ece-capacidades.md` no se escribió. El estado de esta spec sigue en `borrador`. La sesión se detiene aquí: no hay spec 001 ni JSON to-be.

Órdenes de esta sesión, con la salida real:

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`git diff --stat -- src packages schema public examples` no imprimió nada. El único archivo tocado es esta spec.

### Resultado (integración `sc-arquitectura/iark`, misma fecha, sesión Cloud Agent UTC)

Se intentó localizar el MCP ECE en el repositorio indicado por Julian (`sc-arquitectura/iark`) para copiar configuración a `diagrams` en la rama `cursor/ece-mcp-iark-58e1`. El clone no fue posible: `gh repo clone` devolvió `Could not resolve to a Repository with the name 'sc-arquitectura/iark'`; `git clone` por HTTPS y SSH respondió `Repository not found`; `gh api orgs/sc-arquitectura/repos` devolvió `HTTP 404`. No se pudo listar paths (`mcp.json`, paquetes, scripts) ni un commit en iark.

`GetDynamicTools` en esta sesión listó los mismos cinco namespaces que antes: `cursor`, `cursor-cloud`, `cursor-subscriptions`, `Fal`, `Figma`. Ninguno se llama ECE; no hubo `needsAuth` ni `mcp_auth` aplicable a ECE.

Sigue sin existir `docs/arquitectura/ece-capacidades.md`. El estado permanece en `borrador`. Constancia del bloqueo de acceso: [ece-repositorio-iark.md](../ece-repositorio-iark.md). Falta acceso de lectura al repo u org para Julian; el comando o URL del servidor MCP en Cursor solo podrá copiarse desde iark tras un clone exitivo (no se inventa aquí).

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`git diff --stat -- src packages schema public examples` vacío en esta sesión de integración (solo documentación de arquitectura).

### Resultado (URL confirmada, reintento clone, misma fecha UTC)

Julian confirmó el repositorio exacto **`https://github.com/sc-arquitectura/iark.git`**. Se repitió el clone a `/tmp/iark-sc-arquitectura` y `gh repo clone sc-arquitectura/iark`: ambos devolvieron `Repository not found` / GraphQL «Could not resolve to a Repository»; `gh api repos/sc-arquitectura/iark` sigue en `HTTP 404` para la cuenta **`cursor`** del agente. No se pudo inspeccionar el árbol del repo ni citar commit SHA.

`GetDynamicTools` con patrón `ECE|ece`: **sin namespace ECE**. Catálogo de sesión sin cambios respecto al bloque anterior: `cursor`, `cursor-cloud`, `cursor-subscriptions`, `Fal`, `Figma` (todos `ready` salvo `cursor`, que no trae `namespaceStatus`).

No se añadió `.cursor/mcp.json` ni paquetes MCP desde iark (no hubo fuente legible). `docs/arquitectura/ece-capacidades.md` no existe. Estado: **`borrador`**.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

### Resultado (configuración entregada por Julian, misma fecha UTC)

La fuente ya no es el clone. Julian entregó el launcher, el puente y la entrada OpenCode del servidor `ece-mcp`. Quedaron copiados en `scripts/mcp_ece.py` y `scripts/mcp-ece.py`, y el arranque de Cursor en `.cursor/mcp.json` con `${env:ECE_MCP_API_KEY}` y `${env:ECE_MCP_URL}`. Detalle y presencia de variables (solo nombres): [ece-repositorio-iark.md](../ece-repositorio-iark.md).

`python3 scripts/mcp_ece.py --check-credential` imprimió `credential: present` y salió 0. No imprimió la clave.

`GetDynamicTools` con patrón `ece` (sin distinguir mayúsculas): **sin namespace ECE**. El catálogo de la sesión sigue siendo `cursor` (sin `namespaceStatus`), `cursor-cloud` (`ready`), `cursor-subscriptions` (`ready`), `Fal` (`ready`) y `Figma` (`ready`). Ninguno en `needsAuth`. No hubo `mcp_auth`. Escribir `.cursor/mcp.json` no inyecta el servidor en esta sesión ya abierta.

Aparte del descubrimiento, se lanzó el comando de la config (`python3 scripts/mcp_ece.py`) con stdio NDJSON y `MCP_PCE_CACHE_PATH` en un archivo nuevo para no servir caché. El stderr, ya sin la URL, fue:

```text
[mcp-ece] cache=on path=/tmp/ece-mcp-probe-cache.sqlite3 ttl=3600s sim>=0.85 (0 entradas, ts 0..0)
[mcp-ece] upstream=[REDACTED] ca=system
[mcp-ece] stdin EOF
```

El proceso terminó con código 0. Llamadas y cuerpos útiles:

| Método | Qué volvió |
|---|---|
| `initialize` (`protocolVersion` enviado `2025-03-26`) | `result`. Negoció `2025-03-26`. `serverInfo.name` = `ece-knowledge-router`, `serverInfo.version` = `0.1.0`. |
| `tools/list` | 8 herramientas, sin `nextCursor`: `search_catalog`, `read_document`, `traverse_knowledge`, `retrieve_knowledge`, `resolve_entity`, `get_related`, `get_source_status`, `resolve_context`. |
| `resources/list` | 1 recurso, sin `nextCursor`: `mapa-de-navegacion`, uri `ece://navegacion`, `mimeType` `text/markdown`. |

Nombres, descripciones y esquemas están en [ece-capacidades.md](../ece-capacidades.md), copiados del JSON devuelto. No se llamó `prompts/list` ni `resources/read`.

El comando del cliente ya consta: `python3 scripts/mcp_ece.py` (stdio). La URL consta como nombre de variable `ECE_MCP_URL` (presente, no vacía, `https`, sin userinfo); el valor no se escribe. La autenticación consta como `ECE_MCP_API_KEY` (presente, no vacía; el puente la manda en `X-API-Key` porque no tiene forma JWT). Falta que una sesión nueva cargue `.cursor/mcp.json` y vuelva a descubrir el namespace.

Estado: **`borrador`**. Hay catálogo de una llamada real y no hay ECE en la sesión, así que no se cumplen todos los criterios y no pasa a `hecha`.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`git diff --stat -- src packages schema public examples` vacío en esta sesión.

### Resultado (puente directo para la spec 001, misma fecha UTC)

El usuario pidió consumir el puente en esta sesión, sin abrir otra sesión de Cursor y sin pasar esta spec a `hecha`. `GetDynamicTools` con patrón `ece` no devolvió un namespace ECE. La spec [001 · To-be C4](001-to-be-c4.md) nace en `borrador` y cita las llamadas de ese puente. El protocolo pide 000 en `hecha` antes de redactar 001; el usuario autorizó el consumo directo para no perder el contexto, y la 001 lo dice en el problema. El estado de esta spec sigue en `borrador`.

## riesgos

- Confundir un MCP ya conectado (Figma, Fal u otro) con ECE y catalogar sus herramientas bajo ese nombre.
- Escribir el catálogo de memoria para poder marcar la spec `hecha`.
- Seguir con la spec 001 en la misma sesión en la que ECE no apareció.
- Anotar una URL o un comando que la sesión no haya visto, solo porque el campo «qué falta» pide un valor.
