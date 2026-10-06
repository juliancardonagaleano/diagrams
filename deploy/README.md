# Despliegue de la nube de proyectos

Esta carpeta deja a IArk listo para una máquina con Docker: `docker-compose.yml` (IArk con inicio de sesión de GitHub + Caddy con HTTPS automático), `Caddyfile`, `.env.example` (toda la configuración, sin secretos) y `secrets/` (el secreto de la OAuth App, que git ignora).

**La guía, paso a paso, está en [`docs/despliegue-nube.md`](../docs/despliegue-nube.md)**: registrar la OAuth App en GitHub, elegir dónde alojar, el primer arranque, entrar como administrador, copias de seguridad, actualizar y solución de problemas.

Resumen, desde esta carpeta, con la OAuth App ya creada y el dominio apuntando a la máquina:

```bash
cp .env.example .env                                              # rellena IARK_DOMAIN, IARK_GITHUB_CLIENT_ID e IARK_ADMINS
nano secrets/github_client_secret                                 # pega el Client secret de la OAuth App (solo eso) y guarda
chown 1000:1000 secrets/github_client_secret && chmod 400 secrets/github_client_secret    # con sudo si no eres root: que lo lea el usuario de IArk
docker volume create iark-data                                    # una sola vez: los proyectos y las cuentas
docker compose up -d --build
docker compose logs iark                                          # debe decir «inicio de sesión: GitHub (…)»
```
