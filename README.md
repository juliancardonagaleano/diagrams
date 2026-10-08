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

## Conversión a `.drawio`

Cada vista se convierte en una página de draw.io. Los elementos se envuelven en `<object placeholders="1" c4Name=… c4Type=… c4Description=… c4Technology=…>` con los estilos de la librería C4 (`shape=mxgraph.c4.person2`, `cylinder3` para bases de datos, boundary punteado, relaciones ortogonales). Los hijos de un boundary cuelgan de su celda con geometría relativa, tal como los crea draw.io. El archivo se escribe sin comprimir, así que draw.io / diagrams.net lo abre directamente y se puede versionar en git.

```bash
npx iark convert examples/banca.json --out banca.drawio          # aplica autolayout si faltan coordenadas
npx iark convert examples/banca.json --locale en --view contexto  # etiquetas de tipo en inglés, una sola vista
npx iark convert examples/banca.json --notation card --out banca-tarjetas.drawio  # tarjetas estilo drawdb
```

Dos **notaciones** de figuras (`--notation`, menú Archivo o `toDrawio(doc, { notation })`):

- `c4` (por defecto): librería C4 oficial de draw.io (persona, sistema, contenedor, componente, cilindro).
- `card`: tarjetas estilo drawdb (rectángulo claro con franja del color C4, nombre, `[Tipo: tecnología]` y descripción); las bases de datos y colas conservan el cilindro con relleno claro.

Los archivos [`examples/banca-c4.drawio`](examples/banca-c4.drawio) y [`examples/banca-tarjetas.drawio`](examples/banca-tarjetas.drawio) son el ejemplo de banca exportado en cada notación (3 páginas, enlaces entre niveles y waypoints del autolayout).

## Importar un `.drawio`

Un diagrama de draw.io se puede convertir en un documento C4 (cada **página** pasa a ser una **vista**), tanto en la web (**Archivo ▸ Importar .drawio…**, pide confirmación si hay cambios sin guardar) como en el CLI (`iark import` deduce el formato de la extensión o del contenido; también hay un [DSL de Structurizr](#importar-un-dsl-de-structurizr)):

```bash
npx iark import examples/banca-c4.drawio --out banca.json     # el nombre del diagrama sale del archivo (o --name)
npx iark import diagrama.drawio | npx iark layout --stdin --force > reordenado.json   # descartando las posiciones
cat diagrama.drawio | npx iark import --stdin
```

En el CLI lo importado va a stdout (o a `--out`) y el resumen y los avisos a stderr, así que se puede encadenar con `validate`, `layout` y `convert`. Un archivo que no es de draw.io termina con el código 2 y un motivo de una línea.

Qué reconoce, de más a menos fiel:

- **Un `.drawio` exportado por esta herramienta** (ambas notaciones): recupera los ids, tipos, descripciones, tecnologías, `external`, `shape`, `color`, jerarquía (`parentId`), relaciones, vistas (título, tipo, alcance) y las posiciones y tamaños absolutos. Los ids escritos a propósito (kebab-case, como `web-app` o `r1`) se conservan también en `.drawio` de versiones anteriores de la herramienta o hechos a mano; los aleatorios de draw.io se sustituyen por un id derivado del nombre.
- **La librería C4 de draw.io** (`c4Name`, `c4Type`, `c4Description`, `c4Technology`, en español o inglés): los tipos salen de `c4Type`, "externo" del `c4Type` o del color de relleno, y la jerarquía del boundary que contiene cada forma. Un elemento con el mismo nombre y tipo en varias páginas es un único elemento.
- **Formas sueltas** (sin metadatos): nombre = primera línea del texto, `[Tipo: tecnología]` en una línea aparte fija el tipo y la tecnología, el resto es la descripción; una persona (`umlActor`) o un cilindro (base de datos, o cola si está girado) se reconocen por su forma; y sin más pistas el tipo lo da el anidamiento: sistema › contenedor › componente. Las flechas toman su descripción del texto y `[tecnología]`.
- Se leen las páginas **comprimidas** (el formato por defecto de versiones antiguas de draw.io) y un `<mxGraphModel>` suelto (*Extras ▸ Editar diagrama*).

Cómo se decide cada vista: un boundary de sistema (o de contenedor) que envuelve las formas de la página es su alcance y la vista pasa a ser de contenedores (o de componentes); sin boundary, se usa el enlace `data:page/id,…` de un sistema o contenedor que apunte a la página y, si no, el contenido.

Lo que **no** se importa (siempre se avisa, sin detener la importación): notas de texto suelto, formas sin texto, capas y formas ocultas, flechas sin origen o destino conectados, marcos que solo agrupan personas o sistemas (p. ej. "Empresa"), y las jerarquías que C4 no admite (esa forma se importa sin padre). Además:

- Las **rutas de las flechas** (waypoints) no se importan: la app las recalcula al abrir la vista (o con Autolayout).
- La notación de **tarjetas** no distingue navegador ni móvil (los dibuja como rectángulos), así que esas formas se recuperan sin `shape`.
- No se importan `tags`, `layout` ni la descripción del espacio de trabajo: `.drawio` no los guarda.
- Los `.drawio.svg` / `.drawio.png` (con el XML incrustado) no se leen; expórtalos antes como `.drawio`.

## Importar un DSL de Structurizr

Un modelo escrito en el [DSL de Structurizr](https://docs.structurizr.com/dsl) se importa con el mismo flujo y las mismas garantías que un `.drawio`: en la web con **Archivo ▸ Importar Structurizr DSL…** (pide confirmación si hay cambios sin guardar, deja el diagrama como "sin guardar" y lista los avisos en un modal) y en el CLI con `iark import`, que deduce el formato de la extensión (`.dsl`) o del contenido (`--format dsl|drawio` lo fuerza). Siempre produce un documento válido o un error de una línea (código de salida 2), con el número de línea del DSL cuando el fallo es de sintaxis.

```bash
npx iark import examples/banca.dsl --layout --out banca.json     # --layout coloca con ELK las vistas sin coordenadas
npx iark import examples/banca.dsl --layout | npx iark convert --stdin --out banca.drawio   # DSL → .drawio
```

Un DSL no tiene coordenadas, así que las vistas quedan sin posicionar: la app las coloca sola al abrirlas (o `--layout` en el CLI). [`examples/banca.dsl`](examples/banca.dsl) es el ejemplo de banca escrito en DSL y produce el mismo modelo y las mismas vistas que `examples/banca.json`.

Qué importa:

- **Modelo:** `person`, `softwareSystem`, `container` y `component` con su jerarquía (un contenedor dentro de su sistema, un componente dentro de su contenedor), descripción, tecnología y etiquetas; `group` y `enterprise` solo aportan su contenido.
- **Relaciones:** `origen -> destino "descripción" "tecnología" "etiquetas"`, también dentro de un elemento (`-> otro`, `this -> otro`), con identificador (`r = a -> b`) y adelantadas (pueden apuntar a elementos definidos más abajo).
- **Identificadores** planos y jerárquicos (`!identifiers hierarchical`, con referencias como `sistema.contenedor` o por ámbito); el identificador pasa a ser el `id` del elemento. También `!const`/`!var` con `${NOMBRE}`, comentarios (`#`, `//`, `/* */`), líneas continuadas con `\`, y cadenas `"…"` y `"""…"""`.
- **Vistas:** `systemLandscape`, `systemContext`, `container` y `component`, con su clave, descripción, `title`, `autoLayout tb|bt|lr|rl [separación de rangos] [separación de nodos]` (dirección y separaciones de la vista) y `include`/`exclude` con `*` (los elementos que C4 muestra por defecto en ese nivel), identificadores, `->x->`, `x->`, `->x`, y `element.tag`, `element.type` y `element.parent` (`==` y `!=`). Si el DSL no define vistas se crean las de por defecto (contexto, contenedores y componentes de cada sistema).
- **Estilos** (`styles { element "Etiqueta" { … } }`): `shape cylinder|pipe|webbrowser|mobiledevice…` pasa a la forma del elemento (base de datos, cola, navegador, móvil), `background` a color propio del elemento cuando no es el color estándar de C4, y las etiquetas `External` / `Existing System` (o el gris `#999999`) marcan el elemento como externo.
- **`!include`** de otros archivos en el CLI (relativos al archivo que incluye, con detección de ciclos); solo se leen archivos **dentro del directorio del archivo de entrada** (también siguiendo enlaces simbólicos), así que un DSL de origen desconocido no puede leer nada fuera de su carpeta. En la web y por stdin no hay otros archivos: el `!include` se omite con un aviso.

Qué **no** se importa (siempre se avisa, agrupado por sentencia, sin detener la importación): despliegue (`deploymentEnvironment`, `deploymentNode`…), vistas `dynamic`, `filtered`, `deployment`, `custom` e `image`, `!docs`, `!adrs`, `!ref`, `!script`, `url`, `properties`, `perspectives`, las expresiones de relaciones en `include`/`exclude` (`relationship==…`) y `workspace extends`; y un elemento en un sitio que C4 no admite (un contenedor fuera de un sistema, una persona dentro de uno…) se omite con su contenido. Los temas, la marca (`branding`) y la configuración se ignoran sin avisar, y los estilos de relaciones no se aplican.

## Mermaid

**Importar** (Archivo ▸ Importar Mermaid…, o `iark import diagrama.mmd`). Se admiten:

| Diagrama de Mermaid | Se convierte en |
|---|---|
| `C4Context`, `C4Container`, `C4Component`, `C4Dynamic` | `Person`, `System*`, `Container*`, `Component*` (con `_Ext`, `Db`, `Queue`), `System_Boundary` (sistema) y `Container_Boundary` (contenedor), `Rel`/`BiRel`/`Rel_*`; los `UpdateElementStyle`/`UpdateLayoutConfig` se ignoran |
| `flowchart` / `graph` | nodos y aristas (`-->`, `---`, `-.->`, `==>`, etiquetas `\|texto\|` o `-- texto -->`, cadenas y `A & B`); `subgraph` anidados = sistema › contenedor › componente; `[( )]` = base de datos, `([ ])` = cola |
| `sequenceDiagram` | `actor` = persona, `participant` = sistema, cada mensaje distinto = relación |
| `erDiagram` | entidad = sistema con forma de base de datos (atributos en la descripción), relación con su cardinalidad |

Mermaid no guarda coordenadas ni vistas: se crean las vistas por defecto y el autolayout hace el resto. Lo que no se entiende se lista como aviso. También vale un bloque ```` ```mermaid ```` de un Markdown o un archivo con frontmatter `title:`.

**Exportar** la vista activa (Archivo ▸ Exportar Mermaid, copiar al portapapeles, o `iark convert doc.json --to mermaid --view contenedores [--mermaid-format c4|flowchart]`). `generate --from` y `prompt --from` aceptan también `.drawio`, `.dsl` y `.mmd` como documento base.

**Vista previa** de cómo dibuja Mermaid la vista activa, sin salir de la aplicación: Archivo ▸ Vista previa de Mermaid… en el editor C4 (en C4 nativo o como diagrama de flujo, con el texto exportado a la vista) y, en el banco de trabajo, Exportar ▸ Mermaid ▸ Ver. El dibujo lo hace la librería [`mermaid`](https://mermaid.js.org), que solo se descarga la primera vez que se pide la vista previa (el resto de la aplicación no la carga) y es una dependencia de desarrollo: forma parte del sitio compilado, no del paquete npm ni del CLI. Es una aproximación para pegar en README, GitHub o Confluence; el diagrama definitivo es el del editor. «Tamaño real» permite leer los diagramas grandes con desplazamiento.

## Módulo de integraciones

Segunda especialidad de la suite (`--module integration`): modela **cómo se hablan los sistemas** (APIs, servidores MCP, pasarelas, brokers, colas y tópicos, almacenes, conectores, tareas programadas y usuarios), con sus **contratos editables** (OpenAPI, `.proto` de gRPC, CloudEvents y MCP) y los flujos de extremo a extremo. Vive en `packages/domain-integration` y no depende del código C4: se enlaza con él solo por referencias URN (`urn:iark:c4:<id>`).

Documento JSON (ejemplo completo en [`examples/pedidos-integracion.json`](examples/pedidos-integracion.json), esquema con `iark schema --module integration`):

| Parte | Contenido |
|---|---|
| `nodes` | los doce tipos de la notación (tabla siguiente); opcionales `technology`, `owner`, `external`, `ref` (URN al elemento C4 o de otro módulo), `contractId` (su contrato), `domain` (zona de un equipo o dominio) y, en un nodo `pattern`, el `pattern` EIP que aplica |
| `contracts` | `openapi`, `asyncapi`, `graphql`, `protobuf` (el `.proto` de gRPC), `avro`, `json-schema`, `wsdl`, `cloudevents`, `mcp` u `other`, con `version` y el texto en `content` |
| `interactions` | de un nodo a otro: `style` (`request-response`, `async-message`, `event`, `batch`, `stream`), `protocol`, `pattern` (18 patrones EIP y de resiliencia), `contractId`, `criticality` y `order` (lugar en la secuencia) |
| `flows` | secuencias ordenadas de interacciones (p. ej. «Crear un pedido») |

### Notación EIP

La misma figura en el lienzo, el SVG y el `.drawio` (una sola geometría en `packages/kernel/src/graph/shapes.ts`):

| Tipo | Figura | Lo que modela |
|---|---|---|
| `system` | caja | aplicación o sistema, interno o externo |
| `api` | hexágono | interfaz que expone un sistema (dentro de él) |
| `mcp` | ficha | servidor MCP: herramientas, recursos y prompts para agentes de IA (dentro de un sistema) |
| `gateway` | flecha | pasarela de APIs, ESB o proxy; puede contener colas y tópicos |
| `broker` | barra | plataforma de mensajería; contiene colas y tópicos |
| `queue` | tubo | cola punto a punto |
| `topic` | abanico | tópico de publicación-suscripción |
| `store` | cilindro | base de datos, ficheros o bucket |
| `connector` | caja redondeada | conector o adaptador de canal |
| `scheduler` | reloj | tarea programada (solo dispara) |
| `user` | figura humana | usuario final (solo llama) |
| `pattern` | rombo | patrón EIP como nodo intermedio (traductor, enrutador, agregador…) |

### Contratos: la metadata de las figuras

Cada nodo y cada interacción puede apuntar a un contrato (`contractId`), y el contrato lleva su texto. La pestaña **Contratos** del banco de trabajo es el editor: lista con formato, versión y usos; editor de texto con diagnósticos en vivo que llevan a la línea del problema; **Formatear**, **Plantilla**, conversión JSON ↔ YAML, copiar y descargar con la extensión del formato; resumen del contenido (operaciones, métodos RPC, herramientas…) y «Usado por», que salta a la figura. Desde el panel de propiedades de una figura, «Editar» abre su contrato y «Nuevo contrato» crea uno con el formato que encaja (API → OpenAPI o `.proto` si su tecnología es gRPC, servidor MCP → MCP, tópico o cola → CloudEvents, evento → CloudEvents) y lo deja asignado. La figura muestra el formato y la versión de su contrato como insignia.

| Formato | Qué comprueba | Qué formatea |
|---|---|---|
| CloudEvents (JSON) | `specversion` 1.0, `id`, `source`, `type`, `datacontenttype`, `dataschema`, `time` RFC 3339, `data` / `data_base64` excluyentes, nombres de atributos, también en lotes | **Formateador CloudEvents**: envuelve un payload suelto, completa un envoltorio incompleto y deja la estructura canónica |
| gRPC (`.proto`) | `syntax`, `package`, mensajes (números de campo únicos y en rango), enums proto3, `service` con sus `rpc` y tipos resolubles | reindenta conservando comentarios |
| REST (OpenAPI 3) | `openapi`, `info`, `paths`, respuestas, `operationId` único, parámetros de ruta, `$ref` locales, seguridad | orden canónico, JSON o YAML |
| MCP (JSON) | herramientas con nombre único e `inputSchema` de objeto, `required` dentro de `properties`, recursos con `uri`, prompts con argumentos | orden canónico |
| AsyncAPI, JSON Schema, Avro, GraphQL, WSDL | sintaxis y lo mínimo de cada formato | sangría |

### Patrones, orden y reglas

- **Patrón EIP**: una interacción lleva su patrón como **insignia con el icono del patrón sobre la línea**, o el patrón se dibuja como **nodo intermedio** (rombo) al estilo de los libros de EIP. No son redundantes sino dos formas del mismo dato: la insignia es compacta y el nodo deja ver el componente (un traductor entre dos canales, que sin él se unirían directamente). Las acciones del lienzo **Patrón → nodo** y **Nodo → insignia de patrón** pasan de una a otra sin perder el orden ni los pasos de los flujos; el análisis avisa si se declara el mismo patrón de las dos formas a la vez.
- **Orden**: `order` en una interacción la numera en cada vista (1, 2, 3…) por orden creciente y el número sale sobre la línea; solo ordena, así que se pueden dejar huecos (10, 20, 30). En un flujo manda el orden de sus pasos.
- **Reglas de conexión por tipo** (el lienzo no deja crear la unión y `validate` avisa en documentos existentes): solo un broker o una pasarela contiene colas y tópicos; los sistemas, APIs, conectores, tareas programadas y patrones publican en colas y tópicos, y los sistemas, APIs, pasarelas, conectores y patrones leen de ellos (un canal no se une con otro canal ni admite petición-respuesta); un almacén solo recibe lectura y escritura (petición-respuesta o lote) y nunca inicia una interacción; una tarea programada solo dispara; un usuario final solo llama y solo recibe notificaciones.

### Vistas y zonas

No se guardan coordenadas: las vistas se derivan del modelo (`map` con todo el mapa, `flow:<id>` por cada flujo y `system:<id>` por cada sistema, con él, lo que contiene y sus vecinos directos) y el autolayout las coloca. Los nodos con el mismo `domain` se dibujan dentro de una **zona** de equipo o dominio (los hijos siguen a su padre). Acciones del lienzo, sobre la selección múltiple (Ctrl/⌘ + clic, o Mayús + arrastre para un recuadro): **Agrupar en dominio…**, **Sacar del dominio** y **Agrupar por responsable** (una zona por equipo con los nodos que tienen `owner`).

`validate` comprueba la estructura (referencias, jerarquía, autoenlaces, nodos de patrón con su patrón, contratos que existen) y avisa de lo dudoso: colas sin productor o sin consumidor, interacciones sin contrato o duplicadas, contratos sin versión o con el contenido incorrecto, dependencias síncronas circulares, uniones que incumplen las reglas por tipo y patrones sin entrada o salida.

```bash
iark validate  pedidos.json --module integration
iark convert   pedidos.json --module integration --out mapa.svg          # también .mmd (Mermaid) y .drawio; --to fuerza el formato
iark convert   pedidos.json --module integration --to mermaid --view flow:crear-pedido   # el flujo sale como sequenceDiagram
iark convert   pedidos.json --module integration --view system:pedidos --out pedidos.svg # un sistema y sus vecinos
iark import    mapa.mmd     --module integration --out pedidos.json       # Mermaid (flowchart o sequence) → documento
iark generate  "Pedidos con Kafka y una pasarela de pagos" --module integration --json pedidos.json
iark prompt    "…" --module integration                                 # prompt autocontenido, sin clave de API
iark integration from-c4 banca.json                                     # sistemas y contenedores C4 → mapa de integración
iark integration catalog pedidos.json                                   # tabla Markdown de contratos y dónde se usan
iark integration matrix  pedidos.json                                   # matriz origen × destino con el estilo de cada enlace
iark integration contracts pedidos.json                                 # valida el contenido de cada contrato y lo resume
iark integration contract-export facturacion-proto pedidos.json > facturacion.proto   # saca un contrato a su archivo
iark integration cloudevents payload.json --type com.tienda.pedido.creado --source /pedidos   # formatea como CloudEvents 1.0
```

**Mermaid**: cada tipo tiene su forma (API `{{ }}`, pasarela `>" "]`, broker como `subgraph`, cola y tópico `([ ])`, almacén `[( )]`, conector `( )`, tarea programada `((( )))`, usuario `(( ))`, servidor MCP `[/ /]` y patrón `{ }`). Un sistema o un broker con hijos es un `subgraph`, una zona es un `subgraph` titulado «Dominio: X» que contiene a sus miembros, y las líneas con `order` llevan su número y las que tienen patrón, su nombre entre « ». Cuando la forma no basta para deducir el tipo (un tópico comparte forma con la cola) el texto lleva la marca «Tópico»; con ellas, la ida y vuelta por `iark import` conserva tipo, dominio, orden y patrón. Los contratos y su contenido no viajan por Mermaid: están en el documento JSON.

## Módulo de datos

Tercera especialidad de la suite (`--module data`): modela **dónde viven los datos, de dónde vienen y quién responde por ellos**. Vive en `packages/domain-data`, sin depender del código C4 ni del de integraciones; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/ventas-datos.json`](examples/ventas-datos.json), esquema con `iark schema --module data`):

| Parte | Contenido |
|---|---|
| `domains` | áreas de negocio que agrupan activos (Ventas, Clientes…), con su responsable |
| `assets` | `source`, `database`, `warehouse`, `lake`, `stream`, `table`, `view`, `file`, `report` y `model`; una tabla, vista o archivo puede colgar de su base, almacén o lago (`parentId`). Gobierno: `owner`, `steward`, `classification` (`public`…`restricted`), `pii`, `retention`; y `columns` (tipo, `pk`/`fk`/`uk`, `pii`) |
| `pipelines` | de una o varias entradas a una o varias salidas: `batch`, `elt`, `cdc`, `streaming`, `replication`, `api` o `manual`, con `tool`, `schedule` y `anonymizes`; opcionalmente `mappings` (linaje de columnas: `{ from: { assetId, column }, to: { assetId, column }, transform }`, de una entrada a una salida del pipeline) |
| `relations` | entre entidades (tablas, vistas, archivos, streams): `1:1`, `1:N`, `N:1` o `N:M`; opcionalmente `sourceMin` / `targetMin` (`0` o `1`) para la opcionalidad de cada extremo |

No se guardan coordenadas: las vistas se derivan del modelo. `lineage` es el linaje completo, `erd` el modelo entidad-relación (fichas con sus columnas) y `domain:<id>` una por dominio, con los activos vecinos en discontinuo. El linaje de un activo concreto se pide por su id: `lineage:<activo>` (todo), `upstream:<activo>` (de dónde vienen sus datos) y `downstream:<activo>` (qué depende de él). Un pipeline cuyas entradas y salidas están en un mismo contenedor se dibuja dentro de él.

**Linaje a nivel de columna** (opcional y retrocompatible: sin `mappings` nada cambia). Un pipeline puede declarar qué columna de sus entradas alimenta qué columna de sus salidas; el panel de propiedades del pipeline los edita como líneas de texto, `activo.columna -> activo.columna : transformación`. La vista `column:<activo>.<columna>` (también en el selector, una por cada columna de origen) dibuja un impacto de columna: fichas con solo las columnas afectadas (la de partida con ●), aguas arriba y aguas abajo, hasta los informes y modelos que dependen de ella (los informes y modelos sin columnas declaradas aceptan cualquier nombre de indicador). Funciona en el lienzo, en el SVG y en Mermaid (`--view column:erp-pedidos.total`).

**Dos notaciones para el ERD** (opcional y retrocompatible). El ERD se dibuja por defecto en **pata de gallo**; en el selector «Notación» del lienzo (variante `erd:uml`, también `--view erd:uml`) pasa a **UML con multiplicidades** (`1`, `0..1`, `1..*`, `0..*`) escritas junto a cada extremo de la relación. Salen de la cardinalidad (`1:N` → `1` y `0..*`) y de `sourceMin` / `targetMin`: `targetMin: 1` convierte el lado «muchos» en `1..*` y `sourceMin: 0`, el lado «uno» en `0..1`; el panel de propiedades de la relación los edita. La notación UML llega al SVG, a una página más del `.drawio` (con las multiplicidades como etiquetas de arista) y a Mermaid (`classDiagram` con `"1" -- "1..*"`); el `erDiagram` en pata de gallo sigue siendo el de siempre y solo cambia sus símbolos (`|o`, `o{`, `|{`) cuando se declara la opcionalidad.

**Contratos y DDL por motor de base de datos** (opcional y retrocompatible). Una base, un almacén, un lago, una fuente o un stream puede declarar su `engine`: `postgresql`, `mysql`, `sqlserver`, `oracle`, `sqlite`, `mongodb`, `cassandra`, `dynamodb`, `bigquery`, `snowflake`, `redshift`, `databricks` o `kafka` (el registro es extensible con `registerEngine`, y `iark data engines <motor>` muestra el catálogo de tipos de cada uno); lo heredan las tablas que cuelgan de él. Con motor, `validate` avisa de las columnas cuyo tipo no existe en él y propone el equivalente («`varchar2(10)` no existe en PostgreSQL, ¿quisiste decir `varchar(255)`?»; SQLite acepta cualquier tipo y solo lo anota). El contrato de datos YAML declara su servidor con `servers[].type` (el borrador creado desde un activo lo rellena con el motor del activo); el editor de contratos valida cada `physicalType` contra ese motor, con línea y columna, y ofrece los tipos del motor como sugerencias. El **DDL** se exporta por dialecto: `CREATE TABLE` para los motores SQL (con sus comillas, claves primarias y tipos con parámetros), validador `$jsonSchema` para MongoDB, `CREATE TABLE` de CQL para Cassandra, definición de tabla para DynamoDB y esquema Avro para Kafka; lo que el motor no admite se avisa en lugar de omitirse en silencio. Una clave primaria o única de un tipo que el motor no admite como clave (`text`, `blob` o `json` en MySQL y MariaDB; `clob`, `nclob`, `blob` y `long` en Oracle; `json`, `xml` y los geométricos en PostgreSQL; `text`, `ntext`, `image`, `xml` y los `(max)` en SQL Server; `EngineDef.sql.noKeyTypes`, extensible con `registerEngine`) es un aviso de `validate` con el arreglo (`varchar(n)` o una clave sustituta), y el DDL deja el tipo tal cual con un comentario `-- AVISO:` y lo suma a los avisos que el CLI deja en stderr. `iark data ddl --asset` acepta un contenedor, y también un producto de datos (las tablas de los activos de sus puertos), una API (las de los activos que expone) o un glosario (las de los activos con términos suyos enlazados).

`validate` comprueba la estructura y aplica reglas de **gobierno** que siguen el linaje: datos personales sin clasificar o clasificados por debajo de confidencial, un activo derivado de otro más sensible con una clasificación menor (salvo que su pipeline anonimice), activos sin responsable (más grave con datos personales), informes o modelos sin pipeline que los escriba, un mapeo a una columna que el activo no declara, datos personales que llegan por un mapeo a una columna no marcada como PII (salvo que el pipeline anonimice), pipelines por lotes sin frecuencia, ciclos de linaje y relaciones N:M sin tabla intermedia.

```bash
iark validate  datos.json --module data
iark convert   datos.json --module data --out linaje.svg                 # también .mmd (Mermaid) y .drawio (una página por vista)
iark convert   datos.json --module data --to mermaid --view erd          # erDiagram con columnas y claves
iark convert   datos.json --module data --out impacto.svg --view downstream:silver-ventas
iark import    linaje.mmd  --module data --out datos.json                # flowchart (linaje) o erDiagram → documento
iark import    esquema.sql --module data --out datos.json                # DDL de SQL (CREATE TABLE/VIEW, claves foráneas) → tablas, relaciones y vistas con linaje
iark import    manifest.json --module data --format dbt --out datos.json  # manifest.json de dbt → fuentes, modelos, pipelines y pruebas
iark generate  "Lago con CRM y ERP, almacén y un panel de ventas" --module data --json datos.json
iark data lineage silver-ventas datos.json                               # origen e impacto de un activo, con los responsables a avisar
iark data column-impact erp-pedidos.total datos.json                    # de qué columnas sale y qué columnas, informes y modelos dependen de ella
iark data catalog datos.json                                             # tabla Markdown de activos con dominio, responsable y clasificación
iark data pii datos.json                                                 # datos personales y adónde llegan sin anonimizarse
iark data from-integration mapa.json                                     # almacenes, colas y tópicos de un mapa de integración → activos con URN
iark data ddl datos.json                                                 # DDL de las tablas, con el dialecto del motor de cada una (también en Exportar › DDL)
iark data ddl datos.json --asset erp --engine mysql --schema ventas      # solo las tablas de «erp», traducidas a MySQL
iark data ddl datos.json --asset producto-ventas                         # --asset acepta también un producto, una API o un glosario: las tablas de sus activos
iark data ddl datos.json --contract contrato-pedidos                     # esquema de un contrato de datos; su servers[].type fija el dialecto
iark data ddl datos.json --engine mongodb --format json                  # validador $jsonSchema de MongoDB como JSON
iark data engines [motor]                                                # motores del registro y su catálogo de tipos
```

Al importar un `flowchart`, `[( )]` es una base de datos, `([ ])` un stream y el resto tablas; cada arista (`A & B --> C`) es un pipeline (continua = por lotes, punteada = streaming, gruesa = CDC, o el tipo entre corchetes al final de la etiqueta) y un `subgraph` es un contenedor cuyo tipo se toma del prefijo que pone el exportador («Data lake: …»). Del `erDiagram` se conservan tipos, claves, multiplicidad y opcionalidad (`|o`, `o{`, `|{`…).

**Importar DDL de SQL y dbt** (`--format ddl|dbt|auto`; también en la pestaña «Importar» y con «Abrir archivo…» del banco de trabajo). El DDL (`.sql`, `.ddl`) lo lee un analizador propio y tolerante para PostgreSQL, MySQL/MariaDB, SQL Server, Oracle y Snowflake: cada `CREATE TABLE` (y `CREATE TABLE … AS`) es una tabla con sus columnas (tipo con parámetros, `pk`, `uk`, `fk`, nulos y descripción desde `COMMENT`), el esquema (`ventas.pedido`) pasa a ser un contenedor `database`, las claves foráneas (`FOREIGN KEY`, `REFERENCES`, `ALTER … ADD CONSTRAINT`) son relaciones con su cardinalidad (`1:1` si la clave es única, `1:N` si no; la opcionalidad va en la descripción) y cada `CREATE [MATERIALIZED] VIEW` es una vista con un pipeline `elt` desde sus `FROM` y `JOIN`, y con linaje por columna cuando es un `SELECT` simple. El `manifest.json` de dbt (`.json`, se reconoce por `metadata.dbt_schema_version`) aporta fuentes (`sources`), modelos, semillas y snapshots (tabla o vista según su materialización, colgados de un almacén por base y esquema), un pipeline `elt` por cada dependencia (`depends_on.nodes`), las pruebas `unique`, `not_null` y `relationships` como claves y relaciones, y las exposiciones como informes. **No se deduce nada de gobierno**: la clasificación, los datos personales, el propietario y la retención solo se rellenan si el `meta` de dbt los declara; un nombre de columna como `email` o `dni` solo genera un aviso informativo. Todo lo que no encaja (valores por defecto, `CHECK`, índices, funciones, permisos, `analysis`, macros, métricas, pruebas sin claves…) se resume en los avisos y no se descarta en silencio; una entrada rota termina con el código 2 y el motivo de una línea. Importar dos veces el mismo archivo da el mismo documento.

**Catálogo de datos: productos, APIs y glosario** (opcional y retrocompatible: un documento 1.0 sin estos elementos no cambia ni cambian sus vistas; ejemplo en [`examples/datos-catalogo.json`](examples/datos-catalogo.json)). Tres clases nuevas de activo y un elemento nuevo, el término, para gobernar los datos como producto y no solo como tablas:

| Elemento | Qué es | Campos (todos opcionales) |
|---|---|---|
| `data-product` (Producto de datos) | agrupa activos y los ofrece como un servicio con dueño (data mesh) | `inputPorts` (lo que consume) y `outputPorts` (lo que publica), ambos ids de activos; `owner`, `domainId`, `classification`, `freshness` («24 h»), `sla`, `contractId` |
| `data-api` (API de datos) | expone activos a otras aplicaciones | `exposes` (ids de los activos que sirve), `protocol` (`rest`, `graphql`, `grpc`, `odata`, `sql`, `events`), `endpoint`, `contractId`, `owner` |
| `glossary` (Glosario) | agrupa términos de negocio; no guarda datos, así que no participa en pipelines ni en relaciones | `owner`, `domainId`, `description` |
| `terms` (Término, en la raíz del documento) | concepto de negocio con su definición | `name`, `definition`, `status` (`draft`, `approved`, `deprecated`; sin estado, borrador), `owner`, `glossaryId`, `synonyms` y `links`: `{ assetId, column? }` al activo (o a una columna suya) donde se materializa |

Los puertos, lo que sirve una API y los enlaces de un término son referencias a activos, no copias: un activo puede estar a la vez en su base de datos y en un producto. El esquema rechaza un puerto de un activo que no es producto, un activo que es entrada y salida del mismo producto, una API que expone un glosario u otra API, un término enlazado a un glosario, un enlace repetido y referencias a elementos que no existen. Borrar un activo en el editor limpia los puertos, exposiciones y enlaces que lo apuntaban, y borrar un glosario, sus términos.

Vistas nuevas, derivadas del modelo como las demás: `products` (el mapa de productos de datos: productos y APIs con sus puertos de entrada y salida, su frescura, SLA y protocolo) y `glossary` (cada glosario como zona que contiene sus términos, con flechas discontinuas a los activos y columnas que los implementan). Los productos, APIs y glosarios ligados al catálogo dejan de aparecer en el linaje; los de un dominio salen además en su vista `domain:<id>`. El lienzo ofrece los cuatro elementos en la paleta, las relaciones **Publica**, **Consume**, **Expone** y **Define** (al arrastrar, con el motivo si no encajan), la columna de un enlace de término en el panel de propiedades (un desplegable con «Todo el activo» y las columnas del activo enlazado) y las acciones **Agrupar en producto…** (crea un producto que publica los activos seleccionados, con su dominio y dueño más comunes, o los añade a uno existente) y **Enlazar término**.

`validate` añade las reglas del catálogo: un producto sin dueño, sin salidas, sin entradas, sin frescura ni SLA o sin contrato; una API sin dueño, sin nada que exponer, **sin contrato** o sin protocolo; un producto o una API que publica datos sensibles con una clasificación menor (o ninguna); un glosario sin términos o sin responsable; un término aprobado sin enlace, sin definición o sin responsable (un borrador, solo como información); un término obsoleto que sigue enlazado, repetido en su glosario, sin glosario o enlazado a una columna que el activo no declara; y un pipeline que lee o escribe un glosario.

```bash
iark data products datos.json                                            # productos y APIs: dueño, frescura, SLA, puertos, protocolo y contrato
iark data glossary datos.json                                            # términos con su definición, estado, responsable y activos o columnas enlazados
iark convert   datos.json --module data --out productos.svg --view products   # mapa de productos (también .mmd y .drawio)
iark convert   datos.json --module data --out glosario.svg  --view glossary
```

En Mermaid un producto, una API y un término llevan su clase (`:::dataProduct`, `:::dataApi`, `:::term`; el glosario es un `subgraph` titulado «Glosario: …»), y las flechas se etiquetan «entrada», «salida», «expuesto en» y «define · columna». `iark import` los reconoce (también con los nombres en español) y los devuelve como productos, APIs, términos, puertos, exposiciones y enlaces, no como pipelines. La salida estructurada de `iark generate` incluye los tres tipos y los `terms`; el contrato de un producto o una API se escribe en `contracts` y se enlaza con `contractId`, como el de cualquier activo.

## Módulo empresarial

Cuarta especialidad de la suite (`--module enterprise`): un subconjunto pequeño de ArchiMate/TOGAF para responder **qué sabe hacer la empresa, con qué aplicaciones y sobre qué tecnología**. Vive en `packages/domain-enterprise`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/empresa-arquitectura.json`](examples/empresa-arquitectura.json) y, con un flujo de valor y servicios de negocio, en [`examples/empresa-flujo-de-valor.json`](examples/empresa-flujo-de-valor.json); esquema con `iark schema --module enterprise`):

| Parte | Contenido |
|---|---|
| `units` | la organización (direcciones, equipos, terceros): son los responsables; el SVG solo las dibuja si ejecutan un proceso (`assigned-to`) o están sueltas, y el paisaje del lienzo las dibuja todas para poder arrastrar una asignación hacia cualquiera |
| `capabilities` | capacidades de negocio en árbol (`parentId`), con `importance` (`differentiating`, `core`, `supporting`), `maturity` de 1 a 5 y `ownerId` (se hereda del padre) |
| `processes` | procesos de negocio |
| `applications` | `lifecycle` (`planned`, `active`, `sunset`, `retired`), `criticality`, `technology`, `vendor`, `external`, `ownerId` de negocio, `ref` a otro módulo y datos de gestión opcionales: `annualCost`, `users`, `strategy` (`keep`, `migrate`, `replace`, `retire`) y `endOfLife` |
| `technologies` | plataformas y tecnología (`platform`, `infrastructure`, `database`, `runtime`, `middleware`, `service`), con `version`, `lifecycle` y `endOfLife` |
| `valueStreams`, `valueStages` | **flujos de valor** (opcionales): un flujo (`stakeholder`: quien recibe el valor, `ownerId`) con sus etapas (`streamId`, `value`: lo que aporta), en el orden en que aparecen en el documento; cada etapa se enlaza con las capacidades que la habilitan (`enables`) |
| `businessServices` | **servicios de negocio** (opcionales): lo que se ofrece a clientes (`audience`, `ownerId`); exponen procesos y capacidades (`exposes`) |
| `relations` | `supports` (aplicación → capacidad o proceso), `realizes` (proceso → capacidad), `runs-on` (aplicación → tecnología) `depends-on` (aplicación → aplicación, o tecnología → tecnología), `composes` (el todo → su parte, del mismo tipo), `flows-to` (aplicación → aplicación o proceso → proceso), `assigned-to` (unidad → proceso) y `triggers` (proceso → proceso); `enables` (capacidad → etapa que habilita) y `exposes` (servicio de negocio → proceso o capacidad); los seis últimos son opcionales y el documento sigue en la versión 1.0 |

No se guardan coordenadas: las vistas se derivan del modelo. `capabilities` es el **mapa de capacidades** (cuadrícula anidada; el color indica la madurez por defecto o, con `capabilities:importance`, `capabilities:criticality` y `capabilities:lifecycle`, la importancia, la criticidad o el ciclo de vida de las aplicaciones que la soportan, con su leyenda; el borde indica la importancia y una línea discontinua marca las que no tienen aplicación), `value-stream` los **flujos de valor** (cada flujo es un recuadro con sus etapas como chevrones en cadena, de izquierda a derecha, y debajo las capacidades que las habilitan, ordenadas según sus etapas y unidas a ellas con aristas de un solo codo que no se cortan; si una capacidad habilita etapas de varios flujos, la dibuja el primero y las aristas de los demás suben hasta ella por un pasillo libre —bajo el rótulo del recuadro y a un lado, a la derecha o a la izquierda, de los flujos intermedios— sin pisar ningún nodo ni rótulo, y el orden de las capacidades se afina por búsqueda local cuando hay etapas no contiguas; una etapa sin capacidad se dibuja discontinua), `roadmap` la **hoja de ruta del ciclo de vida** (columnas por año de fin de soporte, retiradas y previstas), `landscape` el **paisaje** capacidad → proceso → aplicación → tecnología, con los colores de capa de ArchiMate (negocio amarillo, aplicación azul, tecnología verde) y el icono del tipo en la esquina de cada elemento y `unit:<id>` una por unidad con lo que tiene a su cargo (lo demás, en discontinuo). El paisaje existe siempre que haya elementos, aunque el documento no tenga relaciones. `matrix` es la **matriz capacidad × aplicación** (capacidades en filas, con sangría por nivel; aplicaciones en columnas): una celda marca que la aplicación soporta la capacidad —directamente (`●`), por un proceso que la realiza (`○`) o, en una capacidad con hijas, heredada de ellas (`·`, no cuenta en los totales)—, se colorea por la criticidad de la aplicación y las filas y columnas suman sus totales; un hueco (capacidad hoja sin aplicación) se avisa en rojo discontinuo y un solapamiento (dos o más aplicaciones vigentes sin criterio: sin transición ni descripción en la relación `supports`) en violeta. En el lienzo, doble clic en una celda (o el botón «Soporta ⇄» con celdas seleccionadas) crea o quita la relación `supports`, y **arrastrar una celda ● a otra la mueve**: soltarla en la misma fila cambia la aplicación, en la misma columna la capacidad y en diagonal las dos (conserva el criterio de la relación, es un solo paso de Deshacer y las celdas vacías, ○ y · no se arrastran); sale también en SVG, draw.io, Mermaid (`block-beta`, que el importador `mermaid` del módulo vuelve a leer: cada ● es una relación `supports`, y lo que el formato no lleva —ids, criticidad, ciclo de vida, ○ y ·— se resume en los avisos) y, desde el CLI, como tabla o CSV. El impacto de un elemento se pide por su id: `impact:<id>` (lo que se apoya en él), `depends:<id>` (de qué depende) y `focus:<id>` (ambos). Las flechas van de quien se apoya a aquello en lo que se apoya.

`validate` comprueba la estructura (ids únicos entre tipos, jerarquías sin ciclos, responsables que son unidades, relaciones que encajan con sus extremos) y aplica reglas de **gobierno**: capacidades sin aplicación (aviso si son esenciales o diferenciadoras), aplicaciones sin responsable de negocio (aviso si son críticas), sin uso o sin tecnología, aplicaciones en retirada que nadie sustituye, elementos vivos que se apoyan en algo en retirada o retirado, tecnologías fuera de soporte (o que lo estarán en menos de 12 meses), capacidades con tres o más aplicaciones (posible duplicidad), procesos que no realizan ninguna capacidad, etapas de un flujo de valor que ninguna capacidad habilita (aviso), flujos sin etapas, servicios de negocio que no exponen nada y críticas que dependen de aplicaciones de criticidad baja.

```bash
iark validate  empresa.json --module enterprise
iark convert   empresa.json --module enterprise --out mapa.svg                       # mapa de capacidades; también .mmd y .drawio (una página por vista)
iark convert   empresa.json --module enterprise --out paisaje.svg --view landscape
iark convert   empresa.json --module enterprise --out impacto.svg --view impact:hana
iark import    paisaje.mmd  --module enterprise --out empresa.json                   # flowchart → documento
iark import    modelo.xml   --module enterprise --format archimate --out empresa.json   # modelo ArchiMate (Exchange Format o Archi) → documento
iark generate  "Comercio con tienda online, ERP, CRM y almacenes" --module enterprise --json empresa.json
iark enterprise coverage  empresa.json                                               # capacidades con sus aplicaciones y las que no tienen ninguna
iark enterprise impact    hana empresa.json [--direction dependencies|both]         # qué se ve afectado si cambia o se retira, con los responsables a avisar
iark enterprise lifecycle empresa.json [--today 2026-06-15]                          # obsolescencia: retiradas y fin de soporte, con las capacidades afectadas
iark enterprise matrix    empresa.json [--format table|csv]                         # matriz capacidad × aplicación: marcas, totales, huecos y solapamientos
iark enterprise from-integration mapa.json                                           # sistemas de un mapa de integración → aplicaciones con URN
```

Al importar un `flowchart`, el tipo de cada nodo sale de su clase (`:::application`, `class A capability`; también en español), del título de la capa que lo contiene («Capacidades», «Aplicaciones»…), de su forma (`([ ])` = proceso, `[( )]` = tecnología) y, por último, de que esté dentro de un `subgraph` (capacidad) o no (aplicación). Un `subgraph` que no es una capa es una capacidad que contiene a las suyas. Cada flecha se convierte en la relación que admiten sus extremos, en cualquier sentido. La segunda línea del texto de una aplicación es su tecnología y la de una tecnología, su versión. La interfaz web todavía no edita este módulo.

**Importar ArchiMate** (`--format archimate`; también en la pestaña «Importar» y con «Abrir archivo…»). Acepta el *Exchange File Format* del Open Group (`.xml`, espacio de nombres `http://www.opengroup.org/xsd/archimate/3.0/`) y el formato nativo de Archi (`.archimate`, con carpetas). Los actores, roles y colaboraciones de negocio pasan a unidades; las capacidades, a capacidades; los procesos, funciones e interacciones de negocio, a procesos; los servicios de negocio, a servicios de negocio; los componentes, colaboraciones y servicios de aplicación y los objetos de datos, a aplicaciones; los nodos, dispositivos, software de sistema, servicios de tecnología y artefactos, a tecnología; y los flujos de valor (compuestos, encadenados por flujo o disparo, o aislados), a flujos de valor con sus etapas. Las uniones y los eventos desaparecen y sus relaciones pasan a ser directas. Las relaciones se convierten siempre a una que admite `RELATION_RULES` y nunca se inventa una inválida: composición y agregación a jerarquía o `composes`, asignación a `assigned-to` o responsable, realización, servicio, flujo, disparo, acceso y asociación a la relación que admiten los tipos de sus extremos (cuando no hay una propia, a `depends-on` o `flows-to` con aviso). Las propiedades (en español o en inglés) se leen como coste anual, usuarios, estrategia (también TIME), fin de soporte, ciclo de vida, criticidad, proveedor, tecnología, `ref`, responsable, madurez (1-5, «Level 3», «3 de 5», «Optimizado») e importancia. Lo que no se mapea (motivación, estrategia, implementación y migración, interfaces, capa física, ubicaciones, agrupaciones y las vistas, porque el módulo deriva las suyas) se resume por categoría en los avisos. Los ids salen del nombre, así que importar dos veces el mismo archivo da el mismo documento, y las entidades externas (`<!ENTITY`) se rechazan.

## Módulo de plataforma

Quinta especialidad de la suite (`--module platform`): modela **dónde corre cada cosa y cómo llega hasta ahí**: entornos, redes, recursos aprovisionados, servicios, despliegues, dependencias y pipelines. Vive en `packages/domain-platform`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/plataforma-ejemplo.json`](examples/plataforma-ejemplo.json), esquema con `iark schema --module platform`):

| Parte | Contenido |
|---|---|
| `environments` | `dev`, `test`, `staging`, `prod` o `dr`, con `provider` y `region` |
| `networks` | redes de un entorno, anidables (`parentId`), con `exposure` (`public`, `private`, `isolated`) y `cidr` |
| `resources` | recursos de un entorno y, si procede, de una red: `cluster` y `vm` (los únicos **anfitriones**), `database`, `cache`, `queue`, `storage`, `load-balancer`, `gateway`, `dns`, `secret-store`, `registry`; con `status` (`planned`, `provisioned`, `decommissioned`), `iac` y `counterpartOf` (su equivalente en otro entorno, ver «Equivalencias entre entornos») |
| `services` | `service`, `worker`, `job` o `frontend`, con `owner`, `criticality` y `external` (SaaS de terceros: no se despliega) |
| `deployments` | dónde corre un servicio en un entorno: `hostId` (un clúster o una máquina **de ese entorno**), `replicas` y `version` |
| `dependencies` | de quién depende un servicio o un recurso: `calls` (síncrona), `messages` (asíncrona) o `data`, con `protocol` |
| `pipelines` | `ci`, `cd`, `ci-cd` o `iac`: los servicios que construyen o despliegan, los recursos que aprovisionan y los entornos por los que promocionan (`stages`, con `approval` manual) |

No se guardan coordenadas: las vistas se derivan del modelo. `topology` es el grafo de servicios y recursos con sus dependencias, `env:<id>` el **despliegue de un entorno** (las redes y los clústeres son recuadros anidados que contienen los recursos y las instancias de cada servicio, con sus réplicas y versión) y `delivery` la **entrega continua** (pipelines con sus pasos por entorno). El impacto de un servicio o recurso se pide por su id: `impact:<id>` (lo que depende de él), `depends:<id>` (de qué depende) y `focus:<id>` (ambos); un recurso, o un servicio que corre en un solo entorno, se acota a ese entorno.

`validate` comprueba la estructura (ids únicos entre tipos, redes sin ciclos, despliegues en un clúster o máquina del mismo entorno, referencias, equivalencias entre entornos) y aplica reglas de **gobierno**: servicios sin despliegue o sin responsable (aviso si son altos o críticos), producción sin pasar por un entorno anterior, dependencias de recursos previstos o dados de baja, de servicios que no corren en el mismo entorno o de recursos de otro entorno, tipos de recurso (base de datos, cola…) que un servicio usa en un entorno y no en otro, datos o secretos en una red pública, producción sin infraestructura como código, puntos únicos de fallo (una réplica de un servicio crítico), clústeres vacíos y recursos que nadie usa, llamadas circulares y pipelines sin aprobación manual en producción, sin servicios o que despliegan donde el servicio no corre.

```bash
iark validate  plataforma.json --module platform
iark convert   plataforma.json --module platform --out topologia.svg                   # topología; también .mmd y .drawio (una página por vista)
iark convert   plataforma.json --module platform --out produccion.svg --view env:prod
iark convert   plataforma.json --module platform --out entrega.svg --view delivery
iark convert   plataforma.json --module platform --out impacto.svg --view impact:kafka-prod
iark import    produccion.mmd --module platform --out plataforma.json                  # flowchart → documento
iark import    main.tf        --module platform --out plataforma.json                  # Terraform (.tf, .tf.json, estado o plan) → documento
iark import    infra/         --module platform --format terraform --out plataforma.json   # todos los *.tf de una carpeta (o varios archivos .tf) como un solo stack
iark import    despliegue.yaml --module platform --format kubernetes --out plataforma.json   # manifiestos de Kubernetes → documento
iark generate  "Tienda con Kubernetes, PostgreSQL y Kafka en desarrollo y producción" --module platform --json plataforma.json
iark platform deployments plataforma.json                                              # dónde corre cada servicio en cada entorno y qué versiones difieren
iark platform compare     dev prod plataforma.json                                     # compara dos entornos: lo que solo está en uno y las versiones o réplicas que difieren; dice cómo emparejó cada recurso si no fue por nombre (o si lo declara el recurso: counterpartOf)
iark platform impact      kafka-prod plataforma.json [--direction dependencies|both] [--env prod]   # qué se cae si falla, con los responsables a avisar
iark platform from-integration mapa.json                                               # sistemas de un mapa de integración → servicios y recursos con URN
```

Al importar un `flowchart`, los `subgraph` con el prefijo que pone el exportador se reconocen como `Entorno: …`, `Red pública|privada|aislada: … (cidr)` y `Clúster: …` / `Máquina virtual: …`; un servicio dentro de un clúster queda desplegado en él (con `3 réplicas · v1.4.2` al final del texto) y los servicios con el mismo nombre en varios entornos son uno solo con varios despliegues. El tipo de cada nodo sale de su clase (`:::database`, `:::worker`, `:::external`; también en español) y, si no, de su forma (`[( )]` = base de datos, `([ ])` = cola); `class X planned|decommissioned` da el estado del recurso. Las flechas son dependencias: continua = llama, punteada = mensajes, gruesa = datos, con la etiqueta `protocolo · descripción`. Los pasos de la vista de entrega continua no se importan. La interfaz web todavía no edita este módulo.

**Importar Terraform y Kubernetes** (`--format terraform|kubernetes|auto`; también en la pestaña «Importar» y con «Abrir archivo…», que reconoce por su contenido un `.tf.json` o un plan JSON). Terraform acepta `.tf` (HCL con un analizador propio y tolerante), `.tf.json`, el estado `.tfstate` v4 y `terraform show -json` (en un plan, los recursos salen como previstos o retirados), de las familias `aws`, `azurerm` y `google`. El entorno sale de `var.environment`, los locals, las etiquetas, el workspace o el nombre del archivo (con aviso cuando se deduce de este último); las VPC, VNet y subredes son redes anidadas con su CIDR, públicas si algo lo dice (IP pública al lanzar, ruta a un internet gateway, etiqueta de balanceador público, nombre «public» o «dmz») y privadas con aviso si nada lo dice; los clústeres, máquinas y demás recursos van a su clase (`iac: true`); las referencias, `depends_on`, grupos de seguridad (con puerto), listeners y DNS son dependencias. Kubernetes acepta YAML multidocumento, `kind: List` de `kubectl` y JSON: un namespace con nombre de entorno es un entorno (si no, hay uno solo, con aviso y con un clúster implícito); Deployment, StatefulSet, DaemonSet, CronJob y Job son servicios con su despliegue (réplicas, versión de la imagen, límites sumados; el HPA fija las réplicas mínimas), las cargas con imagen conocida (postgres, redis, rabbitmq, kafka, minio…) son recursos, Ingress, Gateway API y Service `LoadBalancer` son recursos en una red pública, y del Secret solo se guardan el tipo y los nombres de clave, **nunca los valores**; las variables de entorno (también desde ConfigMap), los `args`, los selectores y los volúmenes son dependencias. Los valores del estado o del plan de Terraform (contraseñas, claves) tampoco se leen. Lo que no se mapea (tipos desconocidos, recursos de soporte como IAM y rutas, `data`, módulos sin resolver, `count`/`for_each` sin evaluar, líneas de HCL que no se entienden con su número, kinds sin mapear, hosts externos…) va agrupado a los avisos. Un archivo roto termina con el código 2 y su línea. **Varios `.tf`**: `iark import <carpeta|a.tf b.tf…> --module platform --format terraform` los lee juntos como un solo stack (la carpeta no es recursiva; se ordenan por nombre, así que el resultado no depende del orden de los argumentos; los `.tf.json` y `.tfstate` no se juntan, avisa de ellos), y «Abrir archivo a importar…» del banco admite selección múltiple; los avisos y errores de HCL llevan el archivo (`red.tf, línea 12: …`). Limitaciones: los módulos locales no se resuelven y un archivo subido en el navegador solo trae el nombre base, así que un `main.tf` da un sistema llamado `main`.

### Equivalencias entre entornos (`counterpartOf`)

«Comparar entornos» (`compare:<A>:<B>`, la matriz `compare:all` e `iark platform compare`) empareja los recursos de dos entornos por deducción: nombre, nombre sin el sufijo del entorno («Kafka (dev)» y «Kafka (prod)»), tecnología si es inequívoca y clase si no suele repetirse. Cuando el nombre no delata la correspondencia («Almacén de pedidos» en preproducción y «Pedidos» en producción) la deducción no la ve y el par sale como «solo en A» y «solo en B»; para eso un recurso puede declarar cuál es su equivalente en otro entorno con el campo opcional `counterpartOf` (el id de ese recurso):

```json
{ "id": "pedidos-db-stg", "name": "Almacén de pedidos", "kind": "database", "environmentId": "stg", "technology": "PostgreSQL", "version": "14" },
{ "id": "pedidos-db-prod", "name": "Pedidos", "kind": "database", "environmentId": "prod", "technology": "Aurora", "version": "15", "counterpartOf": "pedidos-db-stg" }
```

- **Manda sobre la deducción**: lo declarado se empareja primero, sea cual sea el nombre, la tecnología o la clase (una máquina de desarrollo puede ser la equivalente de un clúster de producción), y el par se explica como «emparejado por equivalencia declarada» (en el lienzo, en la etiqueta de la línea; en el informe, una sección «Recursos emparejados por equivalencia declarada» con los de nombre distinto y la anotación en las diferencias de versión; en la matriz, en la celda). Un recurso cuyo equivalente declarado está dado de baja se queda sin pareja: no se le busca otro por deducción.
- **Basta que lo declare uno de los dos**, y la equivalencia es **simétrica y transitiva**: si staging declara que su base es la de desarrollo y producción declara que la suya es la de staging, las tres son el mismo recurso y desarrollo se compara con producción sin más. En la matriz de varios entornos cada equivalencia es una fila, aunque la referencia no la tenga.
- **Validación**: `validate` rechaza (código de salida 2) un equivalente que no existe, que no es un recurso, que es el propio recurso o que está en el mismo entorno, y una equivalencia **ambigua**: dos recursos vivos de un mismo entorno que resultan equivalentes al mismo de otro (los dados de baja no cuentan, así que el sucesor de un recurso retirado puede declarar lo mismo que él). Avisa de un equivalente de otra clase (salvo máquina ↔ clúster) y de uno dado de baja.
- **Lienzo**: el panel de propiedades de un recurso trae «Equivalente en otro entorno» (los recursos de los demás entornos, los de su clase primero; la pista del selector dice quién declara a este recurso como suyo) y no deja elegir uno que rompa o vuelva ambigua la equivalencia. **Duplicar entorno** declara cada copia equivalente de su original (comparar la copia con su origen los empareja uno a uno aunque luego se renombren); **quitar** un recurso o un entorno re-engancha la cadena (el que declaraba al quitado pasa a declarar el que este declaraba) en vez de dejarla colgando; **promover** un servicio re-apunta sus dependencias al equivalente declarado.
- **IA**: `generate` puede escribir `counterpartOf` cuando el nombre no delata la correspondencia y lo conserva al refinar con `--from`. Los importadores (Terraform, Kubernetes, Mermaid) no lo escriben: nada en esos formatos dice qué recurso es el equivalente de otro entorno y no se adivina (la comparación ya empareja por nombre lo que se puede deducir).

### Iconografía de nubes (AWS, Azure y paquetes propios)

Un recurso, un servicio o una red puede decir de qué proveedor es con dos campos opcionales: `provider` (`aws`, `azure`, `gcp`…) y `service` (la clave del servicio en el paquete de iconos de ese proveedor: `rds`, `sql-database`…). Se dibuja entonces con el icono de ese servicio, una **ficha blanca con el color de acento del proveedor** (AWS naranja, Azure azul) sobre la esquina del nodo, y en la esquina superior derecha de las zonas (un clúster que aloja servicios, una VPC). Se ve igual en el lienzo, en el SVG y en el `.drawio` (donde la ficha es una celda de imagen aparte junto a su nodo); Mermaid no tiene imágenes por nodo y no cambia. Si se indica el proveedor y no el servicio, se **sugiere** el que encaje con la clase y la tecnología del recurso, pero solo si es inequívoco (`database` + `PostgreSQL` en AWS → `rds`; una cola de AWS, que puede ser SQS o SNS, no se adivina). Los elementos sin proveedor se dibujan como siempre.

```json
{ "id": "pedidos-db", "name": "Pedidos DB", "kind": "database", "environmentId": "prod", "technology": "PostgreSQL", "provider": "aws", "service": "rds" }
```

| Proveedor | Servicios incluidos (clave) |
|---|---|
| `aws` | `ec2`, `eks`, `ecs`, `fargate`, `lambda`, `s3`, `rds`, `dynamodb`, `elasticache`, `sqs`, `sns`, `elb`, `alb`, `api-gateway`, `route53`, `cloudfront`, `secrets-manager`, `ecr`, `vpc` |
| `azure` | `vm`, `aks`, `app-service`, `functions`, `blob-storage`, `sql-database`, `cosmos-db`, `cache-redis`, `service-bus`, `load-balancer`, `application-gateway`, `api-management`, `dns`, `key-vault`, `container-registry`, `virtual-network` |

En el lienzo, el panel de propiedades de un recurso, un servicio o una red trae el selector **Proveedor de nube** y, debajo, **Servicio de nube** con la lista de servicios del paquete (marca el sugerido); elegir un proveedor propone el servicio y cambiarlo quita el que el nuevo no tiene. `iark platform icons plataforma.json` lista los paquetes disponibles y el icono que se dibuja para cada elemento con proveedor, y `validate` avisa de un proveedor sin paquete o de un servicio que su paquete no tiene.

**Los glifos incluidos son dibujos propios, sencillos, hechos para este proyecto: no son los logotipos oficiales de AWS ni de Azure**, que son marcas propietarias y no se redistribuyen aquí. Quien tenga licencia para usar los iconos oficiales (o quiera los de su empresa) puede **sustituirlos** con un paquete propio: los paquetes del mismo `provider` se superponen servicio a servicio y gana el último, de modo que un paquete `provider: "aws"` con solo los `rds` y `s3` oficiales reemplaza esos dos y deja el resto, sin tocar el documento. Lo que el paquete nuevo no diga de para qué clases (`kinds`) y tecnologías (`keywords`) sirve cada servicio lo hereda del que sustituye.

**Extender a otros proveedores (GCP, OCI, on-prem…)**: un paquete es un objeto `{ id, name, provider, color, icons }` donde cada servicio es `{ label, paths, kinds?, keywords? }` y `paths` son trazados SVG (`M`, `L`, `C`, `A`, `Z`…) en una caja de 16 × 16, solo trazos, que se pintan con el color del paquete. Se puede definir de tres formas:

- **En el documento**: el campo opcional `workspace.iconPacks` (lo ve el CLI, el lienzo y cualquier exportador). Ver [`examples/plataforma-nubes.json`](examples/plataforma-nubes.json), que dibuja AWS, Azure y un paquete propio de GCP.
- **Desde un archivo**: el mismo JSON en un `.json` suelto (su esquema es `schema/platform-icon-pack.schema.json`). `iark platform icons plataforma.json --pack gcp.json` lo valida y lo suma a la lista de esa ejecución; para exportar con él, cópialo a `workspace.iconPacks`. Con `parseIconPack(texto)` se lee desde código.
- **Desde código**: `registerIconPack(pack)` (de `@iark/domain-platform`) lo registra para todos los documentos de la aplicación; `unregisterIconPack(id)` lo quita.

Un paquete solo admite datos de trazado (comandos SVG y números), colores `#rgb`/`#rrggbb` y claves de letras, números, `.`, `_` y `-`: se rechaza cualquier otra cosa para que un paquete cargado de un archivo no pueda colar marcado en el SVG o el `.drawio`.

## Módulo de seguridad

Sexta especialidad de la suite (`--module security`; la quinta de las que pidió el plan, tras integraciones, datos, empresarial y plataforma): modela **qué hay que proteger, de quién y con qué**, con el enfoque clásico de un análisis de amenazas sobre un diagrama de flujo de datos. Vive en `packages/domain-security`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`, `urn:iark:platform:<id>`).

Documento JSON (ejemplo completo en [`examples/seguridad-ejemplo.json`](examples/seguridad-ejemplo.json), esquema con `iark schema --module security`):

| Parte | Contenido |
|---|---|
| `zones` | zonas de confianza, anidables (`parentId`): `untrusted`, `dmz`, `internal` (por defecto) o `restricted`; cruzar de una a otra es cruzar una **frontera de confianza** |
| `assets` | `actor` (persona), `external` (sistema de un tercero), `process` (ejecuta código) `datastore` (guarda datos), `identity` (proveedor de identidad: IdP, SSO; figura de tarjeta), `secret` (secreto, clave o certificado; rombo) o `channel` (canal de confianza VPN/mTLS/túnel; se dibuja como un nodo pequeño en cheurón dentro de una zona, con un flujo a cada lado, de modo que los flujos que lo atraviesan cruzan la frontera por él), cada uno en una zona; con `classification` (`public`, `internal`, `confidential`, `restricted`), `encryptedAtRest` (almacenes y secretos), `authentication` (identidades y canales), `rotation` (secretos), `encrypted` (canales), `owner` y `ref`. Los tipos `identity`, `secret` y `channel` y sus campos son opcionales: los documentos anteriores siguen siendo válidos |
| `flows` | datos que viajan de un activo a otro: `protocol`, `classification`, `encrypted` y `authentication` (`none`, `password`, `token`, `mtls`, `sso`); lo que no se indica, se considera desconocido |
| `threats` | amenaza clasificada con **STRIDE** (`spoofing`, `tampering`, `repudiation`, `information-disclosure`, `denial-of-service`, `elevation-of-privilege`) sobre un activo o un flujo, con `likelihood`, `impact` y `status` (`open`, `mitigated`, `accepted`); el riesgo es probabilidad (1-3) × impacto (1-4) |
| `controls` | lo que mitiga las amenazas (`authentication`, `authorization`, `encryption`, `logging`, `validation`, `network`, `rate-limit`, `backup`, `secrets`), `implemented` o `planned`; cada amenaza cita los suyos en `controlIds` |

No se guardan coordenadas. `dfd` es el **diagrama de flujo de datos** (cada zona es un recuadro del color de su nivel de confianza, anidado en su padre; la flecha es verde si el flujo va cifrado, roja discontinua si no y gris si no se sabe, y más gruesa si lleva datos sensibles; los activos con amenazas graves abiertas se marcan en rojo) y `threats` el **modelo de amenazas** (controles → amenazas → activos y flujos amenazados). Desde un activo se piden `blast:<id>` (hasta dónde llegan los datos si se compromete), `exposure:<id>` (quién puede llegar hasta él) y `focus:<id>` (ambos).

Otras tres vistas derivadas (en el lienzo, en `--view` y en SVG, Mermaid y draw.io):

- **`heatmap`, matriz de calor 3 × 4** (probabilidad × impacto): cada amenaza en su celda, con la celda coloreada por su riesgo. En el lienzo se **arrastra una amenaza a otra celda** (o sobre otra amenaza) y cambia su `likelihood` e `impact`. `heatmap:residual` (selector «Colorear por → Residual») la coloca donde queda tras los controles. **Regla del riesgo residual** (`residualOf`, no se guarda, se calcula): solo cuentan los controles `implemented` enlazados en `controlIds`; con **uno** la probabilidad baja un nivel (los controles evitan que ocurra), con **dos o más** baja además el impacto un nivel (detectan y acotan el daño); nunca por debajo de `low`. Las amenazas reducidas llevan la marca «residual ↓» (en la vista residual, borde discontinuo); una amenaza con residual alto o crítico pese a sus controles genera un aviso. La matriz residual no se arrastra.
- **`standards`, cobertura de estándares** (solo si algún control declara `standard`; `standards:<asvs|nist-800-53|iso-27001|cis>` para un catálogo): los controles agrupados por catálogo, unidos con «mitiga» a las amenazas; cada amenaza se marca como cubierta (control implementado de ese estándar), con cobertura prevista o **sin cobertura**. Las amenazas sin ningún control con estándar se avisan.
- **`surface`, superficie de ataque** (si algún flujo entra desde una zona no confiable): los activos expuestos (borde rojo, «expuesto: entrada directa»), el **radio de alcance** (saltos por los flujos de datos desde la entrada), los flujos de entrada en rojo grueso y ★ en lo que interesa proteger; se avisa de lo que se alcanza a uno o dos saltos de fuera.

`validate` comprueba la estructura (ids únicos entre tipos, zonas sin ciclos, flujos entre activos, amenazas sobre activos o flujos, controles existentes) y aplica reglas de **gobierno**: flujos que cruzan una frontera sin cifrar (aviso si tocan una zona no confiable o llevan datos sensibles), entradas a una zona más confiable sin autenticación o que saltan una zona intermedia, datos sensibles en almacenes sin cifrar en reposo o en zonas poco confiables, datos sensibles que salen a un tercero o de un almacén a un actor, clasificaciones incoherentes con los flujos, amenazas abiertas de riesgo alto o crítico, «mitigadas» sin un control implementado, riesgos críticos aceptados, categorías STRIDE que no aplican al elemento, controles sin uso y lo que cruza fronteras sin amenazas analizadas.

```bash
iark validate  seguridad.json --module security
iark convert   seguridad.json --module security --out flujos.svg                      # diagrama de flujo de datos; también .mmd y .drawio (una página por vista)
iark convert   seguridad.json --module security --out amenazas.svg --view threats
iark convert   seguridad.json --module security --out alcance.svg --view blast:pedidos
iark import    flujos.mmd --module security --out seguridad.json                       # flowchart → documento
iark generate  "Tienda con WAF, API, base de datos y pasarela de pagos" --module security --json seguridad.json
iark security risks    seguridad.json [--status open]                                  # registro de riesgos ordenado por riesgo inherente, con estado, controles y el riesgo residual que queda tras los implementados (↓ si baja)
iark security heatmap  seguridad.json [--residual]                                     # matriz de calor probabilidad × impacto: amenazas por celda y qué amenazas hay en cada una; --residual, donde quedan tras los controles
iark security stride   seguridad.json [--gaps]                                         # cobertura STRIDE: qué categorías aplican a cada activo y flujo y cuáles siguen sin analizar
iark security standards seguridad.json [--catalogo asvs]                               # cobertura de estándares: por catálogo (asvs, nist-800-53, iso-27001, cis), sus controles y las amenazas cubiertas, con cobertura prevista o sin cobertura
iark security exposure seguridad.json                                                  # superficie de ataque: entradas desde zonas no confiables y caminos hasta lo que interesa proteger
iark security from-integration mapa.json                                               # mapa de integración → activos y flujos con URN (zonas por heurística)
iark security from-platform plataforma.json [--env prod]                               # entorno de una plataforma → zonas por red, activos y flujos con URN
```

Al importar un `flowchart`, cada `subgraph` es una zona (con el prefijo `Zona no confiable|DMZ|interna|restringida: …` que pone el exportador se conoce su nivel; sin él se importa como interna y se avisa) y cada nodo, un activo cuyo tipo sale de su clase (`:::actor`, `:::external`, `:::process`, `:::datastore`; también en español) o, si no, de su forma (`[( )]` = almacén, `([ ])` = actor). Al final del texto del nodo se leen `datos confidenciales` y `cifrado en reposo` / `sin cifrar en reposo`. Las flechas son flujos: gruesa `==>` = cifrado, punteada `-.->` = sin cifrar, continua = no se sabe; la etiqueta es `protocolo · descripción · datos … · autenticación …`. Las amenazas y los controles se describen en el JSON, no en Mermaid. La interfaz web todavía no edita este módulo.

## Trazabilidad entre módulos

Los elementos de un documento pueden apuntar a los de otro módulo con una referencia estable `ref: "urn:iark:<módulo>:<id>"` (por ejemplo, un servicio de plataforma que realiza un sistema de integración, o un activo de seguridad que es un servicio de plataforma). Ningún módulo conoce el código de otro: `iark trace` reúne los documentos y sigue esos enlaces.

```bash
# Enlaces por par de módulos y referencias sin resolver
iark trace integration=examples/pedidos-integracion.json platform=examples/plataforma-ejemplo.json security=examples/seguridad-ejemplo.json
# Impacto de tocar un sistema de integración: qué se apoya en él, entre módulos (y de qué se apoya)
iark trace integration=… platform=… security=… --from integration:pedidos --direction referrers
iark trace … --format mermaid   # un subgrafo por módulo; --format svg para el dibujo; --format json para otras herramientas; --strict falla (código 3) con URN mal formadas o inexistentes
```

- `--direction refs|referrers|both` y `--depth n` acotan el alcance; sin `--from` se muestra el grafo completo.
- Un módulo sin documento aportado no invalida los enlaces hacia él: se listan como «sin resolver» (y no rompen `--strict`).
- El servicio HTTP expone lo mismo en `POST /api/trace` (ver más abajo; devuelve el grafo, el informe, el Mermaid y el SVG) y `generate --from …` conserva los `ref` del documento base al refinar con IA, aunque el modelo no los conozca.
- **En la web**: `trazabilidad.html` reúne los documentos de los módulos (ejemplos, archivos o JSON pegado, sin subir nada a ningún servidor), dibuja el grafo con un recuadro por módulo, lista los enlaces por par de módulos y las referencias sin resolver, y calcula el alcance de un elemento (quién se apoya en él, de qué se apoya y a cuántos saltos). Usa el mismo código que el CLI. Se llega desde el banco de trabajo y desde el shell de la suite.
- Los ejemplos (`examples/*.json`) ya traen una cadena real: empresarial → integración, plataforma → integración y seguridad → plataforma.

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
