# 002 · Gateway de módulos

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`002-diagrams-gateway`

## estado

`borrador`

Esta sesión lo deja en `borrador`. No pasa a `aceptada`, `en curso` ni `hecha`.

## problema

`api-modulos` y `pool` viven dentro del único proceso `servicio` (`iark serve`, `src/cli/serve.ts`). Ese proceso también atiende proyectos, cuentas, tokens, avisos, estáticos y cabeceras. La API de módulos traduce el HTTP al núcleo y agrega la respuesta: no guarda proyectos ni protege el invariante de un diagrama. La piscina que ejecuta ese cálculo es infraestructura del mismo proceso, y hoy no hay un borde que sea solo esa API.

## alcance

- Dejar escrito el proceso `diagrams-gateway` como borde único de la API de módulos, con el estilo `gateway-feature-based` que fija la [spec 001](001-to-be-c4.md).
- Fijar los ocho features: `validate`, `views`, `schema`, `export`, `import`, `diff`, `run` y la traza URN.
- Dejar `pool` dentro de ese proceso, como infraestructura interna.
- Dejar el núcleo `@iark/*` ejecutado por ese proceso.
- Conservar el contrato HTTP que hoy documenta `src/cli/serve.ts` para esas rutas.
- Dejar esta spec en `borrador`. Autoriza la implementación solo después de que quien mantiene el producto la pase a `aceptada`, en otra PR, que no es esta.

## fuera de alcance

- `diagrams-app` y el módulo `projects` ([spec 003](003-diagrams-app.md)): `api-proyectos`, el almacén `proyectos`, el historial, el bundle, la importación de proyectos, la comprobación y `ifUpdatedAt`.
- `diagrams-identity` ([spec 004](004-diagrams-identity.md)): `tokens`, `cuentas-gh`, el almacén `cuentas`, `GET /api/whoami`, `/api/auth`, `/api/admin` y `/api/usage`.
- `diagrams-sse` ([spec 005](005-diagrams-sse.md)): `GET /api/events`.
- Estáticos, cabeceras y la librería de observabilidad ([spec 009](009-borde-y-operacion.md)). Esta spec no quita `--static` ni mueve `src/cli/observability/`.
- El manifiesto `GET /.well-known/iark.json` (`src/cli/suiteManifest.ts`). La 001 dice que no es un módulo de `diagrams-app` y que cada URL que anuncia sigue la fila de esa URL. No nombra qué proceso lo sirve. Esta spec no lo asigna.
- El shell, los remotos y el CLI ([specs 006](006-diagrams-shell.md), [007](007-microfrontends.md) y [008](008-cli-hexagonal.md)).
- Un deploy propio de `pool`. Una carpeta de capas `1-api/`, `2-infrastructure/`, `3-application/`.
- Portar el gateway a NestJS o a las plantillas que la card nombra. La materialización es reemplazable, como ya dice la 001.
- Llamar a un modelo. El servicio no tiene cliente de IA; esta spec no se lo añade.
- Crear `examples/diagrams-to-be.json`, editar `examples/diagrams-as-is.json`, o tocar `src/`, `packages/`, `schema/`, `public/`, pruebas y `deploy/` en la PR de este borrador.
- Un contenedor `diagrams-trace`. La traza URN es el feature de esta lista, no un proceso de operación.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`servicio`, `http`, `api-modulos`, `pool`, `nucleo`, `contrato`, `urn`, `diff`.

`http` entra solo por el tramo que hoy reparte la API de módulos y `POST /api/trace`. El resto del enrutador lo llevan otras specs. `contrato`, `urn` y `diff` siguen siendo librería del núcleo: el gateway los ejecuta y no los convierte en módulos de `diagrams-app`.

## capacidades ECE que aplican

Herramientas y paths registrados en la [spec 001](001-to-be-c4.md) (puente stdio, `read_document`). Esta sesión no repitió la llamada. El catálogo de nombres está en [ece-capacidades.md](../ece-capacidades.md).

| Para qué | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| Estilo de `diagrams-gateway` | `read_document` | `gateway-feature-based` | `corpus/software/arquitectura-referencia/gateway-feature-based.md` |
| Materialización que la card nombra y esta spec no porta | `read_document` | `decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad` | `corpus/gateway-nestjs/decision-arquitectonica/decision-arquitectonica-gateway-nestjs-estilo-por-funcionalidad.md` |
| Carpetas del estilo, sin layer-folders | `read_document` | `convencion-gateway-nestjs-feature-structure` | `corpus/gateway-nestjs/convencion/convencion-gateway-nestjs-feature-structure.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

La card, en la lectura que la 001 copió: «un traductor de protocolos y agregador de respuestas organizado alrededor del contexto de negocio (feature), no de la capa técnica. El gateway no persiste datos propios, no protege invariantes de dominio y no posee ciclo de vida de entidades». También: «Un feature nunca depende de otro feature» y «Shared nunca depende de ningún feature». La misma card y el ADR NestJS nombran un BFF NestJS por funcionalidad, con carpetas `features/` y sin layer-folders `1-api/`, `2-infrastructure/`, `3-application/`. La 001 ya dijo que el estilo es un contrato agnóstico de tecnología y que la implementación es reemplazable. Aquí se aplica el contrato al proceso Node. No se copia el BFF NestJS.

La card no nombra la piscina. El corte la deja aquí igual, como ya decidió la 001.

## decisión

`diagrams-gateway` es el proceso que posee la API de módulos. El estilo es `gateway-feature-based`. El núcleo `@iark/*` lo ejecuta este proceso, a través de la piscina. No es un módulo de `diagrams-app`.

El contrato HTTP no cambia. Métodos, rutas y cuerpos siguen siendo los que `createSuiteServer` atiende hoy en `api()` (`src/cli/serve.ts`). La PR de implementación, cuando esta spec esté `aceptada`, extrae el código de esa API y de la piscina a este proceso y deja esas rutas respondiendo igual.

### Features

Cada fila es un feature. Un feature no depende de otro. No hay carpetas de capa `1-api/`, `2-infrastructure/` ni `3-application/`.

| Feature | Contrato que se conserva | Dónde corre el trabajo |
|---|---|---|
| `validate` | `POST /api/<módulo>/validate` | Piscina (`runCompute` en `serve.ts`, `executeJob` en `src/cli/compute.ts`) |
| `views` | `POST /api/<módulo>/views` | Piscina |
| `schema` | `GET /api/<módulo>/schema`, con `kind=document` y, si el módulo tiene IA de esquema, `kind=generation` | En el proceso, leyendo `module.jsonSchema()` del contrato. No entra en la piscina: `api()` no llama a `runCompute` para `schema`. |
| `export` | `POST /api/<módulo>/export` | Piscina |
| `import` | `POST /api/<módulo>/import` | Piscina |
| `diff` | `POST /api/<módulo>/diff` | Piscina. Usa el componente `diff` del núcleo. |
| `run` | `POST /api/<módulo>/run/<comando>` | Piscina |
| Traza URN | `POST /api/trace` | Piscina. Resuelve `urn:iark:<módulo>:<id>` (`urn`, `packages/kernel/src/module/urn.ts`). |

`GET /api/modules` y `GET /api/<módulo>/capabilities` se quedan en Shared. Anuncian el registro (incorporados y, si hay configuración, los de terceros) y no calculan. Leen el registro, no el handler de otro feature, así que Shared no depende de un feature. No son un noveno feature: el corte nombra los ocho de la tabla.

### Piscina

`pool` es infraestructura interna de este proceso. `iark serve` la crea con `worker_threads` (`src/cli/computePool.ts`, `src/cli/computeWorker.ts`), con tiempo límite y cola acotada, salvo `--workers 0`, que calcula en el hilo. Las pruebas pueden usar el ejecutor en línea (`inlineExecutor` en `src/cli/compute.ts`). Nada de eso es un deploy, un servicio ni un feature. El hilo carga el registro y ejecuta `@iark/kernel` (y, a través del registro, los `@iark/domain-*`). El proceso del gateway es quien los ejecuta.

La traza URN corre en esa piscina. No es el proceso de operación de la [spec 009](009-borde-y-operacion.md) y no crea `diagrams-trace`.

### Qué conserva el cliente

Quien llama sigue usando las mismas rutas. La PR de implementación puede separar el proceso y despachar solo esas rutas hacia él. No cambia el cuerpo de la petición ni el de la respuesta, no mueve proyectos ni cuentas, y no añade una ruta de generación.

## alternativas descartadas

- Dejar `api-modulos` y `pool` dentro de `diagrams-app`. La 001 ya los saca de ese proceso.
- Hacer de `pool` un servicio desplegable, o nombrarlo feature.
- Tratar `schema` como trabajo de piscina. El código lo responde en el proceso.
- Añadir un feature de catálogo además de Shared para `/api/modules` y `capabilities`.
- Portar el borde a NestJS para cumplir la carpeta `features/` del ADR. El contrato que se aplica es la regla de features y de Shared.
- Servir `GET /api/events`, el manifiesto o los estáticos desde este proceso.
- Crear `diagrams-trace` para `POST /api/trace`.

## criterios de aceptación comprobables

De este borrador:

1. En este archivo, la línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. `examples/diagrams-as-is.json` no cambia en la PR de este borrador.
3. El diff de esta PR no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
4. La sección de capacidades cita `gateway-feature-based` con la herramienta `read_document` y el `path` de la spec 001. Los ids de «elementos del as-is que toca» están en `examples/diagrams-as-is.json`.
5. La decisión nombra los ocho features, deja `GET /api/modules` y `capabilities` en Shared, y describe `pool` como infraestructura del proceso.

De la implementación, y solo cuando esta spec esté `aceptada` en una PR distinta, que no trae el código:

1. El proceso que responde las ocho rutas de la tabla no implementa `/api/projects`, `/api/events`, `/api/auth`, `/api/admin`, `/api/usage` ni `/api/whoami`.
2. Las rutas, métodos y cuerpos de la tabla siguen los de `src/cli/serve.ts` en el commit del que sale la PR. No se añade una ruta de generación.
3. El código de `src/cli/computePool.ts` y `src/cli/computeWorker.ts` corre en ese proceso. No aparece un deploy aparte de la piscina.
4. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo que otra spec aceptada haya corregido el as-is con una corrección factual.
5. Pasan las pruebas que ya cubren el área: `src/cli/serveCompute.test.ts`, `src/cli/serveDiff.test.ts`, `src/cli/computePool.test.ts`, `src/cli/computeConfig.test.ts`, `src/cli/serveSinIa.test.ts`, `tests/module-operations.test.ts`, `tests/trace.test.ts` y `src/cli/serve.test.ts`.
6. Esa PR deja esta spec en `en curso` mientras trabaja y en `hecha` al cerrar. No mezcla otra spec.

## verificación

Esta sesión redacta el borrador y no implementa. No volvió a abrir el puente: los `entity_id` y los `path` de arriba están en la verificación de la [spec 001](001-to-be-c4.md), leídos con `read_document` vía `python3 scripts/mcp-ece.py --no-cache` (stdio NDJSON). `GetDynamicTools` con patrón `ece` no devolvió un namespace. La spec 000 no cambia de estado. No se imprime `ECE_MCP_API_KEY` ni `ECE_MCP_URL`.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprime nada.

## riesgos

- Dejar la piscina y la traza URN en el gateway cuando la card saca de ahí cualquier invariante de negocio real. El corte lo hace igual. Se vigila que el gateway siga sin persistir diagramas y sin proteger el `ifUpdatedAt`, que es de `projects`.
- Cambiar el contrato HTTP al extraer el proceso. La comprobación son las pruebas de `serveCompute`, `serveDiff`, `trace` y `serveSinIa`.
- Cargar los módulos de terceros en el proceso nuevo y olvidar el registro que hoy viaja en `workerData` (`src/cli/computeWorker.ts`). La ruta pública es la misma; el registro también.
- Adelantar en esta PR la librería de observabilidad, el manifiesto o el reparto de Caddy de otras rutas. El proceso puede seguir usando el `/healthz` que ya existe para poder supervisarlo. Mover esa librería es la spec 009.
