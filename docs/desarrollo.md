# Desarrollo

[← Índice de la documentación](indice.md)

Para quien trabaja en el repositorio: cómo instalarlo y qué scripts hay, cómo está organizado, cómo se prueba, qué decisiones de diseño hay detrás y qué trampas conocidas conviene saber. La guía de contribución es [CONTRIBUTING.md](../CONTRIBUTING.md).

## Instalación y scripts

```bash
npm install
npm run dev        # editor web en http://localhost:5173
npm run build      # librería (dist/core), CLI (dist/cli), SDK de embebido (dist/embed) y app (dist/app)
npm test           # pruebas unitarias y de componente (vitest + Testing Library)
npm run test:coverage  # igual, con informe de cobertura (informativo, sin umbral que bloquee)
npm run e2e        # pruebas de extremo a extremo con @playwright/test (requiere build:app previo)
npm run verify     # typecheck + test + build + e2e, de punta a punta
npm run typecheck  # tsc de la app, de los paquetes y de las pruebas y specs de Playwright (tsconfig.test.json)
npm run schema     # regenera schema/*.schema.json a partir de los esquemas zod de los módulos (y el de iark.config.json)
npm run manifest   # regenera public/.well-known/iark.json (manifiesto de federación) a partir de los módulos registrados
npm run packages:build   # prepara @iark/kernel y @iark/domain-* para publicarse, en dist-packages/ (JS ESM + tipos; ver «Paquetes publicables»)
npm run packages:check   # los empaqueta (npm pack), los instala en una carpeta limpia y comprueba que funcionan solos (pesado; necesita red)
npm run cli -- serve --static dist/app   # servicio HTTP + sitio en http://127.0.0.1:8787 (tras npm run build)
npm run deploy:pages   # publica el sitio en la rama gh-pages desde un equipo con permiso de escritura (ver despliegue-pages.md)
npm run docker:smoke   # construye la imagen y la prueba de verdad como servicio gestionado (necesita Docker y Linux)
npm run evals      # evals de prompts de la IA, offline con respuestas grabadas (sin red ni claves; lo corre también npm test)
npm run evals:live # los mismos casos contra el modelo REAL configurado: gasta tokens, exige --yes (ver ia.md, «Evals de prompts»)
```

Requisitos: **Node 22.12 o superior** (el que usan la imagen Docker y el CI; `@types/node` es la 22; lo fijan `.nvmrc` y `engines` de `package.json`, que llegan en la PR de gobernanza). Las dependencias de ejecución (`commander` 15, `vitest` 5, `mermaid` 12) no admiten Node 20.

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
src/cli/               comandos de iark (commander): módulos, `trace`, `diff`, `project` (con el almacén en carpeta `workspace.ts`), `auth` (tokens: `tokens.ts`), `serve` (y su API de proyectos, con la autenticación de `serveAuth.ts` y el inicio de sesión de GitHub en `accounts/`; la observabilidad —`X-Request-Id`, registros, auditoría, salud y métricas— en `observability/`), `repo/` (`--from-repo`); carga los módulos del registro
src/cli/plugins/       módulos de terceros: `config.ts` (iark.config.json y qué configuración se elige), `resolve.ts` (especificadores) y `load.ts` (import y comprobación de la forma)
src/embed/             protocolo postMessage (C4 y de módulos), SDK de anfitrión y Web Component <iark-module>
src/projects/          proyectos guardados en la app web: almacén en IndexedDB y almacén remoto (servidor), su configuración, la sesión con autoguardado y el gestor
src/modules-app/       banco de trabajo genérico de módulos (controlador sin React, lienzo común de los seis módulos —C4 incluido—, protocolo del puente)
src/shell/             shell de la suite (descubrimiento por manifiesto)
src/trace-app/         vista web de trazabilidad entre módulos (tablero sin DOM + página)
src/mermaid-preview/   vista previa de Mermaid (la librería `mermaid` se carga solo al pedirla)
src/app/               editor C4 clásico (React, Vite, React Flow, Semi UI, Tailwind); el banco de trabajo ya no lo incrusta
schema/                JSON Schema del documento y del formato de generación
examples/              documentos de ejemplo por módulo, páginas anfitrionas de demostración y `plugin-riesgos/` (un módulo de terceros completo; ver docs/plugins.md)
public/.well-known/    manifiesto de federación publicado con el sitio (iark.json)
Dockerfile             imagen del servicio (`iark serve` + sitio)
deploy/                despliegue de la nube gestionada: docker-compose.yml (IArk + Caddy con HTTPS), Caddyfile, .env.example y secrets/ (ignorada por git)
docs/                  esta documentación (el mapa está en docs/indice.md; la hoja de ruta, en docs/roadmap.md)
scripts/               generación de esquemas y manifiesto, preparación y comprobación de los paquetes publicables (`packages.ts`), despliegue a gh-pages y prueba de la imagen Docker
.github/workflows/     despliegue automático a GitHub Pages y publicación manual de los paquetes (`release-packages.yml`)
tests/                 pruebas transversales (CLI, HTTP, proyectos…), fixtures y ayudantes
tests/e2e/             pruebas Playwright
```

`iark modules` lista los módulos instalados y `iark modules --json` emite su manifiesto (`iark.manifest/1`), que es la base de la federación. Cada especialidad nueva es un paquete `@iark/domain-*` que implementa `DomainModule` y se registra en `src/cli/registry.ts`; una especialidad **fuera** del repositorio es un [módulo de terceros](plugins.md) que se carga desde un `iark.config.json` sin tocar nada de aquí.

## Paquetes publicables (`@iark/kernel` y `@iark/domain-*`)

Los siete paquetes de `packages/` se pueden publicar en npm (comparten la versión de `package.json` de la raíz). En el repositorio **no cambia nada para quien desarrolla**: el `exports` de cada `package.json` sigue apuntando a `src/*.ts`, que es lo que consumen vite, vitest, tsx y los alias de `tsconfig.base.json`; compilar antes de cada prueba haría inviable el ciclo de trabajo. Un paquete publicado necesita `exports` hacia JavaScript, así que cada `package.json` declara las dos cosas, como hace pnpm: `exports` (desarrollo) y `publishConfig.exports` (producción, hacia `./dist/*.js` y `./dist/*.d.ts`), y el script `prepack` de los `package.json` fuente falla a propósito para que nadie publique el de desarrollo por error.

- **`npm run packages:build`** comprueba la declaración de cada paquete (`manifestProblems` en `scripts/packages.ts`: versión compartida, licencia, `files`, que cada `exports` tenga su `publishConfig.exports`…) y, con tsup, deja en `dist-packages/<carpeta>/` el JavaScript ESM (con las dependencias, incluidos los `@iark/*`, como `import` externos), los `.d.ts` y un `package.json` de publicación con las dependencias `@iark/*` en `^<versión>`. `dist-packages/` está en `.gitignore`.
- **`npm run packages:check`** compila la raíz, prepara los paquetes, los empaqueta con `npm pack`, los instala **solo desde los tarballs** en una carpeta temporal limpia (más `zod`) y comprueba: que se importan los nueve puntos de entrada y el registro arranca con los seis módulos; que los tipos resuelven y un módulo propio con `defineModule` compila con `tsc` (`NodeNext`); y que `iark --config` y `iark serve --config` del CLI instalado cargan el módulo de ejemplo (con `@iark/kernel` y `zod` de los tarballs) y validan y exportan con él. Tarda alrededor de un minuto en una máquina descargada y necesita red (instala `zod` y sus dependencias). Corre en el job informativo `packages` de `deploy-pages.yml` (NO está en el `needs` de `publish`: un fallo ahí avisa, no bloquea el sitio).
- **Publicar** es otro workflow, `release-packages.yml`, que solo se lanza a mano (`workflow_dispatch`) y con `dry-run` activado por omisión (`npm publish --dry-run` de cada paquete desde `dist-packages/`). Con `dry-run` desactivado publica de verdad con `--provenance --access public`. **Todavía no se ha publicado nada.** Antes de la primera publicación real hace falta, por parte de quien administra el proyecto: que exista la organización o ámbito `@iark` en npm (si no estuviera disponible, hay que renombrar los paquetes) y el secreto `NPM_TOKEN` en el repositorio (un token de automatización con permiso sobre ese ámbito).
- El CLI empaquetado (`dist/cli`) incrusta su propio kernel (tsup solo externaliza las `dependencies` de la raíz), así que un módulo de terceros que importa `@iark/kernel` usa **otra copia**: por eso el contrato se comprueba por forma y `ModuleError` se reconoce por una marca (`Symbol.for`), no por `instanceof` (ver [Módulos de terceros](plugins.md#dos-copias-del-kernel)).

## Pruebas

- **Unitarias y de componente** (`src/**/*.test.ts(x)`, vitest): cubren el núcleo (modelo, autolayout,
  export a `.drawio`, CLI), el store (`documentStore.test.ts`) y componentes React puntuales donde aporta algo que
  ni el store ni un E2E cubren mejor (`@testing-library/react`, entorno jsdom vía pragma
  `// @vitest-environment jsdom`). `npm run test:coverage` genera el informe (`@vitest/coverage-v8`).
- **Extremo a extremo** (`tests/e2e/*.spec.ts`, `@playwright/test`): recorren la app compilada (`vite preview`)
  en el Chromium del entorno. `playwright.config.ts` ya apunta a `CHROMIUM_PATH` (o
  `/opt/pw-browsers/chromium`) sin descargar un navegador propio, y guarda captura + traza solo si una prueba
  falla (`npx playwright show-trace test-results/.../trace.zip`). Las particularidades (puerto, esperas, iframes) están en
  [Trampas conocidas](#trampas-conocidas).
- **Módulos de terceros** (`tests/plugins-cli.test.ts`): el CLI empaquetado de verdad contra `examples/plugin-riesgos` con un `@iark/kernel` compilado como se publica (`tests/helpers/pluginProject.ts`): cargar, descubrir la configuración, los fallos con código 2, que no se cargue de `--from-repo` ni de `--workspace`, y `iark serve --config` con su hilo de cálculo. Las unidades están en `src/cli/plugins/*.test.ts` y `src/cli/registry.test.ts`; `tests/paquetes.test.ts` vigila la declaración de los paquetes publicables.
- **Imagen Docker** (`npm run docker:smoke`, `scripts/docker-smoke-cuentas.ts`): construye la imagen (o usa una con `--image`), la ejecuta de verdad
  y recorre el servicio gestionado contra un GitHub de mentira (`tests/helpers/fakeGithub.ts`): inicio de sesión, un proyecto en el volumen, reiniciar y
  sustituir el contenedor, copia de seguridad y restauración, bind mount, secreto por archivo, que `/healthz` y `/readyz` respondan (el `HEALTHCHECK` consulta `/healthz`), que `/metrics` no exista por omisión y que nada secreto salga en `docker logs`. Necesita Docker y Linux
  (`--network host`); sin ellos se salta con un mensaje. No forma parte de `npm test`.
- **IA** (ver [ia.md](ia.md)): los clientes de modelo se simulan (`tests/helpers/modeloSimulado.ts`: un Chat Completions de mentira y un entorno hermético sin las `AI_*` de la sesión), así que `npm test` nunca llama a un modelo ni usa la red. `tests/evals.test.ts` corre los evals offline y comprueba que el ejecutor detecta lo que debe; `tests/ai-live.test.ts` es la única prueba que llamaría a un modelo real y **se salta** salvo con `IARK_LIVE_AI=1` y credenciales.

## Decisiones de diseño

- **Modelo compartido + vistas** (como Structurizr): renombrar un contenedor lo actualiza en todas las vistas; cada vista es una página del `.drawio`.
- **La IA nunca produce coordenadas**: produce el modelo; ELK produce la geometría. Esto hace la generación robusta y el autolayout la pieza central del sistema.
- **ELK `layered` con `hierarchyHandling: INCLUDE_CHILDREN`** porque es el único motor JS que trata los boundaries como nodos compuestos.
- **Semi UI + Tailwind 4** son las mismas librerías que usa drawdb, lo que permite reproducir su estética (tabs tipo card, cards colapsables, grid de puntos, tarjetas con franja de color).
- **Las librerías del frontend son `devDependencies`**: react, Semi UI, xyflow, zustand y zundo solo las usa el sitio, que Vite empaqueta entero en `dist/app`. `dependencies` se limita a lo que el paquete publicado y la imagen Docker necesitan en ejecución (`dist/core`, `dist/cli` y los dos bundles de `dist/embed`, que no importan nada de ellas): `commander`, `elkjs`, `fast-xml-parser`, `nanoid`, `yaml`, `zod` y los SDK de Anthropic. `tests/runtime-deps.test.ts` lo vigila: construye las cuatro salidas con tsup y falla si alguna importa (o incrusta, porque tsup solo externaliza `dependencies`) algo que no esté declarado como dependencia de ejecución.
- **Niveles como vistas tipadas sobre un modelo único**, no diagramas independientes: así C1, C2 y C3 se mantienen coherentes entre sí y la navegación (doble clic, breadcrumb, enlaces de página en draw.io) se deriva de la relación vista ↔ alcance sin datos adicionales.

## Trampas conocidas

Cosas que ya han hecho perder tiempo; cada una dice cuál es el síntoma.

- **Puerto de los e2e.** El servidor de `vite preview` escucha en el puerto 4173; con `E2E_PORT=4176 npm run e2e` se cambia, para correr e2e a la vez desde varios checkouts. Usa un puerto distinto por checkout: si ya hay algo escuchando en el puerto, Playwright lo reutiliza y probaría el build de otro checkout en vez del propio.
- **Esperas en los e2e.** Las pruebas del lienzo de módulos esperan a que esté asentado (`canvasReady` / `selectView` en `tests/e2e/canvas-helpers.ts`, que leen `data-layout="ready"` en `module-canvas`) antes de medir o hacer clic: ELK y el encuadre de la cámara mueven los nodos después de que aparezcan, y no se usan esperas fijas. El editor C4 (`index.html`) publica lo mismo en `c4-canvas` (`data-view` y `data-layout`: «pending» hasta que ELK ha colocado la vista, React Flow la dibuja y la cámara ha terminado de encuadrar), y sus pruebas esperan con `c4Ready`, `openEditor` y `reloadEditor` en vez de `waitForTimeout` o `networkidle`.
- **Páginas con iframes.** Se usa `domcontentloaded`, porque con iframes `networkidle` a veces no llega.
- **Pruebas que lanzan el CLI** (`cli.test.ts`, `trace.test.ts`, `serve.test.ts`…): ejecutan el bundle de tsup con `node` (no `tsx`; ver `tests/helpers/cliBundle.ts`) y tienen 120 s de margen. Con la máquina cargada (varias ejecuciones en paralelo) cada arranque de `node` cuesta mucho más, y los 30 s por defecto de Vitest se agotaban sin que nada estuviera roto.
- **`indexedDbStore.test.ts`** usa `fake-indexeddb`, una `devDependency`: sin una instalación completa (`npm ci`) esa prueba no corre.
- **Dependencias de ejecución.** Las librerías del frontend son `devDependencies` a propósito; si un bundle publicado importa algo que no está en `dependencies`, `tests/runtime-deps.test.ts` falla (ver «Decisiones de diseño»).
- **Montar la carpeta de tokens, no el archivo**, al ejecutar el servicio en Docker: `iark auth` reemplaza el archivo con otro inodo y el contenedor seguiría viendo el de antes (ver [Con Docker](servicio.md#con-docker)).
