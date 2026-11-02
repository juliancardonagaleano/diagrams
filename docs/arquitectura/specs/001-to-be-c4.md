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
- Dejar escrito lo que la llamada no devolvió. Si Julian asigna una card que la llamada sí devolvió, esa card es el estilo. No se rellena un hueco con una card que la consulta no trajo.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Crear `examples/diagrams-to-be.json` o cualquier otro JSON de modelo. El protocolo lo reserva para cuando esta spec esté `aceptada`.
- Editar `examples/diagrams-as-is.json`.
- Código de producto: `src/`, `packages/`, `schema/`, `public/`, pruebas, imagen y `deploy/`.
- Marcar esta spec o la 000 como `aceptada`, `en curso` o `hecha`.
- Portar el producto a Angular, .NET o las plantillas Copier que las cards de ECE usan como materialización.
- Elegir features internas de los gateways más allá de las que el corte ya nombra: en `diagrams-gateway`, borde, piscina y traza URN; en `diagrams-sse`, el canal de avisos que hoy es `sse`.

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

Esta sesión releyó con `read_document` las cards del corte nuevo. La materialización NestJS, la convención de carpetas, la convención MFE y `backend-hexagonal` siguen siendo las lecturas de la sesión anterior: no se volvieron a pedir.

| Contenedor to-be | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| `diagrams-app` | `read_document` | `backend-coredomain` | `corpus/software/arquitectura-referencia/backend-coredomain.md` |
| `diagrams-identity` | `read_document` | `backend-nano` | `corpus/software/arquitectura-referencia/backend-nano.md` |
| `diagrams-shell` | `read_document` | `frontend-spa` | `corpus/software/arquitectura-referencia/frontend-spa.md` |
| `diagrams-gateway` y `diagrams-sse` | `read_document` | `gateway-feature-based` | `corpus/software/arquitectura-referencia/gateway-feature-based.md` |
| `diagrams-gateway` (materialización NestJS) | `read_document` (sesión anterior) | `decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad` | `corpus/gateway-nestjs/decision-arquitectonica/decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad.md` |
| `diagrams-gateway` (carpetas) | `read_document` (sesión anterior) | `convencion-gateway-nestjs-feature-structure` | `corpus/gateway-nestjs/convencion/convencion-gateway-nestjs-feature-structure.md` |
| Contrato de composición, no estilo de `diagrams-shell` | `read_document` | `frontend-mfe-shell` | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` |
| Cada `mfe-*` | `read_document` | `frontend-mfe-remote` | `corpus/software/arquitectura-referencia/frontend-mfe-remote.md` |
| Contrato shell ↔ remote | `read_document` (sesión anterior) | `convencion-frontend-angular-mfe-structure` | `corpus/frontend-angular/convencion/convencion-frontend-angular-mfe-structure.md` |
| CLI | `read_document` (sesión anterior) | `backend-hexagonal` | `corpus/software/arquitectura-referencia/backend-hexagonal.md` |
| Por qué no hay proceso de observabilidad | `read_document` | `decision-arquitectonica-plataforma-10-observability-stack` | `corpus/plataforma/decision-arquitectonica/decision-arquitectonica-plataforma-10-observability-stack.md` |

`convencion-frontend-angular-mfe-structure`, leída en la sesión anterior, dice que shell y remote se organizan por dentro como la SPA feature-based y que la federación es una capa de composición. El estilo del contenedor `diagrams-shell` es uno: `frontend-spa`. `frontend-mfe-shell` no es un segundo estilo del mismo contenedor. Se releyó para conservar el contrato con el que ese SPA compone remotos.

### Huecos

Consultas hechas y lo que volvió. Una fila dice qué no trajo la llamada. No asigna el estilo: lo asigna la decisión cuando Julian nombra una card que sí se leyó.

Las búsquedas de la tabla son las de la sesión anterior. Esta sesión releyó los `read_document` de `backend-coredomain`, `backend-nano`, `frontend-spa`, `frontend-mfe-shell`, `frontend-mfe-remote`, `gateway-feature-based`, el lineamiento SSE y la card de observability-stack. Esas relecturas no cambiaron el hueco: siguen sin aparecer un título «monolito modular», los nombres `accounts` y `access-tokens`, un proceso SSE y un proceso de observabilidad.

| Consulta | Qué devolvió la llamada | Qué no apareció |
|---|---|---|
| `search_catalog` `query` `monolito modular` | `practica-arquitectura-mantenibilidad` (`corpus/arquitectura/practica/practica-arquitectura-mantenibilidad.md`, relevancia 0.44) y ADRs de módulos Angular | Una entidad titulada monolito modular |
| `search_catalog` `query` `modular monolith` | `ADR-001: MVVM + SPM Modular Architecture` y `ADR-001: Feature-Based Modular Architecture for SDUI BFF` | Un estilo de monolito modular |
| `search_catalog` `type` `pattern` con `query` (CodeDomain, monolito, hexagonal, gateway, shell, microfrontend, feature-based) | `scope_note`: la búsqueda semántica solo alcanza entidades de tipo `doc`; filtrar por `pattern` no casa. `total` 0 | — |
| `search_catalog` `query` `CodeDomain` y `read_document` de `backend-coredomain` | La card DDD táctico y CQRS: cuatro capas (Host, Application, Domain, Infrastructure) y consultas que no pasan por el dominio. Esta sesión: título `backend-coredomain: Backend CoreDomain`, `truncated` false | Una card que pida un módulo por bounded context, y una card titulada monolito modular. El corte aplica igual `backend-coredomain` al único módulo que queda |
| `search_catalog` `query` `separación Host Core` | `antipatron-arquitectura-core-host-coupling` y `decision-arquitectonica-backend-dotnet-separacion-host-core` | Un Host+Core de varios contextos. En el marco, Host+Core es el nombre de Nano |
| `read_document` de `backend-nano` | «un único contexto», «exactamente dos capas» (Host y Core), «No hay capa de infraestructura separada ni puertos explícitos». Esta sesión: título `backend-nano: Backend Nano`, `truncated` false | Los nombres `accounts` y `access-tokens`. La lectura de Julian que los autoriza está en la decisión, no en la card |
| `read_document` de `decision-arquitectonica-backend-dotnet-separacion-host-core` | Extension methods `Add{Module}Services` sobre `IServiceCollection`, Core sin `Microsoft.AspNetCore.*` | Un mecanismo para el proceso Node de identidad |
| `read_document` de `frontend-spa` | SPA como «aplicación frontend mantenida como una unidad». `mfe-shell` y `mfe-remote` «no son variantes de este estilo» y se eligen «por topología de composición federada en vez de por composición standalone». Esta sesión: título `frontend-spa: Frontend SPA`, `truncated` false | La frase «un contenedor no puede ser spa y a la vez componer remotos». No está. El preludio sí llama a SPA «estilo de aplicación frontend standalone» |
| `search_catalog` `query` `shell frontend por features` | Primer resultado `frontend-mfe-shell` | Un estilo llamado feature-based shell, distinto de `frontend-mfe-shell` y de `frontend-spa` |
| `read_document` del lineamiento SSE, `mode` `section`, sección `Lineamientos generales > Arquitectura y diseño` | El punto 3: «Organizar los servicios SSE dentro de las características específicas que los utilicen.» `truncated` false, 1 de 20 secciones. El `mode` `full` de la misma referencia llegó `truncated` true y se cortó antes de esa sección | Un `entity_id` de proceso o contenedor SSE. El punto 3 no impide un proceso; el proceso lo decide Julian |
| `search_catalog` `query` `observabilidad health métricas request id` y `read_document` de la card | `decision-arquitectonica-plataforma-10-observability-stack`. Esta sesión el cuerpo de «Decisión» repite «Stack de observabilidad (logs, metrics, traces).» `truncated` false | Un estilo de proceso de producto |
| `read_document` de `decision-arquitectonica-software-01-arquitectura-hexagonal` | Título «Arquitectura hexagonal para backend», sin puertos ni capas | La definición. Esa definición está en `backend-hexagonal` |
| `read_document` de `Factoria-Ang/.cloud/architecture/decisions/ADR-004-module-federation.md` | `@angular-architects/module-federation`, manifiesto `libs/config/microfrontends.json` | El manifiesto `iark.manifest/1` del producto |

En la sesión que abrió el borrador, `get_source_status` devolvió `status` `ready`, `docs_indexed` 16189, `graph_reachable` true, `stale_sources` vacío. `architecture-knowledge` está `operativa`. `github` está `degradada` (`verdict_reason`: la última operación real falló con `source_error`). Esta sesión no repitió esa llamada. El mapa `resources/read` de `ece://navegacion` fija el orden: localizar, y solo entonces leer.

## decisión

El corte de procesos es el que Julian fijó en esta sesión. El estilo de un contenedor es la card que él nombra cuando esa card se leyó. La tabla de huecos sigue diciendo qué no devolvió la llamada. No se atribuye a la card un nombre que la card no escribe.

### `diagrams-app`

`api-proyectos` pasa a un proceso `diagrams-app`. El estilo es `backend-coredomain`. No hay una card titulada monolito modular: el monolito se especifica con las capas que esta card devuelve, aplicadas a lo que de verdad queda en el proceso.

Tras sacar `api-modulos` (gateway), `tokens` y `cuentas-gh` (identity), `sse`, `estaticos` y `cabeceras`, el módulo de negocio que queda es uno: `projects`. Era `api-proyectos` más el almacén `proyectos`. El almacén deja de ser contenedor y queda dentro de este proceso. La card no pide un módulo por bounded context: no usa esas palabras. Describe un servicio. El monolito empírico tiene ese único módulo, `projects`, organizado en las capas de la card. No se inventan otros módulos de negocio. El núcleo `@iark/*` sigue siendo librería que usa `diagrams-gateway`; la card no lo exige como módulo de este proceso y el corte tampoco.

La card, en «Definición»: «Se compone de cuatro capas explícitas: un punto de entrada ultra-delgado (Host), una capa de orquestación pura sin reglas de negocio (Application), un núcleo de dominio rico en comportamiento y protegido de cualquier detalle técnico (Domain), y una capa de implementaciones concretas (Infrastructure).» Los tres pilares que nombra son «modelado de dominio táctico, separación de comandos y consultas, y aislamiento de puertos y adaptadores». En «Fundamentos»: «las consultas no pasan por el dominio: leen directamente de la capa de infraestructura», y «las escrituras sí pasan íntegramente por el dominio».

En `projects`, con lo que el as-is ya nombra para `api-proyectos` (CRUD de proyectos y diagramas, bundle, importación, comprobación y guardado condicional por `ifUpdatedAt`) y para `proyectos` (carpeta o Postgres):

- **Host.** El HTTP de `api-proyectos`. Traduce cada petición en un comando o una consulta. La card: «No conoce el dominio ni lo invoca directamente; su única responsabilidad es validar el formato de entrada y traducir protocolo hacia y desde ese punto de entrada único.»
- **Application.** Orquesta las escrituras y no contiene la regla. La card: «Cada operación de escritura tiene su propio punto de orquestación que carga el estado, invoca un método de negocio del dominio y persiste; cada operación de lectura hace bypass directo hacia infraestructura con su propio modelo de proyección.» Las escrituras de este módulo son crear, modificar y borrar proyecto o diagrama, importar el archivo único y guardar con `ifUpdatedAt`. Las lecturas son listar, abrir, bundle y comprobación.
- **Domain.** Las reglas de ese CRUD y de ese guardado condicional: el estado válido cambia solo por un método de negocio. La card: «nunca un conjunto de datos con acceso directo a sus campos» y «no tiene ninguna dependencia externa».
- **Infrastructure.** El almacén que hoy es el contenedor `proyectos`. La card: «Implementa los contratos de persistencia del dominio para escritura, define repositorios de lectura separados con proyecciones optimizadas para consulta». El almacén sigue siendo uno, carpeta o Postgres. Los repositorios de lectura son proyecciones sobre ese almacén, no una segunda base.
- **CQRS.** Es la «separación explícita entre comandos y consultas» de la definición, con el bypass de lectura de «Fundamentos». No es una quinta capa con otro nombre en la card.

La regla de dependencia de la card: «Domain no depende de ninguna otra capa. Application depende de Domain. Infrastructure implementa los contratos de Domain. Host depende de Application.» Las consultas son la excepción que la misma frase declara.

Las rutas de miembros que hoy cuelgan de la API de proyectos no arman un segundo módulo aquí. Miembros y cuotas son `accounts`, en identity. No hay módulo `realtime`: el SSE sale de este proceso.

### `diagrams-gateway`

`api-modulos` pasa a `diagrams-gateway`. Es el borde único hacia la API de módulos. El estilo es `gateway-feature-based`. La card: «un traductor de protocolos y agregador de respuestas organizado alrededor del contexto de negocio (feature), no de la capa técnica. El gateway no persiste datos propios, no protege invariantes de dominio y no posee ciclo de vida de entidades». «Un feature nunca depende de otro feature» y «Shared nunca depende de ningún feature». La materialización que la card y el ADR NestJS nombran es BFF NestJS por funcionalidad: carpetas `features/`, sin layer-folders `1-api/`, `2-infrastructure/`, `3-application/`, y handlers HTTP dentro de cada feature. `diagrams-sse` usa la misma card y la misma materialización.

`pool` no es un servicio ni un deploy. Vive dentro de este gateway: ahí corren validate, export, import, diff, run y la traza URN. Es infraestructura del proceso, no una carpeta `2-infrastructure/` que la convención NestJS prohíbe, y no es un feature de negocio. La card no nombra la piscina. Su evolución saca hacia un backend «cualquier invariante de negocio real» que aparezca dentro del gateway. El corte la deja aquí igual. La traza URN (`urn`, hoy bajo `api-modulos` y `pool`, y `/api/trace`) corre en esa piscina. No es el proceso de operación del apartado siguiente.

### `diagrams-sse`

`sse` no entra en `diagrams-app`. Es un gateway nuevo, `diagrams-sse`, dedicado al tiempo real. El estilo es `gateway-feature-based`, el mismo `entity_id` que `diagrams-gateway`. Un solo feature: el canal de avisos que hoy es el componente `sse` (`GET /api/events`, una versión más nueva). No se llama módulo `realtime`.

El lineamiento, sección «Lineamientos generales > Arquitectura y diseño», punto 3: «Organizar los servicios SSE dentro de las características específicas que los utilicen.» El punto 2: «Crear servicios dedicados para la gestión de conexiones SSE, separados de la lógica de negocio.» Eso organiza código dentro de un proceso. No crea el proceso y no lo impide. En la arquitectura del mismo documento, el BFF «Mantiene conexiones SSE abiertas con clientes». El diagrama dibuja un message broker. El as-is no tiene ese broker y esta spec no lo añade como contenedor. El proceso es decisión de Julian.

### `diagrams-identity`

`tokens` y `cuentas-gh` pasan a `diagrams-identity`. El almacén `cuentas` deja de ser contenedor y queda dentro de este proceso. Gateway y app solo validan. El estilo es `backend-nano` (Host+Core).

Lo que la card dice, literal. «Definición»: «un servicio que resuelve un único contexto, sin necesidad de separar infraestructura ni de modelar un dominio con invariantes propias.» «un nanoservicio que empieza a resolver más de un contexto funcional ha dejado de ser Nano.» «Se compone de exactamente dos capas: un punto de entrada (Host) y un núcleo de resolución (Core). No hay capa de infraestructura separada ni puertos explícitos — cuando existe una sola variante de acceso a una dependencia externa, el costo de abstraerla supera el beneficio.» Host: «Traduce la solicitud del protocolo de transporte a una invocación del Core» y «No contiene lógica de negocio». Core: «Contiene toda la lógica que resuelve el problema funcional» «y el acceso directo a las dependencias externas que ese problema necesita. Crece horizontalmente — se agregan más variantes del mismo problema, nunca una responsabilidad de otro contexto funcional.» Dependencia: «El Host depende del Core; el Core no depende del Host.» La card no lista `accounts` ni `access-tokens`.

La lectura de Julian, que autoriza este corte. Host+Core permite infraestructura dentro de Core. Core es una capa libre donde cabe cualquier arquitectura interna. La única condición es una responsabilidad, o como máximo dos. Este componente tiene dos: `accounts` (OAuth GitHub, sesión, miembros, cuotas) y `access-tokens` (hash, rol de carpeta). El Host es el adaptador HTTP. Esas dos responsabilidades viven en Core, y el almacén `cuentas` también: la card no abre una tercera capa de infraestructura, y Julian mete ahí la infraestructura. No se copian los extension methods del ADR .NET que la sesión anterior leyó. El antipatrón `antipatron-arquitectura-core-host-coupling` acompaña el corte: el Core no referencia tipos del Host, que es también la regla de dependencia de la card.

### Por qué no hay `diagrams-trace`

No se crea el contenedor `diagrams-trace`.

- `pool` no es un servicio. Vive dentro de `diagrams-gateway`, como queda arriba. Infraestructura de ese gateway, no un deploy.
- `estaticos` no es un backend. El shell se publica en GitHub Pages o en un CDN. Ni `diagrams-app` ni los gateways sirven el SPA. En el as-is, Pages ya es `github` (`r-gh-sitio`). No hay un estilo ECE para ese destino.
- `cabeceras` no es un servicio. Es una política en el proxy TLS (`proxy`) y en el borde de los dos gateways públicos, `diagrams-gateway` y `diagrams-sse`.
- Observabilidad: cada proceso expone salud. El id de petición y las métricas van en una librería común. `prometheus` sigue raspando métricas. La auditoría que el as-is pone en `obs` queda en los procesos que tienen los datos, identity y `projects`. La card `decision-arquitectonica-plataforma-10-observability-stack` no define un proceso de producto: la sección «Decisión» repite el título «Stack de observabilidad (logs, metrics, traces).» La convención NestJS del gateway dice que los building blocks `@siste/nestjs-*` cubren la observabilidad de ese BFF. Esos paquetes no son la librería de DIAgrams. El nombre `diagrams-trace` chocaría con la traza URN (`traza-ui`, `/api/trace`, `mfe-trace`).

### `diagrams-shell` y microfrontends

Un solo `diagrams-shell`. Julian pide el estilo `frontend-spa`. Deja de ser `frontend-mfe-shell`.

La card de SPA: «aplicación frontend mantenida como una unidad», «organizado internamente por feature en vez de por tipo técnico». `regla-frontend-spa-01`: «un feature nunca depende de otro feature; la comunicación cruzada pasa por Services.» `regla-frontend-spa-02`: «cada feature puede cargarse bajo demanda.» Capas que la card nombra: Features, Core, Security, Services, Shared. «Un feature nunca puede depender de otro feature. Ni Shared ni Core pueden depender de ningún feature.»

En ese shell, con los nombres del corte anterior y el componente as-is entre paréntesis:

- **Features.** `suite`, `studio`, `projects`, `classic-editor`.
- **Core.** Router (`boot`) e i18n (`i18n`): la card dice «capacidades globales de tipo singleton» (guardas de navegación, interceptores, configuración, estado global).
- **Services.** Project-repository (`proyectos-web`) y embed-bridge (`puente`): «Coordinadores de nivel aplicación que cruzan features».
- **Shared.** El lienzo, como slot, «sin lógica propia de ningún feature específico».
- **Security.** La capa de la card. Consume `diagrams-identity`. No es un proceso ni un remoto.

Esos cuatro nombres de plataforma no los devuelve ECE.

La card no dice «un contenedor no puede ser spa y a la vez componer remotos». Sí separa los estilos. Cita: `mfe-shell` y `mfe-remote` «no son variantes de este estilo, sino estilos de referencia propios, pares entre sí, elegidos por topología de composición federada en vez de por composición standalone». El preludio llama a SPA «estilo de aplicación frontend standalone». El marco, leído en la sesión anterior, pide elegir el estilo frontend por topología: `spa`, `mfe-shell` o `mfe-remote`, exactamente una. La orden de Julian se aplica igual: el estilo del shell es `frontend-spa`. Los remotos no se borran. El shell SPA los compone.

El contrato de esa composición se conserva de las cards releídas, aunque el estilo del contenedor ya no sea `frontend-mfe-shell`. La card del shell: «descubre y monta capacidades remotas en tiempo de ejecución». El descubrimiento «ocurre por un manifiesto configurable por entorno, nunca por referencias fijas en el código». «Es dueña del árbol raíz de navegación». «El único acoplamiento permitido del Shell hacia una capacidad remota es el contrato de rutas que esa capacidad expone» y el shell la monta «sin conocer ni reescribir el interior de esa capacidad». La card del remoto: «El conjunto de rutas que la capacidad remota expone es su único punto de acoplamiento hacia afuera» y «Una capacidad remota nunca depende de quien la compone, y nunca depende directamente de otra capacidad remota».

Esos remotos, estilo `frontend-mfe-remote`: `mfe-c4`, `mfe-integration`, `mfe-data`, `mfe-enterprise`, `mfe-platform`, `mfe-security`, `mfe-trace`. Cada uno expone rutas, no componentes sueltos (`convencion-frontend-angular-mfe-structure`, sesión anterior). No son features del SPA: son contenedores aparte que el shell compone. El manifiesto concreto de Factoría (`microfrontends.json`, Webpack, ADR-004) es la materialización Angular, no el contrato `iark.manifest/1`.

El `sdk` sigue siendo librería del anfitrión (`anfitrion`), no un remote.

### CLI

Un proceso, el `cli`. El estilo es `backend-hexagonal`: Host, Core con puertos, Infrastructure que implementa esos puertos. Core no depende de Host ni de Infrastructure. `comandos` (commander) es el Host: valida la entrada y delega. Los puertos del Core, con los nombres del corte, son `ModelProvider`, `RepositoryReader`, `ProjectStore` y `Modules`. Esos identificadores no los devuelve ECE. La IA sigue solo en este proceso (`ia-cli`, `proveedor-ia`). El marco clasifica hexagonal como vertical backend y no nombra una vertical CLI.

### Núcleo

`nucleo` y los paquetes `@iark/*` siguen siendo librería, no un proceso. Un módulo no importa a otro. El enlace entre especialidades sigue siendo la URN. El gateway los ejecuta desde `pool`. No son un módulo de `diagrams-app`.

## alternativas descartadas

- Dejar `diagrams-app` sin estilo, o tratar `backend-coredomain` como si no aplicara porque no se titula monolito modular. Julian asigna esa card. No se inventan módulos de negocio (`realtime`, `@iark/*`, observabilidad) para que el monolito parezca varios contextos.
- Negar Nano porque la card no escribe `accounts` ni `access-tokens`, o copiar los extension methods de .NET al proceso Node.
- Dejar el shell en `frontend-mfe-shell`, o borrar los remotos porque la card de SPA separa la composición federada de la standalone.
- Dejar el SSE como módulo de `diagrams-app`, o colgarlo del gateway de módulos. El lineamiento no define el proceso. El proceso es `diagrams-sse` y el estilo es el del gateway.
- Crear `diagrams-trace`. Hacer de `pool`, `estaticos` o `cabeceras` un servicio. Servir el SPA desde `diagrams-app` o desde un gateway.
- Un estilo «feature-based shell» además de `frontend-spa`.
- Tratar ADR-004 o `federation.manifest.json` de Angular como el manifiesto del producto.
- Usar la card LeanIX `decision-arquitectonica-software-01-arquitectura-hexagonal` como definición de puertos. El cuerpo no los trae.
- Crear `examples/diagrams-to-be.json` en este borrador.
- Pasar la spec 000 a `hecha` solo porque el puente respondió. El descubrimiento de la sesión sigue sin namespace ECE.

## criterios de aceptación comprobables

1. En `docs/arquitectura/specs/001-to-be-c4.md`, la línea de la sección estado es `` `borrador` ``.
2. La spec 000 sigue en `borrador`.
3. No existe `examples/diagrams-to-be.json`. `examples/diagrams-as-is.json` no cambia. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos.
4. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
5. Cada estilo marcado como aplicado en la decisión tiene en «capacidades ECE que aplican» un `entity_id` y un `path` que una llamada de la verificación devolvió. Entran en eso `diagrams-app` (`backend-coredomain`), `diagrams-identity` (`backend-nano`), `diagrams-shell` (`frontend-spa`), `diagrams-gateway` y `diagrams-sse` (`gateway-feature-based`), cada `mfe-*` (`frontend-mfe-remote`) y el `cli` (`backend-hexagonal`).
6. El estilo de `diagrams-shell` no es `frontend-mfe-shell`. No hay módulo `realtime` en `diagrams-app` ni contenedor `diagrams-trace`. La decisión no atribuye a una card los nombres `accounts`, `access-tokens` ni `projects`, ni los cuatro bloques de plataforma del shell, ni los nombres de puertos del CLI. Dice que la card de Core Domain no pide un módulo por bounded context y que el módulo de negocio de `diagrams-app` es uno, `projects`, en Host, Application, Domain e Infrastructure, con comandos y consultas separados.
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

Órdenes de la sesión que abrió el borrador:

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprimió nada.

### Relectura de esta sesión

Mismo puente: `python3 scripts/mcp-ece.py --no-cache`, stdio NDJSON, `protocolVersion` `2025-03-26`. `initialize` negoció `2025-03-26`, `serverInfo.name` `ece-knowledge-router`, `serverInfo.version` `0.1.0`. El stderr, ya sin URL, fue `cache=off (--no-cache)` y `ca=system`. El descubrimiento de la sesión sigue sin namespace ECE. La spec 000 no cambia de estado.

`read_document` con `mode` `full`, salvo el lineamiento. `truncated` false y sin `metadata.error`, salvo la fila que lo dice. El `entity_id` es el que abre el título devuelto. El lineamiento no trae un `entity_id` distinto del path.

| `entity_id` o path | `path` devuelto | Una frase del resultado |
|---|---|---|
| `backend-coredomain` | `corpus/software/arquitectura-referencia/backend-coredomain.md` | «Se compone de cuatro capas explícitas: un punto de entrada ultra-delgado (Host), una capa de orquestación pura sin reglas de negocio (Application), un núcleo de dominio rico en comportamiento y protegido de cualquier detalle técnico (Domain), y una capa de implementaciones concretas (Infrastructure).» |
| `backend-nano` | `corpus/software/arquitectura-referencia/backend-nano.md` | «Se compone de exactamente dos capas: un punto de entrada (Host) y un núcleo de resolución (Core).» |
| `frontend-spa` | `corpus/software/arquitectura-referencia/frontend-spa.md` | «SPA es el estilo de referencia para una aplicación frontend mantenida como una unidad.» |
| `frontend-mfe-shell` | `corpus/software/arquitectura-referencia/frontend-mfe-shell.md` | «Existe exactamente un Shell por composición.» |
| `frontend-mfe-remote` | `corpus/software/arquitectura-referencia/frontend-mfe-remote.md` | «Nunca depende de quien la compone ni de otra capacidad remota de la misma composición.» |
| `gateway-feature-based` | `corpus/software/arquitectura-referencia/gateway-feature-based.md` | «Feature-Based es el estilo de referencia para la vertical gateway: un traductor de protocolos y agregador de respuestas organizado alrededor del contexto de negocio (feature), no de la capa técnica.» |
| `sistedocs:ingenieria-de-software/integraciones/server-sent-events/v1.0/lineamientos-sse.md` | el mismo path | `mode` `full`, `truncated` true: el cuerpo se corta en «Distribución selectiva», antes de los lineamientos. `mode` `section` y sección `Lineamientos generales > Arquitectura y diseño`, `truncated` false, 1 de 20: «Organizar los servicios SSE dentro de las características específicas que los utilicen.» |
| `decision-arquitectonica-plataforma-10-observability-stack` | `corpus/plataforma/decision-arquitectonica/decision-arquitectonica-plataforma-10-observability-stack.md` | La sección «Decisión» repite «Stack de observabilidad (logs, metrics, traces).» |

Los cuerpos de esta relectura, sin la URL ni la clave, quedaron en `/opt/cursor/artifacts/ece-reread-*.md`.

Órdenes de esta sesión sobre el repo:

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprimió nada. El único archivo del diff es esta spec.

## riesgos

- Aplicar `backend-coredomain`, el punto alto del espectro, a un solo módulo. La propia card pide considerar el estilo intermedio «cuando todo el dominio se reduce a una sola entidad trivial» y «cuando ninguna consulta hace bypass y toda la separación de lecturas y escrituras resulta ceremonial». El corte lo aplica igual. Lo que se vigila es que las escrituras de `projects` pasen por el dominio y las lecturas no, como la card dice.
- Leer `accounts` y `access-tokens` como si la card los listara. La card dice que «más de un contexto funcional» deja de ser Nano, y que el Core «nunca» agrega «una responsabilidad de otro contexto funcional». Julian autoriza como máximo dos responsabilidades dentro de Core. El riesgo es que esas dos se separen en dos contextos y el estilo deje de ser el de la card.
- Componer remotos desde un shell cuyo estilo es `frontend-spa`. La card llama a ese estilo standalone y aparta la topología federada. El marco pide una sola elección entre `spa`, `mfe-shell` y `mfe-remote`. Los remotos siguen en `frontend-mfe-remote` por la orden de Julian. El riesgo es tratar el shell como si tuviera los dos estilos a la vez.
- Dejar la piscina y la traza URN en el gateway cuando la card saca de ahí la lógica de dominio. El corte lo hace igual; la card no nombra la piscina.
- Tomar el punto 3 del lineamiento SSE como prohibición del proceso `diagrams-sse`. El punto organiza las conexiones dentro de las features. El proceso es de Julian, y dentro de ese gateway el canal sigue siendo un feature.
- Copiar el manifiesto Angular o los building blocks `@siste/nestjs-*` al repo de DIAgrams.
- Nombrar `diagrams-trace` un día y chocar con `traza-ui`, `/api/trace` y `mfe-trace`.
- La fuente `github` del MCP estaba degradada en la sesión anterior. Esta sesión no volvió a llamar `get_source_status`. Las cards releídas salieron de `architecture-knowledge` y de `sistedocs`.
- Redactar esta spec con 000 todavía en `borrador`. Quien la acepte tiene que mirar si el descubrimiento de la sesión ya muestra el namespace ECE, que aquí no apareció.
