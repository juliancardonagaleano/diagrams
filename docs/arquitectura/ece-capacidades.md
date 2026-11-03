# Capacidades del MCP ECE

[← Spec 000](specs/000-conexion-ece.md) · [Origen de la configuración](ece-repositorio-iark.md)

Catálogo del 3 de noviembre de 2026 (UTC), copiado de una llamada real. El texto dentro de cada bloque es el que devolvió el servidor, sin parafrasear.

La llamada no es el descubrimiento de esta sesión de Cursor. `GetDynamicTools` no devolvió un namespace ECE. El proceso fue `python3 scripts/mcp_ece.py`: el cliente habla stdio (en la prueba, NDJSON) y el puente `scripts/mcp-ece.py` reenvía por HTTP. La URL y la clave salen de `ECE_MCP_URL` y `ECE_MCP_API_KEY`. Esos valores no están en este archivo.

La prueba fijó `MCP_PCE_CACHE_PATH` a un archivo nuevo, fuera del repo, para no reutilizar una respuesta guardada. El log de arranque dijo `0 entradas` y `ca=system`. La configuración del repo no define esa variable: en un arranque normal la caché queda en la ruta por defecto del script.

## Llamadas

| Método | Resultado |
|---|---|
| `initialize` | `result` con `protocolVersion` `2025-03-26` |
| `notifications/initialized` | notificación; el puente no reenvía cuerpo vacío |
| `tools/list` | 10 herramientas, sin `nextCursor` |
| `resources/list` | 1 recurso, sin `nextCursor` |

`serverInfo` devuelto por `initialize`:

```json
{
  "name": "ece-knowledge-router",
  "version": "0.1.0"
}
```

`capabilities` devueltas por `initialize`:

```json
{
  "prompts": {
    "listChanged": false
  },
  "resources": {
    "listChanged": false,
    "subscribe": false
  },
  "tools": {
    "listChanged": false
  }
}
```

`initialize` también devolvió `instructions` (mapa de navegación). No se copia aquí: no salió de `tools/list` ni de `resources/list`. El recurso `ece://navegacion` apunta a ese mapa. No se llamó `resources/read` ni `prompts/list`, así que este archivo no lista prompts ni el cuerpo del mapa.

No hubo `needsAuth` en el descubrimiento de la sesión. El stderr del proceso no incluyó la línea `auth: Bearer JWT`.

## Herramientas

Orden de `tools/list`.

### `search_catalog`

Descripción:

```text
Úsala para localizar entidades: «qué hay sobre esto» o «qué hay de este tipo». Sin `query` es un listado por tipo; con `query` es una búsqueda semántica, que solo alcanza entidades con narrativa propia. Devuelve: `results` con las entidades encontradas (`entity_id`, `type`, `title`, `backend_path`, `attributes`), `total` y `governance`. Con `query` suma `live_results`, el complemento de las fuentes vivas autorizadas, y `scope_note` cuando el filtro de tipo vació la búsqueda semántica. No la uses para: el texto de una entidad: devuelve fichas, no texto. Para el texto, `read_document` o `retrieve_knowledge`. En su lugar: read_document, retrieve_knowledge. Parámetros: `type` filtra por el tipo que declara la fuente, no por la etiqueta del grafo; la lista de tipos no es cerrada y un tipo desconocido no es un error, pero la respuesta difiere: con `query` la búsqueda vacía viene explicada por `scope_note`, y sin `query` llega vacía y sin nota. `query` activa la resolución semántica. `top_k` acota los resultados. Valores por defecto: `type`=None, `query`=None, `top_k`=10. El tipo es el que declara la fuente de la que viene la entidad —`adr`, `policy`, `principle`, `pattern`, `doc` y los tipos del inventario—, no la etiqueta con la que el grafo la almacena. El complemento vivo se declara por consulta nombrada: el bloque `governance.pipeline` dice qué consultas corrieron por fuente, y el recorte por tope viaja como omisión con su conteo. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "type": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Type"
    },
    "query": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Query"
    },
    "top_k": {
      "default": 10,
      "title": "Top K",
      "type": "integer"
    }
  },
  "type": "object",
  "title": "search_catalogArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "search_catalogDictOutput"
}
```

### `read_document`

Descripción:

```text
Úsala cuando ya sabes qué documento leer: tienes su ruta del corpus o el identificador de la entidad que lo posee. Devuelve: `path`, `mode_applied`, `content`, `title`, `metadata`, `estimated_tokens`, `truncated`, `total_sections`, `delivered_sections`, `source_used`, `live_detail` y `governance`. Con `representation: source` llega además `content_base64` (los bytes de la fuente, con tipo de medio, suma y tamaño en `metadata`). Si el documento no está o no es visible, `content` llega vacío y `metadata.error` lo declara; si la sección no existe, dice `section_not_found` con las `available_sections`. No la uses para: elegir el documento: para saber cuál leer, `search_catalog` o `retrieve_knowledge`. En su lugar: search_catalog, retrieve_knowledge. Parámetros: `path` es la ruta del corpus, el id de la entidad dueña o la referencia citable del manifiesto vivo (`{fuente}:{id}`: lo no entregado se sirve desde la retención; si ya no la tiene, `metadata.error` lo declara sin re-consultar). `mode` es `section`, `condensed` o `full`. `section` filtra por la jerarquía de secciones. `max_tokens` acota lo servido. `representation` elige qué se sirve: `prose`, `source` —los bytes—, `structure`, la lectura de su contenido, o `meaning`, la interpretación derivada. En las tres últimas, `mode` y `section` se rechazan y `max_tokens` no acota. `source_id` acota la búsqueda a una fuente. Valores por defecto: `mode`=None, `section`=None, `max_tokens`=None, `representation`=None, `source_id`=None. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "path": {
      "title": "Path",
      "type": "string"
    },
    "mode": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Mode"
    },
    "section": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Section"
    },
    "max_tokens": {
      "anyOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Max Tokens"
    },
    "representation": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Representation"
    },
    "source_id": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Source Id"
    }
  },
  "required": [
    "path"
  ],
  "type": "object",
  "title": "read_documentArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "read_documentDictOutput"
}
```

### `traverse_knowledge`

Descripción:

```text
Úsala para orientarte en el grafo entrando por significado: es `search_catalog` y `get_related` en un solo turno. Úsala cuando no tienes un identificador y quieres saber qué hay alrededor de lo que significa tu consulta. Devuelve: `query`, `anchors` (las entidades que anclan la consulta), `must_load` (lo normativo), `references` (lo referenciado), `unresolved_count`, `live_results` y `governance`. No la uses para: el contenido de lo que ancló: da rutas y títulos; para el texto, `read_document`. Y si ya tienes el identificador exacto, `resolve_entity` y `get_related` son más baratos. En su lugar: resolve_entity, get_related. Parámetros: `query` es la consulta libre (obligatoria). `top_anchors` acota las anclas. `max_hops` es la profundidad de la expansión: subirlo multiplica el volumen. Valores por defecto: `top_anchors`=3, `max_hops`=1. La expansión se clasifica por comportamiento de carga: `MUST_LOAD` es lo normativo y hay que cargarlo antes de decidir; `ATTACH` acompaña a la entidad; `REFERENCE` se cita; `ON_DEMAND` marca el enlace con la narrativa y no viaja en la expansión. El complemento vivo puede encadenarse entre fuentes: el bloque `governance.pipeline` declara qué consultas nombradas corrieron por fuente y qué saltos se omitieron, con su motivo atribuido. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "query": {
      "title": "Query",
      "type": "string"
    },
    "top_anchors": {
      "default": 3,
      "title": "Top Anchors",
      "type": "integer"
    },
    "max_hops": {
      "default": 1,
      "title": "Max Hops",
      "type": "integer"
    }
  },
  "required": [
    "query"
  ],
  "type": "object",
  "title": "traverse_knowledgeArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "traverse_knowledgeDictOutput"
}
```

### `retrieve_knowledge`

Descripción:

```text
Úsala cuando la pregunta es abierta y necesitas evidencia citable con relevancia: es la única que publica una puntuación de confianza, con el complemento de fuentes vivas si la política lo permite. Devuelve: `items` con los fragmentos, su ruta de origen y su puntuación de relevancia, `built_systems` con los sistemas construidos que la evidencia materializa (puede ser una lista vacía), y `governance`, que aquí trae `confidence`. No la uses para: el documento entero: `read_document`. Para una entidad de un tipo, `search_catalog` sin `query` es más barato. En su lugar: read_document. Parámetros: `query` es la consulta libre (obligatoria). `top_k` acota los fragmentos. El complemento vivo es obligatorio salvo las excluidas por la política: `live_results` trae lo respondido y `governance.live_sources_unavailable`, lo que no. El recorte por cupo va en `governance.pipeline.selection`. Valores por defecto: `top_k`=5. La confianza llega en `governance.confidence`, con el termómetro de seis niveles: Termómetro de confianza — seis niveles sobre el `score` redondeado a 2 decimales: `insufficient` (score < 0.2, no usar); `low` ([0.2, 0.45), usar con cautela / verificar); `medium_low` ([0.45, 0.6), correcta pero floja (verificar fuente)); `medium` ([0.6, 0.75), correcta razonable); `high` ([0.75, 0.9), correcta sólida (usar con citación)); `very_high` (>= 0.9, excelente (usar sin dudar)). En el piso `insufficient`, `cause` dice por qué; su vocabulario vive en el mapa (`ece://navegacion`). Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "query": {
      "title": "Query",
      "type": "string"
    },
    "top_k": {
      "default": 5,
      "title": "Top K",
      "type": "integer"
    }
  },
  "required": [
    "query"
  ],
  "type": "object",
  "title": "retrieve_knowledgeArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "retrieve_knowledgeDictOutput"
}
```

### `resolve_entity`

Descripción:

```text
Úsala cuando ya tienes un identificador y quieres saber a qué apunta y qué metadatos tiene. Es el paso más barato: no lee narrativa. Devuelve: `entity_id`, `type`, `title`, `status`, `pointer_path`, `backend_path`, `attributes`, `live_detail` y `governance`. Si la entidad no existe, llegan `entity_id`, `error`, `candidates` —hasta cinco identificadores cercanos visibles para el principal— y `candidates_total` —los visibles totales antes del tope—, con la misma forma que si no fuera visible; si el grafo no responde, el consejo se retira declarándolo en `candidates_unavailable`: un vacío sin esa declaración no afirma que no haya cercanos. No la uses para: lo que hay alrededor de la entidad: para eso, `get_related`. Tampoco devuelve el texto del documento: para eso, `read_document` con su `backend_path`. En su lugar: get_related, read_document. Parámetros: `entity_id` es el identificador de la entidad en el grafo (obligatorio); su forma es la que el grafo devuelve, con el tipo y el nombre separados por dos puntos cuando la fuente la publica así. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "entity_id": {
      "title": "Entity Id",
      "type": "string"
    }
  },
  "required": [
    "entity_id"
  ],
  "type": "object",
  "title": "resolve_entityArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "resolve_entityDictOutput"
}
```

### `get_related`

Descripción:

```text
Úsala cuando tienes un identificador exacto y quieres saber qué cuelga de esa entidad y qué parte de eso es normativo. Devuelve: `entity_id`, `entity_title`, `groups` —cada grupo con su `load_behavior` y sus `nodes`—, `live_detail` y `governance`. No la uses para: nada sin un identificador exacto: para entrar por significado, `search_catalog` o `traverse_knowledge`. Tampoco devuelve el texto de los vecinos: para eso, `read_document`. En su lugar: search_catalog, traverse_knowledge. Parámetros: `entity_id` (obligatorio). Los grupos salen ordenados por comportamiento de carga: `MUST_LOAD` —lo normativo— antes que `ATTACH` y `REFERENCE`. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "entity_id": {
      "title": "Entity Id",
      "type": "string"
    }
  },
  "required": [
    "entity_id"
  ],
  "type": "object",
  "title": "get_relatedArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "get_relatedDictOutput"
}
```

### `get_source_status`

Descripción:

```text
Úsala para saber si el almacén está sano y qué tan fresco está. Es la única superficie de salud y de frescura del conocimiento. Devuelve: `status` (`ready` o `degraded`), `docs_indexed`, `graph_reachable` —si el grafo responde: booleano de la infraestructura, no del universo del principal—, `health_surface` —si esta respuesta pudo calcular la salud y, si no, su `reason`—, `sources` —el registro visible con el veredicto de cada fuente: `verdict` (`operativa`, `degradada`, `caída` o `no evaluable`), `verdict_reason`, `freshness` —última extracción, o `no aplica` en las vivas—, `transport` —el sondeo, con `probeable`— y `operation` —la última operación real observada—; `healthy` equivale a `operativa`—, `stale_sources` —frescura: fuentes de corpus sin extracción que respalde el dato—, `live_sources` —la población viva con su veredicto—, `namespaces` —los namespaces de las fuentes visibles, con su conteo y sus fuentes— y `governance`. Frescura y disponibilidad se declaran por separado. No la uses para: el contenido: solo dice tamaño y frescura; para el contenido, las demás tools. No hay alternativa: es la única superficie para esto. Parámetros: No tiene parámetros. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {},
  "type": "object",
  "title": "get_source_statusArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "get_source_statusDictOutput"
}
```

### `resolve_context`

Descripción:

```text
Úsala cuando trabajas por namespace —un namespace jerárquico del corpus— y quieres saber qué documentos lo componen y cuáles son de lectura obligada. Devuelve: `status` (`resolved`, o `not_found` cuando el grafo no conoce el namespace), `context_id`, `context_name`, `document_count`, `documents` —el bundle, con el tipo y el comportamiento de carga de cada documento— y `governance`. Un namespace que existe pero cuyo bundle quedó vacío lo conserva `resolved` y lo declara: `filtered_by_platform` si ningún documento coincidió con la plataforma pedida, `filtered_by_visibility` si la visibilidad no dejó pasar ninguno. El bundle se enumera, no se lee: el texto se pide documento a documento. No la uses para: el contenido de su bundle, por diseño: la divulgación progresiva pide el texto después. Para una entidad concreta, `resolve_entity`. En su lugar: resolve_entity. Parámetros: `context_id` es el namespace jerárquico (obligatorio). `platform` acota el bundle a los documentos cuyo camino coincide con la plataforma; cuando no coincide con nada, la respuesta lo declara con `filtered_by_platform` en vez de reportar un namespace desconocido. Valores por defecto: `platform`=None. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "context_id": {
      "title": "Context Id",
      "type": "string"
    },
    "platform": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Platform"
    }
  },
  "required": [
    "context_id"
  ],
  "type": "object",
  "title": "resolve_contextArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "resolve_contextDictOutput"
}
```

### `list_query_pipelines`

Descripción:

```text
Úsala para enterarte de qué consultas especializadas (pipelines) puedes invocar y cómo: el catálogo de planes nombrados del registro, derivado solo con lo que tu perfil alcanza. Devuelve: `pipelines` con las entradas alcanzables —cada una con su id, su nombre, su descripción, sus parámetros con ejemplo de valor, la invocación completa para copiar, qué devuelve y su presupuesto declarado— y `count` con el conteo. Sin prosa: dato estructurado. Solo aparece lo que tu perfil alcanza en ambas esferas: la ontológica y la de contenido. No la uses para: ejecutar un pipeline: esta tool solo lista lo que existe y cómo se invoca. Tampoco para buscar evidencia: para eso, `retrieve_knowledge`. En su lugar: retrieve_knowledge. Parámetros: `domain` acota a los pipelines de ese dominio; `keyword` acota a los que coinciden en nombre, descripción o dominio. Combinados acotan a la intersección; sin filtros va el listado completo alcanzable. Valores por defecto: `domain`=None, `keyword`=None. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "domain": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Domain"
    },
    "keyword": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Keyword"
    }
  },
  "type": "object",
  "title": "list_query_pipelinesArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "list_query_pipelinesDictOutput"
}
```

### `run_query_pipeline`

Descripción:

```text
Úsala cuando ya descubriste un pipeline con `list_query_pipelines` y quieres ejecutarlo: invoca un plan nombrado por su id y sus parámetros. Devuelve: La misma forma de la búsqueda estándar: `results` con la evidencia local, `live_results` con lo que respondieron las fuentes vivas, `live_manifest` con toda la evidencia recolectada —referencia citable `{fuente}:{id}`— y `governance`, que trae la traza completa: las etapas que corrieron, el plan invocado (`pipeline: {id, version}`) y el paso que produjo cada evidencia, fallo u omisión. No la uses para: descubrir qué pipelines existen: para eso, `list_query_pipelines`. Tampoco para una pregunta abierta sin plan nombrado: para eso, `retrieve_knowledge`. En su lugar: retrieve_knowledge, list_query_pipelines. Parámetros: `pipeline` (obligatorio) es el id del plan a invocar. `params` lleva los insumos de la invocación: `text` alimenta el insumo `request.text` del plan y la búsqueda base, y el resto de los valores alimentan los insumos `request.params` que el documento declara; un parámetro declarado ausente o no simple rechaza la llamada nombrándolo. Valores por defecto: `params`=None. El plan nombrado se compone SOBRE el pipeline base: la respuesta trae tu búsqueda principal además de la del plan, bajo el mismo presupuesto. Un paso cortado por presupuesto, tiempo o tope llega como omisión con su motivo y su paso dentro de `governance.pipeline` —nunca como error— y el resto de la evidencia viaja igual. Alcance: el universo visible de quien llama — esta tool expone solo la evidencia y las fuentes que tiene autorizadas, nunca lo que se le retiene.
```

Parámetros (`inputSchema`):

```json
{
  "properties": {
    "pipeline": {
      "title": "Pipeline",
      "type": "string"
    },
    "params": {
      "anyOf": [
        {
          "additionalProperties": true,
          "type": "object"
        },
        {
          "type": "null"
        }
      ],
      "default": null,
      "title": "Params"
    }
  },
  "required": [
    "pipeline"
  ],
  "type": "object",
  "title": "run_query_pipelineArguments"
}
```

`outputSchema`:

```json
{
  "type": "object",
  "additionalProperties": true,
  "title": "run_query_pipelineDictOutput"
}
```

## Recursos

Orden de `resources/list`.

### `mapa-de-navegacion`

```json
{
  "description": "Mapa de la superficie: vocabulario del grafo, orden de consulta, límites de lo que puede responder y cómo se lee una respuesta.",
  "mimeType": "text/markdown",
  "name": "mapa-de-navegacion",
  "uri": "ece://navegacion"
}
```
