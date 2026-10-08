# Registro de cambios

Todos los cambios relevantes de IArk - DIAgrams se anotan aquí. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, el [versionado semántico](https://semver.org/lang/es/). Mientras la serie sea `0.x`, un cambio de versión menor puede traer cambios incompatibles.

## [Unreleased]

- Cambios de la fase 1 del plan de robustecimiento en curso.

### Añadido

- **Trazabilidad v2** (fase 2): los enlaces entre módulos llevan tipo. Los seis módulos aceptan `refType` junto a `ref` (vocabulario abierto `[a-z][a-z0-9-]*`; sugeridos `depends-on`, `implements`, `deploys`, `protects`, `realizes`, `derives` y `documents`), `TraceLink.type` siempre está presente (`depends-on` si no se declara) y los esquemas JSON de `schema/` incluyen el campo nuevo. Los ejemplos traen enlaces tipados.
- Huérfanos (`traceOrphans`), matriz de enlaces por módulo o tipo de elemento con desglose por tipo (`traceMatrix`) y cobertura por reglas `origen -> destino` (`traceCoverage`), como funciones puras del kernel.
- `iark trace` y `iark project trace`: `--type` (repetible), `--orphans [módulo[:tipo]]`, `--matrix [module|kind]`, `--coverage <regla>` (repetible), `--min-coverage <n>` y `--strict-unresolved`. `POST /api/trace` acepta `types`, `orphans`, `matrix` y `coverage`.
- Vista web `trazabilidad.html`: filtro por tipo de enlace, tipo en las aristas del grafo y en la lista de enlaces, y pestañas Matriz (con colores de calor accesibles), Huérfanos y Cobertura. El panel de propiedades del banco de trabajo elige el tipo del enlace y «Referenciado por» lo muestra.

### Cambiado

- `iark trace --strict`, además de fallar (código 3) con referencias mal formadas, inexistentes o ambiguas, falla si una cobertura medida queda por debajo del mínimo (100 % por omisión). Las referencias a módulos sin documento seguían sin contar con `--strict`, y ahora la nueva `--strict-unresolved` permite contarlas.
- Los informes de trazabilidad rotulan el tipo del enlace (Markdown, Mermaid y SVG) salvo en `depends-on`; los documentos sin `refType` producen el mismo informe que antes y el JSON solo crece (`type` en cada enlace).

## [0.1.0] - 2026-10-07

Primera versión: reúne lo construido entre el 2026-09-24 (primer commit del repositorio, el núcleo C4 con CLI y exportación `.drawio`) y el 2026-10-07 (último commit de `master` al escribir este registro). El detalle de cada tanda, con sus PR, está en [`docs/roadmap.md`](docs/roadmap.md). No hay etiqueta `v0.1.0` en git todavía.

### Añadido

**Suite y módulos**

- Monorepo con workspaces de npm: `@iark/kernel` (contrato `DomainModule`, registro de módulos, URN `urn:iark:<módulo>:<id>`, manifiesto `iark.manifest/1`, IA estructurada, sintaxis Mermaid, layout y SVG de grafos) y un módulo por especialidad: **C4** (el editor original, ahora el módulo `c4`), **integración** (notación EIP, contratos editables), **datos** (linaje, ERD, gobierno del dato, productos y glosario), **empresarial** (capacidades, procesos, aplicaciones y tecnología con ciclo de vida), **plataforma** (entornos, redes, recursos, despliegues, comparación de entornos) y **seguridad** (zonas de confianza, STRIDE, riesgos).
- Editor C4 interactivo: modelo C1 › C2 › C3, autolayout con ELK, deshacer y rehacer, minimapa, tema claro y oscuro, JSON como formato nativo y exportación 1 a 1 a `.drawio`.
- CLI `iark` (con `c4diagram` como alias), con los subcomandos propios de cada módulo (`iark integration …`, `iark data …`, `iark enterprise …`, `iark platform …`, `iark security …`).
- Banco de trabajo de módulos (`modulos.html`) con un lienzo común (React Flow): paleta de figuras por especialidad, panel de propiedades, reglas de conexión, acciones sobre la selección, vistas derivadas, autolayout y posiciones arrastrables.
- Trazabilidad entre módulos por referencias `ref: "urn:iark:<módulo>:<id>"`: `iark trace`, `POST /api/trace` y la vista web `trazabilidad.html`.

**Importadores y exportadores**

- Importadores: `.drawio` y DSL de Structurizr (C4), Mermaid (todos los módulos), Terraform (`.tf`, `.tf.json`, `.tfstate` y `terraform show -json`, también de una carpeta con varios `.tf`) y Kubernetes (plataforma), DDL de PostgreSQL, MySQL/MariaDB, SQL Server, Oracle y Snowflake, y `manifest.json` de dbt (datos), y ArchiMate (empresarial). Lo que no se puede mapear se informa en los avisos; nunca se descarta en silencio.
- Exportadores: `.drawio`, Mermaid y SVG en todos los módulos, y DDL por motor en datos.
- `iark import` unificado por módulo, `iark convert` y vista previa renderizada de Mermaid en la app.

**IA**

- `iark generate` (Claude con Anthropic o Foundry, y modelos compatibles con OpenAI) con salida estructurada, reintentos y refinado de un documento existente.
- Uso sin clave de API: `iark prompt` y los JSON Schema por módulo (`iark schema`) para que cualquier IA o agente genere los documentos.
- `--from-repo`: dibuja la arquitectura leyendo un repositorio, con presupuesto, lista blanca de lo que se lee, redacción de secretos y `--dry-run` para ver lo que se enviaría.

**Versionado y proyectos**

- `iark diff` y `diffDocuments`: comparan dos versiones de un documento de cualquier módulo (dos archivos, o un archivo contra una revisión de git), con la pestaña «Comparar» del banco de trabajo y `POST /api/<módulo>/diff`.
- Proyectos que agrupan diagramas de varios módulos: `iark project …` sobre una carpeta de trabajo, archivo único `iark.project/1` y gestor de proyectos en la app web (IndexedDB, autoguardado, aviso de conflicto entre pestañas).

**Nube y despliegue**

- `iark serve`: servicio HTTP con la API por módulo, el manifiesto de federación, la API de proyectos (`--workspace`) y el sitio (`--static`); tokens por persona con roles `viewer`, `editor` y `admin` (`iark auth create|list|revoke`).
- Servicio gestionado con inicio de sesión de GitHub (`--accounts`): sesiones con PKCE, cuentas y pertenencia a proyectos, compartir proyectos, administración de cuentas por API y cliente web («Dónde se guardan», «Compartir…»).
- Imagen Docker (`Dockerfile`): corre como usuario `node`, carpeta de datos `/data`, `HEALTHCHECK`; se niega a servir proyectos sin autenticación. `deploy/docker-compose.yml` con Caddy y HTTPS automático, [`docs/despliegue-nube.md`](docs/despliegue-nube.md) y `npm run docker:smoke`.
- Despliegue del sitio estático a `gh-pages` con GitHub Actions (`.github/workflows/deploy-pages.yml`).

**Embebido y federación**

- Modo embebido por `<iframe>` y `postMessage` con SDK de anfitrión, protocolo de módulos con `capabilities`, Web Component `<iark-module>` y shell `suite.html`.
- Federación por manifiesto: `/.well-known/iark.json` y JSON Schema publicados con el sitio.

**Plataforma**

- Iconografía de nubes: glifos propios de AWS y Azure (no los logotipos oficiales), registro de paquetes de iconos ampliable y `iark platform icons`.
- Comparación de dos o más entornos y equivalencias declaradas entre recursos (`counterpartOf`).

**Calidad**

- Pruebas con Vitest y Testing Library, y e2e con Playwright; `npm run typecheck` comprueba también las pruebas y los specs.
- Pruebas que impiden dependencias sin declarar en el paquete publicado y en cada paquete del monorepo (`tests/runtime-deps.test.ts`, `tests/dependencias-paquetes.test.ts`).

### Seguridad

- El escáner de `--from-repo` no lee `.env*`, claves y certificados privados, `.npmrc`, `.netrc`, `*.tfstate`/`*.tfvars` ni los Secret de Kubernetes, y redacta patrones de secretos.
- Los importadores de Terraform y Kubernetes no leen los valores del estado, del plan ni de los Secret.
- `iark serve` se niega a escuchar fuera de loopback con una carpeta de trabajo y sin autenticación; en la nube gestionada solo se guarda el hash de las sesiones.
