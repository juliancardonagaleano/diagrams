# 003 · App de proyectos

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`003-diagrams-app`

## estado

`hecha`

Rama `cursor/post-rearch-continue-58e1`: almacenes en `modules/projects/infrastructure/`; shims en `src/cli/`. Host (`createProjectsHost`) usa `application/queries.ts` para lecturas y `application/commands.ts` para **todas** las escrituras (Domain: `saveDiagram`, `projectWrites`, `diagramWrites`, `versionWrites`). Verificación: typecheck, validate as-is, `tests/project-http*.ts`, `tests/project-check.test.ts` y suite de proyectos en vitest (CI con `IARK_REQUIRE_POSTGRES=1`).

## problema

`api-proyectos` y el almacén `proyectos` están dentro de `iark serve`, mezclados con el resto de superficies. El manejador `createProjectsApi` (`src/cli/serveProjects.ts`) traduce HTTP, aplica reglas y llama al almacén en el mismo sitio. El guardado condicional `ifUpdatedAt` está en los almacenes (`src/cli/workspace.ts`, `src/cli/postgresProjects.ts`, y el de memoria del núcleo). Tras el corte de la [spec 001](001-to-be-c4.md), el único módulo de negocio que permanece en `diagrams-app` es `projects`, y todavía no está escrito en las cuatro capas del estilo que Julian le asignó.

## alcance

- Fijar `diagrams-app` con el estilo `backend-coredomain`.
- Dejar un solo módulo de negocio, `projects`, en Host, Application, Domain e Infrastructure.
- Incluir en ese módulo el CRUD de proyectos y diagramas, el historial, el bundle, la importación, la comprobación y el guardado condicional `ifUpdatedAt`.
- Fijar que las lecturas van por infraestructura y las escrituras por el dominio.
- Dejar esta spec en `borrador`. La implementación espera a `aceptada` en otra PR.

## fuera de alcance

Al lado de `projects`, estas superficies no entran en `diagrams-app`. Cada una tiene su spec:

- Gateway de módulos y la piscina ([spec 002](002-diagrams-gateway.md)): `api-modulos`, `pool`, el núcleo `@iark/*`.
- Identity ([spec 004](004-diagrams-identity.md)): `tokens`, `cuentas-gh`, el almacén `cuentas`. Las rutas de miembros que hoy cuelgan de `/api/projects` delegan en `src/cli/accounts/members.ts`. Administración (`/api/admin`) y cuotas (`/api/usage`, y los topes que las escrituras consultan) son `accounts`.
- SSE ([spec 005](005-diagrams-sse.md)): `GET /api/events`. No hay módulo `realtime`. Mientras el proceso aún no se separa, el `EventPublisher` puede seguir inyectado; esta spec no lo convierte en módulo de la app.
- Estáticos ([spec 009](009-borde-y-operacion.md)): `--static` y `serveStatic`.
- Cabeceras ([spec 009](009-borde-y-operacion.md)): `src/cli/securityHeaders.ts`.
- Observabilidad como proceso. La auditoría de las escrituras de `projects` se queda en este módulo cuando la spec 009 parta la librería. Esta spec no crea esa librería.
- El manifiesto `GET /.well-known/iark.json`.
- El CLI `iark project` ([spec 008](008-cli-hexagonal.md)). Esta spec no rehace el comando. El almacén de carpeta puede seguir sirviendo al CLI hasta esa spec.
- Shell, remotos y cualquier JSON to-be.
- Código de producto en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`servicio`, `http`, `api-proyectos`, `proyectos`, `proyecto-modelo`.

`http` entra por el tramo `/api/projects` que atiende `createProjectsApi`, historial incluido. `proyecto-modelo` (`packages/kernel/src/project`) sigue siendo el modelo compartido: esta spec no le abre un formato paralelo. El contenedor `proyectos` deja de ser contenedor y pasa a Infrastructure de este módulo, como ya dice la 001.

## capacidades ECE que aplican

Citas registradas en la [spec 001](001-to-be-c4.md). Esta sesión no repitió `read_document`.

| Para qué | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| Estilo de `diagrams-app` | `read_document` | `backend-coredomain` | `corpus/software/arquitectura-referencia/backend-coredomain.md` |
| El marco llama a este estilo «DDD + CQRS» | `read_document` | `decision-arquitectonica-gobierno-framework-multi-arquitectura` | `corpus/gobierno/decision-arquitectonica/decision-arquitectonica-gobierno-framework-multi-arquitectura.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

La card, en «Definición», con el texto que la 001 copió de la llamada: «Se compone de cuatro capas explícitas: un punto de entrada ultra-delgado (Host), una capa de orquestación pura sin reglas de negocio (Application), un núcleo de dominio rico en comportamiento y protegido de cualquier detalle técnico (Domain), y una capa de implementaciones concretas (Infrastructure).» Los tres pilares que nombra son el modelado de dominio táctico, la separación de comandos y consultas, y el aislamiento de puertos y adaptadores. En «Fundamentos»: «las consultas no pasan por el dominio: leen directamente de la capa de infraestructura», y «las escrituras sí pasan íntegramente por el dominio».

La card no escribe la sigla CQRS. El marco ya leído nombra el estilo «CoreDomain (DDD + CQRS)». Aquí la sigla es esa separación, no una quinta capa. La card tampoco pide un módulo por bounded context: el único módulo de negocio de este proceso es `projects`.

## decisión

`diagrams-app` queda con el estilo `backend-coredomain` y un solo módulo de negocio, `projects`. Las lecturas salen por Infrastructure. Las escrituras entran por Domain. Host no llama al dominio: traduce el HTTP a un comando o a una consulta.

La regla de dependencia de la card: «Domain no depende de ninguna otra capa. Application depende de Domain. Infrastructure implementa los contratos de Domain. Host depende de Application.» Las consultas son la excepción que la misma frase declara: van de Application a Infrastructure, sin pasar por Domain.

### Host

El HTTP de `api-proyectos` (`src/cli/serveProjects.ts` y `versionsRoute` en el mismo archivo). Valida el formato de entrada y traduce el protocolo. La card: «No conoce el dominio ni lo invoca directamente; su única responsabilidad es validar el formato de entrada y traducir protocolo hacia y desde ese punto de entrada único.»

Rutas que siguen siendo de este módulo:

| Verbo y ruta | Papel |
|---|---|
| `GET /api/projects`, `GET /api/projects/<p>`, `GET /api/projects/<p>/diagrams/<d>` | Lectura |
| `GET /api/projects/<p>/bundle`, `GET /api/projects/<p>/check` | Lectura |
| `GET …/versions`, `GET …/versions/<n>` | Lectura |
| `POST /api/projects`, `PATCH /api/projects/<p>`, `DELETE /api/projects/<p>` | Escritura |
| `POST /api/projects/<p>/diagrams`, `PUT` y `PATCH` y `DELETE …/diagrams/<d>` | Escritura. El `PUT` lleva `text` e `ifUpdatedAt` opcional. |
| `POST /api/projects/import` | Escritura |
| `POST …/versions/<n>/restore`, `PATCH` y `DELETE …/versions/<n>` | Escritura |

`GET|PUT|DELETE /api/projects/<p>/members` no se resuelve aquí.

### Application

Orquesta y no contiene la regla. La card: «Cada operación de escritura tiene su propio punto de orquestación que carga el estado, invoca un método de negocio del dominio y persiste; cada operación de lectura hace bypass directo hacia infraestructura con su propio modelo de proyección.»

Escrituras: crear, renombrar y borrar proyecto o diagrama; importar el archivo único; guardar con `ifUpdatedAt`; restaurar una versión, nombrarla y borrar una versión con nombre.

Lecturas: listar, abrir, el bundle, la comprobación, el historial y una versión. Cada una tiene su proyección y no llama a un método de negocio.

Un comando de escritura que hoy choca con una cuota pregunta la decisión a identity ([spec 004](004-diagrams-identity.md)). La cuota no entra en el dominio de `projects`. El código que la calcula hoy es `src/cli/accounts/usage.ts`.

### Domain

Las reglas del CRUD, del guardado condicional y del historial. El estado válido cambia solo por un método de negocio. La card: «nunca un conjunto de datos con acceso directo a sus campos» y «no tiene ninguna dependencia externa».

`ifUpdatedAt` es una de esas reglas: guardar o restaurar solo si la marca sigue siendo la que leyó quien escribe; si no, el conflicto que hoy responde 409 (`ProjectError` de conflicto en `packages/kernel/src/project/errors.ts`). El dominio expresa esa regla. El almacén sigue haciendo la comparación atómica para que dos escrituras simultáneas no pasen las dos (`src/cli/workspace.ts`).

`proyecto-modelo` aporta el documento de proyecto (id de módulo y texto, sin el tipo interno). El dominio de esta app lo usa. No se copia a otro esquema.

### Infrastructure

El almacén que hoy es el contenedor `proyectos`: carpeta (`src/cli/workspace.ts`) o Postgres (`src/cli/postgresProjects.ts`), historial incluido (`listVersions`, `getVersion`, `restoreVersion`, `labelVersion`, `deleteVersion`). La card: «Implementa los contratos de persistencia del dominio para escritura, define repositorios de lectura separados con proyecciones optimizadas para consulta». El almacén sigue siendo uno. Los repositorios de lectura son proyecciones sobre esa carpeta o esa base, no una segunda base.

### Qué no se parte

El historial, el bundle, la importación, la comprobación y el `ifUpdatedAt` son partes de `projects`. Viven en `createProjectsApi`, no en otro archivo de ruta ni en otro proceso.

## alternativas descartadas

- Dejar `diagrams-app` sin estilo, o no aplicar `backend-coredomain` porque la card no se titula monolito modular. Julian asigna esa card a `projects`.
- Inventar módulos que el código no tiene: `realtime`, un módulo por cada `@iark/*`, observabilidad como módulo de esta app.
- Devolver a esta app `api-modulos`, `tokens`, `cuentas-gh`, `sse`, `pool`, `estaticos` o `cabeceras`.
- Separar el historial, el bundle, la importación o el `ifUpdatedAt` en procesos distintos.
- Hacer que las lecturas pasen por el dominio, o que las escrituras escriban el almacén sin un método de negocio.
- Rehacer `iark project` en la misma PR. El comando es la spec 008.
- Añadir una quinta capa llamada CQRS. La separación ya está en las cuatro.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json` y `examples/diagrams-as-is.json` no cambia en esta PR.
3. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
4. Las capacidades citan `backend-coredomain` con `read_document` y el `path` de la spec 001.
5. La decisión dice que el único módulo de negocio es `projects`, nombra las cuatro capas, asigna las lecturas a infraestructura y las escrituras al dominio, y la sección de fuera de alcance lista gateway, identity, sse, estáticos y cabeceras.
6. Los ids de «elementos del as-is que toca» están en `examples/diagrams-as-is.json`.

De la implementación, solo con la spec en `aceptada` y en su propia PR:

1. El código nuevo de `projects` cumple la regla de dependencia de la card. Un lector ve Host, Application, Domain e Infrastructure, y Domain no importa HTTP, `pg` ni `node:fs`.
2. Las rutas de la tabla de Host conservan método y camino. Las de miembros, admin y usage no están implementadas en este módulo.
3. No aparece un módulo `realtime` ni un handler de `GET /api/events` como módulo de esta app.
4. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada.
5. Pasan `src/cli/serveProjects.test.ts`, `src/cli/serveVersions.test.ts`, `src/cli/workspace.test.ts`, `src/cli/workspaceCoarseTime.test.ts`, `src/cli/postgresProjects.test.ts`, `tests/project-http.test.ts`, `tests/project-http-postgres.test.ts`, `tests/project-check.test.ts` y las de `packages/kernel/src/project/`. `tests/project-cli.test.ts` sigue pasando: el comando no se rehace aquí.
6. La PR deja la spec en `en curso` y luego en `hecha`. No mezcla la 002, la 004, la 005 ni la 009.

## verificación

Implementación parcial (rama `cursor/impl-app-shell-deep-58e1`). Escrituras HTTP en `host/projectsApi.ts` solo llaman a `application/commands.ts`; lecturas a `application/queries.ts`. Domain no importa HTTP ni `pg`.

```text
npm run typecheck
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
npx vitest run src/cli/serveProjects.test.ts src/cli/serveVersions.test.ts \
  src/cli/workspace.test.ts src/cli/workspaceCoarseTime.test.ts src/cli/postgresProjects.test.ts \
  src/diagrams-app/modules/projects/domain/saveDiagram.test.ts \
  src/diagrams-app/modules/projects/domain/projectWrites.test.ts \
  src/diagrams-app/modules/projects/domain/diagramWrites.test.ts
```

```text
npx vitest run tests/project-http.test.ts tests/project-http-postgres.test.ts tests/project-check.test.ts
```

## riesgos

- Aplicar el punto alto del espectro a un solo módulo. La propia card, según la 001, pide mirar el estilo intermedio cuando el dominio es una sola entidad trivial o cuando la separación de lecturas y escrituras sale ceremonial. El corte lo aplica igual. Se vigila que las escrituras pasen por el dominio y las lecturas no.
- Sacar `ifUpdatedAt` del almacén y dejar una ventana en la que dos `PUT` simultáneos ganen. El dominio tiene la regla y el almacén conserva la comparación atómica.
- Meter la cuota de `usage.ts` en el dominio de `projects`. La decisión de cupo se pregunta a identity.
- Partir el modelo `packages/kernel/src/project` y romper `iark project`, que usa el mismo almacén de carpeta hasta la spec 008.
