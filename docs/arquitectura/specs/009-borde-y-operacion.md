# 009 · Borde y operación

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`009-borde-y-operacion`

## estado

`aceptada`

Julian aprobó explícitamente esta spec el 2 de noviembre de 2026. La implementación va en su propia PR (`en curso` → `hecha`).

## problema

Con `--static`, el mismo proceso que guarda proyectos sirve el build del sitio (`estaticos`, `serveStatic` en `src/cli/serve.ts`). Las cabeceras de seguridad salen de ese proceso en cada respuesta (`cabeceras`, `src/cli/securityHeaders.ts`), y Caddy solo fija HSTS (`deploy/Caddyfile`). La observabilidad (`obs`, `src/cli/observability/`) está escrita para un solo `iark serve`: un `/healthz`, un `/readyz` que mira carpeta, tokens, cuentas y cálculo a la vez, un `X-Request-Id` y, si se piden, métricas y auditoría. El corte reparte los procesos y no crea uno nuevo para nada de esto. Tampoco existe `diagrams-trace`, y `pool` no es un servicio.

## alcance

- Dejar los estáticos en GitHub Pages o en un CDN.
- Dejar las cabeceras en el proxy TLS y en el borde de `diagrams-gateway` y de `diagrams-sse`.
- Dejar la observabilidad como librería: salud en cada proceso, identificador de petición y métricas comunes, auditoría en identity y en `projects`.
- Dejar escrito que no existe el contenedor `diagrams-trace` y que `pool` no es un servicio.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Un proceso `diagrams-trace`, un deploy de `pool`, o servir el SPA desde `diagrams-app`, desde `diagrams-gateway` o desde `diagrams-sse`.
- Mover la traza URN. `POST /api/trace` sigue en el gateway ([spec 002](002-diagrams-gateway.md)). `mfe-trace` sigue siendo la superficie ([spec 007](007-microfrontends.md)). `traza-ui` no se convierte en backend.
- Rehacer los features del gateway, el módulo `projects`, identity o el canal SSE. Esta spec solo les quita el estático, les aplica la cabecera de borde y les entrega la librería.
- Elegir el proceso que sirve `GET /.well-known/iark.json`. La 001 no lo nombra. Esta spec no lo asigna. La ruta tiene que seguir respondiendo cuando el dominio deje de servir el sitio; quién la posee queda para una decisión posterior, fuera de este borrador.
- Copiar los building blocks `@siste/nestjs-*` que la convención del gateway menciona para la observabilidad de ese BFF. La 001 ya dijo que esos paquetes no son la librería de DIAgrams.
- Un estilo ECE para Pages o para el CDN. La 001 registró que no hay esa card. No se inventa.
- Código de producto y los JSON de modelo en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`servicio`, `http`, `estaticos`, `cabeceras`, `obs`, `proxy`, `prometheus`, `github`, `pool`, `urn`, `traza-ui`.

`pool`, `urn` y `traza-ui` se nombran para dejarlos donde el corte ya los puso: la piscina dentro del gateway, la URN en el núcleo y en el feature de traza, la UI de traza en el remoto cuando la spec 007 exista. Esta spec no los despliega. `github` sigue sirviendo el sitio (`r-gh-sitio`). `prometheus` sigue raspando `/metrics`. `proxy` sigue terminando TLS.

## capacidades ECE que aplican

Citas de la [spec 001](001-to-be-c4.md). Esta sesión no repitió `read_document`.

| Para qué | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| La observabilidad no es un proceso de producto | `read_document` | `decision-arquitectonica-plataforma-10-observability-stack` | `corpus/plataforma/decision-arquitectonica/decision-arquitectonica-plataforma-10-observability-stack.md` |
| Building blocks que no se copian | `read_document` | `convencion-gateway-nestjs-feature-structure` | `corpus/gateway-nestjs/convencion/convencion-gateway-nestjs-feature-structure.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

La card de observabilidad, en la lectura de la 001: la sección «Decisión» repite «Stack de observabilidad (logs, metrics, traces).» No define un estilo de proceso de producto. No hay otra card, en lo que la 001 registró, para el destino de los estáticos.

## decisión

Tres piezas, ninguna de ellas un proceso nuevo.

### Estáticos

El shell se publica en GitHub Pages (el workflow `.github/workflows/deploy-pages.yml` y `scripts/deploy-gh-pages.sh`) o en un CDN. `github` ya es ese destino en el as-is. `diagrams-app` deja de aceptar `--static`. La imagen actual lo pide en el `ENTRYPOINT` del `Dockerfile` (`iark serve` con `--static dist/app`): la PR de implementación quita esa bandera del proceso de dominio. `serveStatic` no pasa al gateway de módulos ni al gateway SSE. Sin la carpeta de estáticos, el proceso de dominio no tiene esas rutas: hoy, sin `--static`, ya responden 404 (`src/cli/serve.test.ts`).

### Cabeceras

La política sigue siendo la de `securityHeaders` (`src/cli/securityHeaders.ts`):

- En toda respuesta: `X-Content-Type-Options: nosniff`, y `Strict-Transport-Security` si la petición llegó por https (`max-age=15552000`, sin `includeSubDomains` ni `preload`).
- En el HTML: `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Content-Security-Policy` sin `unsafe-eval` y `frame-ancestors`.

Esa política se aplica en dos sitios. El proxy TLS (`proxy`, `deploy/Caddyfile`) la pone en el borde, incluido el HTML que el proxy entregue y el 502 que Caddy ya cubre con HSTS. El borde de `diagrams-gateway` y el de `diagrams-sse` la ponen en sus respuestas antes del handler, igual que hoy `applySecurityHeaders` corre antes del manejador. Las respuestas JSON de la API siguen llevando solo `nosniff` y, si hay https, HSTS: la CSP de documento no se les añade, que es lo que el código ya distingue.

`diagrams-app` y `diagrams-identity` no son el borde público del sitio. No sirven el SPA. Si una respuesta suya sale a internet, el proxy ya puso la cabecera. No se mantiene una tercera copia de la política dentro del dominio solo para el HTML, porque el dominio ya no lo sirve.

Pages, por sí solo, no inyecta esta CSP. Si el sitio sale por Pages sin un CDN o un proxy delante que ponga las cabeceras del HTML, el navegador deja de recibir las que hoy pone `--static`. La PR de implementación deja la cabecera puesta en el proxy o en el CDN, y lo comprueba. No da por cumplida la política solo con quitar `--static`.

### Observabilidad

Es una librería, la que hoy está en `src/cli/observability/`, usada por cada proceso de servidor del corte: `diagrams-gateway`, `diagrams-identity`, `diagrams-app` y `diagrams-sse`. El CLI local no gana un `/healthz`.

| Pieza | Dónde queda |
|---|---|
| `/healthz` | En cada uno de esos cuatro procesos. Dice si ese proceso atiende. |
| `/readyz` | En cada uno, y solo mira lo que ese proceso posee. Gateway: registro y piscina. Identity: almacén de cuentas y archivo de hashes. App: almacén de proyectos. SSE: puede aceptar conexiones y, si la spec 005 ya tiene canal, ese canal. |
| `X-Request-Id` | Librería común, en toda respuesta, como `requestId.ts`. |
| Métricas | Librería común. `/metrics` solo si se activan, apagadas por omisión. Fuera de loopback siguen exigiendo token. `prometheus` raspa. |
| Auditoría | En los procesos que tienen el dato. Identity: `member.set`, `member.remove`, `user.set`, `user.remove`, `auth.logout`. `projects`: las acciones `project.*`, `diagram.*` y `version.*` que `ACTIONS` ya lista en `src/cli/observability/audit.ts`. El mecanismo es la librería; la fila la emite el proceso dueño. |

No hay proceso de auditoría ni proceso de métricas. El registro de accesos sigue apagado por omisión.

`pool` no entra en esta lista. No es un servicio. Sigue dentro de `diagrams-gateway`, que es quien lo arranca. Esta spec no lo despliega y no le pone un `/healthz` propio: la preparación del gateway incluye la piscina.

No se crea `diagrams-trace`. El nombre chocaría con `traza-ui`, con `POST /api/trace` y con `mfe-trace`. Los traces del título de la card de plataforma son el stack de operación (logs, metrics, traces), no la traza URN del producto.

## alternativas descartadas

- Crear `diagrams-trace` para salud, métricas o auditoría.
- Hacer de `pool`, de `estaticos` o de `cabeceras` un servicio.
- Servir el SPA desde `diagrams-app` o desde cualquiera de los dos gateways, aunque sea «solo en desarrollo» dentro del proceso de dominio. El desarrollo del shell sigue siendo el de Vite. `--static` no se conserva en la app.
- Dejar el `/readyz` monolítico en los cuatro procesos, de forma que la app falle si no puede abrir el archivo de tokens.
- Copiar `@siste/nestjs-*` al repo.
- Inventar una card ECE para GitHub Pages.
- Quitar `--static` y no poner la CSP del HTML en ningún borde.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. El as-is no cambia. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
3. Las capacidades citan `decision-arquitectonica-plataforma-10-observability-stack` con `read_document` y el `path` de la spec 001, y no inventan un estilo para Pages.
4. La decisión manda los estáticos a Pages o CDN, las cabeceras al proxy y al borde de los dos gateways, y la observabilidad a una librería con salud por proceso, request id, métricas comunes y auditoría en identity y en `projects`. Dice que no existe `diagrams-trace` y que `pool` no es un servicio.
5. Los ids citados están en `examples/diagrams-as-is.json`.

De la implementación, solo con la spec `aceptada` y en su PR:

1. El proceso de `diagrams-app` no admite `--static` y no llama a `serveStatic`. El `ENTRYPOINT` del `Dockerfile` deja de pasar `--static dist/app` a ese proceso. Los gateways tampoco sirven el build del sitio.
2. `deploy/Caddyfile` y el arranque de `diagrams-gateway` y de `diagrams-sse` aplican la política de `securityHeaders.ts`. Una respuesta HTML de prueba del borde trae CSP sin `unsafe-eval`. Una respuesta JSON de la API no trae esa CSP de documento.
3. Existe una sola librería de request id y de métricas, y cada proceso de la tabla expone `/healthz`. `/readyz` de la app no comprueba el archivo de tokens.
4. No hay un binario, un servicio de compose ni un paquete llamados `diagrams-trace`. `src/cli/computePool.ts` sigue enlazado desde el gateway.
5. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada.
6. Pasan `src/cli/securityHeaders.test.ts`, `src/cli/serveSecurityHeaders.test.ts`, `tests/e2e/seguridad-cabeceras.spec.ts`, `src/cli/serve.test.ts` (el caso «sin --static no sirve archivos»), las pruebas de `src/cli/observability/`, `tests/observabilidad-http.test.ts` y `tests/observabilidad-cli.test.ts`.
7. La PR deja la spec en `en curso` y luego en `hecha`. No mezcla la extracción del gateway ni la del módulo `projects`.

## verificación

Borrador, sin implementación. La cita de la card de observabilidad sale de la spec 001. Esta sesión no llamó al puente. `GetDynamicTools` con patrón `ece` no devolvió namespace. No se imprimen `ECE_MCP_API_KEY` ni `ECE_MCP_URL`.

Se leyeron `src/cli/securityHeaders.ts`, el comentario de HSTS en `deploy/Caddyfile`, el `ENTRYPOINT` del `Dockerfile` (arrastra `--static dist/app`) y la lista `ACTIONS` de `src/cli/observability/audit.ts` para nombrar la política y las acciones que ya existen. No se levantó Caddy ni Pages.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprime nada.

## riesgos

- Publicar el SPA solo en Pages y perder la CSP, porque Pages no aplica `securityHeaders.ts`. La PR no cierra hasta que el proxy o el CDN ponen las cabeceras del HTML.
- Repartir `/readyz` y dejar un balanceador mirando el chequeo viejo, que espera tokens y cálculo en el mismo proceso. Cada proceso publica el chequeo que le pertenece, y el despliegue tiene que apuntar al que le toca.
- Nombrar más adelante `diagrams-trace` a la librería de métricas y chocar con `mfe-trace` y con `/api/trace`.
- Tratar `pool` como el servicio que «ya está aparte» porque vive en un hilo. El hilo no escucha un puerto.
