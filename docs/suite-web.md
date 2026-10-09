# Suite web: banco de trabajo, widget, shell y servicio

[← Índice de la documentación](indice.md)

Los cinco módulos nuevos comparten una interfaz genérica que se genera a partir del contrato `DomainModule` (esquema, vistas, exportadores, informes…), de modo que un módulo nuevo aparece en la web sin escribir pantallas. Cada módulo se carga bajo demanda (`import()` dinámico), así que el editor C4 no paga su peso.

| Superficie | Dónde | Para qué |
|---|---|---|
| Banco de trabajo | `modulos.html?module=security` | Editar, ver, exportar, importar, ejecutar informes y comparar documentos de cualquier módulo (ver [Banco de trabajo](#banco-de-trabajo) más abajo). |
| Widget embebible | `modulos.html?embed=1&proto=json&origin=…` | Mismo banco de trabajo dentro de un `<iframe>`, con un protocolo `postMessage` propio (`src/embed/moduleProtocol.ts`). |
| Trazabilidad | `trazabilidad.html` | Vista transversal: enlaces `urn:iark:…` entre los documentos de varios módulos, referencias sin resolver y alcance de un elemento (ver [Trazabilidad entre módulos](trazabilidad.md)). |
| Shell de la suite | `suite.html` | Descubre los módulos de una instancia leyendo su manifiesto y monta el editor C4 o el widget del módulo elegido. Acepta una URL de manifiesto de otra instancia y rechaza con un mensaje claro la de una versión del manifiesto o del protocolo que no entiende; aparta los módulos que exigen un contrato más nuevo (ver [Federación por manifiesto](embebido.md#federación-por-manifiesto)). |
| Servicio HTTP | `iark serve` | La misma API para todos los módulos y el sitio estático, en un proceso Node sin dependencias. |

## Banco de trabajo

`modulos.html?module=<id>` es la interfaz genérica de un módulo. Pestañas y acciones:

- **Lienzo.** En los cinco módulos con editor propio (integración, datos, empresarial, plataforma y seguridad) la pestaña «Lienzo» es un editor interactivo con paleta de figuras de la especialidad, tipo de relación al conectar, panel de propiedades, deshacer/rehacer, autolayout ELK, minimapa y los atajos del editor C4; el JSON y el SVG quedan en «Vista SVG». En C4, la pestaña «C4» es el editor principal embebido, sincronizado con la pestaña JSON (historia en [historial.md](historial.md#fase-6-identidad-e-interactividad-de-los-diagramadores)).
- **Editar el JSON** del módulo con validación en vivo (esquema + reglas del dominio) y ver las vistas y las vistas de traza.
- **Exportar**: Mermaid con su vista previa dibujada, SVG y draw.io.
- **Importar**: Mermaid y los formatos propios de cada módulo, también con «Abrir archivo…»; los avisos de la última importación se ven en la pestaña «Importar (N)» sea cual sea la vía y se quitan al editar el documento.
- **Informes y conversiones** (`from-integration`…).
- **Comparar** con otra versión del documento (pestaña «Comparar (N)»): «Abrir archivo a comparar…» o pegar su JSON; lista lo añadido, quitado y modificado con cada campo antes → después, y en el lienzo marca los nodos con **Nuevo** o **Modificado**, las aristas con un halo y dibuja lo quitado como un fantasma punteado con **Quitado**; hacer clic en un cambio selecciona y encuadra el elemento; en el módulo C4 el lienzo es un iframe y no se resalta dentro, pero el panel sí funciona.
- **Proyectos…** guarda y abre diagramas agrupados (ver [Proyectos](proyectos.md)).
- El borrador se guarda en el navegador (no en modo embebido). Un borrador, un archivo o un proyecto guardados con una versión anterior del formato se abren migrados y el panel de problemas lo dice («Documento migrado de la versión X a Y»); al guardarlo se escribe en la versión nueva. Uno de una versión más nueva se rechaza con «actualiza IArk» (ver [Versionado de documentos](versionado-documentos.md)).
