# Registro de cambios

Todos los cambios relevantes de IArk - DIAgrams se anotan aquí. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, el [versionado semántico](https://semver.org/lang/es/). Mientras la serie sea `0.x`, un cambio de versión menor puede traer cambios incompatibles.

## [Unreleased]

- Cambios de la fase 1 del plan de robustecimiento en curso.

### Añadido

**IA: verificación, topes y evals (fase 3, acción 9)**

- `iark generate` **verifica lo generado con `validate()` del módulo** (con las tres plataformas: `anthropic`, `foundry` y `openai`) y reintenta devolviéndole al modelo los errores de las reglas, además de los del esquema. `--no-verify` lo desactiva, `--allow-invalid` acepta el documento aunque siga con errores, y `--strict` también devuelve los avisos. El informe dice cuántos reintentos fueron por el esquema y cuántos por las reglas.
- **Topes de tokens, sin precios**: `--max-tokens` (salida por llamada, 16.000 por omisión), `--budget-tokens` (total sumado en los reintentos, 200.000) y `--max-input-tokens` (rechaza antes de llamar un prompt estimado mayor, 100.000), o `IARK_AI_MAX_TOKENS`, `IARK_AI_BUDGET_TOKENS` e `IARK_AI_MAX_INPUT_TOKENS`. Con `--from-repo`, el rechazo dice qué recortar; `--dry-run` y `prompt` informan del tamaño estimado. Informe de tokens por intento y totales.
- **`iark explain` y `iark review`**: explican o revisan en Markdown un diagrama de cualquier módulo (`--module`, `--lang es|en`, `--out`, `--stdin`, y las opciones de plataforma, modelo y presupuesto); `review` pasa al modelo las incidencias de `validate()`. `AiSpec` gana tres campos opcionales (`serialize`, `explainGuide`, `reviewGuide`): los módulos y plugins que no los tengan siguen funcionando.
- **Evals de prompts**: `npm run evals` (16 casos de los seis módulos con respuestas grabadas a mano en `evals/recorded/`, sin red ni claves, también dentro de `npm test`) y `npm run evals:live` (modelo real, con `--yes` y tope de tokens por ejecución). Informe por módulo y por caso.
- `tests/ai-live.test.ts`: prueba real de la IA que se salta sin `IARK_LIVE_AI=1` y credenciales (ver [docs/ia.md](docs/ia.md#prueba-real-automatizada-testsai-livetestts)).
- Documentado por qué `iark serve` no ofrece IA y qué habría que exigir antes de añadirla ([docs/servicio.md](docs/servicio.md#por-qué-no-hay-ia-en-el-servicio)), con una prueba que fija que no hay ninguna ruta.

### Cambiado

- **`generate` ahora también verifica con `validate()`**: un documento que cumple el esquema pero incumple las reglas del módulo (hoy, solo los errores de C4) ya no se acepta a la primera: se reintenta y, si sigue mal, termina con código 3 (antes, 0). `--no-verify` devuelve el comportamiento anterior. Los códigos de salida de la IA pasan a ser `2` (uso o prompt demasiado grande), `3` (incumple las reglas) y `4` (resto de errores del modelo).

### Corregido

- Con la API de Anthropic y con Claude en Foundry, una respuesta cortada por el tope de salida o que no cumplía el esquema de zod no se podía reintentar ni explicar (el SDK la rechazaba al analizarla); ahora se trata como en las demás plataformas.

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
