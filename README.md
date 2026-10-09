# IArk - DIAgrams

**Suite de diagramación de arquitectura**: seis especialidades (C4, integración, datos, empresarial, plataforma y seguridad) sobre un núcleo común, **federada y embebible**, con un CLI (`iark`) que dibuja y refina diagramas con IA. Antes «Diagramador C4»; el comando `c4diagram` se mantiene como alias de `iark`.

- **Un JSON limpio y estable por módulo**, con esquema publicado ([`schema/`](schema/)) y sin coordenadas: la IA produce el modelo y el autolayout (ELK) produce la geometría. Se convierte a **`.drawio`**, **SVG** y **Mermaid**, y se importa desde `.drawio`, DSL de Structurizr, Mermaid, OpenAPI, AsyncAPI, Threat Dragon, Terraform, Kubernetes, CloudFormation, Helm, DDL de SQL, dbt, OpenLineage, ArchiMate y BPMN, según el módulo.
- **Editor web interactivo** del modelo C4 (con la estética de [drawdb.app](https://www.drawdb.app/)) y un **banco de trabajo** con lienzo propio para las otras cinco especialidades.
- **CLI `iark`**: genera con IA a partir de lenguaje natural (o leyendo un repositorio), valida, aplica autolayout, convierte, importa, compara versiones y traza entre módulos. Sin clave de API sirve con cualquier IA o agente (`iark prompt`).
- **Federada y embebible**: cada instancia publica un manifiesto (`/.well-known/iark.json`) y se embebe por `<iframe>` + `postMessage`, con un SDK de anfitrión y el Web Component `<iark-module>`.
- **Trazabilidad entre módulos** con referencias estables `urn:iark:<módulo>:<id>`, sin que ningún módulo conozca el código de otro.
- **Proyectos** que agrupan diagramas de varios módulos: en una carpeta de trabajo (pensada para git), en el navegador o en un servidor propio con tokens o con inicio de sesión de GitHub.
- **Servicio HTTP** (`iark serve`, con Dockerfile) y sitio estático en GitHub Pages.

## Inicio rápido

Requisitos: **Node 22.13 o superior** (el que usan la imagen Docker y el CI; lo fijan `.nvmrc` y `engines` de `package.json`; la 22.13 es la primera que trae `node:sqlite` sin banderas, que usa el almacén de cuentas del servicio gestionado).

```bash
npm install
npm run dev        # editor C4 en http://localhost:5173 (banco de trabajo en /modulos.html, suite en /suite.html)
```

El CLI, sin construir nada (tras `npm run build`: `node dist/cli/index.js`, o `npx iark` con el paquete instalado):

```bash
npm run cli -- example > banca.json                      # documento de ejemplo
npm run cli -- validate banca.json
npm run cli -- convert banca.json --out banca.drawio     # autolayout + .drawio, sin abrir un navegador

export ANTHROPIC_API_KEY=…                               # generar con IA (otros proveedores y modo sin clave: docs/ia.md)
npm run cli -- generate "Banca en línea con app web (React), API (Node.js), PostgreSQL y una pasarela de pagos externa" --json banca.json --out banca.drawio
npm run cli -- generate "Pedidos con Kafka y una pasarela de pagos" --module integration --json pedidos.json
```

El servicio y el sitio, en un solo proceso:

```bash
npm run build
npm run cli -- serve --static dist/app     # http://127.0.0.1:8787: editor, banco de trabajo, shell y API
docker build -t iark-diagrams . && docker run --rm -p 8787:8787 iark-diagrams     # lo mismo, en un contenedor
```

Para comprobar un cambio: `npm run typecheck`, `npm test` (vitest), `npm run e2e` (Playwright, requiere `build:app` previo) o todo junto con `npm run verify`. Los scripts, la estructura del repositorio y las pruebas están en [docs/desarrollo.md](docs/desarrollo.md).

Como biblioteca, el paquete `iark-diagrams` exporta el núcleo del módulo C4 (sin DOM: sirve en Node y en el navegador), el SDK de anfitrión y el Web Component:

```ts
import { validateDocument, autoLayoutDocument, toDrawio } from 'iark-diagrams/core';
import { createIarkEmbed, createIarkModuleEmbed } from 'iark-diagrams/embed';
import 'iark-diagrams/element';   // registra <iark-module>
```

## Un documento, un archivo

Cada diagrama es un JSON sin coordenadas; cualquier elemento sin `x`/`y` se coloca con autolayout. Mínimo de un diagrama C4 (el formato completo está en [docs/modulos/c4.md](docs/modulos/c4.md)):

```json
{
  "version": "1.0",
  "workspace": { "name": "Banca en línea" },
  "model": {
    "elements": [
      { "id": "cliente", "type": "person", "name": "Cliente", "description": "Persona con una cuenta bancaria" },
      { "id": "banca", "type": "softwareSystem", "name": "Banca en línea", "description": "Consulta de saldos y pagos" },
      { "id": "api", "type": "container", "name": "API", "description": "Expone saldos y pagos", "technology": "Node.js", "parentId": "banca" },
      { "id": "db", "type": "container", "name": "BD", "description": "Cuentas y movimientos", "technology": "PostgreSQL", "parentId": "banca", "shape": "database" }
    ],
    "relationships": [
      { "id": "r1", "sourceId": "cliente", "targetId": "banca", "description": "Usa", "technology": "HTTPS" },
      { "id": "r2", "sourceId": "api", "targetId": "db", "description": "Lee y escribe", "technology": "SQL" }
    ]
  },
  "views": [
    { "id": "ctx", "type": "systemContext", "scopeId": "banca", "title": "Contexto", "elements": [{ "id": "cliente" }, { "id": "banca" }] },
    { "id": "cont", "type": "container", "scopeId": "banca", "title": "Contenedores", "elements": [{ "id": "cliente" }, { "id": "api" }, { "id": "db" }] }
  ]
}
```

La misma idea vale para los demás módulos: un documento con su esquema (`iark schema --module <id>`), vistas derivadas del modelo y las mismas operaciones (`validate`, `convert`, `import`, `generate`…).

## Cómo está pensado

- **Modelo compartido + vistas** (como Structurizr): renombrar algo lo actualiza en todas las vistas; cada vista es una página del `.drawio`.
- **La IA nunca produce coordenadas**: produce el modelo; ELK produce la geometría. Por eso la generación es robusta y el autolayout, la pieza central.
- **Un contrato, sin acoplamiento**: cada especialidad implementa `DomainModule` (esquema, validación, vistas, importadores, exportadores, IA, editor) y se descubre por registro y manifiesto; entre módulos solo hay URN.
- **Carga bajo demanda y pocas dependencias de ejecución**: cada módulo se importa dinámicamente en la web, y el frontend es `devDependencies` (Vite lo empaqueta entero en `dist/app`).
- Más decisiones y la estructura del repositorio: [docs/desarrollo.md](docs/desarrollo.md).

## Módulos

Cada especialidad es un paquete `@iark/domain-*` que implementa el contrato `DomainModule` y no depende del código de las demás; se relacionan solo por URN. Se eligen con `--module <id>` en el CLI (`c4` por omisión) y con `?module=<id>` en el banco de trabajo.

| Módulo | `--module` | Qué modela | Documento |
|---|---|---|---|
| C4 | `c4` | Contexto, contenedores y componentes de un sistema de software; niveles C1 › C2 › C3 y autolayout | [docs/modulos/c4.md](docs/modulos/c4.md) |
| Integración | `integration` | Cómo se hablan los sistemas: APIs, servidores MCP, brokers, colas y tópicos, con sus contratos (OpenAPI, `.proto`, CloudEvents…) y flujos | [docs/modulos/integracion.md](docs/modulos/integracion.md) |
| Datos | `data` | Dónde viven los datos, de dónde vienen y quién responde: linaje (también por columna), ERD, gobierno, motores y DDL, productos de datos y glosario | [docs/modulos/datos.md](docs/modulos/datos.md) |
| Empresarial | `enterprise` | Qué sabe hacer la empresa, con qué aplicaciones y sobre qué tecnología (subconjunto de ArchiMate/TOGAF): capacidades, flujos de valor, ciclo de vida | [docs/modulos/empresarial.md](docs/modulos/empresarial.md) |
| Plataforma | `platform` | Dónde corre cada cosa y cómo llega: entornos, redes, recursos, servicios, despliegues y pipelines | [docs/modulos/plataforma.md](docs/modulos/plataforma.md) |
| Seguridad | `security` | Qué proteger, de quién y con qué: zonas de confianza, flujos de datos, amenazas STRIDE, controles y riesgo residual | [docs/modulos/seguridad.md](docs/modulos/seguridad.md) |

`iark modules` lista los módulos instalados y los formatos que importan y exportan; los formatos están tabulados en [docs/importadores.md](docs/importadores.md).

Una especialidad propia no necesita tocar este repositorio: un **módulo de terceros** es un paquete que implementa el contrato `DomainModule` y se carga desde un `iark.config.json` (`iark --config … modules`, `iark serve --config …`). Hay un ejemplo completo en [`examples/plugin-riesgos/`](examples/plugin-riesgos/) y la guía en [docs/plugins.md](docs/plugins.md); funcionan en el CLI y en el servicio, no en el sitio web.

## Superficies

| Superficie | Dónde | Para qué | Más |
|---|---|---|---|
| Editor C4 | `index.html` | Editar diagramas C4 con lienzo interactivo, deshacer/rehacer, minimapa y panel de problemas | [docs/modulos/c4.md](docs/modulos/c4.md) |
| Banco de trabajo | `modulos.html?module=<id>` | Editar cualquier módulo: lienzo, JSON con validación, vistas, exportar, importar, informes y comparar versiones | [docs/suite-web.md](docs/suite-web.md) |
| Suite (shell) | `suite.html` | Descubre los módulos de una instancia leyendo su manifiesto y monta el editor o el widget elegido | [docs/suite-web.md](docs/suite-web.md) |
| Trazabilidad | `trazabilidad.html` | Enlaces `urn:iark:…` entre documentos de varios módulos, referencias sin resolver y alcance de un elemento | [docs/trazabilidad.md](docs/trazabilidad.md) |
| Proyectos | *Proyectos…* en el banco y en *Archivo* del editor C4; `iark project` | Guardar y abrir diagramas agrupados: carpeta, navegador o servidor propio | [docs/proyectos.md](docs/proyectos.md) |
| CLI | `iark` | generate, layout, convert, import, validate, schema, prompt, diff, trace, project, auth, serve y los comandos de cada módulo | [docs/cli.md](docs/cli.md) · [docs/ia.md](docs/ia.md) |
| Servicio | `iark serve` | API por módulo, sitio, proyectos y autenticación (tokens o inicio de sesión de GitHub); registro de accesos, auditoría, `/healthz`, `/readyz` y métricas de Prometheus | [docs/servicio.md](docs/servicio.md) · [docs/cuentas-github.md](docs/cuentas-github.md) · [docs/observabilidad.md](docs/observabilidad.md) |
| Widget y embebido | `modulos.html?embed=1`, `index.html?embed=1`, `<iark-module>` | Llevar el editor a otra aplicación con `postMessage`, SDK o Web Component | [docs/embebido.md](docs/embebido.md) |

## Sitio publicado y demos

El sitio estático se publica en GitHub Pages en cada push a `master` (`https://<usuario>.github.io/<repositorio>/`; detalles en [docs/despliegue-pages.md](docs/despliegue-pages.md)). La generación con IA no vive en el sitio, solo en el CLI. Tres páginas anfitrión de ejemplo muestran cómo embeber la suite: [`examples/embed-host.html`](examples/embed-host.html) (editor C4 por iframe), [`examples/modules-host.html`](examples/modules-host.html) (banco de trabajo de módulos) y [`examples/web-component-host.html`](examples/web-component-host.html) (`<iark-module>`); los documentos de ejemplo de cada módulo están en [`examples/`](examples/).

## Seguridad en breve

Lo imprescindible antes de exponer algo (el detalle está en cada documento y la política de vulnerabilidades en [SECURITY.md](SECURITY.md)):

- **`iark serve` solo habla HTTP**: para usarlo por internet va detrás de un proxy con HTTPS (`--trust-proxy`); ver [docs/servicio.md](docs/servicio.md).
- **Con una carpeta de trabajo (`--workspace`) y fuera de loopback exige autenticación** (`--tokens` o `--accounts`); sin ella, no arranca. La imagen Docker no fija ningún espacio de trabajo a propósito.
- **Registros y métricas: apagados por omisión.** El registro de accesos (`--access-log`) y la auditoría (`--audit-log`) llevan el usuario de GitHub y la dirección IP, nunca credenciales ni contenido; `/metrics` (`--metrics`) exige un token o solo atiende a loopback, y el servicio se niega a arrancar con métricas abiertas fuera de loopback. `/healthz` y `/readyz` son públicos y sin detalles ([docs/observabilidad.md](docs/observabilidad.md)).
- **Los tokens y las sesiones se guardan solo como hash** en disco (las cuentas, en una base SQLite 0600 con transacciones); el secreto de la OAuth App de GitHub no tiene opción de línea de comandos (entorno o archivo).
- **`--from-repo` solo lee una lista blanca** de archivos y redacta los secretos antes de enviar nada al modelo; `--dry-run` enseña exactamente qué se enviaría ([docs/ia.md](docs/ia.md)).
- **Cargar un módulo de terceros ejecuta su código** con los permisos del proceso: solo se carga la configuración que señalas tú (`--config`, `IARK_CONFIG` o el `iark.config.json` del directorio actual), nunca la de un proyecto clonado (`--from-repo`) ni la de una carpeta de trabajo (`--workspace`); `--no-config` lo desactiva ([docs/plugins.md](docs/plugins.md)).
- **Al embeber, fija el origen del anfitrión** (`&origin=https://mi-host`): sin él las respuestas de `postMessage` van a `*` ([docs/embebido.md](docs/embebido.md)).

## Documentación

Todo lo que antes vivía en este README está en [`docs/`](docs/indice.md), con un mapa de dónde quedó cada sección:

- **Usar**: [CLI](docs/cli.md) · [IA](docs/ia.md) · [importar y exportar](docs/importadores.md) · [proyectos](docs/proyectos.md) · [trazabilidad](docs/trazabilidad.md)
- **Módulos**: [C4](docs/modulos/c4.md) · [integración](docs/modulos/integracion.md) · [datos](docs/modulos/datos.md) · [empresarial](docs/modulos/empresarial.md) · [plataforma](docs/modulos/plataforma.md) · [seguridad](docs/modulos/seguridad.md) · [módulos de terceros](docs/plugins.md)
- **Operar**: [servicio](docs/servicio.md) · [inicio de sesión con GitHub](docs/cuentas-github.md) · [GitHub Pages](docs/despliegue-pages.md) · [guía de despliegue de la nube](docs/despliegue-nube.md) · [`deploy/`](deploy/)
- **Desarrollar**: [desarrollo, estructura y pruebas](docs/desarrollo.md) · [hoja de ruta](docs/roadmap.md) · [historial](docs/historial.md)

## Estado

Las seis especialidades, el banco de trabajo, la federación, los proyectos y el servicio gestionado están hechos; el proyecto está en la **Fase 1 «Endurecer»** de su plan de robustecimiento (seguridad, compuerta de CI, documentos de proyecto). Qué está hecho, qué falta y los límites conocidos: [docs/roadmap.md](docs/roadmap.md). Los que conviene saber desde el principio:

- No hay colaboración en tiempo real ni trabajo sin conexión: dos personas sobre el mismo diagrama no se mezclan, el segundo guardado pregunta qué versión conservar.
- El servicio gestionado es de una sola máquina (las cuentas van en una base SQLite del disco local: varios procesos sobre ella son seguros, pero no hay réplicas en máquinas distintas; el camino a Postgres es una decisión pendiente, ver [docs/cuentas-github.md](docs/cuentas-github.md#camino-a-postgres-y-réplicas-una-decisión-pendiente-no-tomada)) y no tiene pantalla de administración de cuentas, solo la API.
- La generación con IA solo se ha probado de verdad con un modelo (DeepSeek-V4-Pro por Foundry, 28-09-2026): ver [docs/ia.md](docs/ia.md#prueba-real-de-generate).
- Quedan fuera de alcance el servidor MCP, las vistas de despliegue y de código de C4 y exportar a DSL de Structurizr.

## Contribuir, seguridad y licencia

- [CONTRIBUTING.md](CONTRIBUTING.md): cómo preparar el entorno, qué comprobar antes de abrir una PR y el estilo del repositorio.
- [SECURITY.md](SECURITY.md): cómo informar de una vulnerabilidad.
- [CHANGELOG.md](CHANGELOG.md): qué cambió en cada versión.
- [LICENSE](LICENSE): licencia MIT.
