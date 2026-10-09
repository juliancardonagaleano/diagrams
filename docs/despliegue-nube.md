# Despliegue de la nube de proyectos (servicio gestionado con GitHub)

Guía para quien **aloja** el servicio: dejar DIAgrams en internet con «Iniciar sesión con GitHub», HTTPS y los datos en un disco que no se pierde. No hace falta ser experta en infraestructura: lo técnico ya viene en la imagen Docker y en [`deploy/`](../deploy/). Aquí está lo que tienes que hacer tú, en orden.

Cada paso dice quién lo hace:

- **Lo haces tú**: solo puede hacerlo la persona dueña del servicio (cuentas, dominio, contraseñas, contratar la máquina).
- **Ya está hecho**: viene en la imagen o en `deploy/`; no hay que tocarlo (se cuenta para que sepas qué hay).

## Lista de comprobación

Antes de empezar necesitas, **todo por tu cuenta**:

- [ ] **Un dominio o subdominio** que controles (por ejemplo `iark.tudominio.org`) y acceso a su DNS. Sin dominio no hay HTTPS, y sin HTTPS no hay inicio de sesión: GitHub y DIAgrams exigen una dirección `https://` (solo `localhost` puede ser `http`).
- [ ] **Una máquina con Docker** (Docker Engine con Compose v2: se usa el comando `docker compose`, con espacio) con IP pública y los puertos 80 y 443 abiertos; o una plataforma de contenedores con disco persistente (paso 2, alternativa).
- [ ] **Una cuenta de GitHub**, para registrar la OAuth App y ser la administradora. Quien entre al servicio también necesita la suya.
- [ ] **Tu identificador numérico de GitHub** (paso 4).
- [ ] **Un sitio fuera de esa máquina** donde guardar copias de seguridad (paso 6).

Lo que ya está hecho, para que sepas qué te ahorras:

| Ya está hecho (imagen y `deploy/`) | Lo haces tú |
|---|---|
| La imagen corre como usuario `node` (no root), con la carpeta de datos `/data` lista | Elegir la dirección y crear el registro DNS |
| `HEALTHCHECK` (`/healthz`) que sigue sirviendo con el inicio de sesión activo | Registrar la OAuth App en GitHub y copiar su Client ID y su Client secret |
| Caddy con HTTPS automático y renovación de certificados | Contratar la máquina, abrir los puertos 80 y 443 |
| `IARK_TRUST_PROXY=true` (`--trust-proxy`), sin publicar el puerto de DIAgrams, sistema de archivos de solo lectura, sin capacidades, reinicio automático, límites de memoria y de CPU, registros con rotación | Rellenar `deploy/.env` y guardar el secreto en `deploy/secrets/` |
| Volumen `iark-data` para proyectos y cuentas; el secreto como Docker secret | `docker compose up -d --build`, las copias de seguridad y las actualizaciones |
| Registro de accesos (a `docker compose logs iark`), auditoría de cambios (`/data/audit.jsonl`) y `/healthz`, `/readyz` y `/metrics` (esta apagada): [observabilidad](observabilidad.md) | Rotar la auditoría, decidir cuánto tiempo guardas los registros (llevan usuario e IP) y, si quieres, enchufar un monitor o Prometheus |
| Se niega a arrancar sin autenticación si hay proyectos (nunca los deja abiertos) | Decidir quién entra (`invite` u `open`) |

**La dirección pública** es la que elijas aquí, una sola vez, y se repite en todas partes: `https://iark.tudominio.org` (sin barra final ni ruta). En esta guía, `iark.tudominio.org` es tu dominio.

---

## 1. Registrar la OAuth App en GitHub — *Lo haces tú*

La OAuth App es lo que permite a GitHub decir «esta persona es @fulana» a tu servicio, sin pedirle ningún permiso sobre sus repositorios.

1. En GitHub, con tu cuenta: foto de perfil → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**. (Puede ser de tu cuenta o de una organización tuya.)
2. Rellena el formulario con estos valores:

| Campo | Valor |
|---|---|
| **Application name** | `DIAgrams` (o el que quieras: es lo que verá la gente en la pantalla de GitHub al entrar) |
| **Homepage URL** | `https://iark.tudominio.org` (la dirección pública) |
| **Application description** | opcional |
| **Authorization callback URL** | **`https://iark.tudominio.org/api/auth/github/callback`** |
| **Enable Device Flow** | **déjalo desmarcado**: no hace falta |

   La *callback URL* tiene que ser **exactamente** esa: `https`, tu dominio, el camino `/api/auth/github/callback`, sin barra final ni espacios. Es lo primero que se revisa cuando algo falla (ver el paso 8). DIAgrams la imprime al arrancar (`callback https://…`) para que la compares.
3. **Register application**. En la página de la aplicación copia el **Client ID**: es público y va en `deploy/.env` (`IARK_GITHUB_CLIENT_ID`).
4. **Generate a new client secret** y cópialo **en ese momento**: GitHub lo muestra una sola vez (si lo pierdes, genera otro y borra el anterior). Es un secreto: va **solo** en `deploy/secrets/github_client_secret` (paso 2); no en `.env`, no en git, no en un mensaje.

No cambies nada más de la aplicación. DIAgrams no pide permisos a GitHub, lee tu perfil público una vez y revoca el token de GitHub en el acto: no conserva ningún acceso.

## 2. Elegir dónde alojar

### Opción recomendada: una VPS pequeña con Docker Compose y Caddy

*Ya está hecho*: `deploy/docker-compose.yml` levanta DIAgrams y Caddy (HTTPS automático), con el volumen, el secreto y los límites. *Lo haces tú*:

1. **Contratar una VPS Linux** con IP pública (el proveedor que prefieras; compara precios y condiciones vigentes). Como referencia de tamaño, en las pruebas DIAgrams usó unos 100 MB de memoria en reposo y unos 330 MB exportando un diagrama de 300 contenedores, y Caddy unos 15 MB: una máquina con 1 GB debería bastar para empezar (compruébalo con `docker stats`).
2. **Instalar Docker** con Compose v2 siguiendo la [guía oficial](https://docs.docker.com/engine/install/) de tu sistema.
3. **DNS**: crea un registro **A** de `iark.tudominio.org` con la IP de la máquina (y **AAAA** si la máquina tiene IPv6). Comprueba que ya resuelve antes de seguir: `dig +short iark.tudominio.org` (o `nslookup iark.tudominio.org`) debe devolver tu IP. Si arrancas Caddy con el DNS mal, no consigue el certificado y reintenta; esperar a que propague evita llegar a los límites de peticiones de las entidades de certificados.
4. **Cortafuegos**: abre **80/tcp y 443/tcp** (en el panel del proveedor y, si lo usas, en `ufw`/`firewalld`). El 80 lo necesita Caddy para conseguir el certificado y para redirigir a HTTPS. DIAgrams **no** publica su puerto (solo Caddy llega a él, por la red interna de Docker). Si usas `ufw`, ten en cuenta que Docker publica puertos saltándose sus reglas: por eso el compose publica únicamente 80 y 443.
5. **Traer el código y configurarlo**:

```bash
git clone https://github.com/juliancardonagaleano/diagrams.git
cd diagrams/deploy
cp .env.example .env
nano .env            # rellena IARK_DOMAIN (iark.tudominio.org, sin https://), IARK_GITHUB_CLIENT_ID e IARK_ADMINS (paso 4)
```

6. **El secreto de la OAuth App**: pégalo en un archivo (con un editor, no con `echo`, para que no quede en el historial del intérprete) y ajusta quién puede leerlo. El contenedor lo lee con el usuario `node` (uid 1000), y `docker compose` monta el archivo tal cual, con su dueño y su modo:

```bash
nano secrets/github_client_secret       # solo el Client secret, y guarda
chown 1000:1000 secrets/github_client_secret && chmod 400 secrets/github_client_secret    # con sudo si no eres root
```

7. **Crear el volumen de datos** (una sola vez) y arrancar:

```bash
docker volume create iark-data          # proyectos y cuentas; ni «docker compose down» ni «down -v» lo borran
docker compose up -d --build            # la primera vez compila la imagen: tarda unos minutos
```

*Ya está hecho en el compose*: el volumen heredará de la imagen la carpeta `/data` con el dueño correcto (`node`, 1000:1000); `iark` solo escribe en `/data` y `/tmp`; `caddy` no arranca hasta que `iark` esté sano.

### Alternativa: una plataforma de contenedores (Fly.io, Render, Railway…)

Sirve cualquiera que cumpla **todos** estos requisitos. **No he probado ninguna plataforma concreta** y por eso no incluyo una configuración de ejemplo: cada una cambia sus campos y sus límites; **comprueba en su documentación los precios y los límites vigentes** (sobre todo del disco persistente y de si apaga el servicio por inactividad).

1. **Una sola instancia (réplica) en una sola máquina**. Las cuentas están en una base SQLite en el disco local: dos copias sobre el mismo disco **local** no la corrompen (cada cambio es una transacción), pero la base no sirve entre máquinas distintas ni sobre un disco de red (NFS, SMB), y el inicio de sesión necesita que sus tres peticiones lleguen a la misma instancia (ver [Límites](#9-límites-honestos)). Desactiva el escalado automático; un despliegue que arranque la versión nueva *antes* de parar la vieja sobre el mismo disco local es tolerable (la base lo admite), pero no entre máquinas.
2. **Un disco persistente montado en `/data`**, para que `IARK_WORKSPACE=/data/workspace` e `IARK_ACCOUNTS=/data/accounts.db` sobrevivan a cada despliegue. Sin disco, se pierde todo al actualizar. Debe ser un disco **local** de bloque (el de Docker, el de la VPS, el volumen persistente de la plataforma): SQLite en modo WAL no funciona bien sobre sistemas de archivos de red.
3. **HTTPS en la dirección pública**: la que te dé la plataforma o tu dominio. Esa misma es `IARK_PUBLIC_URL` y la base de la *callback URL* de la OAuth App (paso 1).
4. **Construir la imagen desde el `Dockerfile` del repositorio** (no hay una imagen publicada en un registro). El puerto sale de la variable `PORT` (8787 por omisión): si la plataforma la define, funciona sin más; si no, apunta su puerto interno al 8787. La comprobación de salud es `GET /healthz` (público y sin tocar el disco; la imagen ya la trae); si la plataforma puede sacar la instancia de rotación sin reiniciarla, `GET /readyz` dice además si puede trabajar (`503` si no puede escribir en el disco): ver [Observabilidad](observabilidad.md#salud-healthz-y-readyz). Los registros (`IARK_ACCESS_LOG=-` para la salida estándar, `IARK_AUDIT_LOG=/data/audit.jsonl`) se encienden con variables, como todo.
5. **Detrás de un proxy**: `IARK_TRUST_PROXY=true` (equivale a `--trust-proxy`) y, si lo necesitas, `IARK_CORS=https://juliancardonagaleano.github.io` (equivale a `--cors`; ver el apartado 5). `IARK_TRUST_PROXY` solo vale si la plataforma deja la dirección real del cliente en la **última** entrada de `X-Forwarded-For`; si no lo tienes claro (Fly.io, por ejemplo, documenta la dirección del cliente en otra cabecera, `Fly-Client-IP`, que DIAgrams no lee), déjalo sin activar: todas las personas compartirán entonces el freno de intentos fallidos. Si la plataforma solo deja poner argumentos, `--trust-proxy` y `--cors=…` valen igual: deben añadirse a los de la imagen (como los que van detrás del nombre de la imagen en `docker run`), no sustituir su `ENTRYPOINT`.
6. **Variables de entorno** (el Client secret, en el almacén de secretos de la plataforma, no en un archivo del repositorio):

| Variable | Valor |
|---|---|
| `IARK_WORKSPACE` | `/data/workspace` |
| `IARK_ACCOUNTS` | `/data/accounts.db` (la imagen ya fija `IARK_ACCOUNTS_STORE=sqlite`) |
| `IARK_ACCOUNTS_IMPORT` | solo si actualizas un servicio que tenía las cuentas en JSON: `/data/accounts.json` (ver el paso 7) |
| `IARK_PUBLIC_URL` | `https://…` (la dirección pública, sin barra final) |
| `IARK_GITHUB_CLIENT_ID` | el Client ID de la OAuth App |
| `IARK_GITHUB_CLIENT_SECRET` | el Client secret (o `IARK_GITHUB_CLIENT_SECRET_FILE` con la ruta de un archivo de secretos) |
| `IARK_ADMINS` | tu identificador numérico de GitHub (paso 4) |
| `IARK_SIGNUP` | `invite` (o `open`; paso 4) |
| `IARK_SESSION_DAYS`, `IARK_MAX_PROJECTS`, `IARK_MAX_DIAGRAMS`, `IARK_MAX_BYTES` | opcionales (30 días, y por persona 25 proyectos, 200 diagramas por proyecto y 256M de espacio por omisión; `0` quita un tope: [Cuotas de uso](cuentas-github.md#cuotas-de-uso)) |

7. **Quién es el dueño del disco.** La imagen corre como `node` (1000:1000). Si la plataforma monta el disco con dueño root y no te deja cambiarlo, DIAgrams no podrá escribir y no arrancará, con `No se pudo crear la base de cuentas «/data/accounts.db» (EACCES)`. Último recurso: construir la imagen para correr como root con `--build-arg IARK_RUN_AS=root` (el campo de «build args» de la plataforma). Probé el servicio como root sobre un disco de root; no probé el argumento en ninguna plataforma.
8. Si la plataforma apaga el servicio por inactividad, la primera visita tardará en responder; las sesiones no se pierden (están en el disco).

## 3. Primer arranque y cómo comprobar que funciona — *Lo haces tú*

```bash
docker compose ps                  # iark: «Up … (healthy)»; caddy: «Up»
docker compose logs iark           # lo que DIAgrams cuenta al arrancar (abajo)
docker compose logs caddy          # busca «certificate obtained successfully»
```

El registro de `iark` debe parecerse a esto (con tus valores):

```
DIAgrams escuchando en http://0.0.0.0:8787 (sitio: dist/app)
  manifiesto: /.well-known/iark.json · módulos: /api/modules
  registro de accesos: stdout (JSON por línea; sin query string, cuerpos ni credenciales)
  auditoría: /data/audit.jsonl (JSON por línea, solo se añade; modo 0600)
  salud: /healthz (vivo) · /readyz (listo)
  cálculo: hasta 1 hilo(s) de trabajo · tiempo límite 30 s por operación · cola de 16
  las rutas de cálculo (validar, exportar, importar, informes, trazas) exigen credencial; /api/modules, capabilities y schema siguen públicos
  espacio de trabajo: /data/workspace · proyectos: /api/projects
  inicio de sesión: GitHub (Iv1.…) · callback https://iark.tudominio.org/api/auth/github/callback · cuentas: /data/accounts.db (0, almacén sqlite) · entrada: solo por invitación · administradores: 1
  detrás de un proxy de confianza (--trust-proxy): el HTTPS lo pone el proxy, compruebe que la dirección pública es https; …
```

La última línea es un recordatorio, no un fallo: DIAgrams habla HTTP y Caddy le pone el HTTPS por delante (sin `IARK_TRUST_PROXY` saldría un «aviso: este servicio no habla TLS»). Lo que sí debes comparar es la `callback` con la de la OAuth App.

Desde cualquier equipo:

```bash
curl https://iark.tudominio.org/api/auth/providers     # {"providers":[{"id":"github","label":"GitHub"}],"tokens":false,"signup":"invite"}
curl https://iark.tudominio.org/.well-known/iark.json  # el manifiesto: debe traer "projects": "../api/projects" y "projectsAuth": "bearer"
curl -i https://iark.tudominio.org/api/projects        # 401 sin sesión: es lo correcto; los proyectos no son públicos
curl -sI http://iark.tudominio.org/ | head -1          # 308: el puerto 80 redirige a HTTPS
curl https://iark.tudominio.org/healthz                # {"status":"ok"}: vivo (es lo que mira el HEALTHCHECK)
curl https://iark.tudominio.org/readyz                 # {"status":"ok","checks":{"workspace":"ok","accounts":"ok","compute":"ok"}}: puede trabajar; 503 si no
```

Si `providers` sale vacío (`"providers":[]`), DIAgrams arrancó sin inicio de sesión: revisa `.env` y el secreto. El `HEALTHCHECK` de la imagen consulta `/healthz` (público) cada 30 s; `docker inspect --format '{{.State.Health.Status}}' iark-iark-1` dice `healthy`.

## 4. Entrar por primera vez como administradora — *Lo haces tú*

**Tu identificador numérico.** `IARK_ADMINS` admite nombres de usuario de GitHub y números; **usa el número**. El nombre de usuario puede cambiarse y pasar a otra persona (y entonces administraría tu servicio); el identificador no cambia nunca.

```bash
curl https://api.github.com/users/TU_USUARIO     # busca la línea "id": 583231,
```

Ponlo en `deploy/.env` (`IARK_ADMINS=583231`; varias personas, separadas por comas) y aplica con `docker compose up -d`.

**Entrar.** Abre `https://iark.tudominio.org/modulos.html` (banco de trabajo: **Proyectos…**) o `https://iark.tudominio.org/` (editor C4: **Archivo ▸ Proyectos…**) y ve a **Dónde se guardan ▸ Conectar a un servidor…** ([Guardar en la nube (servidor propio) desde el navegador](proyectos.md#guardar-en-la-nube-servidor-propio-desde-el-navegador)). La dirección aparece ya escrita cuando el sitio lo sirve la propia instancia; pulsa **Iniciar sesión con GitHub**, acepta en GitHub y vuelves con tu ficha (@usuario, rol `admin`).

**Quién puede entrar (`IARK_SIGNUP`):**

| Valor | Quién entra | Cuándo conviene |
|---|---|---|
| `invite` (por omisión) | Solo las personas de `IARK_ADMINS` y las que invites por su nombre de GitHub | Un equipo conocido. Recomendado |
| `open` | Cualquiera con cuenta de GitHub, como miembro (puede crear hasta `IARK_MAX_PROJECTS` proyectos y guardar hasta `IARK_MAX_BYTES`) | Una comunidad abierta. Las [cuotas](cuentas-github.md#cuotas-de-uso) acotan a cada persona, pero no son un tope duro de disco: vigila también el espacio libre del volumen |

**Invitar** a alguien es compartir un proyecto con su nombre de usuario de GitHub (*Compartir…* en el gestor de proyectos): queda como invitación y, al entrar con esa cuenta, tiene el proyecto con el rol que le diste (como invitado: no crea proyectos propios). Invitar a la instancia sin compartir un proyecto, desactivar una cuenta o cambiar su rol se hace en **Administrar cuentas…** (en «Dónde se guardan», para quien administra la instancia: [Pantalla de administración](cuentas-github.md#pantalla-de-administración)) o con la API ([Administrar las cuentas de la instancia](cuentas-github.md#administrar-las-cuentas-de-la-instancia)). Quien no esté invitado vuelve a la página con `#iark_error=not_invited` (el sitio lo explica). Cambiar `IARK_SIGNUP`: edita `.env` y `docker compose up -d` (recrea el contenedor; las sesiones se conservan, están en el disco).

## 5. El sitio de GitHub Pages también puede usar esta instancia — *Lo haces tú*

El sitio ya publicado (`https://juliancardonagaleano.github.io/diagrams/`) puede guardar sus proyectos en tu instancia: en `deploy/.env` pon

```
IARK_CORS=https://juliancardonagaleano.github.io
```

y `docker compose up -d`. Es el **origen** (esquema y dominio, **sin ruta ni barra final**); admite varios, separados por comas. Eso hace dos cosas: el navegador deja que esa página llame a tu API (CORS, con `Authorization`), y tras entrar con GitHub se **vuelve** a esa página (DIAgrams solo devuelve a su propio sitio o a un origen de `IARK_CORS`; nunca a `*`).

- La **dirección pública sigue siendo la de la instancia** (`IARK_DOMAIN`, la *callback URL* de la OAuth App): GitHub devuelve a tu servicio, que redirige después al sitio de Pages. No pongas `github.io` en la OAuth App.
- En *Dónde se guardan* de ese sitio escribe la dirección de la instancia (`https://iark.tudominio.org`).
- **Cuándo conviene**: si la gente ya usa el sitio de Pages y quieres darle la nube sin cambiar de dirección. **Si no, usa directamente el sitio de tu instancia** (`https://iark.tudominio.org/`): ya sirve el editor y el banco de trabajo, con el mismo origen y sin CORS. Los proyectos que alguien tenga guardados **en el navegador** pertenecen al origen donde los creó: no los verá en el sitio de otra dirección (cópialos a la nube antes desde *Copiar a…*).

## 6. Copias de seguridad y restaurar — *Lo haces tú*

**Qué copiar: `/data` entero**, el volumen `iark-data`: `accounts.db` (la base de cuentas, sesiones y quién pertenece a qué proyecto; con sus `accounts.db-wal` y `accounts.db-shm` mientras el servicio corre) y `workspace/` (los proyectos). Guarda además `deploy/.env` (no es secreto). El Client secret no está en el volumen: si lo pierdes, genera otro en GitHub. Los certificados de Caddy no hace falta copiarlos: se vuelven a pedir. La auditoría (`audit.jsonl`) está en el mismo volumen y se copia con él; el registro de accesos va a la salida estándar de Docker y no forma parte de la copia.

**La base no se copia con `tar` ni `cp` mientras el servicio corre**: en modo WAL, lo último escrito puede estar aún en `accounts.db-wal`, y una copia de `accounts.db` sola, o tomada a la vez que el `-wal`, puede salir incoherente. La copia correcta es `iark accounts backup`, que hace una copia coherente de la base viva (sin parar el servicio), con modo 0600, y comprueba su integridad:

```bash
docker compose exec iark node dist/cli/index.js accounts backup /data/accounts-$(date +%F).db
```

Esa copia queda en el volumen. Para llevarte **todo** fuera de la máquina (la base copiada y los proyectos), un contenedor aparte lee el volumen en solo lectura y escribe un `.tar.gz` en la carpeta actual, **sin la base viva ni su diario** (solo la copia coherente de arriba):

```bash
docker run --rm --user 0 -v iark-data:/data:ro -v "$PWD":/backup --entrypoint tar diagrams \
  czf /backup/iark-data-$(date +%F).tar.gz -C /data \
  --exclude=./accounts.db --exclude=./accounts.db-wal --exclude=./accounts.db-shm .
```

Los proyectos se guardan archivo a archivo de forma atómica, así que esa parte es coherente archivo a archivo; si prefieres una copia exacta de todo, **para el servicio un momento**: `docker compose stop iark`, el `tar` de arriba y `docker compose start iark`. En ambos casos, **llévate el `.tar.gz` fuera de la máquina** (otro equipo, un almacenamiento de objetos…) y repítelo con la frecuencia que te dé tranquilidad: lo que se escriba después de la última copia se pierde si se pierde el disco. Borra de vez en cuando las copias viejas de `/data` (`accounts-*.db`): son pequeñas, pero se acumulan.

**Restaurar** (en esta máquina o en otra con el repositorio clonado, `deploy/.env` y el secreto puestos y la imagen construida con `docker compose build`), **en un volumen vacío**. La copia de la base se renombra a `accounts.db` (y se borra cualquier `-wal` o `-shm` suelto, que no pertenecerían a esa copia):

```bash
docker compose down                       # no borra el volumen
docker volume rm iark-data                # solo si vas a sustituir lo que haya: BORRA los datos actuales
docker volume create iark-data
docker run --rm --user 0 -v iark-data:/data -v "$PWD":/backup:ro --entrypoint sh diagrams \
  -c 'tar xzf /backup/iark-data-2026-10-06.tar.gz -C /data && rm -f /data/accounts.db-wal /data/accounts.db-shm && mv /data/accounts-2026-10-06.db /data/accounts.db && chown -R 1000:1000 /data'
docker compose up -d
```

Las sesiones de la copia siguen valiendo; las abiertas después de la copia caducan (401: se vuelve a entrar con GitHub). Para comprobar el estado de la base en cualquier momento: `docker compose exec iark node dist/cli/index.js accounts info` (versión del esquema, integridad, cuántas cuentas y sesiones).

## 7. Actualizar la imagen — *Lo haces tú*

```bash
cd diagrams && git pull
cd deploy
docker compose build --pull        # reconstruye DIAgrams con la última base de Node
docker compose pull caddy          # y trae la última versión de Caddy
docker compose up -d               # recrea solo lo que cambió
```

Haz una copia antes (paso 6). Lo único que sobrevive entre una versión y otra es el volumen: las cuentas, las sesiones y los proyectos siguen donde estaban (probado: con un contenedor nuevo sobre el mismo volumen, la sesión y el proyecto siguen). El corte es de unos segundos. Si la base es de una versión más nueva que la imagen (vuelves atrás), la imagen vieja no la abre y lo dice: actualiza en vez de volver, o restaura la copia de antes. Para volver atrás: `git checkout <commit anterior>` y `docker compose up -d --build`. `docker image prune` libera el espacio de las imágenes viejas.

Rotar el Client secret: genera otro en GitHub, cámbialo en `secrets/github_client_secret` (con `chown`/`chmod` como en el paso 2) y `docker compose restart iark`; después borra el viejo en GitHub.

**Si tu servicio ya estaba en marcha con las cuentas en JSON** (las versiones anteriores guardaban `/data/accounts.json`): el `docker-compose.yml` nuevo usa la base SQLite `/data/accounts.db` y trae `IARK_ACCOUNTS_IMPORT: /data/accounts.json`, así que **basta con la actualización de arriba**: en el primer arranque DIAgrams importa el JSON a la base (cuentas, invitaciones, sesiones —los tokens siguen valiendo— y proyectos compartidos), lo cuenta en el registro (`Cuentas importadas de «/data/accounts.json»: …`), **deja `accounts.json` como estaba** y guarda una copia suya en `/data/accounts.json.bak-<fecha>`. Los reinicios siguientes no repiten nada. Haz la copia del paso 6 antes, como siempre. Cosas a saber:

- Si prefieres hacerlo a mano y comprobar antes, con el servicio parado: `docker compose run --rm --no-deps --entrypoint node iark dist/cli/index.js accounts migrate --from /data/accounts.json --dry-run` cuenta lo que se importaría sin escribir nada (quita `--dry-run` para importarlo). Se puede repetir sin riesgo: con el mismo JSON no hace nada.
- **Volver atrás** (a la imagen anterior) es posible: el JSON no se tocó. Arranca la imagen vieja con `IARK_ACCOUNTS=/data/accounts.json`; perderás lo que cambió en las cuentas desde que migraste (sesiones nuevas, personas que entraron, proyectos compartidos). Por eso conviene no volver atrás pasado un tiempo.
- Si quieres **seguir con el JSON** (no recomendado: un solo proceso, sin transacciones), pon `IARK_ACCOUNTS_STORE: json` e `IARK_ACCOUNTS: /data/accounts.json` en el compose y quita `IARK_ACCOUNTS_IMPORT`.
- Si la base ya tenía otras cuentas (alguien arrancó la versión nueva sin el JSON y entraron personas), la importación **no mezcla**: el registro dice `aviso: no se importa …` y arranca con la base como está. Para rehacerla: para el servicio, borra `accounts.db`, `accounts.db-wal` y `accounts.db-shm` del volumen y arranca de nuevo.
- Una vez migrado y comprobado, puedes quitar `IARK_ACCOUNTS_IMPORT` del compose y, pasado un tiempo, borrar `accounts.json` y sus `.bak-*` (contienen los hashes de las sesiones: trátalos como las cuentas).

## 8. Solución de problemas

Siempre empieza por `docker compose ps` y `docker compose logs iark` (y `caddy`).

| Qué ves | Qué pasa y cómo se arregla |
|---|---|
| **GitHub muestra `redirect_uri_mismatch`** («The redirect_uri MUST match the registered callback URL…») | La *Authorization callback URL* de la OAuth App no es exactamente `<IARK_PUBLIC_URL>/api/auth/github/callback`: `http` en vez de `https`, otra dirección (`www.`, otro subdominio, un puerto), una barra al final. Compárala letra a letra con la línea `callback …` del registro de arranque y corrige la OAuth App |
| Una página 404 de GitHub al pulsar «Iniciar sesión» | Suele ser un Client ID mal copiado (`IARK_GITHUB_CLIENT_ID`) |
| Vuelves a la página con **`#iark_error=not_invited`** | Esa persona no es administradora ni está invitada y `IARK_SIGNUP=invite`. Invítala (paso 4) o usa `open`. Otros motivos: `access_denied` (canceló en GitHub), `disabled` (cuenta desactivada), `github_unavailable` (no se llegó a GitHub) |
| Vuelves con **`#iark_error=login_failed`** | Casi siempre el **Client secret** no es el de esa OAuth App (o se regeneró) o el Client ID es otro. El registro lo dice (`docker compose logs iark`: «inicio de sesión: GitHub no lo aceptó (rejected)…»; nunca incluye el secreto): revisa el secreto, `docker compose restart iark` y prueba otra vez |
| **401** `Hace falta un token válido: envíe la cabecera «Authorization: Bearer <token>»` (`"code":"unauthorized"`) | La sesión caducó (30 días por omisión, `IARK_SESSION_DAYS`), se cerró o la cuenta se desactivó; también tras restaurar una copia anterior a esa sesión. Se vuelve a entrar con GitHub |
| **401** al validar, exportar, importar, comparar, pedir un informe o `POST /api/trace` desde un script o una integración que antes funcionaba sin credencial | Con inicio de sesión (o tokens) esas rutas de cálculo piden `Authorization: Bearer <token o sesión>`, de cualquier rol (sección 9). Dale un token a esa integración (`iark auth create`), o, si el cálculo debe seguir abierto a cualquiera, arranca con `IARK_PUBLIC_COMPUTE=1` (`--public-compute`) |
| **503** `La operación superó el tiempo límite de 30 s y se canceló…` (`"code":"timeout"`) | El diagrama es demasiado grande o complejo para calcularlo en ese tiempo: el hilo que lo calculaba se terminó y el servicio sigue sirviendo todo lo demás. Simplifica el diagrama (menos contenedores o relaciones por vista) o sube `IARK_COMPUTE_TIMEOUT_MS` (sección 9) |
| **503** `El servicio está ocupado calculando…` (`"code":"busy"`, con cabecera `Retry-After`) | Todos los hilos de cálculo están ocupados y la cola está llena. Reintenta tras `Retry-After` segundos; si pasa con frecuencia, sube `IARK_WORKERS` y `IARK_COMPUTE_QUEUE` (y la CPU del contenedor) |
| **429** `Demasiados intentos fallidos desde esta dirección: espere N s…` o `Demasiados intentos de iniciar sesión desde esta dirección: espere unos minutos.` | El freno de intentos (con cabecera `Retry-After`; vive en memoria y se borra al reiniciar). Si salta a **todas** las personas a la vez, DIAgrams no ve la dirección real: falta `IARK_TRUST_PROXY=true` (el compose lo trae) o el proxy no anota `X-Forwarded-For` |
| **`docker compose up` dice** `required variable IARK_ADMINS is missing a value: Falta …` | Falta esa variable en `deploy/.env` (también `IARK_DOMAIN` e `IARK_GITHUB_CLIENT_ID`) |
| `external volume "iark-data" not found` | Falta crear el volumen: `docker volume create iark-data` |
| `bind source path does not exist: …/secrets/github_client_secret` | Falta el archivo del secreto (paso 2.6) |
| `dependency failed to start: container iark-iark-1 is unhealthy` | **DIAgrams no arranca**: mira `docker compose logs iark` (siguientes filas) |
| `/readyz` responde **503** | Mira qué comprobación dice `fail` (`curl https://…/readyz`): `workspace` (disco lleno, volumen de solo lectura o sin permisos), `accounts` (la base de cuentas `accounts.db` no se lee —falta el archivo, está dañada o la consulta falla— o su carpeta `/data` no admite escribir, donde SQLite crea su diario) o `compute` (el pool de cálculo está parado). `docker compose logs iark` avisa cada vez que una cambia de estado. El servicio no se reinicia por esto (el `HEALTHCHECK` es `/healthz`) |
| Un error inesperado (500) y quieres saber qué pasó | La respuesta lleva la cabecera `X-Request-Id`: `docker compose logs iark \| grep <ese id>` da el acceso y, junto al `error interno`, la línea `petición: <id>` |
| El registro dice `El inicio de sesión con GitHub necesita todo esto y falta: …` | Falta alguna variable (la lista dice cuál). Todo va por `deploy/.env` y el secreto |
| El registro dice `Con un espacio de trabajo, escuchar en 0.0.0.0 sin autenticación … el servicio no arranca así` | Hay `IARK_WORKSPACE` y no hay cuentas activas: es la red de seguridad. En otra plataforma, define las variables de GitHub |
| `No se pudo leer el secreto de GitHub de «/run/secrets/github_client_secret» (EACCES)` | El usuario del contenedor (1000) no puede leer el archivo: `chown 1000:1000 secrets/github_client_secret && chmod 400 …`. Si dice `está vacío`, el archivo no tiene el secreto |
| `No se pudo crear la base de cuentas «/data/accounts.db» (EACCES)` (o `No se pudo abrir…`) | `/data` no es de 1000:1000: pasa con un bind mount del anfitrión (`chown 1000:1000 <carpeta>`) o un disco de plataforma montado como root (paso 2, alternativa, punto 7). Con un volumen con nombre no ocurre |
| `Con --signup invite hace falta al menos un administrador…` | Falta `IARK_ADMINS` |
| `«/data/accounts.json» parece el archivo JSON de cuentas, no una base SQLite…` | `IARK_ACCOUNTS` apunta al JSON de antes pero el almacén es `sqlite`: usa `IARK_ACCOUNTS=/data/accounts.db` con `IARK_ACCOUNTS_IMPORT=/data/accounts.json` (ver el paso 7), o `IARK_ACCOUNTS_STORE=json` para seguir con el JSON. El archivo no se toca |
| `La base de cuentas … es de una versión más nueva de DIAgrams` | Se arrancó una imagen más vieja sobre una base que ya migró una más nueva: actualiza la imagen (no se abre para no escribir lo que no entiende) |
| `La base de cuentas … está ocupada: otro proceso la tuvo bloqueada…` (`unavailable`) | Otro proceso tiene la base bloqueada más de 5 s (una copia mal hecha con `tar` no la bloquea; sí un `sqlite3` abierto con una transacción sin cerrar). Cierra ese proceso. Si el disco es de red (NFS, SMB), el modo WAL no es fiable: pasa `/data` a un disco local |
| `«…» es una base SQLite, pero no de cuentas de DIAgrams` / `no es una base de cuentas válida (…)` | Ese archivo no es la base de cuentas (o está dañado). Restaura la última copia de `iark accounts backup` (paso 6); la base dañada no se modifica |
| El servicio dice `El almacén SQLite necesita Node 22.13.0 o superior` | Solo fuera de la imagen (que trae Node 22 reciente): actualiza Node o usa `IARK_ACCOUNTS_STORE=json` |
| `No se pudo cargar el módulo de terceros «…»: …` y el contenedor no arranca (solo si montaste plugins con `IARK_CONFIG`) | El especificador que nombra el mensaje no se resuelve o no cumple el contrato: ruta mal montada, falta `node_modules` con `@iark/kernel` y `zod` junto al módulo, o un módulo escrito para un contrato más nuevo. Un plugin roto impide arrancar a propósito; corrígelo o quita `IARK_CONFIG` (ver sección 9) |
| `La dirección pública debe ser https (solo localhost puede ser http)…` | `IARK_PUBLIC_URL` (o `IARK_DOMAIN`) mal escrito |
| El navegador avisa de un **certificado** no válido o no carga por HTTPS | Caddy no consiguió el certificado: `docker compose logs caddy`. Casi siempre, el DNS no apunta aún a la máquina o los puertos 80/443 están cerrados (en el panel del proveedor también). Corrige y `docker compose restart caddy` |
| **Contenido mixto** (la consola del navegador bloquea una petición `http://`) | Una página `https` no puede llamar a una dirección `http`: escribe la dirección de la instancia con `https://` en *Dónde se guardan* |
| **CORS** (`blocked by CORS policy`) desde el sitio de Pages u otra página | El origen no está en `IARK_CORS`: debe ser exacto (`https://juliancardonagaleano.github.io`, sin ruta ni barra final). Compruébalo: `curl -i -X OPTIONS https://iark.tudominio.org/api/projects -H 'Origin: https://juliancardonagaleano.github.io' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization'` debe dar `204` y `Access-Control-Allow-Origin`. Tras cambiar `.env`: `docker compose up -d` |

## 9. Límites honestos

- **Una sola máquina, sin alta disponibilidad.** Las cuentas viven en una base SQLite del disco local: varios procesos sobre el mismo disco son seguros (cada cambio es una transacción, también los topes y la regla de «el proyecto no se queda sin administrador»), pero la base no se comparte entre máquinas ni sobre un disco de red (NFS, SMB). Si la máquina cae, el servicio cae hasta que vuelva. Varias instancias sobre el mismo disco comparten ya las sesiones, los roles y los proyectos compartidos; lo que **no** es compartido son el estado del inicio de sesión de GitHub (el `state` de la redirección y el código de un solo uso, en la memoria de cada proceso) y los frenos de intentos fallidos: detrás de un balanceador, las tres peticiones del inicio de sesión (`/api/auth/github/login`, `/callback` y `/exchange`) deben llegar a la misma instancia (afinidad de sesión). Escalar más allá (varias máquinas, base gestionada) es una decisión pendiente que no se ha implementado: qué cambiaría está en [Camino a Postgres y réplicas](cuentas-github.md#camino-a-postgres-y-réplicas-una-decisión-pendiente-no-tomada).
- **Solo GitHub**: no hay SSO de empresa (SAML, OIDC) ni otros proveedores. Con GitHub Enterprise Server se puede apuntar `IARK_GITHUB_URL` y `IARK_GITHUB_API_URL` a su servidor.
- **Sin permisos por organización o equipo de GitHub.** DIAgrams no pide permisos, así que no lee a qué organizaciones perteneces: entra quien tiene cuenta (según `invite` u `open`) y los permisos se reparten por proyecto, por invitación.
- **El token de sesión vive en el navegador** (en la pestaña, o en el equipo si se marca «Mantener la sesión en este equipo»): cualquier script que se ejecute en el sitio, una extensión o quien use ese equipo podría leerlo. Cierra la sesión en equipos ajenos; una cuenta desactivada pierde sus sesiones.
- **La pantalla de administración es para personas**: la ve quien entra con GitHub y es administrador. Las cuentas de servicio con token (`--tokens`) administran por la API (`/api/admin/users`). Los cambios de cuentas quedan en la auditoría si la activas ([Observabilidad](observabilidad.md)); la pantalla en sí no guarda ningún historial.
- **Registros sencillos, y con datos personales.** El compose enciende el registro de accesos (a `docker compose logs iark`, con la rotación de Docker: unos 30 MB) y la auditoría de quién intentó cambiar qué (`/data/audit.jsonl`, que **no se rota sola**): ver [Observabilidad](observabilidad.md#rotar-los-registros). Llevan el usuario de GitHub y la dirección IP ([qué hacer con eso](observabilidad.md#datos-personales)), no hay alertas propias (las métricas, apagadas, son para un Prometheus que montes tú) y son de una sola instancia. Los cambios de otras personas se avisan en segundos (canal `GET /api/events`, de un solo proceso: ver [servicio.md](servicio.md#cambios-en-tiempo-real-get-apievents)) pero sigue sin haber edición simultánea ([límites reales de guardar en la nube](proyectos.md#guardar-en-la-nube-servidor-propio-desde-el-navegador)).
- **Sin edición simultánea**: solo avisos de que otra persona guardó, y de una sola instancia ([límites reales de guardar en la nube](proyectos.md#guardar-en-la-nube-servidor-propio-desde-el-navegador)).
- **Módulos de terceros: opcionales, solo API y bajo tu responsabilidad.** La imagen no trae ninguno. Si quieres servir uno, monta una carpeta con el módulo y su `node_modules` (con `@iark/kernel` y `zod`) en solo lectura —por ejemplo `/plugins`, **fuera de `/data` y del espacio de trabajo**— y define `IARK_CONFIG=/plugins/iark.config.json` en el servicio `iark` del compose (`volumes:` y `environment:`; `deploy/docker-compose.yml` no lo trae). Cargar un módulo ejecuta su código con los permisos del contenedor: instala solo módulos de autores en los que confías. Salen en `/api/modules`, en el manifiesto y en la API (con la autenticación y los límites de siempre), pero **el sitio web no los muestra** y los hilos de cálculo cargan los mismos módulos (cada hilo consume algo más de memoria). Un plugin que no carga impide arrancar. Ver [Módulos de terceros](plugins.md).
- **Cálculo pesado, acotado.** Validar, ver, exportar, importar, comparar, pedir informes (`run`) y trazar (`/api/trace`) pueden tardar mucho con un diagrama grande: en una prueba nuestra, en una máquina compartida, exportar a SVG un diagrama de 300 contenedores y 600 relaciones tardó unos 90 s. Por eso ese cálculo ya no corre en el hilo que atiende las conexiones, sino en **hilos de trabajo** (`worker_threads`) del mismo proceso, con tres topes. Guardar proyectos no calcula distribuciones y no pasa por ahí. Mientras un cálculo largo corre, el inicio de sesión, los proyectos y el `HEALTHCHECK` siguen respondiendo.

  | Qué | Por omisión | Opción · variable |
  |---|---|---|
  | Hilos de trabajo (se crean al hacer falta) | `min(2, CPU − 1)`, al menos 1 | `--workers` · `IARK_WORKERS` (`0`: sin hilos, el cálculo vuelve al hilo principal y sin topes; solo para depurar) |
  | Tiempo máximo de cada operación, desde que un hilo la recibe | 30 s | `--compute-timeout` · `IARK_COMPUTE_TIMEOUT_MS` (milisegundos, o `30s`) |
  | Operaciones que esperan un hilo libre | 16 | `--compute-queue` · `IARK_COMPUTE_QUEUE` |
  | Cuerpo de cualquier petición | 5 MB (no se cambia) | — |

  Al agotarse el tiempo se **termina** el hilo (esté en el bucle que esté), la petición recibe `503` (`"code":"timeout"`) y el siguiente cálculo arranca en un hilo nuevo. Con todos los hilos ocupados y la cola llena, `503` al instante con `Retry-After` (`"code":"busy"`): no se acumulan peticiones en memoria (como mucho `IARK_COMPUTE_QUEUE` cuerpos de hasta 5 MB esperando, más los que se calculan). Si el cliente cuelga con la operación aún en cola, se descarta. Ojo con el reparto de recursos: cada hilo carga todos los módulos (unos 70 MB más en reposo en nuestra medición; calculando un diagrama de 121 contenedores y 240 relaciones el proceso llegó a unos 410 MB) y un diagrama enorme puede agotar la memoria del contenedor entero antes de que venza el tiempo; dimensiona `mem_limit` y `cpus` (el compose trae 768 MB y 1,5 CPU; con 2 CPU a la vista, `IARK_WORKERS` por omisión es 1) y sube los hilos solo si le das CPU. Los topes frenan el abuso, no lo evitan: quien tiene credencial todavía puede ocupar los hilos. `deploy/docker-compose.yml` no pasa estas variables al contenedor: para cambiarlas añade bajo `environment:` del servicio `iark` la que necesites (p. ej. `IARK_WORKERS: "${IARK_WORKERS:-}"`, y `IARK_COMPUTE_TIMEOUT_MS`, `IARK_COMPUTE_QUEUE` o `IARK_PUBLIC_COMPUTE` igual; vacío = el valor por omisión) y defínela en `deploy/.env`.
- **El cálculo exige credencial cuando hay inicio de sesión o tokens.** `POST /api/<módulo>/validate|views|export|import|diff`, `POST /api/<módulo>/run/<comando>` y `POST /api/trace` piden una sesión o un token válidos **de cualquier rol** (`401` sin ellos; el cuerpo ni se lee). Siguen públicos `/api/modules`, `/api/<módulo>/capabilities`, `/api/<módulo>/schema` y `/.well-known/iark.json`, que la federación descubre sin credencial. Sin inicio de sesión ni tokens (la demo de la imagen sin variables) todo queda abierto como siempre. Si necesitas el cálculo abierto a cualquiera con la autenticación puesta (un sitio que exporta sin que nadie inicie sesión), arranca con `IARK_PUBLIC_COMPUTE=1` o `--public-compute`: es una decisión tuya y cuesta CPU de tu máquina a quien llegue al puerto. `--tokens` ahora también protege el cálculo cuando no hay `--workspace`.
- **`run` no lee archivos del servidor.** Los comandos de módulo que leen o escriben en la máquina (hoy `platform icons --pack <archivo>`) solo existen en el CLI local: por HTTP, `POST /api/<módulo>/run/<comando>` rechaza esas opciones con `400` y el mismo mensaje exista o no el archivo.
- **Las copias de seguridad son cosa tuya** (paso 6; la base se copia con `iark accounts backup`, no con `tar`), y las cuotas por persona ([Cuotas de uso](cuentas-github.md#cuotas-de-uso)) son una estimación del servicio, no un tope duro del volumen: vigila el espacio libre.
- **No está probado con un certificado real de Caddy** ni en una plataforma concreta: las pruebas se hicieron con Docker, con un GitHub de mentira y con el HTTPS interno de Caddy sobre `localhost`.

Para repetir la prueba de la imagen: `npm run docker:smoke` (construye la imagen y la prueba con Docker y un GitHub de mentira; ver `scripts/docker-smoke-cuentas.ts`).
