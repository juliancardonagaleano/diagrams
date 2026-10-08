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
