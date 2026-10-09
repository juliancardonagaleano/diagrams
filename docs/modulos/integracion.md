# Módulo de integraciones

[← Índice de la documentación](../indice.md)

Segunda especialidad de la suite (`--module integration`): modela **cómo se hablan los sistemas** (APIs, servidores MCP, pasarelas, brokers, colas y tópicos, almacenes, conectores, tareas programadas y usuarios), con sus **contratos editables** (OpenAPI, `.proto` de gRPC, CloudEvents y MCP) y los flujos de extremo a extremo. Vive en `packages/domain-integration` y no depende del código C4: se enlaza con él solo por referencias URN (`urn:iark:c4:<id>`).

Documento JSON (ejemplo completo en [`examples/pedidos-integracion.json`](../../examples/pedidos-integracion.json), esquema con `iark schema --module integration`):

| Parte | Contenido |
|---|---|
| `nodes` | los doce tipos de la notación (tabla siguiente); opcionales `technology`, `owner`, `external`, `ref` (URN al elemento C4 o de otro módulo), `contractId` (su contrato), `domain` (zona de un equipo o dominio) y, en un nodo `pattern`, el `pattern` EIP que aplica |
| `contracts` | `openapi`, `asyncapi`, `graphql`, `protobuf` (el `.proto` de gRPC), `avro`, `json-schema`, `wsdl`, `cloudevents`, `mcp` u `other`, con `version` y el texto en `content` |
| `interactions` | de un nodo a otro: `style` (`request-response`, `async-message`, `event`, `batch`, `stream`), `protocol`, `pattern` (18 patrones EIP y de resiliencia), `contractId`, `criticality` y `order` (lugar en la secuencia) |
| `flows` | secuencias ordenadas de interacciones (p. ej. «Crear un pedido») |

## Notación EIP

La misma figura en el lienzo, el SVG y el `.drawio` (una sola geometría en `packages/kernel/src/graph/shapes.ts`):

| Tipo | Figura | Lo que modela |
|---|---|---|
| `system` | caja | aplicación o sistema, interno o externo |
| `api` | hexágono | interfaz que expone un sistema (dentro de él) |
| `mcp` | ficha | servidor MCP: herramientas, recursos y prompts para agentes de IA (dentro de un sistema) |
| `gateway` | flecha | pasarela de APIs, ESB o proxy; puede contener colas y tópicos |
| `broker` | barra | plataforma de mensajería; contiene colas y tópicos |
| `queue` | tubo | cola punto a punto |
| `topic` | abanico | tópico de publicación-suscripción |
| `store` | cilindro | base de datos, ficheros o bucket |
| `connector` | caja redondeada | conector o adaptador de canal |
| `scheduler` | reloj | tarea programada (solo dispara) |
| `user` | figura humana | usuario final (solo llama) |
| `pattern` | rombo | patrón EIP como nodo intermedio (traductor, enrutador, agregador…) |

## Contratos: la metadata de las figuras

Cada nodo y cada interacción puede apuntar a un contrato (`contractId`), y el contrato lleva su texto. La pestaña **Contratos** del banco de trabajo es el editor: lista con formato, versión y usos; editor de texto con diagnósticos en vivo que llevan a la línea del problema; **Formatear**, **Plantilla**, conversión JSON ↔ YAML, copiar y descargar con la extensión del formato; resumen del contenido (operaciones, métodos RPC, herramientas…) y «Usado por», que salta a la figura. Desde el panel de propiedades de una figura, «Editar» abre su contrato y «Nuevo contrato» crea uno con el formato que encaja (API → OpenAPI o `.proto` si su tecnología es gRPC, servidor MCP → MCP, tópico o cola → CloudEvents, evento → CloudEvents) y lo deja asignado. La figura muestra el formato y la versión de su contrato como insignia.

| Formato | Qué comprueba | Qué formatea |
|---|---|---|
| CloudEvents (JSON) | `specversion` 1.0, `id`, `source`, `type`, `datacontenttype`, `dataschema`, `time` RFC 3339, `data` / `data_base64` excluyentes, nombres de atributos, también en lotes | **Formateador CloudEvents**: envuelve un payload suelto, completa un envoltorio incompleto y deja la estructura canónica |
| gRPC (`.proto`) | `syntax`, `package`, mensajes (números de campo únicos y en rango), enums proto3, `service` con sus `rpc` y tipos resolubles | reindenta conservando comentarios |
| REST (OpenAPI 3) | `openapi`, `info`, `paths`, respuestas, `operationId` único, parámetros de ruta, `$ref` locales, seguridad | orden canónico, JSON o YAML |
| MCP (JSON) | herramientas con nombre único e `inputSchema` de objeto, `required` dentro de `properties`, recursos con `uri`, prompts con argumentos | orden canónico |
| AsyncAPI, JSON Schema, Avro, GraphQL, WSDL | sintaxis y lo mínimo de cada formato | sangría |

## Patrones, orden y reglas

- **Patrón EIP**: una interacción lleva su patrón como **insignia con el icono del patrón sobre la línea**, o el patrón se dibuja como **nodo intermedio** (rombo) al estilo de los libros de EIP. No son redundantes sino dos formas del mismo dato: la insignia es compacta y el nodo deja ver el componente (un traductor entre dos canales, que sin él se unirían directamente). Las acciones del lienzo **Patrón → nodo** y **Nodo → insignia de patrón** pasan de una a otra sin perder el orden ni los pasos de los flujos; el análisis avisa si se declara el mismo patrón de las dos formas a la vez.
- **Orden**: `order` en una interacción la numera en cada vista (1, 2, 3…) por orden creciente y el número sale sobre la línea; solo ordena, así que se pueden dejar huecos (10, 20, 30). En un flujo manda el orden de sus pasos.
- **Reglas de conexión por tipo** (el lienzo no deja crear la unión y `validate` avisa en documentos existentes): solo un broker o una pasarela contiene colas y tópicos; los sistemas, APIs, conectores, tareas programadas y patrones publican en colas y tópicos, y los sistemas, APIs, pasarelas, conectores y patrones leen de ellos (un canal no se une con otro canal ni admite petición-respuesta); un almacén solo recibe lectura y escritura (petición-respuesta o lote) y nunca inicia una interacción; una tarea programada solo dispara; un usuario final solo llama y solo recibe notificaciones.

## Vistas y zonas

No se guardan coordenadas: las vistas se derivan del modelo (`map` con todo el mapa, `flow:<id>` por cada flujo y `system:<id>` por cada sistema, con él, lo que contiene y sus vecinos directos) y el autolayout las coloca. Los nodos con el mismo `domain` se dibujan dentro de una **zona** de equipo o dominio (los hijos siguen a su padre). Acciones del lienzo, sobre la selección múltiple (Ctrl/⌘ + clic, o Mayús + arrastre para un recuadro): **Agrupar en dominio…**, **Sacar del dominio** y **Agrupar por responsable** (una zona por equipo con los nodos que tienen `owner`).

`validate` comprueba la estructura (referencias, jerarquía, autoenlaces, nodos de patrón con su patrón, contratos que existen) y avisa de lo dudoso: colas sin productor o sin consumidor, interacciones sin contrato o duplicadas, contratos sin versión o con el contenido incorrecto, dependencias síncronas circulares, uniones que incumplen las reglas por tipo y patrones sin entrada o salida.

```bash
iark validate  pedidos.json --module integration
iark convert   pedidos.json --module integration --out mapa.svg          # también .mmd (Mermaid) y .drawio; --to fuerza el formato
iark convert   pedidos.json --module integration --to mermaid --view flow:crear-pedido   # el flujo sale como sequenceDiagram
iark convert   pedidos.json --module integration --view system:pedidos --out pedidos.svg # un sistema y sus vecinos
iark import    mapa.mmd     --module integration --out pedidos.json       # Mermaid (flowchart o sequence) → documento
iark generate  "Pedidos con Kafka y una pasarela de pagos" --module integration --json pedidos.json
iark prompt    "…" --module integration                                 # prompt autocontenido, sin clave de API
iark integration from-c4 banca.json                                     # sistemas y contenedores C4 → mapa de integración
iark integration catalog pedidos.json                                   # tabla Markdown de contratos y dónde se usan
iark integration matrix  pedidos.json                                   # matriz origen × destino con el estilo de cada enlace
iark integration contracts pedidos.json                                 # valida el contenido de cada contrato y lo resume
iark integration contract-export facturacion-proto pedidos.json > facturacion.proto   # saca un contrato a su archivo
iark integration cloudevents payload.json --type com.tienda.pedido.creado --source /pedidos   # formatea como CloudEvents 1.0
```

**Mermaid**: cada tipo tiene su forma (API `{{ }}`, pasarela `>" "]`, broker como `subgraph`, cola y tópico `([ ])`, almacén `[( )]`, conector `( )`, tarea programada `((( )))`, usuario `(( ))`, servidor MCP `[/ /]` y patrón `{ }`). Un sistema o un broker con hijos es un `subgraph`, una zona es un `subgraph` titulado «Dominio: X» que contiene a sus miembros, y las líneas con `order` llevan su número y las que tienen patrón, su nombre entre « ». Cuando la forma no basta para deducir el tipo (un tópico comparte forma con la cola) el texto lleva la marca «Tópico»; con ellas, la ida y vuelta por `iark import` conserva tipo, dominio, orden y patrón. Los contratos y su contenido no viajan por Mermaid: están en el documento JSON.

## Importar OpenAPI y AsyncAPI

`--format openapi|asyncapi|auto` (también en la pestaña «Importar» y con «Abrir archivo…» del banco de trabajo). Los dos son el formato real de este mundo: el contrato de una API REST y el de una API de mensajería. Se leen en YAML o JSON y `auto` los distingue por su campo raíz (`openapi` o `swagger`; `asyncapi`), aunque compartan la extensión `.yaml` o `.json`.

**OpenAPI** (cualquier 3.x, y Swagger 2.0 con un aviso). El modelo de integración no tiene un tipo «operación», así que la API se lee como lo que es para este módulo: quién la publica, en cuántos grupos de operaciones se divide y cuál es su contrato.

| OpenAPI | Documento de integración |
|---|---|
| `info` (título, versión, descripción, contacto) | un sistema con el título; `owner` = el contacto |
| operaciones de `paths`, agrupadas por su primera etiqueta (`tags`) o, sin ella, por el primer segmento de la ruta que no sea `api`/`v1` | un nodo `api` por grupo, hijo del sistema, que cuenta cuántas operaciones tiene |
| `servers` (o `host`, `basePath` y `schemes` en Swagger 2.0) | la URL en la descripción del sistema y el protocolo (`REST (HTTPS)`) de las interacciones; el usuario y la clave de una URL se quitan |
| esquemas que alcanzan las operaciones (`#/components/schemas`, `#/definitions`), también a través de otros esquemas | `dataObjects` de la interacción del grupo (hasta 15; el resto sigue en el contrato) |
| `components.securitySchemes` | el tipo de cada esquema, en la descripción del sistema |
| el documento entero | un contrato `openapi` con el texto original, enlazado a cada API |
| quien llama (OpenAPI no lo dice) | un sistema externo «Cliente de la API» con una interacción de petición-respuesta hacia cada API (se avisa) |

Lo que **no** se importa y se avisa: `webhooks` y `callbacks` (la API que llama al cliente), los `$ref` a otros archivos o URL (**nunca se siguen**: no hay red ni disco), los `$ref` internos rotos o circulares, y las rutas que no son un objeto. Sin aviso, porque siguen completos en el contrato: el detalle de cada operación (parámetros, cuerpos, respuestas, ejemplos), las extensiones `x-` y los enlaces.

**AsyncAPI** (2.x y 3.x). Aquí sí hay un modelo equivalente: los servidores son brokers, los canales son tópicos o colas y las operaciones son interacciones asíncronas.

| AsyncAPI | Documento de integración |
|---|---|
| `info` | un sistema con el título: la aplicación que describe el contrato |
| `servers` | un nodo `broker` por servidor, con el protocolo como tecnología (Kafka, MQTT, AMQP, NATS, WebSocket…) |
| `channels` | un `topic` (o una `queue` si su binding de AMQP lo dice o el protocolo es SQS), dentro del broker del primer servidor que lo declara |
| operaciones | una interacción asíncrona entre el sistema y el canal; sus mensajes, los `dataObjects` |
| el documento entero | un contrato `asyncapi` con el texto original, enlazado a cada canal e interacción |

Quién publica y quién consume sale del punto de vista de la **aplicación**: `send` (3.x) y `subscribe` (2.x) publican; `receive` (3.x) y `publish` (2.x) consumen. En AsyncAPI 2.x los verbos se escriben desde el punto de vista del cliente, no de la aplicación, y el importador lo tiene en cuenta. Se avisa de: los `$ref` externos o rotos, las operaciones que apuntan a un canal que no existe, `reply` (solo se importa el mensaje de ida), los canales sin servidor cuando hay varios (van al primero), y, agrupados, `bindings`, `traits` y seguridad, que siguen completos en el contrato. Como el contrato describe solo a esta aplicación, `validate` avisará después de tópicos sin productor o sin consumidor: es verdad, y es lo que el archivo dice.

```console
$ iark import petstore.yaml --module integration --format openapi --out petstore.json
aviso: OpenAPI no dice quién llama a la API: se añadió el sistema externo «Cliente de la API» con una interacción hacia cada grupo de operaciones.
aviso: 1 URL de servidor con usuario y clave: se quitaron de las descripciones, pero el contrato conserva el texto original.
Importado "Tienda de mascotas" en el módulo integration: 5 elementos, 2 aviso(s).
Documento del módulo integration escrito en petstore.json
$ iark validate petstore.json --module integration
Documento válido (módulo integration). 0 error(es), 0 aviso(s), 0 nota(s).

$ iark import pagos.yaml --module integration --format asyncapi --out pagos.json
aviso: 2 canal(es) no dicen en qué servidor están y hay 2 servidores: se colocan en el primero («kafka-produccion»).
aviso: 1 operación(es) apuntan a un canal que no existe o no declaran «action» válida (send o receive): se omiten.
aviso: AsyncAPI describe solo a esta aplicación: quien consume lo que publica y quien publica lo que consume (3 canal(es)) no está en el contrato, así que la validación del módulo avisará de canales sin productor o sin consumidor.
aviso: 1 operación(es) declaran «reply» (petición-respuesta): solo se importa el mensaje de ida.
aviso: No se importa el detalle por protocolo de servidores, canales y operaciones, que sigue completo en el contrato: bindings (1).
Importado "Servicio de pagos" en el módulo integration: 6 elementos, 5 aviso(s).
Documento del módulo integration escrito en pagos.json
```

Los archivos de estos ejemplos son [`petstore.yaml`](../../tests/fixtures/importar/openapi/petstore.yaml) y [`pagos-v3.yaml`](../../tests/fixtures/importar/asyncapi/pagos-v3.yaml), escritos para las pruebas; el resultado se exporta a Mermaid, SVG y `.drawio` con `iark convert`, igual que cualquier documento del módulo.
