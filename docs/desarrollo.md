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
npm run perf       # mide el autolayout, el lienzo y el tamaño de los trozos con diagramas grandes (a mano: no forma parte de npm test ni del CI; ver rendimiento.md)
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

Requisitos: **Node 22.13 o superior** (el que usan la imagen Docker y el CI; `@types/node` es la 22; lo fijan `.nvmrc` y `engines` de `package.json`, que llegan en la PR de gobernanza). Las dependencias de ejecución (`commander` 15, `vitest` 5, `mermaid` 12) no admiten Node 20.

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
src/i18n/              internacionalización de la interfaz (es / en): catálogos, `t()`, plurales, idioma elegido, selector y traducción de errores (ver «Internacionalización»)
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
- **Rendimiento** (ver [rendimiento.md](rendimiento.md)): `npm test` y el CI **no** fallan por tiempo (el reloj de un CI varía demasiado). Fijan lo estructural: cuántos nodos se montan de verdad con 1000 en el DOM (`DiagramCanvas.scale.test.tsx`), que el cálculo se pide al hilo de trabajo y cae al hilo actual si no hay (`packages/kernel/src/graph/elk.test.ts`), el tamaño por trozo y por página de `dist/app` (`tests/e2e/tamano-trozos.spec.ts`, topes en `scripts/perf/limites.ts`) y un e2e con un diagrama grande (`tests/e2e/rendimiento-lienzo.spec.ts`). Los tiempos se miden a mano con `npm run perf` y se anotan en `docs/rendimiento.md`.
- **Módulos de terceros** (`tests/plugins-cli.test.ts`): el CLI empaquetado de verdad contra `examples/plugin-riesgos` con un `@iark/kernel` compilado como se publica (`tests/helpers/pluginProject.ts`): cargar, descubrir la configuración, los fallos con código 2, que no se cargue de `--from-repo` ni de `--workspace`, y `iark serve --config` con su hilo de cálculo. Las unidades están en `src/cli/plugins/*.test.ts` y `src/cli/registry.test.ts`; `tests/paquetes.test.ts` vigila la declaración de los paquetes publicables.
- **Idioma de la interfaz** (`src/i18n/*.test.ts(x)`, `tests/e2e/idioma.spec.ts`): la puerta de paridad de los catálogos, la elección del idioma, los plurales, la traducción de errores por motivo y código pasando por el cliente HTTP con un `fetch` simulado, el selector, `lang` en los SDK y una spec que cambia a inglés el banco, el gestor de proyectos, el editor C4 y la suite. Detalle en «Internacionalización». Las pruebas de la app corren en español porque `tests/setup/jsdom.ts` fija `navigator.language` en `es-ES` y `playwright.config.ts` usa `locale: 'es-ES'`.
- **Accesibilidad** (`tests/e2e/accesibilidad.spec.ts`, axe-core): audita con menús y diálogos abiertos el editor clásico, el banco, la suite y la trazabilidad en los dos temas, y falla si encuentra violaciones críticas, serias o moderadas (salvo dos exclusiones nominales); con `A11Y_MODO=informe` solo mide y `npx tsx scripts/accesibilidad-resumen.ts` lo resume. Qué cubre, qué no y cómo repetirlo a mano: [accesibilidad.md](accesibilidad.md).
- **Almacén de cuentas** (`src/cli/accounts/`): `tests/helpers/accountStoreContract.ts` es la batería común del contrato `AccountStore` y la corren el almacén JSON (`jsonStore.test.ts`) y el SQLite (`sqliteStore.test.ts`, que añade lo propio: ajustes, migraciones del esquema, rollback, dos conexiones, reinicio); `storeEquivalence.test.ts` los compara paso a paso con el mismo guion; `migrate.test.ts` prueba la importación del JSON; `sqliteProcesses.test.ts` lanza procesos de verdad (`tests/helpers/sqliteWorker.ts`) sobre una misma base (topes, cuentas duplicadas, `SIGKILL`); `serveAccountsSqlite.test.ts` pone dos servidores HTTP sobre una base, y `tests/accounts-cli.test.ts` prueba `iark serve` y `iark accounts` empaquetados. Para correr **toda** la API de cuentas contra SQLite en vez de JSON: `IARK_TEST_ACCOUNTS_STORE=sqlite npx vitest run src/cli/serve*.test.ts` (y lo mismo con Playwright: `IARK_TEST_ACCOUNTS_STORE=sqlite npx playwright test tests/e2e/projects-cloud-github.spec.ts`).
- **Imagen Docker** (`npm run docker:smoke`, `scripts/docker-smoke-cuentas.ts`): construye la imagen (o usa una con `--image`), la ejecuta de verdad
  y recorre el servicio gestionado contra un GitHub de mentira (`tests/helpers/fakeGithub.ts`): inicio de sesión, un proyecto en el volumen, reiniciar y
  sustituir el contenedor, copia de seguridad (`iark accounts backup`) y restauración, actualizar desde cuentas en JSON, bind mount, secreto por archivo, que `/healthz` y `/readyz` respondan (el `HEALTHCHECK` consulta `/healthz`), que `/metrics` no exista por omisión y que nada secreto salga en `docker logs`. Necesita Docker y Linux
  (`--network host`); sin ellos se salta con un mensaje. No forma parte de `npm test`.
- **IA** (ver [ia.md](ia.md)): los clientes de modelo se simulan (`tests/helpers/modeloSimulado.ts`: un Chat Completions de mentira y un entorno hermético sin las `AI_*` de la sesión), así que `npm test` nunca llama a un modelo ni usa la red. `tests/evals.test.ts` corre los evals offline y comprueba que el ejecutor detecta lo que debe; `tests/ai-live.test.ts` es la única prueba que llamaría a un modelo real y **se salta** salvo con `IARK_LIVE_AI=1` y credenciales.

## Decisiones de diseño

- **Modelo compartido + vistas** (como Structurizr): renombrar un contenedor lo actualiza en todas las vistas; cada vista es una página del `.drawio`.
- **La IA nunca produce coordenadas**: produce el modelo; ELK produce la geometría. Esto hace la generación robusta y el autolayout la pieza central del sistema.
- **ELK `layered` con `hierarchyHandling: INCLUDE_CHILDREN`** porque es el único motor JS que trata los boundaries como nodos compuestos.
- **Semi UI + Tailwind 4** son las mismas librerías que usa drawdb, lo que permite reproducir su estética (tabs tipo card, cards colapsables, grid de puntos, tarjetas con franja de color).
- **Las librerías del frontend son `devDependencies`**: react, Semi UI, xyflow, zustand y zundo solo las usa el sitio, que Vite empaqueta entero en `dist/app`. `dependencies` se limita a lo que el paquete publicado y la imagen Docker necesitan en ejecución (`dist/core`, `dist/cli` y los dos bundles de `dist/embed`, que no importan nada de ellas): `commander`, `elkjs`, `fast-xml-parser`, `nanoid`, `yaml`, `zod` y los SDK de Anthropic. `tests/runtime-deps.test.ts` lo vigila: construye las cuatro salidas con tsup y falla si alguna importa (o incrusta, porque tsup solo externaliza `dependencies`) algo que no esté declarado como dependencia de ejecución.
- **Niveles como vistas tipadas sobre un modelo único**, no diagramas independientes: así C1, C2 y C3 se mantienen coherentes entre sí y la navegación (doble clic, breadcrumb, enlaces de página en draw.io) se deriva de la relación vista ↔ alcance sin datos adicionales.

## Internacionalización

La interfaz está en **español (por omisión) e inglés**. Es un módulo propio y sin dependencias, `src/i18n/`; no traduce el CLI, el servicio ni los documentos (ver «Qué no está traducido»).

**Qué idioma se usa** (`resolveLang` en `core.ts`, sin DOM, así que se prueba en Node): `?lang=` de la dirección, y si no, lo que la persona eligió con el selector (`localStorage`, clave `iark.lang`), y si no, el primer idioma de `navigator.languages` que tenga catálogo, y si no, español. Un valor desconocido se salta y no bloquea a los siguientes; si `localStorage` falla (ventana privada) se sigue sin él. Cada entrada (`src/app/main.tsx`, `src/modules-app/main.tsx`, `src/shell/main.ts`) llama a `initLang()` antes de pintar, y eso pone `<html lang>`. Cambiar el idioma (`setLang`) repinta al momento: actualiza `<html lang>`, recuerda la elección y, si la dirección ya traía `?lang=`, la mantiene al día para que recargar no la deshaga.

**Selector.** `LanguageSelect` (`src/i18n/react.tsx`) es un `<select>` nativo con nombre accesible («Idioma» / «Language»), cada opción escrita en su propio idioma y con su atributo `lang`. Está en el encabezado del editor C4 y en el del banco de trabajo (no en modo embebido: allí manda el anfitrión) y la suite tiene el suyo, en TypeScript sin React (`src/shell/main.ts`), que al cambiar vuelve a conectar para que los módulos abiertos reciban el idioma nuevo.

**Cómo se escribe un texto.**

- Los catálogos son objetos planos `clave → texto` en `src/i18n/es/<área>.ts` (el de origen; de él salen las claves y su tipo) y `src/i18n/en/<área>.ts` (`Record<keyof typeof es, string>`: si falta una clave, no compila). Áreas: `comun`, `errores`, `barra` (barra del proyecto, cola sin conexión, avisos, cuotas), `gestor` (gestor de proyectos, «Dónde se guardan», compartir), `historial`, `administracion` y `editor` (encabezado y menús del editor C4 y del banco, y la suite). Las claves llevan prefijo del área (`hist.title`, `adm.row.mine`).
- `t('clave', { nombre: valor })` pone los parámetros `{nombre}` (los números con el formato del idioma); el compilador comprueba que la clave exista y que se pasen exactamente sus parámetros. `tAny` es para claves que se arman en una tabla (motivos de error) y se comprueban aparte.
- Plurales: se escriben variantes `clave.one` / `clave.other` (y las categorías que haga falta, con `Intl.PluralRules`) y se piden con `tp('clave', n, { ... })`; `{count}` se pone solo. `other` es obligatoria y es la que se usa si falta la categoría.
- Un fragmento destacado: `<b>…</b>` y `<code>…</code>` dentro del texto, que `tr('clave')` (de `useT()`) convierte en elementos; nunca `innerHTML`.
- Fechas, tamaños y listas: `formatDate`, `formatNumber`, `formatList` (`Intl`) y `formatBytes` / `formatAgo` (`src/i18n/format.ts`). No se escriben a mano.
- En un componente: `const { t, tp, tr } = useT();` (suscribe al componente al idioma). Fuera de un componente se importa `t` de `src/i18n` y se llama al pintar.
- Las tablas de etiquetas (roles, filtros, direcciones del autolayout) son funciones o `get`, para que se evalúen al pintar y sigan al idioma.

**Añadir una cadena**: escribirla en `es/<área>.ts`, su traducción en `en/<área>.ts` y usarla. **Añadir un idioma**: un `LANGS` nuevo en `core.ts`, `LANG_NAMES`, una carpeta `src/i18n/<código>/` con el mismo contrato que `en/` y su entrada en `CATALOGS` (`index.ts`); la puerta de paridad dice lo que falte.

**La puerta de paridad** (`src/i18n/paridad.test.ts`) falla si: a un idioma le falta o le sobra una clave; un texto cambia sus `{parámetros}` o sus etiquetas `<b>`/`<code>`; una clave plural no tiene `other`, usa una categoría inexistente o pierde `{count}`; un texto está vacío o con espacios al borde; un texto en inglés lleva `¿ ¡ « »` o vocales con tilde (señal de español sin traducir); una clave definida no se usa (su nombre no aparece entre comillas en ningún código que no sea una prueba), o se usa una que no existe. Por eso las claves se escriben enteras en el código: una clave armada con un `${...}` no la ve la prueba.

**Errores del cliente HTTP, traducidos por código.** Un `ProjectError` (`@iark/kernel`) conserva su `message` en español (el CLI y los registros lo usan), pero ahora lleva en `info` el `reason` (un identificador estable, tipo `ProjectErrorReason`), sus `params` y, si el servidor mandó un texto, `serverMessage`. `projectErrorText(error)` (`src/i18n/errores.ts`) decide qué se le cuenta a la persona: **en español**, el texto del servidor si lo hay (es lo que de verdad dijo y trae su detalle) y si no el del motivo; **en inglés**, la traducción del `reason`, y si el error no tiene motivo (un mensaje del servidor que el cliente no conoce) dice qué significa su código y añade «(the server says: …)» con el texto original. `REASON_KEYS` y `CODE_KEYS` son `Record` sobre los tipos del núcleo: añadir un motivo sin su texto no compila. El servidor sigue contestando en español; traducir sus mensajes es un trabajo aparte.

**Qué no está traducido** (a propósito o por falta de margen; la lista vigente está también en la [hoja de ruta](roadmap.md#límites-conocidos-y-fuera-de-alcance)):

- *Traducido*: la barra del proyecto, el aviso de versión más nueva, las acciones sin conexión, el medidor de cuotas, el gestor de proyectos (lista, «Dónde se guardan», compartir, conexión, inicio de sesión), el historial de versiones, la administración de la instancia, los errores del cliente HTTP, el encabezado, los menús, los atajos y el «Acerca de» del editor C4, el encabezado del banco de trabajo y la suite (textos fijos, estado y selector).
- *En español todavía*: del editor C4, la barra flotante (salvo las direcciones y distribuciones del autolayout), el panel lateral y las fichas, el lienzo y sus textos para lectores de pantalla, el panel de problemas, la vista previa de Mermaid y los avisos de importar y exportar; del banco, las pestañas y paneles (Lienzo, Vista SVG, Problemas, Informes, Versiones, Exportar, Importar), el pie del editor, el lienzo común y el inspector, los adjuntos, la comparación y sus avisos; la página de trazabilidad; los mensajes de validación de cada módulo y las frases de `iark diff` del núcleo (el historial usa las suyas, traducibles); los errores del manifiesto de la suite; los mensajes del puente de embebido; el CLI, el servicio y la documentación.
- Los textos que se **guardan** en el momento en que ocurren (el motivo de un cambio aparcado en la cola sin conexión, el mensaje de estado de la sesión) quedan en el idioma de entonces y no se retraducen al cambiar de idioma; lo que se pinta cada vez (etiquetas, fechas, plurales) sí cambia.
- Un mensaje de estado de un componente que no se vuelve a pintar (un aviso ya mostrado) tampoco cambia hasta que se genera otro.

**Embebido.** El anfitrión elige el idioma: `lang` en `createIarkEmbed` / `createIarkModuleEmbed` y el atributo `lang` de `<iark-module>` se mandan como `?lang=` en la dirección del iframe (el protocolo `postMessage` y sus esquemas no cambian). En modo embebido el iframe no muestra selector ni recuerda otra elección. Ver [embebido.md](embebido.md).

## Trampas conocidas

Cosas que ya han hecho perder tiempo; cada una dice cuál es el síntoma.

- **Idioma en las pruebas.** La interfaz sigue el idioma del navegador y jsdom y Playwright se presentan como `en-US`: sin el ajuste de `tests/setup/jsdom.ts` y de `playwright.config.ts` (`es-ES`), cualquier prueba que busque un texto en español vería inglés. Una prueba nueva que quiera inglés lo pide con `?lang=en`, `setLang('en', { persist: false })` (y `resetLang()` al terminar) o un contexto de Playwright con `locale: 'en-US'`.
- **Puerto de los e2e.** El servidor de `vite preview` escucha en el puerto 4173; con `E2E_PORT=4176 npm run e2e` se cambia, para correr e2e a la vez desde varios checkouts. Usa un puerto distinto por checkout: si ya hay algo escuchando en el puerto, Playwright lo reutiliza y probaría el build de otro checkout en vez del propio.
- **Esperas en los e2e.** Las pruebas del lienzo de módulos esperan a que esté asentado (`canvasReady` / `selectView` en `tests/e2e/canvas-helpers.ts`, que leen `data-layout="ready"` en `module-canvas`) antes de medir o hacer clic: ELK y el encuadre de la cámara mueven los nodos después de que aparezcan, y no se usan esperas fijas. El editor C4 (`index.html`) publica lo mismo en `c4-canvas` (`data-view` y `data-layout`: «pending» hasta que ELK ha colocado la vista, React Flow la dibuja y la cámara ha terminado de encuadrar), y sus pruebas esperan con `c4Ready`, `openEditor` y `reloadEditor` en vez de `waitForTimeout` o `networkidle`.
- **Páginas con iframes.** Se usa `domcontentloaded`, porque con iframes `networkidle` a veces no llega.
- **Pruebas que lanzan el CLI** (`cli.test.ts`, `trace.test.ts`, `serve.test.ts`…): ejecutan el bundle de tsup con `node` (no `tsx`; ver `tests/helpers/cliBundle.ts`) y tienen 120 s de margen. Con la máquina cargada (varias ejecuciones en paralelo) cada arranque de `node` cuesta mucho más, y los 30 s por defecto de Vitest se agotaban sin que nada estuviera roto.
- **`indexedDbStore.test.ts`** usa `fake-indexeddb`, una `devDependency`: sin una instalación completa (`npm ci`) esa prueba no corre.
- **Dependencias de ejecución.** Las librerías del frontend son `devDependencies` a propósito; si un bundle publicado importa algo que no está en `dependencies`, `tests/runtime-deps.test.ts` falla (ver «Decisiones de diseño»).
- **Montar la carpeta de tokens, no el archivo**, al ejecutar el servicio en Docker: `iark auth` reemplaza el archivo con otro inodo y el contenedor seguiría viendo el de antes (ver [Con Docker](servicio.md#con-docker)).
