# Plan de implementación

[← Índice de la documentación](../indice.md) · [Protocolo](protocolo-sdd.md) · [As-is](as-is.md) · [Spec 001](specs/001-to-be-c4.md)

Este plan ordena el corte que fija la [spec 001](specs/001-to-be-c4.md), hoy en `borrador`, y que detallan las specs 002 a 009, también en `borrador`. No es una spec. No autoriza código. No cambia el estado de ninguna spec: quien mantiene el producto escribe `aceptada`, en una PR que no trae implementación. La PR que implementa una spec la pasa de `en curso` a `hecha` y no mezcla otra.

Una spec implementada es una PR. El código de producto (`src/`, `packages/`, `schema/`, `public/`, pruebas, imagen, `deploy/` y cualquier JSON de modelo) espera a esa aceptación. `examples/diagrams-to-be.json` espera, además, a que la 001 esté `aceptada`. La PR que escribe `aceptada` no lo crea: el protocolo cuenta ese JSON como código de producto, y la 001 ya le puso el nombre.

Las rutas de abajo son las de hoy. Ninguna se edita en la PR de este plan.

## Fase 0 · Aceptación

Quien mantiene el producto acepta cada spec por su cuenta y escribe `aceptada`. Esta sesión no lo hace. El orden de abajo no empieza para una spec que siga en `borrador`.

El JSON to-be se crea después de que la 001 esté `aceptada`, en un cambio distinto del que la marca y distinto de la primera PR de código. Hasta entonces no existe.

## Fase 1 · Gateway

La autoriza la [spec 002](specs/002-diagrams-gateway.md). Depende de la fase 0 para esa spec.

Extrae `api-modulos` y `pool` a `diagrams-gateway` sin cambiar el contrato HTTP. El núcleo `@iark/*` lo ejecuta ese proceso. La piscina se queda dentro.

Toca, cuando se implemente: `src/cli/serve.ts` (el tramo de `api()` de módulos y `POST /api/trace`), `src/cli/compute.ts`, `src/cli/computePool.ts`, `src/cli/computeWorker.ts`, `src/cli/computeConfig.ts`, y el punto de entrada del proceso nuevo junto a ese servidor. Puede seguir llamando a `src/cli/registry.ts` tal como está. No introduce el puerto `Modules`.

No mezcla proyectos, cuentas, eventos, `--static`, la política de cabeceras ni el manifiesto. Puede dejar el `/healthz` que ya existe para supervisar el proceso. Mover la librería es la fase 5.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json` y con `src/cli/serveCompute.test.ts`, `src/cli/serveDiff.test.ts`, `src/cli/computePool.test.ts`, `src/cli/computeConfig.test.ts`, `src/cli/serveSinIa.test.ts`, `tests/module-operations.test.ts`, `tests/trace.test.ts` y `src/cli/serve.test.ts`.

## Fase 2 · Identity

La autoriza la [spec 004](specs/004-diagrams-identity.md). Depende de la fase 1: al salir el gateway, app y gateway solo validan, y el almacén de hashes y el de cuentas quedan en identity.

Toca: `src/cli/accounts/`, `src/cli/tokens.ts`, `src/cli/serveAuth.ts`, `src/cli/auth.ts`, y en `src/cli/serve.ts` las ramas `whoami`, `auth`, `admin`, `usage` y `members`.

No mezcla la API de módulos, el CRUD de diagramas, el canal SSE ni el estático. `iark auth` sigue siendo el comando que crea y revoca; no se abre una ruta HTTP nueva para eso.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json` y con `src/cli/serveAuth.test.ts`, `src/cli/tokens.test.ts`, `src/cli/serveAccounts.test.ts`, `src/cli/serveAccountsPostgres.test.ts`, `src/cli/serveAccountsSqlite.test.ts`, `src/cli/serveMembers.test.ts`, `src/cli/serveQuotas.test.ts` y las pruebas de `src/cli/accounts/`.

## Fase 3 · App de proyectos

La autoriza la [spec 003](specs/003-diagrams-app.md). Depende de las fases 1 y 2: lo que queda del monolito es `projects`, y las cuotas y los miembros ya no son suyos.

Toca: `src/cli/serveProjects.ts`, `src/cli/workspace.ts`, `src/cli/workspaceStore.ts`, `src/cli/postgresProjects.ts`. El modelo compartido `packages/kernel/src/project` se usa; no se le abre un formato paralelo. Las cuatro capas (Host, Application, Domain, Infrastructure) separan lecturas por infraestructura y escrituras por dominio.

No mezcla el gateway, identity, el proceso SSE ni `--static`. El `EventPublisher` puede seguir inyectado: sacarlo es la fase 4. `iark project` tiene que seguir pasando (`tests/project-cli.test.ts`); rehacer el comando es la fase 8.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json` y con `src/cli/serveProjects.test.ts`, `src/cli/serveVersions.test.ts`, `src/cli/workspace.test.ts`, `src/cli/workspaceCoarseTime.test.ts`, `src/cli/postgresProjects.test.ts`, `tests/project-http.test.ts`, `tests/project-http-postgres.test.ts`, `tests/project-check.test.ts`, `tests/project-cli.test.ts` y las de `packages/kernel/src/project/`.

## Fase 4 · SSE

La autoriza la [spec 005](specs/005-diagrams-sse.md). Depende de las fases 2 y 3: la app publica el aviso y identity dice quién pertenece al proyecto. El gateway de módulos no sirve este canal.

Hoy no hay bus. `announce` en `src/cli/serveProjects.ts` llama a `EventPublisher.publish` y el hub vive en memoria en `src/cli/serveEvents.ts`. En `src/` no hay `NOTIFY`. `LISTEN` solo aparece en los comentarios de `src/cli/postgres/pool.ts` y `src/cli/postgresProjects.ts`, que están escritos para el pooler de Supabase en modo transacción y no pueden usarlo.

Antes de separar el proceso falta ese canal. El candidato que no añade contenedor es `NOTIFY` de Postgres por una conexión de sesión, al margen de ese pool. Otro canal vale si tampoco es un contenedor nuevo: la spec 001 no añade el broker del lineamiento. Hasta que el canal esté elegido y probado, esta fase no arranca `diagrams-sse` como proceso. Puede dejar el feature delimitado en el proceso que publica, y la spec sigue en `en curso`.

Cuando el canal existe, toca `src/cli/serveEvents.ts` y el `announce` de `src/cli/serveProjects.ts`. La app publica. El gateway abre `GET /api/events`. El cuerpo del aviso no cambia.

No mezcla la extracción del gateway, las capas de `projects` ni el estático.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json`, `src/cli/serveEvents.test.ts` y `tests/e2e/projects-cloud-eventos.spec.ts`.

## Fase 5 · Borde

La autoriza la [spec 009](specs/009-borde-y-operacion.md). Depende de las fases 1 a 3, que ya son procesos distintos. Si la fase 4 sigue parada en el canal, esta fase no la desbloquea y no se lleva el split: aplica la cabecera al feature SSE donde esté servido, y el proceso `diagrams-sse` recibe la misma función cuando por fin se separe.

Quita `--static` del proceso de dominio. Hoy el `ENTRYPOINT` del `Dockerfile` arranca `iark serve` con `--static dist/app`. Los estáticos quedan en Pages (`.github/workflows/deploy-pages.yml`, `scripts/deploy-gh-pages.sh`) o en un CDN. Ni la app ni los gateways sirven el SPA.

Las cabeceras quedan en el proxy TLS (`deploy/Caddyfile`, que hoy solo fija HSTS) y en el borde de `diagrams-gateway` y de `diagrams-sse`, con la política de `src/cli/securityHeaders.ts`. Pages solo no pone la CSP del HTML: el proxy o el CDN tienen que ponerla.

La observabilidad pasa a librería desde `src/cli/observability/`. Salud en cada proceso (`/healthz`, y un `/readyz` que solo mira lo que ese proceso posee). Request id y métricas son comunes. `prometheus` sigue raspando `/metrics`. La auditoría de cuentas y miembros se queda en identity; la de proyectos, diagramas y versiones, en `projects`. No existe `diagrams-trace`. `pool` no es un servicio: sigue dentro del gateway.

Toca también `deploy/docker-compose.yml` solo en lo que el proceso de dominio deje de publicar el sitio. No rehace el gateway ni el módulo `projects`.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json`, `src/cli/securityHeaders.test.ts`, `src/cli/serveSecurityHeaders.test.ts`, `tests/e2e/seguridad-cabeceras.spec.ts`, `src/cli/serve.test.ts`, las pruebas de `src/cli/observability/`, `tests/observabilidad-http.test.ts` y `tests/observabilidad-cli.test.ts`.

## Fase 6 · Shell SPA

La autoriza la [spec 006](specs/006-diagrams-shell.md). Depende de la fase 0 para esa spec y, en este orden, va después del borde. No depende del proceso del CLI.

Un build. `vite.config.ts` deja de tener `modulos.html`, `trazabilidad.html` y `suite.html` como entradas. El router sale de `src/boot.ts`. Los features son `suite`, `studio`, `projects` y `classic-editor`. La plataforma es el router, `src/i18n`, `src/projects` y el puente de `src/embed`. El lienzo (`src/modules-app/canvas`) es el slot.

Toca también `index.html`, `src/home`, `src/studio`, `src/app`, `src/shell`, `src/trace-app` (solo para montarlo en `/trace`, sin extraerlo), `src/cli/suiteManifest.ts` (las URL `../modulos.html`), `src/embed/iark-module-embed.ts` y `scripts/perf/limites.ts`.

No mezcla la extracción de remotos. El banco puede seguir dentro del slot.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json`, `tests/e2e/suite.spec.ts`, `tests/e2e/studio-marco.spec.ts`, `tests/e2e/navigation-and-layout.spec.ts`, `tests/e2e/embed.spec.ts`, `tests/e2e/idioma.spec.ts`, `tests/e2e/tamano-trozos.spec.ts`, `tests/e2e/modules.spec.ts`, `tests/e2e/trace.spec.ts`, `src/shell/manifest.test.ts` y `src/i18n/core.test.ts`.

## Fase 7 · Microfrontends

La autoriza la [spec 007](specs/007-microfrontends.md). Depende de la fase 6: el shell SPA y el slot ya existen. Una sola PR. Los commits van en este orden: primero el contrato y el manifiesto (junto a `packages/kernel/src/module/manifest.ts` y `src/shell/manifest.ts`, sin cambiar el nombre `iark.manifest/1` a la ligera), luego un remoto por especialidad (`mfe-c4`, `mfe-integration`, `mfe-data`, `mfe-enterprise`, `mfe-platform`, `mfe-security`) sacando la UI de `src/modules-app`, y `mfe-trace` al final, sacando `src/trace-app`. El SDK (`src/embed/iark-embed.ts`, `iark-module-embed.ts`, `iark-module-element.ts`) no se convierte en remoto.

No mezcla el cambio de estilo del shell ni el cálculo de `POST /api/trace`, que sigue en el gateway. No crea `diagrams-trace`.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json`, `tests/manifest.test.ts`, `src/shell/manifest.test.ts`, `packages/kernel/src/module/endpoint.test.ts`, `tests/e2e/modules.spec.ts`, `tests/e2e/c4-lienzo-comun.spec.ts`, `tests/e2e/module-canvas.spec.ts` y, en el commit de la traza, `tests/e2e/trace.spec.ts`. Si el manifiesto cambia de versión, también `npm run manifest`.

## Fase 8 · CLI hexagonal, en paralelo al shell

La autoriza la [spec 008](specs/008-cli-hexagonal.md). Va en paralelo a las fases 6 y 7: no comparte proceso con el shell ni con los remotos, y no toca `src/boot.ts`, las HTML ni `src/modules-app`.

No va en paralelo a las fases 1 a 3. Esas PR todavía editan `src/cli/serve.ts`, `src/cli/registry.ts` y `src/cli/workspace.ts`, que el CLI también usa. Empieza cuando esas tres han cerrado, y puede avanzar a la vez que el shell. No entra en la PR del borde ni en la del SSE.

Un proceso. Commander (`src/cli/main.ts`) es el adaptador de entrada. Los puertos son `ModelProvider` (`src/cli/ai.ts`), `RepositoryReader` (`src/cli/repo`), `ProjectStore` (la carpeta de `src/cli/workspace.ts`, no el Postgres de la app) y `Modules` (`src/cli/registry.ts`, `src/cli/plugins`). La IA sigue solo aquí.

No toca `src/cli/serve.ts`, `serveProjects.ts`, `serveEvents.ts`, `serveAuth.ts`, `accounts/`, `observability/`, `securityHeaders.ts` ni `computePool.ts`.

Se verifica con `npm run cli -- validate examples/diagrams-as-is.json`, `npm run cli -- validate` sobre un documento de ejemplo que hoy ya valide, `src/cli/cli.test.ts`, `src/cli/moduleCommands.test.ts`, `src/cli/registry.test.ts`, `tests/plugins-cli.test.ts`, `tests/project-cli.test.ts`, `src/cli/serveSinIa.test.ts` y las pruebas de `src/cli/repo/`.

## Qué queda bloqueado

Hasta que quien mantiene el producto escriba `aceptada` en cada spec, no hay PR de código de esa spec. Hasta que la 001 esté `aceptada`, no hay `examples/diagrams-to-be.json`. Este plan no sustituye ninguna de las dos esperas.

El manifiesto `GET /.well-known/iark.json` no tiene proceso dueño en el corte. Las fases de arriba no se lo asignan. La ruta sigue respondiendo; elegir el proceso es otra decisión.
