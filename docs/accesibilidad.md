# Accesibilidad

Qué se ha medido, qué se ha arreglado, qué atajos de teclado hay, qué se comprueba solo en cada cambio y qué **no** se ha podido comprobar sin un lector de pantalla real. Es la acción 10 de la [fase 3](roadmap.md) («Accesibilidad»).

> **Lo que este documento no afirma.** No dice que DIAgrams «cumple WCAG 2.2 AA». Dice que una herramienta automática (axe-core) no encuentra violaciones en las superficies auditadas y que se arreglaron las que sí encontró. Esa herramienta, según su propia documentación, detecta solo una parte de los problemas (alrededor de un tercio de los criterios WCAG se pueden comprobar sin una persona), y **nadie ha probado todavía estas pantallas con un lector de pantalla real**. La [lista de comprobación manual](#lista-de-comprobación-manual) de abajo es lo que falta.

## Alcance y objetivo

Objetivo: **WCAG 2.2 nivel AA** (texto 4,5:1 de contraste, componentes de interfaz y anillos de foco 3:1, todo operable con teclado, nombres y roles correctos, sin pérdida de contenido con zoom).

Superficies auditadas, cada una en tema claro y oscuro:

| Superficie | Dónde está | Qué se audita |
|---|---|---|
| Editor C4 clásico | `index.html`, `src/app/` | Vista inicial, los cinco menús abiertos, las pestañas Relaciones, Vistas e IA, el panel JSON, un elemento seleccionado (ficha desplegada), los diálogos de atajos, «Acerca de», vista previa de Mermaid y el gestor de proyectos. |
| Banco de trabajo | `modulos.html`, `src/modules-app/` | Los seis módulos, todas sus pestañas (lienzo con y sin panel de propiedades, informes, problemas, exportar, importar, comparar con y sin diferencias, vista SVG, contratos), el gestor de proyectos y la ayuda de atajos. |
| Lienzo común | `src/modules-app/canvas/` | Lo anterior, más el recorrido por teclado y los nombres accesibles de nodos y relaciones (pruebas unitarias). |
| Suite | `suite.html`, `src/shell/` | La página con un módulo embebido en su `<iframe>`. |
| Trazabilidad | `trazabilidad.html`, `src/trace-app/` | Vacía y con ejemplos, en las siete pestañas. |

Fuera de alcance: la salida exportada (SVG, draw.io, Mermaid: su accesibilidad depende de la herramienta que la abra), el widget embebible de terceros y la propia página de GitHub durante el inicio de sesión.

## Cómo se mide

`tests/e2e/accesibilidad.spec.ts` recorre esas superficies con [axe-core](https://github.com/dequelabs/axe-core) (`@axe-core/playwright`, solo en `devDependencies`) con las reglas `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` y `best-practice`. Los menús y los diálogos se auditan **abiertos**. Pasa si no hay violaciones `critical`, `serious` ni `moderate`; las `minor` se registran, no bloquean.

```bash
npm run build:app
E2E_PORT=4185 npx playwright test tests/e2e/accesibilidad.spec.ts          # puerta: falla si hay violaciones
A11Y_MODO=informe A11Y_SALIDA=a11y-informe npx playwright test tests/e2e/accesibilidad.spec.ts   # solo mide
A11Y_SIN_EXCLUSIONES=1 …                                                    # ignora las exclusiones nominales
npx tsx scripts/accesibilidad-resumen.ts a11y-informe [--superficies]       # resume el informe
```

Además hay pruebas que no necesitan navegador y corren con `npm test`:

- `src/modules-app/a11y/contraste.test.ts`: mide los pares de color de los temas (`--wb-*` del banco, la suite y la trazabilidad; `--c4-*` del editor clásico) con la fórmula de WCAG. Si alguien añade un color a un tema sin que llegue al mínimo, falla.
- `src/modules-app/a11y/*.test.ts(x)`: nombres accesibles (`etiquetas`), vecino por flechas (`teclado`), teclado de pestañas y filas accionables.
- `src/modules-app/canvas/DiagramCanvas.a11y.test.tsx` y `src/app/components/canvas/Canvas.a11y.test.tsx`: nombres, recorrido con flechas, mover con Mayús, Intro, Escape, Supr, la lista de elementos y el formulario de conexión, con jsdom.
- `src/app/components/sidepanel/ElementCard.a11y.test.tsx`: cada campo de la ficha tiene el nombre de su etiqueta.
- Reflujo: la misma spec e2e comprueba que a 640 px y a 320 px de ancho (200 % y 400 % de zoom sobre 1280 px) ninguna de las cuatro páginas se desplaza en horizontal.

`axe` también devuelve **«incompletos»**: casos que no pudo decidir (un fondo tapado por otro elemento, un texto demasiado corto). No son violaciones ni aprobados; el modo informe los cuenta aparte. Al terminar este trabajo quedan, sobre las 158 superficies × tema: 2.671 nodos de `color-contrast` (casi todo texto sobre el lienzo o sobre figuras SVG, que axe no sabe mezclar), 876 de `aria-valid-attr-value` (`aria-describedby` de los tooltips de Semi UI, que apuntan a un nodo que solo existe mientras el tooltip está abierto) y 62 de `aria-prohibited-attr` (`aria-label` en un `div` de Semi UI o de React Flow sin rol). Hay que revisarlos a mano o con un lector de pantalla; ver la lista de comprobación.

## Antes y después

Medido con la misma spec y las mismas reglas, 79 superficies × 2 temas (158 informes):

| | Antes | Después, con las 2 exclusiones | Después, sin exclusiones |
|---|---|---|---|
| Violaciones críticas | 66 (194 nodos) | 0 | 0 |
| Serias | 167 (867 nodos) | 0 | 0 |
| Moderadas | 210 (406 nodos) | 0 | 20 (20 nodos) |
| Total | **443 (1.467 nodos)** | **0** | **20** (todas de las dos exclusiones) |

Por regla, antes del trabajo (violaciones = regla × superficie × tema; entre paréntesis, superficies afectadas):

| Impacto | Regla | Violaciones | Qué era |
|---|---|---|---|
| crítico | `aria-allowed-attr` | 30 | Atributos ARIA no permitidos en el rol (`aria-expanded` en el disparador de un menú de Semi UI, entre otros). |
| crítico | `aria-required-children` | 28 | Pestañas de Semi UI con `collapsible`: botones que no son pestañas dentro del `tablist`. |
| crítico | `aria-valid-attr-value` | 6 | `aria-activedescendant` apuntando a una opción que no existe con la lista cerrada. |
| crítico | `label` | 2 | Campos de la ficha sin etiqueta asociada. |
| serio | `color-contrast` | 145 | Marca «DIAgrams», texto secundario, botones, enlaces, títulos de zona, pestañas… |
| serio | `scrollable-region-focusable` | 8 | Regiones con desplazamiento a las que el teclado no llegaba. |
| serio | `role-img-alt` | 6 | Flecha de los selectores de Semi UI con `aria-label=""`. |
| serio | `aria-input-field-name` | 4 | Selectores sin nombre. |
| serio | `target-size` | 2 | Botones de «Usado por» de 23 px de alto. |
| serio | `label-title-only` | 2 | El selector de color solo tenía `title`. |
| moderado | `page-has-heading-one` | 148 | Ninguna página tenía un `h1`. |
| moderado | `region` | 30 | Contenido fuera de landmarks. |
| moderado | `landmark-one-main` | 22 | Sin `main` (editor clásico). |
| moderado | `landmark-unique`, `landmark-no-duplicate-banner` | 6 y 4 | El banner del banco más el del diálogo de proyectos, y la suite con el banco embebido. |

## Qué se cambió, por prioridad

### Teclado

- **Lienzo común.** Cada elemento es una parada del tabulador (React Flow ya lo hacía). Las **flechas** pasan al elemento vecino en esa dirección (cono de 45°, más peso a lo alineado; no suben a la zona que contiene al elemento), **Mayús + flechas** lo mueven (10 px en el banco, una celda de 12 px en el editor clásico) y **Intro o F2** lo seleccionan y llevan el foco a sus propiedades; **Escape** desde las propiedades devuelve el foco al elemento. **Supr** sobre un elemento enfocado lo borra aunque no esté seleccionado, y el foco no se pierde en el `<body>`. Con Alt+↓ y Alt+↑ se sigue entrando y saliendo de niveles y enlaces, como antes.
- **Crear una relación sin arrastrar** (WCAG 2.5.7): el panel de propiedades de un elemento tiene «Crear una relación desde aquí», con el tipo y el destino en dos selectores nativos y un botón; pasa por la misma validación del módulo que el arrastre.
- **Lista de elementos** (botón «Lista» del banco): todos los elementos y relaciones del diagrama, agrupados como el dibujo, cada uno con un botón que lo selecciona, lleva la vista hasta él y le pasa el foco. Es la alternativa al dibujo para quien navega con lector de pantalla y el salvavidas de los diagramas grandes: **con `onlyRenderVisibleElements` los nodos fuera de la pantalla no existen en el DOM y el teclado no puede enfocarlos**; la lista y las flechas desplazan la vista hasta el nodo (`fitView` sobre él) y lo enfocan en cuanto aparece.
- **Pestañas** (módulos, paneles del banco, pestañas del editor): patrón de WAI-ARIA, con flechas, Inicio y Fin y `tabindex` rodante (solo la activa es parada del tabulador). **Decisión por defecto cambiable**: la pestaña a la que se llega se activa al instante, también al cambiar de módulo con las flechas (WAI-ARIA admite activación manual con Intro, que sería más prudente si cambiar de módulo tarda).
- **Saltar al contenido** (WCAG 2.4.1) en el banco, la suite y el editor clásico; el contenedor principal (`main`) recibe el foco.
- **Regiones con desplazamiento** (el dibujo SVG, el panel JSON, el texto de Mermaid, los registros de la suite): `tabindex="0"`, `role="region"` y nombre, para poder desplazarlas con las flechas.
- **Editor clásico**: los menús son botones (`aria-haspopup`, `aria-expanded`), al elegir una opción el foco vuelve al botón del menú, el título del diagrama es un botón dentro de un `h1` y, al terminar de renombrarlo, el foco vuelve a él; las cabeceras de tarjeta y las filas de problemas son accionables con Intro y Espacio; el separador del panel lateral se mueve con flechas, Inicio y Fin (WCAG 2.5.7); el gestor de proyectos devuelve el foco a quien lo abrió.

### Lectores de pantalla

- Cada nodo se anuncia con **tipo, nombre, tecnología, zona, a quién envía y de quién recibe, si enlaza con otro módulo y su marca en «Comparar»** («Contenedor: API de pedidos, Node.js. Dentro de «Sistema de pedidos». Sale hacia 2: Base de datos y Cola. Recibe de 1: Web.»). Cada relación, **de dónde a dónde va**. Los textos que React Flow trae en inglés (descripción de las teclas, aviso de movimiento, controles, minimapa) están en español.
- El lienzo se anuncia con cuántos elementos y relaciones tiene y cómo recorrerlo. Una región `aria-live` anuncia qué quedó seleccionado y qué se movió o borró.
- Landmarks y encabezados: un `h1` por página (visible en el banco completo y en el editor clásico, oculto en el modo embebido), `main`, `header`, `nav` y `aside` con nombre donde hay más de uno; los títulos de sección bajan de nivel de uno en uno.
- Los selectores de Semi UI llevan `aria-labelledby` hacia su etiqueta visible (su nombre propio es el literal «selected»), sin `aria-activedescendant` fantasma y con la flecha decorativa oculta; las etiquetas de las fichas están unidas a sus campos con `for`.
- Axe ya no encuentra botones ni enlaces sin nombre (`button-name`, `link-name`); los iconos decorativos van con `aria-hidden`.
- El aviso «hay una versión más nueva» de los proyectos en un servidor (otra persona guardó el diagrama abierto) vive en una región `role="status"` (`aria-live="polite"`) que está siempre en la página y vacía mientras no hay aviso, para que se anuncie el texto cuando aparece; «Cargar la nueva» e «Ignorar» son botones normales alcanzables con Tab, y al cargar el foco pasa a la región, que anuncia el resultado. Una prueba e2e (`tests/e2e/projects-cloud-eventos.spec.ts`) comprueba el rol, el teclado, un contraste de al menos 4,5:1 en tema claro y oscuro y que no desborda a 390 px; con axe sobre la barra del proyecto solo si `@axe-core/playwright` está instalado. **No se probó con un lector de pantalla real.**

### Contraste

- **Banco, suite y trazabilidad**: el color primario se separó en un relleno (`--wb-primary`, con texto blanco encima) y en un texto/línea (`--wb-primary-ink`); el texto atenuado (`--wb-muted`), los bordes de los campos (`--wb-control-border`, 3:1), el anillo de foco (`--wb-focus`) y los rellenos de los signos de «Comparar» tienen sus propios valores en cada tema. Los pares están en `contraste.test.ts`.
- **Editor clásico**: texto atenuado (`--c4-text-muted`, el de Semi daba 2,1:1), anillo de foco, textos de los botones claros de peligro y primario en el tema oscuro, tinta de los nodos por contraste real (`tintaLegible`) y no por brillo.
- **Lienzo**: el título de una zona lleva un fondo propio y un color oscurecido solo lo justo para llegar a 4,5:1 sobre él; el anillo de foco de los nodos es siempre claro-sobre-claro u oscuro-sobre-oscuro según el tema.

### Movimiento reducido

`@media (prefers-reduced-motion: reduce)` apaga transiciones y animaciones de CSS en las cuatro páginas; los encuadres y zoom de la cámara (que dirige el código) pasan por `duracion()` y saltan sin animar si la persona lo pidió en su sistema.

### Objetivos táctiles y zoom

Botones de 24 × 24 px como mínimo (WCAG 2.5.8; `target-size` de axe sin violaciones). La suite pasa a una sola columna por debajo de 600 px. Reflujo comprobado a 640 y 320 px en las cuatro páginas (el propio diagrama queda exento: necesita un plano de dos dimensiones).

### Idioma

Las cuatro páginas ya declaraban `lang="es"`; no hizo falta cambiarlo. La interfaz solo está en español (ver [roadmap](roadmap.md), «Interfaz es/en»). Los nombres de los elementos del documento van en el idioma en que los escribió la persona y no se marcan con `lang` propio.

## Exclusiones nominales

Una exclusión descarta **una regla en un selector concreto**, con su motivo y cuándo se arregla; nunca una regla entera ni un selector para todas las reglas. Están en `EXCLUSIONES` de la spec, y `A11Y_SIN_EXCLUSIONES=1` las ignora para comprobar que siguen haciendo falta.

| Regla | Selector | Impacto | Motivo | Cuándo se arregla |
|---|---|---|---|---|
| `region` | `.semi-portal` | moderado (mejor práctica, no criterio A/AA) | Semi UI monta menús y diálogos en un portal al final del `<body>`, fuera de los landmarks. El diálogo es `role="dialog"` con nombre y `aria-modal`; el menú es `role="menu"` junto a su disparador. | Al sustituir menús y diálogos de Semi UI por componentes propios, o si Semi deja montar el portal dentro de un landmark. |
| `heading-order` | `#semi-modal-title` | moderado (mejor práctica, no criterio A/AA) | Semi UI pinta el título de todo diálogo como `<h5>` sin permitir otro nivel, y se abre sobre una página cuyo último encabezado es el `h1`. El diálogo se rotula con ese título (`aria-labelledby`). | Igual que la anterior. |

Solo afectan al editor clásico (los diálogos del banco son propios y cumplen).

## Atajos de teclado

Los del banco de trabajo (botón «Atajos» del lienzo) y los del editor clásico (Ayuda › Atajos de teclado) comparten estos:

| Tecla | Qué hace |
|---|---|
| Tabulador · Mayús + Tabulador | Recorrer los elementos del lienzo (y todo lo demás) |
| Flechas, con un elemento enfocado | Pasar al elemento vecino en esa dirección |
| Mayús + flechas | Mover el elemento enfocado (el banco, también la selección) |
| Intro · F2 | Seleccionar el elemento y pasar a sus propiedades (ficha) |
| Escape | Quitar la selección; desde las propiedades, volver al elemento |
| Supr · Retroceso | Borrar lo seleccionado (en el banco, también el elemento enfocado aunque no esté seleccionado) |
| Ctrl/⌘ + Z · Ctrl/⌘ + Y | Deshacer · Rehacer |
| Ctrl/⌘ + L | Autolayout |
| Alt + ↓ · Alt + ↑ | Seguir un enlace o bajar de nivel · volver o subir |
| 0 (banco) | Ajustar a la ventana |
| Flechas, Inicio, Fin (en una lista de pestañas) | Cambiar de pestaña |
| Flechas, Inicio, Fin (en el separador del panel lateral, editor clásico) | Cambiar su ancho (Mayús: pasos mayores) |

Las **relaciones no son paradas del tabulador** (`edgesFocusable={false}`): había que pasar por todas antes de llegar a los elementos. Se eligen en la «Lista» (banco), en la pestaña «Relaciones» (editor clásico) o con el ratón.

## Idioma de la interfaz

La interfaz puede estar en español o en inglés (ver [desarrollo.md](desarrollo.md#internacionalización)). Lo que importa a la accesibilidad:

- **`<html lang>` siempre dice el idioma de la interfaz** (WCAG 3.1.1): se actualiza al arrancar y al cambiarlo. Las opciones del selector llevan su propio `lang` (3.1.2), porque cada idioma se escribe en sí mismo («Español», «English») para que quien no lee el actual encuentre el suyo.
- **El selector es un `<select>` nativo** con nombre accesible («Idioma» / «Language»), operable con teclado y lector sin código propio; cambia al elegir, sin recargar y sin perder el foco, y en el encabezado del editor, del banco y de la suite está en el orden de tabulación del propio encabezado (sin `tabindex` propio). Su borde cumple 3:1 (1.4.11) con los colores del banco o de Semi.
- **Los nombres accesibles también se traducen**: `aria-label`, `title`, `placeholder`, las regiones y los avisos de lo migrado (gestor, historial, administración, encabezados) salen en el idioma activo, y los plurales («1 versión» / «2 versiones»; «1 module» / «2 modules») siguen las reglas del idioma.
- **Lo que no se tradujo sigue en español aunque el resto esté en inglés**: el lienzo y sus textos para lectores, las fichas del panel lateral, las pestañas y paneles del banco… Un lector configurado en inglés leería esas partes con la voz equivocada, porque no llevan `lang="es"` propio. Está anotado como pendiente en la [hoja de ruta](roadmap.md).
- Las pruebas de accesibilidad del repositorio corren en español. No se ha repetido la auditoría con axe en inglés (`tests/e2e/accesibilidad.spec.ts` necesita `@axe-core/playwright`, que no estaba instalado en el entorno donde se hizo este cambio) ni se ha probado con un lector de pantalla en inglés.

## Lo que no se ha podido comprobar

- **Ningún lector de pantalla real** (NVDA, JAWS, VoiceOver, TalkBack, Orca). Los nombres, roles y mensajes están comprobados por estructura (árbol de accesibilidad y pruebas), no por cómo los lee cada lector: la longitud del nombre de un nodo, el orden de lectura y los anuncios de `aria-live` pueden resultar pesados o repetitivos.
- **Dispositivos táctiles reales** y alternativas al arrastre más allá del teclado (2.5.7 está cubierto con el formulario de relaciones y el separador por teclado; mover un nodo sin teclado ni arrastre no se puede).
- **Zoom del navegador de verdad** (se simuló con el ancho de ventana) y fuentes ampliadas por el sistema.
- **Modo de alto contraste de Windows** (`forced-colors`).
- **Los 876 + 62 + 2.671 «incompletos»** de axe, ni el contraste del texto sobre figuras del lienzo (axe no los decide).
- **Criterios que una herramienta no ve**: coherencia de la navegación, orden de lectura con significado, textos de enlace fuera de contexto, errores de formulario entendibles, tiempo suficiente, destellos, etc.
- **Con `onlyRenderVisibleElements`** (la mejora de rendimiento para diagramas grandes que se desarrolla en paralelo): las pruebas de esta rama se hicieron sin ella. La lista de elementos y el desplazamiento de la vista hasta el nodo están pensados para ese caso, pero hay que repetir la comprobación manual cuando se fusionen.
- Las **cuentas y el inicio de sesión de GitHub** no se auditaron.

## Lista de comprobación manual

Para repetir antes de una versión (o al tocar el lienzo, un diálogo o un tema). Solo con teclado salvo donde se diga otra cosa:

1. **Tabulador desde cero** en cada página: lo primero es «Saltar al contenido»; el foco siempre se ve; nunca se queda atrapado (salvo en un diálogo, y ahí Escape lo cierra y devuelve el foco a quien lo abrió).
2. **Lienzo**: Tabulador llega a los elementos; las flechas pasan al vecino; Mayús + flecha mueve; Intro abre las propiedades y Escape vuelve; Supr borra y el foco acaba en un sitio razonable; «Crear una relación desde aquí» crea una relación sin arrastrar.
3. **Lista de elementos** (con un diagrama de 100+ elementos): cada botón lleva al elemento, aunque esté fuera de la pantalla.
4. **Menús y pestañas**: flechas, Inicio y Fin; Escape cierra y devuelve el foco al botón del menú.
5. **Lector de pantalla** (NVDA + Firefox o Chrome en Windows, VoiceOver + Safari en macOS, y TalkBack o VoiceOver en móvil): recorrer el banco con un diagrama de ejemplo. ¿Se entiende de qué trata el diagrama sin verlo? ¿Se anuncia lo seleccionado y lo movido? ¿Los campos de la ficha dicen su nombre y su valor? ¿Los diálogos se anuncian con su título? ¿Los selectores dicen «Tipo, lista desplegable, Contenedor»?
6. **Zoom 200 % y 400 %** del navegador (no solo reducir la ventana): nada se corta ni se solapa, nada obliga a desplazar en horizontal salvo el diagrama.
7. **Texto ampliado** (solo texto 200 %) y **espaciado del texto** (WCAG 1.4.12).
8. **Movimiento reducido** activado en el sistema: la cámara salta y no hay animaciones.
9. **Alto contraste de Windows** y **modo oscuro del sistema**: todo se sigue viendo, los anillos de foco también.
10. **Móvil**: los botones se pulsan sin fallar; el separador del panel lateral y el arrastre de relaciones tienen alternativa.
11. **Aviso de versión más nueva** (dos navegadores contra un `iark serve --tokens`): al guardar la otra persona, el lector anuncia el aviso sin mover el foco; «Cargar la nueva» se alcanza con Tab y, al activarla, se anuncia «Se cargó la versión nueva».

## Cómo añadir algo sin romper nada de esto

- Un botón de solo icono lleva `aria-label`; un campo, una etiqueta asociada (`<label htmlFor>` o `aria-labelledby`); una fila clicable, `accionable()` o un `<button>`.
- Un color nuevo en un tema, un par en `contraste.test.ts`.
- Una pantalla o un diálogo nuevos, una prueba en `accesibilidad.spec.ts` (con el elemento abierto).
- Un diálogo propio: `role="dialog"`, `aria-modal`, título con `aria-labelledby`, foco dentro al abrir, trampa de foco, Escape para cerrar y el foco de vuelta a quien lo abrió.
- No añadas exclusiones a la spec sin el motivo y el cuándo.
