# 006 · Shell SPA

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`006-diagrams-shell`

## estado

`en curso`

PR consolidada `cursor/consolidate-rearch-stack-58e1`: un solo `rollupOptions.input` de suite (`index.html`); `/modules/:id` y `/trace` cargan desde `spaRoutes.ts` (e2e alineados en la misma PR); copias legacy en build y fallback en dev; enlaces internos y manifiesto apuntan a rutas canónicas. La federación de la [007](007-microfrontends.md) monta remotos desde el shell; faltan criterios de cierre de esta spec.

## problema

El sitio es una SPA a medias. `index.html` carga `src/boot.ts` y elige la superficie con la consulta (`/?editor=1`, `/?manifest=`, `/?embed=1`). Al lado hay tres entradas de build que no pasan por ese enrutador o que solo redirigen: `modulos.html` (el banco, `banco`), `trazabilidad.html` (`traza-ui`, no pasa por `boot`) y `suite.html` (redirige a `/` con `src/shell/redirect.ts`). Vite las declara todas en `rollupOptions.input` (`vite.config.ts`). El corte pide un solo `diagrams-shell`, con estilo `frontend-spa`, un build y rutas en lugar de esas páginas.

## alcance

- Fijar `diagrams-shell` con el estilo `frontend-spa`.
- Nombrar los features `suite`, `studio`, `projects` y `classic-editor`.
- Nombrar la plataforma que el corte pide y que ECE no devolvió: router (el `boot` de hoy), i18n, project-repository y embed-bridge, colocada en las capas que la card sí nombra.
- Dejar el lienzo como slot de Shared.
- Sustituir `modulos.html`, `trazabilidad.html` y `suite.html` por rutas de un solo build.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Cambiar el estilo del shell a `frontend-mfe-shell`. La composición de remotos es la [spec 007](007-microfrontends.md). Esta spec no extrae `mfe-*`.
- El SDK del anfitrión (`sdk`, `embed-c4`, `embed-modulo`, `web-component`) como remote o como feature. Sigue siendo librería del anfitrión. El puente de dentro de la página (`puente`) sí es el embed-bridge de este shell.
- Reescribir el protocolo `postMessage` (`protocolo`, `src/embed/protocol.ts`, `src/embed/moduleProtocol.ts`). Las rutas nuevas tienen que seguir abriendo el mismo protocolo.
- Los procesos `diagrams-app`, `diagrams-gateway`, `diagrams-identity` y `diagrams-sse`.
- Borrar el editor clásico. Sigue siendo el feature `classic-editor` (`editor`, `src/app`). El estudio (`studio`, `src/studio`) sigue siendo el otro.
- Código de producto y los JSON de modelo en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`sitio`, `boot`, `home`, `studio`, `editor`, `banco`, `shell`, `traza-ui`, `proyectos-web`, `i18n`, `puente`.

## capacidades ECE que aplican

Citas de la [spec 001](001-to-be-c4.md). Esta sesión no repitió `read_document`.

| Para qué | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| Estilo de `diagrams-shell` | `read_document` | `frontend-spa` | `corpus/software/arquitectura-referencia/frontend-spa.md` |
| Contrato de composición, no segundo estilo | `read_document` | `frontend-mfe-shell` | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` |
| Una sola topología frontend | `read_document` | `decision-arquitectonica-gobierno-framework-multi-arquitectura` | `corpus/gobierno/decision-arquitectonica/decision-arquitectonica-gobierno-framework-multi-arquitectura.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

La card de SPA, texto que la 001 copió: «SPA es el estilo de referencia para una aplicación frontend mantenida como una unidad», organizado por feature y no por tipo técnico. `regla-frontend-spa-01`: «un feature nunca depende de otro feature; la comunicación cruzada pasa por Services.» `regla-frontend-spa-02`: «cada feature puede cargarse bajo demanda.» Capas que la card nombra: Features, Core, Security, Services, Shared. «Un feature nunca puede depender de otro feature. Ni Shared ni Core pueden depender de ningún feature.»

Core, en la card, son «capacidades globales de tipo singleton». Services son «Coordinadores de nivel aplicación que cruzan features». Shared es el sitio «sin lógica propia de ningún feature específico».

La card no dice «un contenedor no puede ser spa y a la vez componer remotos». Sí aparta los otros estilos: `mfe-shell` y `mfe-remote` «no son variantes de este estilo, sino estilos de referencia propios, pares entre sí, elegidos por topología de composición federada en vez de por composición standalone». El preludio llama a SPA «estilo de aplicación frontend standalone». El marco pide elegir una topología: `spa`, `mfe-shell` o `mfe-remote`. La orden de Julian es la de la 001: el estilo de este contenedor es `frontend-spa`. Los remotos no se borran; los compone la spec 007.

Los cuatro nombres de plataforma (router, i18n, project-repository, embed-bridge) no los devolvió ECE. La 001 lo dice. No se citan como entidades.

## decisión

Un solo `diagrams-shell`. El estilo es `frontend-spa`. Un build: `index.html` sigue siendo la entrada que carga el enrutador, y `vite.config.ts` deja de declarar `modulos.html`, `trazabilidad.html` y `suite.html` en `rollupOptions.input`. Las páginas de ejemplo del anfitrión (`examples/embed-host.html`, `examples/modules-host.html`, `examples/web-component-host.html`) no son el shell; si apuntan a `modulos.html`, la misma PR actualiza esa URL. No son un segundo build de la suite.

### Capas, con los nombres del corte

| Capa de la card | Qué pone el corte | Id as-is y código de hoy |
|---|---|---|
| Features | `suite`, `studio`, `projects`, `classic-editor` | `home` (`src/home`), `studio` (`src/studio`), la superficie de proyectos que hoy abre `home` junto con el cliente, `editor` (`src/app`) |
| Core | Router, que es el `boot` de hoy, e i18n | `boot` (`src/boot.ts`), `i18n` (`src/i18n`) |
| Services | project-repository y embed-bridge | `proyectos-web` (`src/projects`), `puente` (el lado de la página en `src/embed`) |
| Shared | El lienzo, como slot | El lienzo de `src/modules-app/canvas`. Sin lógica de un feature concreto. |
| Security | La capa de la card | Consume `diagrams-identity`. No es un proceso ni un remoto. |

Un feature no importa otro feature. `studio` y `classic-editor` no se importan entre sí. Los dos hablan con proyectos a través de project-repository, no a través del feature `projects`. El feature `projects` es la superficie de listar y abrir. El servicio `proyectos-web` es quien tiene IndexedDB, el cliente HTTP y la cola sin red.

El lienzo es slot. `studio` lo usa, como hoy el estudio reutiliza el lienzo del banco (`r-studio-banco`), y no se queda una segunda copia. `banco` deja de ser la página `modulos.html`. Su contenido actual entra por la ruta del slot. Los seis editores de especialidad pueden seguir dentro de ese slot hasta la spec 007: no son features de este shell y esta spec no los convierte en remotos. `traza-ui` deja de ser `trazabilidad.html` y pasa a la ruta de traza, todavía con `src/trace-app`, hasta que la spec 007 la saque a `mfe-trace`.

`shell` (`src/shell`), el que hoy solo arranca con `/?manifest=`, queda en el router de esta SPA: el shell es dueño del árbol de navegación. Descubrir remotos por manifiesto, sin imports fijos, es el contrato que la spec 007 escribe. Esta spec conserva `/?manifest=` como entrada de esa navegación y no reescribe el interior de un remoto, porque aún no hay remotos.

### Rutas que sustituyen a las páginas

El router acepta estas rutas como canónicas:

| Ruta | Feature o superficie | Sustituye a |
|---|---|---|
| `/` | `suite` | `index.html` en `/`, y a `suite.html` |
| `/studio` | `studio` | `/?editor=1` |
| `/projects` | `projects` | la lista de proyectos que hoy vive en el inicio |
| `/editor` | `classic-editor` | `/?editor=1&classic=1` |
| `/modules/:moduleId` | el slot | `modulos.html?module=<id>` |
| `/trace` | la traza, aún `traza-ui` | `trazabilidad.html` |

Las consultas que el as-is y el SDK ya envían siguen resolviendo en la misma SPA, para no partir el protocolo en esta PR: `/?editor=1` abre el estudio, `/?editor=1&classic=1` abre el clásico, `/?embed=1` sigue mandando el embebido como manda hoy `src/boot.ts`, `/?surface=home&embed=1` abre el inicio embebido, `/?manifest=` sigue leyendo el manifiesto. `?classic=1` a solas sigue cayendo en la suite. La PR actualiza los llamadores de dentro del repo (el manifiesto en `src/cli/suiteManifest.ts` que hoy apunta a `../modulos.html`, el SDK en `src/embed/iark-module-embed.ts`, las e2e y `scripts/perf/limites.ts`) para que la ruta canónica sea la de la tabla. El protocolo de mensajes no cambia.

`suite.html` no sale del build. Quien pida `/suite.html` recibe la misma SPA y el router lo lleva a `/`, que es lo que `src/shell/redirect.ts` ya hace.

Security pide la sesión o el token a identity. No guarda cuentas. El estado global de «hay sesión» cabe en Core, que es donde la card pone el estado global, y los features lo leen de ahí, no unos de otros.

## alternativas descartadas

- Dejar el shell en `frontend-mfe-shell`.
- Un estilo «feature-based shell» además de `frontend-spa`. La búsqueda que la 001 registró no encontró esa card.
- Borrar los remotos porque la card de SPA separa la composición federada. Los remotos siguen, en la spec 007, y el estilo de este contenedor es uno.
- Mantener `modulos.html`, `trazabilidad.html` y `suite.html` como entradas de Rollup «por compatibilidad» y llamar a eso un build.
- Hacer de `banco` y de `traza-ui` dos features más. El corte nombra cuatro features. El banco es el slot; la traza espera a `mfe-trace`.
- Meter el SDK del anfitrión dentro del shell. Corre en la página del anfitrión.
- Cambiar los cuerpos de `postMessage` en la misma PR que cambia las rutas.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. El as-is no cambia. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
3. Las capacidades citan `frontend-spa` con `read_document` y el `path` de la spec 001. Dicen que `frontend-mfe-shell` no es el estilo de este contenedor.
4. La decisión nombra los cuatro features, el router como el `boot` actual, i18n, project-repository, embed-bridge y el lienzo como slot, y sustituye las tres páginas HTML por las rutas de la tabla.
5. Los ids citados están en `examples/diagrams-as-is.json`. Los cuatro nombres de plataforma no se presentan como entidades ECE.

De la implementación, solo con la spec `aceptada` y en su PR:

1. `vite.config.ts` tiene una sola entrada HTML de la suite. `modulos.html`, `trazabilidad.html` y `suite.html` no están en `rollupOptions.input`.
2. Las seis rutas de la tabla abren la superficie que la tabla dice. `/?editor=1` sigue abriendo el estudio y `/?editor=1&classic=1` el clásico, como ya separan `tests/e2e/studio-marco.spec.ts` y `tests/e2e/canvas-helpers.ts`.
3. Ningún feature importa otro feature. El lienzo vive en Shared.
4. No aparece un remote `mfe-*` en esta PR. `src/trace-app` puede seguir montado en `/trace`.
5. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada.
6. Pasan `tests/e2e/suite.spec.ts`, `tests/e2e/studio-marco.spec.ts`, `tests/e2e/navigation-and-layout.spec.ts`, `tests/e2e/embed.spec.ts`, `tests/e2e/idioma.spec.ts`, `tests/e2e/tamano-trozos.spec.ts`, `src/shell/manifest.test.ts` y `src/i18n/core.test.ts`. `tests/e2e/trace.spec.ts` y `tests/e2e/modules.spec.ts` pasan contra la ruta nueva, todavía sin remoto.
7. La PR deja la spec en `en curso` y luego en `hecha`. No mezcla la 007.

## verificación

Borrador, sin implementación. Las citas salen de la spec 001. Esta sesión no llamó al puente. `GetDynamicTools` con patrón `ece` no devolvió namespace. No se imprimen `ECE_MCP_API_KEY` ni `ECE_MCP_URL`.

Las tres entradas HTML y el `input` de Vite se contrastaron con `vite.config.ts`, `index.html`, `modulos.html`, `trazabilidad.html` y `suite.html`, que existen en el árbol. No se arrancó el sitio.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprime nada.

## riesgos

- Tratar el shell como si tuviera a la vez el estilo `frontend-spa` y el estilo `frontend-mfe-shell`. El marco pide una sola elección. El estilo escrito aquí es `frontend-spa`. El contrato de composición se usa en la spec 007 sin cambiar este estilo.
- Dejar el banco como feature encubierto dentro del slot y acoplar las seis especialidades al shell para siempre. La spec 007 las saca. Esta PR no debe añadir imports nuevos entre especialidades.
- Romper el embebido al quitar `modulos.html` si el SDK, el manifiesto o un anfitrión externo siguen apuntando a esa página. La PR actualiza los llamadores del repo y conserva las consultas de `boot`. Un anfitrión que tenga la URL vieja grabada necesita la ruta o un redirect, y eso se prueba con `tests/e2e/embed.spec.ts`.
- Partir `suite.html` sin redirect y romper enlaces ya publicados en Pages.
