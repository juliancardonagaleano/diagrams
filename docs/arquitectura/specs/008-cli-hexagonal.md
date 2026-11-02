# 008 · CLI hexagonal

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`008-cli-hexagonal`

## estado

`en curso`

Rama `cursor/impl-cli-hexagonal-58e1`: puertos declarados en `src/cli/ports/` y adaptadores iniciales sin romper commander.

## problema

El CLI es un proceso Node (`cli`, `src/cli/main.ts`) que ya reparte en commander, el registro, el cliente de modelos, el lector de repositorio, la carpeta de proyectos y el cargador de plugins. Esas piezas están escritas como módulos que se llaman entre sí, no como un núcleo con puertos. La IA del producto vive aquí y en ninguna otra parte: `iark serve` no tiene cliente de modelo. El corte pide el estilo `backend-hexagonal` para este único proceso, y los nombres de los puertos no los devolvió ECE.

## alcance

- Fijar un solo proceso, el `cli`, con el estilo `backend-hexagonal`.
- Dejar commander (`comandos`) como adaptador de entrada.
- Fijar los puertos `ModelProvider`, `RepositoryReader`, `ProjectStore` y `Modules`.
- Dejar la IA enganchada solo en este proceso.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Un segundo proceso para la IA, o una ruta de generación en `diagrams-gateway`, `diagrams-app`, `diagrams-identity` o `diagrams-sse`.
- Mover `iark serve` a este rediseño. Los archivos del servidor (`src/cli/serve.ts`, `serveProjects.ts`, `serveEvents.ts`, `serveAuth.ts`, `accounts/`, `observability/`, `securityHeaders.ts`, `computePool.ts`) los parten otras specs. Esta spec no los edita en la misma PR.
- El almacén de proyectos del servidor (Postgres de `diagrams-app`). El puerto `ProjectStore` de este proceso es la carpeta del CLI (`workspace-cli`).
- El shell y los remotos. No comparten proceso con el CLI; por eso el [plan](../plan-implementacion.md) marca esta fase en paralelo a la del shell.
- Usar la card LeanIX `decision-arquitectonica-software-01-arquitectura-hexagonal` como definición de puertos. La 001 leyó ese cuerpo y no trae puertos ni capas. La definición es `backend-hexagonal`.
- Una vertical «CLI» que el marco no nombra. El marco clasifica hexagonal como vertical backend. Se aplica igual, al proceso que ya existe.
- Código de producto y los JSON de modelo en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`cli`, `comandos`, `registro-cli`, `ia-cli`, `repo-cli`, `workspace-cli`, `plugins-cli`, `proveedor-ia`, `repositorio`, `proyectos`.

`proyectos` entra por el uso de carpeta del CLI (`r-cli-proy`). El Postgres del servicio es de la spec 003. `proveedor-ia` y `repositorio` siguen siendo externos. `ia-kernel` no se mueve: el adaptador de `ModelProvider` lo usa, y el servicio sigue sin usarlo.

## capacidades ECE que aplican

Citas de la [spec 001](001-to-be-c4.md). Esta sesión no repitió `read_document`. La lectura de `backend-hexagonal` es la de la sesión que abrió la 001; esa spec no la volvió a pedir en las relecturas posteriores y aun así la cuenta entre los estilos aplicados.

| Para qué | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| Estilo del `cli` | `read_document` | `backend-hexagonal` | `corpus/software/arquitectura-referencia/backend-hexagonal.md` |
| Card que no define los puertos | `read_document` | `decision-arquitectonica-software-01-arquitectura-hexagonal` | `corpus/software/decision-arquitectonica/decision-arquitectonica-software-01-arquitectura-hexagonal.md` |
| El marco no nombra una vertical CLI | `read_document` | `decision-arquitectonica-gobierno-framework-multi-arquitectura` | `corpus/gobierno/decision-arquitectonica/decision-arquitectonica-gobierno-framework-multi-arquitectura.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

La decisión de la 001, a partir de esa lectura, fija el estilo en Host, Core con puertos e Infrastructure que implementa esos puertos. Core no depende de Host ni de Infrastructure. Esta spec usa esa cita. No añade frases de la card que la 001 no copió. Los identificadores `ModelProvider`, `RepositoryReader`, `ProjectStore` y `Modules` no los devolvió ECE: son los nombres del corte.

## decisión

Un proceso, el que hoy arranca `src/cli/main.ts`. El estilo es `backend-hexagonal`.

Commander es el adaptador de entrada. El componente `comandos` valida argumentos y delega. No llama al proveedor, no lee el árbol del repositorio y no abre la carpeta: pide eso a los puertos del Core. `InvalidArgumentError` y el parseo de banderas se quedan en ese adaptador.

Core depende de los cuatro puertos y no depende de commander, ni de `node:fs`, ni del cliente HTTP del proveedor. Infrastructure implementa los puertos.

| Puerto | Id as-is | Adaptador de hoy | Qué hace |
|---|---|---|---|
| `ModelProvider` | `ia-cli` | `src/cli/ai.ts`, con `packages/kernel/src/ai` | Pide el documento al proveedor (`proveedor-ia`). Verifica con `validate()` del módulo y reintenta. Sin clave, `iark prompt` sigue entregando el encargo a otro agente, como hoy. |
| `RepositoryReader` | `repo-cli` | `src/cli/repo` | `--from-repo` lee la lista blanca y redacta secretos. `--dry-run` muestra el envío. No carga el `iark.config.json` del clon. |
| `ProjectStore` | `workspace-cli` | `src/cli/workspace.ts` | Carpeta de proyectos del CLI, historial local incluido. No es el `PostgresProjectStore` del servicio. El nombre del puerto es el del corte; el tipo `ProjectStore` que ya exporta el núcleo puede ser el que el adaptador use, sin un renombre de paso. |
| `Modules` | `registro-cli`, `plugins-cli` | `src/cli/registry.ts`, `src/cli/plugins` | Los seis incorporados y los de `iark.config.json`. Un id de plugin no pisa un comando ni otro módulo. El cargador ejecuta el código del tercero con los permisos del proceso. |

La IA solo se engancha en este proceso. `ModelProvider` es el único adaptador que habla con `proveedor-ia`. `r-cli-ia` y `r-ia-prov` siguen saliendo del CLI. La prueba que ya impide un cliente de modelo en el servicio (`src/cli/serveSinIa.test.ts`) tiene que seguir pasando, y esta PR no la debilita.

`iark <módulo>`, `iark trace`, `iark diff`, `iark project` y `iark auth` siguen siendo comandos de este proceso. `iark auth` crea y revoca tokens; el almacén de hashes, cuando la spec 004 esté hecha, es de identity. Hasta entonces el comando sigue escribiendo el archivo que `tokens.ts` ya escribe. Esta spec no traslada ese archivo al servidor.

El núcleo se enlaza como librería (`r-cli-nuc`), igual que hoy. No se duplica dentro de Infrastructure.

## alternativas descartadas

- Dejar el CLI como script de commander sin puertos, porque el marco no tiene vertical CLI.
- Tomar la card LeanIX como lista de puertos. El cuerpo que la 001 leyó no los trae.
- Nombrar otros puertos además de los cuatro del corte.
- Mover `generate`, `explain` o `review` al servicio HTTP.
- Hacer que `ProjectStore` abra el Postgres de `diagrams-app`.
- Reescribir `serve.ts` dentro de la PR hexagonal para «limpiar src/cli». Ese archivo pertenece a otras specs.
- Partir el CLI en dos procesos, uno con IA y otro sin ella.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. El as-is no cambia. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
3. Las capacidades citan `backend-hexagonal` con `read_document` y el `path` de la spec 001, y citan la card LeanIX como definición que no se usa.
4. La decisión nombra un proceso, commander como adaptador de entrada, los cuatro puertos y el enganche de la IA solo en el CLI.
5. Los ids citados están en `examples/diagrams-as-is.json`. Los nombres de los puertos no se presentan como entidades ECE.

De la implementación, solo con la spec `aceptada` y en su PR:

1. El Core que añade la PR no importa `commander`, `node:fs` ni el cliente del proveedor. Esos imports están en los adaptadores.
2. La PR no modifica `src/cli/serve.ts`, `serveProjects.ts`, `serveEvents.ts`, `serveAuth.ts`, `accounts/`, `observability/`, `securityHeaders.ts` ni `computePool.ts`.
3. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada. `npm run cli -- validate` sobre un documento de ejemplo que ya valide hoy sigue saliendo válido.
4. Pasan `src/cli/cli.test.ts`, `src/cli/moduleCommands.test.ts`, `src/cli/registry.test.ts`, `tests/plugins-cli.test.ts`, `tests/project-cli.test.ts`, `src/cli/serveSinIa.test.ts` y las pruebas de `src/cli/repo/`.
5. La PR deja la spec en `en curso` y luego en `hecha`. No mezcla la 002, la 003, la 004 ni la 006.

## verificación

Borrador, sin implementación. La cita de estilo sale de la spec 001. Esta sesión no llamó al puente y no inventó una frase de `backend-hexagonal` que esa spec no hubiera fijado. `GetDynamicTools` con patrón `ece` no devolvió namespace. No se imprimen `ECE_MCP_API_KEY` ni `ECE_MCP_URL`.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprime nada.

## riesgos

- Aplicar un estilo de vertical backend a un proceso de línea de comandos. El marco no nombra otra vertical. Se vigila que siga siendo un solo proceso y que commander no acumule reglas.
- Chocar con las PR que todavía editan `src/cli/serve.ts`. Por eso esta PR no toca esos archivos y el plan la pone en paralelo al shell, no en la misma cola que el gateway.
- Dejar un import del proveedor dentro del Core y abrir la puerta a que el servicio lo reutilice. `serveSinIa` es la alarma.
- Renombrar el `ProjectStore` del núcleo de paso y romper la app y el CLI a la vez.
