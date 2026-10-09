import {
  MODULE_PROTOCOL_VERSION,
  parseModuleAction,
  type ModuleAction,
  type ModuleEvent,
  type ModuleIssueInfo,
  type SuiteCapabilitiesInfo,
} from '../embed/moduleProtocol';
import { InvalidDocumentError, type WorkbenchController } from './controller';
import { viewTitle, type Analysis } from '@iark/kernel';
import { INCOMPATIBLE_PROTOCOL_CODE, negotiateProtocol } from '@iark/kernel/protocol';

export interface BridgeOptions {
  controller: WorkbenchController;
  /** Envía un evento al anfitrión. */
  post(event: ModuleEvent): void;
  /** Módulo que abrió la URL (`?module=`). */
  module?: string;
  /** Pide al anfitrión los ajustes de presentación antes del `load` (`?configure=1`). */
  configure?: boolean;
  /** Retraso de `change`/`autosave` tras una edición. */
  changeDelay?: number;
  onConfigure?(config: { theme?: 'light' | 'dark'; ui?: 'full' | 'min' }): void;
  onDialog?(dialog: { title: string; message: string; button?: string }): void;
}

/** Heurística para no confundir ruido de terceros con un intento (aunque roto) de hablar el protocolo. */
export function looksAddressedToUs(data: unknown): boolean {
  if (data && typeof data === 'object') return true;
  return typeof data === 'string' && data.trim().startsWith('{');
}

export function issueInfos(analysis: Analysis): ModuleIssueInfo[] {
  return analysis.status === 'ok' ? analysis.issues.map((i) => ({ severity: i.severity, message: i.message, ...(i.elementId ? { elementId: i.elementId } : {}) })) : [];
}

/**
 * Lado «iframe» del protocolo de módulos: traduce las acciones del anfitrión a operaciones del banco de trabajo y sus
 * cambios a eventos. Es independiente de React y del `window`: quien lo monta le da `post` y le pasa lo que llega.
 */
export function createModuleBridge(options: BridgeOptions) {
  const { controller, post } = options;
  let autosave = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAnalysis = controller.getState().analysis;
  let lastViewId = controller.getState().viewId;
  let disposed = false;
  // Mensaje del último apretón de manos rechazado: mientras dure, ninguna orden se aplica (el anfitrión habla un protocolo que no entendemos).
  let incompatible: string | undefined;

  const moduleId = (): string => controller.getState().moduleId ?? options.module ?? '';

  const capabilities = async (ids?: string[]): Promise<SuiteCapabilitiesInfo> => (await controller.capabilities(ids)) as SuiteCapabilitiesInfo;

  const fail = (error: unknown, requestId?: string): void => {
    const issues = error instanceof InvalidDocumentError && error.issues.length > 0 ? error.issues : undefined;
    post({ event: 'error', message: (error as Error).message, ...(issues ? { issues } : {}), ...(requestId ? { requestId } : {}) });
  };

  const currentDocument = (): unknown => {
    const { analysis } = controller.getState();
    if (analysis.status !== 'ok') throw new InvalidDocumentError('El documento actual no es válido: corrija los problemas antes de continuar.', analysis.status === 'schema' ? analysis.issues : []);
    return analysis.document;
  };

  async function handle(action: ModuleAction): Promise<void> {
    switch (action.action) {
      case 'load': {
        const id = action.module ?? controller.getState().moduleId ?? options.module;
        if (!id) throw new Error('Indica el módulo que se abre: {"action":"load","module":"data",…} o ?module= en la URL.');
        autosave = !!action.autosave;
        if (action.theme) options.onConfigure?.({ theme: action.theme });
        let warnings: string[] | undefined;
        if (action.document === undefined) {
          await controller.selectModule(id, { text: '' });
        } else if (action.importer !== undefined) {
          if (typeof action.document !== 'string') throw new Error('Con "importer", "document" debe ser el texto en ese formato.');
          await controller.selectModule(id, { text: '' });
          warnings = (await controller.importFrom(action.document, action.importer)).warnings;
        } else {
          await controller.loadDocument(action.document, { module: id, viewId: action.viewId, strict: true });
        }
        if (action.viewId && !controller.setView(action.viewId)) post({ event: 'error', message: `La vista "${action.viewId}" no existe` });
        controller.setReadOnly(!!action.readOnly);
        controller.markSaved();
        const state = controller.getState();
        lastAnalysis = state.analysis;
        lastViewId = state.viewId;
        post({
          event: 'load',
          module: id,
          document: state.analysis.status === 'ok' ? state.analysis.document : null,
          ...(state.viewId ? { viewId: state.viewId } : {}),
          issues: issueInfos(state.analysis),
          ...(warnings ? { warnings } : {}),
        });
        break;
      }
      case 'configure':
        options.onConfigure?.({ theme: action.theme, ui: action.ui });
        break;
      case 'setView':
        if (!controller.setView(action.viewId)) throw new Error(`La vista "${action.viewId}" no existe`);
        break;
      case 'export': {
        const file = await controller.exportAs(action.format, action.viewId);
        const viewId = action.viewId ?? controller.getState().viewId;
        post({
          event: 'export',
          module: moduleId(),
          format: action.format,
          data: file.data,
          mime: file.mime,
          extension: file.extension,
          ...(viewId ? { viewId } : {}),
          ...(action.requestId ? { requestId: action.requestId } : {}),
        });
        break;
      }
      case 'validate': {
        const { analysis } = controller.getState();
        post({
          event: 'issues',
          module: moduleId(),
          valid: analysis.status === 'ok',
          schemaIssues: analysis.status === 'schema' ? analysis.issues : analysis.status === 'syntax' ? [{ path: '(raíz)', message: analysis.error }] : [],
          issues: issueInfos(analysis),
          ...(action.requestId ? { requestId: action.requestId } : {}),
        });
        break;
      }
      case 'run': {
        const input = action.input === undefined ? undefined : typeof action.input === 'string' ? action.input : JSON.stringify(action.input);
        const result = await controller.run(action.command, { args: action.args, options: action.options, input });
        post({ event: 'result', module: moduleId(), ...result, ...(action.requestId ? { requestId: action.requestId } : {}) });
        break;
      }
      case 'capabilities':
        post({ event: 'capabilities', capabilities: await capabilities(action.modules), ...(action.requestId ? { requestId: action.requestId } : {}) });
        break;
      case 'status':
        controller.setStatus(action.message, action.modified);
        break;
      case 'dialog':
        options.onDialog?.({ title: action.title, message: action.message, button: action.button });
        break;
      case 'save': {
        const document = currentDocument();
        controller.markSaved();
        post({ event: 'save', module: moduleId(), document, exit: !!action.exit });
        if (action.exit) post({ event: 'exit', modified: false });
        break;
      }
      case 'exit':
        post({ event: 'exit', modified: controller.getState().modified });
        break;
    }
  }

  /** Procesa lo que llega por `message`. Un mensaje mal formado que parece dirigido al protocolo recibe un `error`. */
  async function receive(data: unknown): Promise<void> {
    const parsed = parseModuleAction(data);
    if (!parsed.ok) {
      if (looksAddressedToUs(data)) post({ event: 'error', message: parsed.error });
      return;
    }
    const requestId = 'requestId' in parsed.action ? parsed.action.requestId : undefined;
    if (parsed.action.action === 'load') {
      // El `load` del anfitrión lleva la versión de su protocolo (sin ella, 1.0): una diferencia de mayor se avisa en vez de funcionar a medias.
      const negotiation = negotiateProtocol(MODULE_PROTOCOL_VERSION, parsed.action.version);
      incompatible = negotiation.ok ? undefined : negotiation.message;
    }
    if (incompatible && parsed.action.action !== 'exit') {
      post({ event: 'error', code: INCOMPATIBLE_PROTOCOL_CODE, message: incompatible, ...(requestId ? { requestId } : {}) });
      return;
    }
    try {
      await handle(parsed.action);
    } catch (error) {
      fail(error, requestId);
    }
  }

  const unsubscribe = controller.subscribe(() => {
    if (disposed) return;
    const state = controller.getState();
    if (state.viewId && state.viewId !== lastViewId && state.module) {
      lastViewId = state.viewId;
      post({ event: 'viewChange', module: state.module.id, viewId: state.viewId, title: viewTitle(state.choices, state.viewId) });
    }
    if (state.analysis === lastAnalysis) return;
    lastAnalysis = state.analysis;
    if (!state.modified || state.analysis.status !== 'ok' || !state.module) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const current = controller.getState();
      if (current.analysis.status !== 'ok' || !current.module) return;
      const payload = { module: current.module.id, document: current.analysis.document, issues: issueInfos(current.analysis) };
      post({ event: 'change', ...payload });
      if (autosave) post({ event: 'autosave', ...payload });
    }, options.changeDelay ?? 500);
  });

  /** Anuncia la instancia al anfitrión: `init` con las capacidades (y `configure` antes, si se pidió). */
  async function start(): Promise<void> {
    if (options.configure) post({ event: 'configure' });
    if (options.module) await controller.selectModule(options.module, { text: '' });
    post({
      event: 'init',
      version: MODULE_PROTOCOL_VERSION,
      ...(options.module ? { module: options.module } : {}),
      capabilities: await capabilities(options.module ? [options.module] : []),
    });
  }

  function dispose(): void {
    disposed = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
  }

  return { receive, start, dispose };
}

export type ModuleBridge = ReturnType<typeof createModuleBridge>;
