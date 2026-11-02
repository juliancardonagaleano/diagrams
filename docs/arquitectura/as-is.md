# Arquitectura as-is de DIAgrams

[← Índice de la documentación](../indice.md)

Este documento explica el modelo C4 que está en [`examples/diagrams-as-is.json`](../../examples/diagrams-as-is.json). El JSON es el modelo: aquí no se copia cada una de las 112 relaciones. Las vistas y los identificadores de abajo son los del archivo. El rediseño no empieza en esta página; sigue el [protocolo](protocolo-sdd.md).

El producto se llama DIAgrams (antes IArk). Siguen igual el comando `iark`, los paquetes `@iark/*`, las referencias `urn:iark:…`, el manifiesto `iark.manifest/1` y las variables `IARK_*`.

## Alcance y fecha

El modelo describe la suite tal como está en `master` en el commit `9343c75`. Se documentó el 2 de noviembre de 2026 (America/Bogota). El archivo JSON entra en el commit `6c285d8`. Cubre el contexto, los contenedores y los componentes de las siete vistas del archivo. Quedan fuera, porque el código de esa fecha tampoco los tiene, el servidor MCP del producto (fuera de alcance de la v1, [hoja de ruta](../roadmap.md#límites-conocidos-y-fuera-de-alcance)), las vistas C4 de despliegue y de código, y cualquier arquitectura futura.

## De dónde sale

ECE no estaba conectado al escribir el modelo. No hay un servidor con ese nombre en este repositorio, ni en los repositorios públicos `diagrams` y `railspec`, ni en los MCP conectados en esa sesión (Figma, Fal, cursor-cloud, cursor). El modelo sale del código y de la documentación de `9343c75`. La descripción de `workspace` en el JSON lo dice con las mismas palabras. Una sesión que rediseñe la arquitectura conecta ECE antes, como indica la [spec 000](specs/000-conexion-ece.md). Hasta entonces no hay URL, herramientas ni capacidades de ECE que citar.

## Cómo se comprueba

```bash
npm run cli -- validate examples/diagrams-as-is.json
```

El 2 de noviembre de 2026 esa orden imprimió: `Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).`

Las aristas que dibuja cada vista salen de `deriveView` (`packages/domain-c4/src/model/viewDerivation.ts`). El recuento de esa misma fecha está en [Qué se comprobó](#qué-se-comprobó). El archivo no trae coordenadas: no hay ninguna clave `x` ni `y`. ELK las calcula al dibujar.

## C1 · Contexto

Vista `c1` (`systemContext`, alcance `diagrams`). Diez aristas, ninguna implícita. Son las relaciones cuyos dos extremos están en esta lista.

Personas:

| id | Nombre | Qué hace en este modelo |
|---|---|---|
| `arquitecto` | Arquitecto | Modela en el navegador: suite, estudio, banco de trabajo y trazabilidad. |
| `operador` | Operador | Usa el CLI en su máquina o en CI. |
| `administrador` | Administrador | Administra una instancia de `iark serve`: cuentas, roles, invitaciones y cuotas. |

Sistema:

| id | Nombre | Qué es |
|---|---|---|
| `diagrams` | DIAgrams | La suite. Seis especialidades, documento JSON, CLI `iark`, sitio y servicio. |

Sistemas externos:

| id | Nombre | Qué aporta |
|---|---|---|
| `anfitrion` | Aplicación anfitriona | Embebe la suite con el SDK, el Web Component o un iframe. |
| `github` | GitHub | Aloja el sitio en Pages y es el proveedor OAuth de las cuentas. |
| `proveedor-ia` | Proveedor de modelo | Anthropic o Foundry. Solo lo llama el CLI. |
| `repositorio` | Repositorio de origen | Árbol que `--from-repo` lee con lista blanca. Redacta secretos antes de enviar nada al modelo. |
| `proxy` | Proxy HTTPS | Opcional. `iark serve` solo habla HTTP; en internet va detrás de un proxy (Caddy en `deploy/`). |
| `prometheus` | Prometheus | Opcional. Raspa `/metrics`. Apagado por omisión; fuera de loopback exige token. |

En C1 la petición al modelo sale de DIAgrams hacia `proveedor-ia`. En C2 y C3 esa misma petición sale del CLI (`r-cli-ia`, `r-ia-prov`). El sitio y `iark serve` no tienen generación. El detalle de por qué el servicio no llama a un modelo está en [servicio.md](../servicio.md#por-qué-no-hay-ia-en-el-servicio).

## C2 · Contenedores

Vista `c2` (`container`, alcance `diagrams`). El límite es `diagrams`. Dieciséis nodos y veintiuna aristas, dos de ellas implícitas. Esos dos saltos están al final de la sección.

| id | Nombre | Papel | Tecnología | Código |
|---|---|---|---|---|
| `sitio` | Sitio web | SPA en el navegador. La entrada `/` es la suite. | Vite, React, React Flow, Semi UI | `index.html` carga `src/boot.ts`. Páginas aparte: `modulos.html`, `trazabilidad.html`, `suite.html` |
| `sdk` | SDK de embebido | Corre en la página anfitriona. Abre un iframe del sitio y habla por `postMessage`. No es un proceso del servidor. | TypeScript, `dist/embed` | `src/embed` |
| `cli` | CLI `iark` | Proceso Node en la máquina de quien modela o en CI. `generate`, `explain` y `review` viven aquí. Sin clave, `iark prompt` entrega el encargo a otro agente. | Node.js >= 22.13, commander | `src/cli` |
| `servicio` | Servicio HTTP | `iark serve`: API, proyectos, cuentas, SSE, observabilidad y, si se pide, el sitio estático. Una imagen Docker. No llama a un modelo. | Node.js, HTTP | `src/cli/serve.ts` |
| `nucleo` | Núcleo y módulos | Se dibuja como contenedor y no escucha puertos. El mismo código se enlaza en el sitio, el CLI y el servicio. Un módulo no importa a otro: solo se relacionan por `urn:iark:<módulo>:<id>`. | `@iark/kernel` y `@iark/domain-*` | `packages/kernel`, `packages/domain-*` |
| `proyectos` | Almacén de proyectos | Carpeta de trabajo (git) o Postgres. | Carpeta o Postgres | Carpeta: `src/cli/workspace.ts`. Postgres del servicio: `src/cli/postgresProjects.ts` |
| `cuentas` | Almacén de cuentas | Solo con `--accounts`. Personas, sesiones hasheadas, miembros y cuotas. | JSON, SQLite o Postgres | `src/cli/accounts/jsonStore.ts`, `sqliteStore.ts`, `postgresStore.ts` |

`iark project` del CLI lee y escribe la carpeta (`r-cli-proy`, tecnología «sistema de archivos»). El servicio persiste con carpeta o Postgres (`r-srv-proy`). El IndexedDB del navegador es el componente `proyectos-web` (`src/projects`), dentro de `sitio`.

Las aristas directas de C2, además de las personas y el anfitrión, son estas: el SDK abre un iframe del sitio; el sitio llama al servicio, empaqueta el núcleo y redirige a GitHub para autorizar; GitHub sirve el build en Pages; el CLI enlaza el núcleo, llama al proveedor de modelo, lee el repositorio y usa la carpeta de proyectos; el servicio enlaza el núcleo, persiste proyectos y cuentas, y completa el OAuth; el proxy termina TLS delante del servicio; Prometheus raspa `/metrics` en el servicio.

Las dos aristas implícitas de C2 suben un componente a su contenedor porque el otro extremo sí está en la vista:

| Relación | En el modelo | Cómo se dibuja en `c2` |
|---|---|---|
| `r-puente-sdk` | `puente` → `sdk` | `sitio` → `sdk`. El puente responde al protocolo del anfitrión. |
| `r-sse-sitio` | `sse` → `sitio` | `servicio` → `sitio`. El servicio avisa de que hay una versión más nueva. |

## C3 · Sitio web

Vista `c3-sitio` (`component`, alcance `sitio`). Veintidós aristas, ninguna implícita. En la vista también aparecen `nucleo`, `servicio` y `sdk`.

| id | Nombre | Código y ruta |
|---|---|---|
| `boot` | Enrutador de superficies | `src/boot.ts`, cargado por `index.html` |
| `home` | Inicio | `src/home`. `suite.html` solo redirige, con `src/shell/redirect.ts` (quita `embed` y vuelve a `/`). |
| `studio` | Estudio | `src/studio`. Marco del editor sobre el controlador del banco. |
| `editor` | Editor C4 clásico | `src/app`. Protocolo `postMessage` histórico, proyectos y notación de tarjetas. El banco ya no lo incrusta. |
| `banco` | Banco de trabajo | `src/modules-app`, página `modulos.html`. Un controlador, un lienzo y un inspector para los seis módulos, C4 incluido. Cada módulo se importa al elegirlo. |
| `shell` | Shell de federación | `src/shell`. Con `/?manifest=` lee el manifiesto de otra instancia. |
| `traza-ui` | Trazabilidad | `src/trace-app`, página `trazabilidad.html`. No pasa por `src/boot.ts`. |
| `proyectos-web` | Cliente de proyectos | `src/projects`. IndexedDB en el navegador, cliente del servicio y cola de lo escrito sin red. Abrir y listar en el servidor sigue necesitando conexión. |
| `i18n` | Internacionalización | `src/i18n`. Español e inglés en la suite, el marco y los encabezados. El lienzo, los paneles, el CLI y el servicio siguen en español. |
| `puente` | Puente postMessage | `src/embed`. Protocolo del editor clásico y protocolo de módulos. Sin `&origin=` las respuestas salen con destino `*`. |

`src/boot.ts` elige así, en este orden:

| Dirección | Qué carga |
|---|---|
| `/?editor=1` o `/?studio=1` | `src/studio` |
| `/?editor=1&classic=1` | `src/app` |
| `/?embed=1` (y `surface` distinto de `home`) | `src/app` |
| `/?surface=home&embed=1` | `src/home` |
| `/?manifest=<url>` | `src/shell` |
| `/` | `src/home` |

`?classic=1` a solas no enciende la rama del editor: cae en la suite. La bandera que aparta el estudio es `classic=1`, y entra en `src/app` cuando además viene `editor=1`, o cuando la página va embebida. Con `embed=1` manda el embebido: `editor=1` en la misma dirección no abre el estudio. `modulos.html` y `trazabilidad.html` tienen su propio `<script>` y no pasan por `boot`.

El estudio reutiliza controlador, lienzo e inspector del banco (`r-studio-banco`). El inicio, el estudio, el banco y el editor clásico abren proyectos por `proyectos-web`. El inicio lista proyectos remotos en el servicio si hay sesión (`r-home-srv`); el cliente guarda, sincroniza y escucha avisos (`r-proyweb-srv`). El editor clásico y el banco hablan con el anfitrión por el puente; el puente responde al SDK (`r-puente-sdk`). El banco importa el módulo elegido, el editor clásico incluye el módulo C4 en su trozo, y la trazabilidad resuelve URN en el navegador. Esos tres apuntan a `nucleo`.

El inicio enlaza cada especialidad con `modulos.html?module=<id>` y puede mandar a `/?manifest=`. Esas navegaciones no tienen relación propia: las aristas de `home` en el modelo son `r-home-proy`, `r-home-i18n` y `r-home-srv`.

## C3 · SDK de embebido

Vista `c3-sdk` (alcance `sdk`). Siete aristas, ninguna implícita. En la vista están el anfitrión y el sitio.

| id | Nombre | Código |
|---|---|---|
| `embed-c4` | `createIarkEmbed` | `src/embed/iark-embed.ts`. El build publicado es `dist/embed`. Añade `embed=1` a la URL del iframe. |
| `embed-modulo` | `createIarkModuleEmbed` | `src/embed/iark-module-embed.ts` |
| `web-component` | `<iark-module>` | `src/embed/iark-module-element.ts` |
| `protocolo` | Protocolo de embebido | `src/embed/protocol.ts` (editor C4) y `src/embed/moduleProtocol.ts` (módulos). El anfitrión no conoce el interior de un módulo. |

El anfitrión crea uno de los tres puntos de entrada. Los tres hablan el protocolo. El protocolo abre el iframe y negocia capacidades (`r-proto-sitio`). Páginas de ejemplo: `examples/embed-host.html`, `examples/modules-host.html`, `examples/web-component-host.html`. El protocolo y el idioma están contados en [embebido.md](../embebido.md).

## C3 · CLI iark

Vista `c3-cli` (alcance `cli`). Once aristas, ninguna implícita. En la vista están el núcleo, el proveedor de modelo, el repositorio de origen y el almacén de proyectos.

| id | Nombre | Código |
|---|---|---|
| `comandos` | Intérprete de comandos | `src/cli/main.ts`. Comandos de primer nivel y el grupo `iark <módulo>` que aporta cada `DomainModule`. |
| `registro-cli` | Registro de módulos | `src/cli/registry.ts`. Los seis incorporados más los de `iark.config.json`. Un id de plugin no puede pisar un comando ni otro módulo. |
| `ia-cli` | Cliente de modelos | `src/cli/ai.ts` y `packages/kernel/src/ai`. Verifica con `validate()` del módulo y reintenta. El servicio HTTP no usa este cliente. |
| `repo-cli` | Lector de repositorio | `src/cli/repo`. `--from-repo` lee la lista blanca y redacta secretos. `--dry-run` muestra el envío. No carga el `iark.config.json` del clon. |
| `workspace-cli` | Proyectos en carpeta | `src/cli/workspace.ts`. Historial de versiones local al almacén. |
| `plugins-cli` | Cargador de plugins | `src/cli/plugins`. Ejecuta el código del módulo de terceros con los permisos del proceso. |

`comandos` reparte en el registro, el cliente de modelos, el lector de repositorio, la carpeta de proyectos y el cargador. El cargador registra el módulo si el contrato encaja. El cliente pide JSON estructurado al proveedor (`r-ia-prov`) y usa el `AiSpec` del núcleo (`r-ia-nuc`). El registro carga cada `DomainModule` (`r-reg-nuc`). La referencia de órdenes está en [cli.md](../cli.md) y la de la generación en [ia.md](../ia.md).

## C3 · Servicio HTTP

Vista `c3-servicio` (alcance `servicio`). Veintiuna aristas, ninguna implícita. En la vista están el núcleo, los dos almacenes, GitHub, el proxy, Prometheus y el sitio. No está `proveedor-ia`: esta vista no tiene cliente de modelo.

| id | Nombre | Código |
|---|---|---|
| `http` | Enrutador HTTP | `src/cli/serve.ts`. Rutas `/api/modules`, `/api/<módulo>/…`, proyectos, auth, eventos, salud y estáticos. |
| `api-modulos` | API de módulos | `validate`, `views`, `schema`, `export`, `import`, `diff`, `run` y `/api/trace`. No llama a un modelo. |
| `api-proyectos` | API de proyectos | `src/cli/serveProjects.ts`. CRUD, bundle, importación, comprobación y guardado condicional por `ifUpdatedAt`. |
| `tokens` | Tokens de acceso | `src/cli/tokens.ts` y `src/cli/serveAuth.ts`. El archivo guarda hashes. El rol vale para toda la carpeta. Sin caducidad. |
| `cuentas-gh` | Cuentas de GitHub | `src/cli/accounts`. Login, callback, sesión, miembros, administración y cuotas. El secreto OAuth entra por entorno o por archivo. |
| `sse` | Avisos en tiempo real | `src/cli/serveEvents.ts`. `GET /api/events` avisa de una versión más nueva. Un solo proceso. No mezcla ediciones simultáneas. |
| `obs` | Observabilidad | `src/cli/observability`. `X-Request-Id`, registro de accesos, auditoría, `/healthz`, `/readyz` y `/metrics`. Registros y métricas apagados por omisión. |
| `pool` | Piscina de cálculo | `src/cli/computePool.ts` y `src/cli/computeWorker.ts`. `validate`, `export`, `import`, `diff`, `run` y `trace` corren en `worker_threads`. |
| `estaticos` | Sitio estático | `--static dist/app`. El mismo proceso puede servir el build que también publica GitHub Pages. |
| `cabeceras` | Cabeceras de seguridad | `src/cli/securityHeaders.ts`. CSP sin `unsafe-eval`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors` y HSTS detrás del proxy. |

El enrutador reparte en la API de módulos, la de proyectos, los tokens, las cuentas, los avisos, la observabilidad, los estáticos y las cabeceras. La API de módulos saca el cálculo a la piscina, y la piscina ejecuta el núcleo. La API de proyectos persiste en el almacén de proyectos. Las cuentas guardan el hash de la sesión y completan el OAuth con GitHub. Los tokens autorizan la API de proyectos por el rol de la carpeta. Los avisos llegan al sitio, los estáticos entregan el mismo build, el proxy reenvía al enrutador y Prometheus raspa la observabilidad. La vista también dibuja las dos aristas de Pages entre el sitio y GitHub (`r-sitio-gh`, `r-gh-sitio`). Rutas, cuentas y operación: [servicio.md](../servicio.md), [cuentas-github.md](../cuentas-github.md), [observabilidad.md](../observabilidad.md), [proyectos.md](../proyectos.md).

## C3 · Núcleo y módulos

Vista `c3-nucleo` (alcance `nucleo`). Veintiséis aristas, ninguna implícita. Ninguna une dos módulos: la traza lee entidades por el contrato.

| id | Nombre | Código |
|---|---|---|
| `contrato` | Contrato `DomainModule` | `packages/kernel/src/module/contract.ts`. Esquema, validación, vistas, importadores, exportadores, IA, editor, migraciones y `contractVersion`. El registro rechaza un contrato más nuevo que el anfitrión. |
| `urn` | URN y trazabilidad | `packages/kernel/src/module/urn.ts`. `urn:iark:<módulo>:<id>`. |
| `diff` | Comparación de documentos | `packages/kernel/src/diff`. Estructural. Cada módulo declara qué rutas son maquetación y cuáles listas conservan orden. |
| `proyecto-modelo` | Modelo de proyecto | `packages/kernel/src/project`. Un proyecto agrupa diagramas de varios módulos. Guarda el id de módulo y el texto, no el tipo interno. |
| `ia-kernel` | IA estructurada | `packages/kernel/src/ai`. Proveedor, reintentos y JSON Schema. El modelo devuelve el documento; no devuelve coordenadas. |
| `grafo` | Layout de grafos | `packages/kernel/src/graph` y `packages/kernel/src/mermaid`. ELK genérico, SVG y sintaxis Mermaid. |
| `mod-c4` | Módulo C4 | `packages/domain-c4`. También es la API pública `diagrams/core`. |
| `mod-integration` | Módulo de integración | `packages/domain-integration` |
| `mod-data` | Módulo de datos | `packages/domain-data` |
| `mod-enterprise` | Módulo empresarial | `packages/domain-enterprise` |
| `mod-platform` | Módulo de plataforma | `packages/domain-platform` |
| `mod-security` | Módulo de seguridad | `packages/domain-security` |

Cada módulo implementa el contrato (seis aristas). `urn` lee las entidades de cada módulo sin importar su código (seis). Cada módulo entrega prompts y esquema a la IA estructurada (seis). Los cinco módulos que no son C4 piden `layoutGraph` para sus vistas; C4 pinta el SVG con el kernel y el autolayout del modelo es el suyo (`r-c4-grafo`). `diff` y el modelo de proyecto usan el contrato. Formato, niveles y autolayout de C4: [modulos/c4.md](../modulos/c4.md).

## Invariantes

Estos hechos se mantienen mientras el as-is sea el modelo de partida. Cambiarlos es un rediseño y pasa por una spec aceptada.

- La generación con IA vive en el CLI. `iark serve` no tiene cliente de modelo ni ruta de generación.
- El documento no necesita coordenadas. ELK coloca lo que no trae `x`/`y`. Este as-is no trae ninguna.
- Hay dos editores de C4. El clásico es `src/app`. El otro es el lienzo común del banco (`src/modules-app`), que el estudio (`src/studio`) reutiliza. Los dos siguen en el producto.
- Arrastrar en el lienzo común se recuerda en el navegador, por vista, en `localStorage` con la clave `iark.canvas.<módulo>.<vista>` (`src/modules-app/canvas/DiagramCanvas.tsx`). Ese arrastre no se escribe en el documento. En el editor clásico, mover un nodo sí guarda `x`/`y` en `view.elements`; la tabla está en [modulos/c4.md](../modulos/c4.md#diferencias-con-el-editor-clásico).
- El núcleo se dibuja como contenedor y no es un proceso. El mismo código entra en el sitio, en el CLI y en el servicio.
- Un módulo no importa a otro. El enlace entre especialidades es la URN.
- `@iark`, `urn:iark`, el comando `iark` y las variables `IARK_*` se conservan.
- IndexedDB del navegador es `proyectos-web`, dentro del sitio. El contenedor `proyectos` es la carpeta o Postgres.

## Deriva conocida de la documentación

El código de `src/boot.ts` abre el estudio con `/?editor=1`. Varios textos de ese commit siguen asignando esa dirección al editor clásico:

- El [README](../../README.md) lo dice en el comentario de `npm run dev` y en la fila «Editor C4 (clásico)» de la tabla de superficies.
- El comentario de cabecera de `src/boot.ts` dice que el editor clásico sigue en `/?editor=1`. La condición de debajo carga `src/studio` para esa dirección y `src/app` para `/?embed=1` o para `/?editor=1&classic=1`.
- [suite-web.md](../suite-web.md) abre el párrafo diciendo que el editor clásico se abre con `/?editor=1`.
- La suite rotula el enlace `?editor=1` como «Editor C4 clásico» (`home.editor` en `src/i18n/es/editor.ts`, `src/home/Home.tsx`). Esa dirección abre el estudio.

Las pruebas de extremo a extremo ya separan las dos rutas: `tests/e2e/studio-marco.spec.ts` espera el estudio en `/?editor=1`, y `tests/e2e/canvas-helpers.ts` abre el clásico con `/?editor=1&classic=1`. Corregir esos textos es documentación. No es una corrección del modelo: el elemento `boot` ya dice que `/?editor=1` abre el estudio.

La descripción de `boot` en el JSON resume el clásico como `?classic=1` y el embebido. El predicado completo es el de la tabla de [C3 · Sitio web](#c3--sitio-web).

## Qué se comprobó

El 2 de noviembre de 2026, sobre `examples/diagrams-as-is.json`:

- `npm run cli -- validate examples/diagrams-as-is.json` → `Documento válido: 59 elementos, 112 relaciones, 7 vistas. 0 error(es), 0 aviso(s).`
- `deriveView` de `@iark/domain-c4`:

| Vista | Nodos | Límites | Aristas | Implícitas |
|---|---|---|---|---|
| `c1` | 10 | 0 | 10 | 0 |
| `c2` | 16 | 1 | 21 | 2 |
| `c3-sitio` | 13 | 1 | 22 | 0 |
| `c3-sdk` | 6 | 1 | 7 | 0 |
| `c3-cli` | 10 | 1 | 11 | 0 |
| `c3-servicio` | 17 | 1 | 21 | 0 |
| `c3-nucleo` | 12 | 1 | 26 | 0 |

Para repetir el recuento:

```bash
npx tsx -e '
import { readFileSync } from "node:fs";
import { deriveView } from "./packages/domain-c4/src/model/viewDerivation.ts";
const doc = JSON.parse(readFileSync("examples/diagrams-as-is.json", "utf8"));
for (const v of doc.views) {
  const d = deriveView(doc, v.id);
  const implied = d.edges.filter((e) => e.implied);
  console.log(v.id, d.nodes.length, "nodos", d.boundaries.length, "límites", d.edges.length, "aristas", implied.length, "implícitas");
  for (const e of implied) console.log(" ", e.relationship.id, e.sourceId, "->", e.targetId);
}
'
```

ECE no se consultó: no había servidor que consultar. El modelo sale del código.
