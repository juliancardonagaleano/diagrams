# Proyectos

[← Índice de la documentación](indice.md)

Un proyecto agrupa diagramas de cualquier módulo de la suite para guardarlos, comprobarlos y trazarlos juntos. Hay tres sitios donde viven: una **carpeta de trabajo** (CLI y `iark serve`, pensada para ir en git), **este navegador** (IndexedDB, desde el banco de trabajo y el editor C4) y un **servidor propio** al que se conecta el navegador (con tokens o con inicio de sesión de GitHub). Las tres comparten el mismo archivo único de proyecto (`iark.project/1`).

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
| `trace <proyecto> [--from] [--direction] [--depth] [--format markdown\|mermaid\|svg\|json] [-o]` | La trazabilidad de `iark trace` con los diagramas del proyecto. Una URN (`urn:iark:<módulo>:<id>`) se resuelve en todo el proyecto, y si dos diagramas del mismo módulo definen el mismo id, se marca como ambigua. Un diagrama que no se puede leer se deja fuera con un aviso |

Los errores de uso (proyecto o diagrama que no existe, nombre repetido, documento inválido, falta `--yes`) salen con código 2 y un mensaje de una línea; las comprobaciones fallidas, con 3; un disco o una carpeta inaccesibles, con 1.

### API HTTP de proyectos

`iark serve --workspace <carpeta>` (o `IARK_WORKSPACE`) añade la API de proyectos sobre la misma carpeta; sin ella esas rutas responden 404 «Este servicio no tiene espacio de trabajo (use --workspace <carpeta>)». El manifiesto de la instancia anuncia entonces `"projects": "../api/projects"` y `"projectsAuth": "none"` (`"bearer"` con tokens: ver [Servidor para varias personas](servicio.md#servidor-para-varias-personas-nube-autoalojada)). Todo es JSON salvo el archivo único del proyecto; los ids son los de la carpeta (`tienda-web`, `seguridad-ejemplo`).

| Ruta | Descripción |
|---|---|
| `GET /api/projects` · `POST /api/projects` | Lista (con diagramas, sin documentos) · crea `{ name, description? }` (201) |
| `GET\|PATCH\|DELETE /api/projects/<p>` | Resumen · renombra `{ name }` · borra |
| `POST /api/projects/<p>/diagrams` | Crea `{ module, name?, text }` (201) |
| `GET\|PUT\|PATCH\|DELETE /api/projects/<p>/diagrams/<d>` | `{ ...meta, text }` · guarda `{ text, ifUpdatedAt? }` (el diagrama debe existir) · renombra `{ name }` · borra |
| `GET /api/projects/<p>/bundle` | El archivo único (`Content-Disposition` con `<proyecto>.iark-project.json`) |
| `POST /api/projects/import[?name=]` | Cuerpo: ese archivo → crea un proyecto nuevo (201) |
| `GET /api/projects/<p>/check` | La comprobación del proyecto (`checkProject`) |

Códigos: `not-found` 404, `exists` 409, `conflict` 409, `invalid` 400, `unavailable` 500; el cuerpo es `{ "error": "…", "code": "…" }`. Un cuerpo que pasa de `maxBodyBytes` (5 MB) da 413.

**Seguridad (sin `--tokens`: solo para una persona, en su máquina).** `iark serve` escucha en localhost y una página ajena abierta en el navegador podría intentar leer o escribir en el disco del usuario a través de él. En las rutas de proyectos (y solo en ellas):

- POST, PUT, PATCH y DELETE exigen `Content-Type: application/json` (415 si no): un formulario o un `fetch` `no-cors` no pueden enviarlo. Se admiten parámetros (`; charset=utf-8`); DELETE también lo exige, con el cuerpo vacío.
- Una petición con cabecera `Origin` se rechaza con 403 salvo que su host (y puerto) coincidan con la cabecera `Host` o esté en `--cors`. Un `*` en `--cors` no basta para esta API: hay que nombrar el origen (`--cors https://mi-app.example`). Solo a esos orígenes se les anuncian `PUT`, `PATCH` y `DELETE` en `Access-Control-Allow-Methods`.
- Si la conexión llega por loopback, la cabecera `Host` debe ser `localhost`, `127.0.0.1` o `[::1]` (con o sin puerto); si no, 403 (protección contra el *DNS rebinding*). Esa comprobación solo es posible en loopback: con un espacio de trabajo, `iark serve --host 0.0.0.0` (o cualquier `--host` que no sea de loopback) **no arranca sin `--tokens`** (código 2). Para exponerlo a otras personas, use tokens: ver [Servidor para varias personas (nube autoalojada)](servicio.md#servidor-para-varias-personas-nube-autoalojada).
- Los ids se validan antes de tocar el disco (400 si no son un id válido) y los errores de disco no revelan rutas.

Con `--tokens` esta lista cambia (no hay `Host` ni `Origin` que comprobar, pero sí token y rol): ver [Servidor para varias personas](servicio.md#servidor-para-varias-personas-nube-autoalojada).

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

Por omisión los proyectos de la app web viven en **este navegador** (IndexedDB). Para verlos desde otros equipos y compartirlos con otras personas se pueden guardar en un **servidor propio**: el mismo `iark serve --workspace` ([API HTTP de proyectos](#api-http-de-proyectos)), cuya API de proyectos ya es lo que usa el navegador. El servidor es tuyo y su carpeta de trabajo (la misma de `iark project`, pensada para ir en git) es la fuente de verdad; se entra con un token (`--tokens`) o, en una instancia con cuentas (`--accounts`), con **«Iniciar sesión con GitHub»** (ver el apartado «Iniciar sesión con GitHub» más abajo y [Servicio gestionado: inicio de sesión con GitHub](cuentas-github.md)).

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
- **Límites.** Iniciar sesión recarga la página: lo que no se pudo guardar se pierde si lo confirmas (antes se pide confirmación y «Cancelar» lo conserva), y no hay ventana emergente. Hace falta https o `localhost` (la comprobación PKCE usa `crypto.subtle`), y el servidor debe aceptar el origen de la página con `--cors` si no es el suyo. Con tokens sin rol la interfaz no limita nada y decide el servidor.

**3. Qué se guarda en el navegador y qué tan seguro es.**

- La dirección y el nombre del servidor, en `localStorage` (`iark.projects.backend`). No son secretos.
- El **token**, por omisión, en `sessionStorage`: solo esa pestaña, y se olvida al cerrarla (si el servidor pide token, una pestaña nueva lo pide otra vez). Con la casilla **«Recordar en este equipo»** (desmarcada por omisión) pasa a `localStorage` y sigue ahí hasta que lo borres; **cualquier script que se ejecute en este sitio podría leerlo**, así que márcala solo en un equipo tuyo. Cada token se guarda junto a su dirección y solo se envía a ella, sin cookies.
- Quien decide quién puede leer o escribir es el servidor, no la página.
- Si el servidor deja de aceptar el token, un guardado lo avisa («El servidor no aceptó el token») con un botón para volver a conectar: el texto pendiente no se pierde y se guarda al dar el token bueno, sin recargar.
- Si el token es válido pero su rol no alcanza (un `viewer` que edita), el guardado avisa «Sin permiso para guardar en el servidor», con el botón «Cambiar de token»: el texto pendiente tampoco se pierde y se guarda al dar un token de `editor`, sin recargar. Las lecturas siguen funcionando.

**4. Copiar entre almacenes.** *Copiar a…* en el detalle de un proyecto lo lleva al otro almacén (del navegador al servidor, o al revés) con el archivo único del proyecto (`iark.project/1`): nunca pisa nada —si el nombre ya existe queda «Nombre (2)»— y, si algo falla a mitad, no deja un proyecto a medias. Sin un servidor conocido, el botón lleva al formulario de conexión, que ofrece copiar sin cambiar de almacén.

**5. Límites reales.**

- **No hay trabajo sin conexión.** Un fallo de red al guardar deja el aviso y «Reintentar», y se reintenta solo al volver la conexión o el foco, pero **solo lo que está en memoria**: si cierras la pestaña sin red, se pierde (el navegador avisa antes de cerrar si hay cambios sin enviar). Al cerrar o recargar, un guardado pequeño (hasta 60 KB) sigue su curso con `keepalive`; uno mayor no.
- **No hay tiempo real entre personas.** La lista se vuelve a leer al volver el foco a la ventana y cada 30 s mientras el gestor está abierto o hay un diagrama abierto (con el gestor cerrado y sin diagrama abierto no se consulta nada). Si dos personas guardan el mismo diagrama, el segundo guardado lo detecta (`ifUpdatedAt`) y ofrece «Quedarme con mi versión» o «Cargar la otra»: **no se mezclan cambios**.
- Cada guardado envía el documento entero (el límite del servidor es de 5 MB) y la lista de proyectos incluye todos los diagramas sin su texto: está pensado para carpetas pequeñas o medianas, no para miles de diagramas.
- No se ha probado con la página publicada por https frente a un servidor en `localhost`: algunos navegadores piden permiso o bloquean ese acceso a la red local.
