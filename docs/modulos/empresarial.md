# Módulo empresarial

[← Índice de la documentación](../indice.md)

Cuarta especialidad de la suite (`--module enterprise`): un subconjunto pequeño de ArchiMate/TOGAF para responder **qué sabe hacer la empresa, con qué aplicaciones y sobre qué tecnología**. Vive en `packages/domain-enterprise`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/empresa-arquitectura.json`](../../examples/empresa-arquitectura.json) y, con un flujo de valor y servicios de negocio, en [`examples/empresa-flujo-de-valor.json`](../../examples/empresa-flujo-de-valor.json); esquema con `iark schema --module enterprise`):

| Parte | Contenido |
|---|---|
| `units` | la organización (direcciones, equipos, terceros): son los responsables; el SVG solo las dibuja si ejecutan un proceso (`assigned-to`) o están sueltas, y el paisaje del lienzo las dibuja todas para poder arrastrar una asignación hacia cualquiera |
| `capabilities` | capacidades de negocio en árbol (`parentId`), con `importance` (`differentiating`, `core`, `supporting`), `maturity` de 1 a 5 y `ownerId` (se hereda del padre) |
| `processes` | procesos de negocio |
| `applications` | `lifecycle` (`planned`, `active`, `sunset`, `retired`), `criticality`, `technology`, `vendor`, `external`, `ownerId` de negocio, `ref` a otro módulo y datos de gestión opcionales: `annualCost`, `users`, `strategy` (`keep`, `migrate`, `replace`, `retire`) y `endOfLife` |
| `technologies` | plataformas y tecnología (`platform`, `infrastructure`, `database`, `runtime`, `middleware`, `service`), con `version`, `lifecycle` y `endOfLife` |
| `valueStreams`, `valueStages` | **flujos de valor** (opcionales): un flujo (`stakeholder`: quien recibe el valor, `ownerId`) con sus etapas (`streamId`, `value`: lo que aporta), en el orden en que aparecen en el documento; cada etapa se enlaza con las capacidades que la habilitan (`enables`) |
| `businessServices` | **servicios de negocio** (opcionales): lo que se ofrece a clientes (`audience`, `ownerId`); exponen procesos y capacidades (`exposes`) |
| `relations` | `supports` (aplicación → capacidad o proceso), `realizes` (proceso → capacidad), `runs-on` (aplicación → tecnología) `depends-on` (aplicación → aplicación, o tecnología → tecnología), `composes` (el todo → su parte, del mismo tipo), `flows-to` (aplicación → aplicación o proceso → proceso), `assigned-to` (unidad → proceso) y `triggers` (proceso → proceso); `enables` (capacidad → etapa que habilita) y `exposes` (servicio de negocio → proceso o capacidad); los seis últimos son opcionales y el documento sigue en la versión 1.0 |

No se guardan coordenadas: las vistas se derivan del modelo. `capabilities` es el **mapa de capacidades** (cuadrícula anidada; el color indica la madurez por defecto o, con `capabilities:importance`, `capabilities:criticality` y `capabilities:lifecycle`, la importancia, la criticidad o el ciclo de vida de las aplicaciones que la soportan, con su leyenda; el borde indica la importancia y una línea discontinua marca las que no tienen aplicación), `value-stream` los **flujos de valor** (cada flujo es un recuadro con sus etapas como chevrones en cadena, de izquierda a derecha, y debajo las capacidades que las habilitan, ordenadas según sus etapas y unidas a ellas con aristas de un solo codo que no se cortan; si una capacidad habilita etapas de varios flujos, la dibuja el primero y las aristas de los demás suben hasta ella por un pasillo libre —bajo el rótulo del recuadro y a un lado, a la derecha o a la izquierda, de los flujos intermedios— sin pisar ningún nodo ni rótulo, y el orden de las capacidades se afina por búsqueda local cuando hay etapas no contiguas; una etapa sin capacidad se dibuja discontinua), `roadmap` la **hoja de ruta del ciclo de vida** (columnas por año de fin de soporte, retiradas y previstas), `landscape` el **paisaje** capacidad → proceso → aplicación → tecnología, con los colores de capa de ArchiMate (negocio amarillo, aplicación azul, tecnología verde) y el icono del tipo en la esquina de cada elemento y `unit:<id>` una por unidad con lo que tiene a su cargo (lo demás, en discontinuo). El paisaje existe siempre que haya elementos, aunque el documento no tenga relaciones. `matrix` es la **matriz capacidad × aplicación** (capacidades en filas, con sangría por nivel; aplicaciones en columnas): una celda marca que la aplicación soporta la capacidad —directamente (`●`), por un proceso que la realiza (`○`) o, en una capacidad con hijas, heredada de ellas (`·`, no cuenta en los totales)—, se colorea por la criticidad de la aplicación y las filas y columnas suman sus totales; un hueco (capacidad hoja sin aplicación) se avisa en rojo discontinuo y un solapamiento (dos o más aplicaciones vigentes sin criterio: sin transición ni descripción en la relación `supports`) en violeta. En el lienzo, doble clic en una celda (o el botón «Soporta ⇄» con celdas seleccionadas) crea o quita la relación `supports`, y **arrastrar una celda ● a otra la mueve**: soltarla en la misma fila cambia la aplicación, en la misma columna la capacidad y en diagonal las dos (conserva el criterio de la relación, es un solo paso de Deshacer y las celdas vacías, ○ y · no se arrastran); sale también en SVG, draw.io, Mermaid (`block-beta`, que el importador `mermaid` del módulo vuelve a leer: cada ● es una relación `supports`, y lo que el formato no lleva —ids, criticidad, ciclo de vida, ○ y ·— se resume en los avisos) y, desde el CLI, como tabla o CSV. El impacto de un elemento se pide por su id: `impact:<id>` (lo que se apoya en él), `depends:<id>` (de qué depende) y `focus:<id>` (ambos). Las flechas van de quien se apoya a aquello en lo que se apoya.

`validate` comprueba la estructura (ids únicos entre tipos, jerarquías sin ciclos, responsables que son unidades, relaciones que encajan con sus extremos) y aplica reglas de **gobierno**: capacidades sin aplicación (aviso si son esenciales o diferenciadoras), aplicaciones sin responsable de negocio (aviso si son críticas), sin uso o sin tecnología, aplicaciones en retirada que nadie sustituye, elementos vivos que se apoyan en algo en retirada o retirado, tecnologías fuera de soporte (o que lo estarán en menos de 12 meses), capacidades con tres o más aplicaciones (posible duplicidad), procesos que no realizan ninguna capacidad, etapas de un flujo de valor que ninguna capacidad habilita (aviso), flujos sin etapas, servicios de negocio que no exponen nada y críticas que dependen de aplicaciones de criticidad baja.

```bash
iark validate  empresa.json --module enterprise
iark convert   empresa.json --module enterprise --out mapa.svg                       # mapa de capacidades; también .mmd y .drawio (una página por vista)
iark convert   empresa.json --module enterprise --out paisaje.svg --view landscape
iark convert   empresa.json --module enterprise --out impacto.svg --view impact:hana
iark import    paisaje.mmd  --module enterprise --out empresa.json                   # flowchart → documento
iark import    modelo.xml   --module enterprise --format archimate --out empresa.json   # modelo ArchiMate (Exchange Format o Archi) → documento
iark generate  "Comercio con tienda online, ERP, CRM y almacenes" --module enterprise --json empresa.json
iark enterprise coverage  empresa.json                                               # capacidades con sus aplicaciones y las que no tienen ninguna
iark enterprise impact    hana empresa.json [--direction dependencies|both]         # qué se ve afectado si cambia o se retira, con los responsables a avisar
iark enterprise lifecycle empresa.json [--today 2026-06-15]                          # obsolescencia: retiradas y fin de soporte, con las capacidades afectadas
iark enterprise matrix    empresa.json [--format table|csv]                         # matriz capacidad × aplicación: marcas, totales, huecos y solapamientos
iark enterprise from-integration mapa.json                                           # sistemas de un mapa de integración → aplicaciones con URN
```

Al importar un `flowchart`, el tipo de cada nodo sale de su clase (`:::application`, `class A capability`; también en español), del título de la capa que lo contiene («Capacidades», «Aplicaciones»…), de su forma (`([ ])` = proceso, `[( )]` = tecnología) y, por último, de que esté dentro de un `subgraph` (capacidad) o no (aplicación). Un `subgraph` que no es una capa es una capacidad que contiene a las suyas. Cada flecha se convierte en la relación que admiten sus extremos, en cualquier sentido. La segunda línea del texto de una aplicación es su tecnología y la de una tecnología, su versión. El banco de trabajo (`modulos.html?module=enterprise`) lo edita en un lienzo propio, con paleta de figuras, panel de propiedades, deshacer/rehacer y autolayout (ver [Suite web](../suite-web.md)).

**Importar ArchiMate** (`--format archimate`; también en la pestaña «Importar» y con «Abrir archivo…»). Acepta el *Exchange File Format* del Open Group (`.xml`, espacio de nombres `http://www.opengroup.org/xsd/archimate/3.0/`) y el formato nativo de Archi (`.archimate`, con carpetas). Los actores, roles y colaboraciones de negocio pasan a unidades; las capacidades, a capacidades; los procesos, funciones e interacciones de negocio, a procesos; los servicios de negocio, a servicios de negocio; los componentes, colaboraciones y servicios de aplicación y los objetos de datos, a aplicaciones; los nodos, dispositivos, software de sistema, servicios de tecnología y artefactos, a tecnología; y los flujos de valor (compuestos, encadenados por flujo o disparo, o aislados), a flujos de valor con sus etapas. Las uniones y los eventos desaparecen y sus relaciones pasan a ser directas. Las relaciones se convierten siempre a una que admite `RELATION_RULES` y nunca se inventa una inválida: composición y agregación a jerarquía o `composes`, asignación a `assigned-to` o responsable, realización, servicio, flujo, disparo, acceso y asociación a la relación que admiten los tipos de sus extremos (cuando no hay una propia, a `depends-on` o `flows-to` con aviso). Las propiedades (en español o en inglés) se leen como coste anual, usuarios, estrategia (también TIME), fin de soporte, ciclo de vida, criticidad, proveedor, tecnología, `ref`, responsable, madurez (1-5, «Level 3», «3 de 5», «Optimizado») e importancia. Lo que no se mapea (motivación, estrategia, implementación y migración, interfaces, capa física, ubicaciones, agrupaciones y las vistas, porque el módulo deriva las suyas) se resume por categoría en los avisos. Los ids salen del nombre, así que importar dos veces el mismo archivo da el mismo documento, y las entidades externas (`<!ENTITY`) se rechazan.

## Importar BPMN 2.0

`--format bpmn|auto` (también en la pestaña «Importar» y con «Abrir archivo…»). Lee el modelo semántico de BPMN 2.0 (`definitions`, en el espacio de nombres `http://www.omg.org/spec/BPMN/20100524/MODEL`, con cualquier prefijo) que escriben Camunda, bpmn.io, Signavio, Bizagi y demás; `auto` lo distingue de un modelo de ArchiMate (que también es `.xml`) por ese espacio de nombres. Como en ArchiMate, lo que el módulo no puede representar se resume en los avisos, no se descarta en silencio.

| BPMN | Documento empresarial |
|---|---|
| `participant` (pool) | unidad; externa si no tiene `processRef` (una caja negra) |
| `lane` | unidad hija del pool (los carriles anidados cuelgan de su carril) |
| `process` | proceso, con el pool como responsable (`assigned-to`) |
| tarea, subproceso y actividad de llamada | proceso hijo del proceso o subproceso que lo contiene (`composes`), con su carril como responsable |
| `sequenceFlow` entre actividades | `triggers` de una actividad a la siguiente |
| `messageFlow` | `flows-to` entre los procesos de sus extremos |
| actividad de llamada con `calledElement` | el proceso llamado forma parte de la actividad (`composes`) |

Los **eventos y las compuertas no son procesos y desaparecen**, igual que las uniones de ArchiMate: la relación que pasa por ellos se sustituye por una directa entre las actividades de sus extremos, y los nombres de los eventos, las compuertas y las condiciones de las ramas quedan en la descripción de esa relación (`Compuerta exclusiva: ¿Hay stock? → Sí`). El evento de inicio y el de fin con nombre pasan a la descripción de su proceso; un evento límite cuelga de la actividad a la que está unido; y un pool de caja negra se convierte en un proceso marcado `caja-negra` para poder recibir y enviar mensajes.

Lo que **no** se importa y se resume en los avisos: objetos y almacenes de datos, anotaciones, asociaciones y grupos; coreografías y conversaciones; las extensiones de herramienta (`extensionElements`, atributos `camunda:`…); las características de bucle y multiinstancia; y el diagrama gráfico (BPMNDI), porque el módulo calcula su propia distribución. Solo se usa `fast-xml-parser`, sin red ni disco; se rechazan las entidades propias (`<!ENTITY>`), el XML mal formado, el texto de más de 32 MiB, más de 100 niveles de anidamiento o 500.000 elementos, y los modelos con más de 50.000 actividades, eventos y compuertas.

```console
$ iark import pedidos-colaboracion.bpmn --module enterprise --format bpmn --out pedidos.json
aviso: 2 participante(s) sin proceso detallado («Pasarela de pagos», «Transportista») se importan como unidad externa con un proceso marcado «caja-negra», para poder recibir y enviar mensajes.
aviso: 11 evento(s) y 3 compuerta(s) no son procesos: las relaciones que pasan por ellos se unen directamente entre actividades y sus nombres y las condiciones de las ramas quedan en la descripción de la relación.
aviso: 1 flujo(s) de secuencia o evento(s) límite apuntan a un elemento que no existe y se ignoran.
aviso: 1 flujo(s) de mensaje apuntan a un elemento que no existe o que no tiene actividades, y se ignoran.
aviso: Sin correspondencia en el módulo, no se importan: 1 anotación(es), 1 asociación(es), 1 actividad(es) multiinstancia, 1 objeto(s) de datos, 1 referencia(s) a objetos de datos, 1 almacén(es) de datos, 1 grupo(s).
aviso: Extensiones de herramienta no importadas: 1 bloque(s) «extensionElements» y atributos de «camunda:».
aviso: 1 diagrama(s) gráfico(s) (BPMNDI) no se importan: el módulo calcula su propia distribución.
Importado "Proceso de pedidos" en el módulo enterprise: 25 elementos, 7 aviso(s).
Documento del módulo enterprise escrito en pedidos.json
$ iark validate pedidos.json --module enterprise
…
Documento válido (módulo enterprise). 0 error(es), 0 aviso(s), 37 nota(s).
```

Un modelo de BPMN solo describe procesos y quién los ejecuta: no trae capacidades, aplicaciones ni tecnología, así que las notas de `validate` (procesos que no realizan ninguna capacidad ni están soportados por una aplicación) son lo esperado; se completan en el documento o con el lienzo del módulo. Los ids salen del nombre, así que importar dos veces el mismo archivo da el mismo documento. Los archivos de ejemplo, [`pedidos-colaboracion.bpmn`](../../tests/fixtures/importar/bpmn/pedidos-colaboracion.bpmn) y [`solicitud-vacaciones.bpmn`](../../tests/fixtures/importar/bpmn/solicitud-vacaciones.bpmn), están escritos para las pruebas.
