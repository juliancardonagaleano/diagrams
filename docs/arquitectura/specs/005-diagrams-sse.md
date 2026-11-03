# 005 · Gateway de avisos

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`005-diagrams-sse`

## estado

`hecha`

Canal Postgres probado (`postgresBridge.ts`); `createEventsHost` es el único borde HTTP del canal. `iark serve-sse` + `IARK_EVENTS_ROLE=publish|stream` permiten separar app y gateway SSE en producción (`deploy/docker-compose.split.yml`). Monolito con carpeta o Postgres en un solo proceso sigue soportado. `serveEvents.ts` reexporta tipos por compatibilidad.

## problema

`GET /api/events` vive en el mismo proceso que guarda los proyectos (`src/cli/serveEvents.ts`). El aviso lleva identificadores y marcas, no el documento, y el hub es memoria de ese proceso: con varias instancias solo se entera de lo que pasó por cada una. El corte saca ese canal de `diagrams-app`. No es un módulo de la app y no cuelga del gateway de módulos.

## alcance

- Fijar el proceso `diagrams-sse`, estilo `gateway-feature-based`, dedicado a `GET /api/events`.
- Dejar un solo feature: el canal de avisos que hoy es el componente `sse`.
- Dejar la publicación del aviso en `diagrams-app` y la conexión abierta en este gateway.
- Dejar escrito qué falta antes de separar el proceso: un canal entre los dos, que hoy no existe.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Un módulo `realtime` dentro de `diagrams-app` ([spec 003](003-diagrams-app.md)).
- Colgar el canal de `diagrams-gateway` ([spec 002](002-diagrams-gateway.md)). Ese gateway es la API de módulos.
- Mezclar ediciones. Dos guardados del mismo diagrama siguen chocando en `ifUpdatedAt`, que es regla de `projects`.
- Añadir un contenedor broker. La 001 leyó que el diagrama del lineamiento dibuja un message broker y decidió no añadirlo como contenedor. Esta spec tampoco.
- Reanudación con `Last-Event-ID`. El as-is no la tiene: al reconectar, el cliente vuelve a leer la lista.
- Avisar de lo que `iark project` escriba en la carpeta sin pasar por la app. Ese hueco lo cubre el sondeo, como hoy.
- Identidad, salvo que este proceso le pregunte quién pertenece al proyecto en el momento de entregar el aviso ([spec 004](004-diagrams-identity.md)).
- Estáticos, cabeceras y la librería de observabilidad ([spec 009](009-borde-y-operacion.md)).
- El cliente del navegador (`proyectos-web`). Sigue consumiendo el mismo `GET /api/events`. Cambiar el shell es la [spec 006](006-diagrams-shell.md).
- Código de producto y los JSON de modelo en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`servicio`, `http`, `sse`, `sitio`.

`http` entra por `GET /api/events`. `sitio` sigue siendo quien recibe el aviso (`r-sse-sitio`): el mensaje no cambia de forma. `sse` deja de ser componente de `servicio` y pasa a ser el feature de `diagrams-sse`.

## capacidades ECE que aplican

Citas de la [spec 001](001-to-be-c4.md). Esta sesión no repitió la llamada.

| Para qué | Herramienta | `entity_id` o referencia | `path` |
|---|---|---|---|
| Estilo de `diagrams-sse` | `read_document` | `gateway-feature-based` | `corpus/software/arquitectura-referencia/gateway-feature-based.md` |
| La misma materialización que el otro gateway, sin portarla | `read_document` | `decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad` | `corpus/gateway-nestjs/decision-arquitectonica/decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad.md` |
| Lineamiento del canal | `read_document` (`mode` `section`, sección `Lineamientos generales > Arquitectura y diseño`) | El documento no trae un `entity_id` distinto del path. La referencia que devolvió la 001 es `sistedocs:ingenieria-de-software/integraciones/server-sent-events/v1.0/lineamientos-sse.md` | `ingenieria-de-software/integraciones/server-sent-events/v1.0/lineamientos-sse.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

El estilo es el mismo `entity_id` que `diagrams-gateway`. La card: «Feature-Based es el estilo de referencia para la vertical gateway: un traductor de protocolos y agregador de respuestas organizado alrededor del contexto de negocio (feature), no de la capa técnica.» Un feature no depende de otro. Aquí hay un solo feature, así que la regla se cumple de antemano. No se portan las carpetas NestJS.

El lineamiento, en la sección que la 001 leyó con `truncated` false: «Organizar los servicios SSE dentro de las características específicas que los utilicen.» El punto 2 de esa misma sección, que la 001 también cita: «Crear servicios dedicados para la gestión de conexiones SSE, separados de la lógica de negocio.» Eso organiza el código dentro de un proceso. No crea el proceso y no lo impide. El proceso lo decide Julian, y esta spec lo escribe. El `mode` `full` de ese documento volvió `truncated` true y se cortó antes de la sección; la cita válida es la de `mode` `section`.

## decisión

`sse` no entra en `diagrams-app` y no es un módulo. Es un gateway nuevo, `diagrams-sse`, dedicado al tiempo real. El estilo es `gateway-feature-based`. El único feature es el canal que hoy implementan la clase `EventHub` y `createEventsApi` en `src/cli/serveEvents.ts`.

El contrato del canal se conserva:

| Pieza | Qué es hoy |
|---|---|
| Ruta | `GET /api/events`, con `?project=<p>` opcional. `POST` y cualquier subruta siguen en 404. |
| Aviso | `change` con `type`, `project`, `diagram?`, `updatedAt?`, `by?`, `at`. Identificadores y marcas. Sin documento y sin nombres de diagrama en el sentido de contenido. |
| Tipos | `project.created`, `project.changed`, `project.deleted`, `diagram.created`, `diagram.saved`, `diagram.renamed`, `diagram.deleted`, `diagram.restored`. |
| Otros mensajes | `ready` al abrir, `bye` si la credencial cae o el proceso para, comentario de latido. |
| Permiso | La credencial va en `Authorization`. La pertenencia se mira al entregar, no solo al conectar. Tope por persona y tope global, 429 con `Retry-After`. |

`diagrams-app` publica el aviso cuando una escritura de `projects` confirma el cambio. Hoy eso es `announce` en `src/cli/serveProjects.ts`, que llama a `EventPublisher.publish`. El gateway abre la conexión y entrega. La app no deja el socket abierto. El gateway no aplica `ifUpdatedAt`: si dos guardados chocan, la app no publica el que perdió.

### Qué falta antes de separar el proceso

Hoy el hub y el publicador son el mismo objeto en memoria. `EventPublisher` no sale del proceso. El corte no añade un broker como contenedor, y el as-is no tiene uno.

Separar `diagrams-sse` de `diagrams-app` espera un canal por el que la app publique y este gateway reciba. Hasta que ese canal exista, el proceso no se parte: el feature puede quedar delimitado en código y la conexión sigue en el mismo proceso que publica.

El candidato que no añade contenedor es `NOTIFY` de Postgres sobre la base que ya guarda proyectos. El pool actual no sirve para eso. `src/cli/postgres/pool.ts` y `src/cli/postgresProjects.ts` están escritos para el pooler de Supabase en modo transacción: no usan `LISTEN`, no usan sentencias preparadas con nombre y no cambian parámetros de sesión. Un `LISTEN` en ese pool no es el canal. Hace falta una conexión de sesión al margen de ese pooler, u otro canal que tampoco sea un contenedor nuevo del modelo. El [plan](../plan-implementacion.md) para la fase en ese punto: no se abre el proceso hasta que el canal esté elegido y probado.

La carpeta de trabajo, sin Postgres, tampoco tiene ese canal. Un despliegue solo con carpeta sigue con el hub en el mismo proceso, que es el comportamiento actual de una sola instancia, o espera el mismo canal. Esta spec no inventa un bus de ficheros.

El lineamiento cabe dentro del proceso una vez partido: el feature del gateway es el servicio de conexiones, separado de la lógica de `projects`, que se queda en la app.

## alternativas descartadas

- Dejar el SSE como módulo de `diagrams-app`, con el nombre `realtime` o con el nombre `sse`.
- Colgar `GET /api/events` de `diagrams-gateway`.
- Leer el punto 3 del lineamiento como prohibición del proceso. El punto organiza las conexiones dentro de las features. El proceso es el de Julian, y dentro de él el canal es un feature.
- Añadir el message broker del diagrama del lineamiento como contenedor del to-be.
- Partir el proceso el mismo día en que el único pub/sub sigue siendo la memoria de `EventHub`.
- Usar `LISTEN` sobre el pool de `src/cli/postgres/pool.ts` sin decir que ese pool lo rechaza.
- Meter el documento en el evento para ahorrar el `GET` posterior. El canal avisa; quien escucha vuelve a leer por la API de proyectos.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. El as-is no cambia. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
3. Las capacidades citan `gateway-feature-based` y el path del lineamiento SSE tal como la spec 001 los registró.
4. La decisión dedica el proceso a `GET /api/events`, dice que la app publica y este gateway abre la conexión, y dice que falta un canal antes de separar el proceso. Nombra el límite de `LISTEN` en `src/cli/postgres/pool.ts`.
5. Los ids citados están en `examples/diagrams-as-is.json`.

De la implementación, solo con la spec `aceptada` y en su PR:

1. Mientras no haya canal probado, la PR no arranca un segundo proceso. Puede dejar el feature delimitado y el hub donde está, y el criterio de «proceso aparte» queda explícitamente pendiente en la spec, que sigue en `en curso`.
2. Cuando el canal existe, `GET /api/events` lo atiende `diagrams-sse` y la escritura de proyectos lo publica desde `diagrams-app`. El cuerpo de `change` sigue siendo el de `ChangeEvent` en `src/cli/serveEvents.ts`.
3. `diagrams-app` no registra un módulo `realtime`. `diagrams-gateway` no sirve `/api/events`.
4. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada.
5. Pasan `src/cli/serveEvents.test.ts` y `tests/e2e/projects-cloud-eventos.spec.ts`.
6. La PR que cierra el proceso aparte deja la spec en `hecha`. No mezcla la 002, la 003 ni la 009.

## verificación

1. **`createEventsHost` único:** `serve.ts` enruta `/api/events` solo vía `eventsHost.handle`; no hay otro handler SSE en `diagrams-app` ni en `diagrams-gateway`.
2. **Canal Postgres:** publicación en el pool; escucha en conexión de sesión (`IARK_DATABASE_SESSION_URL`). Límite del pool transaccional documentado en `src/cli/postgres/pool.ts`.
3. **Proceso aparte:** `iark serve-sse`, roles `IARK_EVENTS_ROLE=publish|stream`, variables en `src/diagrams-sse/README.md`. Stack de referencia: `deploy/docker-compose.split.yml`, `deploy/Caddyfile.split`, `deploy/.env.example`.
4. **Pruebas:**

```text
npm run typecheck
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
npx vitest run src/cli/serveEvents.test.ts src/diagrams-sse/features/events/postgresBridge.test.ts src/cli/observability/readinessChecks.test.ts
```

`postgresBridge.test.ts` ejecuta NOTIFY/LISTEN contra Postgres real cuando `IARK_REQUIRE_POSTGRES=1` (como en CI). E2E del canal: `tests/e2e/projects-cloud-eventos.spec.ts`.

## riesgos

- Partir el proceso con el hub en memoria y perder los avisos entre app y gateway. Por eso el canal es previo.
- Apoyar `NOTIFY` en el pool de transacción y no recibir nada. El pool está escrito para no usar `LISTEN`.
- Tratar el canal como un contenedor nuevo y reabrir el corte de la 001, que no añade el broker.
- Filtrar la pertenencia solo al conectar. Quien pierde el proyecto tiene que dejar de recibir, como hace hoy el hub al publicar.
- Suavizar el conflicto de `ifUpdatedAt` porque «ya hay tiempo real». El canal no mezcla ediciones.
