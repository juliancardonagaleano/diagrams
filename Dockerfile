# IArk - DIAgrams como servicio: API por módulo, manifiesto de federación y el sitio (editor C4, banco de trabajo de
# módulos y shell) en un solo proceso Node, sin servidor web aparte.
#
# Tres usos (README: «Imagen Docker», «Servidor para varias personas» y «Servicio gestionado»; guía de despliegue en
# docs/despliegue-nube.md):
#
#  1. Demo, solo API y sitio, sin guardar nada ni pedir nada (es lo que hace la imagen sin variables):
#       docker build -t iark-diagrams .
#       docker run --rm -p 8787:8787 iark-diagrams
#       curl http://localhost:8787/api/modules
#     Para llamar a la API desde el navegador desde otro origen: añade --cors https://mi-app.example al comando.
#
#  2. Servidor autoalojable con un token por persona: IARK_WORKSPACE (carpeta de proyectos) e IARK_TOKENS (archivo de
#     tokens), en volúmenes. Los tokens se crean con `docker run --rm -v <carpeta>:/tokens --entrypoint node iark-diagrams
#     dist/cli/index.js auth create <nombre> --role admin --tokens /tokens/tokens.json`.
#
#  3. Servicio gestionado con inicio de sesión de GitHub (`iark serve --accounts`): un volumen en /data con los proyectos
#     (IARK_WORKSPACE=/data/workspace) y las cuentas (IARK_ACCOUNTS=/data/accounts.json), la OAuth App por IARK_GITHUB_CLIENT_ID
#     e IARK_GITHUB_CLIENT_SECRET_FILE (Docker secrets) o IARK_GITHUB_CLIENT_SECRET, IARK_PUBLIC_URL, IARK_ADMINS…, y un proxy
#     con HTTPS delante (con `--trust-proxy`). El `deploy/docker-compose.yml` lo deja montado con Caddy y
#     docs/despliegue-nube.md lo explica paso a paso.
#
# Esta imagen NO fija IARK_WORKSPACE a propósito: escucha en 0.0.0.0 y, con un espacio de trabajo y sin autenticación (--tokens
# o --accounts), `iark serve` se niega a arrancar. Es la red de seguridad: un contenedor sin configurar nunca deja los proyectos
# abiertos.
#
# Datos: todo lo que el servicio escribe va a /data, una carpeta vacía del usuario `node` (uid y gid 1000), así que basta
# montar ahí un volumen. Un volumen con nombre (`-v iark-data:/data`) hereda esa carpeta, dueño incluido, la primera vez que se
# usa; un bind mount de una carpeta del anfitrión (`-v $PWD/datos:/data`) no hereda nada: su dueño debe ser 1000:1000
# (`chown 1000:1000 datos`). La imagen no declara `VOLUME`: así la demo no deja volúmenes anónimos tras cada `docker run`.
# Algunas plataformas montan el disco persistente con dueño root y no dejan cambiarlo: como último recurso, la imagen se construye
# para correr como root con `--build-arg IARK_RUN_AS=root` (el contenedor sigue aislado; solo cambia el usuario de dentro).
#
# El puerto de dentro sale de la variable PORT (8787 por defecto) y lo usan igual el servidor y el HEALTHCHECK:
# para cambiarlo, `-e PORT=9000` (y publícalo con `-p 9000:9000`), no `--port`.
FROM node:22-alpine AS build
WORKDIR /app
# Los workspaces (packages/*) deben existir antes de `npm ci`.
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
COPY . .
# Compila la biblioteca, el CLI (dist/cli) y el sitio (dist/app), y deja solo las dependencias de producción: las del
# frontend (react, Semi UI, xyflow…) son devDependencies porque Vite ya las empaqueta en dist/app.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/cli ./dist/cli
COPY --from=build /app/dist/app ./dist/app
# La carpeta de datos del servicio gestionado, escribible por `node` (arriba: cómo la heredan los volúmenes).
RUN mkdir /data && chown node:node /data
ARG IARK_RUN_AS=node
USER ${IARK_RUN_AS}
EXPOSE 8787
# /api/modules es público (no pide sesión ni token) y no toca el disco: responde igual con la autenticación activada.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/api/modules" >/dev/null || exit 1
# `sh -c` solo expande $PORT; `exec` deja a node como proceso 1 (recibe SIGTERM) y "$@" añade los argumentos de `docker run`.
ENTRYPOINT ["sh", "-c", "exec node dist/cli/index.js serve --host 0.0.0.0 --port \"${PORT:-8787}\" --static dist/app \"$@\"", "iark"]
