# IArk - DIAgrams

> Antes «Diagramador C4». IArk - DIAgrams evoluciona hacia una suite de diagramación de arquitectura (integraciones, datos, empresarial, plataforma, seguridad…); hoy incluye el editor del **modelo C4**. El comando `c4diagram` se mantiene como alias de `iark`. Hoja de ruta: [`docs/roadmap.md`](docs/roadmap.md).

Editor web de diagramas del **modelo C4** (Contexto, Contenedores y Componentes) con:

- **JSON limpio y estable** como formato nativo, convertible 1‑a‑1 a **`.drawio`** (usa la librería C4 oficial de draw.io, con placeholders `%c4Name%`, `%c4Type%`, `%c4Description%`, `%c4Technology%`) y **importable desde `.drawio` y desde el DSL de Structurizr** (web y CLI).
- **Autolayout jerárquico** (ELK, algoritmo *layered* con boundaries anidados) como característica central: el mismo motor se usa en el navegador y en el CLI.
- **Editor interactivo** con la estética de [drawdb.app](https://www.drawdb.app/): cabecera con menús, toolbar flotante, panel lateral con pestañas y cards, panel de problemas, tema claro/oscuro, deshacer/rehacer, minimapa.
- **CLI `iark`** para generar diagramas a partir de **instrucciones en lenguaje natural** (Claude, salida estructurada), aplicar autolayout y convertir a `.drawio` sin abrir un navegador. Se puede usar sin clave de API con cualquier otra IA o agente.
- **Modo embebido** por `<iframe>` con protocolo **postMessage** al estilo de draw.io (`embed.diagrams.net`) y un SDK de anfitrión.
- **Suite de módulos** (integraciones, datos, empresarial, plataforma, seguridad) con **banco de trabajo web**, **widget embebible** (SDK y Web Component `<iark-module>`), **federación por manifiesto**, **servicio HTTP** (`iark serve`, con Dockerfile), **trazabilidad entre módulos** (`iark trace`) **proyectos** que agrupan diagramas de varios módulos en una carpeta de trabajo (`iark project`) y un **servidor autoalojable para varias personas** (`iark serve --tokens`, con una cuenta por persona y roles).

## Instalación

```bash
npm install
npm run dev        # editor web en http://localhost:5173
npm run build      # librería (dist/core), CLI (dist/cli), SDK de embebido (dist/embed) y app (dist/app)
npm test           # pruebas unitarias y de componente (vitest + Testing Library)
npm run test:coverage  # igual, con informe de cobertura (informativo, sin umbral que bloquee)
npm run e2e        # pruebas de extremo a extremo con @playwright/test (requiere build:app previo)
npm run verify     # typecheck + test + build + e2e, de punta a punta
npm run manifest   # regenera public/.well-known/iark.json (manifiesto de federación) a partir de los módulos registrados
npm run cli -- serve --static dist/app   # servicio HTTP + sitio en http://127.0.0.1:8787 (tras npm run build)
```

Requisitos: Node 20+.

## Pruebas

- **Unitarias y de componente** (`src/**/*.test.ts(x)`, vitest): cubren el núcleo (modelo, autolayout,
  export a `.drawio`, CLI), el store (`documentStore.test.ts`) y componentes React puntuales donde aporta algo que
  ni el store ni un E2E cubren mejor (`@testing-library/react`, entorno jsdom vía pragma
  `// @vitest-environment jsdom`). `npm run test:coverage` genera el informe (`@vitest/coverage-v8`).
- **Extremo a extremo** (`tests/e2e/*.spec.ts`, `@playwright/test`): recorren la app compilada (`vite preview`)
  en el Chromium del entorno. `playwright.config.ts` ya apunta a `CHROMIUM_PATH` (o
  `/opt/pw-browsers/chromium`) sin descargar un navegador propio, y guarda captura + traza solo si una prueba
  falla (`npx playwright show-trace test-results/.../trace.zip`). El servidor de `vite preview` escucha en el puerto
  4173; con `E2E_PORT=4176 npm run e2e` se cambia, para correr e2e a la vez desde varios checkouts. Usa un puerto
  distinto por checkout: si ya hay algo escuchando en el puerto, Playwright lo reutiliza y probaría el build de otro
  checkout en vez del propio. Las pruebas del lienzo de módulos esperan a que esté asentado (`canvasReady` /
  `selectView` en `tests/e2e/canvas-helpers.ts`, que leen `data-layout="ready"` en `module-canvas`) antes de medir
  o hacer clic: ELK y el encuadre de la cámara mueven los nodos después de que aparezcan, y no se usan esperas fijas.
  El editor C4 (`index.html`) publica lo mismo en `c4-canvas` (`data-view` y `data-layout`: «pending» hasta que ELK ha
  colocado la vista, React Flow la dibuja y la cámara ha terminado de encuadrar), y sus pruebas esperan con `c4Ready`,
  `openEditor` y `reloadEditor` en vez de `waitForTimeout` o `networkidle`. En las páginas con iframes se usa
  `domcontentloaded`, porque con iframes `networkidle` a veces no llega.
- **Imagen Docker** (`npm run docker:smoke`, `scripts/docker-smoke-cuentas.ts`): construye la imagen (o usa una con `--image`), la ejecuta de verdad
  y recorre el servicio gestionado contra un GitHub de mentira (`tests/helpers/fakeGithub.ts`): inicio de sesión, un proyecto en el volumen, reiniciar y
  sustituir el contenedor, copia de seguridad y restauración, bind mount, secreto por archivo y que nada secreto salga en `docker logs`. Necesita Docker y Linux
  (`--network host`); sin ellos se salta con un mensaje. No forma parte de `npm test`.

## Despliegue (GitHub Pages)

La app es un sitio estático (`dist/app`), sin servidor: la generación con IA vive solo en el CLI. (Para desplegar el **servicio con servidor** —la nube de proyectos con inicio de sesión de GitHub, HTTPS y disco— ver la [guía de despliegue](docs/despliegue-nube.md); esta sección es solo el sitio estático.)

El sitio se publica solo: cada push a `master` lanza el workflow
[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), que

1. compila el sitio con la ruta base `/<repositorio>/` (`npm run build:app`, que ya incluye el typecheck),
2. lo publica en la rama `gh-pages` con `scripts/deploy-gh-pages.sh` (solo el sitio compilado, más `.nojekyll`; la rama se reescribe en cada publicación) y
3. espera a que Pages sirva la compilación nueva y comprueba que `/`, `modulos.html`, `suite.html`, `trazabilidad.html`, `/.well-known/iark.json` y el trozo
   `assets/main-*.js` responden 200 (`scripts/verify-pages.sh`).

Un pull request hacia `master` ejecuta solo el paso 1 (comprueba que el sitio compila) y nunca publica. Los cambios que solo tocan `*.md`, `docs/`, `deploy/`,
`tests/` o el `Dockerfile` no lanzan nada. También se puede lanzar a mano desde la pestaña *Actions → Deploy to GitHub Pages → Run workflow* (siempre sobre `master`).
Si `master` avanza mientras una ejecución compila, esa ejecución se salta la publicación y la hace la más reciente, así que nunca se publica una versión vieja
encima de una nueva. Para dejar de publicar solo con cada push basta con quitar el disparador `push` del workflow: queda el manual.

- Origen de Pages: *Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` / (root)* (no se usa «GitHub Actions» como origen: el workflow empuja
  a la rama con el `GITHUB_TOKEN` y es Pages quien la sirve). El workflow pide `contents: write` en su propio archivo, pero *Settings → Actions → General →
  Workflow permissions* no debe prohibir a los workflows escribir en la rama `gh-pages` ni haber una regla de protección sobre ella que bloquee el push forzado.
- Publicar sin Actions sigue siendo posible: `npm run deploy:pages` hace lo mismo desde un equipo con permiso de escritura (compila con `/<repositorio>/` según
  `origin`, o con `BASE_PATH=/otra-ruta/`), y `bash scripts/verify-pages.sh <url> dist/pages` repite la comprobación.
- URL: `https://<usuario>.github.io/<repositorio>/` (la demo del modo embebido queda en
  `.../examples/embed-host.html`).
- `vite.config.ts` usa `BASE_PATH` como `base`. En hostings que sirven en la raíz (Cloudflare Pages, Netlify,
  Vercel) basta con `npm run build:app` y la carpeta `dist/app`, sin definir `BASE_PATH`.

## Proyectos (espacio de trabajo en carpeta)

Un **proyecto** agrupa diagramas de cualquier módulo de la suite (los de seguridad, plataforma e integración de un mismo sistema, por ejemplo) para guardarlos, comprobarlos y trazarlos juntos. En el CLI y en `iark serve` los proyectos viven en una **carpeta de trabajo** corriente, pensada para ir en git:

```
iark-workspace/                          la carpeta de trabajo: --workspace <carpeta>, IARK_WORKSPACE o, por omisión, ./iark-workspace
  tienda-web/                            un proyecto = un directorio; su nombre es el id del proyecto
    project.json                         opcional: nombre, descripción y nombre de cada diagrama (iark.project.meta/1)
    seguridad-ejemplo.security.json      un diagrama = el JSON de su módulo, tal cual: <id>.<módulo>.json
    plataforma-ejemplo.platform.json     (el mismo documento que entiende `iark validate --module platform`)
    pedidos-integracion.integration.json
```

- **La carpeta es la fuente de verdad.** Un directorio sin `project.json` ya es un proyecto (se llama como el directorio) y un `x.<módulo>.json` copiado a mano ya es un diagrama (se llama `x` y su fecha de creación es la de modificación del archivo), aunque no figure en el sidecar. Lo que no encaja se ignora sin fallar: otros archivos, directorios ocultos (`.git`), `node_modules`, ids o módulos inválidos, un `*.iark-project.json` y todo lo que no sea un archivo o directorio normal. Si dos archivos tienen el mismo id con distinto módulo (`x.c4.json` y `x.data.json`) se usa el primero por orden alfabético.
- **Ids.** El id de un proyecto o de un diagrama es un solo segmento de ruta (letras ASCII, dígitos, `_`, `-` y `.`, sin empezar ni acabar en punto, sin `..` y sin nombres reservados de Windows como `con` o `nul`). Al crear, sale del nombre sin tildes ni símbolos (`Gestión de pedidos` → `gestion-de-pedidos`) y se numera si ya está tomado (`gestion-de-pedidos-2`). **Renombrar solo cambia el nombre del sidecar**: el directorio y el archivo no se mueven, así que las rutas que otros hayan escrito en scripts siguen valiendo. No puede haber dos proyectos con el mismo nombre ni dos diagramas con el mismo nombre en un proyecto (sin distinguir mayúsculas).
- **Seguridad del disco.** Ningún id que llegue de fuera (línea de comandos o HTTP) puede salir de la carpeta de trabajo: se valida antes de tocar el disco y se comprueba que el destino queda dentro. **No se siguen enlaces simbólicos** (los de directorios y archivos se ignoran, aunque apunten dentro de la carpeta), y borrar un proyecto quita los enlaces que contenga, no lo que hay al otro lado.
- **Escrituras atómicas y concurrencia.** Cada guardado va a un temporal del mismo directorio y se publica con `rename` (nadie lee un archivo a medias); los diagramas nuevos se publican sin pisar uno existente, así que dos procesos (el CLI y `iark serve`) pueden trabajar en la misma carpeta. La fecha `updatedAt` de un diagrama es la de modificación de su archivo, con milisegundos, y crece siempre al guardar. Con `ifUpdatedAt` (API HTTP) un guardado falla con `conflict` si otro cambió el diagrama en medio.

```bash
iark project create "Tienda web" --description "Pedidos y pagos"
iark project add "Tienda web" examples/seguridad-ejemplo.json      # el módulo se deduce; también --module security, --name "Amenazas"
iark project add tienda-web examples/plataforma-ejemplo.json
iark project add tienda-web examples/pedidos-integracion.json
iark project list                                                  # proyectos y diagramas (módulo, nombre, fecha); --json para otras herramientas
iark project show tienda-web
iark project check tienda-web                                      # cada diagrama (esquema y reglas de su módulo) y las referencias URN entre ellos
iark project trace tienda-web --from integration:pedidos --direction referrers   # como `iark trace`, con los diagramas del proyecto
iark project export tienda-web -o tienda.iark-project.json         # el proyecto entero en un solo archivo (iark.project/1)
iark project import tienda.iark-project.json -w otra-carpeta       # lo crea en otro espacio de trabajo (nunca pisa uno existente)
iark project copy tienda-web seguridad-ejemplo --to otro-proyecto
iark project get tienda-web seguridad-ejemplo -o amenazas.json
iark project delete tienda-web --yes                               # borra el directorio entero; sin --yes no hace nada
```

Todos los subcomandos aceptan `-w, --workspace <carpeta>`; los proyectos y los diagramas se indican por id o por nombre.

| Subcomando | Qué hace |
|---|---|
| `list [--json]` · `show <proyecto> [--json]` | Proyectos y diagramas (módulo, nombre, fecha) |
| `create <nombre> [--description]` · `rename <proyecto> <nuevo-nombre>` · `delete <proyecto> --yes` | Ciclo de vida del proyecto (`delete` borra su directorio entero; no pide confirmación interactiva) |
| `add <proyecto> <archivo\|-> [--module] [--name] [--force] [--update]` | Añade un diagrama. Sin `--module` el módulo sale del nombre `x.<módulo>.json` o del único módulo cuyo esquema acepta el documento **sin descartar ninguno de sus campos** (si ninguno o varios, error de uso con la lista). Con `--module` un documento que no cumple el esquema se rechaza con la lista de errores, salvo `--force` (se guarda como borrador). Un nombre repetido da `exists`; con `--update` reemplaza el diagrama del mismo módulo conservando su id y su nombre |
| `get <proyecto> <diagrama> [-o]` · `rename-diagram` · `remove <proyecto> <diagrama> --yes` · `copy <proyecto> <diagrama> [--to] [--name]` | Operaciones sobre un diagrama |
| `export <proyecto> [-o]` · `import <archivo\|-> [--name]` | Archivo único del proyecto (`-o` puede ser una carpeta: se llama `<proyecto>.iark-project.json`) |
| `check <proyecto> [--strict] [--json]` | Una línea por diagrama y las referencias rotas, ambiguas y sin resolver. Código 3 si hay diagramas inválidos, errores de las reglas de un módulo o referencias rotas o ambiguas; `--strict` también con avisos de los módulos o referencias sin resolver (a un módulo sin diagrama en el proyecto) |
| `trace <proyecto> [--from] [--direction] [--depth] [--format markdown\|mermaid\|svg\|json] [-o]` | La trazabilidad de `iark trace` con los diagramas del proyecto. Una URN (`urn:iark:<módulo>:<id>`) se resuelve en todo el proyecto, y si dos diagramas del mismo módulo definen el mismo id, se marca como ambigua. Un diagrama que no se puede leer se deja fuera con un aviso |

Los errores de uso (proyecto o diagrama que no existe, nombre repetido, documento inválido, falta `--yes`) salen con código 2 y un mensaje de una línea; las comprobaciones fallidas, con 3; un disco o una carpeta inaccesibles, con 1.

### API HTTP de proyectos

`iark serve --workspace <carpeta>` (o `IARK_WORKSPACE`) añade la API de proyectos sobre la misma carpeta; sin ella esas rutas responden 404 «Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)». El manifiesto de la instancia anuncia entonces `"projects": "../api/projects"` y `"projectsAuth": "none"` (`"bearer"` con tokens: ver «Servidor para varias personas»). Todo es JSON salvo el archivo único del proyecto; los ids son los de la carpeta (`tienda-web`, `seguridad-ejemplo`).

| Ruta | Descripción |
|---|---|
| `GET /api/projects` · `POST /api/projects` | Lista (con diagramas, sin documentos) · crea `{ name, description? }` (201) |
| `GET\|PATCH\|DELETE /api/projects/<p>` | Resumen · renombra `{ name }` · borra |
| `POST /api/projects/<p>/diagrams` | Crea `{ module, name?, text }` (201) |
| `GET\|PUT\|PATCH\|DELETE /api/projects/<p>/diagrams/<d>` | `{ ...meta, text }` · guarda `{ text, ifUpdatedAt? }` (el diagrama debe existir) · renombra `{ name }` · borra |
| `GET /api/projects/<p>/bundle` | El archivo único (`Content-Disposition` con `<proyecto>.iark-project.json`) |
| `POST /api/projects/import[?name=]` | Cuerpo: ese archivo → crea un proyecto nuevo (201) |
| `GET /api/projects/<p>/check` | La comprobación del proyecto (`checkProject`) |

Códigos: `not-found` 404, `exists` 409, `conflict` 409, `invalid` 400, `unavailable` 500; el cuerpo es `{ "error": "…", "code": "…" }`. Un cuerpo que pasa de `maxBodyBytes` (5 MB) da 413.

**Seguridad (sin `--tokens`: solo para una persona, en su máquina).** `iark serve` escucha en localhost y una página ajena abierta en el navegador podría intentar leer o escribir en el disco del usuario a través de él. En las rutas de proyectos (y solo en ellas):

- POST, PUT, PATCH y DELETE exigen `Content-Type: application/json` (415 si no): un formulario o un `fetch` `no-cors` no pueden enviarlo. Se admiten parámetros (`; charset=utf-8`); DELETE también lo exige, con el cuerpo vacío.
- Una petición con cabecera `Origin` se rechaza con 403 salvo que su host (y puerto) coincidan con la cabecera `Host` o esté en `--cors`. Un `*` en `--cors` no basta para esta API: hay que nombrar el origen (`--cors https://mi-app.example`). Solo a esos orígenes se les anuncian `PUT`, `PATCH` y `DELETE` en `Access-Control-Allow-Methods`.
- Si la conexión llega por loopback, la cabecera `Host` debe ser `localhost`, `127.0.0.1` o `[::1]` (con o sin puerto); si no, 403 (protección contra el *DNS rebinding*). Esa comprobación solo es posible en loopback: con un espacio de trabajo, `iark serve --host 0.0.0.0` (o cualquier `--host` que no sea de loopback) **no arranca sin `--tokens`** (código 2). Para exponerlo a otras personas, use tokens: ver «Servidor para varias personas (nube autoalojada)».
- Los ids se validan antes de tocar el disco (400 si no son un id válido) y los errores de disco no revelan rutas.

Con `--tokens` esta lista cambia (no hay `Host` ni `Origin` que comprobar, pero sí token y rol): ver la sección siguiente.

## Servidor para varias personas (nube autoalojada)

Con `--tokens`, `iark serve --workspace` deja de ser solo de una persona en su máquina: puede escuchar en una red (o en internet, detrás de HTTPS) con **una cuenta por persona** y **roles**. El sitio publicado en GitHub Pages es estático y no tiene servidor: la «nube» es la que usted aloja, y el cliente web se conecta a ella con la URL del servidor y el token de cada persona. No hay registro abierto de usuarios ni OAuth: las «cuentas» son tokens que emite quien administra el servidor.

### Crear tokens

```bash
iark auth create "Ana García" --role admin  --tokens iark-tokens.json    # imprime el token UNA vez (stdout); un recordatorio, por stderr
iark auth create "Luis"       --role editor --tokens iark-tokens.json
iark auth create "Visitas"    --role viewer --tokens iark-tokens.json
iark auth list   --tokens iark-tokens.json                               # nombre, rol y fecha; --json para otras herramientas
iark auth revoke "Visitas" --tokens iark-tokens.json
export IARK_TOKENS=iark-tokens.json                                      # equivale a --tokens en `iark auth` y en `iark serve`
```

- Un token es `iark_` y 32 bytes aleatorios en base64url (`iark_Zk3…`, 48 caracteres). **El archivo guarda solo su hash (sha256)**, nunca el token: quien lo lea no puede usarlo, y si se pierde el token no se puede recuperar (se revoca y se crea otro). El archivo es `{ "version": 1, "tokens": [{ "name", "role", "hash", "createdAt" }] }`, se crea con modo 0600 y se escribe de forma atómica (temporal + `rename`).
- El nombre es único (sin distinguir mayúsculas) y es el que devuelve `whoami`. Los tokens no caducan: se revocan por su nombre.
- **El servidor relee el archivo cuando cambia** (su fecha, tamaño o inodo): crear o revocar un token surte efecto en la siguiente petición, sin reiniciar. Si el archivo no se puede leer o está dañado, el servidor **deniega todo** (503, nunca abre el acceso) y lo anota en stderr, sin contenido; vuelve el acceso en cuanto el archivo es válido otra vez. Al arrancar, en cambio, el archivo debe existir y ser válido (si no, el servidor no arranca: código 2).
- `iark auth` hace una persona cada vez: dos administradores a la vez pueden pisarse el cambio.

### Arrancar

```bash
iark serve --host 0.0.0.0 --port 8787 \
  --workspace ./iark-workspace --tokens ./iark-tokens.json \
  --cors https://juliancardonagaleano.github.io
```

- **Fuera de loopback, `--tokens` es obligatorio.** Con `--workspace` (o `IARK_WORKSPACE`) y un `--host` que no sea `127.0.0.1`, `localhost` o `::1`, sin `--tokens` el servicio **se niega a arrancar** (código 2) y explica las dos salidas: exigir tokens, o escuchar solo en `--host 127.0.0.1`. Sin espacio de trabajo no hay nada que proteger y todo sigue como antes (`--tokens` se ignora con un aviso).
- `--tokens` también vale en loopback (entonces también se exige token). Sin `--tokens`, todo funciona exactamente como en «API HTTP de proyectos».
- `--cors <orígenes>` lista los sitios web que pueden llamar a la API desde el navegador: aquí, el cliente web publicado (`https://juliancardonagaleano.github.io`, solo el origen, sin ruta). Con tokens también vale `*` (ver «CORS» más abajo).
- Detrás de un proxy, añada `--trust-proxy` (ver «Límites»).
- Con tokens fuera de loopback el arranque recuerda que el servicio **no habla TLS**.

### Roles

| Operación | `viewer` | `editor` | `admin` |
|---|:---:|:---:|:---:|
| Leer: `GET` de proyectos, diagramas, archivo único (`bundle`), comprobación (`check`) y `/api/whoami` | sí | sí | sí |
| Crear, guardar, renombrar y borrar **diagramas** | no | sí | sí |
| Crear y renombrar **proyectos** · importar un proyecto (`POST /api/projects/import`) | no | sí | sí |
| Borrar **proyectos** (`DELETE /api/projects/<p>`) | no | no | sí |

Cada rol incluye lo de los de abajo. Lo que no es una lectura (también un método o una ruta que no existen) exige al menos `editor`: un `viewer` recibe 403 en cualquier escritura, sin sondear con peticiones torcidas. El rol se comprueba **antes** de leer el cuerpo o tocar el disco. Los roles valen para todo el espacio de trabajo (no hay permisos por proyecto).

### Contrato HTTP con autenticación

Las rutas `/api/projects…` y `GET /api/whoami` exigen la cabecera `Authorization: Bearer <token>` (el esquema no distingue mayúsculas). El resto de la API (validar, exportar, módulos, manifiesto…) sigue sin pedir token: no toca el disco.

| Estado | Cuándo | Cuerpo y cabeceras |
|---|---|---|
| `401` | Sin cabecera, con otro esquema, o con un token que no existe o se revocó | `{ "error": "…", "code": "unauthorized" }` + `WWW-Authenticate: Bearer realm="iark"`. El mensaje es el mismo exista o no el token |
| `403` | El rol del token no alcanza para la operación | `{ "error": "…", "code": "forbidden" }` |
| `429` | Demasiados intentos fallidos desde la misma dirección | `{ "error": "…", "code": "rate-limited" }` + `Retry-After: <segundos>` |
| `503` | El archivo de tokens no se puede leer o está dañado (se deniega todo) | `{ "error": "…", "code": "unavailable" }`. Distinto del 401 a propósito: un cliente no debe confundir un servidor mal configurado con un token revocado (y olvidar el token) |

- `GET /api/whoami` → `{ "auth": true, "name": "Ana García", "role": "admin" }` con un token válido (401 si no). Sin `--tokens` es público y responde `{ "auth": false }`. Es la forma de comprobar un token antes de guardarlo y de saber qué rol tiene.
- El manifiesto (`/.well-known/iark.json`, siempre público) anuncia `"projects": "../api/projects"` y `"projectsAuth": "bearer"` (o `"none"` sin tokens): el cliente lo lee para saber si debe pedir un token.
- **Frenado de intentos fallidos**: desde una misma dirección se toleran 5 intentos fallidos (una petición que trae `Authorization` y no vale); después, 1 s de espera, y se duplica con cada fallo más (2 s, 4 s…) hasta un tope de 5 min. Mientras dura el freno, todas las peticiones de esa dirección a estas rutas dan 429, también las que traigan un token bueno (si no, el freno serviría para seguir adivinando). Las peticiones sin cabecera no cuentan, un acierto no borra los fallos y una dirección que no falla durante 15 min se olvida. Es en memoria (se pierde al reiniciar) y acotado.
- **Con tokens ya no se comprueban `Host` ni `Origin`** en estas rutas: la credencial es una cabecera que el navegador no añade por su cuenta, así que una página ajena no puede usar la API sin un token que alguien le haya dado (no hay CSRF) y no hay «DNS rebinding» que atajar; además el servidor se expone con otros nombres y desde otros sitios. **Se mantiene** `Content-Type: application/json` en POST, PUT, PATCH y DELETE (415 si no).
- Un token nunca se escribe en ningún registro ni se devuelve en ninguna respuesta.

### CORS

Con tokens, las rutas `/api/projects…` y `/api/whoami` anuncian `Access-Control-Allow-Headers: Content-Type, Authorization`, todos los métodos (`GET, POST, PUT, PATCH, DELETE, OPTIONS`) y `Access-Control-Expose-Headers: Retry-After, Content-Disposition, Location` para los orígenes de `--cors` **y también para `*`**. Sin tokens, para esta API hay que nombrar el origen: abrirla a `*` dejaría que cualquier página escribiera en el disco. Con tokens no hace falta esa cautela, porque la credencial es una cabecera que el navegador no envía por sí solo (no se usan cookies ni `Access-Control-Allow-Credentials`): una página ajena sin token recibe 401. El preflight `OPTIONS` no lleva credenciales y siempre responde 204, también con `Authorization` en `Access-Control-Request-Headers`; las respuestas de error (401, 403, 429…) llevan las mismas cabeceras de CORS, para que el cliente pueda leerlas. El resto de la API conserva el CORS de siempre.

### Con Docker

El contenedor corre como el usuario `node` (uid 1000): la carpeta de trabajo y la de tokens deben poder leerse por ese usuario (y la de trabajo, escribirse).

```bash
docker build -t iark-diagrams .
mkdir -p datos/espacio datos/tokens && sudo chown -R 1000:1000 datos
# crear el primer token con la propia imagen (su ENTRYPOINT es `serve`, así que se cambia por `node`)
docker run --rm -v "$PWD/datos/tokens:/tokens" --entrypoint node iark-diagrams \
  dist/cli/index.js auth create "Ana García" --role admin --tokens /tokens/tokens.json
# el servicio, con la carpeta de trabajo y la de tokens como volúmenes; publicado solo en el anfitrión, donde va el proxy con HTTPS (abajo)
docker run -d --name iark -p 127.0.0.1:8787:8787 \
  -v "$PWD/datos/espacio:/workspace" -v "$PWD/datos/tokens:/tokens:ro" \
  -e IARK_WORKSPACE=/workspace -e IARK_TOKENS=/tokens/tokens.json \
  iark-diagrams --cors https://juliancardonagaleano.github.io --trust-proxy
```

- **Monte la carpeta de los tokens, no el archivo.** Docker monta un archivo suelto por su inodo, y `iark auth` reemplaza el archivo de forma atómica (con otro inodo): el contenedor seguiría viendo el de antes y las revocaciones no surtirían efecto. Con la carpeta montada sí. El servidor solo lee el archivo, así que `:ro` vale.
- La imagen escucha en `0.0.0.0`: con `IARK_WORKSPACE` y sin `IARK_TOKENS` se niega a arrancar. Un archivo de tokens creado en el anfitrión con otro usuario (modo 0600) no lo podrá leer el contenedor: créelo con la imagen, como arriba, o cámbiele el dueño (`chown 1000`).
- Para revocar o listar: `docker run --rm -v "$PWD/datos/tokens:/tokens" --entrypoint node iark-diagrams dist/cli/index.js auth revoke "Ana García" --tokens /tokens/tokens.json`; el servidor en marcha lo nota solo.
- El `HEALTHCHECK` de la imagen consulta `/api/modules`, que sigue siendo público.
- La imagen trae `/data`, una carpeta vacía del usuario `node`: con un **volumen con nombre** (`-v iark-data:/data`) hereda ese dueño y sirve tal cual; con un bind mount de una carpeta del anfitrión, su dueño debe ser `1000:1000` (`chown 1000:1000 <carpeta>`). Es la carpeta que usa el servicio gestionado (`IARK_WORKSPACE=/data/workspace`, `IARK_ACCOUNTS=/data/accounts.json`).
- **Con inicio de sesión de GitHub** en lugar de tokens (nube gestionada), la imagen y un `docker-compose.yml` con Caddy, el secreto como Docker secret y el volumen ya están preparados en [`deploy/`](deploy/); la guía paso a paso (OAuth App, dominio, primer arranque, copias de seguridad) es [`docs/despliegue-nube.md`](docs/despliegue-nube.md).

Con HTTPS delante (Caddy), en un `docker-compose.yml`:

```yaml
services:
  iark:
    image: iark-diagrams
    restart: unless-stopped
    command: ["--cors", "https://juliancardonagaleano.github.io", "--trust-proxy"]
    environment:
      IARK_WORKSPACE: /workspace
      IARK_TOKENS: /tokens/tokens.json
    volumes:
      - ./datos/espacio:/workspace
      - ./datos/tokens:/tokens:ro
    # sin `ports`: solo el proxy llega a él
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

### HTTPS: el servidor no habla TLS

`iark serve` solo habla HTTP: sin HTTPS los tokens viajan en claro. Ponga delante un proxy inverso con un certificado, y pásele `--trust-proxy` a `iark serve`. Lo mínimo con Caddy (obtiene y renueva el certificado solo; `nube.ejemplo.org` debe apuntar a su máquina):

```
nube.ejemplo.org {
	reverse_proxy iark:8787
}
```

o con nginx (certificado ya emitido, por ejemplo con certbot):

```nginx
server {
    listen 443 ssl;
    server_name nube.ejemplo.org;
    ssl_certificate     /etc/letsencrypt/live/nube.ejemplo.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nube.ejemplo.org/privkey.pem;
    client_max_body_size 6m;                          # el servidor admite cuerpos de hasta 5 MB
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # el cliente real; no se fía de lo que el cliente haya puesto
    }
}
```

### Límites

- **Sin TLS** (arriba) y **sin registro abierto ni OAuth**: no hay contraseñas, ni registro de personas, ni inicio de sesión con terceros. Quien administra crea un token por persona y se lo entrega por un canal seguro. Los tokens no caducan y los roles son globales al espacio de trabajo (no hay permisos por proyecto).
- **Un token guardado en el navegador queda expuesto a cualquier XSS del sitio que lo use** (y a las extensiones del navegador y a quien use ese equipo). Use el rol mínimo (`viewer` para quien solo lee), revoque el token ante la duda y no abra el cliente web desde un sitio que no controle.
- **`--trust-proxy` solo detrás de un proxy.** Sin él, todos los clientes de un proxy comparten la dirección del proxy y, por tanto, el freno de intentos fallidos: cualquiera podría frenar a todos durante unos minutos con tokens inválidos. Con él, la dirección sale de la última entrada de `X-Forwarded-For`: sin un proxy delante, cualquiera cambiaría de dirección a voluntad y el freno no serviría. El freno es por dirección exacta (no agrupa un IPv6 por su prefijo) y no sustituye a un cortafuegos.
- Un token con rol `editor` o `admin` puede escribir y borrar en la carpeta de trabajo: el control de versiones de la carpeta (git, copias de seguridad) es su red de seguridad. Cada diagrama se guarda de forma atómica y `ifUpdatedAt` detecta un guardado en medio, pero no hay edición simultánea en tiempo real ni historial de quién cambió qué.
- El servidor no registra accesos. El resto de la API (validar, exportar…) no pide token y consume CPU de su servidor con cuerpos de hasta 5 MB.

## Servicio gestionado: inicio de sesión con GitHub

Con `--accounts`, el mismo `iark serve --workspace` ofrece **«Iniciar sesión con GitHub»** en lugar de repartir tokens a mano: cada persona entra con su cuenta de GitHub, el servicio guarda quién es y a qué proyectos pertenece, y le da una **sesión** (un token que caduca) que se usa exactamente como un token de `iark auth`: `Authorization: Bearer <sesión>`. Lo que hace falta es una OAuth App de GitHub (la crea quien aloja el servicio: [guía de despliegue](docs/despliegue-nube.md), con los valores exactos de cada campo), un archivo para las cuentas y la dirección pública del servicio. `--tokens` sigue existiendo y puede usarse a la vez (cuentas de servicio, scripts y CLI con un rol para toda la carpeta).

```bash
export IARK_GITHUB_CLIENT_SECRET=…            # solo por entorno o por IARK_GITHUB_CLIENT_SECRET_FILE: nunca por la línea de comandos
iark serve --host 0.0.0.0 --port 8787 --static dist/app \
  --workspace ./iark-workspace --accounts ./iark-accounts.json \
  --github-client-id Iv1.abc123 --public-url https://iark.ejemplo.org \
  --admins 583231 --signup invite
```

| Opción | Variable | Qué hace |
|---|---|---|
| `--accounts <archivo>` | `IARK_ACCOUNTS` | Dónde guarda el servicio las cuentas, las sesiones y la pertenencia a proyectos (JSON, modo 0600, escritura atómica; solo lo escribe el servicio: no lo edite con él en marcha ni use varias réplicas sobre el mismo archivo) |
| `--github-client-id <id>` | `IARK_GITHUB_CLIENT_ID` | Client ID de la OAuth App |
| — | `IARK_GITHUB_CLIENT_SECRET` o `IARK_GITHUB_CLIENT_SECRET_FILE` | Client secret de la OAuth App. **No existe opción de línea de comandos**: se vería en la lista de procesos |
| `--public-url <url>` | `IARK_PUBLIC_URL` | Dirección pública del servicio (https; solo `localhost` puede ser http). La «Authorization callback URL» de la OAuth App es `<esa dirección>/api/auth/github/callback` |
| `--signup invite\|open` | `IARK_SIGNUP` | `invite` (por omisión): solo entran los administradores y las personas invitadas (o con un proyecto compartido: ver «Compartir proyectos»). `open`: entra cualquiera con cuenta de GitHub |
| `--admins <lista>` | `IARK_ADMINS` | Administradores de la instancia, separados por comas: nombres de usuario de GitHub o, **mejor, sus identificadores numéricos** (el nombre de usuario puede pasar a otra persona si su dueña lo cambia; el id no). `curl https://api.github.com/users/<usuario>` lo da |
| `--session-days <n>` | `IARK_SESSION_DAYS` | Duración de una sesión (30 por omisión) |
| `--max-projects <n>` | `IARK_MAX_PROJECTS` | Proyectos que puede administrar cada persona (25 por omisión; los administradores no tienen tope) |
| `--cors <orígenes>`, `--trust-proxy` | `IARK_CORS`, `IARK_TRUST_PROXY=true` | Orígenes que pueden llamar a la API desde un navegador y a los que se vuelve tras entrar (para volver hay que nombrarlos: un `*` no vale); y «hay un proxy de confianza delante» (solo con proxy: ver «Límites»). Sirven para plataformas que solo se configuran por entorno |
| `--github-url`, `--github-api-url` | `IARK_GITHUB_URL`, `IARK_GITHUB_API_URL` | Con GitHub Enterprise Server, su dirección y su API (`https://git.empresa.com`, `https://git.empresa.com/api/v3`) |

Con cuentas, el servicio puede escuchar fuera de loopback sin `--tokens` (hace falta una de las dos formas de autenticarse). Si falta algo de lo anterior, el arranque lo dice todo de una vez (código 2). Con `--signup invite` y sin administradores ni cuentas todavía, nadie podría entrar: no arranca.

**Desplegarlo**: la imagen Docker ya sirve como servicio gestionado y [`deploy/`](deploy/) trae un `docker-compose.yml` de producción (IArk + Caddy con HTTPS automático, volumen de datos y el secreto de la OAuth App como Docker secret). La guía [`docs/despliegue-nube.md`](docs/despliegue-nube.md) lleva de cero a un servicio en marcha: registrar la OAuth App, DNS y firewall, primer arranque, entrar como administradora, usar el sitio de GitHub Pages contra la instancia, copias de seguridad, actualizar y los errores más frecuentes.

### Cómo es el inicio de sesión

1. El cliente genera un secreto (`verifier`) y manda a la persona a `GET /api/auth/github/login?redirect=<dónde volver>&challenge=<sha256(verifier) en base64url>`. El servicio guarda un `state` al azar (10 minutos) y lo pone también en una cookie `HttpOnly; SameSite=Lax` de ese navegador, y la lleva a GitHub **sin pedir permisos** (solo la información pública del perfil).
2. GitHub devuelve a `/api/auth/github/callback`. El servicio comprueba que el `state` es suyo, que no se usó antes, que no caducó y que viene en la cookie de **este** navegador (nadie puede hacer que otra persona termine un inicio de sesión que empezó él); cambia el código por un token de GitHub, lee `GET /user`, **revoca ese token** (IArk no conserva ningún acceso a GitHub) y decide si la persona puede entrar.
3. Devuelve a la persona a `redirect#iark_code=<código>` (o `#iark_error=<motivo>`: `access_denied`, `not_invited`, `disabled`, `github_unavailable`, `login_failed`). Es un **código de un solo uso (60 s) en el fragmento**, que no viaja al servidor ni queda en registros ni en `Referer`; la sesión no va nunca en una URL.
4. `POST /api/auth/exchange { code, verifier }` lo cambia por `{ token, expiresAt, user }` (PKCE: solo quien conoce el `verifier` puede; un código robado no sirve y se gasta en el primer intento; 5 fallos seguidos frenan la dirección con 429).
5. `POST /api/auth/logout` con la sesión la cierra. `GET /api/whoami` con una sesión responde `{ auth: true, name, role: <rol en la instancia>, user: { id, login, name?, avatarUrl?, siteRole } }`.

`redirect` solo puede ser el propio sitio (`--public-url`) o un origen nombrado en `--cors` (nunca `*`): no hay redirección abierta. `GET /api/auth/providers` (público) dice qué formas de entrar ofrece la instancia: `{ providers: [{ id: "github", label: "GitHub" }], tokens: boolean, signup }`. El token de sesión (`iark_s_` + 256 bits) **solo se guarda como hash sha256**, igual que los de `iark auth`.

### Quién ve qué

- **Rol en la instancia** (`siteRole`): `admin` (los de `--admins`: ven todos los proyectos y son `admin` de todos), `member` (pueden crear y importar proyectos) y `guest` (no crean proyectos: solo entran a los que les compartan, ver «Compartir proyectos»).
- **Rol en cada proyecto**: `viewer`, `editor` o `admin`, los mismos de la tabla de «Roles». Quien crea o importa un proyecto queda como `admin` del suyo; **la lista de proyectos solo trae aquellos a los que se pertenece**, y cada uno trae su `role`.
- Un proyecto al que no se pertenece responde **404** (igual que si no existiera: no se revela qué proyectos hay); con un rol que no alcanza, 403 `forbidden`. Todo se decide antes de leer el cuerpo y de tocar el disco.
- Borrar un proyecto olvida a sus miembros: otro proyecto con el mismo nombre no los hereda. Un proyecto creado a mano en la carpeta (o con un token) no pertenece a nadie: lo ven los tokens y los administradores de la instancia.
- Los tokens de `--tokens` no cambian: su rol vale para toda la carpeta y sus respuestas no llevan `role`.

### Compartir proyectos

Quien administra un proyecto decide quién pertenece a él y con qué rol. Los tres endpoints cuelgan del proyecto y solo existen con `--accounts` (sin cuentas responden 404):

| Petición | Quién | Qué hace |
|---|---|---|
| `GET /api/projects/<p>/members` | `viewer` o más | `Member[]`, los administradores primero: `{ login, name?, avatarUrl?, role, pending, you? }`. `pending` es una invitación todavía sin aceptar; `you` marca a quien llama |
| `PUT /api/projects/<p>/members/<usuario>` | `admin` del proyecto | `{ "role": "viewer" \| "editor" \| "admin" }` → comparte el proyecto o cambia el rol (201 si es nuevo, 200 si cambió) |
| `DELETE /api/projects/<p>/members/<usuario>` | `admin` del proyecto, **o la propia persona** (cualquier rol) | Quita a alguien, o la persona se va ella misma → `{ "removed": "<usuario>" }` |

- Se comparte con un **nombre de usuario de GitHub**. Si esa persona ya entró, pertenece al proyecto al instante. Si no tiene cuenta, se crea una **invitación** (`pending: true`) que reclama al entrar con ese nombre: con `--signup invite` la invitación le da entrada a la instancia como `guest` (puede abrir el proyecto compartido, no crear proyectos propios); con `--signup open`, como `member`.
- **Quitar a una persona invitada que aún no ha entrado y que no tiene más proyectos cancela su invitación**: ya no puede entrar. Quien ya entró conserva su cuenta (un administrador puede desactivarla, ver abajo).
- **Un proyecto no se queda sin administrador**: quitar o bajar de rol a la única persona que lo administra responde 409 `{ code: "last-admin" }` (nombre antes a otra). Un proyecto admite hasta 100 personas (409 `{ code: "limit" }`) y la instancia, hasta 500 invitaciones sin aceptar (quien tenga un proyecto puede llenar ese tope; quien administra la instancia las ve y las cancela en `/api/admin/users`).
- Los administradores de la instancia ven y cambian los miembros de cualquier proyecto sin pertenecer a él (no aparecen en la lista); un token con rol `admin` también. Quitar a alguien le cierra el proyecto en la siguiente petición, aunque conserve su sesión.
- Los errores son los de siempre: 400 `invalid` (usuario o rol que no valen), 403 `forbidden` (rol insuficiente), 404 (no se pertenece al proyecto, o no existe), 415 sin `Content-Type: application/json`.

```bash
curl -X PUT https://iark.ejemplo.org/api/projects/tienda/members/carla \
  -H "Authorization: Bearer $SESION" -H "Content-Type: application/json" -d '{"role":"editor"}'
```

### Administrar las cuentas de la instancia

Solo para quien administra la instancia (una persona con rol `admin` o un token de `--tokens` con rol `admin`; los demás, 403). Es lo que usará la pantalla de administración y también sirve desde la línea de comandos:

| Petición | Qué hace |
|---|---|
| `GET /api/admin/users` | Las cuentas: `{ id, login, name?, avatarUrl?, siteRole, disabled, pending, listed?, createdAt, lastLoginAt?, projects }`, por nombre de usuario. `listed` marca a quien figura en `--admins`; `projects`, a cuántos proyectos pertenece |
| `PUT /api/admin/users/<usuario>` | `{ siteRole?: "admin" \| "member" \| "guest", disabled?: boolean }` → cambia el rol de la instancia o desactiva/reactiva la cuenta (desactivar cierra sus sesiones y le impide volver a entrar). Con un nombre que no existe **crea una invitación** (rol `member` por omisión): 201 |
| `DELETE /api/admin/users/<usuario>` | Cancela la invitación de quien todavía no ha entrado. Con quien ya entró, 409 `conflict`: se desactiva |

Nadie puede cambiar su propio rol ni desactivarse (409 `self`: que lo haga otra persona), y a quien figura en `--admins` no se le puede bajar de rol ni desactivar desde la API (409 `listed-admin`): su rol lo manda la lista. Un `PUT` con `siteRole: "admin"` hace administradora a otra persona sin tocar `--admins`; quitarle el rol es otro `PUT`.

## Proyectos en la app web (este navegador)

Los mismos proyectos de la sección anterior (diagramas de cualquier módulo, agrupados) se usan desde el navegador sin instalar nada: en el **banco de trabajo** (`modulos.html`, botón *Proyectos…*) y en el **editor C4** (*Archivo ▸ Proyectos…*), que comparten almacén. Por omisión viven en **este navegador** (IndexedDB); para guardarlos en un servidor, véase la sección siguiente.

- **El gestor** crea, renombra y borra proyectos; crea un diagrama nuevo (con el ejemplo del módulo o vacío), guarda el documento que estás editando, y abre, renombra, duplica y borra diagramas. No puede haber dos proyectos con el mismo nombre ni dos diagramas con el mismo nombre en un proyecto (sin distinguir mayúsculas).
- **Autoguardado.** Con un proyecto y un diagrama abiertos, cada cambio se guarda tras 500 ms de pausa; la barra del proyecto (banco) y el chip del editor C4 dicen «Guardado en «X»». Sin proyecto abierto todo sigue como antes: un borrador por módulo en `localStorage`, que «Guardar en «X»» convierte en un diagrama del proyecto.
- **Abrir directamente** con `modulos.html?project=<id>&diagram=<id>`; se recuerda el último diagrama abierto. En el editor C4, abrir un diagrama de otro módulo lleva al banco de trabajo con ese enlace.
- **Enlaces entre diagramas.** Las referencias `ref: "urn:iark:<módulo>:<id>"` se resuelven en todo el proyecto: doble clic o Alt+↓ sobre un elemento enlazado abre el diagrama que lo contiene, y Alt+↑ (o la miga de pan) vuelve al anterior.
- **Dos pestañas.** Si otra pestaña guarda el mismo diagrama mientras lo editas, se avisa (`ifUpdatedAt`) y puedes «Quedarme con mi versión» o «Cargar la otra»: no se mezclan cambios. Cargar un ejemplo o importar sobre un diagrama guardado avisa «Se reemplazó el contenido de «X»» y se puede deshacer.
- **Copia de seguridad.** *Exportar* baja el proyecto entero como `<proyecto>.iark-project.json` (`iark.project/1`, el mismo archivo de `iark project export`) e *Importar proyecto* lo recupera sin pisar nada: si el nombre ya existe queda «Nombre (2)». Un proyecto admite hasta 500 diagramas.

Límites: IndexedDB pertenece a **este navegador y a este sitio**. Borrar los datos del sitio, usar otro navegador u otro equipo o una ventana privada deja los proyectos fuera de alcance: **exporta de vez en cuando** o usa un servidor. Con el almacenamiento bloqueado la app dice «Almacenamiento no disponible» y sigue funcionando con borradores.

## Guardar en la nube (servidor propio) desde el navegador

Por omisión los proyectos de la app web viven en **este navegador** (IndexedDB). Para verlos desde otros equipos y compartirlos con otras personas se pueden guardar en un **servidor propio**: el mismo `iark serve --workspace` de la sección anterior, cuya API de proyectos ya es lo que usa el navegador. El servidor es tuyo y su carpeta de trabajo (la misma de `iark project`, pensada para ir en git) es la fuente de verdad; se entra con un token (`--tokens`) o, en una instancia con cuentas (`--accounts`), con **«Iniciar sesión con GitHub»** (ver el apartado «Iniciar sesión con GitHub» más abajo y «Servicio gestionado: inicio de sesión con GitHub»).

**1. Arrancar el servidor.** El navegador solo deja que la página lea las respuestas de otro origen si el servidor lo autoriza, así que hay que darle el origen exacto de la página con `--cors` (sin barra final ni ruta):

```bash
iark serve --workspace ./iark-workspace --cors https://mi-usuario.github.io   # la app publicada
iark serve --workspace ./iark-workspace --cors http://localhost:5173          # desarrollo (npm run dev)
```

- Si sirves el propio sitio desde el servidor (`--static dist/app`), la página y la API comparten origen y `--cors` no hace falta.
- Con `--tokens <archivo>` el servidor exige un token (cabecera `Authorization: Bearer`) y reparte permisos por rol; se configura como se explica en «Servidor para varias personas», que no se repite aquí. Sin él, **quien llegue al puerto lee y escribe los proyectos**: déjalo en `127.0.0.1`.
- `iark serve` **no habla TLS**. Para usarlo por internet pon delante un proxy con https. Y una página publicada por https no puede llamar a una dirección `http://` que no sea la propia máquina (contenido mixto: el navegador lo bloquea, y el gestor lo avisa al escribir la dirección).

**2. Conectar desde el gestor.** *Proyectos… ▸ Dónde se guardan ▸ Conectar a un servidor…* (en el banco de trabajo y en el editor C4, que comparten almacén):

1. Escribe la dirección (`https://iark.ejemplo.org`, `http://localhost:8787`) y, si el servidor lo pide, el token. El nombre es opcional.
2. **Probar conexión** dice quién eres y qué rol tienes, o por qué falla: sin conexión, el navegador rechazó el origen (CORS; te dice con qué `--cors` arrancar el servidor), el servidor no ofrece proyectos (¿sin `--workspace`?), token inválido, sin permiso o demasiados intentos.
3. **Conectar** guarda lo que haya pendiente, anota la configuración y **recarga la página**: es la forma más simple y segura de cambiar de almacén. **Volver a este navegador** lo deshace (los proyectos del navegador no se tocan: estaban aparte).

Con un servidor, la barra del proyecto del banco y el chip del editor dicen «Guardado en «X» · servidor». El último diagrama abierto se recuerda por servidor.

**2b. Iniciar sesión con GitHub (instancias con cuentas).** Si el servidor se arrancó con `--accounts`, *Dónde se guardan* ofrece **Iniciar sesión con GitHub** (y, si abriste la página desde esa misma instancia, su dirección ya aparece escrita). La página va al servidor, a GitHub y vuelve recargada con la sesión; en la barra de direcciones no queda ningún código. **Usar un token** sigue disponible, plegado.

- **Qué se guarda y dónde.** La dirección y el nombre del servidor, en `localStorage` (`iark.projects.backend`), no son secretos. La sesión (`iark_s_…`) va en `localStorage` si dejas marcada **«Mantener la sesión en este equipo»** (marcada por omisión: las sesiones caducan y se pueden cerrar) y en `sessionStorage` si no (solo esa pestaña). El estado `iark.login.pending` existe solo durante el inicio de sesión. Nunca se guarda ninguna credencial de GitHub: el servidor usa su token una vez y lo revoca.
- **Cerrar sesión** la cierra en el servidor (el token deja de valer aunque lo hubieran copiado), olvida el token del navegador y vuelve a «Este navegador», recordando solo la dirección.
- **Si caduca** (o se cierra desde otro sitio), el guardado avisa «Tu sesión caducó», el texto se conserva en pantalla e *Iniciar sesión* la retoma. Mientras no vuelvas a entrar no se reintenta contra el servidor (cada intento fallido cuenta para el freno de la dirección).
- **Roles y compartir.** La lista de proyectos trae tu rol en cada uno y la interfaz lo respeta (un lector no renombra, duplica, borra ni guarda; borrar un proyecto es del administrador). Quien administra un proyecto lo comparte desde **Compartir…** con el usuario de GitHub y un rol (lector, editor, administrador). Si la persona aún no ha entrado queda «pendiente» y lo tendrá al entrar con esa cuenta, también en instancias solo por invitación. Cualquiera puede salir con **Salir del proyecto**; un proyecto no se queda sin administrador. La API detrás es la de «Compartir proyectos».
- **Límites.** Iniciar sesión recarga la página: lo que no se pudo guardar se pierde si lo confirmas (antes se pide confirmación y «Cancelar» lo conserva), y no hay ventana emergente. Hace falta https o `localhost` (la comprobación PKCE usa `crypto.subtle`), y el servidor debe aceptar el origen de la página con `--cors` si no es el suyo. Con tokens sin rol la interfaz no limita nada y decide el servidor.

**3. Qué se guarda en el navegador y qué tan seguro es.**

- La dirección y el nombre del servidor, en `localStorage` (`iark.projects.backend`). No son secretos.
- El **token**, por omisión, en `sessionStorage`: solo esa pestaña, y se olvida al cerrarla (si el servidor pide token, una pestaña nueva lo pide otra vez). Con la casilla **«Recordar en este equipo»** (desmarcada por omisión) pasa a `localStorage` y sigue ahí hasta que lo borres; **cualquier script que se ejecute en este sitio podría leerlo**, así que márcala solo en un equipo tuyo. Cada token se guarda junto a su dirección y solo se envía a ella, sin cookies.
- Quien decide quién puede leer o escribir es el servidor, no la página.
- Si el servidor deja de aceptar el token, un guardado lo avisa («El servidor no aceptó el token») con un botón para volver a conectar: el texto pendiente no se pierde y se guarda al dar el token bueno, sin recargar.
- Si el token es válido pero su rol no alcanza (un `viewer` que edita), el guardado avisa «Sin permiso para guardar en el servidor», con el botón «Cambiar de token»: el texto pendiente tampoco se pierde y se guarda al dar un token de `editor`, sin recargar. Las lecturas siguen funcionando.

**4. Copiar entre almacenes.** *Copiar a…* en el detalle de un proyecto lo lleva al otro almacén (del navegador al servidor, o al revés) con el archivo único del proyecto (`iark.project/1`): nunca pisa nada —si el nombre ya existe queda «Nombre (2)»— y, si algo falla a mitad, no deja un proyecto a medias. Sin un servidor conocido, el botón lleva al formulario de conexión, que ofrece copiar sin cambiar de almacén.

**5. Límites reales.**

- **No hay trabajo sin conexión.** Un fallo de red al guardar deja el aviso y «Reintentar», y se reintenta solo al volver la conexión o el foco, pero **solo lo que está en memoria**: si cierras la pestaña sin red, se pierde (el navegador avisa antes de cerrar si hay cambios sin enviar). Al cerrar o recargar, un guardado pequeño (hasta 60 KB) sigue su curso con `keepalive`; uno mayor no.
- **No hay tiempo real entre personas.** La lista se vuelve a leer al volver el foco a la ventana y cada 30 s mientras el gestor está abierto o hay un diagrama abierto (con el gestor cerrado y sin diagrama abierto no se consulta nada). Si dos personas guardan el mismo diagrama, el segundo guardado lo detecta (`ifUpdatedAt`) y ofrece «Quedarme con mi versión» o «Cargar la otra»: **no se mezclan cambios**.
- Cada guardado envía el documento entero (el límite del servidor es de 5 MB) y la lista de proyectos incluye todos los diagramas sin su texto: está pensado para carpetas pequeñas o medianas, no para miles de diagramas.
- No se ha probado con la página publicada por https frente a un servidor en `localhost`: algunos navegadores piden permiso o bloquean ese acceso a la red local.

## CLI `iark`

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
iark project  list|create|rename|delete|show|add|get|rename-diagram|remove|copy|export|import|check|trace   # proyectos en una carpeta de trabajo (ver «Proyectos»)
iark auth     create|list|revoke   # tokens de acceso de `iark serve --tokens` (ver «Servidor para varias personas»)
iark <módulo> <comando>   # comandos propios de cada módulo (p. ej. `iark integration catalog`)
```

`generate`, `import`, `convert`, `validate`, `schema`, `prompt` y `diff` aceptan `--module <id>` para trabajar con cualquier módulo de la suite (por defecto `c4`); `iark modules` lista los instalados y sus formatos de importación y exportación. Además de Mermaid, cada módulo puede importar formatos propios (`--format <id>`, o `auto` para deducirlo de la extensión y del contenido): Terraform y Kubernetes en plataforma, DDL de SQL y dbt en datos y ArchiMate en empresarial (ver cada módulo). Es `--format`, no `--from`: `--from` solo existe en `generate` y `prompt`.

### Comparar versiones de un diagrama (`iark diff`)

`iark diff` dice qué cambió entre dos versiones de un documento de **cualquier módulo**: lo añadido, lo quitado y lo modificado, con cada campo antes → después.

```bash
iark diff  antes.json despues.json --module data                  # dos archivos
iark diff  empresa.json --module enterprise --rev HEAD~1          # el archivo en esa revisión de git contra la copia de trabajo (rama, etiqueta o commit)
iark diff  banca.json --rev main --format markdown >> cambios.md  # Markdown para pegar en una PR o un changelog (también `json`)
iark diff  antes.json despues.json --exit-code                    # sale con 1 si hay cambios, como `git diff --exit-code`
```

Los elementos se emparejan por `id` (o por `name`, o por similitud si la lista no tiene ids); el resto se compara campo a campo, así que un cambio de nombre sale como una modificación y no como un borrado más un alta. **No cuenta como cambio** la maquetación que guarda el autolayout de C4 (coordenadas, tamaños, rutas y opciones de layout de las vistas; qué elementos muestra cada vista sí cuenta) ni el orden de las listas: un reordenamiento sale aparte («N reordenados»). Donde el orden sí es parte del significado el módulo lo declara (`DomainModule.diff.ordered`: pasos de un flujo de integración, etapas de un pipeline de plataforma, etapas de un flujo de valor) y ahí cambiarlo es una modificación. Cada entrada se valida con el esquema del módulo (código de salida 2 si alguna no lo cumple) y acepta lo mismo que `validate` y `convert`: JSON del módulo, `-` para la entrada estándar y cualquier fuente que el módulo importe (`.drawio`, `.dsl`, `.mmd`…). El servicio HTTP lo expone como `POST /api/<módulo>/diff` con `{ before, after }`, y el banco de trabajo tiene la pestaña «Comparar» (ver «Suite web»).

### Dibujar desde un repositorio (`--from-repo`)

`iark generate … --from-repo <carpeta|url>` y `iark prompt … --from-repo <carpeta|url>` dibujan la arquitectura leyendo un repositorio: una **carpeta local** o la **URL de git**. Se combinan con `--module` (cualquier módulo) y con `--from` (refinar un documento existente).

```bash
iark generate "Dibuja la arquitectura" --from-repo ./mi-proyecto --json arq.json            # carpeta local
iark generate "Dibuja la arquitectura" --from-repo https://github.com/org/repo.git --repo-ref v2.1 --module platform
iark generate "Solo el servicio de pedidos" --from-repo ./mono --repo-include 'services/pedidos/' --repo-exclude '**/*.test.ts'
iark generate "…" --from-repo ./mi-proyecto --dry-run        # imprime lo que se enviaría (y qué se omite y por qué), sin modelo ni clave
iark prompt   "…" --from-repo ./mi-proyecto                  # el mismo resumen dentro de un prompt para pegar donde quieras
```

- **Qué lee**: solo una lista blanca de lo que revela la arquitectura (README y docs, diagramas existentes, manifiestos, Dockerfile y compose, contratos OpenAPI/AsyncAPI/proto/GraphQL, Kubernetes/Helm/Terraform/CloudFormation, DDL y migraciones, puntos de entrada, CI y los *nombres* de un `.env.example`); lo demás llega como árbol de carpetas y rutas, nunca su contenido. Presupuesto estricto con `--repo-budget <kb>` (60 por defecto, de 1 a 1024).
- **Privacidad**: nunca se leen `.env*`, claves y certificados privados, `.npmrc`/`.netrc`, `*.tfstate`/`*.tfvars` ni los Secret de Kubernetes; todo el texto incluido pasa por una redacción de patrones de secretos antes de recortar y otra vez sobre el resumen; no se ejecuta nada del repositorio ni se siguen enlaces simbólicos; el contenido va al modelo como datos, no como instrucciones. `--dry-run` y `prompt` enseñan exactamente qué se enviaría antes de enviar nada.
- **URL de git** (`https://`, `ssh://` o `git@host:grupo/repo.git`; `--repo-ref <rama|etiqueta>`): se ejecuta solo `git clone` (sin shell, superficial, sin submódulos ni hooks, con 120 s de margen) a un directorio temporal que se borra siempre, también si falla o lo interrumpes; después no se ejecuta nada del clon. Se rechazan `http://`, `git://`, `file://`, las URL con usuario o token dentro y los valores que empiezan por «-»; un repositorio privado usa las credenciales que ya tengas en git y en ssh (IArk no las lee ni las guarda y git no pregunta contraseñas). En un clon no se aplica el `.gitignore` (solo trae lo versionado).
- **Filtros** (`--repo-include <glob>` y `--repo-exclude <glob>`, repetibles, en formato `.gitignore` y relativos a la raíz): `--repo-exclude` quita lo que cuadre de todo el resumen (árbol, componentes y contenido) y `--repo-include` limita el *contenido* a los archivos clave que cuadren (el árbol sigue entero); si ambos cuadran gana `--repo-exclude`. Solo reducen: nunca hacen legible lo que la lista de secretos prohíbe.
- Es solo del CLI: el servicio `iark serve` no lo expone, porque leería el disco del servidor.

En desarrollo: `npm run cli -- <comando>`; tras `npm run build`: `node dist/cli/index.js` o `npx iark` si el paquete está instalado.

### Generar diagramas con IA (Claude)

```bash
export ANTHROPIC_API_KEY=…   # o `ant auth login`
npx iark generate "Sistema de banca en línea con app web (React), API (Node.js), base de datos PostgreSQL y una pasarela de pagos externa. Los clientes consultan saldos y hacen pagos." \
  --out banca.drawio --json banca.json
```

Flujo: la instrucción se envía a Claude (`claude-opus-5` por defecto) con **salida estructurada** contra el esquema del modelo *sin coordenadas*; el resultado se valida (referencias, jerarquía C4) con un reintento automático si hay errores; después se aplica **autolayout** a todas las vistas y se escriben el JSON y el `.drawio`. Con `--from base.json` la instrucción se trata como un refinamiento del documento existente ("agrega una cola Kafka entre la API y las notificaciones"), conservando los ids y posiciones ya fijados.

#### Con Microsoft (Azure) Foundry: Claude u otros modelos

`generate` funciona con dos tipos de despliegue de Foundry; la plataforma se detecta por la URL, o se fuerza con `--provider`. Guarda las variables como secretos del entorno, nunca en el repositorio.

**Cualquier modelo de Foundry** (DeepSeek, Llama, Mistral, GPT…, `--provider openai`): usa el endpoint compatible con OpenAI del recurso.

```bash
export AI_BASE_URL=https://<recurso>.openai.azure.com/openai/v1    # también vale ANTHROPIC_FOUNDRY_BASE_URL
export AI_API_KEY=…                                                # o ANTHROPIC_FOUNDRY_API_KEY
export AI_MODEL=<nombre-de-tu-despliegue>                          # o ANTHROPIC_FOUNDRY_MODEL
npx iark generate "Una tienda en línea con web, API y base de datos" --json tienda.json --out tienda.drawio
```

No todos los modelos garantizan el esquema, así que el JSON Schema va también en el prompt, se pide `json_schema` (o `json_object`, o nada si el modelo no lo admite) y la respuesta se valida con zod; si es ilegible o incumple el esquema se reintenta con el error. Se descartan los bloques `<think>…</think>` de los modelos de razonamiento. La calidad del diagrama depende del modelo.

**Claude en Foundry** (`--provider foundry`): protocolo de mensajes de Anthropic, con salida estructurada garantizada.

```bash
export ANTHROPIC_FOUNDRY_API_KEY=…
export ANTHROPIC_FOUNDRY_BASE_URL=https://<recurso>.services.ai.azure.com/anthropic/   # o ANTHROPIC_FOUNDRY_RESOURCE=<recurso>
export ANTHROPIC_FOUNDRY_MODEL=<nombre-de-tu-despliegue-de-claude>
```

En Foundry no se envían los *fallbacks* del servidor (solo existen en la API de Anthropic).

### Sin clave de API: cualquier IA o agente

`iark prompt` imprime un prompt autocontenido (reglas C4 + JSON Schema + instrucción). Pégalo en el asistente que prefieras (o deja que un agente como Claude Code lo ejecute) y tuberiza la respuesta:

```bash
npx iark prompt "Plataforma de reservas de hotel con app móvil, backend y pagos" > prompt.txt
# … la IA responde con un JSON (se acepta envuelto en ```json) …
cat respuesta.json | npx iark layout --stdin --out reservas.json
npx iark convert reservas.json --out reservas.drawio
```

La pestaña **IA** del editor web hace lo mismo sin llamar a ningún servicio: "Copiar prompt para IA" y "Pegar JSON generado" (valida, aplica autolayout y carga o fusiona el modelo).

### Uso programático

```ts
import { generateDocument, autoLayoutDocument, toDrawio, fromDrawio, fromStructurizrDsl, validateDocument, deriveView } from 'iark-diagrams/core';

const { document } = await generateDocument({ instruction: 'Un sistema de tickets…' }); // Claude + autolayout
const laid = await autoLayoutDocument(validateDocument(json).document, { direction: 'RIGHT', force: true });
const xml = toDrawio(laid, { locale: 'en' });
const { document: imported, warnings } = await fromDrawio(xml, { name: 'Tickets' }); // .drawio → documento C4 (lanza DrawioImportError si no es utilizable)
const fromDsl = fromStructurizrDsl(dslText, { resolveInclude });                       // DSL de Structurizr → documento C4 (lanza DslImportError, con la línea)
```

`core` no depende del DOM: funciona en Node y en el navegador. `fromStructurizrDsl` es síncrono y solo lee otros archivos si le das un `resolveInclude`. `fromDrawio` descomprime las páginas comprimidas con `DecompressionStream` (Node 20.12+ y los navegadores actuales); un archivo sin comprimir no lo necesita.

## Embebido en otra aplicación (iframe + postMessage)

Abre la app con `?embed=1&proto=json[&origin=https://mi-host][&theme=dark][&ui=min][&configure=1]` dentro de un `<iframe>`. El protocolo sigue el patrón de draw.io: el iframe emite `init`, el anfitrión responde `load`, y a partir de ahí intercambian mensajes JSON (objeto o cadena).

**iframe → anfitrión (`event`)**

| `event` | Cuándo | Carga útil |
|---|---|---|
| `init` | la app está lista | `{ version }` |
| `configure` | antes de `init`, si se abrió con `&configure=1` | — |
| `load` | documento cargado | `{ document, viewId }` |
| `change` / `autosave` | cada cambio (500 ms de throttle); `autosave` solo si `load.autosave = true` | `{ document }` |
| `save` | Guardar / Guardar y salir | `{ document, drawio, exit }` |
| `export` | respuesta a `action: export` | `{ format, data, viewId, requestId }` |
| `autoLayout` | tras un autolayout pedido por el anfitrión | `{ viewId, direction }` |
| `viewChange` | el usuario (o `setView`) cambió de vista | `{ viewId, level: 'C1' \| 'C2' \| 'C3', scopeId, title }` |
| `exit` | salir | `{ modified }` |
| `error` | documento inválido, acción desconocida… | `{ message, issues?, requestId? }` |

**anfitrión → iframe (`action`)**

| `action` | Parámetros |
|---|---|
| `load` | `document?` (objeto o JSON), `autosave?`, `title?`, `readOnly?`, `theme?`, `viewId?`, `autoLayout?` |
| `configure` | `theme?`, `ui?: 'full' \| 'min'`, `hideSidePanel?` |
| `merge` | `document`, `autoLayout?` — fusiona elementos/relaciones/vistas y relanza el autolayout |
| `export` | `format: 'json' \| 'drawio'` (`svg`/`png` responden `error` por ahora), `notation?: 'c4' \| 'card'`, `viewId?`, `requestId?` |
| `autoLayout` | `viewId?`, `direction?: 'auto' \| 'DOWN' \| 'RIGHT' \| 'LEFT' \| 'UP'`, `distribution?: 'auto' \| 'centered' \| 'elk'`, `force?` |
| `setView` | `viewId` |
| `status` | `message`, `modified?` — texto en la cabecera |
| `dialog` | `title`, `message`, `button?` |
| `save` | `exit?` — fuerza la emisión de `save` |
| `exit` | — |

Seguridad: solo se atienden mensajes cuyo `source` es `window.parent`; con `&origin=` se exige además ese `event.origin` y se usa como `targetOrigin` de las respuestas (sin él se usa `*`, solo recomendable en desarrollo). Los documentos recibidos se validan con el mismo esquema zod del núcleo.

### SDK de anfitrión

```html
<div id="editor" style="height: 100vh"></div>
<script type="module">
  import { createIarkEmbed } from 'iark-diagrams/embed'; // o dist/embed/iark-embed.global.js → window.IArkEmbed
  const embed = createIarkEmbed({
    container: '#editor',
    url: 'https://mi-servidor/diagramador/',
    document: miDocumento,          // opcional; sin coordenadas ⇒ autolayout
    autosave: true,
    theme: 'dark',
    onSave: ({ document, drawio, exit }) => guardar(document, drawio),
    onChange: (document) => console.log('cambió', document),
    onExit: () => cerrarModal(),
  });
  await embed.ready;
  const xml = await embed.export('drawio');
  embed.autoLayout({ direction: 'RIGHT' });
  embed.merge(otroFragmento);
  embed.setView('contenedores');
  embed.destroy();
</script>
```

Demo completa: [`examples/embed-host.html`](examples/embed-host.html) (en desarrollo: `http://localhost:5173/examples/embed-host.html`; tras `npm run build` queda en `dist/app/examples/embed-host.html`).

## Suite web: banco de trabajo, widget, shell y servicio

Los cinco módulos nuevos comparten una interfaz genérica que se genera a partir del contrato `DomainModule` (esquema, vistas, exportadores, informes…), de modo que un módulo nuevo aparece en la web sin escribir pantallas. Cada módulo se carga bajo demanda (`import()` dinámico), así que el editor C4 no paga su peso.

| Superficie | Dónde | Para qué |
|---|---|---|
| Banco de trabajo | `modulos.html?module=security` | Editar el JSON del módulo con validación en vivo (esquema + reglas del dominio), ver las vistas y las vistas de traza, exportar (Mermaid con su vista previa dibujada, SVG, draw.io), importar (Mermaid y los formatos propios de cada módulo, también con «Abrir archivo…»; los avisos de la última importación se ven en la pestaña «Importar (N)» sea cual sea la vía y se quitan al editar el documento), ejecutar informes y conversiones (`from-integration`…) y **comparar** con otra versión del documento (pestaña «Comparar (N)»: «Abrir archivo a comparar…» o pegar su JSON; lista lo añadido, quitado y modificado con cada campo antes → después, y en el lienzo marca los nodos con **Nuevo** o **Modificado**, las aristas con un halo y dibuja lo quitado como un fantasma punteado con **Quitado**; hacer clic en un cambio selecciona y encuadra el elemento; en el módulo C4 el lienzo es un iframe y no se resalta dentro, pero el panel sí funciona). El borrador se guarda en el navegador (no en modo embebido). |
| Widget embebible | `modulos.html?embed=1&proto=json&origin=…` | Mismo banco de trabajo dentro de un `<iframe>`, con un protocolo `postMessage` propio (`src/embed/moduleProtocol.ts`). |
| Trazabilidad | `trazabilidad.html` | Vista transversal: enlaces `urn:iark:…` entre los documentos de varios módulos, referencias sin resolver y alcance de un elemento (ver «Trazabilidad entre módulos»). |
| Shell de la suite | `suite.html` | Descubre los módulos de una instancia leyendo su manifiesto y monta el editor C4 o el widget del módulo elegido. Acepta una URL de manifiesto de otra instancia. |
| Servicio HTTP | `iark serve` | La misma API para todos los módulos y el sitio estático, en un proceso Node sin dependencias. |

### Protocolo de módulos y SDK

Es el protocolo del editor C4 con dos añadidos: el `init` lleva el `capabilities` de la instancia (módulos, formatos, informes y vistas de traza) y las acciones/eventos llevan un `requestId` para correlacionar las respuestas. El origen del anfitrión es `?origin`, o el del `referrer`, o el propio; los mensajes nunca se envían a `*`.

- **Acciones** (anfitrión → iframe): `load` (con `module`, `document` o texto con `importer`, `viewId`, `autosave`, `readOnly`), `configure` (`theme`, `ui: 'full' | 'min'`), `setView`, `export`, `validate`, `run` (informe o conversión), `capabilities`, `status`, `dialog`, `save`, `exit`.
- **Eventos** (iframe → anfitrión): `init`, `configure`, `load`, `change`, `autosave`, `issues`, `viewChange`, `export`, `result`, `capabilities`, `save`, `exit`, `error`.
- **`ui=min`** oculta la marca y las pestañas de módulos pero conserva las acciones.

```js
import { createIarkModuleEmbed } from 'iark-diagrams/embed'; // o dist/embed/iark-embed.global.js → window.IArkEmbed.createIarkModuleEmbed
const embed = createIarkModuleEmbed({
  container: '#panel',
  url: 'https://mi-servidor/diagramador/modulos.html', // o el `endpoints.embed` del manifiesto
  module: 'security',
  document: miDocumento,
  autosave: true,
  onChange: ({ document, issues }) => guardar(document),
});
const capacidades = await embed.initialized;
await embed.ready;
const svg = await embed.export('svg', 'dfd');
const { output } = await embed.run('risks', { options: { status: 'open' } });
```

Las acciones que esperan respuesta (`load`, `export`, `validate`, `run`, `capabilities`) devuelven una promesa y se rechazan con el mensaje de `error`, o por tiempo (15 s, configurable). Las que se lanzan antes del `init` se encolan. Demo: [`examples/modules-host.html`](examples/modules-host.html).

### Web Component `<iark-module>`

```html
<script type="module" src="https://mi-servidor/diagramador/embed/iark-module-element.js"></script>
<iark-module manifest="https://mi-servidor/diagramador/.well-known/iark.json" module="security" theme="dark" ui="min" style="height: 520px"></iark-module>
<script>document.querySelector('iark-module').document = miDocumento;</script>
```

Atributos: `manifest` (descubre el editor del módulo en la instancia) o `src` (URL directa de `modulos.html`), `module`, `theme`, `ui`, `readonly`, `autosave`, `view`. El documento va por la propiedad `document` (objeto o JSON). Eventos DOM: `iark-init`, `iark-load`, `iark-change`, `iark-view-change`, `iark-save`, `iark-exit`, `iark-error`, `iark-result`. Métodos: `export`, `run`, `validate`, `capabilities`, `setView`, `save`; esperan a que el widget esté listo. Demo: [`examples/web-component-host.html`](examples/web-component-host.html). Se empaqueta como `dist/embed/iark-module-element.{js,global.js}` y como el subpath `iark-diagrams/element`.

### Federación por manifiesto

Cada instancia publica `/.well-known/iark.json` (esquema `iark.manifest/1`): módulos, versiones, formatos y **endpoints relativos** al manifiesto (`embed`, `schema`, `api`). El sitio estático lo incluye junto con los JSON Schema de cada módulo (`npm run manifest` lo regenera; una prueba comprueba que no se desincroniza), y `iark serve` lo genera al vuelo con la URL de su API. El shell y el Web Component solo dependen de ese manifiesto, no del código de los módulos.

### Servicio HTTP (`iark serve`)

```bash
npm run build
node dist/cli/index.js serve --static dist/app --port 8787      # o: docker build -t iark-diagrams . && docker run --rm -p 8787:8787 iark-diagrams
curl localhost:8787/api/modules
curl -X POST localhost:8787/api/security/validate -d @examples/seguridad-ejemplo.json
curl -X POST 'localhost:8787/api/security/export?format=svg&view=dfd' -d @examples/seguridad-ejemplo.json > dfd.svg
```

| Ruta | Descripción |
|---|---|
| `GET /.well-known/iark.json` · `GET /api/modules` | Manifiesto de la instancia y capacidades de los módulos |
| `GET /api/<módulo>/capabilities` · `/schema[?kind=generation]` | Formatos, informes, vistas de traza; JSON Schema del documento o de la salida de IA |
| `POST /api/<módulo>/validate` · `/views` · `/export?format=&view=` | Cuerpo: el documento JSON |
| `POST /api/<módulo>/import?importer=&name=` | Cuerpo: texto (Mermaid, Terraform, Kubernetes, DDL, dbt, ArchiMate según el módulo) → documento y avisos |
| `POST /api/<módulo>/diff` | Cuerpo `{ before, after }` (dos documentos del módulo) → lo añadido, quitado, modificado y reordenado |
| `POST /api/<módulo>/run/<comando>` | Cuerpo `{ input?, args?, options? }` → informe o conversión |
| `POST /api/trace` | Cuerpo `{ documents: [{ module, document }], from?, direction?, depth? }` → grafo de trazabilidad |

Con `--workspace <carpeta>` añade además la API de proyectos (`/api/projects…`, con sus propias reglas de seguridad: ver «API HTTP de proyectos»); con `--tokens <archivo>` exige un token con rol en esa API y puede escuchar fuera de loopback (ver «Servidor para varias personas (nube autoalojada)»); sin ella, el servicio no guarda estado. Sin dependencias (`node:http`). Sin `--cors` solo responde al mismo origen; `--cors https://mi-app.example` (o `*`) abre la API a un navegador de otro origen. El cuerpo máximo es de 5 MB. La generación con IA sigue viviendo solo en el CLI.

#### Imagen Docker

El `Dockerfile` (dos etapas sobre `node:22-alpine`) compila la biblioteca, el CLI y el sitio, deja solo las dependencias de producción y arranca `iark serve --host 0.0.0.0 --port $PORT --static dist/app` (`PORT` vale 8787 por defecto) como el usuario `node` (no root). La imagen pesa unos 210 MB (la base de Node, unos 165 MB; `node_modules`, 28 MB; el sitio, 9 MB; el CLI, 3 MB) y sin variables no guarda estado (la demo); lo que guarda el servicio gestionado va a `/data`. Pesaba 355 MB mientras el frontend (react, Semi UI, xyflow, zustand…) estaba en `dependencies`: Vite ya lo empaqueta en `dist/app`, así que ahora es `devDependencies` y `npm prune --omit=dev` lo descarta; el paquete npm tampoco lo arrastra a quien lo instala (22 paquetes y 52 MB en vez de 209 y 271 MB).

```bash
docker build -t iark-diagrams .
docker run --rm -p 8787:8787 iark-diagrams                                   # editor, banco de trabajo, shell y API en http://localhost:8787
docker run --rm -p 9000:8787 iark-diagrams --cors https://mi-app.example    # otro puerto del anfitrión y la API abierta a ese origen
docker run --rm -e PORT=9100 -p 9000:9100 iark-diagrams                      # otro puerto de dentro (el HEALTHCHECK lo sigue)
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -p 8787:8787 iark-diagrams   # endurecida: no escribe en disco
```

- Los argumentos tras el nombre de la imagen se añaden al `ENTRYPOINT` (`--cors`, `--static`…); si repites una opción, gana la última. Para cambiar el puerto de publicación basta `-p`. El puerto de dentro sale de la variable `PORT` (8787 por defecto), que usan igual el servidor y el `HEALTHCHECK` (consulta `/api/modules`): cámbialo con `-e PORT=9100`, no con `--port` (el servidor escucharía en otro puerto que el `HEALTHCHECK` no mira y el contenedor acabaría `unhealthy`; si aun así lo haces, sobrescribe el chequeo con `--health-cmd` o `--no-healthcheck`).
- Para guardar proyectos y compartirlos entre personas (volúmenes, tokens, HTTPS), ver «Servidor para varias personas (nube autoalojada)»: la imagen escucha en `0.0.0.0`, así que con `IARK_WORKSPACE` y sin autenticación (`IARK_TOKENS` o el inicio de sesión de GitHub, `IARK_ACCOUNTS`…) se niega a arrancar; por eso la imagen no fija `IARK_WORKSPACE`. Para el servicio con inicio de sesión de GitHub, ver «Servicio gestionado» y la [guía de despliegue](docs/despliegue-nube.md).
- La carpeta `/data` de la imagen es del usuario `node` (1000:1000): un volumen con nombre la hereda; en un bind mount, la carpeta del anfitrión debe ser de `1000:1000`. Si una plataforma monta el disco con dueño root y no deja cambiarlo, `docker build --build-arg IARK_RUN_AS=root` construye la imagen para correr como root (último recurso).
- El `HEALTHCHECK` sirve igual con la autenticación activada (`/api/modules` es público).
- El contenedor pasa a `healthy` en unos segundos (`docker inspect --format '{{.State.Health.Status}}' <contenedor>`) y `docker stop` lo detiene en menos de un segundo con código 0: `iark serve` cierra el servidor al recibir `SIGTERM`, sin necesidad de `--init`.
- Probado con Docker 29 (`docker build`, `docker run --network host` y `docker run -p` con red de puente e iptables, incluida la variante endurecida y `-e PORT` con otro `-p`): `/`, `/modulos.html?module=data`, `/suite.html`, `/trazabilidad.html`, `/.well-known/iark.json`, `/api/modules`, validar y exportar (SVG, Mermaid y draw.io) un ejemplo de cada módulo, importar Mermaid, `run/<comando>` y `POST /api/trace`.
- Servicio gestionado, probado con Docker 29 (`npm run docker:smoke`, ver «Pruebas»; y `deploy/docker-compose.yml` levantado de verdad con Compose 5, con el HTTPS interno de Caddy sobre `localhost`, no con un certificado público): demo sin variables, negativa a arrancar sin autenticación, inicio de sesión completo contra un GitHub de mentira, un proyecto en el volumen `/data`, la sesión y el proyecto tras `docker restart` y tras sustituir el contenedor, corriendo como `node` con el sistema de archivos de solo lectura y sin capacidades, volumen con nombre y bind mount, secreto por archivo, copia y restauración, y que ni el secreto ni las sesiones salgan en `docker logs`.

## Estructura del proyecto

Monorepo con workspaces de npm. Los paquetes internos se consumen desde su código fuente; `npm run build` los empaqueta dentro de `dist/`.

```
packages/kernel/       @iark/kernel: contrato de módulo (DomainModule), registro, URN, manifiesto de federación, IA estructurada, sintaxis Mermaid (flowchart, sequence, erDiagram) y layout/SVG de grafos genéricos
packages/domain-c4/    @iark/domain-c4: módulo `c4` (modelo, esquema zod, vistas, autolayout ELK, import/export draw.io, Structurizr y Mermaid, prompts de IA; sin DOM)
packages/domain-integration/  @iark/domain-integration: módulo `integration` (nodos, contratos, interacciones y flujos; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-data/  @iark/domain-data: módulo `data` (activos, dominios, pipelines y linaje, modelo entidad-relación y gobierno del dato; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-enterprise/  @iark/domain-enterprise: módulo `enterprise` (capacidades, procesos, aplicaciones y tecnología con ciclo de vida; mapa de capacidades, paisaje, impacto y obsolescencia; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-platform/  @iark/domain-platform: módulo `platform` (entornos, redes, recursos, servicios, despliegues, dependencias y pipelines; topología, despliegue por entorno, entrega continua e impacto; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-security/  @iark/domain-security: módulo `security` (zonas de confianza, activos, flujos de datos, amenazas STRIDE y controles; diagrama de flujo de datos, modelo de amenazas, riesgos y superficie de ataque; import Mermaid, export Mermaid/SVG/draw.io, IA)
src/cli/               comandos de iark (commander): módulos, `trace`, `project` (con el almacén en carpeta `workspace.ts`), `auth` (tokens: `tokens.ts`), `serve` (y su API de proyectos, con la autenticación de `serveAuth.ts`); carga los módulos del registro
src/embed/             protocolo postMessage (C4 y de módulos), SDK de anfitrión y Web Component <iark-module>
src/projects/          proyectos guardados en la app web: almacén en IndexedDB y almacén remoto (servidor), su configuración, la sesión con autoguardado y el gestor
src/modules-app/       banco de trabajo genérico de módulos (controlador sin React, editor, protocolo del puente)
src/shell/             shell de la suite (descubrimiento por manifiesto)
src/trace-app/         vista web de trazabilidad entre módulos (tablero sin DOM + página)
src/app/               editor React (Vite, React Flow, Semi UI, Tailwind)
schema/                JSON Schema del documento y del formato de generación
examples/              documentos de ejemplo por módulo y páginas anfitrionas de demostración
public/.well-known/    manifiesto de federación publicado con el sitio (iark.json)
Dockerfile             imagen del servicio (`iark serve` + sitio)
deploy/                despliegue de la nube gestionada: docker-compose.yml (IArk + Caddy con HTTPS), Caddyfile, .env.example y secrets/ (ignorada por git)
docs/despliegue-nube.md  guía de despliegue de la nube de proyectos con inicio de sesión de GitHub
docs/roadmap.md        hoja de ruta de la suite (integraciones, datos, empresarial, plataforma…)
tests/e2e/             pruebas Playwright
```

`iark modules` lista los módulos instalados y `iark modules --json` emite su manifiesto (`iark.manifest/1`), que es la base de la federación. Cada especialidad nueva es un paquete `@iark/domain-*` que implementa `DomainModule` y se registra en `src/cli/registry.ts`.

## Decisiones de diseño

- **Modelo compartido + vistas** (como Structurizr): renombrar un contenedor lo actualiza en todas las vistas; cada vista es una página del `.drawio`.
- **La IA nunca produce coordenadas**: produce el modelo; ELK produce la geometría. Esto hace la generación robusta y el autolayout la pieza central del sistema.
- **ELK `layered` con `hierarchyHandling: INCLUDE_CHILDREN`** porque es el único motor JS que trata los boundaries como nodos compuestos.
- **Semi UI + Tailwind 4** son las mismas librerías que usa drawdb, lo que permite reproducir su estética (tabs tipo card, cards colapsables, grid de puntos, tarjetas con franja de color).
- **Las librerías del frontend son `devDependencies`**: react, Semi UI, xyflow, zustand y zundo solo las usa el sitio, que Vite empaqueta entero en `dist/app`. `dependencies` se limita a lo que el paquete publicado y la imagen Docker necesitan en ejecución (`dist/core`, `dist/cli` y los dos bundles de `dist/embed`, que no importan nada de ellas): `commander`, `elkjs`, `fast-xml-parser`, `nanoid`, `yaml`, `zod` y los SDK de Anthropic. `tests/runtime-deps.test.ts` lo vigila: construye las cuatro salidas con tsup y falla si alguna importa (o incrusta, porque tsup solo externaliza `dependencies`) algo que no esté declarado como dependencia de ejecución.
- **Niveles como vistas tipadas sobre un modelo único**, no diagramas independientes: así C1, C2 y C3 se mantienen coherentes entre sí y la navegación (doble clic, breadcrumb, enlaces de página en draw.io) se deriva de la relación vista ↔ alcance sin datos adicionales.

## Prueba real de `generate`

La generación con IA está cubierta por pruebas con clientes simulados (`src/core/ai/*.test.ts`) y, además, se ejecutó
contra un servicio real. Estado por proveedor:

| Proveedor | Estado |
|---|---|
| **Foundry, cualquier modelo** (`--provider openai`) | **Probado** con DeepSeek‑V4‑Pro (28‑09‑2026): un intento, JSON válido, 6 elementos, 4 relaciones y 2 vistas; `validate --strict` sin errores ni avisos, todas las vistas con coordenadas y el `.drawio` con una página por vista. Variables usadas: `AI_API_KEY`, `AI_BASE_URL` y `AI_MODEL` (también valen las `ANTHROPIC_FOUNDRY_*`). |
| **Claude en Foundry** (`--provider foundry`) | **Sin probar**: requiere un despliegue de Claude en el recurso, `ANTHROPIC_FOUNDRY_BASE_URL` (`https://<recurso>.services.ai.azure.com/anthropic/`) o `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY` y `ANTHROPIC_FOUNDRY_MODEL` con el nombre de ese despliegue. |
| **API de Anthropic** | **Sin probar**: requiere `ANTHROPIC_API_KEY` con créditos (la suscripción de Claude.ai no incluye acceso a la API). |

La prueba real destapó un defecto que las pruebas con clientes simulados no veían: la vista de contexto salía **sin su
propio sistema** (y por tanto sin aristas) porque `generatedToDocument` descartaba el `scopeId` en todas las vistas
y ningún validador lo exigía. Ahora solo se descarta en contenedores/componentes, y `validateDocument` rechaza una vista
`systemContext` que no incluya su alcance (lo que dispara el reintento con el error), con el mismo aviso en el panel de
problemas y en `validate --strict`.

Para repetir la prueba con otro proveedor o modelo:

```bash
npm run cli -- generate "Sistema de banca en línea con app web (React), API (Node.js), PostgreSQL y una pasarela de pagos externa" \
  --json examples/banca-ia.generated.json --out examples/banca-ia.generated.drawio
npm run cli -- validate examples/banca-ia.generated.json --strict
```

y comprobar que `validate` no reporta errores, que todas las vistas tienen coordenadas y que el `.drawio` abre en
draw.io con una página por vista (la vista de contexto debe llevar el sistema y sus relaciones). Los archivos
`*.generated.*` están ignorados por git. Si el endpoint rechaza algo (formato de respuesta, parámetros de tokens,
autenticación), el ajuste va en `src/core/ai/openaiCompat.ts`. Las credenciales van siempre en los ajustes del entorno
(*Environment variables* / *API credentials*), nunca en el chat, en el código ni en git (`.gitignore` excluye `.env*`).

## Fuera de alcance (v1)

Servidor MCP, exportación PNG/SVG desde el modo embebido, vistas de despliegue/código, colaboración en tiempo real, importar `.drawio` o DSL desde el modo embebido (el anfitrión puede usar `fromDrawio` / `fromStructurizrDsl` del núcleo), exportar a DSL de Structurizr.
