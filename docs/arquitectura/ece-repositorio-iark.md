# ECE en el repositorio `sc-arquitectura/iark`

[← Protocolo SDD](protocolo-sdd.md) · [Spec 000](specs/000-conexion-ece.md)

Julian confirmó que la implementación del MCP ECE vive en GitHub en **`https://github.com/sc-arquitectura/iark.git`** (slug `sc-arquitectura/iark`). Esta nota registra los intentos de acceso desde el entorno Cloud Agent del repositorio `juliancardonagaleano/diagrams` (rama `cursor/ece-mcp-iark-58e1`). No sustituye a `ece-capacidades.md`: ese archivo solo debe existir cuando ECE esté conectado en sesión y las herramientas se listen con llamadas reales.

## Estado del acceso (2 de noviembre de 2026, UTC)

### Sesión inicial (antes de confirmar la URL)

| Intento | Salida |
|--------|--------|
| `gh repo clone sc-arquitectura/iark /tmp/iark` | `GraphQL: Could not resolve to a Repository with the name 'sc-arquitectura/iark'. (repository)` |
| `git clone git@github.com:sc-arquitectura/iark.git` | `remote: Repository not found.` |
| `git ls-remote https://github.com/sc-arquitectura/iark.git` | `remote: Repository not found.` |
| `gh api orgs/sc-arquitectura/repos` | `HTTP 404` — `Not Found` (la cuenta `cursor` del agente no ve la organización o el org no es público para este token) |
| `gh search repos --owner sc-arquitectura` | Sin resultados visibles |

### Reintento tras URL confirmada por Julian (misma fecha, ~18:53 UTC)

| Intento | Salida |
|--------|--------|
| `git clone https://github.com/sc-arquitectura/iark.git /tmp/iark-sc-arquitectura` | `remote: Repository not found.` (exit 128) |
| `gh repo clone sc-arquitectura/iark /tmp/iark-sc-arquitectura-gh` | `GraphQL: Could not resolve to a Repository with the name 'sc-arquitectura/iark'. (repository)` |
| `gh api repos/sc-arquitectura/iark` | `HTTP 404` — `Not Found` |
| `gh search repos iark org:sc-arquitectura` | Sin resultados visibles para la cuenta del agente |

`gh auth status` muestra sesión activa como cuenta **`cursor`** (HTTPS). El nombre del repo ya no está en duda; el bloqueo es **permiso de lectura** (repo u org privados). No hay paths locales del MCP (`mcp.json`, `.cursor/`, `packages/*mcp*`, README ECE) ni commit hash que citar hasta que el clone funcione.

## Qué debe hacer Julian

1. ~~Confirmar que el repositorio existe y que el nombre es exactamente `sc-arquitectura/iark`~~ — **hecho**: URL `https://github.com/sc-arquitectura/iark.git`.
2. Conceder a la cuenta de GitHub que usa el Cloud Agent (`cursor` o la service account del equipo) permiso de lectura sobre ese repo u org `sc-arquitectura`.
3. Volver a ejecutar la spec 000: clonar, localizar `mcp.json` / paquetes / README del MCP ECE, copiar solo lo necesario a `diagrams` (por ejemplo `.cursor/mcp.json` o documentación alineada), y conectar el servidor en Cursor para catalogar herramientas en `docs/arquitectura/ece-capacidades.md`.

## Integración prevista en `diagrams` (sin inventar el contrato)

Cuando el clone sea posible, la rama de trabajo es **`cursor/ece-mcp-iark-58e1`** (base `master`). Se copiará fielmente desde iark lo mínimo para usar el MCP desde este repo; no se modificarán `src/`, `packages/`, `schema/` ni `public/` salvo que el MCP deba vivir entero bajo `packages/` en iark.

Hasta entonces, **no hay** `.cursor/mcp.json` en `diagrams` porque la sesión no leyó la configuración real del repositorio fuente.
