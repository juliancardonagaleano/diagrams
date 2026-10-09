# Servicio gestionado: inicio de sesión con GitHub

[← Índice de la documentación](indice.md)

Con `--accounts`, el mismo `iark serve --workspace` ofrece **«Iniciar sesión con GitHub»** en lugar de repartir tokens a mano: cada persona entra con su cuenta de GitHub, el servicio guarda quién es y a qué proyectos pertenece, y le da una **sesión** (un token que caduca) que se usa exactamente como un token de `iark auth`: `Authorization: Bearer <sesión>`. Lo que hace falta es una OAuth App de GitHub (la crea quien aloja el servicio: [guía de despliegue](despliegue-nube.md), con los valores exactos de cada campo), un archivo para las cuentas y la dirección pública del servicio. `--tokens` sigue existiendo y puede usarse a la vez (cuentas de servicio, scripts y CLI con un rol para toda la carpeta).

```bash
export IARK_GITHUB_CLIENT_SECRET=…            # solo por entorno o por IARK_GITHUB_CLIENT_SECRET_FILE: nunca por la línea de comandos
iark serve --host 0.0.0.0 --port 8787 --static dist/app \
  --workspace ./iark-workspace --accounts ./iark-accounts.json \
  --github-client-id Iv1.abc123 --public-url https://iark.ejemplo.org \
  --admins 583231 --signup invite
```

| Opción | Variable | Qué hace |
|---|---|---|
| `--accounts <archivo>` | `IARK_ACCOUNTS` | Dónde guarda el servicio las cuentas, las sesiones y la pertenencia a proyectos (JSON, modo 0600, escritura atómica; solo lo escribe el servicio: no lo edite con él en marcha ni use varias réplicas sobre el mismo archivo) |
| `--github-client-id <id>` | `IARK_GITHUB_CLIENT_ID` | Client ID de la OAuth App |
| — | `IARK_GITHUB_CLIENT_SECRET` o `IARK_GITHUB_CLIENT_SECRET_FILE` | Client secret de la OAuth App. **No existe opción de línea de comandos**: se vería en la lista de procesos |
| `--public-url <url>` | `IARK_PUBLIC_URL` | Dirección pública del servicio (https; solo `localhost` puede ser http). La «Authorization callback URL» de la OAuth App es `<esa dirección>/api/auth/github/callback` |
| `--signup invite\|open` | `IARK_SIGNUP` | `invite` (por omisión): solo entran los administradores y las personas invitadas (o con un proyecto compartido: ver [Compartir proyectos](#compartir-proyectos)). `open`: entra cualquiera con cuenta de GitHub |
| `--admins <lista>` | `IARK_ADMINS` | Administradores de la instancia, separados por comas: nombres de usuario de GitHub o, **mejor, sus identificadores numéricos** (el nombre de usuario puede pasar a otra persona si su dueña lo cambia; el id no). `curl https://api.github.com/users/<usuario>` lo da |
| `--session-days <n>` | `IARK_SESSION_DAYS` | Duración de una sesión (30 por omisión) |
| `--max-projects <n>` | `IARK_MAX_PROJECTS` | Proyectos que puede administrar cada persona (25 por omisión; los administradores no tienen tope) |
| `--cors <orígenes>`, `--trust-proxy` | `IARK_CORS`, `IARK_TRUST_PROXY=true` | Orígenes que pueden llamar a la API desde un navegador y a los que se vuelve tras entrar (para volver hay que nombrarlos: un `*` no vale); y «hay un proxy de confianza delante» (solo con proxy: ver [Límites](servicio.md#límites)). Sirven para plataformas que solo se configuran por entorno |
| `--github-url`, `--github-api-url` | `IARK_GITHUB_URL`, `IARK_GITHUB_API_URL` | Con GitHub Enterprise Server, su dirección y su API (`https://git.empresa.com`, `https://git.empresa.com/api/v3`) |
| `--access-log`, `--audit-log`, `--metrics`, `--metrics-token` | `IARK_ACCESS_LOG`, `IARK_AUDIT_LOG`, `IARK_METRICS`, `IARK_METRICS_TOKEN` | Registro de accesos, **auditoría** (quién inició sesión, falló al hacerlo o cambió qué, también lo denegado), y métricas de Prometheus. Apagados por omisión; llevan el usuario de GitHub y la dirección IP: ver [Observabilidad](observabilidad.md) |

Con cuentas, el servicio puede escuchar fuera de loopback sin `--tokens` (hace falta una de las dos formas de autenticarse). Si falta algo de lo anterior, el arranque lo dice todo de una vez (código 2). Con `--signup invite` y sin administradores ni cuentas todavía, nadie podría entrar: no arranca.

**Desplegarlo**: la imagen Docker ya sirve como servicio gestionado y [`deploy/`](../deploy/) trae un `docker-compose.yml` de producción (IArk + Caddy con HTTPS automático, volumen de datos y el secreto de la OAuth App como Docker secret). La guía [`docs/despliegue-nube.md`](despliegue-nube.md) lleva de cero a un servicio en marcha: registrar la OAuth App, DNS y firewall, primer arranque, entrar como administradora, usar el sitio de GitHub Pages contra la instancia, copias de seguridad, actualizar y los errores más frecuentes.

## Cómo es el inicio de sesión

1. El cliente genera un secreto (`verifier`) y manda a la persona a `GET /api/auth/github/login?redirect=<dónde volver>&challenge=<sha256(verifier) en base64url>`. El servicio guarda un `state` al azar (10 minutos) y lo pone también en una cookie `HttpOnly; SameSite=Lax` de ese navegador, y la lleva a GitHub **sin pedir permisos** (solo la información pública del perfil).
2. GitHub devuelve a `/api/auth/github/callback`. El servicio comprueba que el `state` es suyo, que no se usó antes, que no caducó y que viene en la cookie de **este** navegador (nadie puede hacer que otra persona termine un inicio de sesión que empezó él); cambia el código por un token de GitHub, lee `GET /user`, **revoca ese token** (IArk no conserva ningún acceso a GitHub) y decide si la persona puede entrar.
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
| `GET /api/admin/users` | Las cuentas: `{ id, login, name?, avatarUrl?, siteRole, disabled, pending, listed?, createdAt, lastLoginAt?, projects }`, por nombre de usuario. `listed` marca a quien figura en `--admins`; `projects`, a cuántos proyectos pertenece |
| `PUT /api/admin/users/<usuario>` | `{ siteRole?: "admin" \| "member" \| "guest", disabled?: boolean }` → cambia el rol de la instancia o desactiva/reactiva la cuenta (desactivar cierra sus sesiones y le impide volver a entrar). Con un nombre que no existe **crea una invitación** (rol `member` por omisión): 201 |
| `DELETE /api/admin/users/<usuario>` | Cancela la invitación de quien todavía no ha entrado. Con quien ya entró, 409 `conflict`: se desactiva |

Nadie puede cambiar su propio rol ni desactivarse (409 `self`: que lo haga otra persona), y a quien figura en `--admins` no se le puede bajar de rol ni desactivar desde la API (409 `listed-admin`): su rol lo manda la lista. Un `PUT` con `siteRole: "admin"` hace administradora a otra persona sin tocar `--admins`; quitarle el rol es otro `PUT`.

## Pantalla de administración

Quien administra la instancia no necesita la API a mano. El gestor de proyectos (**Proyectos…** en el banco de trabajo y en el editor C4) trae, arriba, en «Dónde se guardan» y junto a «Cambiar…», el botón **Administrar cuentas…**: abre **Administración de la instancia**, una ventana sobre `/api/admin/users`.

**Quién la ve.** Solo una persona con sesión de GitHub y `siteRole: admin`. Para un miembro, un invitado, un token (aunque tenga rol `admin`: las cuentas de servicio usan la API) o los proyectos de este navegador no hay botón ni enlace, y el gestor no pide nada a `/api/admin`. El botón no es la seguridad: el servidor vuelve a comprobar el rol en cada petición, así que si a alguien se lo quitan con la ventana abierta, la siguiente lectura o cambio responde 403 y la ventana deja de mostrar cuentas.

**Qué muestra.** Una tabla con una fila por cuenta: foto (o su inicial), `@usuario`, nombre, las marcas «tú» y «en --admins», el rol, el estado (*Activa*, *Invitación pendiente* o *Desactivada*), el último acceso y a cuántos proyectos pertenece. Por omisión van primero los administradores, luego los miembros y los invitados, y dentro de cada rol por usuario. Se puede **buscar** por usuario o nombre (sin distinguir mayúsculas ni acentos), **filtrar** (por rol, invitaciones pendientes o desactivadas) y **ordenar** (por rol, usuario, último acceso o proyectos). Encima de la tabla, un resumen: cuántas cuentas, administradores, invitaciones pendientes y desactivadas hay.

**Qué se puede hacer**

| Acción | Cómo | Petición |
|---|---|---|
| Invitar | Formulario «Invitar a una persona»: usuario de GitHub (con o sin `@`) y rol inicial (miembro por omisión). Queda como invitación pendiente hasta que esa persona entre con su cuenta. Un nombre que ya tiene cuenta o invitación no se invita: la pantalla lo dice y no lo pide, porque el servidor, ante un nombre que conoce, cambia su rol en lugar de invitar | `PUT` con `siteRole` (201) |
| Cambiar el rol | El selector de la fila deja un **borrador**; **Guardar rol** lo aplica (con un aviso de lo que da si es de administrador) y **Descartar** lo quita. Mover el selector no cambia nada por sí solo: con el teclado cada flecha dispara el cambio, y alguien podría dar el rol de administrador sin querer | `PUT { siteRole }` |
| Desactivar | Pide confirmación en la propia fila. Cierra sus sesiones y no le deja volver a entrar | `PUT { disabled: true }` |
| Reactivar | Sin confirmación: se deshace con otro clic | `PUT { disabled: false }` |
| Cancelar una invitación | Solo de quien aún no ha entrado. Pide confirmación; también la quita de los proyectos a los que la hubieran invitado | `DELETE` |

**Lo que no ofrece, y por qué.** Tu propia cuenta (409 `self`) y las de `--admins` (409 `listed-admin`) salen en la lista, pero sin selector ni botón de desactivar, con la razón a la vista: su rol y su acceso los manda la lista del servicio, que se cambia en su configuración (`IARK_ADMINS`). Tampoco se puede administrar una cuenta cuyo nombre el servicio apartó con un `~` (alguien que cambió de nombre en GitHub dejó el suyo a otra persona): la API no puede nombrarla.

**Errores.** El mensaje del servidor se muestra tal cual, precedido de lo que se intentaba («No se pudo cambiar el rol de @beto. …»), y la lista se vuelve a leer: lo que se ve es lo que dice el servidor. Lo escrito no se pierde: si falla una invitación, el usuario y el rol siguen en el formulario; si falla un cambio de rol, el borrador sigue en la fila. 403 (ya no administras la instancia) y 401 (la sesión caducó) retiran la lista y dicen qué hacer; sin conexión, la última lista leída sigue a la vista y «Actualizar» o el siguiente intento la recupera. 409 se muestra con el texto del servidor sea cual sea su código (`self`, `listed-admin`, `conflict` al cancelar la invitación de quien acaba de entrar, `limit` con 500 invitaciones sin aceptar). El seguro de «la instancia no se queda sin administradores» no es `last-admin` (ese código es de los proyectos): es que nadie baja de rol ni se desactiva a sí mismo.

**Teclado, lector de pantalla y pantalla pequeña.** Todo se hace con el teclado: el foco queda dentro de la ventana, **Escape** cancela una confirmación y, si no hay ninguna, cierra la ventana (y el foco vuelve al botón que la abrió); al confirmar, el foco cae en «No»; al terminar una acción vuelve a la fila donde estaba. La lista es una tabla con encabezados, cada control lleva el nombre de la cuenta a la que afecta («Desactivar a @beto») y los avisos se anuncian (`role="status"` y `role="alert"`). En una pantalla estrecha (700 px o menos) cada cuenta pasa a ser una tarjeta, sin desplazamiento lateral. Usa los mismos colores que el resto del gestor, así que sigue el tema claro u oscuro.
