# Importar y exportar: draw.io, Structurizr y Mermaid

[← Índice de la documentación](indice.md)

Cómo entra y sale un diagrama de la suite. Esta página describe los formatos del módulo C4 (`.drawio` y DSL de Structurizr) y Mermaid; los formatos propios de cada módulo (OpenAPI, AsyncAPI, Threat Dragon, OpenLineage, BPMN, Terraform, Kubernetes, CloudFormation, Helm, DDL de SQL, dbt, ArchiMate…) se explican en el documento de su módulo. En todos los importadores lo que no se puede mapear se lista como aviso (nunca se descarta en silencio) y importar dos veces el mismo archivo da el mismo documento.

`iark modules` lista los módulos instalados con sus formatos; hoy son:

| Módulo | Importa | Exporta | Detalle |
|---|---|---|---|
| `c4` | `drawio`, `dsl` (Structurizr), `mermaid` | `drawio`, `svg`, `mermaid` | esta página |
| `integration` | `mermaid`, `openapi` (OpenAPI 3.x y Swagger 2.0), `asyncapi` (2.x y 3.x) | `mermaid`, `svg`, `drawio` | [integración](modulos/integracion.md#importar-openapi-y-asyncapi) |
| `data` | `mermaid`, `ddl` (SQL), `dbt`, `openlineage` | `mermaid`, `svg`, `drawio`, `ddl` | [datos](modulos/datos.md#importar-openlineage) |
| `enterprise` | `mermaid`, `archimate`, `bpmn` (BPMN 2.0) | `mermaid`, `svg`, `drawio` | [empresarial](modulos/empresarial.md#importar-bpmn-20) |
| `platform` | `mermaid`, `terraform`, `kubernetes`, `cloudformation`, `helm` | `mermaid`, `svg`, `drawio` | [plataforma](modulos/plataforma.md#importar-cloudformation-y-helm) |
| `security` | `mermaid`, `threat-dragon` (OWASP Threat Dragon v2) | `mermaid`, `svg`, `drawio` | [seguridad](modulos/seguridad.md#importar-owasp-threat-dragon) |

El formato se elige con `--format <id>` (o `auto`, que lo deduce de la extensión y del contenido); ver [CLI](cli.md).

## Lo que tienen en común los formatos de terceros

Los importadores de OpenAPI, AsyncAPI, Threat Dragon, OpenLineage, BPMN, CloudFormation y Helm siguen las mismas reglas, porque `iark serve` ejecuta `import` sobre entrada no confiable. Los de Terraform, Kubernetes, DDL, dbt y ArchiMate, anteriores, comparten tres de ellas (no tocan red ni disco, avisan de lo que no entra y no copian secretos); Kubernetes además aplica los topes de tamaño y de anidamiento.

- **Sin red ni disco.** Un `$ref` a otro archivo o a una URL (OpenAPI, AsyncAPI), un subchart de Helm (`repository`, `file://`, `oci://`), una plantilla anidada de CloudFormation (`TemplateURL`) o un módulo local de Terraform no se siguen ni se leen: se avisa. Los `$ref` internos (`#/…`) sí se resuelven, con control de ciclos y de profundidad.
- **Solo las bibliotecas que ya usa la suite**: `yaml` (con su esquema por defecto; las etiquetas cortas de CloudFormation `!Ref`, `!Sub`… se leen como datos, nunca se ejecutan) y `fast-xml-parser` (sin entidades propias). No se añadió ninguna dependencia.
- **Topes comunes** (`IMPORT_LIMITS` del núcleo): hasta 32 MiB de texto, 200 niveles de anidamiento y 2.000.000 de nodos; los de cada formato, además, acotan los elementos que se recorren (el cálculo no puede crecer sin freno con una entrada hecha para ello). Una entrada vacía, de otro tipo, truncada, con un anidamiento de miles de niveles o con una «bomba» de alias termina con el código 2 y **un mensaje de una línea**, sin traza ni cuelgue.
- **Nada se descarta en silencio**: lo que el módulo no puede representar se resume en los avisos (agrupado y con su cuenta), y lo que el formato no dice y el importador decide (el lado más confiable de una frontera, el entorno de una plantilla, quién llama a una API) se avisa para que se revise.
- **Los secretos no se copian** a los elementos ni a los avisos: contraseñas de `values.yaml` de Helm, parámetros `NoEcho` de CloudFormation, valores de un Secret de Kubernetes y credenciales en la URL de un servidor de OpenAPI o AsyncAPI (que se quitan de las descripciones; el contrato que guarda el documento entero conserva el texto original del archivo, porque es el archivo).
- **Lo reconoce el contenido, no solo la extensión**: dos formatos que comparten `.yaml` o `.json` (OpenAPI, AsyncAPI, Kubernetes, CloudFormation y un `Chart.yaml` de Helm) se distinguen por sus campos raíz. Si varios importadores declaran la misma extensión, gana el primero cuyo `detect` encuentra su formato; un texto que no es de ninguno falla con la lista de formatos del módulo.

Las secciones siguientes describen el módulo C4; el Mermaid de los demás módulos (cada tipo de nodo con su forma) y sus formatos propios están en su documento.

## Conversión a `.drawio`

Cada vista se convierte en una página de draw.io. Los elementos se envuelven en `<object placeholders="1" c4Name=… c4Type=… c4Description=… c4Technology=…>` con los estilos de la librería C4 (`shape=mxgraph.c4.person2`, `cylinder3` para bases de datos, boundary punteado, relaciones ortogonales). Los hijos de un boundary cuelgan de su celda con geometría relativa, tal como los crea draw.io. El archivo se escribe sin comprimir, así que draw.io / diagrams.net lo abre directamente y se puede versionar en git.

```bash
npx iark convert examples/banca.json --out banca.drawio          # aplica autolayout si faltan coordenadas
npx iark convert examples/banca.json --locale en --view contexto  # etiquetas de tipo en inglés, una sola vista
npx iark convert examples/banca.json --notation card --out banca-tarjetas.drawio  # tarjetas estilo drawdb
```

Dos **notaciones** de figuras (`--notation`, menú Archivo o `toDrawio(doc, { notation })`):

- `c4` (por defecto): librería C4 oficial de draw.io (persona, sistema, contenedor, componente, cilindro).
- `card`: tarjetas estilo drawdb (rectángulo claro con franja del color C4, nombre, `[Tipo: tecnología]` y descripción); las bases de datos y colas conservan el cilindro con relleno claro.

Los archivos [`examples/banca-c4.drawio`](../examples/banca-c4.drawio) y [`examples/banca-tarjetas.drawio`](../examples/banca-tarjetas.drawio) son el ejemplo de banca exportado en cada notación (3 páginas, enlaces entre niveles y waypoints del autolayout).

## Importar un `.drawio`

Un diagrama de draw.io se puede convertir en un documento C4 (cada **página** pasa a ser una **vista**), tanto en la web (**Archivo ▸ Importar .drawio…**, pide confirmación si hay cambios sin guardar) como en el CLI (`iark import` deduce el formato de la extensión o del contenido; también hay un [DSL de Structurizr](#importar-un-dsl-de-structurizr)):

```bash
npx iark import examples/banca-c4.drawio --out banca.json     # el nombre del diagrama sale del archivo (o --name)
npx iark import diagrama.drawio | npx iark layout --stdin --force > reordenado.json   # descartando las posiciones
cat diagrama.drawio | npx iark import --stdin
```

En el CLI lo importado va a stdout (o a `--out`) y el resumen y los avisos a stderr, así que se puede encadenar con `validate`, `layout` y `convert`. Un archivo que no es de draw.io termina con el código 2 y un motivo de una línea.

Qué reconoce, de más a menos fiel:

- **Un `.drawio` exportado por esta herramienta** (ambas notaciones): recupera los ids, tipos, descripciones, tecnologías, `external`, `shape`, `color`, jerarquía (`parentId`), relaciones, vistas (título, tipo, alcance) y las posiciones y tamaños absolutos. Los ids escritos a propósito (kebab-case, como `web-app` o `r1`) se conservan también en `.drawio` de versiones anteriores de la herramienta o hechos a mano; los aleatorios de draw.io se sustituyen por un id derivado del nombre.
- **La librería C4 de draw.io** (`c4Name`, `c4Type`, `c4Description`, `c4Technology`, en español o inglés): los tipos salen de `c4Type`, "externo" del `c4Type` o del color de relleno, y la jerarquía del boundary que contiene cada forma. Un elemento con el mismo nombre y tipo en varias páginas es un único elemento.
- **Formas sueltas** (sin metadatos): nombre = primera línea del texto, `[Tipo: tecnología]` en una línea aparte fija el tipo y la tecnología, el resto es la descripción; una persona (`umlActor`) o un cilindro (base de datos, o cola si está girado) se reconocen por su forma; y sin más pistas el tipo lo da el anidamiento: sistema › contenedor › componente. Las flechas toman su descripción del texto y `[tecnología]`.
- Se leen las páginas **comprimidas** (el formato por defecto de versiones antiguas de draw.io) y un `<mxGraphModel>` suelto (*Extras ▸ Editar diagrama*).

Cómo se decide cada vista: un boundary de sistema (o de contenedor) que envuelve las formas de la página es su alcance y la vista pasa a ser de contenedores (o de componentes); sin boundary, se usa el enlace `data:page/id,…` de un sistema o contenedor que apunte a la página y, si no, el contenido.

Lo que **no** se importa (siempre se avisa, sin detener la importación): notas de texto suelto, formas sin texto, capas y formas ocultas, flechas sin origen o destino conectados, marcos que solo agrupan personas o sistemas (p. ej. "Empresa"), y las jerarquías que C4 no admite (esa forma se importa sin padre). Además:

- Las **rutas de las flechas** (waypoints) no se importan: la app las recalcula al abrir la vista (o con Autolayout).
- La notación de **tarjetas** no distingue navegador ni móvil (los dibuja como rectángulos), así que esas formas se recuperan sin `shape`.
- No se importan `tags`, `layout` ni la descripción del espacio de trabajo: `.drawio` no los guarda.
- Los `.drawio.svg` / `.drawio.png` (con el XML incrustado) no se leen; expórtalos antes como `.drawio`.

## Importar un DSL de Structurizr

Un modelo escrito en el [DSL de Structurizr](https://docs.structurizr.com/dsl) se importa con el mismo flujo y las mismas garantías que un `.drawio`: en la web con **Archivo ▸ Importar Structurizr DSL…** (pide confirmación si hay cambios sin guardar, deja el diagrama como "sin guardar" y lista los avisos en un modal) y en el CLI con `iark import`, que deduce el formato de la extensión (`.dsl`) o del contenido (`--format dsl|drawio` lo fuerza). Siempre produce un documento válido o un error de una línea (código de salida 2), con el número de línea del DSL cuando el fallo es de sintaxis.

```bash
npx iark import examples/banca.dsl --layout --out banca.json     # --layout coloca con ELK las vistas sin coordenadas
npx iark import examples/banca.dsl --layout | npx iark convert --stdin --out banca.drawio   # DSL → .drawio
```

Un DSL no tiene coordenadas, así que las vistas quedan sin posicionar: la app las coloca sola al abrirlas (o `--layout` en el CLI). [`examples/banca.dsl`](../examples/banca.dsl) es el ejemplo de banca escrito en DSL y produce el mismo modelo y las mismas vistas que `examples/banca.json`.

Qué importa:

- **Modelo:** `person`, `softwareSystem`, `container` y `component` con su jerarquía (un contenedor dentro de su sistema, un componente dentro de su contenedor), descripción, tecnología y etiquetas; `group` y `enterprise` solo aportan su contenido.
- **Relaciones:** `origen -> destino "descripción" "tecnología" "etiquetas"`, también dentro de un elemento (`-> otro`, `this -> otro`), con identificador (`r = a -> b`) y adelantadas (pueden apuntar a elementos definidos más abajo).
- **Identificadores** planos y jerárquicos (`!identifiers hierarchical`, con referencias como `sistema.contenedor` o por ámbito); el identificador pasa a ser el `id` del elemento. También `!const`/`!var` con `${NOMBRE}`, comentarios (`#`, `//`, `/* */`), líneas continuadas con `\`, y cadenas `"…"` y `"""…"""`.
- **Vistas:** `systemLandscape`, `systemContext`, `container` y `component`, con su clave, descripción, `title`, `autoLayout tb|bt|lr|rl [separación de rangos] [separación de nodos]` (dirección y separaciones de la vista) y `include`/`exclude` con `*` (los elementos que C4 muestra por defecto en ese nivel), identificadores, `->x->`, `x->`, `->x`, y `element.tag`, `element.type` y `element.parent` (`==` y `!=`). Si el DSL no define vistas se crean las de por defecto (contexto, contenedores y componentes de cada sistema).
- **Estilos** (`styles { element "Etiqueta" { … } }`): `shape cylinder|pipe|webbrowser|mobiledevice…` pasa a la forma del elemento (base de datos, cola, navegador, móvil), `background` a color propio del elemento cuando no es el color estándar de C4, y las etiquetas `External` / `Existing System` (o el gris `#999999`) marcan el elemento como externo.
- **`!include`** de otros archivos en el CLI (relativos al archivo que incluye, con detección de ciclos); solo se leen archivos **dentro del directorio del archivo de entrada** (también siguiendo enlaces simbólicos), así que un DSL de origen desconocido no puede leer nada fuera de su carpeta. En la web y por stdin no hay otros archivos: el `!include` se omite con un aviso.

Qué **no** se importa (siempre se avisa, agrupado por sentencia, sin detener la importación): despliegue (`deploymentEnvironment`, `deploymentNode`…), vistas `dynamic`, `filtered`, `deployment`, `custom` e `image`, `!docs`, `!adrs`, `!ref`, `!script`, `url`, `properties`, `perspectives`, las expresiones de relaciones en `include`/`exclude` (`relationship==…`) y `workspace extends`; y un elemento en un sitio que C4 no admite (un contenedor fuera de un sistema, una persona dentro de uno…) se omite con su contenido. Los temas, la marca (`branding`) y la configuración se ignoran sin avisar, y los estilos de relaciones no se aplican.

## Mermaid

**Importar** (Archivo ▸ Importar Mermaid…, o `iark import diagrama.mmd`). Se admiten:

| Diagrama de Mermaid | Se convierte en |
|---|---|
| `C4Context`, `C4Container`, `C4Component`, `C4Dynamic` | `Person`, `System*`, `Container*`, `Component*` (con `_Ext`, `Db`, `Queue`), `System_Boundary` (sistema) y `Container_Boundary` (contenedor), `Rel`/`BiRel`/`Rel_*`; los `UpdateElementStyle`/`UpdateLayoutConfig` se ignoran |
| `flowchart` / `graph` | nodos y aristas (`-->`, `---`, `-.->`, `==>`, etiquetas `\|texto\|` o `-- texto -->`, cadenas y `A & B`); `subgraph` anidados = sistema › contenedor › componente; `[( )]` = base de datos, `([ ])` = cola |
| `sequenceDiagram` | `actor` = persona, `participant` = sistema, cada mensaje distinto = relación |
| `erDiagram` | entidad = sistema con forma de base de datos (atributos en la descripción), relación con su cardinalidad |

Mermaid no guarda coordenadas ni vistas: se crean las vistas por defecto y el autolayout hace el resto. Lo que no se entiende se lista como aviso. También vale un bloque ```` ```mermaid ```` de un Markdown o un archivo con frontmatter `title:`.

**Exportar** la vista activa (Archivo ▸ Exportar Mermaid, copiar al portapapeles, o `iark convert doc.json --to mermaid --view contenedores [--mermaid-format c4|flowchart]`). `generate --from` y `prompt --from` aceptan también `.drawio`, `.dsl` y `.mmd` como documento base.

**Vista previa** de cómo dibuja Mermaid la vista activa, sin salir de la aplicación: Archivo ▸ Vista previa de Mermaid… en el editor C4 (en C4 nativo o como diagrama de flujo, con el texto exportado a la vista) y, en el banco de trabajo, Exportar ▸ Mermaid ▸ Ver. El dibujo lo hace la librería [`mermaid`](https://mermaid.js.org), que solo se descarga la primera vez que se pide la vista previa (el resto de la aplicación no la carga) y es una dependencia de desarrollo: forma parte del sitio compilado, no del paquete npm ni del CLI. Es una aproximación para pegar en README, GitHub o Confluence; el diagrama definitivo es el del editor. «Tamaño real» permite leer los diagramas grandes con desplazamiento.
