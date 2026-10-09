# Despliegue con GitHub Pages, Render y Supabase

Guía para alojar la nube de proyectos de DIAgrams **sin máquina propia**: el sitio en GitHub Pages, el servicio (la API y el inicio de sesión) en Render y los datos en Supabase. Es la alternativa a la VPS con Caddy de [`despliegue-nube.md`](despliegue-nube.md); de aquel documento valen igual el registro de la OAuth App (paso 1), el primer acceso como administradora (paso 4) y la solución de problemas (paso 8).

```
Navegador ──► GitHub Pages            https://juliancardonagaleano.github.io/diagrams/   (el sitio, estático)
    │
    └───────► Render (servicio web)   https://diagrams-api.onrender.com                  (API, inicio de sesión)
                    │
                    └───────────────► Supabase (Postgres)                                (cuentas, sesiones, proyectos)
```

Cada pieza es independiente: el sitio y el servicio viven en **orígenes distintos**, y por eso hay que decirle al servicio qué sitio puede llamarlo (`IARK_CORS`) y al sitio dónde está el servicio (`IARK_SERVER_URL`). Todo eso está en esta guía.

## Por qué estas tres piezas

- **Sitio: GitHub Pages, no Vercel.** Pages ya está montado: cada fusión a `master` compila, pasa las pruebas y publica sola ([`deploy-pages.yml`](../.github/workflows/deploy-pages.yml)), sin cuenta ni permisos nuevos. Vercel daría despliegues de vista previa por rama y su propio dominio, pero añade otro proveedor, otra cuenta y otra configuración, y el sitio no necesita nada que Pages no dé (es estático y no usa funciones del servidor). Si algún día quieres un dominio propio, Pages también lo admite.
- **Servicio: Render, en un servicio propio.** El servicio necesita un proceso Node siempre encendido (el inicio de sesión guarda un estado breve en memoria y hay un canal de avisos en directo), así que no encaja en un alojamiento de funciones. En Render cada servicio web elige su **propia instancia** (memoria y CPU): crear este servicio **no quita recursos** a los que ya tengas (por ejemplo, otro proyecto en el mismo espacio de trabajo). Lo único que puede compartirse es la cuota del plan del espacio de trabajo (por ejemplo, horas de instancias gratuitas); compruébalo en tu panel de Render antes de elegir plan.
- **Datos: Supabase.** Render no guarda datos entre despliegues (su disco es efímero salvo que contrates un disco), así que las cuentas y los proyectos van a Postgres. DIAgrams habla con Supabase por conexión directa de Postgres; no usa su API REST, ni sus claves `anon`/`service_role`, ni su autenticación.

Qué se necesita (todo por tu cuenta): una cuenta de Supabase, una de Render y la de GitHub desde la que registrarás la OAuth App.

## 1. Supabase — *Lo haces tú*

1. Crea un proyecto en Supabase y apunta la **región**; elige la misma, o la más cercana, para el servicio de Render. Guarda la **contraseña de la base** que te pide al crearlo (si la pierdes, se restablece en *Database ▸ Settings*). Si tiene símbolos (`@ : / # ? %`), usa mejor una contraseña solo con letras y números: va dentro de una dirección y hay que codificarlos con `%XX`.
2. Copia la cadena de conexión: botón **Connect** ▸ **Transaction pooler** (puerto **6543**). Tiene esta forma y la contraseña va donde pone `[YOUR-PASSWORD]`:

   ```
   postgres://postgres.<referencia>:[YOUR-PASSWORD]@<servidor-del-pooler>.pooler.supabase.com:6543/postgres
   ```

   Usa el **pooler** y no la «Direct connection»: la conexión directa de Supabase puede ser solo IPv6 (salvo que contrates su complemento IPv4) y no hay garantía de que Render salga por IPv6. DIAgrams está escrito para el modo de transacción del pooler (sin sentencias preparadas con nombre, sin `SET` de sesión, sin `LISTEN`).
3. **No hace falta crear tablas.** Al arrancar, DIAgrams crea su propio esquema `iark` (no usa `public`, que Supabase expone por su API pública) y aplica sus migraciones. Activa la seguridad por filas en todas las tablas y no da permisos a `anon`, `authenticated` ni `service_role`, así que ni las claves públicas de tu proyecto llegan a esos datos. Detalle: [`postgres.md`](postgres.md).
4. **Certificado del servidor** (recomendado): en *Database ▸ Settings ▸ SSL configuration* descarga el certificado de la autoridad (`.crt`). DIAgrams comprueba el certificado del servidor por omisión; con ese archivo lo hace contra la autoridad de Supabase (paso 4 de Render). Si no lo subes, y la conexión falla con un error de certificado, la salida de emergencia es `IARK_DATABASE_SSL=no-verify`: la conexión va cifrada pero ya no se comprueba a quién te conectas.
5. El plan gratuito de Supabase tiene un espacio limitado (500 MB al escribir esto: compruébalo) y **pausa** los proyectos sin actividad. Cada guardado de un diagrama escribe el documento y una versión del historial, casi el doble de espacio; vigila el uso en el panel de Supabase.

## 2. La OAuth App de GitHub — *Lo haces tú*

Como el paso 1 de [`despliegue-nube.md`](despliegue-nube.md#1-registrar-la-oauth-app-en-github--lo-haces-tú), con una diferencia: la dirección pública es la **del servicio de Render**, no la del sitio de Pages. La *Authorization callback URL* es `https://<tu-servicio>.onrender.com/api/auth/github/callback`. No pongas `github.io` en la OAuth App.

La dirección de Render solo se conoce al crear el servicio (paso 3). Puedes registrar la OAuth App con la que esperas (el nombre del servicio da la dirección: `https://diagrams-api.onrender.com`) y corregir la *callback URL* en GitHub si Render te asigna otra.

## 3. Render — *Lo haces tú*

**Con el Blueprint** (lo más cómodo): en Render, **New ▸ Blueprint**, elige este repositorio y la ruta [`deploy/render.yaml`](../deploy/render.yaml). Crea un servicio web Docker (`diagrams-api`) que construye la imagen del `Dockerfile` y te pide los valores secretos. El archivo no se ha probado contra Render: si rechaza algún campo, crea el servicio a mano con **New ▸ Web Service ▸ Docker** y los valores de la tabla.

Variables de entorno:

| Variable | Valor |
|---|---|
| `IARK_ACCOUNTS_STORE` | `postgres` (la imagen trae `sqlite` por omisión: hay que cambiarlo) |
| `IARK_WORKSPACE_STORE` | `postgres` |
| `IARK_DATABASE_URL` | la cadena del *Transaction pooler* del paso 1 (**secreto**) |
| `IARK_DATABASE_POOL` | `5` (conexiones por proceso) |
| `IARK_PUBLIC_URL` | `https://diagrams-api.onrender.com` (la dirección que dé Render, sin barra final) |
| `IARK_CORS` | `https://juliancardonagaleano.github.io` (solo el origen, sin ruta ni barra final) |
| `IARK_GITHUB_CLIENT_ID` | el Client ID de la OAuth App |
| `IARK_GITHUB_CLIENT_SECRET` | el Client secret (**secreto**) |
| `IARK_ADMINS` | tu identificador numérico de GitHub ([paso 4](despliegue-nube.md#4-entrar-por-primera-vez-como-administradora--lo-haces-tú)) |
| `IARK_SIGNUP` | `invite` (o `open`) |
| `IARK_WORKERS` | `1` (los hilos de cálculo que caben en una instancia pequeña) |
| `IARK_ACCESS_LOG` | `-` (registro de accesos a los registros de Render, sin credenciales ni contenido) |

No definas `IARK_WORKSPACE` ni `IARK_ACCOUNTS` (rutas de disco): con `postgres` no se usan, y `IARK_WORKSPACE` junto a `IARK_WORKSPACE_STORE=postgres` se rechaza.

Otros detalles:

- **Puerto y salud.** Render define `PORT` y la imagen lo respeta; la comprobación de salud es `GET /healthz` (el Blueprint ya la fija). `GET /readyz` además hace una consulta a la base y responde `503` si Supabase no contesta.
- **Certificado de Supabase** (paso 1.4): en el servicio, **Environment ▸ Secret Files**, sube el `.crt` como `supabase-ca.crt` y añade `IARK_DATABASE_CA_FILE=/etc/secrets/supabase-ca.crt`.
- **Una sola instancia.** No actives el escalado a varias instancias. Las cuentas y los proyectos sí aguantan varias réplicas contra la misma base, pero el estado del inicio de sesión (el `state` de la redirección y el código de un solo uso) y los frenos de intentos fallidos viven en la memoria de cada proceso: con varias réplicas el inicio de sesión necesitaría afinidad de sesión, y Render no la da por omisión. Los avisos en tiempo real (`/api/events`) también son de un proceso.
- **`IARK_TRUST_PROXY`.** Render pone un proxy delante. Con `IARK_TRUST_PROXY=true` el freno de intentos usa la última dirección de `X-Forwarded-For`; sin él, todas las personas comparten un único freno. Actívalo solo si has comprobado que esa última entrada es la dirección real de cada visita: con `IARK_ACCESS_LOG=-` mira en los registros de Render la dirección que anota para dos conexiones desde sitios distintos. En la duda, déjalo apagado: es lo seguro.
- **Recursos.** Con `IARK_WORKERS=1` y `IARK_DATABASE_POOL=5` el servicio es ligero; en las pruebas usó del orden de 100 MB en reposo y unos 330 MB exportando un diagrama de 300 contenedores ([`despliegue-nube.md`](despliegue-nube.md#opción-recomendada-una-vps-pequeña-con-docker-compose-y-caddy)). Elige la instancia con ese margen.

Cuando el servicio esté «Live», comprueba desde cualquier equipo:

```bash
curl https://diagrams-api.onrender.com/healthz                  # {"status":"ok"}
curl https://diagrams-api.onrender.com/readyz                   # {"status":"ok","checks":{...}}: la base responde; 503 si no
curl https://diagrams-api.onrender.com/api/auth/providers       # {"providers":[{"id":"github",...}],"signup":"invite"}
curl -i https://diagrams-api.onrender.com/api/projects          # 401 sin sesión: es lo correcto
```

En los registros de Render debe aparecer una línea `inicio de sesión: GitHub (…) · callback https://…/api/auth/github/callback · cuentas: … (N, almacén postgres)`. Compara esa `callback` con la de la OAuth App.

## 4. El sitio de Pages apunta al servicio — *Lo haces tú*

Para que el campo «Dirección del servidor» de *Dónde se guardan* venga ya rellenado en el sitio publicado, en GitHub: **Settings ▸ Secrets and variables ▸ Actions ▸ Variables ▸ New repository variable**:

| Nombre | Valor |
|---|---|
| `IARK_SERVER_URL` | `https://diagrams-api.onrender.com` |

La compilación de Pages la toma como `VITE_IARK_SERVER`. Solo se acepta `https://` (o `http://` en `localhost`), sin usuario ni clave; no conecta nada por sí sola: la persona sigue pulsando **Conectar**. Es una variable, no un secreto: la dirección del servicio es pública.

El cambio **no se publica solo**: la variable no es código y un push de solo documentación no dispara el flujo. Ve a **Actions ▸ Deploy to GitHub Pages ▸ Run workflow** (sobre `master`) o espera a la siguiente fusión.

## 5. Entrar por primera vez — *Lo haces tú*

Abre `https://juliancardonagaleano.github.io/diagrams/modulos.html` ▸ **Proyectos…** ▸ **Dónde se guardan ▸ Conectar a un servidor…**. La dirección debería estar ya escrita; pulsa **Iniciar sesión con GitHub**, acepta y vuelves al sitio de Pages con tu ficha (`@usuario`, rol `admin`). Quién entra, cómo invitar y la pantalla de administración: [`despliegue-nube.md`](despliegue-nube.md#4-entrar-por-primera-vez-como-administradora--lo-haces-tú).

Cómo funciona entre dos orígenes: el sitio abre el inicio de sesión en el servicio indicando a qué página volver; GitHub devuelve al **servicio** (la *callback URL*), que redirige al sitio (solo si es el suyo o un origen de `IARK_CORS`, nunca un destino cualquiera) con un código de un solo uso que el sitio canjea por una sesión. Esa sesión es un token que el sitio manda en la cabecera `Authorization`, no una cookie entre sitios, así que no depende de las cookies de terceros del navegador. Esto está cubierto por las pruebas del servicio (redirección permitida y rechazada, CORS con `Authorization` y el canal de avisos); lo que **no** se ha probado es el recorrido completo con los dominios reales de Pages y Render.

## 6. Copias de seguridad, actualizaciones y límites

- **Copias.** Los datos están en Supabase: usa las copias de su panel (según el plan) o `pg_dump` contra la conexión directa. `iark accounts backup` es solo de SQLite y no aplica. Las copias contienen los hashes de las sesiones y los documentos: trátalas como las cuentas.
- **Pasar lo que ya tenías.** De un servicio con carpeta de proyectos a Postgres: `iark workspace import --from <carpeta>` (conserva ids, fechas e historial). De cuentas en JSON o SQLite a Postgres: `iark accounts migrate --accounts-store postgres` (o `IARK_ACCOUNTS_IMPORT` al arrancar con la base vacía). Ambos leen la base de `IARK_DATABASE_URL`, que debe estar en el entorno del comando.
- **Actualizar.** Con `autoDeployTrigger: commit` Render reconstruye con cada fusión a `master`. Las migraciones de la base se aplican solas al arrancar, y DIAgrams **se niega a arrancar** si la base es de una versión más nueva que la suya (vuelve a una imagen más reciente, no a una anterior).
- **Rotar secretos.** El Client secret: nuevo en GitHub, cámbialo en el entorno de Render y vuelve a desplegar. La contraseña de Supabase: restablécela en Supabase, actualiza `IARK_DATABASE_URL` y vuelve a desplegar (hasta entonces el servicio responde `503`).
- **Límites.** Una sola instancia (arriba). Las cuotas de uso (bytes, proyectos, diagramas) se miden fuera de la transacción de guardado: son una estimación, no un tope duro. Un documento con el carácter U+0000 sin escapar se rechaza (Postgres no lo admite en `text`). Con el plan gratuito de Supabase, el espacio se llena pronto con el historial de versiones. Y, sobre todo: **no se ha probado contra un Supabase ni un Render reales** (solo contra un Postgres 16 local); la primera vez, vigila los registros de Render y `GET /readyz`.

## Si algo falla

| Qué ves | Qué pasa |
|---|---|
| El servicio no arranca y el registro dice `Falta IARK_DATABASE_URL` | Falta esa variable (o está vacía). No se acepta por la línea de comandos |
| `no se pudo comprobar el certificado del servidor` (o `self-signed certificate in certificate chain`) | Sube el certificado de Supabase y define `IARK_DATABASE_CA_FILE` (paso 3); solo en último caso, `IARK_DATABASE_SSL=no-verify` |
| `password authentication failed` | La contraseña de la cadena no es la de la base (o tiene símbolos sin codificar con `%XX`). El mensaje de DIAgrams nunca la repite |
| `too many connections` / `remaining connection slots` | Usa el *Transaction pooler* (6543) y baja `IARK_DATABASE_POOL` |
| `ENETUNREACH` / `network is unreachable` al conectar | Estás usando la conexión directa (IPv6): cambia a la cadena del pooler |
| `/readyz` responde `503` con `accounts` o `workspace` en `fail` | Supabase no contesta (proyecto pausado, contraseña cambiada, red). Mira el registro: el motivo sale ahí, sin la contraseña |
| El sitio de Pages avisa de **CORS** | El origen no está en `IARK_CORS` o está mal escrito (sin ruta ni barra final) |
| GitHub muestra `redirect_uri_mismatch` | La *callback URL* de la OAuth App no es exactamente `<IARK_PUBLIC_URL>/api/auth/github/callback` |
| Vuelves a Pages con `#iark_error=login_failed` | El Client secret o el Client ID no son los de esa OAuth App, o la base no contestó en ese momento: el registro lo dice |
| El primer acceso tarda mucho | El plan de Render apaga el servicio por inactividad (el gratuito lo hace): el primer acceso lo despierta |
