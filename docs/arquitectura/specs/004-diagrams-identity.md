# 004 · Identidad

[← Índice de la documentación](../../indice.md) · [Protocolo](../protocolo-sdd.md) · [As-is](../as-is.md) · [Spec 001](001-to-be-c4.md) · [Plan](../plan-implementacion.md)

## id

`004-diagrams-identity`

## estado

`en curso`

Rama `cursor/impl-identity-core-move-58e1`: `src/cli/accounts/` y `src/cli/tokens.ts` movidos a `src/diagrams-identity/core/`; borde `createIdentityApi`; `serve.ts` delega auth, admin, usage y whoami.

## problema

Las cuentas de GitHub y los tokens de acceso viven en el mismo `iark serve` que los proyectos y la API de módulos. El almacén `cuentas` está dibujado como contenedor propio. Quien llama a proyectos o al cálculo tiene que fiarse de un rol que hoy resuelve el mismo proceso que guarda los hashes y las sesiones. El corte deja esa resolución en `diagrams-identity`, y la app y el gateway solo validan.

## alcance

- Fijar el proceso `diagrams-identity` con el estilo `backend-nano`: por fuera, Host y Core.
- Dejar dentro de Core, y solo ahí, el CQRS acotado de `accounts` y de `access-tokens`.
- Dejar el almacén de cuentas y los hashes de los tokens dentro de Core, con acceso directo.
- Dejar que `diagrams-app` y `diagrams-gateway` validen la credencial y no guarden personas ni hashes.
- Dejar esta spec en `borrador`.

## fuera de alcance

- Una tercera capa, una capa Infrastructure, o puertos hexagonales. El estilo exterior es Nano.
- Atribuir la sigla CQRS a la card `backend-nano`. Esa card no la trae. El patrón se cita de `backend-coredomain` y la decisión es de Julian.
- Las cuatro capas de `diagrams-app` ([spec 003](003-diagrams-app.md)). Aquí no se copian Application, Domain ni Infrastructure.
- Los extension methods `Add{Module}Services` del ADR .NET. El proceso es Node.
- La API de módulos y la piscina ([spec 002](002-diagrams-gateway.md)).
- El CRUD de proyectos, salvo las rutas de miembros, administración y cuotas, que sí son `accounts`.
- `GET /api/events` ([spec 005](005-diagrams-sse.md)). El canal pregunta a identity quién puede oír un proyecto; el canal no vive aquí.
- Estáticos, cabeceras y la librería de observabilidad ([spec 009](009-borde-y-operacion.md)). La auditoría de cuentas, miembros y sesión se queda en este proceso cuando esa librería exista.
- El comando `iark auth` como proceso aparte. Sigue siendo el comando que crea y revoca tokens (`src/cli/auth.ts`, `src/cli/tokens.ts`). Pasa a ser el comando de `access-tokens` dentro de este Core, no una ruta nueva de `serve`.
- Código de producto, el JSON as-is y el JSON to-be en la PR de este borrador.

## elementos del as-is que toca

Ids de [`examples/diagrams-as-is.json`](../../../examples/diagrams-as-is.json). El archivo no se edita.

`servicio`, `http`, `tokens`, `cuentas-gh`, `cuentas`.

`http` entra por `GET /api/whoami`, `/api/auth`, `/api/admin`, `/api/usage` y por `GET|PUT|DELETE /api/projects/<p>/members[/<login>]`. `cuentas` deja de ser contenedor y queda dentro de Core.

## capacidades ECE que aplican

Citas de la [spec 001](001-to-be-c4.md). Esta sesión no repitió la lectura. La 001 releyó `backend-nano` y `backend-coredomain` con `read_document`, `mode` `full`, `truncated` false.

| Para qué | Herramienta | `entity_id` | `path` |
|---|---|---|---|
| Estilo exterior de `diagrams-identity` | `read_document` | `backend-nano` | `corpus/software/arquitectura-referencia/backend-nano.md` |
| La separación de comandos y consultas, no las cuatro capas | `read_document` | `backend-coredomain` | `corpus/software/arquitectura-referencia/backend-coredomain.md` |
| El marco nombra «DDD + CQRS» en CoreDomain | `read_document` | `decision-arquitectonica-gobierno-framework-multi-arquitectura` | `corpus/gobierno/decision-arquitectonica/decision-arquitectonica-gobierno-framework-multi-arquitectura.md` |
| El Core no referencia tipos del Host | `read_document` | `antipatron-arquitectura-core-host-coupling` | `corpus/arquitectura/antipatron/antipatron-arquitectura-core-host-coupling.md` |
| Mecanismo .NET que no se copia | `read_document` | `decision-arquitectonica-backend-dotnet-separacion-host-core` | `corpus/backend-dotnet/decision-arquitectonica/decision-arquitectonica-backend-dotnet-separacion-host-core.md` |
| C4 antes de código | `read_document` | `principio-arquitectura-arquitectura-primero` | `corpus/arquitectura/principio/principio-arquitectura-arquitectura-primero.md` |

`backend-nano`, texto que la 001 copió de la llamada: «Se compone de exactamente dos capas: un punto de entrada (Host) y un núcleo de resolución (Core).» «La restricción no es de sofisticación interna, es de alcance.» «Lo que hace "nano" al estilo no es la ausencia de estructura interna.» Host: «Traduce la solicitud del protocolo de transporte a una invocación del Core» y «No contiene lógica de negocio». Core: «Contiene toda la lógica que resuelve el problema funcional» y «el acceso directo a las dependencias externas que ese problema necesita». «El Host depende del Core; el Core no depende del Host.» «El Core puede depender directamente de una dependencia externa concreta cuando no existe variabilidad real que justifique una interfaz.» La misma lectura comprobó que el cuerpo no contiene «CQRS», «comando» ni «consulta».

La separación que esta spec usa dentro de Core es la frase de `backend-coredomain`: «separación explícita entre comandos y consultas». Esa card tampoco trae la sigla. El marco la llama «CoreDomain (DDD + CQRS)». Se toma la separación. No se toman las cuatro capas ni el aislamiento de puertos y adaptadores: esas piezas siguen siendo el estilo de `diagrams-app`.

## decisión

Por fuera, `diagrams-identity` es `backend-nano`: exactamente Host y Core. No hay tercera capa y no hay puertos hexagonales. El almacén de cuentas y el archivo de hashes viven en Core, con acceso directo, porque la card permite depender de la dependencia concreta cuando no hay variabilidad que justifique una interfaz. Los tres almacenes de cuentas (JSON, SQLite, Postgres) son esa dependencia concreta, elegida al arrancar, no un puerto nuevo.

La card nano no menciona CQRS. No se le atribuye. La organización interna del Core es decisión de Julian: dentro de Core, y solo ahí, hay CQRS acotado para dos responsabilidades, `accounts` y `access-tokens`. No es una capa. No es un puerto. Vale para esas dos y para ninguna otra.

Host solo traduce el HTTP a un comando o a una consulta y devuelve el resultado. La frase «comando o una consulta» es la del Host de `backend-coredomain`. En este proceso no trae Application, Domain ni Infrastructure. El Core no referencia tipos del Host (`antipatron-arquitectura-core-host-coupling`).

### `accounts`

Es lo que hoy es `cuentas-gh`: OAuth de GitHub, sesión, miembros, administración y cuotas. Los nombres no los escribe la card.

| Comando (cambia estado) | Consulta (lee) | Código de hoy |
|---|---|---|
| `POST /api/auth/exchange`, `POST /api/auth/logout` | `GET /api/auth/providers`, `GET /api/auth/github/login`, `GET /api/auth/github/callback` | `src/cli/accounts/routes.ts`, `github.ts` |
| `PUT` y `DELETE /api/projects/<p>/members[/<login>]` | `GET` de esas rutas | `src/cli/accounts/members.ts` |
| `PUT` y `DELETE /api/admin/users[/<login>]` | `GET` de esas rutas | `src/cli/accounts/admin.ts` |
| Los topes que una escritura de proyectos consulta | `GET /api/usage` | `src/cli/accounts/usage.ts` |
| Sesión que `GET /api/whoami` no escribe | `GET /api/whoami` con sesión: persona y rol en la instancia | `src/cli/serve.ts` |

El almacén (personas, sesiones hasheadas, miembros, cuotas) sigue en Core: `src/cli/accounts/jsonStore.ts`, `sqliteStore.ts`, `postgresStore.ts`. `accounts` habla con ese almacén. No hay bypass hacia una Infrastructure que este proceso no tiene.

### `access-tokens`

Es lo que hoy es `tokens`: archivo de hashes sha256, rol (`viewer`, `editor`, `admin`) para toda la carpeta, sin caducidad.

| Comando | Consulta | Código de hoy |
|---|---|---|
| Crear y revocar, que hoy es `iark auth` y no es una ruta de `serve` | Comprobar el hash de `Authorization: Bearer` y responder `GET /api/whoami` con nombre y rol | `src/cli/tokens.ts`, `src/cli/serveAuth.ts`, `src/cli/auth.ts` |

El archivo de hashes vive en Core. `access-tokens` habla con ese archivo. `serveAuth` frena los intentos fallidos; esa regla queda en Core, y Host solo entrega la cabecera.

`GET /api/whoami` sigue siendo una ruta. Con token responde desde `access-tokens`. Con sesión responde desde `accounts`. Sin autenticación configurada, el comportamiento actual (`{ auth: false }` cuando no hay tokens ni cuentas) se conserva en Host, que no inventa una persona.

### App y gateway

`diagrams-app` y `diagrams-gateway` validan. No abren el archivo de hashes ni el almacén de personas. Preguntan a este proceso si la credencial vale y qué rol trae. La PR de implementación de esta spec hace esa extracción. Las de las specs 002 y 003 no se llevan el almacén.

## alternativas descartadas

- Negar Nano porque la card no escribe `accounts` ni `access-tokens`. Esos nombres son del corte, no de la card.
- Atribuir el CQRS a `backend-nano`.
- Añadir puertos o una capa Infrastructure para separar comandos y consultas.
- Copiar los extension methods del ADR .NET al proceso Node.
- Partir `accounts` y `access-tokens` en dos procesos. La 001 los deja en el mismo Core. La card, en el riesgo que la 001 ya anotó, deja de ser Nano si hay más de un contexto funcional partido.
- Dejar los hashes o las sesiones dentro de `diagrams-app` o del gateway.
- Abrir una ruta HTTP nueva para crear y revocar tokens. Eso sigue en `iark auth`.

## criterios de aceptación comprobables

De este borrador:

1. La línea de la sección estado es `` `borrador` ``.
2. No existe `examples/diagrams-to-be.json`. El as-is no cambia en esta PR. El diff no toca `src/`, `packages/`, `schema/`, `public/`, pruebas ni `deploy/`.
3. Las capacidades citan `backend-nano` como estilo y `backend-coredomain` como origen de la separación de comandos y consultas, con los `path` de la spec 001. El texto no dice que la card nano mencione CQRS.
4. La decisión deja Host y Core por fuera, el CQRS dentro de Core, sin tercera capa y sin puertos, y el almacén de cuentas y los hashes dentro de Core.
5. Los ids citados están en `examples/diagrams-as-is.json`.

De la implementación, solo con la spec `aceptada` y en su PR:

1. El proceso de identidad no sirve `/api/modules`, `/api/<módulo>/validate` ni el CRUD de diagramas. Sí sirve las rutas de la tabla de esta spec.
2. El código de Core no importa tipos de respuesta HTTP del Host.
3. No aparece una interfaz hexagonal de almacén ni una carpeta Infrastructure de este proceso. Los tres almacenes de cuentas y el archivo de hashes se usan desde Core.
4. `npm run cli -- validate examples/diagrams-as-is.json` sigue en 59 elementos, 112 relaciones, 7 vistas y 0 avisos, salvo corrección factual de otra spec aceptada.
5. Pasan `src/cli/serveAuth.test.ts`, `src/cli/tokens.test.ts`, `src/cli/serveAccounts.test.ts`, `src/cli/serveAccountsPostgres.test.ts`, `src/cli/serveAccountsSqlite.test.ts`, `src/cli/serveMembers.test.ts`, `src/cli/serveQuotas.test.ts` y las pruebas de `src/cli/accounts/`.
6. La PR pone la spec en `en curso` y la cierra en `hecha`. No mezcla la 002 ni la 003.

## verificación

Borrador, sin implementación. Citas tomadas de la spec 001, incluida la relectura en la que `backend-nano` volvió sin «CQRS», «comando» ni «consulta». Esta sesión no llamó al puente. `GetDynamicTools` con patrón `ece` no devolvió namespace. No se imprimen `ECE_MCP_API_KEY` ni `ECE_MCP_URL`.

```text
npm run cli -- validate examples/diagrams-as-is.json
Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).
```

`examples/diagrams-to-be.json` no está. `git diff --stat -- src packages schema public examples` no imprime nada.

## riesgos

- Leer el CQRS interno como tercera capa o como puertos. La forma exterior sigue siendo Host y Core, y el almacén sigue dentro de Core.
- Separar después `accounts` y `access-tokens` en dos contextos y salir del alcance que la card llama Nano. La decisión los deja juntos.
- Hacer que el gateway o la app abran `tokens.ts` o `jsonStore.ts` «mientras tanto» y dejar dos dueños del hash.
- Filtrar el Core con tipos de `ServerResponse` o de `HttpError` definidos para el Host.
