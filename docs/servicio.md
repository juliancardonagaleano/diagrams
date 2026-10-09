# Servicio HTTP y servidor para varias personas

[← Índice de la documentación](indice.md)

`iark serve` es el servicio HTTP de la suite: la API por módulo, el manifiesto de federación y, con `--static`, el sitio compilado. Con `--workspace` (una carpeta) o con `--workspace-store postgres` (una base, para un servicio sin disco persistente) añade la API de [proyectos](proyectos.md); con `--tokens` (abajo) o con `--accounts` ([inicio de sesión con GitHub](cuentas-github.md)) puede escuchar en una red. Con `--accounts` y `--workspace` cada persona tiene además **cuotas de uso** (espacio, proyectos y diagramas por proyecto: `--max-bytes`, `--max-projects`, `--max-diagrams`; [Cuotas de uso](cuentas-github.md#cuotas-de-uso)); con `--tokens` no hay cuotas. La guía paso a paso para desplegarlo con HTTPS y disco es [despliegue-nube.md](despliegue-nube.md).

## Servicio HTTP (`iark serve`)

```bash
npm run build
node dist/cli/index.js serve --static dist/app --port 8787      # o: docker build -t iark-diagrams . && docker run --rm -p 8787:8787 iark-diagrams
curl localhost:8787/api/modules
curl -X POST localhost:8787/api/security/validate -d @examples/seguridad-ejemplo.json
curl -X POST 'localhost:8787/api/security/export?format=svg&view=dfd' -d @examples/seguridad-ejemplo.json > dfd.svg
```

| Ruta | Descripción |
|---|---|
| `GET /.well-known/iark.json` · `GET /api/modules` | Manifiesto de la instancia y capacidades de los módulos |
| `GET /api/<módulo>/capabilities` · `/schema[?kind=generation]` | Formatos, informes, vistas de traza; JSON Schema del documento o de la salida de IA |
| `POST /api/<módulo>/validate` · `/views` · `/export?format=&view=` | Cuerpo: el documento JSON |
| `POST /api/<módulo>/import?importer=&name=` | Cuerpo: texto (Mermaid, OpenAPI, AsyncAPI, Threat Dragon, Terraform, Kubernetes, CloudFormation, Helm, DDL, dbt, OpenLineage, ArchiMate, BPMN según el módulo) → documento y avisos |
| `POST /api/<módulo>/diff` | Cuerpo `{ before, after }` (dos documentos del módulo) → lo añadido, quitado, modificado y reordenado |
| `POST /api/<módulo>/run/<comando>` | Cuerpo `{ input?, args?, options? }` → informe o conversión |
| `POST /api/trace` | Cuerpo `{ documents: [{ module, document }], from?, direction?, depth?, types?, orphans?, matrix?, coverage? }` → grafo de trazabilidad (con el tipo de cada enlace); `types` (`["implements"]`) mira solo esos enlaces, y `orphans` (`true`, `"módulo"` o `"módulo:tipo"`), `matrix` (`"module"` o `"kind"`) y `coverage` (`["security:asset -> platform"]`) añaden huérfanos, matriz y cobertura (ver [Trazabilidad](trazabilidad.md)) |
| `GET /healthz` · `GET /readyz` | Vivo (`200 {"status":"ok"}`) y listo (`200` o `503` según la carpeta de trabajo, los tokens, las cuentas y el cálculo). Sin autenticación y sin detalles |
| `GET /metrics` | Métricas de Prometheus. Solo con `--metrics`: con `--metrics-token` o, sin él, solo desde loopback |

Con `--workspace <carpeta>` añade además la API de proyectos (`/api/projects…`, con sus propias reglas de seguridad: ver [API HTTP de proyectos](proyectos.md#api-http-de-proyectos)); con `--workspace-store postgres` (o `IARK_WORKSPACE_STORE=postgres`) la misma API guarda los proyectos en una base Postgres en vez de en una carpeta, sin indicar carpeta y con la conexión solo en el entorno (`IARK_DATABASE_URL`: ver [Proyectos en Postgres](proyectos.md#proyectos-en-postgres-un-servicio-sin-disco-persistente) y [Postgres](postgres.md)), y `/readyz` comprueba la base en lugar de la carpeta; con `--tokens <archivo>` (o con `--accounts`, el inicio de sesión con GitHub: ver [Servicio gestionado](cuentas-github.md)) exige un token con rol en esa API y puede escuchar fuera de loopback (ver [Servidor para varias personas (nube autoalojada)](#servidor-para-varias-personas-nube-autoalojada)); sin ella, el servicio no guarda estado. Sin dependencias (`node:http`). Sin `--cors` solo responde al mismo origen; `--cors https://mi-app.example` (o `*`) abre la API a un navegador de otro origen. El cuerpo máximo es de 5 MB. La IA (`generate`, `explain` y `review`) sigue viviendo solo en el CLI: ver [Por qué no hay IA en el servicio](#por-qué-no-hay-ia-en-el-servicio).

### Por qué no hay IA en el servicio

`iark serve` no expone `generate`, `explain` ni `review`, ni ninguna otra ruta que llame a un modelo (`/api/<módulo>/schema?kind=generation` solo devuelve el JSON Schema de la salida de IA: es un dato, no llama a nadie). En el CLI quien ejecuta el comando usa sus propias claves y paga lo suyo; en el servicio, **cada petición sería dinero de quien lo despliega**, y hoy el servicio no tiene con qué contenerlo:

- Las rutas de cálculo cuestan CPU, y eso se acota con hilos de trabajo, tiempo máximo y cola limitada; una llamada a un modelo cuesta dinero, y un solo prompt puede llegar a decenas de miles de tokens (por omisión, hasta 100.000 de entrada y 200.000 en total por llamada, ver [IA](ia.md#topes-de-tokens-sin-precios)).
- Sin `--tokens` ni `--accounts` todo está abierto; con `--public-compute` el cálculo queda abierto a propósito. Una ruta de IA así vaciaría la cuenta del modelo con peticiones anónimas.
- Con tokens o cuentas hay identidad y rol, pero **no hay contabilidad por persona**: el servicio no registra accesos ni cuenta consumo, así que una sola persona (o un token filtrado) podría gastar todo el presupuesto sin que nadie lo vea.

**Qué habría que exigir antes de añadirla** (los tres a la vez, no uno):

1. **Credencial obligatoria**: la ruta de IA nunca se abre con `--public-compute` ni en un servicio sin tokens ni cuentas; exige un token o una sesión con el rol que se decida (por ejemplo `editor` o superior), también en loopback, y la clave del modelo es del servidor (variable de entorno o secreto), nunca de la petición.
2. **Cuota por persona**: un contador por token o cuenta (no por dirección IP) de peticiones y de tokens por día, guardado en disco para que sobreviva a un reinicio, con `429` y `Retry-After` al agotarse.
3. **Tope de presupuesto**: un tope global del servicio (tokens por día o por mes, sumados entre todas las personas) además de los topes por petición que ya existen (`--max-tokens`, `--budget-tokens`, `--max-input-tokens`); al agotarse responde sin llamar al modelo (`503`) y lo anota para quien administra.

Además haría falta registrar quién gastó qué (hoy el servidor no registra accesos) y mantener fuera de la ruta `--from-repo`, porque leería el disco del servidor. Está **sin implementar** a propósito: la prueba `src/cli/serveSinIa.test.ts` fija que no existe ninguna ruta de IA, y quien añada una tendrá que cambiarla junto con estos tres requisitos. Mientras tanto, quien necesite IA desde una interfaz tiene el CLI, `iark prompt` (sin clave) y la pestaña **IA** del editor web (copiar el prompt, pegar el JSON).

Cada respuesta lleva `X-Request-Id`. El registro de accesos (`--access-log`), la auditoría de cambios (`--audit-log`), la salud y las métricas están en [Observabilidad](observabilidad.md); los registros y las métricas están apagados por omisión.

### Módulos de terceros en el servicio (`--config`)

```bash
iark serve --config ./iark.config.json --port 8787     # o IARK_CONFIG=./iark.config.json (y IARK_NO_CONFIG=1 para no cargar nada)
```

Con `--config` (o `IARK_CONFIG`, o un `iark.config.json` en el directorio donde se arranca) el servicio carga los [módulos de terceros](plugins.md) de esa configuración y los sirve como a los incorporados: salen en `/api/modules` y en el manifiesto `/.well-known/iark.json` (con su `contractVersion` y su `documentVersion`, y **sin** `embed` ni esquema estático: el sitio no los trae, su esquema está en `/api/<módulo>/schema`) y tienen su API (`/api/<módulo>/validate`, `/export`, `/import`, `/run/<comando>`, y en `/api/trace`) con la misma autenticación, roles y límites. El cálculo en hilos de trabajo (`--workers`) carga los mismos módulos, así que da igual con hilos que con `--workers 0`. Un módulo que no carga **impide arrancar** el servicio (código 2, con el especificador en el mensaje). Los módulos los fija quien arranca el servicio: ninguna petición ni proyecto puede cargar uno, y el `iark.config.json` de dentro de una carpeta `--workspace` no se carga.

**El sitio web (`--static`) no los muestra**: el banco de trabajo, el shell y el editor se compilan con los seis módulos incorporados. Un módulo de terceros es solo API y CLI.

### Imagen Docker

El `Dockerfile` (dos etapas sobre `node:22-alpine`) compila la biblioteca, el CLI y el sitio, deja solo las dependencias de producción y arranca `iark serve --host 0.0.0.0 --port $PORT --static dist/app` (`PORT` vale 8787 por defecto) como el usuario `node` (no root). La imagen pesa unos 210 MB (la base de Node, unos 165 MB; `node_modules`, 28 MB; el sitio, 9 MB; el CLI, 3 MB) y sin variables no guarda estado (la demo); lo que guarda el servicio gestionado va a `/data`. Pesaba 355 MB mientras el frontend (react, Semi UI, xyflow, zustand…) estaba en `dependencies`: Vite ya lo empaqueta en `dist/app`, así que ahora es `devDependencies` y `npm prune --omit=dev` lo descarta; el paquete npm tampoco lo arrastra a quien lo instala (22 paquetes y 52 MB en vez de 209 y 271 MB).

```bash
docker build -t iark-diagrams .
docker run --rm -p 8787:8787 iark-diagrams                                   # editor, banco de trabajo, shell y API en http://localhost:8787
docker run --rm -p 9000:8787 iark-diagrams --cors https://mi-app.example    # otro puerto del anfitrión y la API abierta a ese origen
docker run --rm -e PORT=9100 -p 9000:9100 iark-diagrams                      # otro puerto de dentro (el HEALTHCHECK lo sigue)
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -p 8787:8787 iark-diagrams   # endurecida: no escribe en disco
```

- Los argumentos tras el nombre de la imagen se añaden al `ENTRYPOINT` (`--cors`, `--static`…); si repites una opción, gana la última. Para cambiar el puerto de publicación basta `-p`. El puerto de dentro sale de la variable `PORT` (8787 por defecto), que usan igual el servidor y el `HEALTHCHECK` (consulta `/healthz`): cámbialo con `-e PORT=9100`, no con `--port` (el servidor escucharía en otro puerto que el `HEALTHCHECK` no mira y el contenedor acabaría `unhealthy`; si aun así lo haces, sobrescribe el chequeo con `--health-cmd` o `--no-healthcheck`).
- Para guardar proyectos y compartirlos entre personas (volúmenes, tokens, HTTPS), ver [Servidor para varias personas (nube autoalojada)](#servidor-para-varias-personas-nube-autoalojada): la imagen escucha en `0.0.0.0`, así que con `IARK_WORKSPACE` y sin autenticación (`IARK_TOKENS` o el inicio de sesión de GitHub, `IARK_ACCOUNTS`…) se niega a arrancar; por eso la imagen no fija `IARK_WORKSPACE`. Para el servicio con inicio de sesión de GitHub, ver [Servicio gestionado](cuentas-github.md) y la [guía de despliegue](despliegue-nube.md).
- La carpeta `/data` de la imagen es del usuario `node` (1000:1000): un volumen con nombre la hereda; en un bind mount, la carpeta del anfitrión debe ser de `1000:1000`. Si una plataforma monta el disco con dueño root y no deja cambiarlo, `docker build --build-arg IARK_RUN_AS=root` construye la imagen para correr como root (último recurso).
- Módulos de terceros en la imagen: no trae ninguno. Monta una carpeta con el módulo **y su `node_modules`** (con `@iark/kernel` y `zod` instalados; el módulo resuelve sus `import` desde ahí, no desde `/app`) y apunta `IARK_CONFIG` a su configuración: `docker run --rm -p 8787:8787 -v "$PWD/plugins:/plugins:ro" -e IARK_CONFIG=/plugins/iark.config.json iark-diagrams`. Ponla fuera de `/data` y del espacio de trabajo. Detalles y seguridad: [Módulos de terceros](plugins.md#iark-serve-y-docker).
- El `HEALTHCHECK` consulta `/healthz`: público, sin tocar el disco ni los hilos de cálculo, así que sirve igual con la autenticación activada y un problema pasajero del disco no hace que Docker dé el servicio por muerto. `/readyz` (carpeta de trabajo escribible, tokens y cuentas legibles, cálculo vivo) es para un balanceador o un monitor: ver [Observabilidad](observabilidad.md#salud-healthz-y-readyz).
- Registros y métricas en el contenedor: `-e IARK_ACCESS_LOG=-` (accesos a la salida estándar, para `docker logs`), `-e IARK_AUDIT_LOG=/data/audit.jsonl` (auditoría en el volumen) y `-e IARK_METRICS=1 -e IARK_METRICS_TOKEN=…` (`/metrics`; el contenedor escucha en `0.0.0.0`, así que el token es obligatorio).
- El contenedor pasa a `healthy` en unos segundos (`docker inspect --format '{{.State.Health.Status}}' <contenedor>`) y `docker stop` lo detiene en menos de un segundo con código 0: `iark serve` cierra el servidor al recibir `SIGTERM`, sin necesidad de `--init`.
- Probado con Docker 29 (`docker build`, `docker run --network host` y `docker run -p` con red de puente e iptables, incluida la variante endurecida y `-e PORT` con otro `-p`): `/`, `/modulos.html?module=data`, `/suite.html`, `/trazabilidad.html`, `/.well-known/iark.json`, `/api/modules`, validar y exportar (SVG, Mermaid y draw.io) un ejemplo de cada módulo, importar Mermaid, `run/<comando>` y `POST /api/trace`.
- Servicio gestionado, probado con Docker 29 (`npm run docker:smoke`, ver [Pruebas](desarrollo.md#pruebas); y `deploy/docker-compose.yml` levantado de verdad con Compose 5, con el HTTPS interno de Caddy sobre `localhost`, no con un certificado público): demo sin variables, negativa a arrancar sin autenticación, inicio de sesión completo contra un GitHub de mentira, un proyecto en el volumen `/data`, la sesión y el proyecto tras `docker restart` y tras sustituir el contenedor, corriendo como `node` con el sistema de archivos de solo lectura y sin capacidades, volumen con nombre y bind mount, secreto por archivo, copia y restauración, y que ni el secreto ni las sesiones salgan en `docker logs`.

## Servidor para varias personas (nube autoalojada)

Con `--tokens`, `iark serve --workspace` deja de ser solo de una persona en su máquina: puede escuchar en una red (o en internet, detrás de HTTPS) con **una cuenta por persona** y **roles**. El sitio publicado en GitHub Pages es estático y no tiene servidor: la «nube» es la que usted aloja, y el cliente web se conecta a ella con la URL del servidor y el token de cada persona. Con `--tokens` no hay registro abierto de usuarios ni OAuth: las «cuentas» son tokens que emite quien administra el servidor (para entrar con GitHub y tener permisos por proyecto, ver [Servicio gestionado](cuentas-github.md)).

### Crear tokens

```bash
iark auth create "Ana García" --role admin  --tokens iark-tokens.json    # imprime el token UNA vez (stdout); un recordatorio, por stderr
iark auth create "Luis"       --role editor --tokens iark-tokens.json
iark auth create "Visitas"    --role viewer --tokens iark-tokens.json
iark auth list   --tokens iark-tokens.json                               # nombre, rol y fecha; --json para otras herramientas
iark auth revoke "Visitas" --tokens iark-tokens.json
export IARK_TOKENS=iark-tokens.json                                      # equivale a --tokens en `iark auth` y en `iark serve`
```

- Un token es `iark_` y 32 bytes aleatorios en base64url (`iark_Zk3…`, 48 caracteres). **El archivo guarda solo su hash (sha256)**, nunca el token: quien lo lea no puede usarlo, y si se pierde el token no se puede recuperar (se revoca y se crea otro). El archivo es `{ "version": 1, "tokens": [{ "name", "role", "hash", "createdAt" }] }`, se crea con modo 0600 y se escribe de forma atómica (temporal + `rename`).
- El nombre es único (sin distinguir mayúsculas) y es el que devuelve `whoami`. Los tokens no caducan: se revocan por su nombre.
- **El servidor relee el archivo cuando cambia** (su fecha, tamaño o inodo): crear o revocar un token surte efecto en la siguiente petición, sin reiniciar. Si el archivo no se puede leer o está dañado, el servidor **deniega todo** (503, nunca abre el acceso) y lo anota en stderr, sin contenido; vuelve el acceso en cuanto el archivo es válido otra vez. Al arrancar, en cambio, el archivo debe existir y ser válido (si no, el servidor no arranca: código 2).
- `iark auth` hace una persona cada vez: dos administradores a la vez pueden pisarse el cambio.

### Arrancar

```bash
iark serve --host 0.0.0.0 --port 8787 \
  --workspace ./iark-workspace --tokens ./iark-tokens.json \
  --cors https://juliancardonagaleano.github.io
```

- **Fuera de loopback, `--tokens` es obligatorio.** Con `--workspace` (o `IARK_WORKSPACE`) y un `--host` que no sea `127.0.0.1`, `localhost` o `::1`, sin `--tokens` el servicio **se niega a arrancar** (código 2) y explica las dos salidas: exigir tokens, o escuchar solo en `--host 127.0.0.1`. Sin espacio de trabajo no hay proyectos que proteger, pero `--tokens` sigue protegiendo el cálculo (validar, exportar, importar, comparar, `run`, `/api/trace`: piden un token de cualquier rol).
- `--tokens` también vale en loopback (entonces también se exige token). Sin `--tokens`, todo funciona exactamente como en [API HTTP de proyectos](proyectos.md#api-http-de-proyectos).
- `--cors <orígenes>` lista los sitios web que pueden llamar a la API desde el navegador: aquí, el cliente web publicado (`https://juliancardonagaleano.github.io`, solo el origen, sin ruta). Con tokens también vale `*` (ver [CORS](#cors) más abajo).
- Detrás de un proxy, añada `--trust-proxy` (ver [Límites](#límites)).
- Con tokens fuera de loopback el arranque recuerda que el servicio **no habla TLS**.

### Roles

| Operación | `viewer` | `editor` | `admin` |
|---|:---:|:---:|:---:|
| Leer: `GET` de proyectos, diagramas, archivo único (`bundle`), comprobación (`check`) y `/api/whoami` | sí | sí | sí |
| Crear, guardar, renombrar y borrar **diagramas** | no | sí | sí |
| Crear y renombrar **proyectos** · importar un proyecto (`POST /api/projects/import`) | no | sí | sí |
| Borrar **proyectos** (`DELETE /api/projects/<p>`) | no | no | sí |
| Ver el **historial de versiones** de un diagrama y leer una versión (`GET …/versions`) | sí | sí | sí |
| Restaurar (`POST …/versions/<v>/restore`) y nombrar una versión (`PATCH …/versions/<v>`) | no | sí | sí |
| Borrar una versión **con nombre** (`DELETE …/versions/<v>`) | no | no | sí |

Cada rol incluye lo de los de abajo. Lo que no es una lectura (también un método o una ruta que no existen) exige al menos `editor`: un `viewer` recibe 403 en cualquier escritura, sin sondear con peticiones torcidas. El rol se comprueba **antes** de leer el cuerpo o tocar el disco. Con `--tokens` los roles valen para todo el espacio de trabajo (no hay permisos por proyecto); con `--accounts` cada persona tiene un rol en cada proyecto (ver [Quién ve qué](cuentas-github.md#quién-ve-qué)).

### Contrato HTTP con autenticación

Las rutas `/api/projects…` y `GET /api/whoami` exigen la cabecera `Authorization: Bearer <token>` (el esquema no distingue mayúsculas). El resto de la API (validar, exportar, módulos, manifiesto…) sigue sin pedir token: no toca el disco.

| Estado | Cuándo | Cuerpo y cabeceras |
|---|---|---|
| `401` | Sin cabecera, con otro esquema, o con un token que no existe o se revocó | `{ "error": "…", "code": "unauthorized" }` + `WWW-Authenticate: Bearer realm="iark"`. El mensaje es el mismo exista o no el token |
| `403` | El rol del token no alcanza para la operación | `{ "error": "…", "code": "forbidden" }` |
| `429` | Demasiados intentos fallidos desde la misma dirección | `{ "error": "…", "code": "rate-limited" }` + `Retry-After: <segundos>` |
| `503` | El archivo de tokens no se puede leer o está dañado (se deniega todo) | `{ "error": "…", "code": "unavailable" }`. Distinto del 401 a propósito: un cliente no debe confundir un servidor mal configurado con un token revocado (y olvidar el token) |

- `GET /api/whoami` → `{ "auth": true, "name": "Ana García", "role": "admin" }` con un token válido (401 si no). Sin `--tokens` es público y responde `{ "auth": false }`. Es la forma de comprobar un token antes de guardarlo y de saber qué rol tiene.
- El manifiesto (`/.well-known/iark.json`, siempre público) anuncia `"projects": "../api/projects"` y `"projectsAuth": "bearer"` (o `"none"` sin tokens): el cliente lo lee para saber si debe pedir un token.
- **Frenado de intentos fallidos**: desde una misma dirección se toleran 5 intentos fallidos (una petición que trae `Authorization` y no vale); después, 1 s de espera, y se duplica con cada fallo más (2 s, 4 s…) hasta un tope de 5 min. Mientras dura el freno, todas las peticiones de esa dirección a estas rutas dan 429, también las que traigan un token bueno (si no, el freno serviría para seguir adivinando). Las peticiones sin cabecera no cuentan, un acierto no borra los fallos y una dirección que no falla durante 15 min se olvida. Es en memoria (se pierde al reiniciar) y acotado.
- **Con tokens ya no se comprueban `Host` ni `Origin`** en estas rutas: la credencial es una cabecera que el navegador no añade por su cuenta, así que una página ajena no puede usar la API sin un token que alguien le haya dado (no hay CSRF) y no hay «DNS rebinding» que atajar; además el servidor se expone con otros nombres y desde otros sitios. **Se mantiene** `Content-Type: application/json` en POST, PUT, PATCH y DELETE (415 si no).
- Un token nunca se escribe en ningún registro ni se devuelve en ninguna respuesta.

### Cambios en tiempo real (`GET /api/events`)

Un canal de **servidor a cliente** (Server-Sent Events) para que las pestañas de varias personas se enteren de los cambios de los proyectos sin sondear. No es edición colaborativa ni sincroniza documentos: solo avisa de que algo cambió. Está encendido por omisión con `--workspace`; `--max-streams 0` (o `IARK_MAX_STREAMS=0`) lo apaga (la ruta da 404, el manifiesto no anuncia `projectsEvents` y los clientes vuelven al sondeo).

- **Autenticación y roles: los de siempre.** Pide la cabecera `Authorization: Bearer` (token de `--tokens` o sesión de `--accounts`) con cualquier rol (también `viewer`); sin ella, 401. Lo lee `fetch` con streaming, no `EventSource`: el token nunca va en la URL, y por eso tampoco queda en ningún registro. Solo `GET` (405 con otro método). Con cuentas, el canal de cada persona solo recibe los proyectos a los que pertenece **en el momento del cambio** (se evalúa al publicar, no al abrir: quien entra o sale de un proyecto lo nota al instante); quien administra la instancia recibe todos. A quien se le acaba de quitar de un proyecto le llega ese único aviso (`project.changed`) y nada más. Con `?project=<id>` solo se avisa de ese proyecto. Con tokens, un token vale para toda la carpeta, como en la API.
- **Los eventos.** `ready` (al abrir, con el intervalo del latido), `change` y `bye` (`unauthorized` si la credencial se revocó o venció, `shutdown` al parar el servidor). `change` lleva `{ type, project, diagram?, updatedAt?, by?, at }` con `type` en `project.created|changed|deleted` o `diagram.created|saved|renamed|deleted|restored`. **Sin documento, sin nombres ni textos**; `by` es quien lo hizo (`@usuario` o el nombre del token). Cada 20 s un comentario `: hb` mantiene viva la conexión y vuelve a comprobar que la credencial sigue valiendo (revocar un token cierra el canal con `bye` en el siguiente latido).
- **Topes.** Por persona 8 canales abiertos (`--max-streams <n>`, `IARK_MAX_STREAMS`, de 1 a 1000) y 1000 en total; el siguiente da 429 con `Retry-After: 30` y `{ "code": "limit" }`. Una persona = una cuenta, un token o, sin credenciales, una dirección. Un cliente lento (más de 256 KiB sin leer) se desconecta y vuelve a leer la lista. Al parar el servidor (`SIGTERM`) todos los canales se cierran con `bye`.
- **Detrás de un proxy.** La respuesta lleva `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` y `Connection: keep-alive`. Hace falta que el proxy **no almacene en búfer ni comprima** esa ruta y tenga un tiempo de lectura largo: en nginx, `proxy_buffering off;` y `proxy_read_timeout 1h;` en `location /api/events`; en Caddy, `encode` sin esa ruta y `flush_interval -1` (ver `deploy/Caddyfile`). Un proxy que corta la conexión larga no rompe nada: el cliente lo nota (200 sin `text/event-stream`, o silencio) y sondea como antes.
- **Registros.** El registro de accesos anota **una línea al cerrarse** el canal (no al abrirse), con la ruta `/api/events`, `stream: true`, `events` (cuántos avisos se enviaron), `bytes`, duración y quién, sin query string ni credenciales; no cuenta como petición en curso ni entra en el histograma de duración (dura horas). La auditoría no anota nada: es solo lectura. Métricas: `iark_event_streams` (abiertos), `iark_events_published_total`, `iark_events_delivered_total`, `iark_event_streams_rejected_total` y `iark_event_streams_dropped_total`, sin etiquetas por persona ni proyecto ([observabilidad](observabilidad.md#métricas-metrics)).
- **Con el almacén de cuentas `json` o `sqlite`** funciona igual (la pertenencia se consulta por la interfaz del almacén).
- **Límites.** El canal es **de un proceso**: con varias instancias detrás de un balanceador, cada una solo avisa de lo que pasa por ella (hace falta un bus compartido que no existe; con los proyectos en Postgres tampoco, porque el pooler de transacción no admite `LISTEN`); los cambios que se hacen directamente en la carpeta o con `iark project …` no se anuncian; no hay reenvío de lo perdido en un corte (`Last-Event-ID`): el cliente relee la lista al reconectar.

### CORS

Con tokens, las rutas `/api/projects…` y `/api/whoami` anuncian `Access-Control-Allow-Headers: Content-Type, Authorization`, todos los métodos (`GET, POST, PUT, PATCH, DELETE, OPTIONS`) y `Access-Control-Expose-Headers: Retry-After, Content-Disposition, Location` para los orígenes de `--cors` **y también para `*`**. Sin tokens, para esta API hay que nombrar el origen: abrirla a `*` dejaría que cualquier página escribiera en el disco. Con tokens no hace falta esa cautela, porque la credencial es una cabecera que el navegador no envía por sí solo (no se usan cookies ni `Access-Control-Allow-Credentials`): una página ajena sin token recibe 401. El preflight `OPTIONS` no lleva credenciales y siempre responde 204, también con `Authorization` en `Access-Control-Request-Headers`; las respuestas de error (401, 403, 429…) llevan las mismas cabeceras de CORS, para que el cliente pueda leerlas. El resto de la API conserva el CORS de siempre.

### Con Docker

El contenedor corre como el usuario `node` (uid 1000): la carpeta de trabajo y la de tokens deben poder leerse por ese usuario (y la de trabajo, escribirse).

```bash
docker build -t iark-diagrams .
mkdir -p datos/espacio datos/tokens && sudo chown -R 1000:1000 datos
# crear el primer token con la propia imagen (su ENTRYPOINT es `serve`, así que se cambia por `node`)
docker run --rm -v "$PWD/datos/tokens:/tokens" --entrypoint node iark-diagrams \
  dist/cli/index.js auth create "Ana García" --role admin --tokens /tokens/tokens.json
# el servicio, con la carpeta de trabajo y la de tokens como volúmenes; publicado solo en el anfitrión, donde va el proxy con HTTPS (abajo)
docker run -d --name iark -p 127.0.0.1:8787:8787 \
  -v "$PWD/datos/espacio:/workspace" -v "$PWD/datos/tokens:/tokens:ro" \
  -e IARK_WORKSPACE=/workspace -e IARK_TOKENS=/tokens/tokens.json \
  iark-diagrams --cors https://juliancardonagaleano.github.io --trust-proxy
```

- **Monte la carpeta de los tokens, no el archivo.** Docker monta un archivo suelto por su inodo, y `iark auth` reemplaza el archivo de forma atómica (con otro inodo): el contenedor seguiría viendo el de antes y las revocaciones no surtirían efecto. Con la carpeta montada sí. El servidor solo lee el archivo, así que `:ro` vale.
- La imagen escucha en `0.0.0.0`: con `IARK_WORKSPACE` y sin `IARK_TOKENS` se niega a arrancar. Un archivo de tokens creado en el anfitrión con otro usuario (modo 0600) no lo podrá leer el contenedor: créelo con la imagen, como arriba, o cámbiele el dueño (`chown 1000`).
- Para revocar o listar: `docker run --rm -v "$PWD/datos/tokens:/tokens" --entrypoint node iark-diagrams dist/cli/index.js auth revoke "Ana García" --tokens /tokens/tokens.json`; el servidor en marcha lo nota solo.
- El `HEALTHCHECK` de la imagen consulta `/healthz`, que es público.
- La imagen trae `/data`, una carpeta vacía del usuario `node`: con un **volumen con nombre** (`-v iark-data:/data`) hereda ese dueño y sirve tal cual; con un bind mount de una carpeta del anfitrión, su dueño debe ser `1000:1000` (`chown 1000:1000 <carpeta>`). Es la carpeta que usa el servicio gestionado (`IARK_WORKSPACE=/data/workspace`, `IARK_ACCOUNTS=/data/accounts.db`: las cuentas van en una base SQLite, el almacén `IARK_ACCOUNTS_STORE=sqlite` que fija la imagen; ver [Dónde se guardan las cuentas](cuentas-github.md#dónde-se-guardan-las-cuentas-json-o-sqlite)).
- **Con inicio de sesión de GitHub** en lugar de tokens (nube gestionada), la imagen y un `docker-compose.yml` con Caddy, el secreto como Docker secret y el volumen ya están preparados en [`deploy/`](../deploy/); la guía paso a paso (OAuth App, dominio, primer arranque, copias de seguridad) es [`docs/despliegue-nube.md`](despliegue-nube.md).

Con HTTPS delante (Caddy), en un `docker-compose.yml`:

```yaml
services:
  iark:
    image: iark-diagrams
    restart: unless-stopped
    command: ["--cors", "https://juliancardonagaleano.github.io", "--trust-proxy"]
    environment:
      IARK_WORKSPACE: /workspace
      IARK_TOKENS: /tokens/tokens.json
    volumes:
      - ./datos/espacio:/workspace
      - ./datos/tokens:/tokens:ro
    # sin `ports`: solo el proxy llega a él
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

### HTTPS: el servidor no habla TLS

`iark serve` solo habla HTTP: sin HTTPS los tokens viajan en claro. Ponga delante un proxy inverso con un certificado, y pásele `--trust-proxy` a `iark serve`. Lo mínimo con Caddy (obtiene y renueva el certificado solo; `nube.ejemplo.org` debe apuntar a su máquina):

```
nube.ejemplo.org {
	reverse_proxy iark:8787
}
```

o con nginx (certificado ya emitido, por ejemplo con certbot):

```nginx
server {
    listen 443 ssl;
    server_name nube.ejemplo.org;
    ssl_certificate     /etc/letsencrypt/live/nube.ejemplo.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nube.ejemplo.org/privkey.pem;
    client_max_body_size 6m;                          # el servidor admite cuerpos de hasta 5 MB
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # el cliente real; no se fía de lo que el cliente haya puesto
        proxy_set_header X-Forwarded-Proto $scheme;      # con --trust-proxy, así sabe el servidor que la petición llegó por https
    }
    location /api/events {                            # canal de cambios en tiempo real (SSE): una conexión larga, sin búfer ni compresión
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        gzip off;
        proxy_read_timeout 1h;
    }
}
```

### Cabeceras de seguridad

`iark serve` añade cabeceras de seguridad a sus respuestas sin configurar nada (`src/cli/securityHeaders.ts`):

| Cabecera | Dónde | Valor |
|---|---|---|
| `X-Content-Type-Options` | todas las respuestas | `nosniff` |
| `Strict-Transport-Security` | solo si la petición llegó por https (directo o, con `--trust-proxy`, por `X-Forwarded-Proto`) | `max-age=15552000` (180 días), sin `includeSubDomains` ni `preload`: esas decisiones son de quien opera el dominio |
| `Content-Security-Policy` | páginas HTML | `script-src 'self'` (sin `unsafe-inline` ni `unsafe-eval`), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`; `connect-src` y `frame-src` admiten el propio origen, cualquier `https:` y el bucle local, porque la suite habla con otras instancias (manifiesto, proyectos, editores embebidos) y no se sabe cuáles hasta que alguien las conecta |
| `Referrer-Policy` · `Permissions-Policy` · `X-Frame-Options` | páginas HTML | `no-referrer` · cámara, micrófono, geolocalización, pagos y USB vacíos · `SAMEORIGIN` en las páginas normales (las cargas embebidas no la llevan) |

**Quién puede incrustar la instancia por `<iframe>`** (`frame-ancestors`). Las páginas normales solo las puede incrustar la propia instancia. Las cargas embebidas (`?embed=1` en `index.html`, `modulos.html`; es lo que añaden `createIarkEmbed`, `createIarkModuleEmbed` y `<iark-module>`) se rigen por `--frame-ancestors` (o `IARK_FRAME_ANCESTORS`), una lista de orígenes separados por comas, o `*`. **Por omisión es `*`**, porque el producto se vende como embebible desde cualquier aplicación. Si solo lo incrustas en tu propia aplicación, fíjala a su origen:

```bash
iark serve --workspace ./proyectos --tokens tokens.json --frame-ancestors https://app.ejemplo.org
```

Una lista concreta siempre incluye además el propio origen (la suite incrusta el editor C4 y el banco de módulos). Añadir `?embed=1` a otra página (la suite, la trazabilidad…) no abre su incrustación. Con la imagen Docker del repositorio, la variable `IARK_FRAME_ANCESTORS` de `deploy/.env` llega al servicio.

**Lo que no cubre.** Detrás de un proxy que ya pone alguna de estas cabeceras, la del servicio y la del proxy pueden coincidir: deja una sola. El sitio de GitHub Pages es estático y no puede enviar cabeceras (no hay CSP ni `frame-ancestors` allí). Firefox no expone `ancestorOrigins`: el editor embebido toma el origen del anfitrión de `?origin=` o de `document.referrer` (ver [Modo embebido](embebido.md)).

### Límites

- **Sin TLS** (arriba) y, con `--tokens`, **sin registro abierto ni OAuth**: no hay contraseñas, ni registro de personas, ni inicio de sesión con terceros (eso lo ofrece `--accounts`: ver [Servicio gestionado](cuentas-github.md)). Quien administra crea un token por persona y se lo entrega por un canal seguro. Los tokens no caducan y sus roles son globales al espacio de trabajo (no hay permisos por proyecto; con `--accounts` sí).
- **Un token guardado en el navegador queda expuesto a cualquier XSS del sitio que lo use** (y a las extensiones del navegador y a quien use ese equipo). Use el rol mínimo (`viewer` para quien solo lee), revoque el token ante la duda y no abra el cliente web desde un sitio que no controle.
- **`--trust-proxy` solo detrás de un proxy.** Sin él, todos los clientes de un proxy comparten la dirección del proxy y, por tanto, el freno de intentos fallidos: cualquiera podría frenar a todos durante unos minutos con tokens inválidos. Con él, la dirección sale de la última entrada de `X-Forwarded-For`: sin un proxy delante, cualquiera cambiaría de dirección a voluntad y el freno no serviría. El freno es por dirección exacta (no agrupa un IPv6 por su prefijo) y no sustituye a un cortafuegos.
- **Sin cuotas con `--tokens`**: un token con rol `editor` o `admin` puede llenar el disco de la carpeta de trabajo (o la base, con `--workspace-store postgres`) (las cuotas por persona son de `--accounts`: [Cuotas de uso](cuentas-github.md#cuotas-de-uso)); vigile el espacio libre del volumen.
- Un token con rol `editor` o `admin` puede escribir y borrar en la carpeta de trabajo: el control de versiones de la carpeta (git, copias de seguridad) es su red de seguridad. Cada diagrama se guarda de forma atómica y `ifUpdatedAt` detecta un guardado en medio, pero no hay edición simultánea (solo avisos de cambios: ver «Cambios en tiempo real») (quién intentó cambiar qué lo anota, si se activa, la [auditoría](observabilidad.md#auditoría)).
- El servidor no registra accesos ni cambios salvo que se active (`--access-log`, `--audit-log`: ver [Observabilidad](observabilidad.md)). Con `--tokens` o `--accounts`, validar, exportar, importar, comparar, `run` y `/api/trace` piden una credencial de cualquier rol y se calculan en hilos de trabajo con tiempo máximo y cola acotada (ver [Límites honestos](despliegue-nube.md#9-límites-honestos)); `--public-compute` o `IARK_PUBLIC_COMPUTE=1` los deja abiertos. Sin tokens ni cuentas, todo está abierto y cuesta CPU de su servidor con cuerpos de hasta 5 MB.
