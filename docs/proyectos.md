# Proyectos

[← Índice de la documentación](indice.md)

Un proyecto agrupa diagramas de cualquier módulo de la suite para guardarlos, comprobarlos y trazarlos juntos. Hay tres sitios donde viven: una **carpeta de trabajo** (CLI y `iark serve`, pensada para ir en git), **este navegador** (IndexedDB, desde el banco de trabajo y el editor C4) y un **servidor propio** al que se conecta el navegador (con tokens o con inicio de sesión de GitHub); ese servidor puede guardarlos en su carpeta o, si no tiene disco persistente, en una **base Postgres** ([abajo](#proyectos-en-postgres-un-servicio-sin-disco-persistente)). Todos comparten el mismo archivo único de proyecto (`iark.project/1`).

## Proyectos (espacio de trabajo en carpeta)

Un **proyecto** agrupa diagramas de cualquier módulo de la suite (los de seguridad, plataforma e integración de un mismo sistema, por ejemplo) para guardarlos, comprobarlos y trazarlos juntos. En el CLI y en `iark serve` los proyectos viven en una **carpeta de trabajo** corriente, pensada para ir en git:

```
iark-workspace/                          la carpeta de trabajo: --workspace <carpeta>, IARK_WORKSPACE o, por omisión, ./iark-workspace
  tienda-web/                            un proyecto = un directorio; su nombre es el id del proyecto
    project.json                         opcional: nombre, descripción y nombre de cada diagrama (iark.project.meta/1)
    seguridad-ejemplo.security.json      un diagrama = el JSON de su módulo, tal cual: <id>.<módulo>.json
    plataforma-ejemplo.platform.json     (el mismo documento que entiende `iark validate --module platform`)
    pedidos-integracion.integration.json
```

- **La carpeta es la fuente de verdad.** Un directorio sin `project.json` ya es un proyecto (se llama como el directorio) y un `x.<módulo>.json` copiado a mano ya es un diagrama (se llama `x` y su fecha de creación es la de modificación del archivo), aunque no figure en el sidecar. Lo que no encaja se ignora sin fallar: otros archivos, directorios ocultos (`.git`), `node_modules`, ids o módulos inválidos, un `*.iark-project.json` y todo lo que no sea un archivo o directorio normal. Si dos archivos tienen el mismo id con distinto módulo (`x.c4.json` y `x.data.json`) se usa el primero por orden alfabético.
- **Ids.** El id de un proyecto o de un diagrama es un solo segmento de ruta (letras ASCII, dígitos, `_`, `-` y `.`, sin empezar ni acabar en punto, sin `..` y sin nombres reservados de Windows como `con` o `nul`). Al crear, sale del nombre sin tildes ni símbolos (`Gestión de pedidos` → `gestion-de-pedidos`) y se numera si ya está tomado (`gestion-de-pedidos-2`). **Renombrar solo cambia el nombre del sidecar**: el directorio y el archivo no se mueven, así que las rutas que otros hayan escrito en scripts siguen valiendo. No puede haber dos proyectos con el mismo nombre ni dos diagramas con el mismo nombre en un proyecto (sin distinguir mayúsculas).
- **Seguridad del disco.** Ningún id que llegue de fuera (línea de comandos o HTTP) puede salir de la carpeta de trabajo: se valida antes de tocar el disco y se comprueba que el destino queda dentro. **No se siguen enlaces simbólicos** (los de directorios y archivos se ignoran, aunque apunten dentro de la carpeta), y borrar un proyecto quita los enlaces que contenga, no lo que hay al otro lado.
- **Escrituras atómicas y concurrencia.** Cada guardado va a un temporal del mismo directorio y se publica con `rename` (nadie lee un archivo a medias); los diagramas nuevos se publican sin pisar uno existente, así que dos procesos (el CLI y `iark serve`) pueden trabajar en la misma carpeta. La fecha `updatedAt` de un diagrama es la de modificación de su archivo, con milisegundos, y crece siempre al guardar. Con `ifUpdatedAt` (API HTTP) un guardado falla con `conflict` si otro cambió el diagrama en medio.

```bash
iark project create "Tienda web" --description "Pedidos y pagos"
iark project add "Tienda web" examples/seguridad-ejemplo.json      # el módulo se deduce; también --module security, --name "Amenazas"
iark project add tienda-web examples/plataforma-ejemplo.json
iark project add tienda-web examples/pedidos-integracion.json
iark project list                                                  # proyectos y diagramas (módulo, nombre, fecha); --json para otras herramientas
iark project show tienda-web
iark project check tienda-web                                      # cada diagrama (esquema y reglas de su módulo) y las referencias URN entre ellos
iark project trace tienda-web --from integration:pedidos --direction referrers   # como `iark trace`, con los diagramas del proyecto
iark project trace tienda-web --orphans --matrix --coverage "security:asset -> platform" --strict   # huérfanos, matriz y cobertura de los diagramas del proyecto
iark project export tienda-web -o tienda.iark-project.json         # el proyecto entero en un solo archivo (iark.project/1)
iark project import tienda.iark-project.json -w otra-carpeta       # lo crea en otro espacio de trabajo (nunca pisa uno existente)
iark project copy tienda-web seguridad-ejemplo --to otro-proyecto
iark project get tienda-web seguridad-ejemplo -o amenazas.json
iark project delete tienda-web --yes                               # borra el directorio entero; sin --yes no hace nada
```

Todos los subcomandos aceptan `-w, --workspace <carpeta>`; los proyectos y los diagramas se indican por id o por nombre.

| Subcomando | Qué hace |
|---|---|
| `list [--json]` · `show <proyecto> [--json]` | Proyectos y diagramas (módulo, nombre, fecha) |
| `create <nombre> [--description]` · `rename <proyecto> <nuevo-nombre>` · `delete <proyecto> --yes` | Ciclo de vida del proyecto (`delete` borra su directorio entero; no pide confirmación interactiva) |
| `add <proyecto> <archivo\|-> [--module] [--name] [--force] [--update]` | Añade un diagrama. Sin `--module` el módulo sale del nombre `x.<módulo>.json` o del único módulo cuyo esquema acepta el documento **sin descartar ninguno de sus campos** (si ninguno o varios, error de uso con la lista). Con `--module` un documento que no cumple el esquema se rechaza con la lista de errores, salvo `--force` (se guarda como borrador). Un nombre repetido da `exists`; con `--update` reemplaza el diagrama del mismo módulo conservando su id y su nombre |
| `get <proyecto> <diagrama> [-o]` · `rename-diagram` · `remove <proyecto> <diagrama> --yes` · `copy <proyecto> <diagrama> [--to] [--name]` | Operaciones sobre un diagrama |
| `export <proyecto> [-o]` · `import <archivo\|-> [--name]` | Archivo único del proyecto (`-o` puede ser una carpeta: se llama `<proyecto>.iark-project.json`) |
| `check <proyecto> [--strict] [--json]` | Una línea por diagrama y las referencias rotas, ambiguas y sin resolver. Código 3 si hay diagramas inválidos, errores de las reglas de un módulo o referencias rotas o ambiguas; `--strict` también con avisos de los módulos o referencias sin resolver (a un módulo sin diagrama en el proyecto) |
| `trace <proyecto> [--from] [--direction] [--depth] [--format markdown\|mermaid\|svg\|json] [--type] [--orphans] [--matrix] [--coverage] [--min-coverage] [--strict] [--strict-unresolved] [-o]` | La trazabilidad de `iark trace` (enlaces tipados, huérfanos, matriz y cobertura: ver [Trazabilidad](trazabilidad.md)) con los diagramas del proyecto. Una URN (`urn:iark:<módulo>:<id>`) se resuelve en todo el proyecto, y si dos diagramas del mismo módulo definen el mismo id, se marca como ambigua. Un diagrama que no se puede leer se deja fuera con un aviso |

Los errores de uso (proyecto o diagrama que no existe, nombre repetido, documento inválido, falta `--yes`) salen con código 2 y un mensaje de una línea; las comprobaciones fallidas, con 3; un disco o una carpeta inaccesibles, con 1.

### API HTTP de proyectos

`iark serve --workspace <carpeta>` (o `IARK_WORKSPACE`) añade la API de proyectos sobre la misma carpeta (o, con `--workspace-store postgres`, sobre una base: [abajo](#proyectos-en-postgres-un-servicio-sin-disco-persistente)); sin ninguna de las dos esas rutas responden 404 «Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)». El manifiesto de la instancia anuncia entonces `"projects": "../api/projects"` y `"projectsAuth": "none"` (`"bearer"` con tokens: ver [Servidor para varias personas](servicio.md#servidor-para-varias-personas-nube-autoalojada)). Todo es JSON salvo el archivo único del proyecto; los ids son los de la carpeta (`tienda-web`, `seguridad-ejemplo`).

| Ruta | Descripción |
|---|---|
| `GET /api/projects` · `POST /api/projects` | Lista (con diagramas, sin documentos) · crea `{ name, description? }` (201) |
| `GET\|PATCH\|DELETE /api/projects/<p>` | Resumen · renombra `{ name }` · borra |
| `POST /api/projects/<p>/diagrams` | Crea `{ module, name?, text }` (201) |
| `GET\|PUT\|PATCH\|DELETE /api/projects/<p>/diagrams/<d>` | `{ ...meta, text }` · guarda `{ text, ifUpdatedAt? }` (el diagrama debe existir) · renombra `{ name }` · borra |
| `GET /api/projects/<p>/diagrams/<d>/versions` | El historial del diagrama (más reciente primero, sin documentos): [Historial de versiones](#historial-de-versiones) |
| `GET /api/projects/<p>/diagrams/<d>/versions/<v>` | Una versión con su documento (`{ ...meta, text }`) |
| `POST /api/projects/<p>/diagrams/<d>/versions/<v>/restore` | Restaura esa versión como versión **nueva** `{ ifUpdatedAt? }` → `{ diagram, version, unchanged }` |
| `PATCH /api/projects/<p>/diagrams/<d>/versions/<v>` | Nombra la versión `{ label }` |
| `DELETE /api/projects/<p>/diagrams/<d>/versions/<v>` | Borra una versión **con nombre** (solo `admin`) |
| `GET /api/projects/<p>/bundle` | El archivo único (`Content-Disposition` con `<proyecto>.iark-project.json`) |
| `POST /api/projects/import[?name=]` | Cuerpo: ese archivo → crea un proyecto nuevo (201) |
| `GET /api/projects/<p>/check` | La comprobación del proyecto (`checkProject`) |
| `GET /api/events[?project=<p>]` | Canal de cambios en tiempo real (SSE; no cuelga de `/api/projects`): [Cambios en tiempo real](servicio.md#cambios-en-tiempo-real-get-apievents) |

Códigos: `not-found` 404, `exists` 409, `conflict` 409, `invalid` 400, `limit` 409 (tope de versiones con nombre; con `--accounts`, también las [cuotas de uso](cuentas-github.md#cuotas-de-uso): proyectos por persona, diagramas por proyecto y espacio, con `quota`, `used` y `limit` en el cuerpo), `unsupported` 501 (almacén sin historial), `unavailable` 500; el cuerpo es `{ "error": "…", "code": "…" }`. Un cuerpo que pasa de `maxBodyBytes` (5 MB) da 413.

**Cuotas** (solo con `--accounts`): crear o importar un proyecto, crear un diagrama y guardar uno pueden responder `409 limit` si la persona que posee el proyecto llegó a su tope; borrar, renombrar, restaurar versiones y guardar sin crecer no se rechazan nunca. `GET /api/usage` dice cuánto usa quien pregunta y cuánto puede usar. Qué se cuenta, a quién se cobra, los topes y sus límites: [Cuotas de uso](cuentas-github.md#cuotas-de-uso).

**Seguridad (sin `--tokens`: solo para una persona, en su máquina).** `iark serve` escucha en localhost y una página ajena abierta en el navegador podría intentar leer o escribir en el disco del usuario a través de él. En las rutas de proyectos (y solo en ellas):

- POST, PUT, PATCH y DELETE exigen `Content-Type: application/json` (415 si no): un formulario o un `fetch` `no-cors` no pueden enviarlo. Se admiten parámetros (`; charset=utf-8`); DELETE también lo exige, con el cuerpo vacío.
- Una petición con cabecera `Origin` se rechaza con 403 salvo que su host (y puerto) coincidan con la cabecera `Host` o esté en `--cors`. Un `*` en `--cors` no basta para esta API: hay que nombrar el origen (`--cors https://mi-app.example`). Solo a esos orígenes se les anuncian `PUT`, `PATCH` y `DELETE` en `Access-Control-Allow-Methods`.
- Si la conexión llega por loopback, la cabecera `Host` debe ser `localhost`, `127.0.0.1` o `[::1]` (con o sin puerto); si no, 403 (protección contra el *DNS rebinding*). Esa comprobación solo es posible en loopback: con un espacio de trabajo, `iark serve --host 0.0.0.0` (o cualquier `--host` que no sea de loopback) **no arranca sin `--tokens`** (código 2). Para exponerlo a otras personas, use tokens: ver [Servidor para varias personas (nube autoalojada)](servicio.md#servidor-para-varias-personas-nube-autoalojada).
- Los ids se validan antes de tocar el disco (400 si no son un id válido) y los errores de disco no revelan rutas.

Con `--tokens` esta lista cambia (no hay `Host` ni `Origin` que comprobar, pero sí token y rol): ver [Servidor para varias personas](servicio.md#servidor-para-varias-personas-nube-autoalojada).

## Proyectos en Postgres (un servicio sin disco persistente)

`iark serve` guarda los proyectos en una carpeta, y una plataforma como Render, con disco **efímero**, la vacía en cada despliegue o reinicio: el servicio perdería todos los proyectos. Con `--workspace-store postgres` (o `IARK_WORKSPACE_STORE=postgres`) los proyectos, sus diagramas y su historial de versiones viven en una base **Postgres** (Supabase, Neon, RDS…) y el servicio no necesita disco. La API HTTP, los roles, las cuentas, las cuotas y la interfaz son exactamente los mismos; lo único que cambia es dónde se guarda.

```bash
export IARK_DATABASE_URL='postgres://usuario:clave@host:5432/postgres'   # solo por entorno: ver postgres.md
iark serve --workspace-store postgres --host 0.0.0.0 --tokens tokens.json   # o --accounts …
```

- **Sin carpeta, y la conexión solo del entorno.** Con `postgres` no se indica `--workspace` (ni `IARK_WORKSPACE`: si están las dos cosas, el servicio no arranca y lo dice). La cadena de conexión lleva la contraseña, así que nunca va en la línea de comandos: `IARK_DATABASE_URL` (o `IARK_DATABASE_URL_FILE`), con `IARK_DATABASE_SSL`, `IARK_DATABASE_CA_FILE`, `IARK_DATABASE_POOL` y `IARK_DATABASE_SCHEMA` ([Postgres](postgres.md#configuración-solo-por-entorno)). Al arrancar crea o actualiza sus tablas (migraciones del almacén «proyectos») y, al apagar con `SIGTERM`, cierra la conexión.
- **Qué guarda.** Tres tablas en el esquema `iark` (no `public`): `proyectos`, `diagramas` y `versiones`. El documento de cada diagrama (y el de cada versión) es una columna `text` con **el JSON exacto**, no `jsonb`: `jsonb` reordenaría las claves y cambiaría los espacios, y con ellos el hash y los bytes. Lo que se guarda es, carácter por carácter, lo que se lee (también un borrador que no es JSON, el BOM y los saltos de línea). Los bytes de cada documento y de cada versión se guardan aparte para medir las cuotas sin leer los documentos.
- **La misma semántica que la carpeta.** Pasa las mismas pruebas de contrato que el almacén de carpeta y el de memoria: ids que salen del nombre (`tienda-web`, `tienda-web-2`…), nombres que no se repiten sin distinguir mayúsculas, el tope de 16 MB por documento, `ifUpdatedAt` (conflicto `409` si alguien guardó en medio), y todo el [historial de versiones](#historial-de-versiones) (coalescencia, retención, nombrar, borrar, restaurar) con la misma política y las mismas variables `IARK_VERSIONS…`.
- **Varias réplicas.** Cada operación que escribe es **una transacción**. Guardar un diagrama bloquea su fila y comprueba `ifUpdatedAt` con lo que hay en la base en ese instante: dos guardados con la misma marca, aunque lleguen a procesos distintos, dejan uno guardado y el otro en conflicto; los diagramas distintos no se esperan entre sí. Crear, renombrar y borrar proyectos y diagramas están serializados por proyecto (no hay dos ids iguales ni dos nombres repetidos), y un índice único de nombres es la última red.
- **Salud.** `/readyz` comprueba la base con una consulta (la comprobación `workspace` pasa a significar «la base contesta») en lugar de mirar que la carpeta sea escribible. Si la base se cae, la API responde `500` «El espacio de trabajo no está disponible» sin decir dónde está la base, y el detalle (sin contraseña) va al registro de errores.
- **Cuotas.** `iark serve --accounts` mide los proyectos de Postgres igual que los de carpeta (`documentUsage` suma los bytes de los documentos y `versionUsage` los de las versiones; el medidor y `/api/usage` no cambian). Los proyectos sin dueña conservan solo el tope de diagramas por proyecto.

### Pasar una carpeta de trabajo a Postgres

```bash
IARK_DATABASE_URL=… iark workspace import --from ./iark-workspace --dry-run   # solo cuenta lo que pasaría (no toca la base)
IARK_DATABASE_URL=… iark workspace import --from ./iark-workspace
```

Lee la carpeta con el mismo almacén de siempre y escribe en la base **conservando los ids** de proyectos y diagramas (las pertenencias de `--accounts`, los enlaces y los scripts siguen valiendo), los nombres, las descripciones, las **fechas** y el **historial de versiones** con sus ids, etiquetas y autores. Cada proyecto entra en una sola transacción: o entero o nada. Es **idempotente**: un proyecto que ya está en la base (mismo id, sin distinguir mayúsculas) se omite, así que se puede repetir sin miedo; `--replace` lo borra y lo vuelve a crear desde la carpeta. Si otro proyecto de la base ya se llama igual (con otro id) se omite y se avisa; si dos diagramas de la carpeta tenían el mismo nombre (editada a mano) el segundo se numera (`Nombre (2)`). Un proyecto que falla no impide los demás (el comando termina con código 1 y lo cuenta). La carpeta solo se lee, nunca se modifica.

Para llevar **un solo proyecto**, o en sentido contrario (de Postgres a una carpeta o a otro servicio), sirve el archivo único: `GET /api/projects/<p>/bundle` descarga el proyecto y `POST /api/projects/import` lo crea (o «Exportar» e «Importar» en la interfaz). El archivo único **no lleva el historial** y el proyecto importado recibe un id nuevo.

### Límites

- **`iark project …` del CLI sigue operando sobre carpetas** (`-w, --workspace <carpeta>`): no se conecta a Postgres. Para trabajar desde la línea de comandos con los proyectos de un servicio hay que usar su API (`GET /api/projects/<p>/bundle`, `POST /api/projects/import`) o la interfaz web conectada a ese servidor.
- **Las cuotas se miden fuera de la transacción del guardado.** La comprobación previa (`2 × nuevo − actual`) y el uso que se muestra son una medida con caché de 30 s, no parte de la transacción: con varias réplicas, dos guardados simultáneos de la misma persona pueden pasarse del tope por lo que guardan a la vez (dentro de un proceso van de uno en uno).
- **Documentos grandes.** El tope es el de siempre, 16 MB por documento, y cada guardado escribe el documento **y** la versión que anota (casi el doble de bytes), más el documento anterior si hay que registrarlo como línea base. El plan gratuito de Supabase tiene 500 MB de base: con documentos de megabytes y hasta 150 versiones por diagrama se llena pronto. Mantenga las cuotas por persona (`--max-bytes`, 256 MB por omisión) y baje `IARK_VERSIONS_KEEP` si hace falta. Un documento de varios megabytes por una conexión lenta puede pasar de los 20 s que se espera a cada consulta y fallar con «Postgres no está disponible»; vuelva a guardar. El carácter NUL (U+0000) sin escapar no cabe en un `text` de Postgres y se rechaza (un JSON válido lo lleva escapado, `\u0000`).
- **Los avisos en tiempo real (`/api/events`) son de un proceso**, como con la carpeta: con varias instancias, cada una avisa solo de lo que pasa por ella (el pooler de transacción de Supabase no admite `LISTEN`); los clientes de las demás se enteran al sondear (cada 30 s). Con una sola instancia, como en Render, funcionan igual.
- **Los relojes.** `updatedAt` y las fechas de las versiones salen del reloj del proceso que guarda; por diagrama `updatedAt` es siempre estrictamente creciente aunque dos réplicas tengan relojes distintos, pero la ventana de coalescencia del historial se mide con ellos.
- **No edite las tablas a mano.** El hash y los bytes de cada documento y el contador de versiones se guardan al escribir; cambiar `documento` con SQL los deja desfasados (el historial lo tomaría por contenido distinto). Para cambiar proyectos use la API.
- **La importación** no puede conservar el contador de ids de versiones ya descartadas (la carpeta no lo expone): sigue desde la mayor versión que se importó, así que el id de una versión descartada antes de importar podría reutilizarse. Un proyecto de la carpeta con un documento que lleve NUL no entra.
- Probado contra un Postgres 16 local. Con Supabase de verdad (TLS con su CA, su pooler) no se ha probado desde aquí: ver los límites de [Postgres](postgres.md#probar-contra-un-postgres-de-verdad).

## Historial de versiones

Cada guardado de un diagrama deja una **versión**: una copia inmutable de su documento que se puede ver, comparar con el diagrama de ahora, **restaurar** y **nombrar**. Funciona igual en los tres sitios donde viven los proyectos (carpeta de trabajo, este navegador y servidor propio) y desde la API, el CLI y la interfaz.

### Modelo y política

- **Una versión** lleva un `id` entero que crece de uno en uno dentro de cada diagrama (**no se reutiliza** aunque la versión se descarte o se borre), `savedAt` (ISO 8601), `savedBy` (quién la guardó, si se sabe), `label` (el nombre, si lo tiene), `size` (bytes del documento), `hash` (SHA-256 del documento) y `restoredFrom` (la versión de la que se restauró, si es el caso). Un documento guardado nunca se modifica: el historial solo crece, se rota o se borra una versión con nombre.
- **Coalescencia.** Si la **misma persona** vuelve a guardar el diagrama antes de `coalesceSeconds` (30 por omisión) desde la primera versión de la serie, el guardado **sustituye** a la última versión automática en lugar de añadir otra: el autoguardado de la interfaz no inunda el historial. Una versión **con nombre** o **restaurada** nunca se sustituye, y una persona distinta (otro `savedBy`) siempre añade una versión nueva.
- **Retención.** Se conservan las últimas `keepAutomatic` versiones automáticas (50) más las nombradas, hasta `maxVersions` en total (150): quedan 100 para las nombradas. Al pasarse se descarta la automática más antigua; la versión más reciente (el estado actual) nunca se descarta. Dar nombre a una versión cuando ya no caben más nombradas falla con `limit` (409): borra una o usa otra.
- **Quién guarda** lo decide el servidor, nunca el cuerpo de la petición: el nombre del token (`--tokens`) o `@usuario` de GitHub (`--accounts`). En la carpeta de trabajo con el CLI, sin identidad, `savedBy` no se anota.
- **Restaurar** guarda el contenido de la versión como una **versión nueva** (`restoredFrom` apunta a la original): el historial anterior no se toca, así que restaurar se deshace restaurando la versión que había antes. Si el diagrama ya tiene ese contenido no se guarda nada (`unchanged: true`). Con `ifUpdatedAt` falla con `conflict` si otra persona guardó el diagrama en medio, como cualquier guardado.
- **Un almacén que no guarda historial lo declara** (`keepsVersions: false`, o el servidor responde 501 `unsupported`) y la interfaz no ofrece «Historial…»: el diagrama se guarda con normalidad.
- **Cuotas.** El historial **cuenta para la cuota de espacio** de quien posee el proyecto: `versionUsage(proyecto)` devuelve `{ versions, bytes }` (la suma de `size` de todas las versiones) y el servicio con cuentas lo suma a los documentos actuales ([Cuotas de uso](cuentas-github.md#cuotas-de-uso)). Restaurar y borrar versiones con nombre nunca se rechazan por cuota (borrar libera espacio; restaurar queda acotado por la rotación). Sin cuentas (la carpeta con el CLI, o `--tokens`) no hay cuotas y el historial solo lo acotan sus topes de versiones.

### Dónde se guarda

| Almacén | Dónde | Configuración |
|---|---|---|
| Carpeta de trabajo (`iark project`, `iark serve --workspace`) | `<proyecto>/.versiones/<diagrama>/` | Variables de entorno de abajo |
| Postgres (`iark serve --workspace-store postgres`) | La tabla `versiones` del esquema `iark`, con el documento de cada versión | Las mismas variables de entorno de abajo ([Proyectos en Postgres](#proyectos-en-postgres-un-servicio-sin-disco-persistente)) |
| Este navegador | IndexedDB, en los almacenes `versions`, `versionTexts` y `versionState` de la misma base de los proyectos | Política por omisión |
| Servidor propio | El del servidor (el navegador usa la API) | Las variables de entorno del servidor |

En la carpeta de trabajo cada diagrama tiene un directorio `.versiones/<diagrama>/` con un `index.json` (`iark.versions/1`: los metadatos de cada versión y el mayor `id` dado hasta ahora) y un `NNNNNN.json` por versión con el documento. Son directorios ocultos, así que **`iark project list`, `check`, `export` e `import` no los ven** (un directorio oculto se ignora, igual que `.git`) y siguen funcionando igual. Todo se escribe de forma atómica (temporal y `rename`) y, si el historial se estropea (un `index.json` ilegible o demasiado grande), se ignora: el diagrama sigue guardándose y el historial vuelve a empezar desde el contenido actual.

- **¿En git?** El historial es **local a cada equipo y ocupa disco** (hasta 150 copias por diagrama): normalmente no interesa versionarlo si el proyecto ya va en git. Añade `.versiones/` a tu `.gitignore` o déjalo: no afecta a nada más.
- **El historial no viaja en el archivo único** (`iark project export`/`import` y «Exportar» de la interfaz solo llevan el contenido actual) ni se copia con *Copiar a…*: un proyecto importado empieza con el historial vacío.
- **Una escritura a la vez.** La coalescencia y la retención leen y escriben el historial sin bloqueo entre procesos: dos procesos (el CLI y `iark serve`) guardando el mismo diagrama exactamente a la vez pueden perder una versión del historial, nunca el diagrama. Lo usual (un proceso, o guardados en momentos distintos) no se ve afectado.

| Variable | Qué hace |
|---|---|
| `IARK_VERSIONS=off` | No guarda historial en la carpeta de trabajo (los comandos de historial dicen que está desactivado y la API responde 501) |
| `IARK_VERSIONS_COALESCE=<segundos>` | `coalesceSeconds`: de 0 (cada guardado es una versión) a 3600 |
| `IARK_VERSIONS_KEEP=<n>` | `keepAutomatic`: de 1 a 1000 |
| `IARK_VERSIONS_MAX=<n>` | `maxVersions`: mayor que `IARK_VERSIONS_KEEP`, hasta 5000 |

Un valor que no es un número del rango se rechaza al abrir la carpeta (código 2 en el CLI, el servicio no arranca).

### API

Las cinco rutas de [la API de proyectos](#api-http-de-proyectos) cuelgan de un diagrama y usan **los mismos roles y reglas de seguridad** (tokens, cuentas, `Origin`, `Content-Type: application/json` en `POST`/`PATCH`/`DELETE`, límites de cuerpo):

| Petición | Rol mínimo | Respuesta |
|---|---|---|
| `GET …/versions` | `viewer` | `VersionMeta[]`, la más reciente primero (sin documentos) |
| `GET …/versions/<v>` | `viewer` | `{ ...meta, text }`; 404 `not-found` si ya no existe |
| `POST …/versions/<v>/restore` `{ ifUpdatedAt? }` | `editor` | `{ diagram, version, unchanged }`; 409 `conflict` si `ifUpdatedAt` no es el vigente |
| `PATCH …/versions/<v>` `{ label }` | `editor` | La versión con su nombre; 409 `limit` si ya hay tantas nombradas como caben |
| `DELETE …/versions/<v>` | **`admin`** | `{ deleted: <v> }`; solo versiones **con nombre** (una sin nombre se descarta sola; 400 si no tiene nombre) |

Con `--accounts` el rol es el de la persona en ese proyecto; un proyecto al que no se pertenece responde 404 y un rol que no alcanza, 403, antes de leer el cuerpo. Un servidor anterior al historial responde 404 sin `code` en estas rutas y el cliente lo trata como `unsupported`. La auditoría ([observabilidad.md](observabilidad.md)) anota restaurar, nombrar y borrar versiones.

### CLI

```bash
iark project history tienda-web pedidos                  # versiones del diagrama: #, fecha, quién, tamaño y nombre; --json
iark project diff tienda-web pedidos 2                   # qué cambió de la versión #2 al contenido actual (mismo motor y formatos que `iark diff`)
iark project diff tienda-web pedidos 2 5 --format markdown --exit-code
iark project label tienda-web pedidos 2 "Entrega 1"      # le da nombre: ya no se sustituye ni se descarta sola
iark project restore tienda-web pedidos 2                # el contenido de la #2 pasa a ser el actual, como versión NUEVA
iark project delete-version tienda-web pedidos 2 --yes   # borra una versión con nombre
```

En lugar de un número, `diff` acepta `actual` (el contenido de ahora). Todos aceptan `-w, --workspace <carpeta>` y el proyecto y el diagrama por id o por nombre. El CLI no tiene identidad: sus versiones no llevan `savedBy`, y por eso **varios guardados seguidos desde el CLI en menos de `coalesceSeconds` se funden en una versión** (`IARK_VERSIONS_COALESCE=0` para que cada guardado cuente). Los errores de uso (versión inexistente, historial desactivado, falta `--yes`) salen con código 2.

### En la interfaz

«Historial…» aparece, con un diagrama de un proyecto abierto en un almacén que guarda historial, en la **barra del proyecto** del banco de trabajo y en el **editor C4** (botón «Historial…» del encabezado y entrada «Historial de versiones…» del menú *Archivo*). Abre un cuadro de diálogo (foco atrapado, `Esc` lo cierra y devuelve el foco al botón, flechas para moverse por la lista; en móviles de hasta 700 px ocupa la pantalla):

- La **lista** de versiones, la actual marcada, con fecha, quién la guardó, su nombre y si es una restauración.
- **Qué cambió**: con una versión elegida (por omisión, la última distinta de la actual) se compara con el diagrama de ahora con el mismo motor de `iark diff` (añadidos, quitados, modificados; la maquetación guardada y el orden de las listas no cuentan). Un documento que no se puede leer (un borrador que no es JSON) lo dice en lugar de fallar.
- **Restaurar esta versión** pide confirmación. Si el diagrama está abierto, antes guarda lo pendiente (así lo de ahora queda en el historial) y restaura con la marca que conoce la pestaña: si otra persona guardó mientras tanto, avisa del conflicto y no toca nada. Después el editor se recarga con lo restaurado.
- **Nombrar versión**, y **Borrar esta versión** para quien administra el proyecto. Un lector ve el historial pero no restaura ni nombra (los botones aparecen desactivados y el cuadro dice por qué; el servidor lo impone igualmente).

### Límites

- Sin edición simultánea en tiempo real y sin cola sin conexión (sí hay avisos de cambios: sección 4c de «Guardar en la nube»): el historial se guarda cuando el guardado llega al almacén. Las cuotas de espacio (solo con cuentas) cuentan el historial: [Cuotas de uso](cuentas-github.md#cuotas-de-uso).
- El historial no viaja con el proyecto (exportar, importar, copiar) ni se mezcla entre almacenes.
- Un servidor que no es el de esta versión no ofrece historial (501 / 404): la interfaz lo dice al abrir «Historial…» y el resto sigue como siempre.
- Comparar compara el documento entero de cada módulo; no hay comparación de tres vías ni fusión.

## Proyectos en la app web (este navegador)

Los mismos proyectos de la sección anterior (diagramas de cualquier módulo, agrupados) se usan desde el navegador sin instalar nada: en el **banco de trabajo** (`modulos.html`, botón *Proyectos…*) y en el **editor C4** (*Archivo ▸ Proyectos…*), que comparten almacén. Por omisión viven en **este navegador** (IndexedDB); para guardarlos en un servidor, véase la sección siguiente.

- **El gestor** crea, renombra y borra proyectos; crea un diagrama nuevo (con el ejemplo del módulo o vacío), guarda el documento que estás editando, y abre, renombra, duplica y borra diagramas. No puede haber dos proyectos con el mismo nombre ni dos diagramas con el mismo nombre en un proyecto (sin distinguir mayúsculas).
- **Autoguardado.** Con un proyecto y un diagrama abiertos, cada cambio se guarda tras 500 ms de pausa; la barra del proyecto (banco) y el chip del editor C4 dicen «Guardado en «X»». Sin proyecto abierto todo sigue como antes: un borrador por módulo en `localStorage`, que «Guardar en «X»» convierte en un diagrama del proyecto.
- **Abrir directamente** con `modulos.html?project=<id>&diagram=<id>`; se recuerda el último diagrama abierto. En el editor C4, abrir un diagrama de otro módulo lleva al banco de trabajo con ese enlace.
- **Enlaces entre diagramas.** Las referencias `ref: "urn:iark:<módulo>:<id>"` se resuelven en todo el proyecto: doble clic o Alt+↓ sobre un elemento enlazado abre el diagrama que lo contiene, y Alt+↑ (o la miga de pan) vuelve al anterior.
- **Dos pestañas.** Si otra pestaña guarda el mismo diagrama mientras lo editas, se avisa (`ifUpdatedAt`) y puedes «Quedarme con mi versión» o «Cargar la otra»: no se mezclan cambios. Cargar un ejemplo o importar sobre un diagrama guardado avisa «Se reemplazó el contenido de «X»» y se puede deshacer.
- **Copia de seguridad.** *Exportar* baja el proyecto entero como `<proyecto>.iark-project.json` (`iark.project/1`, el mismo archivo de `iark project export`) e *Importar proyecto* lo recupera sin pisar nada: si el nombre ya existe queda «Nombre (2)». Un proyecto admite hasta 500 diagramas.

Límites: IndexedDB pertenece a **este navegador y a este sitio**. Borrar los datos del sitio, usar otro navegador u otro equipo o una ventana privada deja los proyectos fuera de alcance: **exporta de vez en cuando** o usa un servidor. Con el almacenamiento bloqueado la app dice «Almacenamiento no disponible» y sigue funcionando con borradores.

## Guardar en la nube (servidor propio) desde el navegador

Por omisión los proyectos de la app web viven en **este navegador** (IndexedDB). Para verlos desde otros equipos y compartirlos con otras personas se pueden guardar en un **servidor propio**: el mismo `iark serve --workspace` ([API HTTP de proyectos](#api-http-de-proyectos)), cuya API de proyectos ya es lo que usa el navegador. El servidor es tuyo y su carpeta de trabajo (la misma de `iark project`, pensada para ir en git) es la fuente de verdad; se entra con un token (`--tokens`) o, en una instancia con cuentas (`--accounts`), con **«Iniciar sesión con GitHub»** (ver el paso 2b, «Iniciar sesión con GitHub», más abajo y [Servicio gestionado: inicio de sesión con GitHub](cuentas-github.md)).

**1. Arrancar el servidor.** El navegador solo deja que la página lea las respuestas de otro origen si el servidor lo autoriza, así que hay que darle el origen exacto de la página con `--cors` (sin barra final ni ruta):

```bash
iark serve --workspace ./iark-workspace --cors https://mi-usuario.github.io   # la app publicada
iark serve --workspace ./iark-workspace --cors http://localhost:5173          # desarrollo (npm run dev)
```

- Si sirves el propio sitio desde el servidor (`--static dist/app`), la página y la API comparten origen y `--cors` no hace falta.
- Con `--tokens <archivo>` el servidor exige un token (cabecera `Authorization: Bearer`) y reparte permisos por rol; se configura como se explica en [Servidor para varias personas](servicio.md#servidor-para-varias-personas-nube-autoalojada), que no se repite aquí. Sin él, **quien llegue al puerto lee y escribe los proyectos**: déjalo en `127.0.0.1`.
- `iark serve` **no habla TLS**. Para usarlo por internet pon delante un proxy con https. Y una página publicada por https no puede llamar a una dirección `http://` que no sea la propia máquina (contenido mixto: el navegador lo bloquea, y el gestor lo avisa al escribir la dirección).

**2. Conectar desde el gestor.** *Proyectos… ▸ Dónde se guardan ▸ Conectar a un servidor…* (en el banco de trabajo y en el editor C4, que comparten almacén):

1. Escribe la dirección (`https://iark.ejemplo.org`, `http://localhost:8787`) y, si el servidor lo pide, el token. El nombre es opcional.
2. **Probar conexión** dice quién eres y qué rol tienes, o por qué falla: sin conexión, el navegador rechazó el origen (CORS; te dice con qué `--cors` arrancar el servidor), el servidor no ofrece proyectos (¿sin `--workspace`?), token inválido, sin permiso o demasiados intentos.
3. **Conectar** guarda lo que haya pendiente, anota la configuración y **recarga la página**: es la forma más simple y segura de cambiar de almacén. **Volver a este navegador** lo deshace (los proyectos del navegador no se tocan: estaban aparte).

Con un servidor, la barra del proyecto del banco y el chip del editor dicen «Guardado en «X» · servidor». El último diagrama abierto se recuerda por servidor.

**2b. Iniciar sesión con GitHub (instancias con cuentas).** Si el servidor se arrancó con `--accounts`, *Dónde se guardan* ofrece **Iniciar sesión con GitHub** (y, si abriste la página desde esa misma instancia, su dirección ya aparece escrita). La página va al servidor, a GitHub y vuelve recargada con la sesión; en la barra de direcciones no queda ningún código. **Usar un token** sigue disponible, plegado.

- **Qué se guarda y dónde.** La dirección y el nombre del servidor, en `localStorage` (`iark.projects.backend`), no son secretos. La sesión (`iark_s_…`) va en `localStorage` si dejas marcada **«Mantener la sesión en este equipo»** (marcada por omisión: las sesiones caducan y se pueden cerrar) y en `sessionStorage` si no (solo esa pestaña). El estado `iark.login.pending` existe solo durante el inicio de sesión. Nunca se guarda ninguna credencial de GitHub: el servidor usa su token una vez y lo revoca.
- **Cerrar sesión** la cierra en el servidor (el token deja de valer aunque lo hubieran copiado), olvida el token del navegador y vuelve a «Este navegador», recordando solo la dirección.
- **Si caduca** (o se cierra desde otro sitio), el guardado avisa «Tu sesión caducó», el texto se conserva en pantalla e *Iniciar sesión* la retoma. Mientras no vuelvas a entrar no se reintenta contra el servidor (cada intento fallido cuenta para el freno de la dirección).
- **Roles y compartir.** La lista de proyectos trae tu rol en cada uno y la interfaz lo respeta (un lector no renombra, duplica, borra ni guarda; borrar un proyecto es del administrador). Quien administra un proyecto lo comparte desde **Compartir…** con el usuario de GitHub y un rol (lector, editor, administrador). Si la persona aún no ha entrado queda «pendiente» y lo tendrá al entrar con esa cuenta, también en instancias solo por invitación. Cualquiera puede salir con **Salir del proyecto**; un proyecto no se queda sin administrador. La API detrás es la de [Compartir proyectos](cuentas-github.md#compartir-proyectos).
- **Administrar la instancia.** Si tu rol en la instancia es el de administrador, *Dónde se guardan* trae **Administrar cuentas…**: la lista de cuentas del servicio, con la que invitas por usuario de GitHub, cambias el rol, desactivas o reactivas y cancelas invitaciones. Para las demás personas el botón no existe. Qué muestra, qué errores da y cómo se maneja está en [Pantalla de administración](cuentas-github.md#pantalla-de-administración).
- **Límites.** Iniciar sesión recarga la página: lo que no se pudo guardar se pierde si lo confirmas (antes se pide confirmación y «Cancelar» lo conserva), y no hay ventana emergente. Hace falta https o `localhost` (la comprobación PKCE usa `crypto.subtle`), y el servidor debe aceptar el origen de la página con `--cors` si no es el suyo. Con tokens sin rol la interfaz no limita nada y decide el servidor.

**3. Qué se guarda en el navegador y qué tan seguro es.**

- La dirección y el nombre del servidor, en `localStorage` (`iark.projects.backend`). No son secretos.
- El **token**, por omisión, en `sessionStorage`: solo esa pestaña, y se olvida al cerrarla (si el servidor pide token, una pestaña nueva lo pide otra vez). Con la casilla **«Recordar en este equipo»** (desmarcada por omisión) pasa a `localStorage` y sigue ahí hasta que lo borres; **cualquier script que se ejecute en este sitio podría leerlo**, así que márcala solo en un equipo tuyo. Cada token se guarda junto a su dirección y solo se envía a ella, sin cookies.
- Quien decide quién puede leer o escribir es el servidor, no la página.
- Si el servidor deja de aceptar el token, un guardado lo avisa («El servidor no aceptó el token») con un botón para volver a conectar: el texto pendiente no se pierde y se guarda al dar el token bueno, sin recargar.
- Si el token es válido pero su rol no alcanza (un `viewer` que edita), el guardado avisa «Sin permiso para guardar en el servidor», con el botón «Cambiar de token»: el texto pendiente tampoco se pierde y se guarda al dar un token de `editor`, sin recargar. Las lecturas siguen funcionando.

**4. Copiar entre almacenes.** *Copiar a…* en el detalle de un proyecto lo lleva al otro almacén (del navegador al servidor, o al revés) con el archivo único del proyecto (`iark.project/1`): nunca pisa nada —si el nombre ya existe queda «Nombre (2)»— y, si algo falla a mitad, no deja un proyecto a medias. Sin un servidor conocido, el botón lleva al formulario de conexión, que ofrece copiar sin cambiar de almacén.

**4b. Trabajo sin conexión.** Con los proyectos en un servidor, un corte de red (o un servidor que no contesta) ya no pierde lo que escribes. Cada guardado que no llega al servidor se **conserva en este navegador** (IndexedDB, base `iark-offline`) y se envía solo cuando vuelve la conexión. Con los proyectos en este navegador no hay cola ni cambia nada.

- **Qué se ve.** Junto al nombre del proyecto (banco de trabajo y editor C4) el indicador, que se anuncia como `role="status"`, dice «Guardado», «Guardando…», **«Sin conexión: N cambios pendientes»** o **«Hay un conflicto que resolver»**; a su lado, «Reintentar ahora» y, si hay conflicto, «Resolver el conflicto…». El indicador usa el espacio que ya tenía, así que no mueve la barra; en pantallas de hasta 700 px el texto y los botones se ajustan sin desplazamiento horizontal.
- **Qué se guarda.** Solo el **último estado de cada diagrama** (el texto completo, el servidor y el proyecto al que pertenece, y la marca `updatedAt` del servidor sobre la que escribiste): varios cambios seguidos del mismo diagrama son un único pendiente. **Nunca se guarda el token ni ninguna credencial** en la cola; lo único que lleva es un identificador de quién escribió (`u:<id>` en una instancia con cuentas, `t:<nombre>` con `--tokens`, `open` sin autenticación), que el servidor devuelve en `whoami`.
- **Tope.** La cola admite hasta **8 MiB** y **100 diagramas** distintos. Si lo último no cabe, el aviso lo dice con claridad («Se superó el tope de cambios sin conexión…»), el texto sigue en la pestaña (y el navegador avisa al cerrarla) y no se pierde lo anterior de la cola. Sin IndexedDB (ventana privada, permisos bloqueados) la cola vive solo en memoria: se avisa y el navegador sigue preguntando al cerrar la pestaña.
- **Cuándo se reintenta.** Al volver la conexión (`online`), al volver el foco a la ventana (si pasaron al menos 5 s desde el último intento y la ventana no está oculta), con «Reintentar ahora» y **al reabrir la app** (los pendientes de la sesión anterior se envían solos). Entre tanto, una espera exponencial acotada: 2, 4, 8, 16, 32 y 60 s (con una variación de ±20 % para que varias pestañas no coincidan). Hay **un solo envío activo por diagrama** y los diagramas salen de uno en uno; si la red sigue caída solo se prueba con uno por ronda. Con varias pestañas abiertas un cerrojo (`navigator.locks`) hace que solo una envíe.
- **Lo que no se reintenta en bucle.** Un **401** (token rechazado o sesión caducada) y un **403** (rol que no alcanza) dejan el cambio en la cola y paran: ni el foco, ni la red ni el tiempo lo reintentan (cada 401 cuenta para el freno del servidor, que a los 5 intentos fallidos responde 429); se retoma al dar un token o sesión nuevos. Un **429** se respeta: no se vuelve a intentar antes de lo que pida `Retry-After` (como mínimo 60 s si no lo trae), ni siquiera con el foco o `online`; solo «Reintentar ahora» lo adelanta.
- **De quién es lo pendiente.** Cada cambio lleva el nombre de quien lo escribió y **solo se envía con la credencial de esa misma persona**:
  - Si entras con otra cuenta en el mismo servidor, lo de la anterior no se envía ni se muestra como tuyo: «Dónde se guardan» avisa de que hay cambios sin enviar de otra cuenta, que se conservan aparte y se envían si esa cuenta vuelve; se pueden **descartar a mano** y, si nadie los reclama, **caducan a los 30 días**.
  - **Cerrar sesión descarta** los pendientes de esa persona (no se enviarían con otra cuenta ni conviene dejarlos en un equipo compartido): antes pregunta cuántos son y se confirma («Seguir y descartarlos»).
  - Si en la **misma pestaña** cambias de token porque el actual no sirve para guardar (un lector que pasa a un token de editor), lo que acabas de escribir pasa a la persona del token nuevo; lo que quedó de otra vez u otra persona no se reclama.
  - Cambiar de servidor no mezcla nada: la cola distingue por dirección del servidor.
- **Si otra persona cambió el diagrama mientras tanto.** El envío lleva `ifUpdatedAt` con la marca del servidor sobre la que escribiste; si el servidor la cambió (o borró el diagrama) **no se pisa nada**: tu versión queda en este navegador como «conflicto» y el indicador dice «Hay un conflicto que resolver». «Resolver el conflicto…» abre un cuadro con tres salidas, que usan el mismo teclado y el mismo texto en el banco y en el editor C4:
  1. **Quedarme con la del servidor**: descarta la tuya (se confirma) y carga la versión actual del servidor.
  2. **Quedarme con la mía**: la reenvía sobre lo que hay ahora en el servidor, que se pierde (se confirma). Si mientras decidías llegó otro cambio, vuelve a ser un conflicto en vez de pisarlo.
  3. **Guardar la mía como diagrama nuevo**: crea una copia con otro nombre («Nombre (mi versión)» o el que elijas; si ya existe se numera) y el original conserva lo del servidor.
  Sin red no se puede decidir (hace falta leer el servidor) y no se pierde nada. Un diagrama borrado en el servidor se ofrece como «Descartar la mía» o copia.
- **Pruebas.** `src/projects/offlineQueue.test.ts` y `session.offline.test.ts` (cola, reintentos con reloj simulado, conflicto y sus tres salidas, 401/403/429, identidad) y `tests/e2e/projects-cloud-offline.spec.ts` (Chromium con `context.setOffline(true)` contra un `iark serve` real: corte y recuperación, recarga con pendientes, token rechazado, conflicto, pantalla estrecha y editor C4).

Límites de este trabajo sin conexión: la **lista y la apertura de proyectos siguen necesitando al servidor** (una página que arranca sin red muestra el servidor como no disponible y no reabre sola el proyecto cuando vuelve: recarga con conexión), dos pestañas que editan el mismo diagrama sin red pueden acabar en un conflicto, cada envío es el documento entero y la cola no sustituye a una copia de seguridad (es la de un solo navegador). No es edición en tiempo real ni historial de versiones. Con cuotas ([Cuotas de uso](cuentas-github.md#cuotas-de-uso)), un guardado en cola que el servidor rechaza por superar el tope no se pierde ni se reintenta en bucle: queda aparcado como «rechazado», con el mensaje del servidor, y se puede conservar, copiar a un diagrama nuevo o descartar.

**4c. Cambios de otras personas, en tiempo real.** Con los proyectos en un servidor que lo ofrece, la pestaña recibe un aviso en cuanto otra persona (u otra pestaña, u otro equipo) cambia algo: la lista de proyectos se actualiza sola y, si el cambio es del diagrama que tienes abierto, aparece «**@beto guardó una versión más nueva de «Ventas»**» con dos botones, «Cargar la nueva» e «Ignorar». **No es edición colaborativa**: no se mezclan cambios y no se toca nunca lo que estás escribiendo.

- **Qué avisa.** Un diagrama creado, guardado, renombrado, borrado o restaurado desde el historial, y un proyecto creado, renombrado, borrado o cuyos miembros cambian. El aviso lleva solo identificadores, la marca `updatedAt` y quién lo hizo: **nunca el documento ni el nombre** (la pestaña los lee con sus permisos de siempre).
- **El aviso de versión más nueva.** Vive en una región `role="status"` (`aria-live="polite"`) que está siempre en la página y vacía mientras no hay nada, para que un lector de pantalla anuncie el texto cuando aparece; los botones se alcanzan con el teclado y, al cargar, el foco pasa a la región, que anuncia «Se cargó la versión nueva de «X»». «Ignorar» lo quita hasta que haya otra versión aún más nueva. Está en el banco de trabajo y en el editor C4.
- **Qué NO hace.** Si en esta pestaña hay algo sin guardar (escribiendo, guardando, o pendiente en la cola sin conexión), **el aviso no sale**: manda el flujo de siempre y, al guardarse, el conflicto de «Si otra persona cambió el diagrama mientras tanto» con sus tres salidas. «Cargar la nueva» se niega si entre tanto apareció algo pendiente. Lo propio tampoco cuenta: guardar aquí no avisa a esta pestaña.
- **Cómo se conecta.** `GET /api/events` (SSE) con la misma cabecera `Authorization: Bearer` de siempre (por eso se lee con `fetch` y no con `EventSource`, que no puede enviar cabeceras: el token nunca va en la URL). Se reconecta sola con espera exponencial (1 s, 2 s, 4 s… hasta 60 s, con algo de azar) y, al volver, relee la lista para no perderse nada. El indicador `data-live` de la barra del proyecto dice el estado: `live`, `connecting`, `retrying`, `unsupported` o `rejected`.
- **Si el servidor no lo ofrece** (una versión anterior, `--max-streams 0`, o un proxy que no deja pasar la conexión larga) la pestaña vuelve al sondeo de siempre: al volver el foco y cada 30 s. Con el canal en directo el sondeo se relaja a un repaso de seguridad cada 5 min. Un 401 o 403 no se reintenta en bucle.
- **Quién ve qué** (detalles en [servicio.md](servicio.md#cambios-en-tiempo-real-get-apievents)): las mismas reglas que la API. Con cuentas, cada persona recibe solo los proyectos a los que pertenece (y a quien se le quita del proyecto le llega ese aviso y nada más); con tokens, todos los de la carpeta.
- **Pruebas.** `src/cli/serveEvents.test.ts` (canal real con tokens, cuentas json y sqlite, topes, roles, revocación, cierre), `packages/kernel/src/project/events.test.ts` (analizador SSE, reconexión, latidos), `src/projects/session.events.test.ts` y `NewerVersionNotice.test.tsx`, y `tests/e2e/projects-cloud-eventos.spec.ts` (dos navegadores contra un `iark serve` real).

**5. Límites reales.**

- **Trabajo sin conexión, con límites** (ver la sección siguiente). Lo que escribes sin red se conserva en este navegador y se envía solo al volver, pero **no se puede abrir ni listar un proyecto sin el servidor**, y un diagrama que dos personas cambian sin coordinarse acaba en un conflicto que hay que resolver. Al cerrar o recargar, un guardado pequeño (hasta 60 KB) sigue su curso con `keepalive`; uno mayor no.
- **Tiempo real solo de avisos, sin edición simultánea** (sección 4c). Si el servidor ofrece el canal de eventos, los cambios de otras personas llegan en segundos; si no, la lista se vuelve a leer al volver el foco a la ventana y cada 30 s mientras el gestor está abierto o hay un diagrama abierto (con el gestor cerrado y sin diagrama abierto no se consulta nada). El canal es de **un solo proceso**: con varias instancias del servidor, cada una solo avisa de los cambios que pasan por ella; los cambios hechos con `iark project …` sobre la carpeta no se anuncian (los recoge el sondeo); no se reenvía lo perdido durante un corte (al reconectar se relee la lista). Si dos personas guardan el mismo diagrama, el segundo guardado lo detecta (`ifUpdatedAt`) y lo detiene y ofrece tres salidas (ver «Si otra persona cambió el diagrama mientras tanto»): **no se mezclan cambios**.
- Cada guardado envía el documento entero (el límite del servidor es de 5 MB) y la lista de proyectos incluye todos los diagramas sin su texto: está pensado para carpetas pequeñas o medianas, no para miles de diagramas.
- No se ha probado con la página publicada por https frente a un servidor en `localhost`: algunos navegadores piden permiso o bloquean ese acceso a la red local.
