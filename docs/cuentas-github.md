# Servicio gestionado: inicio de sesión con GitHub

[← Índice de la documentación](indice.md)

Con `--accounts`, el mismo `iark serve --workspace` ofrece **«Iniciar sesión con GitHub»** en lugar de repartir tokens a mano: cada persona entra con su cuenta de GitHub, el servicio guarda quién es y a qué proyectos pertenece, y le da una **sesión** (un token que caduca) que se usa exactamente como un token de `iark auth`: `Authorization: Bearer <sesión>`. Lo que hace falta es una OAuth App de GitHub (la crea quien aloja el servicio: [guía de despliegue](despliegue-nube.md), con los valores exactos de cada campo), un lugar donde guardar las cuentas (un archivo JSON o, mejor para un servicio de verdad, una base SQLite o, sin disco persistente o con varias máquinas, Postgres: ver [Dónde se guardan las cuentas](#dónde-se-guardan-las-cuentas-json-sqlite-o-postgres)) y la dirección pública del servicio. `--tokens` sigue existiendo y puede usarse a la vez (cuentas de servicio, scripts y CLI con un rol para toda la carpeta).

```bash
export IARK_GITHUB_CLIENT_SECRET=…            # solo por entorno o por IARK_GITHUB_CLIENT_SECRET_FILE: nunca por la línea de comandos
iark serve --host 0.0.0.0 --port 8787 --static dist/app \
  --workspace ./iark-workspace --accounts ./iark-accounts.json \
  --github-client-id Iv1.abc123 --public-url https://iark.ejemplo.org \
  --admins 583231 --signup invite
```

| Opción | Variable | Qué hace |
|---|---|---|
| `--accounts <archivo>` | `IARK_ACCOUNTS` | Dónde guarda el servicio las cuentas, las sesiones y la pertenencia a proyectos: un archivo JSON (modo 0600, escritura atómica; un solo proceso) o, con `--accounts-store sqlite`, una base SQLite (modo 0600, transaccional; admite varios procesos). Solo lo escribe el servicio: no lo edite con él en marcha. **No se usa con `postgres`** (las cuentas van a la base de `IARK_DATABASE_URL`; si se da, se avisa y se ignora) |
| `--accounts-store json\|sqlite\|postgres` | `IARK_ACCOUNTS_STORE` | Qué almacén usa el servicio: `json` (por omisión en el CLI, como siempre), `sqlite` o `postgres`. **La imagen Docker y el `docker-compose.yml` de `deploy/` usan `sqlite`**. Detalle y migración abajo |
| — | `IARK_DATABASE_URL` o `IARK_DATABASE_URL_FILE` | Solo con `postgres`: la conexión a la base (`postgres://usuario:clave@host:puerto/base`). **No existe opción de línea de comandos**: lleva la contraseña. El resto de la configuración (TLS, pool, esquema) y el pooler de Supabase: [postgres.md](postgres.md) |
| `--accounts-import <archivo>` | `IARK_ACCOUNTS_IMPORT` | Solo con `sqlite` o `postgres`: si la base está vacía, importa en el arranque este JSON de cuentas (o una base SQLite) sin tocarlo (deja una copia de seguridad). Es la forma de actualizar sin pasos a mano; si el archivo no existe o la base ya se importó de él, no hace nada |
| `--github-client-id <id>` | `IARK_GITHUB_CLIENT_ID` | Client ID de la OAuth App |
| — | `IARK_GITHUB_CLIENT_SECRET` o `IARK_GITHUB_CLIENT_SECRET_FILE` | Client secret de la OAuth App. **No existe opción de línea de comandos**: se vería en la lista de procesos |
| `--public-url <url>` | `IARK_PUBLIC_URL` | Dirección pública del servicio (https; solo `localhost` puede ser http). La «Authorization callback URL» de la OAuth App es `<esa dirección>/api/auth/github/callback` |
| `--signup invite\|open` | `IARK_SIGNUP` | `invite` (por omisión): solo entran los administradores y las personas invitadas (o con un proyecto compartido: ver [Compartir proyectos](#compartir-proyectos)). `open`: entra cualquiera con cuenta de GitHub |
| `--admins <lista>` | `IARK_ADMINS` | Administradores de la instancia, separados por comas: nombres de usuario de GitHub o, **mejor, sus identificadores numéricos** (el nombre de usuario puede pasar a otra persona si su dueña lo cambia; el id no). `curl https://api.github.com/users/<usuario>` lo da |
| `--session-days <n>` | `IARK_SESSION_DAYS` | Duración de una sesión (30 por omisión) |
| `--max-projects <n>` | `IARK_MAX_PROJECTS` | Cuota: proyectos que puede poseer cada persona (25 por omisión; `0` quita el tope; los administradores de la instancia no tienen tope). Ver [Cuotas de uso](#cuotas-de-uso) |
| `--max-diagrams <n>` | `IARK_MAX_DIAGRAMS` | Cuota: diagramas que admite cada proyecto (200 por omisión; `0` quita el tope) |
| `--max-bytes <tamaño>` | `IARK_MAX_BYTES` | Cuota: espacio total de los proyectos de cada persona, documentos más historial de versiones (`256M` por omisión; acepta `500K`, `1.5G`, bytes sueltos; `0` o `off` quita el tope; los administradores de la instancia no tienen tope) |
| `--cors <orígenes>`, `--trust-proxy` | `IARK_CORS`, `IARK_TRUST_PROXY=true` | Orígenes que pueden llamar a la API desde un navegador y a los que se vuelve tras entrar (para volver hay que nombrarlos: un `*` no vale); y «hay un proxy de confianza delante» (solo con proxy: ver [Límites](servicio.md#límites)). Sirven para plataformas que solo se configuran por entorno |
| `--github-url`, `--github-api-url` | `IARK_GITHUB_URL`, `IARK_GITHUB_API_URL` | Con GitHub Enterprise Server, su dirección y su API (`https://git.empresa.com`, `https://git.empresa.com/api/v3`) |
| `--access-log`, `--audit-log`, `--metrics`, `--metrics-token` | `IARK_ACCESS_LOG`, `IARK_AUDIT_LOG`, `IARK_METRICS`, `IARK_METRICS_TOKEN` | Registro de accesos, **auditoría** (quién inició sesión, falló al hacerlo o cambió qué, también lo denegado), y métricas de Prometheus. Apagados por omisión; llevan el usuario de GitHub y la dirección IP: ver [Observabilidad](observabilidad.md) |

Con cuentas, el servicio puede escuchar fuera de loopback sin `--tokens` (hace falta una de las dos formas de autenticarse). Si falta algo de lo anterior, el arranque lo dice todo de una vez (código 2). Con `--signup invite` y sin administradores ni cuentas todavía, nadie podría entrar: no arranca.

**Desplegarlo**: la imagen Docker ya sirve como servicio gestionado y [`deploy/`](../deploy/) trae un `docker-compose.yml` de producción (DIAgrams + Caddy con HTTPS automático, volumen de datos y el secreto de la OAuth App como Docker secret). La guía [`docs/despliegue-nube.md`](despliegue-nube.md) lleva de cero a un servicio en marcha: registrar la OAuth App, DNS y firewall, primer arranque, entrar como administradora, usar el sitio de GitHub Pages contra la instancia, copias de seguridad, actualizar y los errores más frecuentes.

## Dónde se guardan las cuentas: JSON, SQLite o Postgres

Las cuentas, las sesiones y a quién se compartió cada proyecto se guardan en un **almacén** a elegir con `--accounts-store`. Los tres hacen exactamente lo mismo de cara al servicio y a la API (hay una batería de pruebas común que los obliga, y otra que los compara paso a paso); lo que cambia es cómo se protegen los datos:

| | `json` (por omisión en el CLI) | `sqlite` (imagen Docker y `deploy/`) | `postgres` (Supabase u otra base gestionada) |
|---|---|---|---|
| Dónde | Un JSON, modo 0600, escritura atómica | Una base SQLite (`cuentas.db` + `-wal` y `-shm`), modo 0600 | Cuatro tablas `cuentas_*` del esquema `iark` de la base de `IARK_DATABASE_URL`, con seguridad por filas y sin permisos para `PUBLIC` ni los roles de Supabase |
| Varios procesos sobre lo mismo | **No** (cada uno tiene su copia en memoria y se pisan) | **Sí**, sobre un disco local: cada cambio es una transacción | **Sí**, también en máquinas distintas |
| Un fallo a mitad de un cambio | Se deshace en memoria; el archivo no cambia | `ROLLBACK`: no queda nada a medias | `ROLLBACK`: no queda nada a medias |
| Topes (500 invitaciones, 20 sesiones por cuenta, 100 miembros) y «el proyecto no se queda sin administrador» | Se cumplen en un proceso | Se cumplen también entre procesos: se comprueban dentro de la transacción | Se cumplen también entre procesos y máquinas: se comprueban dentro de la transacción, tras un candado de asesoramiento |
| Un corte de luz | Lo escrito atómicamente sigue ahí | Lo confirmado sigue ahí (`synchronous=FULL`) | Lo confirmado sigue ahí (lo garantiza la base) |
| Esquema | Un JSON versionado (`version: 1`; la cuota personal es un campo opcional más, sin cambiar la versión) | `PRAGMA user_version` con migraciones numeradas (la 2 añade la cuota personal); una base de una versión más nueva no se abre | Migraciones numeradas (`iark.migraciones`, espacio `cuentas`); una base de una versión más nueva no arranca |
| Necesita | Nada | Node 22.13 o superior (`node:sqlite`, integrado: sin dependencias nuevas) y un disco **local** | Una base Postgres (probado con la 16) y `IARK_DATABASE_URL`; el cliente `pg` ya va incluido |

**Cómo funciona el almacén SQLite** (`src/cli/accounts/sqliteStore.ts`):

- Todo lo que lee y luego escribe (entrar, reclamar una invitación, compartir un proyecto, cambiar un rol, desactivar una cuenta y cerrar sus sesiones, abrir una sesión y podar las viejas…) corre en una transacción `BEGIN IMMEDIATE`: toma el candado de escritura antes de leer, así que dos peticiones a la vez —aunque lleguen a procesos distintos— no pueden saltarse un tope ni dejar dos cuentas para la misma persona. Si algo falla, `ROLLBACK`.
- Modo WAL (los lectores no esperan a quien escribe), `busy_timeout` de 5 s (una escritura espera si otro proceso escribe; si no lo suelta, el error dice que la base está ocupada) y claves foráneas (borrar una cuenta borra sus sesiones y pertenencias). Los nombres de usuario y los ids de GitHub son únicos por restricción de la base, no solo por código.
- Del token de una sesión solo se guarda su hash sha256 (igual que en el JSON).
- Una base que no es de DIAgrams, o de una versión más nueva, **no se abre ni se toca**; un JSON en la ruta de una base (o al revés) se rechaza con un mensaje que dice qué hacer, sin modificar el archivo.
- WAL necesita memoria compartida entre procesos: la base debe estar en un disco **local** (el volumen de Docker, un disco de la máquina), no en NFS, SMB ni un sistema de archivos de red.
- Node 22.13+ trae `node:sqlite` sin necesidad de ninguna bandera (en Node 22 sigue marcado «experimental», y DIAgrams silencia solo ese aviso de arranque; los demás avisos de Node siguen saliendo). Con una versión anterior, el almacén `sqlite` no arranca y lo dice (el `json` no se ve afectado).

### Pasar de JSON a SQLite

Nada se pierde: cuentas, invitaciones sin aceptar, sesiones (los tokens siguen valiendo: solo se guardó su hash) y pertenencia a proyectos entran en **una sola transacción**, y antes de confirmar se cuenta lo guardado y se compara con el JSON (si no cuadra, se deshace).

```bash
iark accounts migrate --from ./iark-accounts.json --accounts ./iark-accounts.db --dry-run   # solo comprueba y cuenta
iark accounts migrate --from ./iark-accounts.json --accounts ./iark-accounts.db             # importa
iark serve … --accounts ./iark-accounts.db --accounts-store sqlite                          # y se arranca con la base
```

- Antes de importar copia el JSON a `<archivo>.bak-<fecha>` (modo 0600); `--no-backup` lo omite. **El JSON original no se modifica ni se borra**: para volver atrás basta arrancar con `--accounts-store json` y el JSON (perdiendo lo que cambió en la base después de migrar).
- Es **idempotente**: la base anota el sha256 del JSON importado. Repetirlo con el mismo archivo no hace nada (`Nada que hacer`); con una base que ya tiene otras cuentas no mezcla (sale con código 1): para rehacerla, se para el servicio, se borra la base (y su `-wal` y `-shm`) y se repite.
- **Migrar al arrancar**: `--accounts-import <archivo.json>` (`IARK_ACCOUNTS_IMPORT`) hace lo mismo en el primer arranque, para actualizar un despliegue solo cambiando variables (el `docker-compose.yml` de `deploy/` lo deja puesto con `/data/accounts.json`). Se puede dejar puesto: los reinicios siguientes no repiten nada, y si no existe el JSON (una instalación nueva) tampoco hace nada. Si dos instancias arrancan a la vez con la importación puesta, la transacción deja pasar a una y la otra ve que ya está hecho. Si la base ya tenía otras cuentas, avisa en una línea y arranca con lo que hay.
- Conviene **parar el servicio que sigue en JSON antes de migrar**: lo que cambie en el JSON después de la copia no pasa a la base. El JSON se lee entero y se valida antes de abrir (o crear) la base: un JSON dañado o inexistente no deja una base vacía por el camino.

### `iark accounts`: mantenimiento de la base

Funciona con el servicio en marcha (la base admite varios procesos). La base SQLite se indica con `--accounts <archivo>` o con `IARK_ACCOUNTS`; con Postgres, solo `migrate` existe (la conexión sale de `IARK_DATABASE_URL`).

| Comando | Qué hace |
|---|---|
| `iark accounts migrate --from <cuentas.json\|cuentas.db> [--accounts-store sqlite\|postgres] [--dry-run] [--no-backup]` | Importa el JSON (o una base SQLite) a SQLite o a Postgres (ver arriba). El origen también puede venir de `IARK_ACCOUNTS_IMPORT` y el destino de `IARK_ACCOUNTS_STORE=postgres` |
| `iark accounts backup <destino>` | Una copia **coherente** de la base viva (`VACUUM INTO`, modo 0600, no sobrescribe un destino que existe) y comprueba su integridad. Es la forma de copiarla: un `tar` o `cp` de `cuentas.db` con el servicio en marcha puede dejar el `-wal` fuera de la copia o a medias |
| `iark accounts info [--json]` | Versión del esquema, modo del diario, integridad, cuántas cuentas, invitaciones, sesiones y pertenencias hay y, si se importó de un JSON, de cuál |

`info` y `backup` no inventan una base: con una ruta mal escrita fallan (código 2) en vez de crear una vacía.

## Postgres y réplicas: lo que hay y lo que no

`--accounts-store postgres` guarda las cuentas en una base Postgres gestionada (Supabase, Neon, RDS…). Es lo que permite alojar el servicio en una máquina **sin disco persistente** (Render, Fly, Cloud Run…) y tener **varias instancias** de `iark serve` sobre las mismas cuentas, también en máquinas distintas.

```bash
export IARK_DATABASE_URL='postgres://usuario:clave@host:6543/postgres'   # del entorno o de IARK_DATABASE_URL_FILE: nunca de la línea de comandos
export IARK_GITHUB_CLIENT_SECRET=…
iark serve --workspace ./iark-workspace --accounts-store postgres \
  --github-client-id Iv1.abc123 --public-url https://iark.ejemplo.org --admins 583231
```

Sin `--accounts <ruta>`: no hay archivo. La guía paso a paso con Supabase y Render está en [despliegue-nube.md](despliegue-nube.md); la configuración de la conexión, el esquema y los poolers, en [postgres.md](postgres.md).

**Cómo funciona el almacén Postgres** (`src/cli/accounts/postgresStore.ts`):

- **Cada escritura es una transacción** que empieza tomando un candado de asesoramiento (`pg_advisory_xact_lock('cuentas:escritura')`, que dura lo que la transacción): entrar, reclamar una invitación, compartir un proyecto, cambiar un rol, desactivar una cuenta, importar… Con él, dos peticiones a la vez —de la misma instancia o de otra máquina— no pueden saltarse un tope (500 invitaciones, 100 miembros por proyecto), dejar dos cuentas para la misma persona ni dejar un proyecto sin administrador (esto último, además, con un bloqueo de las filas de administración). Las cuentas se escriben poco; un candado único es más simple y no se ha medido nada que pida uno más fino.
- **Abrir una sesión no toma ese candado** (es lo más frecuente: cada inicio de sesión): bloquea solo la fila de su cuenta (`SELECT … FOR UPDATE`), lo que basta para respetar el tope de 20 sesiones por cuenta aunque se abran a la vez desde dos máquinas, y para ordenarlas respecto a desactivar o borrar la cuenta. Cerrar una sesión y las lecturas son una sola sentencia.
- Del token de una sesión solo se guarda su hash sha256 (igual que en los otros almacenes). Los instantes son `timestamptz` y el reloj es el del proceso.
- **Solo hace falta lo que admite el pooler de transacción de Supabase** (puerto 6543): sin sentencias preparadas con nombre, sin `SET` de sesión, sin `LISTEN`, y candados `xact` (ver [postgres.md](postgres.md#compatibilidad-con-los-poolers-supabase-supavisor-pgbouncer)).
- **Si la base no responde o está saturada**, las peticiones que la necesitan (casi todas: identificar la sesión consulta la base) responden `503` con `Retry-After: 5` y un mensaje que no dice nada de la base; el motivo (sin la contraseña) va al registro del servidor. La comprobación `accounts` de `/readyz` hace una consulta de verdad y falla; `/metrics` sigue saliendo, sin los contadores de cuentas mientras tanto. Una persona que intenta entrar justo entonces vuelve a la página con el error genérico de inicio de sesión.
- Si los cambios son más lentos de lo esperable es por la distancia a la base: cada escritura son varios viajes. Ponga el servicio en la misma región que la base.

### Pasar a Postgres

El mismo comando que a SQLite, con otro destino. El origen puede ser el JSON de antes o una base SQLite (se distingue por su cabecera, no por el nombre):

```bash
iark accounts migrate --from ./iark-accounts.db --accounts-store postgres --dry-run   # solo comprueba el origen y cuenta (no se conecta a la base)
iark accounts migrate --from ./iark-accounts.db --accounts-store postgres             # importa (la conexión sale de IARK_DATABASE_URL)
iark serve … --accounts-store postgres                                                # y se arranca con Postgres
```

- Las mismas garantías que a SQLite: una sola transacción, comprobación de los recuentos antes de confirmar, copia del origen a `<archivo>.bak-<fecha>` (`--no-backup` la omite) y el origen no se toca. Se importa por lotes (una sentencia por tabla), así que no cuesta un viaje por fila.
- **Idempotente**: la base anota el sha256 del origen (`cuentas_meta`). Repetirlo no hace nada; con una base que ya tiene otras cuentas no mezcla (sale con código 1). Para rehacerlo, con el servicio parado: `truncate iark.cuentas_users, iark.cuentas_sessions, iark.cuentas_members, iark.cuentas_meta;` (con otro `IARK_DATABASE_SCHEMA`, ese esquema) y repetir.
- `--accounts-import <archivo>` (`IARK_ACCOUNTS_IMPORT`) lo hace en el primer arranque, igual que con SQLite. Si dos instancias arrancan a la vez con la importación puesta, el candado de escritura deja pasar a una y la otra ve que ya está hecho.
- Para volver atrás basta arrancar con el almacén anterior y el origen (perdiendo lo que cambió en Postgres después de migrar).
- `iark accounts backup` e `info` son solo de SQLite: con Postgres, las copias y la restauración son las de la base (en Supabase, sus copias diarias o `pg_dump`) y se dice al intentarlo.

### Lo que sigue sin existir

Que las cuentas estén en Postgres **no** convierte el servicio en uno sin estado. Lo siguiente no se ha implementado:

- **El estado del inicio de sesión vive en la memoria de cada proceso**: el `state` de la redirección a GitHub, los códigos de un solo uso que se cambian por una sesión (`routes.ts`: `logins` y `codes`) y los frenos de intentos fallidos (`WindowLimiter`). **Con una sola instancia no hay ningún problema.** Con **varias réplicas** detrás de un balanceador hace falta **afinidad de sesión** para `/api/auth/*`: las tres peticiones del flujo (`/api/auth/github/login`, `/callback` y `/exchange`) deben llegar a la misma instancia, o el inicio de sesión falla con «el inicio de sesión caducó o no se empezó desde este navegador». Las sesiones ya abiertas, los roles, los proyectos compartidos y los topes valen en todas las instancias sin más. Los frenos de intentos cuentan por instancia (con N réplicas el freno efectivo es N veces el configurado). Pasar ese estado a la base o a Redis es trabajo futuro.
- **Las cuotas se miden fuera de la transacción.** Las comprobaciones de `accounts/usage.ts` (espacio, proyectos, diagramas) se hacen antes de escribir en el espacio de trabajo, no dentro de las transacciones de las cuentas, y los guardados de una misma persona se serializan solo dentro de un proceso. Con varias instancias, dos guardados o dos creaciones simultáneos de la misma persona en instancias distintas pueden pasarse del tope por lo que se guarda a la vez. La medida que se muestra puede ir hasta 30 s por detrás de lo que otra instancia haya escrito. Los topes de las propias cuentas (invitaciones, miembros, sesiones, última persona administradora) **sí** son exactos.
- **El espacio de trabajo** (`--workspace`) es independiente de las cuentas: con `postgres` solo pasan a la base las cuentas, las sesiones y la pertenencia a proyectos. Los proyectos siguen donde se hayan configurado (una carpeta, o el almacén de proyectos si está disponible: ver [proyectos.md](proyectos.md)); en una máquina sin disco persistente, una carpeta se perdería al reiniciar.
- **Probado con un Postgres local (16), no con Supabase de verdad**: ni su CA, ni su pooler de transacción, ni su esquema `public` expuesto. Las pruebas de concurrencia usan varias conexiones y varios procesos de verdad contra ese Postgres.

## Cómo es el inicio de sesión

1. El cliente genera un secreto (`verifier`) y manda a la persona a `GET /api/auth/github/login?redirect=<dónde volver>&challenge=<sha256(verifier) en base64url>`. El servicio guarda un `state` al azar (10 minutos) y lo pone también en una cookie `HttpOnly; SameSite=Lax` de ese navegador, y la lleva a GitHub **sin pedir permisos** (solo la información pública del perfil).
2. GitHub devuelve a `/api/auth/github/callback`. El servicio comprueba que el `state` es suyo, que no se usó antes, que no caducó y que viene en la cookie de **este** navegador (nadie puede hacer que otra persona termine un inicio de sesión que empezó él); cambia el código por un token de GitHub, lee `GET /user`, **revoca ese token** (DIAgrams no conserva ningún acceso a GitHub) y decide si la persona puede entrar.
3. Devuelve a la persona a `redirect#iark_code=<código>` (o `#iark_error=<motivo>`: `access_denied`, `not_invited`, `disabled`, `github_unavailable`, `login_failed`). Es un **código de un solo uso (60 s) en el fragmento**, que no viaja al servidor ni queda en registros ni en `Referer`; la sesión no va nunca en una URL.
4. `POST /api/auth/exchange { code, verifier }` lo cambia por `{ token, expiresAt, user }` (PKCE: solo quien conoce el `verifier` puede; un código robado no sirve y se gasta en el primer intento; 5 fallos seguidos frenan la dirección con 429).
5. `POST /api/auth/logout` con la sesión la cierra. `GET /api/whoami` con una sesión responde `{ auth: true, name, role: <rol en la instancia>, user: { id, login, name?, avatarUrl?, siteRole } }`.

`redirect` solo puede ser el propio sitio (`--public-url`) o un origen nombrado en `--cors` (nunca `*`): no hay redirección abierta. `GET /api/auth/providers` (público) dice qué formas de entrar ofrece la instancia: `{ providers: [{ id: "github", label: "GitHub" }], tokens: boolean, signup }`. El token de sesión (`iark_s_` + 256 bits) **solo se guarda como hash sha256**, igual que los de `iark auth`.

## Quién ve qué

- **Rol en la instancia** (`siteRole`): `admin` (los de `--admins`: ven todos los proyectos y son `admin` de todos), `member` (pueden crear y importar proyectos) y `guest` (no crean proyectos: solo entran a los que les compartan, ver [Compartir proyectos](#compartir-proyectos)).
- **Rol en cada proyecto**: `viewer`, `editor` o `admin`, los mismos de la tabla de [Roles](servicio.md#roles). Quien crea o importa un proyecto queda como `admin` del suyo; **la lista de proyectos solo trae aquellos a los que se pertenece**, y cada uno trae su `role`.
- Un proyecto al que no se pertenece responde **404** (igual que si no existiera: no se revela qué proyectos hay); con un rol que no alcanza, 403 `forbidden`. Todo se decide antes de leer el cuerpo y de tocar el disco.
- Borrar un proyecto olvida a sus miembros: otro proyecto con el mismo nombre no los hereda. Un proyecto creado a mano en la carpeta (o con un token) no pertenece a nadie: lo ven los tokens y los administradores de la instancia.
- Los tokens de `--tokens` no cambian: su rol vale para toda la carpeta y sus respuestas no llevan `role`.

## Compartir proyectos

Quien administra un proyecto decide quién pertenece a él y con qué rol. Los tres endpoints cuelgan del proyecto y solo existen con `--accounts` (sin cuentas responden 404):

| Petición | Quién | Qué hace |
|---|---|---|
| `GET /api/projects/<p>/members` | `viewer` o más | `Member[]`, los administradores primero: `{ login, name?, avatarUrl?, role, pending, you? }`. `pending` es una invitación todavía sin aceptar; `you` marca a quien llama |
| `PUT /api/projects/<p>/members/<usuario>` | `admin` del proyecto | `{ "role": "viewer" \| "editor" \| "admin" }` → comparte el proyecto o cambia el rol (201 si es nuevo, 200 si cambió) |
| `DELETE /api/projects/<p>/members/<usuario>` | `admin` del proyecto, **o la propia persona** (cualquier rol) | Quita a alguien, o la persona se va ella misma → `{ "removed": "<usuario>" }` |

- Se comparte con un **nombre de usuario de GitHub**. Si esa persona ya entró, pertenece al proyecto al instante. Si no tiene cuenta, se crea una **invitación** (`pending: true`) que reclama al entrar con ese nombre: con `--signup invite` la invitación le da entrada a la instancia como `guest` (puede abrir el proyecto compartido, no crear proyectos propios); con `--signup open`, como `member`.
- **Quitar a una persona invitada que aún no ha entrado y que no tiene más proyectos cancela su invitación**: ya no puede entrar. Quien ya entró conserva su cuenta (un administrador puede desactivarla, ver abajo).
- **Un proyecto no se queda sin administrador**: quitar o bajar de rol a la única persona que lo administra responde 409 `{ code: "last-admin" }` (nombre antes a otra). Un proyecto admite hasta 100 personas (409 `{ code: "limit" }`) y la instancia, hasta 500 invitaciones sin aceptar (quien tenga un proyecto puede llenar ese tope; quien administra la instancia las ve y las cancela en `/api/admin/users`).
- Los administradores de la instancia ven y cambian los miembros de cualquier proyecto sin pertenecer a él (no aparecen en la lista); un token con rol `admin` también. Quitar a alguien le cierra el proyecto en la siguiente petición, aunque conserve su sesión.
- Los errores son los de siempre: 400 `invalid` (usuario o rol que no valen), 403 `forbidden` (rol insuficiente), 404 (no se pertenece al proyecto, o no existe), 415 sin `Content-Type: application/json`.

```bash
curl -X PUT https://iark.ejemplo.org/api/projects/tienda/members/carla \
  -H "Authorization: Bearer $SESION" -H "Content-Type: application/json" -d '{"role":"editor"}'
```

## Administrar las cuentas de la instancia

Solo para quien administra la instancia (una persona con rol `admin` o un token de `--tokens` con rol `admin`; los demás, 403). Es lo que usa la [pantalla de administración](#pantalla-de-administración) y también sirve desde la línea de comandos:

| Petición | Qué hace |
|---|---|
| `GET /api/admin/users` | Las cuentas: `{ id, login, name?, avatarUrl?, siteRole, disabled, pending, listed?, createdAt, lastLoginAt?, projects, quota?, limits, usage? }`, por nombre de usuario. `listed` marca a quien figura en `--admins`; `projects`, a cuántos proyectos pertenece; `quota`, la cuota personal si la tiene; `limits`, los topes que valen para ella; `usage`, lo que ocupa (ver [Cuotas de uso](#cuotas-de-uso)) |
| `PUT /api/admin/users/<usuario>` | `{ siteRole?: "admin" \| "member" \| "guest", disabled?: boolean, quota?: { bytes?, projects?, diagramsPerProject? } }` → cambia el rol de la instancia, desactiva/reactiva la cuenta (desactivar cierra sus sesiones y le impide volver a entrar) o fija su [cuota personal](#cuota-personal-de-cada-persona). Con un nombre que no existe **crea una invitación** (rol `member` por omisión): 201 |
| `DELETE /api/admin/users/<usuario>` | Cancela la invitación de quien todavía no ha entrado. Con quien ya entró, 409 `conflict`: se desactiva |

Nadie puede cambiar su propio rol ni desactivarse (409 `self`: que lo haga otra persona), y a quien figura en `--admins` no se le puede bajar de rol ni desactivar desde la API (409 `listed-admin`): su rol lo manda la lista. Un `PUT` con `siteRole: "admin"` hace administradora a otra persona sin tocar `--admins`; quitarle el rol es otro `PUT`.

## Cuotas de uso

Un servicio abierto necesita un límite a lo que cada persona puede guardar: sin él, una cuenta puede llenar el disco del servidor. Las cuotas existen **solo con `--workspace` y `--accounts`** (sin cuentas no hay personas a quienes cobrar; el servicio con `--tokens` no las tiene). Están activas por omisión, con topes generosos, y se pueden quitar.

### Qué se cuenta

- **Espacio**: los bytes de los documentos actuales de los diagramas **más los de todas las versiones del historial** ([historial de versiones](proyectos.md#historial-de-versiones)). El historial ocupa disco de verdad (un diagrama recién creado ya lleva una versión con su contenido), así que cada guardado cuesta, como mucho, el documento nuevo más la versión que se anota. Se mide con los tamaños de archivo, por el gancho `versionUsage` del historial. No se cuentan `project.json`, el índice del historial ni los archivos que alguien deje a mano en la carpeta.
- **Proyectos**: cuántos proyectos posee la persona.
- **Diagramas por proyecto**: es un tope de cada proyecto, no de la persona.

### A quién se cobra

A la persona que **posee** el proyecto: su persona administradora **más antigua** (normalmente quien lo creó o importó; si deja de administrarlo, pasa a la siguiente administradora; con empate en la fecha, el id de cuenta más bajo). No importa quién guarda: una persona con rol `editor` en un proyecto compartido no gasta su cuota sino la de quien lo posee. Un proyecto **sin dueña** (copiado a mano a la carpeta, o creado con un token de servicio) solo tiene el tope de diagramas por proyecto de la instancia. **Los administradores de la instancia no tienen tope** salvo que se les fije una cuota personal.

### Los topes

| Tope | Por omisión | Opción / variable |
|---|---|---|
| Espacio por persona | 256 MiB | `--max-bytes` / `IARK_MAX_BYTES` |
| Proyectos por persona | 25 | `--max-projects` / `IARK_MAX_PROJECTS` |
| Diagramas por proyecto | 200 | `--max-diagrams` / `IARK_MAX_DIAGRAMS` |

`0` (o `off` en `--max-bytes`) quita el tope. `--max-bytes` acepta bytes sueltos o un sufijo de 1024 en 1024 (`500K`, `256M`, `1.5G`, `2T`). Al arrancar, el servicio imprime los topes que rigen.

#### Cuota personal de cada persona

Quien administra la instancia puede fijar a una persona topes distintos de los de la instancia (para darle más espacio a un equipo, o quitárselo a una cuenta abusiva): `PUT /api/admin/users/<usuario>` con `{ "quota": { "bytes": 1073741824, "projects": 0, "diagramsPerProject": null } }`. Cada campo es independiente: un número fija el tope (`0`, sin tope), `null` lo quita (vuelve al valor de la instancia) y lo que falta no se toca. Los bytes son enteros; la [pantalla de administración](#pantalla-de-administración) los escribe en MB. La cuota se guarda con la cuenta: en el JSON, el campo opcional `quota` (la versión del archivo sigue siendo 1; **una versión anterior de DIAgrams que reescriba el archivo la descarta**) y en SQLite, tres columnas (migración 2 del esquema, que se aplica sola al abrir la base y no se puede deshacer: una versión anterior ya no abre una base migrada). Va por `PUT`, así que queda en la auditoría como `user.quota` ([observabilidad](observabilidad.md)).

### Qué pasa al llegar al tope

Crear o importar un proyecto, crear un diagrama y guardar uno **se rechazan** con `409` y `code: "limit"` (el mismo código de los topes de miembros y de versiones con nombre), un mensaje claro y tres campos más:

```json
{ "error": "Este proyecto ya tiene 200 diagramas, el máximo por proyecto (200). Borra alguno o pide a un administrador que suba el tope.",
  "code": "limit", "quota": "diagrams", "used": 200, "limit": 200 }
```

`quota` es `bytes`, `projects` o `diagrams`. **Nunca se pierde nada**: un guardado rechazado no toca el disco y la interfaz conserva el borrador de quien edita. Lo que libera espacio o no lo hace crecer **sigue permitido** aunque la persona esté por encima del tope (porque se lo bajaron, por ejemplo): guardar un documento idéntico o más pequeño, borrar diagramas y proyectos, renombrar, nombrar y **borrar versiones con nombre** y **restaurar** una versión (añade otra versión, pero la rotación del historial la mantiene acotada por diagrama). Antes de guardar se estima el crecimiento como `2 × nuevo − actual` con historial (`nuevo − actual` sin él): es una cota superior que no descuenta que el guardado sustituya la versión anterior ni la rotación, así que se puede ver un rechazo cuando por poco habría cabido; borrar lo que sobra lo arregla.

Cambio respecto a versiones anteriores: el tope de proyectos por persona (`--max-projects`) ya no responde `403`, sino `409 limit` como el resto, y cuenta los proyectos que se **poseen**, no los que se administran.

### Ver el uso

`GET /api/usage` (solo una sesión de persona; con un token de servicio o sin `--accounts`, 404):

```json
{ "limits": { "bytes": 268435456, "projects": 25, "diagramsPerProject": 200 },
  "usage": { "bytes": 1203, "documentBytes": 601, "versionBytes": 602, "versions": 2, "projects": 1 },
  "projects": [ { "id": "tienda", "name": "Tienda", "diagrams": 2, "documentBytes": 601, "versions": 2, "versionBytes": 602, "bytes": 1203 } ] }
```

`limits` son los que valen para esa persona (los de la instancia con los suyos por encima; `0`, sin tope) y `projects`, los que posee, del que más ocupa al que menos. Este `GET` siempre mide de verdad; el uso que se usa para decidir un guardado puede venir de una caché de 30 s por proyecto, que se invalida con cada cambio que pasa por el servicio. En el gestor de proyectos, bajo «Dónde se guardan», un medidor enseña el espacio, los proyectos y los diagramas del proyecto elegido; avisa (`role="status"`) cuando alguno pasa del 80 % del tope y lo dice como error cuando se alcanzó. No aparece si no hay topes, ni con los proyectos de este navegador ni con un token. En la pantalla de administración se ve el uso de cada cuenta y se edita su cuota.

`/metrics` expone `iark_quota_rejections_total{kind}` (operaciones rechazadas por tipo de tope) e `iark_quota_limit{kind}` (los topes de la instancia). **Sin etiquetas de persona ni de proyecto**: no existe una métrica del uso de cada persona (cardinalidad y privacidad); eso se ve en la pantalla de administración o en `GET /api/admin/users`.

### Límites

- **Con varias réplicas** sobre una misma carpeta, los guardados simultáneos de una persona en réplicas distintas pueden pasarse del tope por lo que se guarda a la vez (dentro de un proceso se serializan por persona), y la medida va hasta 30 s por detrás de lo que escriba otra réplica o una mano en la carpeta.
- **El tope de bytes es una estimación al guardar y una medida al mostrar**; no es una cuota del sistema de archivos. Quien necesite un tope duro de disco debe ponerlo también en el volumen.
- **No hay una acción de «limpiar historial» por persona**: lo que se puede borrar son diagramas, proyectos y versiones con nombre; las versiones automáticas rotan solas (50 por diagrama).
- **No se cobra por proyecto compartido a quien lo recibe**, y un proyecto sin dueña solo tiene el tope de diagramas.

## Pantalla de administración

Quien administra la instancia no necesita la API a mano. El gestor de proyectos (**Proyectos…** en el banco de trabajo y en el editor C4) trae, arriba, en «Dónde se guardan» y junto a «Cambiar…», el botón **Administrar cuentas…**: abre **Administración de la instancia**, una ventana sobre `/api/admin/users`.

**Quién la ve.** Solo una persona con sesión de GitHub y `siteRole: admin`. Para un miembro, un invitado, un token (aunque tenga rol `admin`: las cuentas de servicio usan la API) o los proyectos de este navegador no hay botón ni enlace, y el gestor no pide nada a `/api/admin`. El botón no es la seguridad: el servidor vuelve a comprobar el rol en cada petición, así que si a alguien se lo quitan con la ventana abierta, la siguiente lectura o cambio responde 403 y la ventana deja de mostrar cuentas.

**Qué muestra.** Una tabla con una fila por cuenta: foto (o su inicial), `@usuario`, nombre, las marcas «tú» y «en --admins», el rol, el estado (*Activa*, *Invitación pendiente* o *Desactivada*), el último acceso, a cuántos proyectos pertenece y su **espacio y cuota** (lo que ocupa frente a su tope, con una barra, los proyectos que posee, la marca «cuota propia» si tiene la suya y «Cerca del tope» o «Tope alcanzado»). Por omisión van primero los administradores, luego los miembros y los invitados, y dentro de cada rol por usuario. Se puede **buscar** por usuario o nombre (sin distinguir mayúsculas ni acentos), **filtrar** (por rol, invitaciones pendientes o desactivadas) y **ordenar** (por rol, usuario, último acceso, proyectos o espacio usado). Encima de la tabla, un resumen: cuántas cuentas, administradores, invitaciones pendientes y desactivadas hay.

**Qué se puede hacer**

| Acción | Cómo | Petición |
|---|---|---|
| Invitar | Formulario «Invitar a una persona»: usuario de GitHub (con o sin `@`) y rol inicial (miembro por omisión). Queda como invitación pendiente hasta que esa persona entre con su cuenta. Un nombre que ya tiene cuenta o invitación no se invita: la pantalla lo dice y no lo pide, porque el servidor, ante un nombre que conoce, cambia su rol en lugar de invitar | `PUT` con `siteRole` (201) |
| Cambiar el rol | El selector de la fila deja un **borrador**; **Guardar rol** lo aplica (con un aviso de lo que da si es de administrador) y **Descartar** lo quita. Mover el selector no cambia nada por sí solo: con el teclado cada flecha dispara el cambio, y alguien podría dar el rol de administrador sin querer | `PUT { siteRole }` |
| Desactivar | Pide confirmación en la propia fila. Cierra sus sesiones y no le deja volver a entrar | `PUT { disabled: true }` |
| Reactivar | Sin confirmación: se deshace con otro clic | `PUT { disabled: false }` |
| Cancelar una invitación | Solo de quien aún no ha entrado. Pide confirmación; también la quita de los proyectos a los que la hubieran invitado | `DELETE` |
| Cambiar la cuota de una cuenta | **Cuota…** abre bajo la fila un editor con los tres topes (espacio, en MB; proyectos; diagramas por proyecto): cada uno es «Valor de la instancia», «Sin tope» u «Otro valor…». **Guardar cuota** manda los tres; Escape o **Cancelar** lo cierran sin cambiar nada | `PUT { quota }` |

**Lo que no ofrece, y por qué.** Tu propia cuenta (409 `self`) y las de `--admins` (409 `listed-admin`) salen en la lista, pero sin selector ni botón de desactivar, con la razón a la vista: su rol y su acceso los manda la lista del servicio, que se cambia en su configuración (`IARK_ADMINS`). Tampoco se puede administrar una cuenta cuyo nombre el servicio apartó con un `~` (alguien que cambió de nombre en GitHub dejó el suyo a otra persona): la API no puede nombrarla.

**Errores.** El mensaje del servidor se muestra tal cual, precedido de lo que se intentaba («No se pudo cambiar el rol de @beto. …»), y la lista se vuelve a leer: lo que se ve es lo que dice el servidor. Lo escrito no se pierde: si falla una invitación, el usuario y el rol siguen en el formulario; si falla un cambio de rol, el borrador sigue en la fila. 403 (ya no administras la instancia) y 401 (la sesión caducó) retiran la lista y dicen qué hacer; sin conexión, la última lista leída sigue a la vista y «Actualizar» o el siguiente intento la recupera. 409 se muestra con el texto del servidor sea cual sea su código (`self`, `listed-admin`, `conflict` al cancelar la invitación de quien acaba de entrar, `limit` con 500 invitaciones sin aceptar). El seguro de «la instancia no se queda sin administradores» no es `last-admin` (ese código es de los proyectos): es que nadie baja de rol ni se desactiva a sí mismo.

**Teclado, lector de pantalla y pantalla pequeña.** Todo se hace con el teclado: el foco queda dentro de la ventana, **Escape** cancela una confirmación y, si no hay ninguna, cierra la ventana (y el foco vuelve al botón que la abrió); al confirmar, el foco cae en «No»; al terminar una acción vuelve a la fila donde estaba. La lista es una tabla con encabezados, cada control lleva el nombre de la cuenta a la que afecta («Desactivar a @beto») y los avisos se anuncian (`role="status"` y `role="alert"`). En una pantalla estrecha (700 px o menos) cada cuenta pasa a ser una tarjeta, sin desplazamiento lateral. Usa los mismos colores que el resto del gestor, así que sigue el tema claro u oscuro.
