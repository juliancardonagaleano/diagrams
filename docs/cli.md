# CLI `iark`

[← Índice de la documentación](indice.md)

```
iark generate "<instrucción>" [--from base.json] [--from-repo <carpeta|url>] [--out d.drawio] [--json d.json] [--model claude-opus-5] [--effort high] [--direction DOWN] [--retries n] [--no-verify] [--allow-invalid] [--strict] [--max-tokens n] [--budget-tokens n] [--max-input-tokens n]
iark explain  [archivo | --stdin] [--module id] [--lang es|en] [--out explicacion.md] [--provider p] [--model m] [--max-tokens n] [--budget-tokens n] [--max-input-tokens n]
iark review   [archivo | --stdin] [--module id] [--lang es|en] [--out revision.md]   # como explain, pero pasa al modelo las incidencias de validate()
iark layout   [archivo.json | --stdin] [--out out.json] [--direction auto|down|right|left|up] [--distribution auto|centered|elk] [--density auto|compact|spacious] [--fast] [--force] [--view id]
iark convert  [archivo.json | --stdin] [--out out.drawio] [--notation c4|card] [--no-waypoints] [--locale es|en] [--view id...]
iark import   [archivo.drawio|archivo.dsl|archivo.mmd|… | --stdin] [--format auto|drawio|dsl|mermaid|<importador del módulo>] [--out out.json] [--name nombre] [--layout]
iark validate [archivo.json | --stdin] [--strict]
iark migrate  [archivo.json | --stdin] [--out out.json] [--check]
iark schema   [--generation]
iark prompt   "<instrucción>" [--from base.json] [--from-repo <carpeta|url>]
iark diff     <antes> [<después>] [--rev <revisión>] [--format text|markdown|json] [--exit-code] [--out archivo]
iark example
iark modules  [--json]
iark project  list|create|rename|delete|show|add|get|rename-diagram|remove|copy|export|import|check|trace|history|restore|label|delete-version|diff   # proyectos en una carpeta de trabajo (ver proyectos.md)
iark auth     create|list|revoke   # tokens de acceso de `iark serve --tokens` (ver servicio.md, «Servidor para varias personas»)
iark trace    <módulo=archivo>... [--from <módulo:id>] [--direction refs|referrers|both] [--depth n] [--format markdown|mermaid|svg|json] [--type <tipo>]... [--orphans [módulo[:tipo]]] [--matrix [module|kind]] [--coverage "<origen> -> <destino>"]... [--min-coverage n] [--strict] [--strict-unresolved] [--out archivo]   # trazabilidad entre módulos: enlaces tipados, huérfanos, matriz y cobertura (ver trazabilidad.md)
iark serve    [--static dist/app] [--port 8787] [--host 127.0.0.1] [--cors <orígenes>] [--workspace <carpeta>] [--tokens <archivo> | --accounts <archivo> [--accounts-store json|sqlite] [--accounts-import <json>] …] [--access-log <archivo|->] [--audit-log <archivo|->] [--metrics [--metrics-token <token>]] [--max-streams n]   # servicio HTTP (ver servicio.md; registros, auditoría, salud y métricas: observabilidad.md; `--max-streams` o `IARK_MAX_STREAMS`: canales de cambios en tiempo real por persona, 8 por omisión, 0 los desactiva: servicio.md, «Cambios en tiempo real»)
iark accounts migrate|backup|info   # mantenimiento de la base SQLite de cuentas de `iark serve --accounts-store sqlite`: pasar el JSON de antes, copia coherente y estado (ver cuentas-github.md)
iark <módulo> <comando>   # comandos propios de cada módulo (p. ej. `iark integration catalog`)

# Opciones globales (valen antes o después del comando)
iark --config <archivo> …   # carga los módulos de terceros de ese iark.config.json (o la variable IARK_CONFIG)
iark --no-config …          # no carga ninguno (o IARK_NO_CONFIG=1); por omisión se carga el iark.config.json del directorio actual, si existe
```

`generate`, `explain`, `review`, `import`, `convert`, `validate`, `migrate`, `schema`, `prompt` y `diff` aceptan `--module <id>` para trabajar con cualquier módulo de la suite (por defecto `c4`); `iark modules` lista los instalados, de dónde vienen (`incorporado` o el módulo de terceros que los aporta), sus versiones de contrato y de documento y sus formatos de importación y exportación. Además de Mermaid, cada módulo puede importar formatos propios (`--format <id>`, o `auto` para deducirlo de la extensión y del contenido): OpenAPI y AsyncAPI en integración, Threat Dragon en seguridad, Terraform, Kubernetes, CloudFormation y Helm en plataforma, DDL de SQL, dbt y OpenLineage en datos, y ArchiMate y BPMN en empresarial (ver [Importar y exportar](importadores.md)). Es `--format`, no `--from`: `--from` solo existe en `generate` y `prompt`.

En desarrollo: `npm run cli -- <comando>`; tras `npm run build`: `node dist/cli/index.js` o `npx iark` si el paquete está instalado. La IA (`generate`, `explain`, `review`, `prompt`, `--from-repo`) tiene su propia página: [IA](ia.md); la trazabilidad, [Trazabilidad entre módulos](trazabilidad.md).

**Códigos de salida de la IA.** `generate` ahora **verifica el resultado con `validate()` del módulo** y reintenta por sus errores (`--no-verify` lo desactiva, `--allow-invalid` acepta el documento aunque siga con errores, `--strict` también devuelve los avisos). Códigos: `0` bien; `2` uso incorrecto o prompt demasiado grande para `--max-input-tokens`; `3` el documento incumple las reglas del módulo tras los reintentos; `4` otro error del modelo (credenciales, respuesta cortada por `--max-tokens`, presupuesto `--budget-tokens` agotado). Los tres topes están en tokens, sin precios, y también se leen de `IARK_AI_MAX_TOKENS`, `IARK_AI_BUDGET_TOKENS` e `IARK_AI_MAX_INPUT_TOKENS` (ver [IA](ia.md#topes-de-tokens-sin-precios)).

## Módulos de terceros (`--config` y `iark.config.json`)

Además de los seis módulos incorporados, el CLI carga los que nombre un `iark.config.json` (solo JSON: `{ "modules": ["./index.mjs", "@acme/iark-module-riesgos"], "defaultModule": "risk" }`). Un módulo de terceros se usa como cualquier otro: `--module risk`, `iark import`, `iark trace`, `iark modules` y los comandos que aporte (`iark risk top`). La configuración se elige así: `--no-config` o `IARK_NO_CONFIG=1` (ninguna); `--config <archivo>` o `IARK_CONFIG`; el `iark.config.json` del directorio actual (no se busca en las carpetas padre); si no, ninguna. Cada módulo cargado se anota en la salida de errores (`Módulo de terceros cargado: risk ← ./index.mjs (contrato 1, documento 1.0)`) y cualquier fallo al cargarlo termina con código 2 nombrando el especificador.

Cargar un módulo ejecuta su código con los permisos del proceso, así que **nunca** se carga la configuración de un proyecto clonado (`--from-repo`) ni de un espacio de trabajo (`--workspace`). Guía completa, ejemplo y seguridad: [Módulos de terceros](plugins.md).

## Documentos de una versión anterior del formato (`iark migrate`)

Cada módulo declara la versión de su formato (`documentVersion`, hoy `1.0` en los seis) y, cuando el formato cambia, cómo llevar un documento antiguo a la versión actual (ver [Versionado de documentos](versionado-documentos.md)). Los comandos que leen un documento (`validate`, `convert`, `layout`, `diff`…) lo migran al leerlo, sin tocar el archivo, y lo dicen: `validate` imprime «Documento migrado de la versión 1.0 a 1.1» y los demás lo avisan por la salida de errores. `iark project check` y la API del servicio también lo analizan ya migrado, con esa misma nota entre las incidencias.

`iark migrate` reescribe el documento en la versión actual:

```bash
iark migrate antiguo.json --out nuevo.json          # escribe el documento migrado (sin --out, por la salida estándar)
iark migrate antiguo.json --module data --out nuevo.json
iark migrate --check diagrama.json                  # no escribe nada: código 1 si necesita migración, 0 si ya está al día
```

El documento de entrada no se modifica nunca; el migrado sale validado con el esquema del módulo. Un documento de una versión más nueva que la que entiende esta instalación (`Actualiza IArk para abrirlo`) o anterior a la primera migración declarada termina con código 2, también con `--check`. `--check` sirve para la integración continua: falla mientras queden documentos del repositorio por reescribir.

## Comparar versiones de un diagrama (`iark diff`)

`iark diff` dice qué cambió entre dos versiones de un documento de **cualquier módulo**: lo añadido, lo quitado y lo modificado, con cada campo antes → después.

```bash
iark diff  antes.json despues.json --module data                  # dos archivos
iark diff  empresa.json --module enterprise --rev HEAD~1          # el archivo en esa revisión de git contra la copia de trabajo (rama, etiqueta o commit)
iark diff  banca.json --rev main --format markdown >> cambios.md  # Markdown para pegar en una PR o un changelog (también `json`)
iark diff  antes.json despues.json --exit-code                    # sale con 1 si hay cambios, como `git diff --exit-code`
```

Los elementos se emparejan por `id` (o por `name`, o por similitud si la lista no tiene ids); el resto se compara campo a campo, así que un cambio de nombre sale como una modificación y no como un borrado más un alta. **No cuenta como cambio** la maquetación que guarda el autolayout de C4 (coordenadas, tamaños, rutas y opciones de layout de las vistas; qué elementos muestra cada vista sí cuenta) ni el orden de las listas: un reordenamiento sale aparte («N reordenados»). Donde el orden sí es parte del significado el módulo lo declara (`DomainModule.diff.ordered`: pasos de un flujo de integración, etapas de un pipeline de plataforma, etapas de un flujo de valor) y ahí cambiarlo es una modificación. Cada entrada se valida con el esquema del módulo (código de salida 2 si alguna no lo cumple) y acepta lo mismo que `validate` y `convert`: JSON del módulo, `-` para la entrada estándar y cualquier fuente que el módulo importe (`.drawio`, `.dsl`, `.mmd`…). El servicio HTTP lo expone como `POST /api/<módulo>/diff` con `{ before, after }`, y el banco de trabajo tiene la pestaña «Comparar» (ver [Suite web](suite-web.md)).

## Uso programático

```ts
import { generateDocument, autoLayoutDocument, toDrawio, fromDrawio, fromStructurizrDsl, validateDocument, deriveView } from 'iark-diagrams/core';

const { document } = await generateDocument({ instruction: 'Un sistema de tickets…' }); // Claude + autolayout
const laid = await autoLayoutDocument(validateDocument(json).document, { direction: 'RIGHT', force: true });
const xml = toDrawio(laid, { locale: 'en' });
const { document: imported, warnings } = await fromDrawio(xml, { name: 'Tickets' }); // .drawio → documento C4 (lanza DrawioImportError si no es utilizable)
const fromDsl = fromStructurizrDsl(dslText, { resolveInclude });                       // DSL de Structurizr → documento C4 (lanza DslImportError, con la línea)
```

`core` no depende del DOM: funciona en Node y en el navegador. `fromStructurizrDsl` es síncrono y solo lee otros archivos si le das un `resolveInclude`. `fromDrawio` descomprime las páginas comprimidas con `DecompressionStream` (Node 20.12+ y los navegadores actuales); un archivo sin comprimir no lo necesita.
