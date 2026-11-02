# ECE en el repositorio `sc-arquitectura/iark`

[← Protocolo SDD](protocolo-sdd.md) · [Spec 000](specs/000-conexion-ece.md)

Julian indicó que la implementación del MCP ECE vive en GitHub en **`https://github.com/sc-arquitectura/iark`**. Esta nota registra el intento de acceso desde el entorno Cloud Agent del repositorio `juliancardonagaleano/diagrams` (rama `cursor/ece-mcp-iark-58e1`). No sustituye a `ece-capacidades.md`: ese archivo solo debe existir cuando ECE esté conectado en sesión y las herramientas se listen con llamadas reales.

## Estado del acceso (2 de noviembre de 2026, UTC)

| Intento | Salida |
|--------|--------|
| `gh repo clone sc-arquitectura/iark /tmp/iark` | `GraphQL: Could not resolve to a Repository with the name 'sc-arquitectura/iark'. (repository)` |
| `git clone git@github.com:sc-arquitectura/iark.git` | `remote: Repository not found.` |
| `git ls-remote https://github.com/sc-arquitectura/iark.git` | `remote: Repository not found.` |
| `gh api orgs/sc-arquitectura/repos` | `HTTP 404` — `Not Found` (la cuenta `cursor` del agente no ve la organización o el org no es público para este token) |
| `gh search repos --owner sc-arquitectura` | Sin resultados visibles |

`gh auth status` muestra sesión activa como cuenta **`cursor`** (HTTPS). No hay paths locales del MCP ni commit hash que citar hasta que el clone funcione.

## Qué debe hacer Julian

1. Confirmar que el repositorio existe y que el nombre es exactamente `sc-arquitectura/iark` (privado u org distinta).
2. Conceder a la cuenta de GitHub que usa el Cloud Agent (`cursor` o la service account del equipo) permiso de lectura sobre ese repo u org `sc-arquitectura`.
3. Volver a ejecutar la spec 000: clonar, localizar `mcp.json` / paquetes / README del MCP ECE, copiar solo lo necesario a `diagrams` (por ejemplo `.cursor/mcp.json` o documentación alineada), y conectar el servidor en Cursor para catalogar herramientas en `docs/arquitectura/ece-capacidades.md`.

## Integración prevista en `diagrams` (sin inventar el contrato)

Cuando el clone sea posible, la rama de trabajo es **`cursor/ece-mcp-iark-58e1`** (base `master`). Se copiará fielmente desde iark lo mínimo para usar el MCP desde este repo; no se modificarán `src/`, `packages/`, `schema/` ni `public/` salvo que el MCP deba vivir entero bajo `packages/` en iark.

Hasta entonces, **no hay** `.cursor/mcp.json` en `diagrams` porque la sesión no leyó la configuración real del repositorio fuente.
