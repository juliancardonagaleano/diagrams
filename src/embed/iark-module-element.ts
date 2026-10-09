import { embedUrlFromManifest, resolveEndpointUrl } from '@iark/kernel/endpoint';
import { createIarkModuleEmbed, type IarkModuleEmbed, type ModuleEvent, type SuiteCapabilitiesInfo } from './iark-module-embed';

/**
 * Web Component `<iark-module>`: el widget de un módulo de la suite sin escribir JavaScript de integración.
 *
 *   <script type="module" src="https://mi-host/diagramador/embed/iark-module-element.js"></script>
 *   <iark-module manifest="https://mi-host/diagramador/.well-known/iark.json" module="security" theme="dark"
 *                style="height: 520px"></iark-module>
 *
 * Con `manifest` descubre el editor del módulo en la instancia (federación); con `src` se indica directamente la URL del
 * banco de trabajo (`modulos.html`). El documento se pasa por la propiedad `document` (objeto o JSON) y los cambios
 * salen como eventos DOM (`iark-change`, `iark-load`, `iark-view-change`, `iark-save`, `iark-exit`, `iark-error`,
 * `iark-init`). El atributo `lang="en"` fija el idioma de la interfaz del widget (cambiarlo vuelve a abrir el iframe). Los métodos (`export`, `run`, `validate`, `capabilities`, `setView`, `save`) esperan a que el widget esté listo.
 */
const EVENT_NAMES = {
  init: 'iark-init',
  load: 'iark-load',
  change: 'iark-change',
  viewChange: 'iark-view-change',
  save: 'iark-save',
  exit: 'iark-exit',
  error: 'iark-error',
  result: 'iark-result',
} as const;

const OBSERVED = ['src', 'manifest', 'module', 'theme', 'ui', 'lang', 'readonly', 'autosave', 'view'] as const;

const STYLE = `
  :host { display: block; min-height: 360px; }
  .root { width: 100%; height: 100%; min-height: inherit; display: flex; }
  .root iframe { flex: 1; }
  .message { margin: auto; padding: 16px; font: 14px system-ui, sans-serif; color: #b42318; }
`;

export class IarkModuleElement extends HTMLElement {
  static observedAttributes = OBSERVED;

  #root?: HTMLDivElement;
  #embed?: IarkModuleEmbed;
  #ready?: Promise<IarkModuleEmbed>;
  #document: unknown;
  #generation = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>${STYLE}</style><div class="root" part="root"></div>`;
      this.#root = shadow.querySelector('.root') as HTMLDivElement;
    }
    this.#mount();
  }

  disconnectedCallback(): void {
    this.#unmount();
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null): void {
    if (previous === value || !this.isConnected || !this.#root) return;
    if (name === 'theme' || name === 'ui') {
      this.#whenReady((embed) => embed.send({ action: 'configure', theme: this.#theme(), ui: this.#ui() }));
    } else if (name === 'view') {
      if (value) this.#whenReady((embed) => embed.setView(value));
    } else {
      this.#mount(); // src, manifest, module, lang, readonly, autosave: cambia la instancia o su modo (el idioma viaja en la dirección: hay que volver a abrir el iframe)
    }
  }

  /** Documento del módulo (objeto o texto JSON). Al asignarlo con el widget abierto, se carga. */
  get document(): unknown {
    return this.#document;
  }
  set document(value: unknown) {
    this.#document = value;
    this.#whenReady((embed) => void embed.load(value as Record<string, unknown> | string | undefined, { module: this.getAttribute('module') ?? undefined, viewId: this.getAttribute('view') ?? undefined }).catch(() => undefined));
  }

  /** Se resuelve con el SDK subyacente cuando el widget ha mostrado el handshake; permite usar toda su API. */
  get embed(): Promise<IarkModuleEmbed> {
    return this.#ready ?? Promise.reject(new Error('<iark-module> no está conectado al documento.'));
  }

  export(format: string, viewId?: string): Promise<string> {
    return this.embed.then((e) => e.export(format, viewId));
  }
  validate(): ReturnType<IarkModuleEmbed['validate']> {
    return this.embed.then((e) => e.validate());
  }
  run(command: string, options?: Parameters<IarkModuleEmbed['run']>[1]): ReturnType<IarkModuleEmbed['run']> {
    return this.embed.then((e) => e.run(command, options));
  }
  capabilities(modules?: string[]): Promise<SuiteCapabilitiesInfo> {
    return this.embed.then((e) => e.capabilities(modules));
  }
  setView(viewId: string): Promise<void> {
    return this.embed.then((e) => e.setView(viewId));
  }
  save(exit = false): Promise<void> {
    return this.embed.then((e) => e.save(exit));
  }

  /** Ejecuta `action` cuando el widget está listo; si no llegó a montarse (error), ya se avisó con `iark-error`. */
  #whenReady(action: (embed: IarkModuleEmbed) => void): void {
    this.#ready?.then(action, () => undefined);
  }

  #theme(): 'light' | 'dark' | undefined {
    const value = this.getAttribute('theme');
    return value === 'light' || value === 'dark' ? value : undefined;
  }
  #ui(): 'full' | 'min' | undefined {
    const value = this.getAttribute('ui');
    return value === 'full' || value === 'min' ? value : undefined;
  }

  #emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  #fail(message: string): void {
    if (this.#root) this.#root.innerHTML = `<div class="message" role="alert"></div>`;
    const box = this.#root?.querySelector('.message');
    if (box) box.textContent = message;
    this.#emit(EVENT_NAMES.error, { message });
  }

  /** URL del editor del módulo: `src` tal cual, o la que anuncia el manifiesto de la instancia (en ambos casos, solo http o https). */
  async #resolveUrl(): Promise<string> {
    const src = this.getAttribute('src');
    if (src) return resolveEndpointUrl(src, document.baseURI, 'El atributo "src"');
    const manifest = this.getAttribute('manifest');
    const module = this.getAttribute('module');
    if (!manifest) throw new Error('<iark-module> necesita el atributo "src" (URL del banco de trabajo) o "manifest" (URL de /.well-known/iark.json).');
    if (!module) throw new Error('<iark-module manifest="…"> necesita el atributo "module".');
    const manifestUrl = new URL(manifest, document.baseURI).toString();
    let response: Response;
    try {
      response = await fetch(manifestUrl, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw new Error(`No se pudo leer el manifiesto ${manifestUrl}: ${(error as Error).message}. Si la instancia es de otro origen, debe permitir CORS.`);
    }
    if (!response.ok) throw new Error(`El manifiesto ${manifestUrl} respondió ${response.status}.`);
    // Valida lo imprescindible, busca el módulo y resuelve su editor aceptando solo http(s) (comparte código con el shell).
    return embedUrlFromManifest(await response.json().catch(() => undefined), manifestUrl, module);
  }

  #mount(): void {
    this.#unmount();
    const root = this.#root;
    if (!root) return;
    const generation = ++this.#generation;
    this.#ready = (async () => {
      const url = await this.#resolveUrl();
      if (generation !== this.#generation) throw new Error('reemplazado');
      const module = this.getAttribute('module') ?? undefined;
      const embed = createIarkModuleEmbed({
        container: root,
        url,
        module,
        document: this.#document as Record<string, unknown> | string | undefined,
        autosave: this.hasAttribute('autosave'),
        readOnly: this.hasAttribute('readonly'),
        theme: this.#theme(),
        ui: this.#ui(),
        lang: this.getAttribute('lang') ?? undefined,
        viewId: this.getAttribute('view') ?? undefined,
        title: this.getAttribute('title') ?? undefined,
        onEvent: (event: ModuleEvent) => {
          if (event.event === 'init') this.#emit(EVENT_NAMES.init, event.capabilities);
          else if (event.event === 'load') this.#emit(EVENT_NAMES.load, { module: event.module, document: event.document, viewId: event.viewId, issues: event.issues, warnings: event.warnings });
          else if (event.event === 'change' || event.event === 'autosave') this.#emit(EVENT_NAMES.change, { module: event.module, document: event.document, issues: event.issues, autosave: event.event === 'autosave' });
          else if (event.event === 'viewChange') this.#emit(EVENT_NAMES.viewChange, { module: event.module, viewId: event.viewId, title: event.title });
          else if (event.event === 'save') this.#emit(EVENT_NAMES.save, { module: event.module, document: event.document, exit: event.exit });
          else if (event.event === 'exit') this.#emit(EVENT_NAMES.exit, { modified: event.modified });
          else if (event.event === 'result') this.#emit(EVENT_NAMES.result, { module: event.module, command: event.command, kind: event.kind, output: event.output, warnings: event.warnings });
          else if (event.event === 'error') this.#emit(EVENT_NAMES.error, { message: event.message, issues: event.issues, ...(event.code ? { code: event.code } : {}) });
        },
      });
      this.#embed = embed;
      return embed;
    })();
    this.#ready.catch((error: Error) => {
      if (generation === this.#generation && error.message !== 'reemplazado') this.#fail(error.message);
    });
  }

  #unmount(): void {
    this.#generation += 1;
    this.#embed?.destroy();
    this.#embed = undefined;
    this.#ready = undefined;
    if (this.#root) this.#root.replaceChildren();
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('iark-module')) {
  customElements.define('iark-module', IarkModuleElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'iark-module': IarkModuleElement;
  }
}
