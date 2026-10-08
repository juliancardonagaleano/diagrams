import { resolveEndpointUrl } from '@iark/kernel/endpoint';
import { EMBED_PROTOCOL_VERSION, INCOMPATIBLE_PROTOCOL_CODE, negotiateProtocol } from '@iark/kernel/protocol';
import type { C4Document, LayoutDirection } from '@core/model/types';
import type { EmbedEvent, ExportFormat, HostAction, LoadAction } from './protocol';

export type { EmbedEvent, ExportFormat, HostAction, C4Document };

// SDK de los demás módulos de la suite (integración, datos, empresarial, plataforma, seguridad…): mismo paquete y mismo global.
export { createIarkModuleEmbed } from './iark-module-embed';
export type { IarkModuleEmbed, IarkModuleEmbedOptions, ModuleAction, ModuleCapabilitiesInfo, ModuleEvent, ModuleIssueInfo, SuiteCapabilitiesInfo } from './iark-module-embed';

/**
 * SDK de anfitrión: crea un iframe con IArk - DIAgrams en modo embebido y
 * gestiona el protocolo postMessage (handshake `init` → `load`, eventos, acciones).
 *
 *   const embed = createIarkEmbed({ container: '#editor', url: 'https://mi-host/diagramador/', document, autosave: true,
 *     onSave: ({ document, drawio }) => guardar(document), onExit: () => cerrar() });
 *   const xml = await embed.export('drawio');
 */
export interface IarkEmbedOptions {
  /** Elemento (o selector) donde insertar el iframe. */
  container: HTMLElement | string;
  /** URL de la app de IArk - DIAgrams (se le añaden `embed=1&proto=json`). */
  url: string;
  /** Documento inicial (objeto o JSON). Si se omite, se abre en blanco. */
  document?: C4Document | string;
  autosave?: boolean;
  title?: string;
  readOnly?: boolean;
  theme?: 'light' | 'dark';
  ui?: 'full' | 'min';
  hideSidePanel?: boolean;
  /** Ejecutar autolayout al cargar. */
  autoLayout?: boolean;
  /** Origen esperado del iframe (targetOrigin). Por defecto se deduce de `url`. */
  origin?: string;
  /** Atributos extra del iframe (por ejemplo `title`, `allow`). */
  iframeAttributes?: Record<string, string>;
  /** Tiempo máximo (ms) que esperan `load()`/`export()` antes de rechazar. Por defecto 15000. */
  responseTimeout?: number;
  onInit?: () => void;
  onLoad?: (payload: { document: C4Document; viewId?: string }) => void;
  onChange?: (document: C4Document) => void;
  onSave?: (payload: { document: C4Document; drawio?: string; exit: boolean }) => void;
  onExit?: (payload: { modified: boolean }) => void;
  onExport?: (payload: { format: ExportFormat; data: string; viewId?: string }) => void;
  /** El usuario navegó a otra vista (C1/C2/C3), por doble clic, breadcrumb o `setView`. */
  onViewChange?: (payload: { viewId: string; level: 'C1' | 'C2' | 'C3'; scopeId?: string; title?: string }) => void;
  /** `code` está si el error es de una clase que el anfitrión puede tratar: `incompatible-protocol` (la versión mayor del protocolo difiere con la del iframe). */
  onError?: (payload: { message: string; issues?: Array<{ path: string; message: string }>; code?: string }) => void;
  /** Recibe todos los eventos del iframe. */
  onEvent?: (event: EmbedEvent) => void;
}

export interface IarkEmbed {
  iframe: HTMLIFrameElement;
  /** Promesa que se resuelve cuando IArk - DIAgrams ha cargado el documento inicial; se rechaza si el protocolo del iframe es incompatible. */
  ready: Promise<void>;
  load(document?: C4Document | string, options?: Omit<LoadAction, 'action' | 'document' | 'version'>): Promise<C4Document>;
  merge(document: C4Document | string, autoLayout?: boolean): void;
  /** Exporta; para `drawio`, `notation` elige entre la librería C4 de draw.io ('c4', por defecto) y tarjetas ('card'). */
  export(format: ExportFormat, viewId?: string, notation?: 'c4' | 'card'): Promise<string>;
  /** Ejecuta el autolayout; `direction: 'auto'` aplica la prioridad por nivel (C1 ↓, C2/C3 →). */
  autoLayout(options?: { viewId?: string; direction?: LayoutDirection | 'auto'; distribution?: 'auto' | 'centered' | 'elk'; force?: boolean }): void;
  setView(viewId: string): void;
  status(message: string, modified?: boolean): void;
  dialog(title: string, message: string, button?: string): void;
  /** Pide al diagramador que emita `save` (y `exit` si se indica). */
  save(exit?: boolean): void;
  send(action: HostAction): void;
  destroy(): void;
}

export function createIarkEmbed(options: IarkEmbedOptions): IarkEmbed {
  const container =
    typeof options.container === 'string' ? document.querySelector<HTMLElement>(options.container) : options.container;
  if (!container) throw new Error('createIarkEmbed: no se encontró el contenedor');

  // Solo http(s): un `javascript:`/`data:` como `iframe.src` se ejecutaría en el origen del anfitrión (ver `resolveEndpointUrl`).
  const url = new URL(resolveEndpointUrl(options.url, window.location.href, 'La URL del editor embebido'));
  url.searchParams.set('embed', '1');
  url.searchParams.set('proto', 'json');
  url.searchParams.set('origin', window.location.origin);
  if (options.ui) url.searchParams.set('ui', options.ui);
  if (options.theme) url.searchParams.set('theme', options.theme);
  const targetOrigin = options.origin ?? url.origin;

  const iframe = document.createElement('iframe');
  iframe.src = url.toString();
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.setAttribute('title', options.title ?? 'IArk - DIAgrams');
  for (const [k, v] of Object.entries(options.iframeAttributes ?? {})) iframe.setAttribute(k, v);
  container.appendChild(iframe);

  // Todo `load` lleva la versión del protocolo que habla este SDK: así el iframe puede comprobarla (ver `negotiateProtocol`).
  const send = (action: HostAction) => {
    const stamped = action.action === 'load' && action.version === undefined ? { ...action, version: EMBED_PROTOCOL_VERSION } : action;
    iframe.contentWindow?.postMessage(JSON.stringify(stamped), targetOrigin);
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Un protocolo incompatible rechaza `ready`; quien no lo espera no debe ver un «unhandled rejection» (ya se avisó por `onError`).
  ready.catch(() => undefined);

  const pendingExports = new Map<string, { resolve: (data: string) => void; reject: (e: Error) => void }>();
  const pendingLoads: Array<{ resolve: (doc: C4Document) => void; reject: (e: Error) => void }> = [];
  let counter = 0;
  const responseTimeout = options.responseTimeout ?? 15000;

  /** Rechaza `promise` si no se resuelve en `responseTimeout` ms, limpiando `onTimeout`. */
  function withTimeout<T>(promise: Promise<T>, onTimeout: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`El diagramador embebido no respondió en ${responseTimeout}ms`));
      }, responseTimeout);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  const initialLoad = (): HostAction => ({
    action: 'load',
    document: options.document,
    autosave: options.autosave,
    title: options.title,
    readOnly: options.readOnly,
    theme: options.theme,
    autoLayout: options.autoLayout,
  });

  const listener = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (targetOrigin !== '*' && event.origin !== targetOrigin) return;
    let data: unknown = event.data;
    let parseFailed = false;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        parseFailed = true;
      }
    }
    if (parseFailed || !data || typeof data !== 'object' || !('event' in data)) {
      // El diagramador embebido serializa sus eventos como JSON en string, así que un mensaje
      // con esa forma pero roto casi seguro viene de él (versión desalineada, bug); en vez de
      // descartarlo en silencio se avisa. El resto (ruido ajeno a nuestro protocolo) se ignora.
      const looksAddressedToUs = parseFailed ? (event.data as string).trim().startsWith('{') : !!data && typeof data === 'object';
      if (looksAddressedToUs) options.onError?.({ message: 'Mensaje recibido de IArk - DIAgrams embebido no reconocido' });
      return;
    }
    const msg = data as EmbedEvent;
    options.onEvent?.(msg);
    switch (msg.event) {
      case 'configure':
        send({
          action: 'configure',
          theme: options.theme,
          ui: options.ui,
          hideSidePanel: options.hideSidePanel,
        });
        break;
      case 'init': {
        // Una diferencia de versión MAYOR del protocolo no se resuelve a medias: se avisa y no se carga nada. Sin versión, 1.0.
        const negotiation = negotiateProtocol(EMBED_PROTOCOL_VERSION, msg.version);
        if (!negotiation.ok) {
          const error = new Error(negotiation.message);
          rejectReady(error);
          pendingLoads.splice(0).forEach((l) => l.reject(error));
          // Como si lo hubiera enviado el iframe: quien escucha `onEvent` (el Web Component) lo recibe igual que un `error` de verdad.
          options.onEvent?.({ event: 'error', message: negotiation.message, code: INCOMPATIBLE_PROTOCOL_CODE });
          options.onError?.({ message: negotiation.message, code: INCOMPATIBLE_PROTOCOL_CODE });
          break;
        }
        options.onInit?.();
        send(initialLoad());
        break;
      }
      case 'load':
        resolveReady();
        pendingLoads.splice(0).forEach((p) => p.resolve(msg.document));
        options.onLoad?.({ document: msg.document, viewId: msg.viewId });
        break;
      case 'change':
      case 'autosave':
        options.onChange?.(msg.document);
        break;
      case 'save':
        options.onSave?.({ document: msg.document, drawio: msg.drawio, exit: msg.exit });
        break;
      case 'viewChange':
        options.onViewChange?.({ viewId: msg.viewId, level: msg.level, scopeId: msg.scopeId, title: msg.title });
        break;
      case 'exit':
        options.onExit?.({ modified: msg.modified });
        break;
      case 'export': {
        const p = msg.requestId ? pendingExports.get(msg.requestId) : undefined;
        if (p && msg.requestId) {
          pendingExports.delete(msg.requestId);
          p.resolve(msg.data);
        }
        options.onExport?.({ format: msg.format, data: msg.data, viewId: msg.viewId });
        break;
      }
      case 'error': {
        const p = msg.requestId ? pendingExports.get(msg.requestId) : undefined;
        if (p && msg.requestId) {
          pendingExports.delete(msg.requestId);
          p.reject(new Error(msg.message));
        }
        pendingLoads.splice(0).forEach((l) => l.reject(new Error(msg.message)));
        // El iframe también compara versiones: si rechazó el nuestro, `ready` no llegará nunca.
        if (msg.code === INCOMPATIBLE_PROTOCOL_CODE) rejectReady(new Error(msg.message));
        options.onError?.({ message: msg.message, issues: msg.issues, ...(msg.code ? { code: msg.code } : {}) });
        break;
      }
      default:
        break;
    }
  };
  window.addEventListener('message', listener);

  return {
    iframe,
    ready,
    load(doc, opts = {}) {
      const entry: { resolve: (doc: C4Document) => void; reject: (e: Error) => void } = { resolve: () => {}, reject: () => {} };
      const promise = new Promise<C4Document>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
        pendingLoads.push(entry);
        send({ action: 'load', document: doc, ...opts });
      });
      return withTimeout(promise, () => {
        const i = pendingLoads.indexOf(entry);
        if (i >= 0) pendingLoads.splice(i, 1);
      });
    },
    merge(doc, autoLayout) {
      send({ action: 'merge', document: doc, autoLayout });
    },
    export(format, viewId, notation) {
      const requestId = `exp-${++counter}`;
      const promise = new Promise<string>((resolve, reject) => {
        pendingExports.set(requestId, { resolve, reject });
        send({ action: 'export', format, viewId, requestId, notation });
      });
      return withTimeout(promise, () => pendingExports.delete(requestId));
    },
    autoLayout(opts = {}) {
      send({ action: 'autoLayout', ...opts });
    },
    setView(viewId) {
      send({ action: 'setView', viewId });
    },
    status(message, modified) {
      send({ action: 'status', message, modified });
    },
    dialog(title, message, button) {
      send({ action: 'dialog', title, message, button });
    },
    save(exit = false) {
      send({ action: 'save', exit });
    },
    send,
    destroy() {
      window.removeEventListener('message', listener);
      iframe.remove();
    },
  };
}

/** @deprecated Nombre anterior (C4 Model); use `createIarkEmbed`. */
export const createC4Embed = createIarkEmbed;
/** @deprecated Nombre anterior (C4 Model); use `IarkEmbed`. */
export type C4Embed = IarkEmbed;
/** @deprecated Nombre anterior (C4 Model); use `IarkEmbedOptions`. */
export type C4EmbedOptions = IarkEmbedOptions;

export default createIarkEmbed;
