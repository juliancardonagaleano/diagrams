# ECE: configuración entregada, no el clone de iark

[← Protocolo SDD](protocolo-sdd.md) · [Spec 000](specs/000-conexion-ece.md) · [Catálogo](ece-capacidades.md)

Julian confirmó que la implementación del MCP ECE vive en **`https://github.com/sc-arquitectura/iark.git`**. El Cloud Agent sigue sin poder clonar ese repo. La fuente de lo que hay en `diagrams` no es un commit de iark: son tres archivos que Julian entregó en la sesión del 2 de noviembre de 2026.

## Arranque

El cliente lanza un proceso local y habla con él por **stdio**. No hay transporte HTTP en la configuración del cliente. El HTTP lo abre el puente, hacia el servidor, con la URL que está en el entorno.

Entrada que trajo el archivo de OpenCode (`opencode.json`, servidor `ece-mcp`):

```json
{
  "type": "local",
  "command": ["python3", "scripts/mcp_ece.py"],
  "timeout": 20000,
  "_sdd_kit": true
}
```

`type: local` es el proceso stdio de OpenCode. `timeout` es del cliente (20000 ms), no un argumento del script. Ese archivo también define otros servidores (`pce-mcp`, `gitnexus`) y agentes que este repo no copia.

En Cursor el mismo arranque está en [`.cursor/mcp.json`](../../.cursor/mcp.json): comando `python3`, argumento `scripts/mcp_ece.py`, nombre `ece-mcp`. Las variables van como `${env:ECE_MCP_API_KEY}` y `${env:ECE_MCP_URL}`. No hay valores en git.

Secuencia del proceso:

1. `scripts/mcp_ece.py` lee la clave y hace `exec` de `scripts/mcp-ece.py` con el mismo intérprete. La clave canónica es `ECE_MCP_API_KEY`. Si ese nombre no está en el entorno, prueba `.env` en la raíz y, si tampoco, el alias `PCE_MCP_API_KEY`. Una `ECE_MCP_API_KEY` presente pero vacía no cae al alias. `--check-credential` solo imprime `credential: present` o `credential: absent`.
2. `scripts/mcp-ece.py` es el puente stdio → HTTP. Exige `ECE_MCP_URL` (alias de lectura `PCE_MCP_URL`, misma regla de vacío). No hay host por defecto: si la URL falta, sale con código 2. Si la clave falta, sale con código 2.
3. Hacia el cliente, el puente acepta framing `Content-Length` o NDJSON. Hacia el servidor, hace `POST` con `Content-Type: application/json` y `Accept: application/json, text/event-stream`. Si la clave empieza por `eyJ`, manda `Authorization: Bearer`; si no, `X-API-Key`.
4. La caché local es opcional (`MCP_PCE_CACHE_PATH`, `MCP_PCE_CACHE_TTL_SECS`, `MCP_PCE_CACHE_SIM_THRESHOLD`). El certificado de cliente, si hace falta, sale de `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` o `REQUESTS_CA_BUNDLE`.

## Variables

Comprobado en el entorno del Cloud Agent el 2 de noviembre de 2026. Solo nombres y presencia. No hay `.env` en el repo (`.gitignore` ya ignora `.env`).

| Nombre | Papel | Presencia |
|---|---|---|
| `ECE_MCP_API_KEY` | clave; la exige el launcher y el puente | presente, no vacía |
| `ECE_MCP_URL` | URL del POST; la exige el puente | presente, no vacía; esquema `https`; sin userinfo |
| `PCE_MCP_API_KEY` | alias de lectura de la clave | ausente |
| `PCE_MCP_URL` | alias de lectura de la URL | ausente |
| `NODE_EXTRA_CA_CERTS` | bundle CA opcional | ausente |
| `SSL_CERT_FILE` | bundle CA opcional | ausente |
| `REQUESTS_CA_BUNDLE` | bundle CA opcional | ausente |
| `MCP_PCE_CACHE_PATH` | ruta de la caché | ausente en el entorno; la prueba de la spec 000 la fijó aparte |
| `MCP_PCE_CACHE_TTL_SECS` | TTL de la caché | ausente |
| `MCP_PCE_CACHE_SIM_THRESHOLD` | umbral L2 de la caché | ausente |

La clave de este entorno no empieza por `eyJ`, así que el puente usa `X-API-Key`. El stderr de la prueba no imprimió `auth: Bearer JWT`.

## Archivos copiados

Copia fiel (mismo SHA-256 que la entrega). El launcher busca al puente como hermano en `scripts/`, que es la ruta del comando.

| En el repo | Entrega de Julian | SHA-256 |
|---|---|---|
| `scripts/mcp_ece.py` | `mcp_ece_6322.py` | `cd83f7939bba6985a1f3b267b90b7a1c0a64288b558bc986837e06a8d6d192d0` |
| `scripts/mcp-ece.py` | `mcp-ece_1a79.py` | `397b51779d80ba4726c616bfe02227bd5b5db516f8bc2c622e65127cb88e910e` |

No hay commit de `sc-arquitectura/iark` que citar: el clone sigue bloqueado.

## Clone de iark (sigue sin acceso)

La cuenta `cursor` del agente no lee el repo. Intentos del 2 de noviembre de 2026 (UTC):

| Intento | Salida |
|---|---|
| `gh repo clone sc-arquitectura/iark` | `Could not resolve to a Repository with the name 'sc-arquitectura/iark'` |
| `git clone` HTTPS y SSH | `Repository not found` |
| `gh api repos/sc-arquitectura/iark` y `gh api orgs/sc-arquitectura/repos` | `HTTP 404` |

Eso ya no bloquea la configuración: la fuente usada es la entrega de Julian. Sigue bloqueando citar un SHA de iark.

## Qué tiene que hacer Julian en Cursor

Escribir `.cursor/mcp.json` no mete el servidor en una sesión que ya estaba abierta. El descubrimiento de esta sesión (`GetDynamicTools`) sigue sin namespace ECE. Para que aparezca hace falta una sesión nueva, o recargar los MCP del proyecto, con `ECE_MCP_API_KEY` y `ECE_MCP_URL` en el entorno de ese proceso. Los nombres tienen que existir ahí; este repo no los guarda.
