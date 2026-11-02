# 001 · To-be C4

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 000](000-conexion-ece.md)

## id

`001-to-be-c4`

## estado

`borrador`

Nace en `borrador`. La [spec 000](000-conexion-ece.md) sigue en `borrador`: el descubrimiento de la sesión no tiene un namespace ECE. El [protocolo](../protocolo-sdd.md) deja esta spec bloqueada hasta que 000 esté `hecha`. El usuario autorizó consumir el puente directo en esta sesión para no perder el contexto. Esta página no pasa a `aceptada`, `en curso` ni `hecha`. No crea el JSON to-be.

## problema

En el as-is, `iark serve` es un solo proceso. El contenedor `servicio` concentra la API de módulos, los proyectos, las cuentas, los tokens, los avisos, la observabilidad y, si se pide, el sitio estático. El sitio elige la superficie en `boot` y solo con `/?manifest=` abre otro shell. Un rediseño que nombre estilos sin la definición que ECE devolvió se inventa el contrato de cada contenedor.

## alcance

- Fijar el corte de contenedores to-be acordado con Julian.
- Para cada estilo que ese corte nombra, citar la herramienta o el recurso real y el `entity_id` o `path` que devolvió la llamada. La definición del estilo es la de esa cita.
- Dejar escrito el hueco cuando la consulta no devuelve el estilo nombrado. Ese hueco no se rellena con otra card.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Crear `examples/diagrams-to-be.json` o cualquier otro JSON de modelo. El protocolo lo reserva para cuando esta spec esté `aceptada`.
- Editar `examples/diagrams-as-is.json`.
- Código de producto: `src/`, `packages/`, `schema/`, `public/`, pruebas, imagen y `deploy/`.
- Marcar esta spec o la 000 como `aceptada`, `en curso` o `hecha`.
- Portar el producto a Angular, .NET o las plantillas Copier que las cards de ECE usan como materialización.
- Elegir features internas del gateway más allá de las que el corte ya nombra (borde, piscina, traza URN).

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita. El corte los reubica cuando esta spec avance; aquí solo se nombran.

Personas y sistema: `arquitecto`, `operador`, `administrador`, `anfitrion`, `diagrams`. Externos que siguen: `github`, `proveedor-ia`, `repositorio`, `proxy`, `prometheus`.

Contenedores: `sitio`, `sdk`, `cli`, `servicio`, `nucleo`, `proyectos`, `cuentas`.

Sitio: `boot`, `home`, `studio`, `editor`, `banco`, `shell`, `traza-ui`, `proyectos-web`, `i18n`, `puente`.

SDK: `embed-c4`, `embed-modulo`, `web-component`, `protocolo`.

CLI: `comandos`, `registro-cli`, `ia-cli`, `repo-cli`, `workspace-cli`, `plugins-cli`.

Servicio: `http`, `api-modulos`, `api-proyectos`, `tokens`, `cuentas-gh`, `sse`, `obs`, `pool`, `estaticos`, `cabeceras`.

Núcleo: `contrato`, `urn`, `diff`, `proyecto-modelo`, `ia-kernel`, `grafo`, `mod-c4`, `mod-integration`, `mod-data`, `mod-enterprise`, `mod-platform`, `mod-security`.

## capacidades ECE que aplican

Las herramientas y el recurso están en [ece-capacidades.md](../ece-capacidades.md). Los `entity_id` y los `path` salen de las llamadas de esta sesión (puente stdio, caché apagada). `get_related` sobre las siete arquitecturas de referencia devolvió `groups: []`.

El listado `search_catalog` con `type` `arquitectura-referencia` y sin `query` devolvió `total` 7. Son el catálogo cerrado de estilos de referencia:

| `entity_id` | `path` |
|---|---|
| `backend-nano` | `corpus/software/arquitectura-referencia/backend-nano.md` |
| `backend-hexagonal` | `corpus/software/arquitectura-referencia/backend-hexagonal.md` |
| `backend-coredomain` | `corpus/software/arquitectura-referencia/backend-coredomain.md` |
| `frontend-spa` | `corpus/software/arquitectura-referencia/frontend-spa.md` |
| `frontend-mfe-shell` | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` |
| `frontend-mfe-remote` | `corpus/software/arquitectura-referencia/frontend-mfe-remote.md` |
| `gateway-feature-based` | `corpus/software/arquitectura-referencia/gateway-feature-based.md` |

El marco que los ordena es `decision-arquitectonica-gobierno-framework-multi-arquitectura`, path `corpus/gobierno/decision-arquitectonica/decision-arquitectonica-gobierno-framework-multi-arquitectura.md` (`read_document`). Ahí el backend progresa `Nano (Host+Core)` → `Hexagonal (Host+Core+Infrastructure)` → `CoreDomain (DDD + CQRS)`. El frontend se elige por topología: `spa`, `mfe-shell` o `mfe-remote`, exactamente una. El gateway tiene un solo estilo, Feature-Based, y la tabla de materialización dice NestJS. La misma card dice que el estilo es un contrato agnóstico de tecnología y que la implementación es reemplazable.

`traverse_knowledge` con consulta `CodeDomain monolito modular` y con consulta `arquitectura hexagonal` trajo como `must_load` el principio `principio-arquitectura-arquitectura-primero`, path `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md`. Obliga a evaluar la complejidad del dominio antes de elegir estilo y a documentar C4 antes de generar código. Esta spec es ese registro, en borrador. No autoriza scaffold.

### Estilos que el corte usa

| Contenedor to-be | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| `diagrams-gateway` | `read_document` tras `search_catalog` | `gateway-feature-based` | `corpus/software/arquitectura-referencia/gateway-feature-based.md` |
| `diagrams-gateway` (materialización NestJS) | `read_document` | `decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad` | `corpus/gateway-nestjs/decision-arquitectonica/decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad.md` |
| `diagrams-gateway` (carpetas) | `read_document` | `convencion-gateway-nestjs-feature-structure` | `corpus/gateway-nestjs/convencion/convencion-gateway-nestjs-feature-structure.md` |
| `diagrams-shell` | `read_document` | `frontend-mfe-shell` | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` |
| Organización interna por feature, que el shell conserva | `read_document` | `frontend-spa` | `corpus/software/arquitectura-referencia/frontend-spa.md` |
| Cada `mfe-*` | `read_document` | `frontend-mfe-remote` | `corpus/software/arquitectura-referencia/frontend-mfe-remote.md` |
| Contrato shell ↔ remote | `read_document` | `convencion-frontend-angular-mfe-structure` | `corpus/frontend-angular/convencion/convencion-frontend-angular-mfe-structure.md` |
| CLI | `read_document` | `backend-hexagonal` | `corpus/software/arquitectura-referencia/backend-hexagonal.md` |

`convencion-frontend-angular-mfe-structure` dice que shell y remote se organizan por dentro como la SPA feature-based y que la federación es una capa de composición. El estilo del contenedor `diagrams-shell` es uno: `frontend-mfe-shell`. `frontend-spa` no es un segundo estilo del mismo contenedor.

### Huecos

Consultas hechas y lo que volvió. Ninguna de estas filas define el estilo del contenedor.

| Consulta | Qué devolvió la llamada | Qué no apareció |
|---|---|---|
| `search_catalog` `query` `monolito modular` | `practica-arquitectura-mantenibilidad` (`corpus/arquitectura/practica/practica-arquitectura-mantenibilidad.md`, relevancia 0.44) y ADRs de módulos Angular | Una entidad titulada monolito modular |
| `search_catalog` `query` `modular monolith` | `ADR-001: MVVM + SPM Modular Architecture` y `ADR-001: Feature-Based Modular Architecture for SDUI BFF` | Un estilo de monolito modular |
| `search_catalog` `type` `pattern` con `query` (CodeDomain, monolito, hexagonal, gateway, shell, microfrontend, feature-based) | `scope_note`: la búsqueda semántica solo alcanza entidades de tipo `doc`; filtrar por `pattern` no casa. `total` 0 | — |
| `search_catalog` `query` `CodeDomain` | `backend-coredomain`, path `corpus/software/arquitectura-referencia/backend-coredomain.md` | CodeDomain como monolito por dominios. La card es DDD táctico y CQRS, cuatro capas (Host, Application, Domain, Infrastructure), consultas que no pasan por el dominio |
| `search_catalog` `query` `separación Host Core` | `antipatron-arquitectura-core-host-coupling` y `decision-arquitectonica-backend-dotnet-separacion-host-core` | Un Host+Core de varios contextos. En el marco, Host+Core es el nombre de Nano |
| `read_document` de `backend-nano` | Un problema funcional acotado, dos capas (Host y Core), sin puertos | Módulos `accounts` y `access-tokens` |
| `read_document` de `decision-arquitectonica-backend-dotnet-separacion-host-core` | Extension methods `Add{Module}Services` sobre `IServiceCollection`, Core sin `Microsoft.AspNetCore.*` | Un mecanismo para el proceso Node de identidad |
| `search_catalog` `query` `shell frontend por features` | Primer resultado `frontend-mfe-shell` | Un estilo llamado feature-based shell, distinto de `frontend-mfe-shell` y de `frontend-spa` |
| `search_catalog` `query` `server sent events servicio tiempo real` | Documento `sistedocs:ingenieria-de-software/integraciones/server-sent-events/v1.0/lineamientos-sse.md` | Un servicio o contenedor SSE. La sección «Lineamientos generales > Arquitectura y diseño» pide servicios de conexión dentro de las features que los usan |
| `search_catalog` `query` `observabilidad health métricas request id` | `decision-arquitectonica-plataforma-10-observability-stack`, path `corpus/plataforma/decision-arquitectonica/decision-arquitectonica-plataforma-10-observability-stack.md` | Un estilo de proceso. El cuerpo de la decisión es el título «Stack de observabilidad (logs, metrics, traces)», card sembrada desde LeanIX |
| `read_document` de `decision-arquitectonica-software-01-arquitectura-hexagonal` | Título «Arquitectura hexagonal para backend», sin puertos ni capas | La definición. Esa definición está en `backend-hexagonal` |
| `read_document` de `Factoria-Ang/.cloud/architecture/decisions/ADR-004-module-federation.md` | `@angular-architects/module-federation`, manifiesto `libs/config/microfrontends.json` | El manifiesto `iark.manifest/1` del producto |

`get_source_status` devolvió `status` `ready`, `docs_indexed` 16189, `graph_reachable` true, `stale_sources` vacío. `architecture-knowledge` está `operativa`. `github` está `degradada` (`verdict_reason`: la última operación real falló con `source_error`). El mapa `resources/read` de `ece://navegacion` fija el orden: localizar, y solo entonces leer.

## decisión

El corte de procesos es el acordado. El estilo de un contenedor queda definido solo cuando una card de ECE lo dice y el corte cabe en esa card. Donde la tabla de huecos tiene fila, el corte sigue y el estilo queda sin definir.

### `diagrams-app`

`servicio` junto con `api-proyectos` pasa a un proceso `diagrams-app`. El módulo de ese proceso que persiste diagramas se llama `projects`. El almacén `proyectos` deja de ser contenedor y queda dentro de este proceso.

ECE no define el estilo de ese proceso. `backend-coredomain` es el punto alto del espectro backend: dominio con invariantes fuertes, cuatro capas, escrituras que pasan por el dominio y lecturas que no. El preludio lo llama el estilo de mayor ceremonia, no un monolito por módulos. No se aplica esa card a `diagrams-app`.

`sse` entra en el mismo proceso como módulo `realtime`. El lineamiento SSE no crea un servicio aparte y no lo llama gateway: organiza la conexión dentro de las features que la usan, separada de la lógica de negocio. El nombre `realtime` es el del corte, no un `entity_id`.

### `diagrams-gateway`

`api-modulos` pasa a `diagrams-gateway`. Es el borde único hacia la API de módulos. El estilo es `gateway-feature-based`: traductor de protocolos y agregador, organizado por feature, sin persistencia propia ni invariantes de dominio. Un feature no depende de otro feature; `shared/` no depende de ningún feature. La materialización que la card y el ADR NestJS nombran es BFF NestJS por funcionalidad: carpetas `features/`, sin layer-folders `1-api/`, `2-infrastructure/`, `3-application/`, y handlers HTTP dentro de cada feature.

La piscina `pool` vive en este proceso por el corte acordado. La card de gateway no la nombra. Su sección de evolución saca hacia un backend la lógica de dominio que aparezca dentro del gateway. La traza URN (`urn`, hoy bajo `api-modulos` y `pool`) es una feature de este gateway por el corte acordado. No es un servicio de operación y no hay una card que la defina.

`cabeceras` no es un servicio. Las aplica el `proxy` y este gateway.

### `diagrams-identity`

`tokens` y `cuentas-gh` pasan a `diagrams-identity`, con módulos `accounts` y `access-tokens`. El almacén `cuentas` deja de ser contenedor y queda dentro de este proceso. Gateway y app solo validan.

El nombre Host+Core, en ECE, es Nano: `backend-nano`, un contexto funcional, capas Host y Core, sin puertos. Dos módulos no salen de esa card, así que el estilo Nano no se da por aplicado. El ADR de separación Host/Core es el mecanismo DI de .NET y no se copia a este proceso. El antipatrón `antipatron-arquitectura-core-host-coupling` sí acompaña cualquier corte Host/Core: el Core no referencia tipos del Host.

### Observabilidad

`obs` no se renombra `diagrams-trace`. Ese nombre choca con la traza URN. No hay contenedor nuevo de observabilidad. Salud en cada proceso. Métricas y el id de petición, en una librería común. Auditoría en identity y en `projects`. `prometheus` sigue raspando métricas.

La card `decision-arquitectonica-plataforma-10-observability-stack` no define ese reparto: el texto de la decisión repite el título. La convención NestJS del gateway dice que los building blocks `@siste/nestjs-*` cubren la observabilidad de ese BFF. Esos paquetes no son la librería de DIAgrams.

### Estáticos

`estaticos` sale de `diagrams-app`. El build lo sirve Pages, que en el as-is ya es `github` (`r-gh-sitio`). No hay un estilo ECE para ese destino.

### `diagrams-shell` y microfrontends

Un solo `diagrams-shell`. Existe un shell por composición (`frontend-mfe-shell`): descubre remotos por un manifiesto configurable por entorno, es dueño del árbol de rutas y monta cada remoto por el contrato de rutas, sin conocer su interior. Features de producto dentro de ese shell: `suite`, `studio`, `projects`, `classic-editor`. Plataforma del shell, con el nombre del componente as-is entre paréntesis: router (`boot`), i18n (`i18n`), project-repository (`proyectos-web`), embed-bridge (`puente`). El lienzo es un slot del shell. Esos cuatro nombres de plataforma no los devuelve ECE.

ECE no tiene un estilo «feature-based shell». La organización por feature es la de `frontend-spa` (`regla-frontend-spa-01`: un feature no depende de otro; la comunicación cruza por Services). El texto de `frontend-spa` dice que `mfe-shell` y `mfe-remote` conservan esa organización y son estilos distintos. El marco exige exactamente un estilo de frontend por componente. El de `diagrams-shell` es `frontend-mfe-shell`.

La card del shell dice que su responsabilidad central es orquestar, no resolver un dominio de negocio propio. `suite`, `studio`, `projects` y `classic-editor` son superficies de producto del corte. Cómo conviven con esa frase no lo cierra ninguna card leída.

Microfrontends, estilo `frontend-mfe-remote`: `mfe-c4`, `mfe-integration`, `mfe-data`, `mfe-enterprise`, `mfe-platform`, `mfe-security`, `mfe-trace`. Cada uno expone rutas, no componentes sueltos (`convencion-frontend-angular-mfe-structure`). Un remote no importa a otro ni a quien lo compone. El manifiesto concreto de Factoría (`microfrontends.json`, Webpack, ADR-004) es la materialización Angular, no el contrato `iark.manifest/1`.

El `sdk` sigue siendo librería del anfitrión (`anfitrion`), no un remote.

### CLI

Un proceso, el `cli`. El estilo es `backend-hexagonal`: Host, Core con puertos, Infrastructure que implementa esos puertos. Core no depende de Host ni de Infrastructure. `comandos` (commander) es el Host: valida la entrada y delega. Los puertos del Core, con los nombres del corte, son `ModelProvider`, `RepositoryReader`, `ProjectStore` y `Modules`. Esos identificadores no los devuelve ECE. La IA sigue solo en este proceso (`ia-cli`, `proveedor-ia`). El marco clasifica hexagonal como vertical backend y no nombra una vertical CLI.

### Núcleo

`nucleo` y los paquetes `@iark/*` siguen siendo librería, no un proceso. Un módulo no importa a otro. El enlace entre especialidades sigue siendo la URN.

## alternativas descartadas

- Dar por definido un monolito modular o un CodeDomain de módulos de dominio. La card `backend-coredomain` describe otra arquitectura.
- Aplicar Nano a `diagrams-identity` con dos módulos, o copiar los extension methods de .NET.
- Llamar `diagrams-trace` al reparto de `obs`, o crear un proceso de observabilidad porque el título de la card de plataforma dice «stack».
- Un proceso `diagrams-sse` o colgar el SSE del gateway. El lineamiento no define un servicio y el corte lo deja en `diagrams-app`.
- Servir `estaticos` desde `diagrams-app`, o hacer de `cabeceras` un servicio.
- Un estilo «feature-based shell» además de `frontend-mfe-shell`.
- Tratar ADR-004 o `federation.manifest.json` de Angular como el manifiesto del producto.
- Usar la card LeanIX `decision-arquitectonica-software-01-arquitectura-hexagonal` como definición de puertos. El cuerpo no los trae.
- Crear `examples/diagrams-to-be.json` en este borrador.
- Pasar la spec 000 a `hecha` solo porque el puente respondió. El descubrimiento de la sesión sigue sin namespace ECE.

## criterios de aceptación comprobables

1. En `docs/arquitectura/specs/001-to-be-c4.md`, la línea de la sección estado es `` `borrador` ``.
2. La spec 000 sigue en `borrador`.
3. No existe `examples/diagrams-to-be.json`. `examples/diagrams-as-is.json` no cambia. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos.
4. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
5. Cada estilo marcado como aplicado en la decisión tiene en «capacidades ECE que aplican» un `entity_id` y un `path` que una llamada de la verificación devolvió.
6. La decisión deja sin estilo ECE: el interior de `diagrams-app`, el Nano de dos módulos en identity, el reparto de observabilidad, el módulo de nombre `realtime`, los cuatro bloques de plataforma del shell y los nombres de puertos del CLI.
7. Los ids de «elementos del as-is que toca» están en `examples/diagrams-as-is.json`.

## verificación

Puente: `python3 scripts/mcp-ece.py --no-cache` con stdio NDJSON y `protocolVersion` `2025-03-26`. `scripts/mcp_ece.py` hace `exec` de ese puente y no reenvía argumentos; la clave y la URL ya estaban en el entorno. No se imprimen. Caché apagada. `initialize` negoció `2025-03-26`, `serverInfo.name` `ece-knowledge-router`, `serverInfo.version` `0.1.0`. El stderr, ya sin URL, fue `cache=off (--no-cache)` y `ca=system`.

`GetDynamicTools` con patrón `ece` no devolvió namespace. La spec 000 no cambia de estado por eso.

`resources/read` `ece://navegacion`: un contenido `text/markdown`, uri `ece://navegacion`, título de sección «Vocabulario del grafo».

`get_source_status`: `status` `ready`, `docs_indexed` 16189, `graph_reachable` true, `health_surface.available` true, `stale_sources` `[]`. Fuentes: `architecture-knowledge` operativa, `leanix` operativa, `sistedocs` operativa, `leanix-views` operativa, `github` degradada, `sc-mcp-factoria` operativa.

Extracto de las lecturas que definen estilo (`read_document`, `mode` `full`, `truncated` false, sin `metadata.error`):

| `entity_id` | Título que devolvió la llamada | `path` |
|---|---|---|
| `backend-coredomain` | Backend CoreDomain | `corpus/software/arquitectura-referencia/backend-coredomain.md` |
| `backend-hexagonal` | Backend Hexagonal | `corpus/software/arquitectura-referencia/backend-hexagonal.md` |
| `backend-nano` | Backend Nano | `corpus/software/arquitectura-referencia/backend-nano.md` |
| `frontend-spa` | Frontend SPA | `corpus/software/arquitectura-referencia/frontend-spa.md` |
| `frontend-mfe-shell` | Frontend MFE Shell | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` |
| `frontend-mfe-remote` | Frontend MFE Remote | `corpus/software/arquitectura-referencia/frontend-mfe-remote.md` |
| `gateway-feature-based` | Gateway Feature-Based | `corpus/software/arquitectura-referencia/gateway-feature-based.md` |
| `decision-arquitectonica-gobierno-framework-multi-arquitectura` | Framework Multi-Arquitectura Verticales Estilos Implementacion | `corpus/gobierno/decision-arquitectonica/decision-arquitectonica-gobierno-framework-multi-arquitectura.md` |
| `decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad` | Estructura Gateway BFF NestJS por Funcionalidad | `corpus/gateway-nestjs/decision-arquitectonica/decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad.md` |
| `convencion-gateway-nestjs-feature-structure` | Feature-Based Structure — BFF NestJS | `corpus/gateway-nestjs/convencion/convencion-gateway-nestjs-feature-structure.md` |
| `convencion-frontend-angular-mfe-structure` | Estructura MFE — Shell y Remote | `corpus/frontend-angular/convencion/convencion-frontend-angular-mfe-structure.md` |
| `principio-arquitectura-arquitectura-primero` | Arquitectura-Primero | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |
| `decision-arquitectonica-backend-dotnet-separacion-host-core` | Separación Host/Core y Composición DI vía Extension Methods | `corpus/backend-dotnet/decision-arquitectonica/decision-arquitectonica-backend-dotnet-separacion-host-core.md` |
| `antipatron-arquitectura-core-host-coupling` | Core to Host Coupling | `corpus/arquitectura/antipatron/antipatron-arquitectura-core-host-coupling.md` |
| `decision-arquitectonica-plataforma-10-observability-stack` | Stack de observabilidad (logs, metrics, traces) | `corpus/plataforma/decision-arquitectonica/decision-arquitectonica-plataforma-10-observability-stack.md` |
| `decision-arquitectonica-software-01-arquitectura-hexagonal` | Arquitectura hexagonal para backend | `corpus/software/decision-arquitectonica/decision-arquitectonica-software-01-arquitectura-hexagonal.md` |

El lineamiento SSE se leyó con `mode` `section` y `section` `Lineamientos generales > Arquitectura y diseño` (`truncated` false, 1 de 20 secciones). El documento es `sistedocs:ingenieria-de-software/integraciones/server-sent-events/v1.0/lineamientos-sse.md`, path `ingenieria-de-software/integraciones/server-sent-events/v1.0/lineamientos-sse.md`. ADR-004 se leyó en `Factoria-Ang/.cloud/architecture/decisions/ADR-004-module-federation.md`, título `ADR-004: Module Federation for Micro-Frontends`.

Los JSON de respuesta, sin la URL ni la clave, quedaron en `/opt/cursor/artifacts/ece-estilo-*.json`.

Órdenes de esta sesión sobre el repo:

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprimió nada.

## riesgos

- Leer `backend-coredomain` como si fuera el monolito de `diagrams-app`. La card es el otro extremo del espectro.
- Declarar Nano cumplido con `accounts` y `access-tokens`. La card pide un solo contexto.
- Dejar la piscina y la traza URN en el gateway cuando la card saca de ahí la lógica de dominio. El corte lo hace igual; la card no lo respalda.
- Tratar `suite`, `studio`, `projects` y `classic-editor` como si el shell de ECE fuera dueño de dominios de negocio. La card dice que orquesta.
- Copiar el manifiesto Angular o los building blocks `@siste/nestjs-*` al repo de DIAgrams.
- La fuente `github` del MCP estaba degradada. Nada de lo citado depende de esa fuente.
- Redactar esta spec con 000 todavía en `borrador`. Quien la acepte tiene que mirar si el descubrimiento de la sesión ya muestra el namespace ECE, que aquí no apareció.
