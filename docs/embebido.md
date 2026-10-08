# Modo embebido: iframe, postMessage, SDK y Web Component

[← Índice de la documentación](indice.md)

**Modo embebido** por `<iframe>` con protocolo **postMessage** al estilo de draw.io (`embed.diagrams.net`) y un SDK de anfitrión.

Hay dos protocolos, los dos por `postMessage`: el del **editor C4** (`index.html?embed=1&proto=json`) y el del **banco de trabajo de módulos** (`modulos.html?embed=1&proto=json`), que añade `module` y `capabilities`. Encima de ellos están el SDK de anfitrión (`createIarkEmbed`, `createIarkModuleEmbed`) y el Web Component `<iark-module>`; la federación por manifiesto permite descubrir el editor de cada módulo en cualquier instancia.

## Embebido en otra aplicación (iframe + postMessage)

Abre la app con `?embed=1&proto=json[&origin=https://mi-host][&theme=dark][&ui=min][&configure=1]` dentro de un `<iframe>`. El protocolo sigue el patrón de draw.io: el iframe emite `init`, el anfitrión responde `load`, y a partir de ahí intercambian mensajes JSON (objeto o cadena).

**iframe → anfitrión (`event`)**

| `event` | Cuándo | Carga útil |
|---|---|---|
| `init` | la app está lista | `{ version }` |
| `configure` | antes de `init`, si se abrió con `&configure=1` | — |
| `load` | documento cargado | `{ document, viewId }` |
| `change` / `autosave` | cada cambio (500 ms de throttle); `autosave` solo si `load.autosave = true` | `{ document }` |
| `save` | Guardar / Guardar y salir | `{ document, drawio, exit }` |
| `export` | respuesta a `action: export` | `{ format, data, viewId, requestId }` |
| `autoLayout` | tras un autolayout pedido por el anfitrión | `{ viewId, direction }` |
| `viewChange` | el usuario (o `setView`) cambió de vista | `{ viewId, level: 'C1' \| 'C2' \| 'C3', scopeId, title }` |
| `exit` | salir | `{ modified }` |
| `error` | documento inválido, acción desconocida… | `{ message, issues?, requestId? }` |

**anfitrión → iframe (`action`)**

| `action` | Parámetros |
|---|---|
| `load` | `document?` (objeto o JSON), `autosave?`, `title?`, `readOnly?`, `theme?`, `viewId?`, `autoLayout?` |
| `configure` | `theme?`, `ui?: 'full' \| 'min'`, `hideSidePanel?` |
| `merge` | `document`, `autoLayout?` — fusiona elementos/relaciones/vistas y relanza el autolayout |
| `export` | `format: 'json' \| 'drawio' \| 'svg' \| 'png'` (`svg` devuelve el SVG de la vista y `png` ese SVG rasterizado como data URL; sin `viewId`, la vista activa), `notation?: 'c4' \| 'card'` (solo `drawio`), `viewId?`, `requestId?` |
| `autoLayout` | `viewId?`, `direction?: 'auto' \| 'DOWN' \| 'RIGHT' \| 'LEFT' \| 'UP'`, `distribution?: 'auto' \| 'centered' \| 'elk'`, `force?` |
| `setView` | `viewId` |
| `status` | `message`, `modified?` — texto en la cabecera |
| `dialog` | `title`, `message`, `button?` |
| `save` | `exit?` — fuerza la emisión de `save` |
| `exit` | — |

Seguridad: solo se atienden mensajes cuyo `source` es `window.parent`; con `&origin=` se exige además ese `event.origin` y se usa como `targetOrigin` de las respuestas (sin él se usa `*`, solo recomendable en desarrollo). Los documentos recibidos se validan con el mismo esquema zod del núcleo.

### SDK de anfitrión

```html
<div id="editor" style="height: 100vh"></div>
<script type="module">
  import { createIarkEmbed } from 'iark-diagrams/embed'; // o dist/embed/iark-embed.global.js → window.IArkEmbed
  const embed = createIarkEmbed({
    container: '#editor',
    url: 'https://mi-servidor/diagramador/',
    document: miDocumento,          // opcional; sin coordenadas ⇒ autolayout
    autosave: true,
    theme: 'dark',
    onSave: ({ document, drawio, exit }) => guardar(document, drawio),
    onChange: (document) => console.log('cambió', document),
    onExit: () => cerrarModal(),
  });
  await embed.ready;
  const xml = await embed.export('drawio');
  embed.autoLayout({ direction: 'RIGHT' });
  embed.merge(otroFragmento);
  embed.setView('contenedores');
  embed.destroy();
</script>
```

Demo completa: [`examples/embed-host.html`](../examples/embed-host.html) (en desarrollo: `http://localhost:5173/examples/embed-host.html`; tras `npm run build` queda en `dist/app/examples/embed-host.html`).

## Protocolo de módulos y SDK

Es el protocolo del editor C4 con dos añadidos: el `init` lleva el `capabilities` de la instancia (módulos, formatos, informes y vistas de traza) y las acciones/eventos llevan un `requestId` para correlacionar las respuestas. El origen del anfitrión es `?origin`, o el del `referrer`, o el propio; los mensajes nunca se envían a `*`.

- **Acciones** (anfitrión → iframe): `load` (con `module`, `document` o texto con `importer`, `viewId`, `autosave`, `readOnly`), `configure` (`theme`, `ui: 'full' | 'min'`), `setView`, `export`, `validate`, `run` (informe o conversión), `capabilities`, `status`, `dialog`, `save`, `exit`.
- **Eventos** (iframe → anfitrión): `init`, `configure`, `load`, `change`, `autosave`, `issues`, `viewChange`, `export`, `result`, `capabilities`, `save`, `exit`, `error`.
- **`ui=min`** oculta la marca y las pestañas de módulos pero conserva las acciones.

```js
import { createIarkModuleEmbed } from 'iark-diagrams/embed'; // o dist/embed/iark-embed.global.js → window.IArkEmbed.createIarkModuleEmbed
const embed = createIarkModuleEmbed({
  container: '#panel',
  url: 'https://mi-servidor/diagramador/modulos.html', // o el `endpoints.embed` del manifiesto
  module: 'security',
  document: miDocumento,
  autosave: true,
  onChange: ({ document, issues }) => guardar(document),
});
const capacidades = await embed.initialized;
await embed.ready;
const svg = await embed.export('svg', 'dfd');
const { output } = await embed.run('risks', { options: { status: 'open' } });
```

Las acciones que esperan respuesta (`load`, `export`, `validate`, `run`, `capabilities`) devuelven una promesa y se rechazan con el mensaje de `error`, o por tiempo (15 s, configurable). Las que se lanzan antes del `init` se encolan. Demo: [`examples/modules-host.html`](../examples/modules-host.html).

## Web Component `<iark-module>`

```html
<script type="module" src="https://mi-servidor/diagramador/embed/iark-module-element.js"></script>
<iark-module manifest="https://mi-servidor/diagramador/.well-known/iark.json" module="security" theme="dark" ui="min" style="height: 520px"></iark-module>
<script>document.querySelector('iark-module').document = miDocumento;</script>
```

Atributos: `manifest` (descubre el editor del módulo en la instancia) o `src` (URL directa de `modulos.html`), `module`, `theme`, `ui`, `readonly`, `autosave`, `view`. El documento va por la propiedad `document` (objeto o JSON). Eventos DOM: `iark-init`, `iark-load`, `iark-change`, `iark-view-change`, `iark-save`, `iark-exit`, `iark-error`, `iark-result`. Métodos: `export`, `run`, `validate`, `capabilities`, `setView`, `save`; esperan a que el widget esté listo. Demo: [`examples/web-component-host.html`](../examples/web-component-host.html). Se empaqueta como `dist/embed/iark-module-element.{js,global.js}` y como el subpath `iark-diagrams/element`.

## Federación por manifiesto

Cada instancia publica `/.well-known/iark.json` (esquema `iark.manifest/1`): módulos, versiones, formatos y **endpoints relativos** al manifiesto (`embed`, `schema`, `api`). El sitio estático lo incluye junto con los JSON Schema de cada módulo (`npm run manifest` lo regenera; una prueba comprueba que no se desincroniza), y `iark serve` lo genera al vuelo con la URL de su API. El shell y el Web Component solo dependen de ese manifiesto, no del código de los módulos.
