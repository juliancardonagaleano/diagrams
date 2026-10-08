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
