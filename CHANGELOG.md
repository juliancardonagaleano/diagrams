# Registro de cambios

Todos los cambios relevantes de IArk - DIAgrams se anotan aquí. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones, el [versionado semántico](https://semver.org/lang/es/). Mientras la serie sea `0.x`, un cambio de versión menor puede traer cambios incompatibles.

## [Unreleased]

- Cambios de la fase 1 del plan de robustecimiento en curso.
- Pantalla «Administración de la instancia» para quien administra un servicio con cuentas (`siteRole: admin`): lista, busca y filtra las cuentas, invita por usuario de GitHub, cambia el rol, desactiva y reactiva, y cancela invitaciones, con confirmación y los errores del servidor a la vista. Se abre con «Administrar cuentas…» en «Dónde se guardan» y a los demás no les aparece; el cliente HTTP gana `listAccounts`, `setAccount` y `cancelInvitation`. Ver [`docs/cuentas-github.md`](docs/cuentas-github.md#pantalla-de-administración).
- Observabilidad de `iark serve` ([`docs/observabilidad.md`](docs/observabilidad.md)):
  - Cada respuesta lleva `X-Request-Id` (se respeta el de la petición si tiene hasta 64 caracteres seguros; si no, un UUID), que también sale en los registros y en el aviso de un error interno.
  - `--access-log <archivo|->` (`IARK_ACCESS_LOG`): registro de accesos en JSON por línea (plantilla de la ruta sin identificadores ni query string, estado, duración, bytes, dirección según `--trust-proxy`, quién llama). Nunca anota credenciales, cookies, el código ni el verificador del inicio de sesión, cuerpos ni contenido.
  - `--audit-log <archivo|->` (`IARK_AUDIT_LOG`): auditoría de quién intentó cambiar qué (proyectos, diagramas, miembros, cuentas, inicios de sesión), con el resultado `ok`, `denied` o `error`; también las peticiones denegadas. Archivo `0600` al que solo se añade; si falla, el servicio sigue y avisa.
  - `GET /healthz` (vivo) y `GET /readyz` (listo: carpeta de trabajo escribible, tokens, cuentas y cálculo). El `HEALTHCHECK` de la imagen y del compose pasa a consultar `/healthz`.
  - `--metrics` (`IARK_METRICS=1`) sirve `GET /metrics` en formato Prometheus, con `--metrics-token` (`IARK_METRICS_TOKEN`) o solo a loopback; el arranque se niega a abrirlas fuera de loopback sin token. Sin etiquetas por persona, proyecto ni dirección.
  - `SIGHUP` vuelve a abrir los archivos de registro tras rotarlos. `deploy/docker-compose.yml` manda los accesos a la salida estándar y la auditoría a `/data/audit.jsonl`.
  - `docker:smoke` comprueba `/healthz`, `/readyz` y que `/metrics` no existe por omisión; además, su comprobación del «Client secret equivocado» esperaba un registro vacío y ahora espera el motivo (`GitHub no lo aceptó (rejected)`) sin el secreto, que es lo que el servicio escribe desde que lo cuenta la guía de despliegue.

### Añadido

- **Migración de documentos por módulo.** `DomainModule.migrations` declara cómo llevar un documento de una versión anterior a la `documentVersion` actual; `migrateDocument` (en `@iark/kernel`) aplica la cadena sin modificar la entrada y `analyzeValue`/`analyzeText` migran antes de validar, así que el banco de trabajo, el servicio, los proyectos, los borradores del navegador y «Comparar» abren documentos antiguos con una nota «Documento migrado de la versión X a Y». Un documento de una versión más nueva se rechaza con «actualiza IArk». Ver [`docs/versionado-documentos.md`](docs/versionado-documentos.md).
- **`iark migrate`** reescribe un documento en la versión actual del módulo (`--out`, `--stdin`, `--module`); con `--check` no escribe y sale con código 1 si necesita migración. `validate` informa «migrado de X a Y».
- **`contractVersion` del contrato `DomainModule`** (`CONTRACT_VERSION`, `assertModuleContract`, `isContractCompatible`): `ModuleRegistry.register` rechaza un módulo escrito para un contrato más nuevo y una cadena de migraciones con huecos o ciclos. Los seis módulos lo declaran y las capacidades y el manifiesto lo publican.
- **Negociación de la versión del protocolo embebido** (`EMBED_PROTOCOL_VERSION`, `negotiateProtocol`): `init` y `load` llevan la versión; una versión mayor distinta produce un `error` con `code: 'incompatible-protocol'` en ambos lados (SDKs, `<iark-module>` y editores) y una diferencia de menor se acepta. El manifiesto añade `protocol` y, por módulo, `contractVersion` (opcionales al leer; el esquema sigue siendo `iark.manifest/1`), y el shell rechaza con un mensaje claro una instancia de esquema o protocolo mayor y aparta los módulos que exigen un contrato más nuevo.
- Pruebas con documentos antiguos congelados (`tests/fixtures/documentos/<módulo>-v1.0.json`): si un cambio de esquema los rompe, hace falta una migración.
- **Módulos de terceros e `iark.config.json`.** Un paquete que implementa `DomainModule` se carga en el CLI y en `iark serve` sin tocar el repositorio: `iark.config.json` (solo JSON: `modules` y `defaultModule`, con esquema en `schema/iark-config.schema.json`), `--config <archivo>` / `IARK_CONFIG`, el `iark.config.json` del directorio actual (sin subir a las carpetas padre) y `--no-config` / `IARK_NO_CONFIG=1`. Los especificadores se resuelven respecto a la carpeta de la configuración (ruta, carpeta de paquete, nombre de paquete instalado o URL `file:`). `defineModule` y `assertModuleShape` (en `@iark/kernel`) comprueban la forma con mensajes que nombran el especificador, los ids no pueden colisionar con otro módulo ni con un comando del CLI y cualquier fallo termina con código 2. Cada módulo cargado se anota en stderr, `iark modules` muestra su origen y versiones, el manifiesto de federación lo publica (sin ruta local ni editor web) y los hilos de cálculo de `iark serve` cargan los mismos plugins. **Cargar un módulo ejecuta su código**: nunca se carga de `--from-repo`, `--workspace`, una petición HTTP ni un documento. **El sitio web no carga módulos de terceros.** Guía y seguridad: [`docs/plugins.md`](docs/plugins.md); ejemplo completo en `examples/plugin-riesgos/`.
- **Paquetes `@iark/*` publicables.** `@iark/kernel` y los seis `@iark/domain-*` declaran licencia, repositorio, `files` y `publishConfig` (el `exports` de desarrollo sigue apuntando a `src/*.ts`). `npm run packages:build` los prepara en `dist-packages/` (JavaScript ESM, tipos y `package.json` de publicación) y `npm run packages:check` los empaqueta, los instala en una carpeta limpia solo desde los tarballs y comprueba que importan, que sus tipos resuelven y que un módulo de terceros se carga con `iark --config` y `iark serve --config`. El job `packages` de CI es informativo. El workflow `release-packages.yml` publica en npm solo a mano (`workflow_dispatch`, con `dry-run` por omisión); todavía no se ha publicado nada (falta el ámbito `@iark` en npm y el secreto `NPM_TOKEN`).
- **Trazabilidad v2** (fase 2): los enlaces entre módulos llevan tipo. Los seis módulos aceptan `refType` junto a `ref` (vocabulario abierto `[a-z][a-z0-9-]*`; sugeridos `depends-on`, `implements`, `deploys`, `protects`, `realizes`, `derives` y `documents`), `TraceLink.type` siempre está presente (`depends-on` si no se declara) y los esquemas JSON de `schema/` incluyen el campo nuevo. Los ejemplos traen enlaces tipados.
- Huérfanos (`traceOrphans`), matriz de enlaces por módulo o tipo de elemento con desglose por tipo (`traceMatrix`) y cobertura por reglas `origen -> destino` (`traceCoverage`), como funciones puras del kernel.
- `iark trace` y `iark project trace`: `--type` (repetible), `--orphans [módulo[:tipo]]`, `--matrix [module|kind]`, `--coverage <regla>` (repetible), `--min-coverage <n>` y `--strict-unresolved`. `POST /api/trace` acepta `types`, `orphans`, `matrix` y `coverage`.
- Vista web `trazabilidad.html`: filtro por tipo de enlace, tipo en las aristas del grafo y en la lista de enlaces, y pestañas Matriz (con colores de calor accesibles), Huérfanos y Cobertura. El panel de propiedades del banco de trabajo elige el tipo del enlace y «Referenciado por» lo muestra.

**IA: verificación, topes y evals (fase 3, acción 9)**

- `iark generate` **verifica lo generado con `validate()` del módulo** (con las tres plataformas: `anthropic`, `foundry` y `openai`) y reintenta devolviéndole al modelo los errores de las reglas, además de los del esquema. `--no-verify` lo desactiva, `--allow-invalid` acepta el documento aunque siga con errores, y `--strict` también devuelve los avisos. El informe dice cuántos reintentos fueron por el esquema y cuántos por las reglas.
- **Topes de tokens, sin precios**: `--max-tokens` (salida por llamada, 16.000 por omisión), `--budget-tokens` (total sumado en los reintentos, 200.000) y `--max-input-tokens` (rechaza antes de llamar un prompt estimado mayor, 100.000), o `IARK_AI_MAX_TOKENS`, `IARK_AI_BUDGET_TOKENS` e `IARK_AI_MAX_INPUT_TOKENS`. Con `--from-repo`, el rechazo dice qué recortar; `--dry-run` y `prompt` informan del tamaño estimado. Informe de tokens por intento y totales.
- **`iark explain` y `iark review`**: explican o revisan en Markdown un diagrama de cualquier módulo (`--module`, `--lang es|en`, `--out`, `--stdin`, y las opciones de plataforma, modelo y presupuesto); `review` pasa al modelo las incidencias de `validate()`. `AiSpec` gana tres campos opcionales (`serialize`, `explainGuide`, `reviewGuide`): los módulos y plugins que no los tengan siguen funcionando.
- **Evals de prompts**: `npm run evals` (16 casos de los seis módulos con respuestas grabadas a mano en `evals/recorded/`, sin red ni claves, también dentro de `npm test`) y `npm run evals:live` (modelo real, con `--yes` y tope de tokens por ejecución). Informe por módulo y por caso.
- `tests/ai-live.test.ts`: prueba real de la IA que se salta sin `IARK_LIVE_AI=1` y credenciales (ver [docs/ia.md](docs/ia.md#prueba-real-automatizada-testsai-livetestts)).
- Documentado por qué `iark serve` no ofrece IA y qué habría que exigir antes de añadirla ([docs/servicio.md](docs/servicio.md#por-qué-no-hay-ia-en-el-servicio)), con una prueba que fija que no hay ninguna ruta.

**Importadores de formatos reales (fase 3, acción 13)**: cada módulo importa ya al menos un formato real además de Mermaid ([`docs/importadores.md`](docs/importadores.md)). Lo que cada importador no traslada va a los avisos (nunca se calla ni hace fallar la importación), sin red ni disco al importar, y el resultado cumple el esquema del módulo y `validate()`.

- **Integración: OpenAPI y AsyncAPI** (`--format openapi|asyncapi`, YAML o JSON; OpenAPI 3.x y Swagger 2.0, AsyncAPI 2.x y 3.x). OpenAPI da un sistema, un nodo `api` por grupo de operaciones, las interacciones hacia un «Cliente de la API» (se avisa) y un contrato con el texto original; AsyncAPI, los brokers, los tópicos o colas y las interacciones asíncronas de la aplicación. Solo se siguen las referencias internas `#/…` (con control de ciclos y de profundidad); las de archivo o URL se avisan y no se leen.
- **Seguridad: OWASP Threat Dragon** (`--format threat-dragon`, JSON v2): actores, procesos y almacenes, flujos con su protocolo y cifrado, fronteras de confianza (zonas, con el anidamiento deducido de la geometría), amenazas con su categoría STRIDE, estado y severidad, y sus mitigaciones como controles. Lo que Threat Dragon no dice (qué lado de una frontera es más confiable, la probabilidad, las categorías LINDDUN o CIA) se decide con un valor por defecto y un aviso.
- **Datos: OpenLineage** (`--format openlineage`, un evento, una lista o NDJSON): un pipeline por job, tablas y contenedores por namespace, columnas del facet `schema` y mapeos del facet `columnLineage`. Los eventos `FAIL` y `ABORT` no cuentan y no se deduce ningún dato de gobierno.
- **Empresarial: BPMN 2.0** (`--format bpmn`, XML): participantes y carriles como unidades, procesos y actividades como procesos, `sequenceFlow` y `messageFlow` como relaciones. Los eventos y las compuertas no son procesos: la relación que pasa por ellos se une entre actividades y sus nombres quedan en la descripción. Datos, anotaciones, extensiones de herramienta y diagrama gráfico se avisan.
- **Plataforma: AWS CloudFormation** (`--format cloudformation`, YAML con etiquetas cortas `!Ref`, `!Sub`, `!GetAtt`… leídas como datos, o JSON) y **Helm** (`--format helm`: `Chart.yaml` + `values.yaml` + `requirements.yaml`, como carpeta o archivos sueltos). La salida de `helm template` entra por el importador de Kubernetes, que ahora nombra el espacio de trabajo y el entorno con el chart (`helm.sh/chart` o `# Source:`) cuando no hay nombre de archivo. Un chart no se renderiza nunca y no se descarga ningún subchart; `Fn::ImportValue`, `Transform`, `Conditions` y las pilas anidadas se avisan.
- **Núcleo** (`@iark/kernel`): `IMPORT_LIMITS`, `textSizeProblem` y `treeProblem` (topes comunes: 32 MiB de texto, profundidad 200 y 2 000 000 de nodos), `readJsonText`/`withoutBom`/`asRecord`/`asArray`/`asString` para leer JSON sin romper con una entrada patológica, y `pickImporter`. Los textos vacíos, de otro tipo, truncados o con `$ref` cíclicos dan un error o un aviso claro, nunca un cuelgue. Sin dependencias de ejecución nuevas (el YAML usa `yaml` y el XML, `fast-xml-parser`, sin entidades externas).
- Pruebas con archivos realistas en `tests/fixtures/importar/` (escritos para el proyecto) y `tests/importar-formatos-reales-cli.test.ts`: importar → `validate` → `convert --to mermaid` por la CLI y `POST /api/<módulo>/import` por el servicio, para cada formato.

### Cambiado

- `iark modules` imprime una tercera línea por módulo con su origen (`incorporado` o el especificador del plugin), el `contractVersion` y la `documentVersion`.
- `ModuleRegistry.register` acepta `{ origin }` y expone `originOf(id)`; `ModuleError` se reconoce por una marca (`Symbol.for`) y no solo por `instanceof`, porque un plugin usa otra copia del kernel que la incrustada en el CLI.
- El `persist` del editor C4 (`localStorage`) tiene `migrate` y pasa el documento por las migraciones del módulo C4; antes, lo guardado con otra versión de la forma persistida se descartaba. Los `load`/`merge` del protocolo del editor C4 aceptan documentos antiguos migrables en vez de rechazarlos por el literal de la versión.
- `iark trace --strict`, además de fallar (código 3) con referencias mal formadas, inexistentes o ambiguas, falla si una cobertura medida queda por debajo del mínimo (100 % por omisión). Las referencias a módulos sin documento seguían sin contar con `--strict`, y ahora la nueva `--strict-unresolved` permite contarlas.
- Los informes de trazabilidad rotulan el tipo del enlace (Markdown, Mermaid y SVG) salvo en `depends-on`; los documentos sin `refType` producen el mismo informe que antes y el JSON solo crece (`type` en cada enlace).
- **`generate` ahora también verifica con `validate()`**: un documento que cumple el esquema pero incumple las reglas del módulo (hoy, solo los errores de C4) ya no se acepta a la primera: se reintenta y, si sigue mal, termina con código 3 (antes, 0). `--no-verify` devuelve el comportamiento anterior. Los códigos de salida de la IA pasan a ser `2` (uso o prompt demasiado grande), `3` (incumple las reglas) y `4` (resto de errores del modelo).
- **Elección del importador cuando varios comparten extensión** (`pickImporter`): si más de un importador de un módulo declara `.yaml`, `.json` o `.xml`, gana el primero cuyo `detect` reconoce el contenido y, si ninguno, el primero declarado; con una sola declaración manda la extensión, como antes. Con varios formatos de archivos múltiples (Terraform y Helm), el mensaje de «no son todos del mismo formato» agrupa las extensiones por formato («.tf o los .yaml, .yml») en vez de mezclarlas en una sola lista.
- **Importador de Kubernetes**: rechaza con un error claro un texto de más de 32 MiB, un anidamiento que agotaba la pila del analizador de YAML y una bomba de alias (antes, un `RangeError` o `ReferenceError` sin capturar); sus ayudantes de cantidades e imágenes se exportan para el importador de Helm.
- Las listas de formatos de importación que fijan las pruebas y el manifiesto (`public/.well-known/iark.json`, regenerado con `npm run manifest`) incluyen los formatos nuevos; `docs/importadores.md`, la página de cada módulo, `docs/cli.md`, `docs/servicio.md` y el `README` los describen.

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
