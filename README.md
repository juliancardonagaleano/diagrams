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

## Fuera de alcance (v1)

Servidor MCP, exportación PNG/SVG desde el modo embebido, vistas de despliegue/código, colaboración en tiempo real, importar `.drawio` o DSL desde el modo embebido (el anfitrión puede usar `fromDrawio` / `fromStructurizrDsl` del núcleo), exportar a DSL de Structurizr.
