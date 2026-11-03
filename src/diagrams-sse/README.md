# diagrams-sse

Gateway de avisos (`GET /api/events`, spec 005). El único punto de entrada HTTP del feature es **`createEventsHost`** en `host/eventsApi.ts`.

## Proceso actual (in-process)

Con `iark serve`, `EventHub` y `EventPublisher.publish` (desde `diagrams-app` tras una escritura) comparten el mismo proceso. `src/cli/serveEvents.ts` solo reexporta tipos por compatibilidad histórica.

Con **`--workspace-store postgres`**, el puente **`NOTIFY`/`LISTEN`** de Postgres reparte avisos entre réplicas y prepara separar el proceso:

| Pieza | Dónde | Conexión |
|---|---|---|
| Publicación | Tras cada escritura confirmada | `NOTIFY` en el pool transaccional (`notifyProjectChange`) |
| Reparto al hub | Mismo proceso o `iark serve-sse` | `LISTEN` en conexión de **sesión** (`PostgresEventListener`) |

Variables:

- `IARK_EVENTS_BRIDGE=postgres|memory` — por omisión `postgres` si los proyectos están en Postgres.
- `IARK_DATABASE_SESSION_URL` — URL directa al servidor (p. ej. puerto 5432 en Supabase), cuando el pooler transaccional no admite `LISTEN`.
- `IARK_EVENTS_ROLE=publish` — solo publica NOTIFY (proceso app partido; desactiva SSE en ese proceso).
- `IARK_EVENTS_ROLE=stream` — solo atiende SSE (`iark serve-sse`).

Con LISTEN activo en el mismo proceso, el hub **solo** recibe avisos por NOTIFY (no se duplican en memoria).

## Proceso aparte (`iark serve-sse`)

Comando del CLI (equivalente a `node dist/cli/main.js serve-sse`):

```bash
iark serve-sse --workspace-store postgres --host 0.0.0.0 --port 8788 \
  --tokens /data/tokens.json --trust-proxy
```

Expone `/healthz`, `/readyz`, `/metrics` (si están activados) y **`GET /api/events`**, más las rutas de autenticación necesarias. No sirve `/api/projects` ni la API de módulos.

Referencias de despliegue:

| Archivo | Uso |
|---|---|
| `deploy/docker-compose.split.yml` | Stack Postgres: app (`publish`) + `iark-sse` (`stream`) + Caddy (`Caddyfile.split` enruta `/api/events`) |
| `deploy/docker-compose.sse-snippet.yml` | Fragmento mínimo si ya tiene compose propio |
| `deploy/.env.example` | `IARK_DATABASE_URL`, `IARK_DATABASE_SESSION_URL`, `IARK_EVENTS_*` |

**Política:** el monolito (`iark serve` con carpeta o Postgres en un solo proceso) sigue siendo válido. Con Postgres y varias réplicas, separe procesos: la app publica con NOTIFY; el gateway SSE escucha con una conexión de sesión. Sin `IARK_DATABASE_SESSION_URL`, el pooler transaccional no admite `LISTEN` (ver `src/cli/postgres/pool.ts`).

## Carpeta local (sin Postgres)

El puente NOTIFY no aplica: el hub sigue en memoria del único proceso. Separar `serve-sse` en ese despliegue no reparte avisos entre instancias hasta usar Postgres (o otro canal acordado en la spec 005).
