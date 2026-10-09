# Postgres (Supabase y otros) para `iark serve`

IArk puede guardar las cuentas y los proyectos de `iark serve` en una base **Postgres** gestionada (Supabase, Neon, RDS…) en lugar de un archivo o una carpeta del disco. Es lo que permite alojar el servicio en una máquina sin disco persistente (Render, Fly, Cloud Run…) o con varias réplicas. Esta página es la **base común**: cómo se configura la conexión, qué hace IArk con el esquema y cómo se prueba. Qué guarda cada almacén está en [cuentas-github.md](cuentas-github.md) y [proyectos.md](proyectos.md); la guía paso a paso con Supabase y Render, en [despliegue-nube.md](despliegue-nube.md).

## Configuración (solo por entorno)

La cadena de conexión lleva la contraseña de la base, así que **no se acepta por la línea de comandos** (se vería en `ps` y en el historial), igual que el secreto de la OAuth App.

| Variable | Qué es |
|---|---|
| `IARK_DATABASE_URL` | `postgres://usuario:clave@host:puerto/base`. Si la clave lleva símbolos (`@ : / # ?`), se codifican como `%XX`. |
| `IARK_DATABASE_URL_FILE` | La ruta de un archivo que contiene la cadena (Docker secrets, *Secret Files* de Render, Kubernetes). No vale con `IARK_DATABASE_URL` a la vez. |
| `IARK_DATABASE_SSL` | `verify` (cifra y **comprueba** el certificado del servidor), `no-verify` (cifra sin comprobar) u `off`. Por omisión, `verify` salvo en `localhost`/`127.0.0.1`, donde es `off`. |
| `IARK_DATABASE_CA_FILE` | Un certificado de autoridad en PEM para comprobar al servidor (en Supabase, el «CA certificate» de *Database settings → SSL*). |
| `IARK_DATABASE_POOL` | Conexiones simultáneas como máximo por proceso, de 1 a 50 (por omisión 10). Súbalo solo si la base lo admite: el plan gratuito de Supabase tiene pocas conexiones. |
| `IARK_DATABASE_SCHEMA` | El esquema donde viven las tablas de IArk. Por omisión `iark`. **No puede ser `public`** ni un esquema del sistema o de Supabase. |

Una `sslmode` dentro de la cadena solo se respeta cuando es inequívoca (`disable`; `verify-full` y `verify-ca`). `require` y `prefer` en libpq **no** comprueban al servidor; aquí sí se comprueba salvo `IARK_DATABASE_SSL=no-verify`. Si la comprobación falla («self-signed certificate in certificate chain»), el error lo dice y apunta a estas dos salidas; la buena es `IARK_DATABASE_CA_FILE`.

Los errores de conexión nombran el servidor y el usuario (`postgres://usuario@host:puerto/base`), **nunca la contraseña**.

## Qué hace IArk con el esquema

- **Su propio esquema (`iark`), no `public`.** La API pública de Supabase (PostgREST) expone `public` a cualquiera que tenga la clave `anon`, que va dentro de todo frontend de Supabase. Las tablas de IArk no están ahí.
- **Seguridad por filas en todas las tablas, sin políticas**, y **ningún permiso** sobre el esquema para `PUBLIC` ni para los roles de Supabase (`anon`, `authenticated`, `service_role`). Se aplica en cada arranque, también sobre tablas creadas por versiones futuras. El servicio se conecta como dueño (`postgres`), que no lo necesita. Es un cinturón y unos tirantes: si algún día se expusiera el esquema por error, esos roles verían cero filas.
- **Migraciones numeradas por almacén** (`iark.migraciones`: `namespace`, `version`): cada almacén (cuentas, proyectos) evoluciona por su cuenta. Un candado de asesoramiento serializa el arranque, así que dos réplicas que arrancan a la vez aplican cada migración una sola vez. Si la base tiene una versión **más nueva** de la que conoce esta copia de IArk, el servicio no arranca (hay que actualizar IArk, no tocar la base).

## Las cuentas en Postgres

`iark serve --accounts-store postgres` (o `IARK_ACCOUNTS_STORE=postgres`) guarda las cuentas, las sesiones y la pertenencia a proyectos en cuatro tablas de la base, **sin `--accounts <ruta>`** (si se da, se avisa y se ignora): la conexión sale solo de las variables de arriba. El servicio abre un pool por proceso (`IARK_DATABASE_POOL` conexiones como máximo) que comparten todos los almacenes que lo usen, y lo cierra al apagarse (`SIGTERM`).

| Tabla (en el esquema `iark`) | Qué guarda |
|---|---|
| `cuentas_users` | Una fila por cuenta o invitación sin aceptar (`github_id` nulo): nombre de usuario (único sin distinguir mayúsculas), rol de la instancia, estado y cuota personal |
| `cuentas_sessions` | Una fila por sesión abierta: **solo el sha256 del token**, a quién pertenece y cuándo caduca |
| `cuentas_members` | A qué proyectos pertenece cada cuenta y con qué rol |
| `cuentas_meta` | Metadatos: de qué origen se importó (`imported_json_sha256`, `_source`, `_at`) |

Las migraciones son las del espacio `cuentas` (`iark.migraciones`); `iark serve` las aplica al arrancar, con el candado que ya serializa a dos réplicas. Cómo se protegen los topes y la regla de la última persona administradora (un candado de asesoramiento global de escritura y bloqueo de filas para las sesiones), lo que pasa cuando la base no responde (503 con `Retry-After`) y lo que **no** se ha resuelto con varias réplicas (el estado del inicio de sesión, que sigue en la memoria de cada proceso: afinidad de sesión; y las cuotas, que se miden fuera de la transacción) está en [cuentas-github.md](cuentas-github.md#postgres-y-réplicas-lo-que-hay-y-lo-que-no).

Pasar las cuentas de un JSON o de una base SQLite a Postgres: `iark accounts migrate --from <origen> --accounts-store postgres` (idempotente, con copia del origen, una sola transacción). `iark accounts backup` e `info` no existen para Postgres: las copias de seguridad son las de la base (en Supabase, *Database → Backups*, o `pg_dump`).

## Compatibilidad con los poolers (Supabase Supavisor, PgBouncer)

El código solo usa lo que funciona en el modo de **transacción**, el más estrecho: nada de sentencias preparadas con nombre, nada de `SET` de sesión, nada de `LISTEN`, y los candados son `pg_advisory_xact_lock` (duran lo que la transacción). Tampoco manda `statement_timeout` ni `options` al conectar (PgBouncer los rechaza); el tope de tiempo es del lado del cliente (20 s por consulta). Sirve igual la conexión directa, el pooler de sesión (puerto 5432 del pooler, con IPv4) y el pooler de transacción (puerto 6543).

Los choques entre transacciones simultáneas (`40001`, `40P01`) se reintentan solos hasta cuatro veces con espera creciente; si no se resuelven, el error dice que la base está muy ocupada.

## Probar contra un Postgres de verdad

Las pruebas de Postgres arrancan un clúster temporal con los binarios del sistema (`initdb` y `pg_ctl`; en Debian y Ubuntu, `postgresql` los instala en `/usr/lib/postgresql/<versión>/bin`) en una carpeta y un puerto propios, sin Docker, y lo borran al terminar (`tests/helpers/postgres.ts`). Si no hay binarios, esas pruebas se **omiten**, salvo con `IARK_REQUIRE_POSTGRES=1` (lo pone el CI): entonces fallan, para que no pasen sin probar nada. `IARK_PG_BIN` apunta a otra carpeta de binarios y `IARK_TEST_DATABASE_URL` a una base ya existente (cada prueba usa un esquema propio y lo borra). Como `root`, `initdb` se niega a correr: se lanza como el usuario `postgres` del sistema.

Las pruebas de las cuentas incluyen **concurrencia de verdad** (varias conexiones y varios procesos de Node contra la misma base, con `SIGKILL` en plena escritura) y el flujo HTTP completo con un GitHub de mentira. `IARK_TEST_ACCOUNTS_STORE=postgres npx vitest run src/cli/serve*.test.ts` corre contra Postgres todas las pruebas de la API que usan una nube de prueba.

**Límite:** las pruebas se hacen con un Postgres local (16). Con Supabase de verdad —TLS con su CA, su pooler, el esquema `public` expuesto— no se han probado desde aquí.
