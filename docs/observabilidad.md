# Observabilidad: registros, auditoría, salud y métricas

[← Índice de la documentación](indice.md)

`iark serve` puede dejar cuatro rastros de lo que hace, pensados para operar el [servicio gestionado](cuentas-github.md) (o cualquier `iark serve` expuesto en una red):

| Qué | Para qué | Cómo se enciende |
|---|---|---|
| **`X-Request-Id`** | Seguir una petición por la respuesta, los registros y los avisos | Siempre |
| **Registro de accesos** | Qué se pidió, quién, cuánto tardó y cómo acabó | `--access-log` |
| **Auditoría** | Quién intentó cambiar qué, y si se le dejó (también lo denegado) | `--audit-log` |
| **Salud** (`/healthz`, `/readyz`) | Que un balanceador, Docker o un monitor sepan si está vivo y si puede trabajar | Siempre |
| **Métricas** (`/metrics`, formato Prometheus) | Peticiones, latencias, errores, cálculo, cuentas y proceso | `--metrics` (+ token) |

Todo lo que escribe algo está **apagado por omisión**: sin opciones, `iark serve` no crea ningún archivo de registro ni sirve métricas; solo pone `X-Request-Id` y atiende `/healthz` y `/readyz`. Activarlo no cambia ninguna respuesta (salvo esa cabecera) y un registro que falle nunca tumba el servicio.

## Opciones

| Opción | Variable de entorno | Qué hace |
|---|---|---|
| `--access-log <archivo\|->` | `IARK_ACCESS_LOG` | Registro de accesos, JSON por línea. `-` es la salida estándar. |
| `--audit-log <archivo\|->` | `IARK_AUDIT_LOG` | Auditoría, JSON por línea. El archivo se crea con modo `0600` y solo se le añade. |
| `--metrics` | `IARK_METRICS=1` | Sirve `GET /metrics`. |
| `--metrics-token <token>` | `IARK_METRICS_TOKEN` o `IARK_METRICS_TOKEN_FILE` (el contenido del archivo) | Token `Bearer` de `/metrics`: de 16 a 256 caracteres imprimibles, sin espacios (`openssl rand -hex 32`). Mejor por entorno o archivo que por la línea de comandos, que se ve en la lista de procesos. |

La opción manda sobre la variable de entorno. Las rutas de los archivos se crean (con sus carpetas, modo `0700`) al arrancar; si no se pueden abrir, `iark serve` sale con código 2 antes de abrir el puerto. Los dos registros no pueden ser el mismo archivo (la auditoría se conserva; los accesos se rotan). Con `-` en los dos, ambos salen por la salida estándar, mezclados: la clave `type` (`access` o `audit`) los distingue. Los avisos y errores del servicio siguen yendo, como texto libre, a stderr (la salida estándar solo lleva JSON).

```bash
iark serve --workspace ./proyectos --accounts cuentas.json … \
  --access-log - \                       # los accesos a la salida estándar (Docker los recoge)
  --audit-log /var/log/iark/auditoria.jsonl \
  --metrics --metrics-token "$(cat /etc/iark/metricas.token)"
```

## `X-Request-Id`

Cada respuesta lleva `X-Request-Id`. Si la petición trae uno **razonable** (de 1 a 64 caracteres entre letras, dígitos, `.`, `_`, `:` y `-`, empezando por letra o dígito) se respeta —lo ponen así muchos proxies y clientes—; si no (más largo, con espacios, comillas, repetido…) se ignora y se genera un UUID v4. Nunca puede llevar comillas ni saltos de línea. No es una identidad ni un secreto (quien llama elige el suyo): sirve para correlacionar, jamás para autorizar.

El mismo identificador sale en **cada línea de los dos registros**, y en stderr junto a un error interno (`error interno: …` seguido de `  petición: <id>`), de modo que partiendo de lo que ve quien llama (la cabecera) se llega al acceso, a la fila de auditoría y a la traza. La respuesta de un error interno no lo repite en el cuerpo (sigue siendo «Error interno del servicio.»).

Limitación: no se anuncia en `Access-Control-Expose-Headers`, así que el JavaScript de un sitio de otro origen no puede leerlo (las herramientas del navegador y los proxies sí lo ven).

## Registro de accesos

Una línea JSON por petición, escrita al terminar la respuesta:

```json
{"ts":"2026-10-09T00:48:39.325Z","type":"access","requestId":"alta-tienda-001","method":"POST","route":"/api/projects","status":201,"durationMs":9.29,"bytes":145,"remote":"203.0.113.9","actor":{"kind":"user","id":"u_0iwvjFXwUdBORy1u","login":"beto","role":"member"}}
```

| Campo | Contenido |
|---|---|
| `ts` | Fecha y hora UTC (ISO 8601, milisegundos) del final de la petición. |
| `type` | `"access"`. |
| `requestId` | El `X-Request-Id` de la respuesta. |
| `method` | El método HTTP (hasta 20 letras mayúsculas o guiones; si trae otra cosa, `OTHER`). Las métricas agrupan todo lo que no sea uno de los siete métodos conocidos en `OTHER`. |
| `route` | La **plantilla** de la ruta, no la ruta real: `/api/projects/:project/diagrams/:diagram`, `/api/:module/validate`, `/assets/*`, `/api/projects/*` (una forma desconocida). Un conjunto cerrado de unas decenas de valores: **sin identificadores de proyecto, de diagrama ni de persona, y sin query string**. |
| `status` | El código HTTP de la respuesta. `499` si el cliente colgó antes de recibirla (y entonces `"aborted":true`). |
| `durationMs` | Milisegundos desde que llegó la petición hasta que terminó la respuesta. |
| `bytes` | Bytes de cuerpo enviados (antes de la compresión de un proxy). |
| `remote` | La dirección del cliente: la de la conexión o, con `--trust-proxy`, la última de `X-Forwarded-For` (la que añadió el proxy). |
| `actor` | Quién llama, si la autenticación lo identificó: `{"kind":"user","id","login","role"}` (sesión de GitHub; `role` es su rol en la instancia) o `{"kind":"token","name","role"}` (token de `iark auth`). Sin credencial, o con una falsa, no hay `actor`. |

**No se escribe nunca**: la cabecera `Authorization`, tokens ni sesiones, cookies (`Cookie`, `Set-Cookie`), el `code`, el `state` ni el `verifier` del inicio de sesión de GitHub, nada de la query string (la dirección de vuelta de GitHub lleva un código de un solo uso), cuerpos de petición ni de respuesta, contenido ni nombres de diagramas o proyectos, `User-Agent`, `Referer`. Lo único que llega de fuera a la línea es el `X-Request-Id` (validado) y la dirección; el resto sale de conjuntos cerrados y `JSON.stringify` escapa saltos de línea, comillas y caracteres de control (y U+0085, U+2028 y U+2029, que algunos lectores toman por saltos): nadie puede fabricar una línea falsa ni un campo falso.

No dejan línea las comprobaciones de las máquinas (`/healthz`, `/readyz`, `/metrics`) **que salen bien**: a diario serían miles sin información. Si fallan (503, 401…), sí. Las métricas las cuentan todas.

Si el destino va más lento que las peticiones (una tubería saturada), las líneas que pasarían de 1 MiB en espera se descartan y se cuentan (`iark_log_lines_total{outcome="dropped"}`) en vez de acumularse en memoria.

## Auditoría

Una línea JSON por **intento** de hacer algo que importa, con su resultado, también cuando se denegó. Sirve para responder «¿quién cambió esto y cuándo?» y «¿quién ha intentado entrar o tocar lo que no es suyo?».

```json
{"ts":"2026-10-09T00:48:39.356Z","type":"audit","requestId":"8a00356b-e76d-4ef4-a387-ff971887d343","action":"diagram.create","result":"ok","status":201,"actor":{"kind":"token","name":"servicio","role":"admin"},"target":{"project":"tienda","diagram":"contexto"}}
{"ts":"2026-10-09T00:48:39.339Z","type":"audit","requestId":"e0928b77-2b44-4053-a60e-341e61716ecb","action":"project.create","result":"denied","status":401,"code":"unauthorized","actor":{"kind":"anonymous"}}
{"ts":"2026-10-09T01:12:02.771Z","type":"audit","requestId":"4f0c…","action":"member.add","result":"ok","status":201,"actor":{"kind":"user","id":"u_0iwv…","login":"beto","role":"member"},"target":{"project":"tienda","login":"carla"},"change":{"role":"viewer"}}
```

| Campo | Contenido |
|---|---|
| `ts`, `type`, `requestId`, `status` | Como en el registro de accesos (`type` es `"audit"`). Con `requestId` se cruza con el acceso, que sí lleva la dirección. |
| `action` | Qué se intentó (tabla de abajo). |
| `result` | `ok` (salió bien), `denied` o `error`. |
| `code` | Solo si no fue `ok`: el código del error de la API (`unauthorized`, `forbidden`, `not-found`, `conflict`, `limit`, `invalid`, `self`…) o `http-<estado>` si no traía uno; en los inicios de sesión fallidos, el motivo. |
| `actor` | Quién: como en el registro de accesos, o `{"kind":"anonymous"}` si no hubo credencial válida. |
| `target` | Sobre qué, **solo por identificadores**: `project`, `diagram`, `login` (la persona afectada). Nunca nombres de proyecto ni contenido. |
| `change` | Lo pedido, de un conjunto cerrado de valores: `role` (`viewer`, `editor`, `admin`), `siteRole` (`admin`, `member`, `guest`), `disabled` (booleano). |

`result: "denied"` es un 401 o un 403, y también el 404 que el servicio da a quien **no pertenece a un proyecto** (a propósito no distingue «no existe» de «no es suyo»; para una persona sin rol de administración en la instancia ese 404 cuenta como denegación). Es ambiguo en un caso: un 404 de un diagrama que no existe en un proyecto propio también sale `denied` con `code: "not-found"`. `error` es todo lo demás que falló (409 de un conflicto, 400 de datos inválidos…).

| Acción | Cuándo | `target` · `change` |
|---|---|---|
| `auth.login` | Una persona completó el inicio de sesión (cambió su código por una sesión). | — |
| `auth.login-failed` | Un intento de iniciar sesión que no llegó a sesión. `code`: `access_denied` (no aceptó en GitHub), `not_invited`, `disabled`, `state-mismatch`, `invalid-grant` (código o verificador falsos), `github_unavailable`, `login_failed`. | `login`, si GitHub llegó a decir quién era |
| `auth.logout` | Cerrar sesión. | — |
| `auth.denied` | Una ruta protegida sin acción propia (`/api/whoami`, listas…) rechazó una credencial **falsa** o un rol insuficiente. Una petición sin cabecera `Authorization` a una ruta de lectura no deja fila (queda en el acceso y en las métricas). | `project`, `login` si la ruta los lleva |
| `compute.denied` | Una ruta de cálculo (validar, exportar, importar, comparar, `run`, `trace`) dio 401 o 403. El cálculo que sale bien no se audita. | — |
| `project.create` · `project.import` | Crear un proyecto / importar un archivo de proyecto. | `project` (el nuevo, si salió bien) |
| `project.rename` · `project.delete` | Renombrar / borrar un proyecto. | `project` |
| `project.export` | Descargar el archivo único de un proyecto (`/bundle`): es sacar todo el proyecto, y por eso se audita aunque sea una lectura. | `project` |
| `diagram.create` · `diagram.save` · `diagram.rename` · `diagram.delete` | Crear / guardar / renombrar / borrar un diagrama. | `project`, `diagram` |
| `version.restore` · `version.label` · `version.delete` | Historial de versiones de un diagrama: restaurar una versión (crea una nueva), nombrarla o borrar una nombrada. | `project`, `diagram`, `version` |
| `member.add` · `member.role` · `member.remove` | Compartir un proyecto con alguien (201), cambiar su rol (200) o quitarle (también cuando alguien se va por sí mismo). Si la petición se rechaza antes de saber cuál de las dos era, `member.set`. | `project`, `login` · `role` |
| `user.invite` · `user.role` · `user.disable` · `user.enable` · `user.quota` · `user.remove` | Administración de cuentas (`/api/admin/users`): invitar, cambiar el rol de la instancia, desactivar, reactivar, fijar la cuota de espacio de una persona, quitar una invitación. Una petición con dos cambios deja dos filas. Si se rechaza sin leer el cuerpo, `user.set`. | `login` · `siteRole`, `disabled`, `quota` (solo los números `bytes`, `projects` y `diagramsPerProject`; `null` es «el valor de la instancia») |

Las acciones se **deducen de la petición cuando termina** (método + plantilla de la ruta, el código de estado, la cabecera `Location` de lo que se creó y, solo en las rutas de miembros y de cuentas, los campos permitidos del cuerpo), sin tocar los manejadores de la API de proyectos ni de cuentas; solo el inicio de sesión lo anotan los manejadores de `/api/auth`, porque son quienes saben el motivo. Una prueba (`src/cli/observability/audit.test.ts`) lee la documentación de la API y falla si una ruta documentada que cambia algo no tiene su acción.

**Qué no se audita**: las lecturas (listar y abrir proyectos y diagramas, la lista de miembros, `whoami`), el cálculo que sale bien, los 429 del freno de intentos (ya son una métrica, y una dirección que insiste no debe llenar el archivo) y los cambios que se hacen fuera del servicio (editar el archivo de cuentas o la carpeta de trabajo a mano; `iark accounts migrate` sobre la base de cuentas; crear o revocar tokens con `iark auth`; `iark project …` sobre la carpeta).

**Cómo se escribe**: cada fila se escribe en el acto (`writeSync` con `O_APPEND`, sin buffer en memoria) en un archivo `0600` (si ya existía con otro modo se corrige). Si el archivo falla (disco lleno, volumen desmontado), el servicio **sigue**, avisa una sola vez por episodio por stderr, cuenta el fallo (`iark_log_errors_total{log="audit"}`) y manda cada fila que no pudo escribir también a stderr, para que no se pierda del todo; reintenta abrir cada 5 s. Conviene una alerta sobre ese contador (abajo).

**Lo que no garantiza**: «solo se añade» significa que el servicio nunca reescribe ni trunca el archivo, no que sea a prueba de manipulación: quien administre la máquina (o el usuario del proceso) puede editarlo. Si lo necesita como prueba, envíelo a un sistema externo o ponga el atributo de solo añadir en el sistema de archivos (`chattr +a` en Linux; necesita root y complica la rotación).

## Salud: `/healthz` y `/readyz`

Sin autenticación, sin CORS, sin detalles, solo `GET` y `HEAD`, y no se anotan en el registro de accesos mientras salgan bien.

- **`GET /healthz`** («vivo»): `200 {"status":"ok"}` mientras el proceso atienda conexiones. No toca el disco, ni las cuentas, ni los hilos de cálculo, así que no depende de nada que pueda estar roto. Es lo que consulta el `HEALTHCHECK` de la imagen Docker.
- **`GET /readyz`** («listo»): `200` si puede hacer su trabajo y `503` si no, con el nombre de cada comprobación y `ok` o `fail`:

  ```json
  {"status":"fail","checks":{"workspace":"fail","tokens":"ok","accounts":"ok","compute":"ok"}}
  ```

  | Comprobación | Cuándo existe | Qué prueba |
  |---|---|---|
  | `workspace` | con `--workspace` | Que se puede escribir en la carpeta de trabajo: crea y borra un archivo temporal oculto (`.iark-ready-<pid>-<azar>.tmp`). `access(W_OK)` no basta: no ve un disco lleno ni un volumen de solo lectura. Si la carpeta aún no existe, prueba la existente más cercana por encima. |
  | `tokens` | con `--tokens` | Que el archivo de tokens se lee y es válido (si no, el servicio está denegando todo con 503). |
  | `accounts` | con `--accounts` | Que el archivo de cuentas existe y se lee, que el almacén responde a una lectura de verdad (con `--accounts-store sqlite`, una consulta a la base; con `json` el estado está en memoria y basta el archivo) y que se puede escribir en su carpeta (el JSON se reemplaza por renombrado en cada cambio; SQLite crea ahí su diario `-wal` y `-shm`). No toma el candado de escritura de la base. |
  | `compute` | con hilos de cálculo (`--workers` > 0) | Que el pool no está cerrado, que existe el archivo de su hilo y que los últimos tres hilos no se cayeron seguidos sin contestar. No crea ningún hilo para averiguarlo. Un pool ocupado o con la cola llena **sigue vivo**: eso es carga y lo cuentan las métricas. |

  Nunca incluye rutas ni secretos. El resultado se **cachea 5 segundos** (varias peticiones a la vez comparten una sola ronda), cada comprobación tiene 2 s de plazo, y cuando una cambia de estado se anota una línea en stderr con su nombre.

**¿Cuál usar?** El `HEALTHCHECK` de la imagen y de `deploy/docker-compose.yml` usan **`/healthz`** a propósito: un problema pasajero del disco no debe hacer que Docker o la plataforma den el servicio por muerto y lo reinicien (ni que Caddy, que espera a que esté sano, no arranque). `/readyz` es para quien decide si **mandarle tráfico**: un balanceador, un monitor externo o una alerta. Una plataforma que solo ofrece una comprobación y puede sacar la instancia de rotación sin reiniciarla puede usar `/readyz`.

## Métricas: `/metrics`

Apagadas por omisión: sin `--metrics`, `GET /metrics` responde 404 como cualquier ruta que no existe. Encendidas, **no son públicas**:

- **Con `--metrics-token`**: exige `Authorization: Bearer <token>`. Sin él o con otro, 401 (con `WWW-Authenticate`); la comparación es en tiempo constante; tras 5 fallos seguidos desde una dirección, 429 con `Retry-After` (el mismo freno que protege los tokens de la API). El token es solo para esto: no abre nada más, y los de la API no abren `/metrics`.
- **Sin token**: solo atiende conexiones de loopback y, si el servicio escucha en loopback, comprueba también la cabecera `Host` (contra el «DNS rebinding»: una página ajena no puede leerlas).
- **El arranque lo exige**: `--metrics` sin token con `--host 0.0.0.0` (o cualquier dirección que no sea de loopback), o con `--trust-proxy` (un proxy en la misma máquina las publicaría con una conexión de loopback), termina con código 2 y no abre el puerto. En el contenedor, que escucha en `0.0.0.0`, el token es obligatorio.
- No lleva cabeceras de CORS y no se cachea.

| Métrica | Tipo | Etiquetas | Qué cuenta |
|---|---|---|---|
| `iark_http_requests_total` | contador | `method`, `route`, `status_class` | Peticiones atendidas. `route` es la plantilla; `status_class`, `2xx`…`5xx`; `method` uno de los siete conocidos u `OTHER`. |
| `iark_http_request_duration_seconds` | histograma | `route` | Duración de las peticiones (cubos de 5 ms a 60 s). |
| `iark_http_requests_in_flight` | indicador | — | Peticiones en curso (la propia lectura de `/metrics` cuenta). |
| `iark_http_rate_limited_total` | contador | — | Respuestas 429. |
| `iark_auth_failures_total` | contador | `reason` | Autenticaciones fallidas: `missing` (sin credencial), `invalid` (falsa), `rate_limited`, `unavailable` (el archivo de tokens no se puede leer) y `login_failed` (inicios de sesión que no llegaron a sesión). |
| `iark_audit_events_total` | contador | `action`, `result` | Filas de auditoría (se cuentan aunque no haya `--audit-log`). |
| `iark_log_lines_total` · `iark_log_errors_total` | contador | `log`, `outcome` · `log` | Líneas escritas o descartadas de cada registro, y fallos al abrir o escribir (solo de los registros activados). |
| `iark_compute_workers` · `_workers_max` · `_active` · `_queued` | indicador | — | Hilos de cálculo creados, tope, operaciones en curso y en cola. |
| `iark_compute_completed_total` · `_timeouts_total` · `_rejected_total` · `_worker_crashes_total` | contador | — | Operaciones terminadas, canceladas por pasar del plazo, rechazadas por cola llena (503 `busy`) e hilos caídos. |
| `iark_accounts` · `iark_sessions_active` | indicador | `state` (`active`, `disabled`, `pending`) · — | Recuentos de cuentas y de sesiones vigentes (solo números; con `--accounts`). |
| `iark_quota_rejections_total` · `iark_quota_limit` | contador · indicador | `kind` (`bytes`, `projects`, `diagrams`) | Operaciones rechazadas por superar una cuota desde que arrancó el proceso, y los topes de la instancia por omisión (`0` = sin tope; con `--accounts` y `--workspace`). **Sin etiquetas de persona ni de proyecto**: lo que ocupa cada persona se ve en la administración de cuentas ([cuotas](cuentas-github.md#cuotas-de-uso)). |
| `iark_tokens` · `iark_tokens_file_ok` | indicador | — | Tokens del archivo y si el archivo se puede leer (`0` = el servicio deniega todo; con `--tokens`). |
| `iark_build_info` | indicador | `version` | Siempre 1. |
| `process_start_time_seconds` · `process_uptime_seconds` · `process_resident_memory_bytes` · `process_cpu_seconds_total` | — | — | El proceso. |
| `nodejs_eventloop_lag_seconds` · `_p99_seconds` · `_max_seconds` | indicador | — | Retraso del bucle de eventos desde la lectura anterior (media, percentil 99, máximo); sube cuando algo bloquea el hilo principal. |

**Privacidad y cardinalidad.** Ninguna etiqueta lleva personas, proyectos, diagramas, tokens ni direcciones IP: salen de conjuntos cerrados (la plantilla de la ruta, la clase de estado, la acción de auditoría, el motivo del fallo), y las cuentas y las sesiones son solo recuentos. Una prueba comprueba la lista de nombres de etiqueta y que nada de lo que escribe quien llama (rutas, métodos, cabeceras) crea series nuevas. Aun así, cada familia limita sus series a 500: pasado el tope, las nuevas se agrupan en `other` en vez de crecer sin fin. Los contadores se reinician con el proceso, como siempre en Prometheus.

## Consultas y alertas de ejemplo

Las consultas con `jq` se probaron contra los registros de un `iark serve` real; las reglas de Prometheus, `logrotate` y Caddy de más abajo **no se probaron** contra esos programas (no se instalaron en el entorno donde se escribió esto): trátelas como punto de partida.

**Auditoría y accesos con `jq`**

```bash
# quién tocó un proyecto, y cuándo
jq -c 'select(.target.project=="tienda") | {ts,action,result,quien:(.actor.login // .actor.name // .actor.kind)}' auditoria.jsonl
# todo lo denegado
jq -c 'select(.result=="denied") | {ts,action,code,requestId}' auditoria.jsonl
# inicios de sesión fallidos, por motivo y persona
jq -r 'select(.action=="auth.login-failed") | [.ts,.code,(.target.login // "-")] | @tsv' auditoria.jsonl
# desde qué dirección fue una fila de auditoría: se cruza por requestId con el registro de accesos
jq -c --arg id "e0928b77-2b44-4053-a60e-341e61716ecb" 'select(.requestId==$id)' acceso.jsonl auditoria.jsonl
# las direcciones con más 401 (fuerza bruta o un token caducado en un cliente)
jq -r 'select(.status==401) | .remote' acceso.jsonl | sort | uniq -c | sort -rn | head
# errores del servidor por ruta, y las peticiones lentas
jq -r 'select(.status>=500) | .route' acceso.jsonl | sort | uniq -c | sort -rn
jq -c 'select(.durationMs>1000) | {ts,route,durationMs,requestId}' acceso.jsonl
```

Con los dos registros en la salida estándar de un contenedor, `docker compose logs --no-log-prefix iark | jq -c 'select(.type=="audit")'` (los avisos de stderr no son JSON: añada `2>/dev/null` o `jq -R 'fromjson? | …'`).

**Reglas de Prometheus** (`prometheus.yml` con el token por archivo, y una regla por síntoma):

```yaml
scrape_configs:
  - job_name: iark
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/iark-metricas.token
    static_configs:
      - targets: ['iark:8787']          # por la red interna de compose; no publique el puerto
```

```yaml
groups:
  - name: iark
    rules:
      - alert: IArkCaido
        expr: up{job="iark"} == 0
        for: 2m
      - alert: IArkErrores5xx
        expr: sum(rate(iark_http_requests_total{status_class="5xx"}[5m])) / sum(rate(iark_http_requests_total[5m])) > 0.05
        for: 10m
      - alert: IArkLento
        # el cálculo (exportar, importar) tarda segundos con diagramas grandes: se mide sin él
        expr: histogram_quantile(0.95, sum by (le) (rate(iark_http_request_duration_seconds_bucket{route!~"/api/:module/.*|/api/trace"}[5m]))) > 1
        for: 10m
      - alert: IArkIntentosDeAcceso
        expr: sum(rate(iark_auth_failures_total{reason=~"invalid|login_failed"}[10m])) > 0.5 or increase(iark_http_rate_limited_total[10m]) > 0
      - alert: IArkCalculoSaturado
        expr: iark_compute_queued > 0 or increase(iark_compute_rejected_total[15m]) > 0 or increase(iark_compute_timeouts_total[15m]) > 0
        for: 5m
      - alert: IArkBucleBloqueado
        expr: nodejs_eventloop_lag_p99_seconds > 0.2
        for: 5m
      - alert: IArkMemoria
        expr: process_resident_memory_bytes > 0.8 * 768 * 1024 * 1024      # el mem_limit del compose
        for: 10m
      - alert: IArkNoEscribeLosRegistros
        # la auditoría que no se escribe es la peor: la fila solo queda en stderr
        expr: increase(iark_log_errors_total[15m]) > 0 or increase(iark_log_lines_total{outcome="dropped"}[15m]) > 0
      - alert: IArkTokensIlegibles
        expr: iark_tokens_file_ok == 0
```

Para vigilar `/readyz` desde fuera (el `workspace` y `accounts` son los que importan), cualquier monitor de URL sirve: espere `200` y alerte tras unos fallos seguidos.

## Rotar los registros

Los archivos crecen sin límite: rótelos. `iark serve` **vuelve a abrir los archivos de registro al recibir `SIGHUP`** (solo si hay alguno; sin archivos conserva el comportamiento de siempre de `SIGHUP`, terminar el proceso; no existe en Windows). La rotación estándar es renombrar y avisar:

```
# /etc/logrotate.d/iark   (sin probar con logrotate)
/var/log/iark/*.jsonl {
    weekly
    rotate 8
    maxage 60
    compress
    delaycompress
    missingok
    notifempty
    create 0600 iark iark
    sharedscripts
    postrotate
        systemctl kill -s HUP iark.service        # o: kill -HUP "$(cat /run/iark.pid)"
    endscript
}
```

Con `copytruncate` (sin `create` ni `postrotate`) también funciona, porque el archivo se abre con `O_APPEND`, pero puede perder las líneas escritas entre la copia y el vaciado. Al reabrir, el archivo nuevo se crea con modo `0600` si no existe.

**Con Docker** (el `deploy/docker-compose.yml`): el registro de accesos va a la salida estándar, y Docker lo rota con el `logging` del servicio (`json-file`, 10 MB × 3: unos 30 MB; lo más antiguo se borra; si necesita conservarlo más tiempo, envíelo a un recolector con otro `logging.driver` o ponga `IARK_ACCESS_LOG` en un archivo). La auditoría va a `/data/audit.jsonl`, en el volumen, y **no se rota sola**: con logrotate en el anfitrión (la ruta real la da `docker volume inspect iark-data`) y el aviso con `docker compose -f deploy/docker-compose.yml kill -s HUP iark`; o a mano, de vez en cuando:

```bash
cd deploy
mv /var/lib/docker/volumes/iark-data/_data/audit.jsonl /var/lib/docker/volumes/iark-data/_data/audit-$(date +%F).jsonl
docker compose kill -s HUP iark          # el servicio vuelve a abrir audit.jsonl (nuevo, 0600)
gzip /var/lib/docker/volumes/iark-data/_data/audit-*.jsonl
```

## Datos personales

Los registros contienen **datos personales**:

- el **nombre de usuario de GitHub** (y un identificador interno de cuenta) de quien actúa, en los dos registros;
- la **dirección IP** del cliente, en el registro de accesos (con `--trust-proxy`, la que anota el proxy);
- el **nombre de los tokens** de `iark auth`, que suele ser el de una persona («Ana García»);
- en la auditoría, los **identificadores** de proyecto y de diagrama (que salen del nombre del proyecto: `adquisicion-banco-x` dice algo) y el usuario de GitHub de a quien se comparte o se invita.

No contienen contraseñas (no hay), tokens, sesiones, cookies, el código ni el verificador del inicio de sesión, cuerpos ni contenido de diagramas, ni `User-Agent` ni `Referer`. Las métricas no llevan ningún dato personal: solo recuentos.

Como cualquier registro con usuario e IP, entran en la normativa de protección de datos que le aplique (por ejemplo el RGPD). Esto no es asesoría legal; sí hay decisiones técnicas para **recoger menos y guardarlo menos tiempo**:

1. **Encienda solo lo que necesita.** La auditoría (quién cambió qué) no lleva direcciones IP; el registro de accesos sí. Si solo le interesa la rendición de cuentas, active `--audit-log` y deje `--access-log` apagado: se pierde la dirección, pero se conserva quién, qué y cuándo (y `iark_http_requests_total` sigue contando todo sin personas ni direcciones).
2. **Fije una retención y cúmplala.** `rotate`/`maxage` de logrotate (arriba) o, con Docker, el `max-size`/`max-file` del `logging`. Un criterio razonable: accesos, de 7 a 30 días (suficiente para investigar un incidente); auditoría, lo que su política de seguridad pida, y no más.
3. **Seudonimice al archivar.** Antes de guardar copias largas se pueden truncar las direcciones, por ejemplo (solo IPv4):
   `jq -c '.remote |= (if test("^[0-9.]+$") then (split(".")[0:3]|join(".")+".0") else . end)' acceso.jsonl`
4. **Restrinja el acceso.** Los archivos son `0600` del usuario del servicio; no los haga legibles para más gente de la necesaria ni los envíe a un servicio externo sin haberlo decidido.
5. **No active `--trust-proxy` sin proxy:** cualquiera podría escribir en `X-Forwarded-For` lo que quisiera y quedaría como su «dirección».
6. Las filas de auditoría **no se editan en el sitio**: si una persona pide que se borre su usuario de ellas, es una decisión de política de retención (rotar y descartar los archivos viejos), no una función del servicio.

## Detrás de un proxy (Caddy)

El `Caddyfile` de `deploy/` no activa el registro de accesos de Caddy: la dirección de vuelta de GitHub lleva un código de un solo uso en la query string, y el de IArk nunca anota la query string. Tres ajustes **opcionales** (sin probar: no hay Caddy en el entorno donde se escribió esto):

```
{$IARK_DOMAIN} {
	# /metrics no sale a internet aunque esté activado (IArk ya lo protege con token); Prometheus lo lee por iark:8787
	@metricas path /metrics
	respond @metricas 404

	reverse_proxy iark:8787 {
		# un identificador de petición propio de Caddy, para cruzar sus registros con los de IArk (IArk respeta un X-Request-Id válido)
		header_up X-Request-Id {http.request.uuid}
		# comprobación activa de que IArk puede trabajar (carpeta de trabajo, cuentas): Caddy deja de mandarle tráfico si /readyz da 503
		health_uri /readyz
		health_interval 15s
	}
}
```

## Límites

- **Registros y métricas por proceso**: son del proceso, no de la instancia. Con varias instancias sobre una misma base SQLite de cuentas (ver [Dónde se guardan las cuentas](cuentas-github.md#dónde-se-guardan-las-cuentas-json-o-sqlite)) habría que reunirlos fuera, y `iark_accounts` e `iark_sessions_active` salen iguales en todas porque leen la base compartida. Si la base no responde, esas dos métricas no salen en esa lectura (el resto de `/metrics` sigue) y `/readyz` da 503 en `accounts`.
- **Sin trazas distribuidas ni niveles de registro**: no hay OpenTelemetry ni líneas de depuración; los avisos y errores siguen siendo texto libre en stderr.
- **El registro de accesos anota el final de la petición**: una caída del proceso a mitad de una petición no deja línea de ella (la auditoría tampoco: se escribe al terminar).
- **No se mide la sobrecarga**: es una línea JSON por petición y unas pocas sumas en memoria; no se hizo una prueba de carga.
- **No se ha probado** con un Prometheus real, `logrotate`, Caddy, ni en una plataforma concreta; las pruebas del repositorio comprueban el formato de `/metrics` línea a línea, el contenido de los registros contra el servidor real y el CLI empaquetado como proceso. La imagen Docker no se construyó ni se ejecutó `npm run docker:smoke` al hacer este cambio (que ahora comprueba `/healthz`, `/readyz` y `/metrics`).
