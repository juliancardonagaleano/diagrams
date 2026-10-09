# Módulo de datos

[← Índice de la documentación](../indice.md)

Tercera especialidad de la suite (`--module data`): modela **dónde viven los datos, de dónde vienen y quién responde por ellos**. Vive en `packages/domain-data`, sin depender del código C4 ni del de integraciones; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/ventas-datos.json`](../../examples/ventas-datos.json), esquema con `iark schema --module data`):

| Parte | Contenido |
|---|---|
| `domains` | áreas de negocio que agrupan activos (Ventas, Clientes…), con su responsable |
| `assets` | `source`, `database`, `warehouse`, `lake`, `stream`, `table`, `view`, `file`, `report` y `model`; una tabla, vista o archivo puede colgar de su base, almacén o lago (`parentId`). Gobierno: `owner`, `steward`, `classification` (`public`…`restricted`), `pii`, `retention`; y `columns` (tipo, `pk`/`fk`/`uk`, `pii`) |
| `pipelines` | de una o varias entradas a una o varias salidas: `batch`, `elt`, `cdc`, `streaming`, `replication`, `api` o `manual`, con `tool`, `schedule` y `anonymizes`; opcionalmente `mappings` (linaje de columnas: `{ from: { assetId, column }, to: { assetId, column }, transform }`, de una entrada a una salida del pipeline) |
| `relations` | entre entidades (tablas, vistas, archivos, streams): `1:1`, `1:N`, `N:1` o `N:M`; opcionalmente `sourceMin` / `targetMin` (`0` o `1`) para la opcionalidad de cada extremo |

No se guardan coordenadas: las vistas se derivan del modelo. `lineage` es el linaje completo, `erd` el modelo entidad-relación (fichas con sus columnas) y `domain:<id>` una por dominio, con los activos vecinos en discontinuo. El linaje de un activo concreto se pide por su id: `lineage:<activo>` (todo), `upstream:<activo>` (de dónde vienen sus datos) y `downstream:<activo>` (qué depende de él). Un pipeline cuyas entradas y salidas están en un mismo contenedor se dibuja dentro de él.

**Linaje a nivel de columna** (opcional y retrocompatible: sin `mappings` nada cambia). Un pipeline puede declarar qué columna de sus entradas alimenta qué columna de sus salidas; el panel de propiedades del pipeline los edita como líneas de texto, `activo.columna -> activo.columna : transformación`. La vista `column:<activo>.<columna>` (también en el selector, una por cada columna de origen) dibuja un impacto de columna: fichas con solo las columnas afectadas (la de partida con ●), aguas arriba y aguas abajo, hasta los informes y modelos que dependen de ella (los informes y modelos sin columnas declaradas aceptan cualquier nombre de indicador). Funciona en el lienzo, en el SVG y en Mermaid (`--view column:erp-pedidos.total`).

**Dos notaciones para el ERD** (opcional y retrocompatible). El ERD se dibuja por defecto en **pata de gallo**; en el selector «Notación» del lienzo (variante `erd:uml`, también `--view erd:uml`) pasa a **UML con multiplicidades** (`1`, `0..1`, `1..*`, `0..*`) escritas junto a cada extremo de la relación. Salen de la cardinalidad (`1:N` → `1` y `0..*`) y de `sourceMin` / `targetMin`: `targetMin: 1` convierte el lado «muchos» en `1..*` y `sourceMin: 0`, el lado «uno» en `0..1`; el panel de propiedades de la relación los edita. La notación UML llega al SVG, a una página más del `.drawio` (con las multiplicidades como etiquetas de arista) y a Mermaid (`classDiagram` con `"1" -- "1..*"`); el `erDiagram` en pata de gallo sigue siendo el de siempre y solo cambia sus símbolos (`|o`, `o{`, `|{`) cuando se declara la opcionalidad.

**Contratos y DDL por motor de base de datos** (opcional y retrocompatible). Una base, un almacén, un lago, una fuente o un stream puede declarar su `engine`: `postgresql`, `mysql`, `sqlserver`, `oracle`, `sqlite`, `mongodb`, `cassandra`, `dynamodb`, `bigquery`, `snowflake`, `redshift`, `databricks` o `kafka` (el registro es extensible con `registerEngine`, y `iark data engines <motor>` muestra el catálogo de tipos de cada uno); lo heredan las tablas que cuelgan de él. Con motor, `validate` avisa de las columnas cuyo tipo no existe en él y propone el equivalente («`varchar2(10)` no existe en PostgreSQL, ¿quisiste decir `varchar(255)`?»; SQLite acepta cualquier tipo y solo lo anota). El contrato de datos YAML declara su servidor con `servers[].type` (el borrador creado desde un activo lo rellena con el motor del activo); el editor de contratos valida cada `physicalType` contra ese motor, con línea y columna, y ofrece los tipos del motor como sugerencias. El **DDL** se exporta por dialecto: `CREATE TABLE` para los motores SQL (con sus comillas, claves primarias y tipos con parámetros), validador `$jsonSchema` para MongoDB, `CREATE TABLE` de CQL para Cassandra, definición de tabla para DynamoDB y esquema Avro para Kafka; lo que el motor no admite se avisa en lugar de omitirse en silencio. Una clave primaria o única de un tipo que el motor no admite como clave (`text`, `blob` o `json` en MySQL y MariaDB; `clob`, `nclob`, `blob` y `long` en Oracle; `json`, `xml` y los geométricos en PostgreSQL; `text`, `ntext`, `image`, `xml` y los `(max)` en SQL Server; `EngineDef.sql.noKeyTypes`, extensible con `registerEngine`) es un aviso de `validate` con el arreglo (`varchar(n)` o una clave sustituta), y el DDL deja el tipo tal cual con un comentario `-- AVISO:` y lo suma a los avisos que el CLI deja en stderr. `iark data ddl --asset` acepta un contenedor, y también un producto de datos (las tablas de los activos de sus puertos), una API (las de los activos que expone) o un glosario (las de los activos con términos suyos enlazados).

`validate` comprueba la estructura y aplica reglas de **gobierno** que siguen el linaje: datos personales sin clasificar o clasificados por debajo de confidencial, un activo derivado de otro más sensible con una clasificación menor (salvo que su pipeline anonimice), activos sin responsable (más grave con datos personales), informes o modelos sin pipeline que los escriba, un mapeo a una columna que el activo no declara, datos personales que llegan por un mapeo a una columna no marcada como PII (salvo que el pipeline anonimice), pipelines por lotes sin frecuencia, ciclos de linaje y relaciones N:M sin tabla intermedia.

```bash
iark validate  datos.json --module data
iark convert   datos.json --module data --out linaje.svg                 # también .mmd (Mermaid) y .drawio (una página por vista)
iark convert   datos.json --module data --to mermaid --view erd          # erDiagram con columnas y claves
iark convert   datos.json --module data --out impacto.svg --view downstream:silver-ventas
iark import    linaje.mmd  --module data --out datos.json                # flowchart (linaje) o erDiagram → documento
iark import    esquema.sql --module data --out datos.json                # DDL de SQL (CREATE TABLE/VIEW, claves foráneas) → tablas, relaciones y vistas con linaje
iark import    manifest.json --module data --format dbt --out datos.json  # manifest.json de dbt → fuentes, modelos, pipelines y pruebas
iark generate  "Lago con CRM y ERP, almacén y un panel de ventas" --module data --json datos.json
iark data lineage silver-ventas datos.json                               # origen e impacto de un activo, con los responsables a avisar
iark data column-impact erp-pedidos.total datos.json                    # de qué columnas sale y qué columnas, informes y modelos dependen de ella
iark data catalog datos.json                                             # tabla Markdown de activos con dominio, responsable y clasificación
iark data pii datos.json                                                 # datos personales y adónde llegan sin anonimizarse
iark data from-integration mapa.json                                     # almacenes, colas y tópicos de un mapa de integración → activos con URN
iark data ddl datos.json                                                 # DDL de las tablas, con el dialecto del motor de cada una (también en Exportar › DDL)
iark data ddl datos.json --asset erp --engine mysql --schema ventas      # solo las tablas de «erp», traducidas a MySQL
iark data ddl datos.json --asset producto-ventas                         # --asset acepta también un producto, una API o un glosario: las tablas de sus activos
iark data ddl datos.json --contract contrato-pedidos                     # esquema de un contrato de datos; su servers[].type fija el dialecto
iark data ddl datos.json --engine mongodb --format json                  # validador $jsonSchema de MongoDB como JSON
iark data engines [motor]                                                # motores del registro y su catálogo de tipos
```

Al importar un `flowchart`, `[( )]` es una base de datos, `([ ])` un stream y el resto tablas; cada arista (`A & B --> C`) es un pipeline (continua = por lotes, punteada = streaming, gruesa = CDC, o el tipo entre corchetes al final de la etiqueta) y un `subgraph` es un contenedor cuyo tipo se toma del prefijo que pone el exportador («Data lake: …»). Del `erDiagram` se conservan tipos, claves, multiplicidad y opcionalidad (`|o`, `o{`, `|{`…).

**Importar DDL de SQL y dbt** (`--format ddl|dbt|auto`; también en la pestaña «Importar» y con «Abrir archivo…» del banco de trabajo). El DDL (`.sql`, `.ddl`) lo lee un analizador propio y tolerante para PostgreSQL, MySQL/MariaDB, SQL Server, Oracle y Snowflake: cada `CREATE TABLE` (y `CREATE TABLE … AS`) es una tabla con sus columnas (tipo con parámetros, `pk`, `uk`, `fk`, nulos y descripción desde `COMMENT`), el esquema (`ventas.pedido`) pasa a ser un contenedor `database`, las claves foráneas (`FOREIGN KEY`, `REFERENCES`, `ALTER … ADD CONSTRAINT`) son relaciones con su cardinalidad (`1:1` si la clave es única, `1:N` si no; la opcionalidad va en la descripción) y cada `CREATE [MATERIALIZED] VIEW` es una vista con un pipeline `elt` desde sus `FROM` y `JOIN`, y con linaje por columna cuando es un `SELECT` simple. El `manifest.json` de dbt (`.json`, se reconoce por `metadata.dbt_schema_version`) aporta fuentes (`sources`), modelos, semillas y snapshots (tabla o vista según su materialización, colgados de un almacén por base y esquema), un pipeline `elt` por cada dependencia (`depends_on.nodes`), las pruebas `unique`, `not_null` y `relationships` como claves y relaciones, y las exposiciones como informes. **No se deduce nada de gobierno**: la clasificación, los datos personales, el propietario y la retención solo se rellenan si el `meta` de dbt los declara; un nombre de columna como `email` o `dni` solo genera un aviso informativo. Todo lo que no encaja (valores por defecto, `CHECK`, índices, funciones, permisos, `analysis`, macros, métricas, pruebas sin claves…) se resume en los avisos y no se descarta en silencio; una entrada rota termina con el código 2 y el motivo de una línea. Importar dos veces el mismo archivo da el mismo documento.

**Catálogo de datos: productos, APIs y glosario** (opcional y retrocompatible: un documento 1.0 sin estos elementos no cambia ni cambian sus vistas; ejemplo en [`examples/datos-catalogo.json`](../../examples/datos-catalogo.json)). Tres clases nuevas de activo y un elemento nuevo, el término, para gobernar los datos como producto y no solo como tablas:

| Elemento | Qué es | Campos (todos opcionales) |
|---|---|---|
| `data-product` (Producto de datos) | agrupa activos y los ofrece como un servicio con dueño (data mesh) | `inputPorts` (lo que consume) y `outputPorts` (lo que publica), ambos ids de activos; `owner`, `domainId`, `classification`, `freshness` («24 h»), `sla`, `contractId` |
| `data-api` (API de datos) | expone activos a otras aplicaciones | `exposes` (ids de los activos que sirve), `protocol` (`rest`, `graphql`, `grpc`, `odata`, `sql`, `events`), `endpoint`, `contractId`, `owner` |
| `glossary` (Glosario) | agrupa términos de negocio; no guarda datos, así que no participa en pipelines ni en relaciones | `owner`, `domainId`, `description` |
| `terms` (Término, en la raíz del documento) | concepto de negocio con su definición | `name`, `definition`, `status` (`draft`, `approved`, `deprecated`; sin estado, borrador), `owner`, `glossaryId`, `synonyms` y `links`: `{ assetId, column? }` al activo (o a una columna suya) donde se materializa |

Los puertos, lo que sirve una API y los enlaces de un término son referencias a activos, no copias: un activo puede estar a la vez en su base de datos y en un producto. El esquema rechaza un puerto de un activo que no es producto, un activo que es entrada y salida del mismo producto, una API que expone un glosario u otra API, un término enlazado a un glosario, un enlace repetido y referencias a elementos que no existen. Borrar un activo en el editor limpia los puertos, exposiciones y enlaces que lo apuntaban, y borrar un glosario, sus términos.

Vistas nuevas, derivadas del modelo como las demás: `products` (el mapa de productos de datos: productos y APIs con sus puertos de entrada y salida, su frescura, SLA y protocolo) y `glossary` (cada glosario como zona que contiene sus términos, con flechas discontinuas a los activos y columnas que los implementan). Los productos, APIs y glosarios ligados al catálogo dejan de aparecer en el linaje; los de un dominio salen además en su vista `domain:<id>`. El lienzo ofrece los cuatro elementos en la paleta, las relaciones **Publica**, **Consume**, **Expone** y **Define** (al arrastrar, con el motivo si no encajan), la columna de un enlace de término en el panel de propiedades (un desplegable con «Todo el activo» y las columnas del activo enlazado) y las acciones **Agrupar en producto…** (crea un producto que publica los activos seleccionados, con su dominio y dueño más comunes, o los añade a uno existente) y **Enlazar término**.

`validate` añade las reglas del catálogo: un producto sin dueño, sin salidas, sin entradas, sin frescura ni SLA o sin contrato; una API sin dueño, sin nada que exponer, **sin contrato** o sin protocolo; un producto o una API que publica datos sensibles con una clasificación menor (o ninguna); un glosario sin términos o sin responsable; un término aprobado sin enlace, sin definición o sin responsable (un borrador, solo como información); un término obsoleto que sigue enlazado, repetido en su glosario, sin glosario o enlazado a una columna que el activo no declara; y un pipeline que lee o escribe un glosario.

```bash
iark data products datos.json                                            # productos y APIs: dueño, frescura, SLA, puertos, protocolo y contrato
iark data glossary datos.json                                            # términos con su definición, estado, responsable y activos o columnas enlazados
iark convert   datos.json --module data --out productos.svg --view products   # mapa de productos (también .mmd y .drawio)
iark convert   datos.json --module data --out glosario.svg  --view glossary
```

En Mermaid un producto, una API y un término llevan su clase (`:::dataProduct`, `:::dataApi`, `:::term`; el glosario es un `subgraph` titulado «Glosario: …»), y las flechas se etiquetan «entrada», «salida», «expuesto en» y «define · columna». `iark import` los reconoce (también con los nombres en español) y los devuelve como productos, APIs, términos, puertos, exposiciones y enlaces, no como pipelines. La salida estructurada de `iark generate` incluye los tres tipos y los `terms`; el contrato de un producto o una API se escribe en `contracts` y se enlaza con `contractId`, como el de cualquier activo.

## Importar OpenLineage

`--format openlineage|auto` (también en la pestaña «Importar» y con «Abrir archivo…»). [OpenLineage](https://openlineage.io) es el estándar abierto de linaje que emiten Airflow, Spark, Flink, dbt y otros: es lo que ocurrió de verdad en tu plataforma, en vez de lo que alguien dibujó. Se acepta un evento (JSON), una lista de eventos (JSON) o un evento por línea (NDJSON o `.jsonl`, como los guardan Marquez y los transportes a archivo); `auto` lo reconoce por el contenido (un evento con `eventTime` y `producer`).

| OpenLineage | Documento de datos |
|---|---|
| `job` (`namespace` + `name`) | un pipeline por job (todas sus ejecuciones se unen); `jobType` y `processing_engine` dan su tipo (streaming, ELT, por lotes) y su herramienta |
| `inputs` y `outputs` de sus eventos | entradas y salidas del pipeline |
| `namespace` de un dataset (`postgres://…`, `snowflake://…`, `s3://…`, `kafka://…`) | su contenedor: base de datos, almacén, lago o fuente según la plataforma; un topic de Kafka o similar es un `stream` suelto |
| `name` de un dataset | tabla (o archivo, en un lago) con ese nombre, dentro de su contenedor |
| facet `schema` | columnas con nombre, tipo y descripción |
| facet `columnLineage` | mapeos de columna a columna del pipeline (la transformación va en `transform`) |
| facets `documentation`, `ownership` y `storage` | descripción, responsable y tecnología del activo o del pipeline |

Lo que el importador decide y avisa: los eventos `FAIL` y `ABORT` no cuentan (una ejecución fallida no da linaje fiable) y un job que solo falló no se importa; un job sin entradas o sin salidas no puede ser un pipeline (el módulo exige al menos una de cada), así que no se importa aunque sus datasets sí; un dataset que el job lee y escribe se quita de sus entradas (un pipeline no puede leer y escribir el mismo activo); los mapeos de columna cuyo origen no es una entrada del job se descartan; y los facets sin correspondencia (consultas SQL, estadísticas, calidad, tiempos de ejecución…) se cuentan en un solo aviso. **No se deduce nada de gobierno** (clasificación, datos personales, retención): solo el responsable que declare el facet `ownership`. El motor de base de datos tampoco se deduce del namespace, porque los tipos de columna de OpenLineage mezclan el vocabulario del motor y el de Spark: se lee como tecnología.

```console
$ iark import eventos-tienda.json --module data --format openlineage --out datos.json
aviso: 1 evento(s) FAIL o ABORT no cuentan para el linaje: una ejecución fallida no da linaje fiable.
aviso: 1 job(s) solo tienen ejecuciones fallidas o abortadas y no se importan: «etl_diario.limpiar_temporales».
aviso: 1 evento(s) de dataset (DatasetEvent, sin «job») no se importan: solo aportan datasets cuando un job los lee o escribe.
aviso: 1 job(s) no se importan como pipeline porque necesitan al menos una entrada y una salida: auditar.revisar_pedidos (no escribe ningún dataset). Sus datasets sí se importan como activos.
aviso: 1 job(s) leen y escriben el mismo dataset («compactar_pedidos»): se quita de sus entradas, porque un pipeline no puede leer y escribir el mismo activo.
aviso: 1 mapeo(s) de columna se descartan porque su origen no es una entrada del job o su destino no es una de sus salidas (p. ej. linaje indirecto de otro namespace).
aviso: Facets sin correspondencia en el modelo, que no se importan: nominalTime (ejecución) ×2, sql (job) ×2.
Importado "eventos-tienda" en el módulo data: 14 elementos, 7 aviso(s).
Documento del módulo data escrito en datos.json
$ iark validate datos.json --module data
…
Documento válido (módulo data). 0 error(es), 1 aviso(s), 13 nota(s).
```

Los archivos de ejemplo, [`eventos-tienda.json`](../../tests/fixtures/importar/openlineage/eventos-tienda.json) (una lista de eventos de Airflow y Spark) y [`pagos-flink.ndjson`](../../tests/fixtures/importar/openlineage/pagos-flink.ndjson) (dos eventos de Flink, uno por línea), están escritos para las pruebas. El linaje de lo importado se consulta como el de cualquier documento: `iark data lineage <activo> datos.json`.
