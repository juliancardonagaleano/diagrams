# Trazabilidad entre módulos

[← Índice de la documentación](indice.md)

Los elementos de un documento pueden apuntar a los de otro módulo con una referencia estable `ref: "urn:iark:<módulo>:<id>"` (por ejemplo, un servicio de plataforma que realiza un sistema de integración, o un activo de seguridad que es un servicio de plataforma) y decir de qué clase es el enlace con `refType`. Ningún módulo conoce el código de otro: `iark trace` reúne los documentos y sigue esos enlaces. Sobre ese grafo calcula también los **huérfanos** (elementos sin ningún enlace), la **matriz** de enlaces y la **cobertura** de las reglas que fijes.

```bash
# Enlaces por par de módulos y referencias sin resolver
iark trace integration=examples/pedidos-integracion.json platform=examples/plataforma-ejemplo.json security=examples/seguridad-ejemplo.json
# Impacto de tocar un sistema de integración: qué se apoya en él, entre módulos (y de qué se apoya)
iark trace integration=… platform=… security=… --from integration:pedidos --direction referrers
iark trace … --format mermaid   # un subgrafo por módulo; --format svg para el dibujo; --format json para otras herramientas
```

## Enlaces tipados (`refType`)

Junto a `ref`, un elemento puede llevar `refType`: la clase del enlace. Es opcional; sin él, el enlace es `depends-on` (la v1 no distinguía clases, así que todos los documentos anteriores siguen valiendo sin cambios). El vocabulario es abierto: cualquier texto en minúsculas, dígitos y guiones que empiece por letra (`/^[a-z][a-z0-9-]*$/`, hasta 40 caracteres) es válido, pero estos tipos son los sugeridos y los que reconocen las vistas:

| Tipo | Significa |
|---|---|
| `depends-on` | El origen se apoya en el destino (valor por omisión cuando no se declara tipo) |
| `implements` | El origen implementa al destino: la pieza concreta frente a lo que lleva a cabo (un servicio de plataforma y el sistema de integración) |
| `deploys` | El origen despliega al destino: lo aloja o lo ejecuta |
| `protects` | El origen protege al destino: el activo o control de seguridad que cubre a un elemento |
| `realizes` | El origen realiza al destino: lo hace efectivo en otra capa (una aplicación empresarial y el sistema que la materializa) |
| `derives` | El origen se deriva del destino: nace de él o lo toma como fuente |
| `documents` | El origen documenta o describe al destino (un inventario, una ficha o un catálogo) |

Un `refType` fuera de esa lista no es un error: el enlace se mantiene y el informe lo anota en «Avisos» («el tipo de enlace «x» no está en el vocabulario sugerido; se acepta tal cual»). Uno con forma inválida (mayúsculas, espacios…) lo rechaza el esquema del módulo al validar; si llega al grafo de todos modos, el enlace cuenta como `depends-on` y el informe lo anota. Los seis módulos admiten `refType` donde admiten `ref` (también `iark schema` lo incluye), y el banco de trabajo lo ofrece en el panel de propiedades como un selector bajo «Referencia (URN)».

```json
{ "id": "pedidos", "name": "Servicio de pedidos", "ref": "urn:iark:integration:pedidos", "refType": "implements" }
```

`--type <tipo>` (repetible) mira solo los enlaces de esos tipos, tanto en el informe como en el alcance (`--from`), los huérfanos, la matriz y la cobertura. Las referencias sin resolver se muestran siempre, sea cual sea el filtro.

```
$ iark trace integration=… data=… enterprise=… platform=… security=… --from integration:pedidos --direction referrers --type implements --type protects
Trazabilidad de integration:pedidos (Servicio de pedidos)

**Se apoyan en él (el impacto de tocarlo)** (2)
- platform:pedidos (Servicio de pedidos) · service · enlace implements
  - security:pedidos (Servicio de pedidos) · asset · a 2 saltos · enlace protects

Módulos alcanzados: platform, security
```

El informe Markdown añade «Por tipo: …» y el tipo de cada enlace solo cuando hay alguno distinto de `depends-on`; Mermaid y SVG rotulan la arista con el tipo (la `depends-on` va sin rótulo) y el JSON incluye `type` en todos los enlaces. Con los ejemplos del repositorio, el informe completo empieza así:

```
Trazabilidad entre módulos: 5 documentos, 143 elementos, 15 enlaces.

| Módulo | Archivo | Elementos | Enlaces salientes | Enlaces entrantes |
|---|---|--:|--:|--:|
| integration | examples/pedidos-integracion.json | 17 | 0 | 10 |
| data | examples/ventas-datos.json | 24 | 1 | 0 |
| enterprise | examples/empresa-arquitectura.json | 43 | 3 | 0 |
| platform | examples/plataforma-ejemplo.json | 22 | 6 | 5 |
| security | examples/seguridad-ejemplo.json | 37 | 5 | 0 |

### Enlaces

Por tipo: protects 5, implements 4, realizes 3, deploys 2, derives 1.

**data → integration** (1)
- data:erp (ERP de pedidos) → integration:pedidos (Servicio de pedidos) · derives

**platform → integration** (6)
- platform:kafka-prod (Kafka (prod)) → integration:kafka (Kafka) · deploys
- platform:tienda-web (Tienda web) → integration:tienda-web (Tienda web) · implements
…
```

## Huérfanos

`--orphans [módulo[:tipo]]` añade al informe los elementos que no participan en ningún enlace (ni como origen ni como destino), agrupados por módulo y tipo de elemento. Sin valor examina todos los módulos; con `security` solo ese módulo, y con `security:asset` solo sus activos. Un huérfano no es un error: no todo tiene por qué estar enlazado. Cuentan los enlaces resueltos y, si hay `--type`, solo los de esos tipos.

```
$ iark trace integration=… data=… enterprise=… platform=… security=… --orphans security:asset
…
### Huérfanos

Huérfanos en security:asset: 6 de 11 elementos no tienen ningún enlace.

**security · asset** (6 de 11)
- cliente (Cliente)
- pasarela-pagos (Pasarela de pagos)
- proveedor-correo (Proveedor de correo)
- waf-lb (Balanceador y WAF)
- tienda-web (Tienda web)
- secretos (Almacén de secretos)
```

`--orphans` lleva un valor opcional, así que ponga los documentos (`módulo=archivo`) antes de esa opción.

## Matriz

`--matrix [module|kind]` añade la matriz origen × destino de los enlaces, por módulo (por omisión) o por tipo de elemento (`security:asset`, `platform:service`…), con los totales y el desglose por tipo de enlace.

```
$ iark trace integration=… data=… enterprise=… platform=… security=… --matrix
…
### Matriz

Matriz de trazabilidad por módulo: 15 enlaces.

| Origen \ Destino | integration | platform | Total |
|---|--:|--:|--:|
| data | 1 | 0 | 1 |
| enterprise | 3 | 0 | 3 |
| platform | 6 | 0 | 6 |
| security | 0 | 5 | 5 |
| **Total** | 10 | 5 | 15 |

Desglose por tipo de enlace:

| Origen → Destino | protects | implements | realizes | deploys | derives | Total |
|---|--:|--:|--:|--:|--:|--:|
| data → integration | 0 | 0 | 0 | 0 | 1 | 1 |
| enterprise → integration | 0 | 0 | 3 | 0 | 0 | 3 |
| platform → integration | 0 | 4 | 0 | 2 | 0 | 6 |
| security → platform | 5 | 0 | 0 | 0 | 0 | 5 |
| **Total** | 5 | 4 | 3 | 2 | 1 | 15 |
```

Con `--format json` la matriz sale con sus filas, columnas, celdas (con el recuento por tipo) y totales.

## Cobertura

`--coverage "<origen> -> <destino>"` (repetible) mide una regla de trazabilidad. Cada lado es un módulo (`platform`) o un módulo y un tipo de elemento (`security:asset`). Un elemento del origen está **cubierto** si tiene al menos un enlace saliente hacia algún elemento del destino; la dirección importa. El resultado es el porcentaje, los cubiertos y los que quedan **SIN cubrir**. Si el origen no tiene ningún elemento, la regla no es aplicable (no cuenta como 0 % ni como 100 %).

```
$ iark trace integration=… data=… enterprise=… platform=… security=… --coverage "security:asset -> platform" --coverage "platform:service -> integration" --min-coverage 60 --strict
…
### Cobertura

Cobertura de trazabilidad: 2 reglas.

| Regla | Cubiertos | Total | Cobertura |
|---|--:|--:|--:|
| `security:asset -> platform` | 5 | 11 | 45,5 % |
| `platform:service -> integration` | 4 | 6 | 66,7 % |

**SIN cubrir** · `security:asset -> platform` (6)
- security:cliente (Cliente) · asset
- security:pasarela-pagos (Pasarela de pagos) · asset
…

**SIN cubrir** · `platform:service -> integration` (2)
- platform:notificaciones (Notificaciones) · service
- platform:reportes (Reportes nocturnos) · service

Por debajo del mínimo (60 %): `security:asset -> platform`.
```

El comando termina con código 3 y, en stderr, `Cobertura de «security:asset -> platform»: 45,5 %, por debajo del mínimo (60 %).`

## Códigos de salida y modo estricto

| Opción | Efecto |
|---|---|
| `--strict` | Código 3 con referencias mal formadas (`invalid`), a elementos que no existen (`dangling`) o ambiguas (`ambiguous`), **y** con una cobertura por debajo del mínimo. Con `--coverage`, el mínimo es 100 % salvo que se dé `--min-coverage` |
| `--strict-unresolved` | Lo de `--strict` y además las referencias a módulos de los que no se aportó documento (`unresolved`) |
| `--min-coverage <n>` | Porcentaje mínimo (0 a 100; acepta coma decimal) de cada regla. Sin `--strict` ya hace fallar la cobertura insuficiente (código 3); necesita al menos un `--coverage` |

Sin `--strict` ni `--min-coverage`, las referencias con problemas y la cobertura solo se informan y el código de salida es 0. Un error de uso (una regla sin flecha, un módulo que no existe, un porcentaje fuera de 0 a 100, `--min-coverage` sin reglas) sale con código 2. Los informes de `--orphans`, `--matrix` y `--coverage` se imprimen con `--format markdown` y `--format json`; con `mermaid` o `svg` se avisa de que no se imprimen (la cobertura sí se evalúa para `--strict` y `--min-coverage`).

```
$ iark trace platform=examples/plataforma-ejemplo.json security=examples/seguridad-ejemplo.json --strict-unresolved
6 referencia(s) sin resolver.     # exit 3: sin el documento de integración, los seis enlaces de plataforma no se resuelven
```

## Dónde se usa

- **CLI**: `iark trace` con documentos sueltos y `iark project trace <proyecto>` con los diagramas de un [proyecto](proyectos.md), con las mismas opciones (`--from`, `--direction`, `--depth`, `--format`, `--type`, `--orphans`, `--matrix`, `--coverage`, `--min-coverage`, `--strict`, `--strict-unresolved`). `--direction refs|referrers|both` y `--depth n` acotan el alcance; sin `--from` se muestra el grafo completo.
- **Servicio HTTP**: `POST /api/trace` con `{ documents, from?, direction?, depth?, types?, orphans?, matrix?, coverage? }`; devuelve el grafo, el informe, el Mermaid y el SVG, y con `orphans` (`true`, `"módulo"`, `"módulo:tipo"` u `{ module, kind? }`), `matrix` (`"module"` o `"kind"`) y `coverage` (lista de reglas) añade esos análisis como JSON. Ver [Servicio HTTP](servicio.md#servicio-http-iark-serve).
- **En la web**: `trazabilidad.html` reúne los documentos de los módulos (ejemplos, archivos o JSON pegado, sin subir nada a ningún servidor) y usa el mismo código que el CLI. Muestra el grafo con un recuadro por módulo y el tipo en cada arista, los enlaces por par de módulos con su tipo, las referencias sin resolver y el alcance de un elemento. Un **filtro por tipo** (casillas con el recuento de cada tipo) acota todas las vistas. La pestaña **Matriz** es una tabla con cabeceras de fila y de columna; el color de cada celda indica la proporción respecto del máximo, pero el número exacto va siempre escrito en ella. **Huérfanos** se filtra por módulo y tipo de elemento, y **Cobertura** tiene un campo de reglas (una por línea, `#` para comentar), un mínimo y el detalle de lo que queda sin cubrir. Se llega desde el banco de trabajo y desde el shell de la suite.
- **Banco de trabajo**: el panel de propiedades de un elemento elige el módulo y el elemento al que apunta, y el tipo del enlace; «Referenciado por» lista quién apunta al elemento y con qué tipo.
- **IA**: `generate --from …` conserva los `ref` y los `refType` del documento base al refinar, aunque el modelo no los conozca.

Un módulo sin documento aportado no invalida los enlaces hacia él: se listan como «sin resolver» (y no rompen `--strict`, sí `--strict-unresolved`). Los ejemplos (`examples/*.json`) ya traen una cadena real y tipada: empresarial → integración (`realizes`), plataforma → integración (`implements`, `deploys`), seguridad → plataforma (`protects`) y datos → integración (`derives`).
