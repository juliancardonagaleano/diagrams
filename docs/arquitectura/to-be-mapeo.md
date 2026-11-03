# Mapeo to-be → código

Modelo de referencia: [`examples/diagrams-to-be.json`](../../examples/diagrams-to-be.json) (spec [001](specs/001-to-be-c4.md)). El primer corte de implementación concentra la lógica en módulos bajo `src/`; `iark serve` sigue siendo el proceso monolítico por omisión, con comandos partidos (`serve-gateway`, `serve-identity`, `serve-app`, `serve-sse`) para despliegues repartidos.

| Contenedor (id to-be) | Código principal | Comando / rol |
| --- | --- | --- |
| `diagrams-gateway` | `src/diagrams-gateway/` (`moduleApi.ts`), montaje en `src/cli/serve.ts` | `iark serve-gateway` / `IARK_SERVE_ROLE=gateway` |
| `diagrams-app` | `src/diagrams-app/` (`host/projectsApi.ts`, `modules/projects/`) | `iark serve-app` / `IARK_SERVE_ROLE=app` |
| `diagrams-identity` | `src/diagrams-identity/` (`host/identityApi.ts`, `core/accounts/`, tokens) | `iark serve-identity` / `IARK_SERVE_ROLE=identity` |
| `diagrams-sse` | `src/diagrams-sse/` (`host/eventsApi.ts`, `features/events/`) | `iark serve-sse` / `IARK_SERVE_ROLE=sse` |
| `diagrams-shell` | `src/shell/` (SPA, federación, rutas) | Sitio estático: `npm run build:app` → Pages/CDN |
| `mfe-*` | Entradas Vite en `src/modules-app/` y paquetes `packages/domain-*` | Remotos compilados en `dist/app/` |
| `cli` | `src/cli/` (hexagonal: `ports/`, comandos `serve*`) | Binario `iark` (`dist/cli/index.js`) |

Comprobación en CI: `tests/architecture-models.test.ts` valida esquema y conteos de ambos JSON (`diagrams-as-is` y `diagrams-to-be`). Localmente: `npm run cli -- validate examples/diagrams-to-be.json`.
