# Despliegue de la nube de proyectos (servicio gestionado con GitHub)

Guía para quien **aloja** el servicio: dejar IArk en internet con «Iniciar sesión con GitHub», HTTPS y los datos en un disco que no se pierde. No hace falta ser experta en infraestructura: lo técnico ya viene en la imagen Docker y en [`deploy/`](../deploy/). Aquí está lo que tienes que hacer tú, en orden.

Cada paso dice quién lo hace:

- **Lo haces tú**: solo puede hacerlo la persona dueña del servicio (cuentas, dominio, contraseñas, contratar la máquina).
- **Ya está hecho**: viene en la imagen o en `deploy/`; no hay que tocarlo (se cuenta para que sepas qué hay).

## Lista de comprobación

Antes de empezar necesitas, **todo por tu cuenta**:

- [ ] **Un dominio o subdominio** que controles (por ejemplo `iark.tudominio.org`) y acceso a su DNS. Sin dominio no hay HTTPS, y sin HTTPS no hay inicio de sesión: GitHub y IArk exigen una dirección `https://` (solo `localhost` puede ser `http`).
- [ ] **Una máquina con Docker** (Docker Engine con Compose v2: se usa el comando `docker compose`, con espacio) con IP pública y los puertos 80 y 443 abiertos; o una plataforma de contenedores con disco persistente (paso 2, alternativa).
- [ ] **Una cuenta de GitHub**, para registrar la OAuth App y ser la administradora. Quien entre al servicio también necesita la suya.
- [ ] **Tu identificador numérico de GitHub** (paso 4).
- [ ] **Un sitio fuera de esa máquina** donde guardar copias de seguridad (paso 6).

Lo que ya está hecho, para que sepas qué te ahorras:

| Ya está hecho (imagen y `deploy/`) | Lo haces tú |
|---|---|
| La imagen corre como usuario `node` (no root), con la carpeta de datos `/data` lista | Elegir la dirección y crear el registro DNS |
| `HEALTHCHECK` que sigue sirviendo con el inicio de sesión activo | Registrar la OAuth App en GitHub y copiar su Client ID y su Client secret |
| Caddy con HTTPS automático y renovación de certificados | Contratar la máquina, abrir los puertos 80 y 443 |
| `IARK_TRUST_PROXY=true` (`--trust-proxy`), sin publicar el puerto de IArk, sistema de archivos de solo lectura, sin capacidades, reinicio automático, límites de memoria y de CPU, registros con rotación | Rellenar `deploy/.env` y guardar el secreto en `deploy/secrets/` |
| Volumen `iark-data` para proyectos y cuentas; el secreto como Docker secret | `docker compose up -d --build`, las copias de seguridad y las actualizaciones |
| Se niega a arrancar sin autenticación si hay proyectos (nunca los deja abiertos) | Decidir quién entra (`invite` u `open`) |

**La dirección pública** es la que elijas aquí, una sola vez, y se repite en todas partes: `https://iark.tudominio.org` (sin barra final ni ruta). En esta guía, `iark.tudominio.org` es tu dominio.

---

## 1. Registrar la OAuth App en GitHub — *Lo haces tú*

La OAuth App es lo que permite a GitHub decir «esta persona es @fulana» a tu servicio, sin pedirle ningún permiso sobre sus repositorios.

1. En GitHub, con tu cuenta: foto de perfil → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**. (Puede ser de tu cuenta o de una organización tuya.)
2. Rellena el formulario con estos valores:

| Campo | Valor |
|---|---|
| **Application name** | `IArk - DIAgrams` (o el que quieras: es lo que verá la gente en la pantalla de GitHub al entrar) |
| **Homepage URL** | `https://iark.tudominio.org` (la dirección pública) |
| **Application description** | opcional |
| **Authorization callback URL** | **`https://iark.tudominio.org/api/auth/github/callback`** |
| **Enable Device Flow** | **déjalo desmarcado**: no hace falta |

   La *callback URL* tiene que ser **exactamente** esa: `https`, tu dominio, el camino `/api/auth/github/callback`, sin barra final ni espacios. Es lo primero que se revisa cuando algo falla (ver el paso 8). IArk la imprime al arrancar (`callback https://…`) para que la compares.
3. **Register application**. En la página de la aplicación copia el **Client ID**: es público y va en `deploy/.env` (`IARK_GITHUB_CLIENT_ID`).
4. **Generate a new client secret** y cópialo **en ese momento**: GitHub lo muestra una sola vez (si lo pierdes, genera otro y borra el anterior). Es un secreto: va **solo** en `deploy/secrets/github_client_secret` (paso 2); no en `.env`, no en git, no en un mensaje.

No cambies nada más de la aplicación. IArk no pide permisos a GitHub, lee tu perfil público una vez y revoca el token de GitHub en el acto: no conserva ningún acceso.

## 2. Elegir dónde alojar

### Opción recomendada: una VPS pequeña con Docker Compose y Caddy

*Ya está hecho*: `deploy/docker-compose.yml` levanta IArk y Caddy (HTTPS automático), con el volumen, el secreto y los límites. *Lo haces tú*:

1. **Contratar una VPS Linux** con IP pública (el proveedor que prefieras; compara precios y condiciones vigentes). Como referencia de tamaño, en las pruebas IArk usó unos 100 MB de memoria en reposo y unos 330 MB exportando un diagrama de 300 contenedores, y Caddy unos 15 MB: una máquina con 1 GB debería bastar para empezar (compruébalo con `docker stats`).
2. **Instalar Docker** con Compose v2 siguiendo la [guía oficial](https://docs.docker.com/engine/install/) de tu sistema.
3. **DNS**: crea un registro **A** de `iark.tudominio.org` con la IP de la máquina (y **AAAA** si la máquina tiene IPv6). Comprueba que ya resuelve antes de seguir: `dig +short iark.tudominio.org` (o `nslookup iark.tudominio.org`) debe devolver tu IP. Si arrancas Caddy con el DNS mal, no consigue el certificado y reintenta; esperar a que propague evita llegar a los límites de peticiones de las entidades de certificados.
4. **Cortafuegos**: abre **80/tcp y 443/tcp** (en el panel del proveedor y, si lo usas, en `ufw`/`firewalld`). El 80 lo necesita Caddy para conseguir el certificado y para redirigir a HTTPS. IArk **no** publica su puerto (solo Caddy llega a él, por la red interna de Docker). Si usas `ufw`, ten en cuenta que Docker publica puertos saltándose sus reglas: por eso el compose publica únicamente 80 y 443.
5. **Traer el código y configurarlo**:

```bash
git clone https://github.com/juliancardonagaleano/iark-diagrams.git
cd iark-diagrams/deploy
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

1. **Una sola instancia (réplica)**, siempre. Las cuentas están en un archivo con un único escritor: con dos copias sobre el mismo disco, cada una pisaría los cambios de la otra. Desactiva el escalado automático y cualquier despliegue que arranque la versión nueva antes de parar la vieja.
2. **Un disco persistente montado en `/data`**, para que `IARK_WORKSPACE=/data/workspace` e `IARK_ACCOUNTS=/data/accounts.json` sobrevivan a cada despliegue. Sin disco, se pierde todo al actualizar.
3. **HTTPS en la dirección pública**: la que te dé la plataforma o tu dominio. Esa misma es `IARK_PUBLIC_URL` y la base de la *callback URL* de la OAuth App (paso 1).
4. **Construir la imagen desde el `Dockerfile` del repositorio** (no hay una imagen publicada en un registro). El puerto sale de la variable `PORT` (8787 por omisión): si la plataforma la define, funciona sin más; si no, apunta su puerto interno al 8787. La comprobación de salud puede ser `GET /api/modules` (público).
5. **Detrás de un proxy**: `IARK_TRUST_PROXY=true` (equivale a `--trust-proxy`) y, si lo necesitas, `IARK_CORS=https://juliancardonagaleano.github.io` (equivale a `--cors`; ver el apartado 5). `IARK_TRUST_PROXY` solo vale si la plataforma deja la dirección real del cliente en la **última** entrada de `X-Forwarded-For`; si no lo tienes claro (Fly.io, por ejemplo, documenta la dirección del cliente en otra cabecera, `Fly-Client-IP`, que IArk no lee), déjalo sin activar: todas las personas compartirán entonces el freno de intentos fallidos. Si la plataforma solo deja poner argumentos, `--trust-proxy` y `--cors=…` valen igual: deben añadirse a los de la imagen (como los que van detrás del nombre de la imagen en `docker run`), no sustituir su `ENTRYPOINT`.
6. **Variables de entorno** (el Client secret, en el almacén de secretos de la plataforma, no en un archivo del repositorio):

| Variable | Valor |
|---|---|
| `IARK_WORKSPACE` | `/data/workspace` |
| `IARK_ACCOUNTS` | `/data/accounts.json` |
| `IARK_PUBLIC_URL` | `https://…` (la dirección pública, sin barra final) |
| `IARK_GITHUB_CLIENT_ID` | el Client ID de la OAuth App |
| `IARK_GITHUB_CLIENT_SECRET` | el Client secret (o `IARK_GITHUB_CLIENT_SECRET_FILE` con la ruta de un archivo de secretos) |
| `IARK_ADMINS` | tu identificador numérico de GitHub (paso 4) |
| `IARK_SIGNUP` | `invite` (o `open`; paso 4) |
| `IARK_SESSION_DAYS`, `IARK_MAX_PROJECTS` | opcionales (30 días y 25 proyectos por omisión) |

7. **Quién es el dueño del disco.** La imagen corre como `node` (1000:1000). Si la plataforma monta el disco con dueño root y no te deja cambiarlo, IArk no podrá escribir y no arrancará, con `No se pudo escribir el archivo de cuentas «/data/accounts.json» (EACCES)`. Último recurso: construir la imagen para correr como root con `--build-arg IARK_RUN_AS=root` (el campo de «build args» de la plataforma). Probé el servicio como root sobre un disco de root; no probé el argumento en ninguna plataforma.
8. Si la plataforma apaga el servicio por inactividad, la primera visita tardará en responder; las sesiones no se pierden (están en el disco).

## 3. Primer arranque y cómo comprobar que funciona — *Lo haces tú*

```bash
docker compose ps                  # iark: «Up … (healthy)»; caddy: «Up»
docker compose logs iark           # lo que IArk cuenta al arrancar (abajo)
docker compose logs caddy          # busca «certificate obtained successfully»
```

El registro de `iark` debe parecerse a esto (con tus valores):

```
IArk - DIAgrams escuchando en http://0.0.0.0:8787 (sitio: dist/app)
  manifiesto: /.well-known/iark.json · módulos: /api/modules
  espacio de trabajo: /data/workspace · proyectos: /api/projects
  inicio de sesión: GitHub (Iv1.…) · callback https://iark.tudominio.org/api/auth/github/callback · cuentas: /data/accounts.json (0) · entrada: solo por invitación · administradores: 1
  detrás de un proxy de confianza (--trust-proxy): el HTTPS lo pone el proxy, compruebe que la dirección pública es https; …
```

La última línea es un recordatorio, no un fallo: IArk habla HTTP y Caddy le pone el HTTPS por delante (sin `IARK_TRUST_PROXY` saldría un «aviso: este servicio no habla TLS»). Lo que sí debes comparar es la `callback` con la de la OAuth App.

Desde cualquier equipo:

```bash
curl https://iark.tudominio.org/api/auth/providers     # {"providers":[{"id":"github","label":"GitHub"}],"tokens":false,"signup":"invite"}
curl https://iark.tudominio.org/.well-known/iark.json  # el manifiesto: debe traer "projects": "../api/projects" y "projectsAuth": "bearer"
curl -i https://iark.tudominio.org/api/projects        # 401 sin sesión: es lo correcto; los proyectos no son públicos
curl -sI http://iark.tudominio.org/ | head -1          # 308: el puerto 80 redirige a HTTPS
```

Si `providers` sale vacío (`"providers":[]`), IArk arrancó sin inicio de sesión: revisa `.env` y el secreto. El `HEALTHCHECK` de la imagen consulta `/api/modules` (público) cada 30 s; `docker inspect --format '{{.State.Health.Status}}' iark-iark-1` dice `healthy`.

## 4. Entrar por primera vez como administradora — *Lo haces tú*

**Tu identificador numérico.** `IARK_ADMINS` admite nombres de usuario de GitHub y números; **usa el número**. El nombre de usuario puede cambiarse y pasar a otra persona (y entonces administraría tu servicio); el identificador no cambia nunca.

```bash
curl https://api.github.com/users/TU_USUARIO     # busca la línea "id": 583231,
```

Ponlo en `deploy/.env` (`IARK_ADMINS=583231`; varias personas, separadas por comas) y aplica con `docker compose up -d`.

**Entrar.** Abre `https://iark.tudominio.org/modulos.html` (banco de trabajo: **Proyectos…**) o `https://iark.tudominio.org/` (editor C4: **Archivo ▸ Proyectos…**) y ve a **Dónde se guardan ▸ Conectar a un servidor…** (README, «Guardar en la nube (servidor propio) desde el navegador»). La dirección aparece ya escrita cuando el sitio lo sirve la propia instancia; pulsa **Iniciar sesión con GitHub**, acepta en GitHub y vuelves con tu ficha (@usuario, rol `admin`).

**Quién puede entrar (`IARK_SIGNUP`):**

| Valor | Quién entra | Cuándo conviene |
|---|---|---|
| `invite` (por omisión) | Solo las personas de `IARK_ADMINS` y las que invites por su nombre de GitHub | Un equipo conocido. Recomendado |
| `open` | Cualquiera con cuenta de GitHub, como miembro (puede crear hasta `IARK_MAX_PROJECTS` proyectos) | Una comunidad abierta. IArk no impone una cuota de disco por persona: vigila el espacio libre |

Invitar es compartir un proyecto con un nombre de usuario de GitHub, o invitarlo a la instancia (README, «Compartir proyectos» y «Administrar las cuentas de la instancia»). Quien no esté invitado vuelve a la página con `#iark_error=not_invited` (el sitio lo explica). Cambiar `IARK_SIGNUP`: edita `.env` y `docker compose up -d` (recrea el contenedor; las sesiones se conservan, están en el disco).

## 5. El sitio de GitHub Pages también puede usar esta instancia — *Lo haces tú*

El sitio ya publicado (`https://juliancardonagaleano.github.io/iark-diagrams/`) puede guardar sus proyectos en tu instancia: en `deploy/.env` pon

```
IARK_CORS=https://juliancardonagaleano.github.io
```

y `docker compose up -d`. Es el **origen** (esquema y dominio, **sin ruta ni barra final**); admite varios, separados por comas. Eso hace dos cosas: el navegador deja que esa página llame a tu API (CORS, con `Authorization`), y tras entrar con GitHub se **vuelve** a esa página (IArk solo devuelve a su propio sitio o a un origen de `IARK_CORS`; nunca a `*`).

- La **dirección pública sigue siendo la de la instancia** (`IARK_DOMAIN`, la *callback URL* de la OAuth App): GitHub devuelve a tu servicio, que redirige después al sitio de Pages. No pongas `github.io` en la OAuth App.
- En *Dónde se guardan* de ese sitio escribe la dirección de la instancia (`https://iark.tudominio.org`).
- **Cuándo conviene**: si la gente ya usa el sitio de Pages y quieres darle la nube sin cambiar de dirección. **Si no, usa directamente el sitio de tu instancia** (`https://iark.tudominio.org/`): ya sirve el editor y el banco de trabajo, con el mismo origen y sin CORS. Los proyectos que alguien tenga guardados **en el navegador** pertenecen al origen donde los creó: no los verá en el sitio de otra dirección (cópialos a la nube antes desde *Copiar a…*).

## 6. Copias de seguridad y restaurar — *Lo haces tú*

**Qué copiar: `/data` entero**, el volumen `iark-data`: `accounts.json` (cuentas, sesiones y quién pertenece a qué proyecto) y `workspace/` (los proyectos). Guarda además `deploy/.env` (no es secreto). El Client secret no está en el volumen: si lo pierdes, genera otro en GitHub. Los certificados de Caddy no hace falta copiarlos: se vuelven a pedir.

**Copia, con el servicio en marcha** (un contenedor aparte lee el volumen en solo lectura y escribe un `.tar.gz` en la carpeta actual):

```bash
docker run --rm --user 0 -v iark-data:/data:ro -v "$PWD":/backup --entrypoint tar iark-diagrams \
  czf /backup/iark-data-$(date +%F).tar.gz -C /data .
```

Cada archivo se guarda de forma atómica, así que la copia es coherente archivo a archivo; si prefieres una copia exacta, **para el servicio un momento**: `docker compose stop iark`, la copia de arriba y `docker compose start iark`. En ambos casos, **llévate el `.tar.gz` fuera de la máquina** (otro equipo, un almacenamiento de objetos…) y repítelo con la frecuencia que te dé tranquilidad: lo que se escriba después de la última copia se pierde si se pierde el disco.

**Restaurar** (en esta máquina o en otra con el repositorio clonado, `deploy/.env` y el secreto puestos y la imagen construida con `docker compose build`), **en un volumen vacío**:

```bash
docker compose down                       # no borra el volumen
docker volume rm iark-data                # solo si vas a sustituir lo que haya: BORRA los datos actuales
docker volume create iark-data
docker run --rm --user 0 -v iark-data:/data -v "$PWD":/backup:ro --entrypoint sh iark-diagrams \
  -c 'tar xzf /backup/iark-data-2026-10-06.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose up -d
```

Las sesiones de la copia siguen valiendo; las abiertas después de la copia caducan (401: se vuelve a entrar con GitHub).

## 7. Actualizar la imagen — *Lo haces tú*

```bash
cd iark-diagrams && git pull
cd deploy
docker compose build --pull        # reconstruye IArk con la última base de Node
docker compose pull caddy          # y trae la última versión de Caddy
docker compose up -d               # recrea solo lo que cambió
```

Haz una copia antes (paso 6). Lo único que sobrevive entre una versión y otra es el volumen: las cuentas, las sesiones y los proyectos siguen donde estaban (probado: con un contenedor nuevo sobre el mismo volumen, la sesión y el proyecto siguen). El corte es de unos segundos. Para volver atrás: `git checkout <commit anterior>` y `docker compose up -d --build`. `docker image prune` libera el espacio de las imágenes viejas.

Rotar el Client secret: genera otro en GitHub, cámbialo en `secrets/github_client_secret` (con `chown`/`chmod` como en el paso 2) y `docker compose restart iark`; después borra el viejo en GitHub.

## 8. Solución de problemas

Siempre empieza por `docker compose ps` y `docker compose logs iark` (y `caddy`).

| Qué ves | Qué pasa y cómo se arregla |
|---|---|
| **GitHub muestra `redirect_uri_mismatch`** («The redirect_uri MUST match the registered callback URL…») | La *Authorization callback URL* de la OAuth App no es exactamente `<IARK_PUBLIC_URL>/api/auth/github/callback`: `http` en vez de `https`, otra dirección (`www.`, otro subdominio, un puerto), una barra al final. Compárala letra a letra con la línea `callback …` del registro de arranque y corrige la OAuth App |
| Una página 404 de GitHub al pulsar «Iniciar sesión» | Suele ser un Client ID mal copiado (`IARK_GITHUB_CLIENT_ID`) |
| Vuelves a la página con **`#iark_error=not_invited`** | Esa persona no es administradora ni está invitada y `IARK_SIGNUP=invite`. Invítala (paso 4) o usa `open`. Otros motivos: `access_denied` (canceló en GitHub), `disabled` (cuenta desactivada), `github_unavailable` (no se llegó a GitHub) |
| Vuelves con **`#iark_error=login_failed`** | Casi siempre el **Client secret** no es el de esa OAuth App (o se regeneró) o el Client ID es otro. El registro lo dice (`docker compose logs iark`: «inicio de sesión: GitHub no lo aceptó (rejected)…»; nunca incluye el secreto): revisa el secreto, `docker compose restart iark` y prueba otra vez |
| **401** `Hace falta un token válido: envíe la cabecera «Authorization: Bearer <token>»` (`"code":"unauthorized"`) | La sesión caducó (30 días por omisión, `IARK_SESSION_DAYS`), se cerró o la cuenta se desactivó; también tras restaurar una copia anterior a esa sesión. Se vuelve a entrar con GitHub |
| **429** `Demasiados intentos fallidos desde esta dirección: espere N s…` o `Demasiados intentos de iniciar sesión desde esta dirección: espere unos minutos.` | El freno de intentos (con cabecera `Retry-After`; vive en memoria y se borra al reiniciar). Si salta a **todas** las personas a la vez, IArk no ve la dirección real: falta `IARK_TRUST_PROXY=true` (el compose lo trae) o el proxy no anota `X-Forwarded-For` |
| **`docker compose up` dice** `required variable IARK_ADMINS is missing a value: Falta …` | Falta esa variable en `deploy/.env` (también `IARK_DOMAIN` e `IARK_GITHUB_CLIENT_ID`) |
| `external volume "iark-data" not found` | Falta crear el volumen: `docker volume create iark-data` |
| `bind source path does not exist: …/secrets/github_client_secret` | Falta el archivo del secreto (paso 2.6) |
| `dependency failed to start: container iark-iark-1 is unhealthy` | **IArk no arranca**: mira `docker compose logs iark` (siguientes filas) |
| El registro dice `El inicio de sesión con GitHub necesita todo esto y falta: …` | Falta alguna variable (la lista dice cuál). Todo va por `deploy/.env` y el secreto |
| El registro dice `Con un espacio de trabajo, escuchar en 0.0.0.0 sin autenticación … el servicio no arranca así` | Hay `IARK_WORKSPACE` y no hay cuentas activas: es la red de seguridad. En otra plataforma, define las variables de GitHub |
| `No se pudo leer el secreto de GitHub de «/run/secrets/github_client_secret» (EACCES)` | El usuario del contenedor (1000) no puede leer el archivo: `chown 1000:1000 secrets/github_client_secret && chmod 400 …`. Si dice `está vacío`, el archivo no tiene el secreto |
| `No se pudo escribir (o leer) el archivo de cuentas «/data/accounts.json» (EACCES)` | `/data` no es de 1000:1000: pasa con un bind mount del anfitrión (`chown 1000:1000 <carpeta>`) o un disco de plataforma montado como root (paso 2, alternativa, punto 7). Con un volumen con nombre no ocurre |
| `Con --signup invite hace falta al menos un administrador…` | Falta `IARK_ADMINS` |
| `La dirección pública debe ser https (solo localhost puede ser http)…` | `IARK_PUBLIC_URL` (o `IARK_DOMAIN`) mal escrito |
| El navegador avisa de un **certificado** no válido o no carga por HTTPS | Caddy no consiguió el certificado: `docker compose logs caddy`. Casi siempre, el DNS no apunta aún a la máquina o los puertos 80/443 están cerrados (en el panel del proveedor también). Corrige y `docker compose restart caddy` |
| **Contenido mixto** (la consola del navegador bloquea una petición `http://`) | Una página `https` no puede llamar a una dirección `http`: escribe la dirección de la instancia con `https://` en *Dónde se guardan* |
| **CORS** (`blocked by CORS policy`) desde el sitio de Pages u otra página | El origen no está en `IARK_CORS`: debe ser exacto (`https://juliancardonagaleano.github.io`, sin ruta ni barra final). Compruébalo: `curl -i -X OPTIONS https://iark.tudominio.org/api/projects -H 'Origin: https://juliancardonagaleano.github.io' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization'` debe dar `204` y `Access-Control-Allow-Origin`. Tras cambiar `.env`: `docker compose up -d` |

## 9. Límites honestos

- **Una sola réplica.** Las cuentas viven en un archivo JSON con un único escritor (el propio servicio): no se editan con el servicio en marcha ni se comparten entre varias copias. No hay alta disponibilidad: si la máquina cae, el servicio cae hasta que vuelva. El archivo se reescribe entero en cada cambio: está pensado para equipos pequeños o medianos.
- **Solo GitHub**: no hay SSO de empresa (SAML, OIDC) ni otros proveedores. Con GitHub Enterprise Server se puede apuntar `IARK_GITHUB_URL` y `IARK_GITHUB_API_URL` a su servidor.
- **Sin permisos por organización o equipo de GitHub.** IArk no pide permisos, así que no lee a qué organizaciones perteneces: entra quien tiene cuenta (según `invite` u `open`) y los permisos se reparten por proyecto, por invitación.
- **El token de sesión vive en el navegador** (en la pestaña, o en el equipo si se marca «Mantener la sesión en este equipo»): cualquier script que se ejecute en el sitio, una extensión o quien use ese equipo podría leerlo. Cierra la sesión en equipos ajenos; una cuenta desactivada pierde sus sesiones.
- **Sin registro de accesos ni de quién cambió qué**, y sin edición simultánea en tiempo real (README, «Guardar en la nube»).
- **Un diagrama muy grande bloquea el servicio mientras se calcula** (el cálculo de la distribución corre en el mismo proceso): en una prueba nuestra, en una máquina compartida, exportar a SVG con la API (`/api/<módulo>/export`) un diagrama de 300 contenedores y 600 relaciones tardó unos 90 s y dejó todo lo demás esperando. Guardar proyectos no calcula distribuciones.
- **Las copias de seguridad son cosa tuya** (paso 6), y el servicio no ofrece cuotas de disco por persona.
- **No está probado con un certificado real de Caddy** ni en una plataforma concreta: las pruebas se hicieron con Docker, con un GitHub de mentira y con el HTTPS interno de Caddy sobre `localhost`.

Para repetir la prueba de la imagen: `npm run docker:smoke` (construye la imagen y la prueba con Docker y un GitHub de mentira; ver `scripts/docker-smoke-cuentas.ts`).
