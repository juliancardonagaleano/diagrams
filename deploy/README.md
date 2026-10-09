# Despliegue de la nube de proyectos

Esta carpeta deja a DIAgrams listo para una máquina con Docker: `docker-compose.yml` (DIAgrams con inicio de sesión de GitHub + Caddy con HTTPS automático), `Caddyfile`, `.env.example` (toda la configuración, sin secretos) y `secrets/` (el secreto de la OAuth App, que git ignora).

**La guía, paso a paso, está en [`docs/despliegue-nube.md`](../docs/despliegue-nube.md)**: registrar la OAuth App en GitHub, elegir dónde alojar, el primer arranque, entrar como administrador, copias de seguridad, actualizar y solución de problemas.

**¿Sin máquina propia?** [`render.yaml`](render.yaml) es un Blueprint de Render para el servicio solo (sitio en GitHub Pages, datos en Supabase); la guía está en [`docs/despliegue-render-supabase.md`](../docs/despliegue-render-supabase.md). No se ha probado contra Render.

Resumen, desde esta carpeta, con la OAuth App ya creada y el dominio apuntando a la máquina:

```bash
cp .env.example .env                                              # rellena IARK_DOMAIN, IARK_GITHUB_CLIENT_ID e IARK_ADMINS
nano secrets/github_client_secret                                 # pega el Client secret de la OAuth App (solo eso) y guarda
chown 1000:1000 secrets/github_client_secret && chmod 400 secrets/github_client_secret    # con sudo si no eres root: que lo lea el usuario de DIAgrams
docker volume create iark-data                                    # una sola vez: los proyectos y las cuentas
docker compose up -d --build
docker compose logs iark                                          # debe decir «inicio de sesión: GitHub (…)»
```

Observabilidad (ver [`docs/observabilidad.md`](../docs/observabilidad.md)): el compose manda el registro de accesos de DIAgrams a la salida estándar (`docker compose logs iark`, con la rotación de Docker) y la auditoría —quién cambió qué, también lo denegado— a `/data/audit.jsonl` en el volumen. El `HEALTHCHECK` consulta `/healthz`; `/readyz` y `/metrics` (esta última apagada, con token) están para un monitor o Prometheus.

Las cuentas, las sesiones y a quién se compartió cada proyecto van en una **base SQLite** (`/data/accounts.db`, dentro del mismo volumen): transaccional, con modo WAL, pensada para un disco local. Dos cosas que cambian respecto a copiar archivos:

- **Copias de seguridad**: la base se copia con `docker compose exec iark node dist/cli/index.js accounts backup /data/accounts-<fecha>.db` (una copia coherente con el servicio en marcha), no con `tar` o `cp` de `accounts.db`. Los pasos completos, y la restauración, están en la guía (sección 6).
- **Si ya tenías el servicio con las cuentas en JSON** (`/data/accounts.json`), no hay que hacer nada a mano: el compose lleva `IARK_ACCOUNTS_IMPORT=/data/accounts.json` y la primera arrancada las importa a la base (sin tocar el JSON y con una copia de seguridad suya). Detalles y cómo volver atrás: sección 7 de la guía.
