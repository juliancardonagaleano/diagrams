# Módulos de terceros e `iark.config.json`

[← Índice de la documentación](indice.md)

DIAgrams trae seis módulos (`c4`, `integration`, `data`, `enterprise`, `platform`, `security`). Un **módulo de terceros** añade una séptima especialidad —o la octava— **sin tocar este repositorio**: es un paquete aparte que implementa el contrato `DomainModule` y que el CLI y el servicio cargan desde un archivo de configuración. Con él, `iark validate --module risk`, `iark convert`, `iark import`, `iark trace`, `iark risk top` y `iark serve` funcionan igual que con un módulo incorporado.

> **Qué alcanza hoy.** Los módulos de terceros se cargan en el **CLI** y en **`iark serve`** (y en sus hilos de cálculo). **El sitio web (el banco de trabajo, el shell y el editor) no los trae**: se compila de antemano con los seis módulos incorporados. Un módulo de terceros no tiene editor visual; se opera por la línea de comandos y por la API HTTP, y sale en el manifiesto de federación para quien lo consuma. Ver [Lo que no hace](#lo-que-no-hace-todavía).

## Probarlo en un minuto

En [`examples/plugin-riesgos/`](../examples/plugin-riesgos/) hay un paquete mínimo y completo (un registro de riesgos, módulo `risk`): esquema, reglas de validación, exportador a Markdown, importador de CSV, un comando propio y entidades para la trazabilidad. Su `iark.config.json` ya lo carga:

Dentro del repositorio no hay que instalar nada (el CLI de desarrollo corre con `tsx`, que entiende el `@iark/kernel` del monorepo):

```bash
npm install
cd examples/plugin-riesgos                 # el iark.config.json de esta carpeta carga ./index.mjs
alias iark='npx tsx ../../src/cli/index.ts'    # o, instalado el CLI, simplemente `iark`
iark modules                               # risk aparece con su origen: ./index.mjs
iark validate --module risk riesgos.json
iark convert  --module risk riesgos.json --to md
iark import   --module risk riesgos.csv
iark risk top riesgos.json -n 3            # el comando que aporta el módulo
iark trace c4=../banca.json risk=riesgos.json   # los riesgos enlazan con elementos C4 por URN
```

Fuera del repositorio, con el CLI instalado, el módulo necesita `@iark/kernel` y `zod` en su propia carpeta (`npm install @iark/kernel zod`). **Mientras `@iark/kernel` no esté publicado en npm** (ver [Paquetes `@iark/*`](#paquetes-iark)), se instala desde el tarball que prepara `npm run packages:build`: `npm pack ./dist-packages/kernel` y `npm install ./iark-kernel-0.1.0.tgz zod`.

Al cargarlo, el CLI lo anota en la salida de errores (no mezcla con el resultado):

```
Módulo de terceros cargado: risk ← ./index.mjs (contrato 1, documento 1.0)
```

## Escribir un módulo, paso a paso

Un módulo de terceros es un paquete ESM cuyo módulo principal exporta (por defecto) un `DomainModule`. El mínimo, sin compilar nada:

```
mi-modulo/
├── package.json     { "type": "module", "exports": "./index.mjs", "peerDependencies": { "@iark/kernel": "^0.1.0", "zod": "^4.3.3" } }
├── index.mjs
└── iark.config.json { "modules": ["./index.mjs"] }
```

```js
// index.mjs
import { CONTRACT_VERSION, defineModule } from '@iark/kernel';
import { z } from 'zod';

const schema = z.object({ version: z.literal('1.0').default('1.0'), workspace: z.object({ name: z.string() }), items: z.array(z.object({ id: z.string() })).default([]) });

export default defineModule({
  id: 'inventario',                 // minúsculas, números y guiones; forma parte de las URN (urn:iark:inventario:<id>)
  name: 'Inventario',
  version: '1.0.0',                 // la versión del módulo (semver)
  contractVersion: CONTRACT_VERSION,
  documentVersion: '1.0',           // la versión del formato de documento que produce (mayor.menor)
  schema,
  jsonSchema: () => z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }),
  validate: (document) => [],       // reglas semánticas: lista de { severity, message, elementId? }
  importers: [],
  exporters: [],
});
```

1. **Crea el paquete** como arriba y declara `@iark/kernel` y `zod` como `peerDependencies`: el módulo importa del kernel en ejecución (`defineModule`, `CONTRACT_VERSION`, `ModuleError`, `parseUrn`…) y usa el mismo `zod` que el esquema que valida.
2. **Instala esas dos dependencias junto al módulo** (`npm install @iark/kernel zod`). El CLI resuelve los `import` del módulo desde la carpeta del módulo, como cualquier programa Node.
3. **Escribe el módulo** con `defineModule(...)` (solo devuelve lo que recibe, pero da tipos y autocompletado). El ejemplo completo comenta cada parte.
4. **Cárgalo**: `iark --config ruta/iark.config.json modules` (o deja el `iark.config.json` en el directorio donde ejecutas `iark`).
5. **Pruébalo**: `iark validate --module inventario doc.json`, `iark convert --module inventario doc.json --to <exportador>`…

Si escribes el módulo en TypeScript, **compílalo a ESM** (`tsc`, `tsup`…) y apunta `exports` al JavaScript resultante: el CLI carga el módulo con un `import()` de Node, que no ejecuta `.ts`. Los tipos (`DomainModule`, `CommandSpec`, `ModuleIssue`…) los exporta `@iark/kernel`.

### El contrato

`DomainModule` está definido en `packages/kernel/src/module/types.ts`; lo imprescindible:

| Campo | Qué es |
|---|---|
| `id` | Identificador estable (`^[a-z][a-z0-9-]*$`). No puede coincidir con un módulo ya cargado ni con un comando del CLI. |
| `name`, `version` | Nombre legible y versión del módulo. |
| `contractVersion` | Entero: contra qué versión del contrato se escribió (`CONTRACT_VERSION`, hoy `1`). Uno **mayor** que el de esta instalación se rechaza. |
| `documentVersion` | Versión `mayor.menor` del formato de documento, y `migrations` si el formato cambia ([Versionado de documentos](versionado-documentos.md)). |
| `schema`, `jsonSchema()` | El esquema de zod del documento y su JSON Schema (`iark schema --module <id>`). |
| `validate(doc)` | Reglas semánticas más allá del esquema. |
| `importers`, `exporters` | Formatos de entrada y salida (pueden ser listas vacías). Cada uno con `id` único, `label` y la función `import` / `export`; los importadores con `extensions` y los exportadores con `extension` y `mime`, en minúsculas y con punto (`.csv`, `.md`). |

Opcionales: `entities` (elementos referenciables por URN: entran en `iark trace`), `views`, `traceViews`, `cliCommands` (subcomandos `iark <módulo> <comando>`), `ai`, `diff`, `migrations` y `editor`. Un módulo que exporta una **fábrica** (`export default () => defineModule({...})`, también asíncrona) se acepta: el CLI la ejecuta al cargarlo y, si falla, lo dice.

`editor` describe el lienzo interactivo del módulo (`EditorSpec`, en [`packages/kernel/src/module/editor.ts`](../packages/kernel/src/module/editor.ts)): figuras y relaciones, proyección del documento a un grafo, campos del panel de propiedades y las operaciones de alta, edición y borrado. Todo lo que se añade a `EditorSpec` para un módulo con niveles de detalle (el de C4 es el ejemplo: `packages/domain-c4/src/editor.ts`) es **opcional**, y un módulo que no lo usa funciona igual:

| Opcional | Para qué |
|---|---|
| `EdgeNotation.addable: false` | Un tipo de relación derivado (C4: la implícita entre ancestros visibles) que se dibuja pero no se crea a mano; si solo queda un tipo creable, el lienzo no muestra el selector «Relación». |
| `EditorNode.shape` | Figura propia de un nodo (C4: base de datos, cola, navegador o móvil), que sustituye a la de su tipo. |
| `EditorNode.marks` | Marcas con nombre accesible propio sobre el nodo (`{ text, title }[]`): el lienzo pinta `text` en una píldora blanca en su esquina inferior izquierda y `title` es su nombre accesible, su ayuda y parte de lo que el lector de pantalla lee del nodo. Plataforma las usa para «≈ Producción» (el equivalente declarado en otro entorno). A diferencia de `badges` (solo texto), no pierde la frase completa. |
| `EditResult.view` | El resultado lleva el lienzo a otra vista (bajar de nivel). Con el mismo documento es solo navegación: no entra en el deshacer. |
| `viewId` en `EditorAction` (`prompt.initial`, `prompt.suggestions`, `disabled`, `run`) y en `canConnect` | La vista abierta, para acciones y reglas que dependen de ella. |
| `EditorAction.shortcut` (`'alt+down'` o `'alt+up'`) | La acción reclama Alt+↓ / Alt+↑ cuando el elemento no tiene enlace que seguir ni hay diagrama al que volver. |
| `layout(document, viewId, { fresh })` | `fresh` lo pide el botón Autolayout (Ctrl+L): recalcular la colocación aunque el documento ya guarde posiciones. |
| `breadcrumb(document, viewId)` | Camino de vistas hasta la abierta (`{ id, label }[]`); con más de un tramo el lienzo lo dibuja sobre el diagrama y cada tramo abre su vista. |

Los comandos que lleven una opción o argumento que toque el disco, la red o procesos deben marcarlo `local: true`; así el servicio HTTP no los ofrece a un cliente remoto (ver `CommandOption.local`).

### Qué se comprueba al cargarlo

Antes de registrar el módulo se comprueba su **forma** (no basta con que importe): `id`, `name`, `version`, `documentVersion` (`mayor.menor`), que `schema` sea un esquema de zod, `jsonSchema`, `validate`, `importers`/`exporters`/`traceViews`/`cliCommands` bien formados con ids no repetidos, y el contrato (`contractVersion` no mayor que el de DIAgrams, cadena de `migrations` sin huecos). Todos los problemas salen juntos, nombrando el módulo por el especificador con el que se cargó:

```
El módulo de terceros «./index.mjs» no cumple el contrato DomainModule:
  - «schema» debe ser un esquema de zod (con safeParse)
  - exporters «md»: «extension» debe ser una extensión en minúsculas con punto (p. ej. «.md»)
```

## `iark.config.json`

Es **solo JSON** (la configuración no ejecuta código):

```json
{
  "$schema": "https://github.com/juliancardonagaleano/iark-diagrams/schema/iark-config.schema.json",
  "modules": ["./index.mjs", "@acme/iark-module-riesgos"],
  "defaultModule": "risk"
}
```

| Clave | Qué hace |
|---|---|
| `modules` | Lista (en orden) de módulos de terceros a cargar. Cada elemento es un **especificador**: ver abajo. Por omisión, ninguno. |
| `defaultModule` | Módulo que usan por omisión los comandos con `--module` (hoy `c4`). Debe ser uno incorporado o uno de los cargados; si no, error de uso. |
| `$schema` | Solo para el editor (autocompletado). DIAgrams lo ignora. El esquema está en [`schema/iark-config.schema.json`](../schema/iark-config.schema.json) y lo regenera `npm run schema`. |

Cualquier otra clave es un error (el esquema es estricto): una errata no se pasa por alto.

### Especificadores

Se resuelven **respecto a la carpeta del `iark.config.json`**, no al directorio desde el que ejecutas `iark`:

- una **ruta** a un archivo (`./index.mjs`, `../otro/modulo.js`, o absoluta);
- una **carpeta** con `package.json` (se usa su `exports` / `main`);
- el **nombre de un paquete** instalado (`@acme/iark-module-riesgos`), buscado en los `node_modules` de esa carpeta y de sus padres, con las reglas de `exports` de ESM;
- una URL **`file:`**.

Cualquier otra URL (`http:`, `https:`, `data:`, `npm:`…) se rechaza: un módulo se instala en la máquina, no se descarga al ejecutar.

### Cómo se elige la configuración

En este orden (gana la primera que aplique):

1. **`--no-config`** o **`IARK_NO_CONFIG=1`**: no se carga ninguna, ni siquiera una rota. Es el cerrojo para la integración continua y para quien no quiere ejecutar código de terceros.
2. **`--config <archivo>`**, y si no, la variable **`IARK_CONFIG`**: ese archivo. Tiene que existir; si no, error (no se ignora en silencio). La opción vale antes y después del subcomando.
3. El **`iark.config.json` del directorio actual**, si existe. **No se busca en las carpetas padre.**
4. Si no, ninguna: DIAgrams se comporta como siempre.

### Qué ves y qué errores hay

- Cada módulo cargado se anota en stderr: `Módulo de terceros cargado: <id> ← <especificador> (contrato N, documento V)`.
- `iark modules` lista los módulos con su origen (`incorporado` o el especificador), la versión del contrato y la del documento; `iark modules --json` imprime el manifiesto de federación (con `contractVersion` y sin rutas locales).
- **Cualquier fallo termina el comando con código 2** y un mensaje en español que nombra el especificador: archivo inexistente, paquete sin instalar (con la pista de instalar `@iark/kernel` y `zod`), módulo con la forma inválida, contrato mayor que el soportado, `id` repetido (dice qué especificador lo cargó antes), `id` igual al de un comando del CLI, un archivo que lanza al importarse, un especificador no `file:`, un `iark.config.json` que no es JSON o con claves desconocidas, un `defaultModule` que no existe. Con `iark serve`, un plugin que no carga **impide arrancar** el servicio.

## Seguridad: cargar un módulo es ejecutar su código

Un módulo de terceros es código que corre **con los permisos del proceso `iark`**: puede leer archivos, abrir la red, ejecutar procesos. Por eso:

- La configuración se carga **solo** de lo que quien ejecuta el comando señala a mano en su máquina: `--config`, `IARK_CONFIG` o el `iark.config.json` de su directorio actual.
- **Nunca** se carga de un proyecto clonado (`--from-repo`), de un espacio de trabajo (`--workspace`, `IARK_WORKSPACE`), de una petición HTTP, de un documento ni del contenido de un repositorio analizado: ahí lo escribió otra persona. Si el directorio actual está dentro de una de esas carpetas, el `iark.config.json` de allí **no se carga** y se avisa en stderr (`aviso: no se carga … cargar módulos ejecuta código. Si es suyo, indíquelo con --config`); con `--config` explícito sí.
- `iark serve` no carga plugins por una petición ni acepta rutas de módulos del cliente: los módulos los fija quien arranca el servicio.
- Instala módulos como cualquier dependencia: de autores en los que confías, con versión fijada y `package-lock.json`. En integración continua, `--no-config` o `IARK_NO_CONFIG=1` evitan ejecutar nada que no esté previsto.

## `iark serve` y Docker

```bash
iark serve --config ./iark.config.json --port 8787
```

- El módulo sale en `GET /api/modules`, en `/.well-known/iark.json` (con `contractVersion`, `documentVersion`, formatos y, **sin** `embed` ni esquema estático, porque el sitio no lo trae: su esquema está en `/api/<id>/schema`) y tiene su API (`/api/<id>/validate`, `/convert`, `/import`, `/run/<comando>`, `/trace`…) con las mismas reglas de autenticación, roles y límites que los módulos incorporados.
- El cálculo pesado (exportar, importar, informes) corre en hilos de trabajo: cada hilo carga **los mismos plugins** (reciben la lista ya resuelta), así que un módulo funciona igual con `--workers 0` (en el hilo principal) que con hilos.
- La línea de arranque dice cuáles se cargaron: `módulos de terceros (se operan por la API y salen en el manifiesto; el sitio web no los trae): risk`.

**En Docker**, la imagen no trae plugins: monta una carpeta con el módulo **y su `node_modules`** (con `@iark/kernel` y `zod` instalados) y apunta `IARK_CONFIG` a su configuración. El módulo resuelve sus `import` desde esa carpeta, no desde `/app`:

```bash
# en el anfitrión: ./plugins/{iark.config.json, mi-modulo/…, node_modules/…}
docker run --rm -p 8787:8787 \
  -v "$PWD/plugins:/plugins:ro" -e IARK_CONFIG=/plugins/iark.config.json \
  iark-diagrams
```

La carpeta de plugins va fuera del espacio de trabajo (`IARK_WORKSPACE`, `/data`) a propósito: los proyectos no son de fiar (ver arriba). Ver también [Servicio HTTP](servicio.md#servicio-http-iark-serve) y [Despliegue en la nube](despliegue-nube.md).

## Dos copias del kernel

El CLI empaquetado lleva incrustado su propio `@iark/kernel`, y el módulo importa el suyo desde su `node_modules`: son **dos copias** del mismo código. Es inevitable (el módulo se publica por separado y no puede apuntar al interior del CLI) y por eso el contrato se comprueba por **forma**, no por identidad de clase. Lo que hay que saber:

- Un `ModuleError` lanzado por el módulo se reconoce como error de uso del CLI aunque venga de la otra copia (el kernel lo marca con `Symbol.for('iark.ModuleError')`): sale como mensaje y código de error, no como «error inesperado».
- No compares con `instanceof` clases del kernel de otra copia (salvo `ModuleError`); trabaja con los datos (objetos planos y JSON).
- Mantén `@iark/kernel` como `peerDependency` con un rango (`^0.1.0`): el contrato se versiona con `contractVersion`, no con la versión del paquete.

## Paquetes `@iark/*`

Para escribir módulos fuera del repositorio hacen falta los paquetes del monorepo como paquetes npm normales:

| Paquete | Qué contiene |
|---|---|
| `@iark/kernel` | El contrato `DomainModule`, `defineModule`, el registro, el manifiesto, URN, trazabilidad, protocolo embebido (`/protocol`) y resolución de endpoints (`/endpoint`). |
| `@iark/domain-c4`, `-integration`, `-data`, `-enterprise`, `-platform`, `-security` | Cada módulo incorporado como paquete (esquema, vistas, importadores y exportadores); dependen solo de `@iark/kernel`. |

Los siete comparten la versión de la raíz (`0.1.0`) y tienen **JavaScript ESM con tipos** en `dist/`. En el repositorio su `package.json` sigue apuntando a `src/*.ts` (vite, vitest, tsx y `tsc` lo consumen así) y declara el `exports` de publicación en `publishConfig.exports`; `npm run packages:build` genera los paquetes publicables en `dist-packages/` y `npm run packages:check` los empaqueta (`npm pack`), los instala en una carpeta limpia usando **solo los tarballs**, importa cada uno, compila un consumidor con `tsc` y ejecuta el módulo de ejemplo con `iark --config` del CLI empaquetado. Más en [Desarrollo](desarrollo.md#paquetes-publicables-iarkkernel-y-iarkdomain-).

**Estado de la publicación:** el flujo de publicación existe (`.github/workflows/release-packages.yml`, solo manual y por omisión en modo simulación), pero **todavía no se ha publicado nada en npm**. Mientras tanto, para probar un módulo propio con los paquetes reales: `npm run packages:build`, `npm pack ./dist-packages/kernel` y `npm install ./iark-kernel-0.1.0.tgz zod` en la carpeta del módulo.

## Lo que no hace (todavía)

- **El sitio web no carga módulos de terceros.** El banco de trabajo, el shell y el editor son estáticos (GitHub Pages o `--static`) y se compilan con los seis módulos incorporados; un navegador no puede ni debe ejecutar código arbitrario de una configuración. Un módulo de terceros se opera por CLI y API; el manifiesto lo anuncia sin `embed`, de modo que un anfitrión que consuma `/.well-known/iark.json` sabe que no hay editor que embeber. Cargar módulos en el navegador (con aislamiento y confianza explícita) queda como trabajo futuro de la [hoja de ruta](roadmap.md).
- No hay descarga ni instalación de módulos: `iark` no ejecuta `npm install` por ti.
- No hay recarga en caliente: al cambiar la configuración o el módulo se reinicia el comando (o el servicio).
- La configuración no acepta importadores o paquetes de iconos sueltos: se cargan **módulos** completos.
