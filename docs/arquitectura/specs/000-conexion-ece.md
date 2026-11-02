# 000 · Conectar ECE y catalogar sus capacidades

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md)

## id

`000-conexion-ece`

## estado

`borrador`

Es la orden de trabajo que la próxima sesión ejecuta primero. Sigue en `borrador` porque ECE no está conectado y, sin una cita a una herramienta o un recurso real, esta spec no puede pasar a `aceptada`. Se ejecuta igual: no toca código de producto. Pasa a `hecha` cuando el catálogo existe y los criterios de abajo se cumplen. Si ECE no aparece, se queda en `borrador` y la sesión se detiene.

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

Ninguna. ECE no está conectado en la sesión que abre esta spec (2 de noviembre de 2026). Sin una cita a un resultado real, el estado no pasa a `aceptada`. Las citas, si la próxima sesión conecta, viven en `docs/arquitectura/ece-capacidades.md` con el nombre que devolvió la llamada. No se copian aquí por adelantado.

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

## riesgos

- Confundir un MCP ya conectado (Figma, Fal u otro) con ECE y catalogar sus herramientas bajo ese nombre.
- Escribir el catálogo de memoria para poder marcar la spec `hecha`.
- Seguir con la spec 001 en la misma sesión en la que ECE no apareció.
- Anotar una URL o un comando que la sesión no haya visto, solo porque el campo «qué falta» pide un valor.
