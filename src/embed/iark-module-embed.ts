import { resolveEndpointUrl } from '@iark/kernel/endpoint';
import { EMBED_PROTOCOL_VERSION, INCOMPATIBLE_PROTOCOL_CODE, negotiateProtocol } from '@iark/kernel/protocol';
import type {
  ModuleAction,
  ModuleCapabilitiesInfo,
  ModuleEvent,
  ModuleExportEvent,
  ModuleIssueInfo,
  ModuleIssuesEvent,
  ModuleLoadEvent,
  ModuleResultEvent,
  SuiteCapabilitiesInfo,
} from './moduleProtocol';

export type { ModuleAction, ModuleCapabilitiesInfo, ModuleEvent, ModuleIssueInfo, SuiteCapabilitiesInfo };

/**
 * SDK de anfitrión para los módulos de la suite (integración, datos, empresarial, plataforma, seguridad…): crea un iframe
 * con el banco de trabajo del módulo y gestiona el protocolo postMessage (`init` con las capacidades → `load`, eventos y
 * acciones con respuesta por `requestId`). Es el hermano de `createIarkEmbed` (editor C4).
 *
 *   const embed = createIarkModuleEmbed({ container: '#panel', url: 'https://mi-host/diagramador/modulos.html', module: 'security',
 *     document, onChange: ({ document }) => guardar(document) });
 *   const svg = await embed.export('svg', 'blast:pedidos');
 *   const { output } = await embed.run('risks', { options: { status: 'open' } });
 */
export interface IarkModuleEmbedOptions<TDoc = unknown> {
  /** Elemento (o selector) donde insertar el iframe. */
  container: HTMLElement | string;
  /** URL del banco de trabajo (`modulos.html`), o el `endpoints.embed` de un manifiesto. */
  url: string;
  /** Módulo que se abre. Si se omite, se indica en `load({ module })`. */
  module?: string;
  /** Documento inicial (objeto o JSON). Con `importer`, el texto en ese otro formato. Si se omite, se abre en blanco. */
  document?: TDoc | string;
  importer?: string;
  autosave?: boolean;
  readOnly?: boolean;
  theme?: 'light' | 'dark';
  ui?: 'full' | 'min';
  viewId?: string;
  /** Origen esperado del iframe (targetOrigin). Por defecto se deduce de `url`. */
  origin?: string;
  /** Título accesible del iframe. */
  title?: string;
  iframeAttributes?: Record<string, string>;
  /** Tiempo máximo (ms) que esperan las acciones con respuesta antes de rechazar. Por defecto 15000. */
  responseTimeout?: number;
  onInit?: (capabilities: SuiteCapabilitiesInfo) => void;
  onLoad?: (payload: { module: string; document: TDoc | null; viewId?: string; issues: ModuleIssueInfo[]; warnings?: string[] }) => void;
  /** El documento cambió (válido): edición de la persona o `merge`; llega tras una pausa de 500 ms. */
  onChange?: (payload: { module: string; document: TDoc; issues: ModuleIssueInfo[] }) => void;
  onViewChange?: (payload: { module: string; viewId: string; title?: string }) => void;
  onSave?: (payload: { module: string; document: TDoc; exit: boolean }) => void;
  onExit?: (payload: { modified: boolean }) => void;
  onExport?: (payload: { module: string; format: string; data: string; mime: string; extension: string; viewId?: string }) => void;
  onResult?: (payload: { module: string; command: string; kind: 'report' | 'convert'; output: string; warnings: string[] }) => void;
  /** `code` está si el error es de una clase que el anfitrión puede tratar: `incompatible-protocol` (la versión mayor del protocolo difiere con la del iframe). */
  onError?: (payload: { message: string; issues?: Array<{ path: string; message: string }>; code?: string }) => void;
  /** Recibe todos los eventos del iframe. */
  onEvent?: (event: ModuleEvent) => void;
}

export interface IarkModuleEmbed<TDoc = unknown> {
  iframe: HTMLIFrameElement;
  /** Se resuelve con las capacidades de la instancia en cuanto el banco de trabajo responde al handshake; se rechaza si su protocolo es incompatible. */
  initialized: Promise<SuiteCapabilitiesInfo>;
  /** Se resuelve cuando se ha cargado el documento inicial; se rechaza si el protocolo del banco de trabajo es incompatible. */
  ready: Promise<void>;
  /** Abre un documento (y, si hace falta, el módulo). Resuelve con lo que devolvió el banco de trabajo. */
  load(document?: TDoc | string, options?: { module?: string; importer?: string; viewId?: string; autosave?: boolean; readOnly?: boolean }): Promise<ModuleLoadEvent>;
  /** Exporta a `json` o a un formato del módulo (`capabilities`): `mermaid`, `svg`, `drawio`… */
  export(format: string, viewId?: string): Promise<string>;
  /** Problemas del documento abierto: esquema y reglas del dominio. */
  validate(): Promise<Omit<ModuleIssuesEvent, 'event' | 'requestId'>>;
  /** Informe o conversión del módulo (los de `iark <módulo> <comando>`). */
  run(command: string, options?: { args?: string[]; options?: Record<string, string | boolean>; input?: TDoc | string }): Promise<Omit<ModuleResultEvent, 'event' | 'requestId'>>;
  /** Capacidades de los módulos pedidos (por defecto, todos los de la instancia). */
  capabilities(modules?: string[]): Promise<SuiteCapabilitiesInfo>;
  setView(viewId: string): void;
  status(message: string, modified?: boolean): void;
  dialog(title: string, message: string, button?: string): void;
  /** Pide al banco de trabajo que emita `save` (y `exit` si se indica). */
  save(exit?: boolean): void;
  send(action: ModuleAction): void;
  destroy(): void;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export function createIarkModuleEmbed<TDoc = unknown>(options: IarkModuleEmbedOptions<TDoc>): IarkModuleEmbed<TDoc> {
  const container = typeof options.container === 'string' ? document.querySelector<HTMLElement>(options.container) : options.container;
  if (!container) throw new Error('createIarkModuleEmbed: no se encontró el contenedor');

  // Solo http(s): un `javascript:`/`data:` como `iframe.src` se ejecutaría en el origen del anfitrión (ver `resolveEndpointUrl`).
  const url = new URL(resolveEndpointUrl(options.url, window.location.href, 'La URL del módulo embebido'));
  url.searchParams.set('embed', '1');
  url.searchParams.set('proto', 'json');
  url.searchParams.set('origin', window.location.origin);
  if (options.module) url.searchParams.set('module', options.module);
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

  const responseTimeout = options.responseTimeout ?? 15000;
  const pending = new Map<string, Pending>();
  const loads: Pending[] = [];
  let counter = 0;
  let initialised = false;
  let queue: ModuleAction[] = [];
  /** Se fija si el protocolo del banco de trabajo es incompatible con el de este SDK (versión mayor distinta): ya no se habla con él. */
  let incompatible: Error | undefined;

  let resolveInit!: (c: SuiteCapabilitiesInfo) => void;
  let rejectInit!: (error: Error) => void;
  const initialized = new Promise<SuiteCapabilitiesInfo>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Un protocolo incompatible los rechaza; quien no los espera no debe ver un «unhandled rejection» (ya se avisó por `onError`).
  initialized.catch(() => undefined);
  ready.catch(() => undefined);

  // Todo `load` lleva la versión del protocolo que habla este SDK: así el iframe puede comprobarla (ver `negotiateProtocol`).
  const post = (action: ModuleAction): void => {
    const stamped = action.action === 'load' && action.version === undefined ? { ...action, version: EMBED_PROTOCOL_VERSION } : action;
    iframe.contentWindow?.postMessage(JSON.stringify(stamped), targetOrigin);
  };
  /** Las acciones anteriores al `init` esperan: el iframe aún no escucha. */
  const send = (action: ModuleAction): void => {
    if (incompatible) return;
    if (initialised) post(action);
    else queue.push(action);
  };

  function withTimeout<T>(promise: Promise<T>, onTimeout: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`El módulo embebido no respondió en ${responseTimeout}ms`));
      }, responseTimeout);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Acción con respuesta correlacionada por `requestId`. */
  function request<R>(build: (requestId: string) => ModuleAction): Promise<R> {
    if (incompatible) return Promise.reject(incompatible);
    const requestId = `req-${++counter}`;
    const promise = new Promise<R>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      send(build(requestId));
    });
    return withTimeout(promise, () => pending.delete(requestId));
  }

  const settle = (requestId: string | undefined, value: unknown): void => {
    const entry = requestId ? pending.get(requestId) : undefined;
    if (entry && requestId) {
      pending.delete(requestId);
      entry.resolve(value);
    }
  };

  /** El protocolo del banco de trabajo no es compatible con el nuestro: se rechaza todo lo que esperaba respuesta y se deja de hablar con él. */
  const refuse = (message: string): void => {
    incompatible = new Error(message);
    queue = [];
    rejectInit(incompatible);
    rejectReady(incompatible);
    for (const entry of pending.values()) entry.reject(incompatible);
    pending.clear();
    loads.splice(0).forEach((l) => l.reject(incompatible!));
  };

  const listener = (event: MessageEvent): void => {
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
      const looksAddressedToUs = parseFailed ? (event.data as string).trim().startsWith('{') : !!data && typeof data === 'object';
      if (looksAddressedToUs) options.onError?.({ message: 'Mensaje recibido del módulo embebido no reconocido' });
      return;
    }
    const msg = data as ModuleEvent;
    options.onEvent?.(msg);
    switch (msg.event) {
      case 'init': {
        // Una diferencia de versión MAYOR del protocolo no se resuelve a medias: se avisa y no se carga nada. Sin versión, 1.0.
        const negotiation = negotiateProtocol(EMBED_PROTOCOL_VERSION, msg.version);
        if (!negotiation.ok) {
          refuse(negotiation.message);
          // Como si lo hubiera enviado el iframe: quien escucha `onEvent` (el Web Component) lo recibe igual que un `error` de verdad.
          options.onEvent?.({ event: 'error', message: negotiation.message, code: INCOMPATIBLE_PROTOCOL_CODE });
          options.onError?.({ message: negotiation.message, code: INCOMPATIBLE_PROTOCOL_CODE });
          break;
        }
        initialised = true;
        resolveInit(msg.capabilities);
        options.onInit?.(msg.capabilities);
        const moduleId = options.module ?? msg.module;
        if (moduleId) {
          post({
            action: 'load',
            module: moduleId,
            document: options.document as Record<string, unknown> | string | undefined,
            importer: options.importer,
            autosave: options.autosave,
            readOnly: options.readOnly,
            theme: options.theme,
            viewId: options.viewId,
          });
        }
        const queued = queue;
        queue = [];
        for (const action of queued) post(action);
        break;
      }
      case 'load':
        resolveReady();
        loads.splice(0).forEach((p) => p.resolve(msg));
        options.onLoad?.({ module: msg.module, document: msg.document as TDoc | null, viewId: msg.viewId, issues: msg.issues, warnings: msg.warnings });
        break;
      case 'change':
      case 'autosave':
        options.onChange?.({ module: msg.module, document: msg.document as TDoc, issues: msg.issues });
        break;
      case 'viewChange':
        options.onViewChange?.({ module: msg.module, viewId: msg.viewId, title: msg.title });
        break;
      case 'save':
        options.onSave?.({ module: msg.module, document: msg.document as TDoc, exit: msg.exit });
        break;
      case 'exit':
        options.onExit?.({ modified: msg.modified });
        break;
      case 'export': {
        settle(msg.requestId, msg satisfies ModuleExportEvent);
        options.onExport?.({ module: msg.module, format: msg.format, data: msg.data, mime: msg.mime, extension: msg.extension, viewId: msg.viewId });
        break;
      }
      case 'issues':
        settle(msg.requestId, msg);
        break;
      case 'result':
        settle(msg.requestId, msg);
        options.onResult?.({ module: msg.module, command: msg.command, kind: msg.kind, output: msg.output, warnings: msg.warnings });
        break;
      case 'capabilities':
        settle(msg.requestId, msg.capabilities);
        break;
      case 'error': {
        // El banco de trabajo también compara versiones: si rechazó la nuestra, nada de lo que esperamos llegará nunca.
        if (msg.code === INCOMPATIBLE_PROTOCOL_CODE) refuse(msg.message);
        const entry = msg.requestId ? pending.get(msg.requestId) : undefined;
        if (entry && msg.requestId) {
          pending.delete(msg.requestId);
          entry.reject(new Error(msg.message));
        } else {
          loads.splice(0).forEach((l) => l.reject(new Error(msg.message)));
        }
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
    initialized,
    ready,
    load(doc, opts = {}) {
      if (incompatible) return Promise.reject(incompatible);
      const entry: Pending = { resolve: () => {}, reject: () => {} };
      const promise = new Promise<ModuleLoadEvent>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
        loads.push(entry);
        send({ action: 'load', document: doc as Record<string, unknown> | string | undefined, ...opts });
      });
      return withTimeout(promise, () => {
        const i = loads.indexOf(entry);
        if (i >= 0) loads.splice(i, 1);
      });
    },
    async export(format, viewId) {
      const event = await request<ModuleExportEvent>((requestId) => ({ action: 'export', format, viewId, requestId }));
      return event.data;
    },
    async validate() {
      const { event: _event, requestId: _requestId, ...rest } = await request<ModuleIssuesEvent>((requestId) => ({ action: 'validate', requestId }));
      return rest;
    },
    async run(command, opts = {}) {
      const { event: _event, requestId: _requestId, ...rest } = await request<ModuleResultEvent>((requestId) => ({
        action: 'run',
        command,
        args: opts.args,
        options: opts.options,
        input: opts.input as Record<string, unknown> | string | undefined,
        requestId,
      }));
      return rest;
    },
    capabilities(modules) {
      return request<SuiteCapabilitiesInfo>((requestId) => ({ action: 'capabilities', modules, requestId }));
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

export default createIarkModuleEmbed;
