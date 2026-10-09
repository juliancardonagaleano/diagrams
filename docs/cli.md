# CLI `iark`

[← Índice de la documentación](indice.md)

```
iark generate "<instrucción>" [--from base.json] [--from-repo <carpeta|url>] [--out d.drawio] [--json d.json] [--model claude-opus-5] [--effort high] [--direction DOWN]
iark layout   [archivo.json | --stdin] [--out out.json] [--direction auto|down|right|left|up] [--distribution auto|centered|elk] [--density auto|compact|spacious] [--fast] [--force] [--view id]
iark convert  [archivo.json | --stdin] [--out out.drawio] [--notation c4|card] [--no-waypoints] [--locale es|en] [--view id...]
iark import   [archivo.drawio|archivo.dsl|archivo.mmd|… | --stdin] [--format auto|drawio|dsl|mermaid|<importador del módulo>] [--out out.json] [--name nombre] [--layout]
iark validate [archivo.json | --stdin] [--strict]
iark schema   [--generation]
iark prompt   "<instrucción>" [--from base.json] [--from-repo <carpeta|url>]
iark diff     <antes> [<después>] [--rev <revisión>] [--format text|markdown|json] [--exit-code] [--out archivo]
iark example
iark modules  [--json]
iark project  list|create|rename|delete|show|add|get|rename-diagram|remove|copy|export|import|check|trace   # proyectos en una carpeta de trabajo (ver proyectos.md)
iark auth     create|list|revoke   # tokens de acceso de `iark serve --tokens` (ver servicio.md, «Servidor para varias personas»)
iark trace    <módulo=archivo>... [--from <módulo:id>] [--direction refs|referrers|both] [--depth n] [--format markdown|mermaid|svg|json] [--strict] [--out archivo]   # trazabilidad entre módulos (ver trazabilidad.md)
iark serve    [--static dist/app] [--port 8787] [--host 127.0.0.1] [--cors <orígenes>] [--workspace <carpeta>] [--tokens <archivo> | --accounts <archivo> …] [--access-log <archivo|->] [--audit-log <archivo|->] [--metrics [--metrics-token <token>]]   # servicio HTTP (ver servicio.md; registros, auditoría, salud y métricas: observabilidad.md)
iark <módulo> <comando>   # comandos propios de cada módulo (p. ej. `iark integration catalog`)
```

`generate`, `import`, `convert`, `validate`, `schema`, `prompt` y `diff` aceptan `--module <id>` para trabajar con cualquier módulo de la suite (por defecto `c4`); `iark modules` lista los instalados y sus formatos de importación y exportación. Además de Mermaid, cada módulo puede importar formatos propios (`--format <id>`, o `auto` para deducirlo de la extensión y del contenido): Terraform y Kubernetes en plataforma, DDL de SQL y dbt en datos y ArchiMate en empresarial (ver [Importar y exportar](importadores.md)). Es `--format`, no `--from`: `--from` solo existe en `generate` y `prompt`.

En desarrollo: `npm run cli -- <comando>`; tras `npm run build`: `node dist/cli/index.js` o `npx iark` si el paquete está instalado. La generación con IA (`generate`, `prompt`, `--from-repo`) tiene su propia página: [IA](ia.md); la trazabilidad, [Trazabilidad entre módulos](trazabilidad.md).

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
