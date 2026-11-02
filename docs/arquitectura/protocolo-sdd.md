# Protocolo de desarrollo guiado por especificaciones

[← Índice de la documentación](../indice.md)

Este protocolo ordena el rediseño de la arquitectura de DIAgrams. Lo sigue la sesión que va a cambiar esa arquitectura. Un arreglo, una página de documentación o una función que no cambie la arquitectura sigue [CONTRIBUTING.md](../../CONTRIBUTING.md) y [desarrollo.md](../desarrollo.md).

El punto de partida es el [as-is](as-is.md) y el JSON [`examples/diagrams-as-is.json`](../../examples/diagrams-as-is.json). La primera orden de trabajo es la [spec 000](specs/000-conexion-ece.md). La plantilla de las siguientes está en [specs/plantilla.md](specs/plantilla.md).

## Modelo congelado

`examples/diagrams-as-is.json` no se reescribe para proponer la arquitectura nueva. Una corrección factual entra solo cuando el código contradice el archivo, y la spec que la acompaña dice qué frase del modelo no coincidía con qué archivo. Un cambio de diseño no es una corrección factual.

El to-be es otro archivo. Se crea cuando una spec está en `aceptada` y esa spec le pone el nombre. El nombre previsto es `examples/diagrams-to-be.json`. La spec 000 no lo crea. Este protocolo tampoco.

## Una spec, una PR

Las specs viven en `docs/arquitectura/specs/`, en Markdown y en español. El nombre es `NNN-titulo.md` con número de tres cifras. Cada spec viaja en su propia PR.

No hay código de producto hasta que la spec está en `estado: aceptada`. Código de producto, aquí, es `src/`, `packages/`, `schema/`, `public/`, pruebas, la imagen, `deploy/` y cualquier JSON de modelo, incluido el to-be. Pasar una spec de `borrador` a `aceptada` es un cambio distinto del que la implementa: quien mantiene el producto escribe `aceptada` en el archivo, y esa PR no trae el código. La sesión que redacta el borrador no lo marca `aceptada` en el mismo cambio.

La PR de implementación parte de `aceptada`, deja la spec en `en curso` mientras trabaja y en `hecha` al cerrar. No mezcla otra spec.

La spec 000 es la excepción de arranque: se ejecuta en `borrador`, como cuenta el ciclo, y no autoriza código de producto.

## Secciones de una spec

Cada spec tiene estas secciones, con estos nombres:

| Sección | Qué contiene |
|---|---|
| id | El nombre del archivo sin `.md`, por ejemplo `000-conexion-ece`. |
| estado | Uno de: `borrador`, `aceptada`, `en curso`, `hecha`, `descartada`. |
| problema | Qué duele o qué falta, en el producto de hoy. |
| alcance | Lo que esta spec autoriza a hacer. |
| fuera de alcance | Lo que esta spec no autoriza, aunque esté al lado. |
| elementos del as-is que toca | Ids del modelo (`arquitecto`, `sitio`, `r-cli-ia`, …). Si no toca ninguno, lo dice. |
| capacidades ECE que aplican | Cada capacidad cita una herramienta o un recurso que una llamada real al MCP devolvió en esta sesión. Sin esa cita, la spec no puede estar en `aceptada`. |
| decisión | Qué se va a hacer. |
| alternativas descartadas | Qué otras salidas se miraron y por qué se dejan. |
| criterios de aceptación comprobables | Condiciones que se pueden mirar en un archivo, una orden o un diff. |
| verificación | Qué se ejecutó y qué salió. Lo que no se corrió no se anota como hecho. |
| riesgos | Qué puede salir mal si se sigue la decisión, y qué se vigila. |

## Ciclo

1. **000 · Conexión con ECE.** Bloquea todo lo demás. Ya está escrita, en `borrador`. La próxima sesión la ejecuta así, sin pasar antes por `aceptada`, porque su trabajo es conseguir las citas que una aceptación necesita y porque no toca código de producto. Al cumplir los criterios pasa a `hecha`. Si ECE no está, se queda en `borrador` y la sesión se detiene.
2. **001 · To-be C4.** Se redacta en `borrador` cuando 000 está `hecha`. Sigue bloqueada mientras 000 no lo esté. El JSON to-be se crea después de que 001 esté `aceptada`, no en el borrador.
3. **Specs siguientes.** Cada una lleva sus ids del as-is y sus citas ECE. No empieza hasta que esa spec está `aceptada`.

## Conectar ECE antes de rediseñar

La sesión que rediseña conecta ECE antes de proponer contenedores, relaciones o código. El procedimiento es este:

1. Descubre los servidores MCP conectados a la sesión.
2. Si no hay un servidor ECE, la sesión se detiene. No escribe el catálogo.
3. Si ECE pide autenticación (`needsAuth`), autentica y vuelve a listar.
4. Lista sus herramientas y sus recursos con la llamada real.
5. Escribe `docs/arquitectura/ece-capacidades.md` solo con lo que esas llamadas devolvieron.

Ese catálogo, cuando exista, lleva la fecha, el nombre del servidor tal como lo devolvió el descubrimiento, y el estado de la autenticación si hizo falta. Cada herramienta y cada recurso es una entrada con el nombre y la descripción devueltos. Si la llamada trae un esquema, el catálogo usa los nombres de parámetros que vinieron. Una llamada fallida se copia con su error. El archivo no propone arquitectura.

Si ECE no está, el catálogo no se crea. En la sección «verificación» de la spec 000 se anota la lista real de servidores vistos y qué falta: el comando o la URL para conectar, y la autenticación. Si el comando, la URL o la autenticación no constan en la sesión, se escribe que no constan. No se inventan capacidades, URLs ni nombres de herramientas.

La búsqueda del 2 de noviembre de 2026 no encontró nada llamado ECE en este repositorio, ni en los repositorios públicos `diagrams` y `railspec`, ni en los MCP conectados entonces (Figma, Fal, cursor-cloud, cursor). El [roadmap](../roadmap.md#límites-conocidos-y-fuera-de-alcance) deja el servidor MCP del producto fuera de la v1. Ese servidor de producto y ECE son cosas distintas: no se usa el uno para rellenar el otro.

Una spec de rediseño cita, en «capacidades ECE que aplican», entradas que ya están en el catálogo y que salieron de una llamada. Si ECE no está conectado, esa spec permanece en `borrador`.

## Validar un JSON C4

Cualquier documento C4 que añada el rediseño, as-is corregido o to-be, se valida así:

```bash
npm run cli -- validate <archivo.json>
```

Si el documento es nuevo, se derivan sus vistas con `deriveView` y la spec anota aristas e implícitas por vista. El comando y la tabla de referencia del as-is están en [as-is.md](as-is.md#qué-se-comprobó). No hace falta un comando nuevo en el CLI para eso.

## Mensaje de arranque

Esta es la instrucción para pegar en la sesión nueva:

```
Vas a rediseñar la arquitectura de DIAgrams. Lee, en este orden, docs/arquitectura/protocolo-sdd.md, docs/arquitectura/as-is.md y examples/diagrams-as-is.json. El JSON as-is está congelado: el relato está en el markdown y el to-be será otro archivo, solo después de una spec aceptada.

Ejecuta primero docs/arquitectura/specs/000-conexion-ece.md, que está en borrador. Descubre los servidores MCP de esta sesión. Si hay un servidor ECE, autentica cuando pida needsAuth, lista herramientas y recursos, y escribe docs/arquitectura/ece-capacidades.md solo con lo que esas llamadas devuelvan. Si no hay servidor ECE, detente: anota en la verificación de la spec 000 el comando o la URL que falta y la autenticación (o que no constan). No inventes capacidades, URLs ni nombres de herramientas.

No edites código de producto, no marques ninguna spec como aceptada y no crees un JSON to-be en esta primera pasada. El modelo as-is se comprueba con `npm run cli -- validate examples/diagrams-as-is.json`.
```
