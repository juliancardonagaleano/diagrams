# diagrams-sse

Gateway de avisos (`GET /api/events`, spec 005). El único punto de entrada HTTP es **`createEventsHost`** en `host/eventsApi.ts`; `iark serve` delega ahí y no registra rutas SSE en otro módulo.

## Proceso actual (in-process)

Hoy `EventHub` y `EventPublisher.publish` (desde `diagrams-app` tras una escritura) comparten el mismo proceso y el mismo objeto en memoria. `src/cli/serveEvents.ts` solo reexporta tipos por compatibilidad histórica.

## Límite futuro (proceso aparte)

Separar `diagrams-sse` de `diagrams-app` exige un canal entre la publicación (escrituras confirmadas) y este gateway (conexiones abiertas). Hasta que exista y esté probado — candidato documentado en la spec 005: `NOTIFY` en Postgres con conexión de sesión al margen del pool transaccional — **no** se arranca un segundo proceso; el feature queda delimitado en código y la spec permanece `en curso`.
