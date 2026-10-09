import {
  analyzeText,
  analyzeValue,
  EMBED_PROTOCOL_VERSION,
  exportDocument,
  importFiles as importSourceFiles,
  importText,
  isKnownView,
  moduleCapabilities,
  pretty,
  renderSvg,
  runCommand,
  viewChoices,
  canRender,
  type Analysis,
  type AnyModule,
  type CommandOutput,
  type CommandRun,
  type ExportedFile,
  type ImportResult,
  type DiagramMeta,
  type ModuleCapabilities,
  type SourceFile,
  type ViewChoices,
} from '@iark/kernel';
import type { ProjectSession } from '../projects/session';

/** Un módulo que el banco de trabajo sabe cargar (bajo demanda: cada especialidad es un trozo aparte del paquete). */
export interface ModuleSource {
  id: string;
  /** Nombre corto para la pestaña. */
  label: string;
  load(): Promise<AnyModule>;
  /** Documento de ejemplo (JSON) para empezar. */
  example?(): Promise<string>;
  /** Documento vacío pero válido, para un diagrama nuevo. Sin él, el diagrama empieza sin texto. */
  blank?(): Promise<string>;
}

/** Un documento del conjunto con el que se resuelven los enlaces: el borrador de un módulo o un diagrama del proyecto abierto. */
export interface SuiteDocument {
  moduleId: string;
  /** Solo en un proyecto: el diagrama que lo contiene. */
  diagramId?: string;
  label: string;
  text: string;
}

/** Borradores del editor entre sesiones (localStorage en la app; nada en modo embebido). */
export interface DraftStorage {
  read(moduleId: string): string | null;
  write(moduleId: string, text: string): void;
}

/** Lo que dejó la última importación (cualquier ruta: pestaña «Importar», «Abrir archivo…»…): el panel lo muestra hasta que cambie el documento. */
export interface ImportNotice {
  /** Id del importador que se usó (`terraform`, `mermaid`…). */
  importer: string;
  /** Nombre del archivo del que se importó, si lo hubo. */
  file?: string;
  warnings: string[];
}

export interface WorkbenchState {
  moduleId?: string;
  module?: AnyModule;
  loading: boolean;
  text: string;
  analysis: Analysis;
  choices: ViewChoices;
  viewId?: string;
  svg?: string;
  rendering: boolean;
  renderError?: string;
  readOnly: boolean;
  /** Hay cambios respecto a lo que cargó el anfitrión o al último guardado. */
  modified: boolean;
  /** Mensaje del anfitrión (acción `status`) o de la propia interfaz. */
  status?: string;
  error?: string;
  /** Avisos de la última importación; se limpia al editar el documento o al cargar/importar otra cosa. */
  lastImport?: ImportNotice;
  /** Lo que había antes de que una importación o un ejemplo reemplazara el diagrama guardado del proyecto, para poder deshacerlo. */
  replaced?: { text: string; label: string };
}

export interface SuiteCapabilities {
  protocol: string;
  suite: string;
  /** Todos los módulos que ofrece esta instancia (aunque no estén cargados). */
  available: string[];
  /** Capacidades de los módulos cargados o pedidos. */
  modules: ModuleCapabilities[];
}

export const EMPTY_CHOICES: ViewChoices = { views: [], traces: [] };

export interface LoadOptions {
  module?: string;
  viewId?: string;
  readOnly?: boolean;
  /** Rechazar (sin tocar el estado) un documento que no cumpla el esquema del módulo. */
  strict?: boolean;
}

export class InvalidDocumentError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'InvalidDocumentError';
  }
}

/**
 * Estado y operaciones del banco de trabajo, sin React: la interfaz se suscribe y el puente `postMessage` lo maneja con
 * las mismas operaciones, de modo que un anfitrión puede hacer exactamente lo que hace una persona.
 */
export class WorkbenchController {
  private state: WorkbenchState = {
    loading: false,
    text: '',
    analysis: { status: 'empty' },
    choices: EMPTY_CHOICES,
    rendering: false,
    readOnly: false,
    modified: false,
  };
  private listeners = new Set<() => void>();
  private loaded = new Map<string, AnyModule>();
  private renderToken = 0;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private selectToken = 0;
  /** Texto de los diagramas del proyecto que no están abiertos, por id y marca de modificación (para no releerlos). */
  private readonly diagramTexts = new Map<string, { updatedAt: string; text: string }>();

  constructor(
    readonly sources: ModuleSource[],
    private readonly options: { storage?: DraftStorage; suite?: string; protocol?: string; renderDelay?: number; projects?: ProjectSession } = {},
  ) {}

  /** Los proyectos guardados (solo en el banco de trabajo de la app; en modo embebido el anfitrión es quien guarda). */
  get projects(): ProjectSession | undefined {
    return this.options.projects;
  }

  // ───────────── suscripción ─────────────

  getState = (): WorkbenchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<WorkbenchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  get moduleIds(): string[] {
    return this.sources.map((s) => s.id);
  }

  private source(id: string): ModuleSource {
    const source = this.sources.find((s) => s.id === id);
    if (!source) throw new Error(`Este banco de trabajo no ofrece el módulo «${id}». Módulos: ${this.moduleIds.join(', ')}.`);
    return source;
  }

  async loadModule(id: string): Promise<AnyModule> {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const module = await this.source(id).load();
    if (module.id !== id) throw new Error(`El módulo cargado como «${id}» se declara «${module.id}».`);
    this.loaded.set(id, module);
    return module;
  }

  /** Texto con el que se abriría el módulo `id` ahora mismo: el activo, el borrador guardado o el ejemplo. */
  async draftText(id: string): Promise<string | undefined> {
    if (id === this.state.moduleId) return this.state.text;
    return this.options.storage?.read(id) ?? (await this.source(id).example?.());
  }

  // ───────────── módulo y documento ─────────────

  /**
   * Activa un módulo. Con `text` lo usa como contenido; si no, el borrador guardado o, la primera vez, el ejemplo del módulo.
   */
  async selectModule(id: string, initial?: { text?: string }): Promise<void> {
    if (id === this.state.moduleId && initial?.text === undefined) return;
    // Con un proyecto abierto, cambiar de módulo abre su diagrama más reciente; si no tiene ninguno, queda un borrador.
    const projects = this.options.projects;
    const project = projects?.project;
    if (projects && project && initial?.text === undefined) {
      const latest = project.diagrams.filter((d) => d.module === id).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
      if (latest) return this.openDiagram(project.id, latest.id);
      await projects.release();
    }
    const token = ++this.selectToken;
    this.set({ loading: true, error: undefined });
    try {
      const module = await this.loadModule(id);
      let text = initial?.text ?? this.options.storage?.read(id) ?? undefined;
      if (text === undefined) text = (await this.source(id).example?.()) ?? '';
      if (token !== this.selectToken) return;
      this.apply(module, text, { modified: false });
    } catch (error) {
      if (token === this.selectToken) this.set({ loading: false, error: (error as Error).message });
    }
  }

  /**
   * Aplica `text` como contenido del módulo `module` y recalcula todo lo derivado. Cualquier cambio de contenido descarta los
   * avisos de la importación anterior, salvo que sea justamente el resultado de una importación (`imported`).
   */
  private apply(module: AnyModule, text: string, patch: { modified: boolean; viewId?: string; readOnly?: boolean; imported?: ImportNotice }): void {
    const analysis = analyzeText(module, text);
    const choices = analysis.status === 'ok' ? viewChoices(module, analysis.document) : EMPTY_CHOICES;
    const previous = this.state.moduleId === module.id ? this.state.viewId : undefined;
    const wanted = patch.viewId ?? previous;
    const viewId = wanted && isKnownView(choices, wanted) ? wanted : choices.views[0]?.id;
    const moduleChanged = this.state.moduleId !== module.id;
    this.set({
      moduleId: module.id,
      module,
      loading: false,
      text,
      analysis,
      choices,
      viewId,
      modified: patch.modified,
      readOnly: patch.readOnly ?? this.state.readOnly,
      error: undefined,
      lastImport: patch.imported,
      replaced: undefined,
      ...(moduleChanged ? { svg: undefined, renderError: undefined } : {}),
    });
    this.scheduleRender(0);
  }

  /** Guarda el cambio donde corresponde: en el diagrama del proyecto abierto o, si no hay, en el borrador del módulo. */
  private persist(module: AnyModule, text: string): void {
    if (this.options.projects?.attached) this.options.projects.queueSave(text);
    else this.options.storage?.write(module.id, text);
  }

  /** Edición del texto por la persona (o por el anfitrión con `merge`). */
  setText(text: string): void {
    const { module, readOnly } = this.state;
    if (!module || readOnly || text === this.state.text) return;
    this.apply(module, text, { modified: true });
    this.persist(module, text);
    if (this.state.analysis.status === 'ok') this.scheduleRender(this.options.renderDelay ?? 250);
  }

  /**
   * Carga un documento (objeto o texto JSON) en el módulo indicado o en el activo. Con `strict` un documento inválido se
   * rechaza sin tocar el estado; si no, se muestra tal cual para que la persona vea los problemas.
   */
  async loadDocument(input: unknown, options: LoadOptions = {}): Promise<Analysis> {
    const module = await this.loadModule(options.module ?? this.state.moduleId ?? this.requireDefault());
    const text = typeof input === 'string' ? input : pretty(input);
    const analysis = typeof input === 'string' ? analyzeText(module, input) : analyzeValue(module, input);
    if (options.strict && analysis.status !== 'ok') throw asInvalid(analysis);
    this.selectToken += 1; // descarta una selección de módulo en curso
    this.apply(module, text, { modified: false, viewId: options.viewId, readOnly: options.readOnly });
    return this.state.analysis;
  }

  private requireDefault(): string {
    const first = this.sources[0];
    if (!first) throw new Error('El banco de trabajo no tiene módulos.');
    return first.id;
  }

  /**
   * Sustituye el documento por el resultado de una importación o conversión (cuenta como cambio de la persona). Con `imported`
   * deja los avisos de la importación en el estado, para que se vean desde el panel «Importar» sea cual sea la vía.
   */
  useDocumentText(text: string, imported?: ImportNotice): void {
    const { module, text: previous } = this.state;
    if (!module) return;
    const projects = this.options.projects;
    // Reemplazar un diagrama guardado se guarda solo: se conserva lo anterior unos momentos para poder deshacerlo.
    const replaced = projects?.attached && previous.trim() && previous !== text ? { text: previous, label: projects.diagram?.name ?? 'el diagrama' } : undefined;
    this.apply(module, text, { modified: true, imported });
    if (replaced) this.set({ replaced });
    this.persist(module, text);
  }

  /** Deshace el último reemplazo del diagrama guardado (importar, abrir un archivo, cargar el ejemplo). */
  undoReplace(): void {
    const { module, replaced } = this.state;
    if (!module || !replaced) return;
    this.apply(module, replaced.text, { modified: true });
    this.persist(module, replaced.text);
  }

  dismissReplaced(): void {
    if (this.state.replaced) this.set({ replaced: undefined });
  }

  // ───────────── proyectos ─────────────

  /** Abre un diagrama del proyecto: lo carga en el editor y a partir de ahí sus cambios se guardan solos. */
  async openDiagram(projectId: string, diagramId: string): Promise<void> {
    const projects = this.options.projects;
    if (!projects) throw new Error('Este banco de trabajo no guarda proyectos.');
    const meta = projects.getState().projects.find((p) => p.id === projectId)?.diagrams.find((d) => d.id === diagramId);
    const token = ++this.selectToken;
    this.set({ loading: true, error: undefined });
    try {
      if (meta && !this.moduleIds.includes(meta.module)) {
        throw new Error(`El diagrama «${meta.name}» es del módulo «${meta.module}», que este banco de trabajo no ofrece (módulos: ${this.moduleIds.join(', ')}).`);
      }
      const diagram = await projects.openDiagram(projectId, diagramId);
      const module = await this.loadModule(diagram.module);
      if (token !== this.selectToken) return;
      this.apply(module, diagram.text, { modified: false, readOnly: false });
    } catch (error) {
      if (token === this.selectToken) this.set({ loading: false, error: (error as Error).message });
    }
  }

  /**
   * Abre un proyecto como contexto (o `undefined` para salir de él). Entra en su diagrama más reciente del módulo activo o,
   * si no tiene, en el más reciente de todos; un proyecto sin diagramas deja el borrador como está. Al salir, vuelve el borrador del módulo.
   */
  async enterProject(projectId: string | undefined): Promise<void> {
    const projects = this.options.projects;
    if (!projects) return;
    if (projectId === undefined) {
      await projects.release();
      projects.selectProject(undefined);
      const { module } = this.state;
      if (module) {
        const text = this.options.storage?.read(module.id) ?? (await this.source(module.id).example?.()) ?? '';
        this.apply(module, text, { modified: false });
      }
      return;
    }
    await projects.release();
    projects.selectProject(projectId);
    const project = projects.project;
    const recent = (list: DiagramMeta[]): DiagramMeta | undefined => [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const target = recent(project?.diagrams.filter((d) => d.module === this.state.moduleId) ?? []) ?? recent(project?.diagrams ?? []);
    if (target && project) await this.openDiagram(project.id, target.id);
  }

  /** Guarda en el proyecto abierto el documento que se está editando (hasta entonces era un borrador) y lo deja abierto. */
  async saveToProject(name?: string): Promise<void> {
    const projects = this.options.projects;
    const current = this.currentDocument();
    if (!projects || !current) return;
    await projects.createDiagram({ module: current.module, name: name ?? current.name, text: current.text });
  }

  /** Resuelve un conflicto de guardado: quedarse con esta versión o cargar la que guardó otra pestaña. */
  async resolveConflict(choice: 'overwrite' | 'reload'): Promise<void> {
    const projects = this.options.projects;
    if (!projects) return;
    const diagram = await projects.resolveConflict(choice);
    const module = diagram && this.state.module;
    if (diagram && module) this.apply(module, diagram.text, { modified: false });
  }

  /** Documento vacío y válido (o ejemplo) con el que empieza un diagrama nuevo del módulo. */
  async template(moduleId: string, kind: 'example' | 'blank'): Promise<string | undefined> {
    const source = this.source(moduleId);
    return kind === 'blank' ? source.blank?.() : source.example?.();
  }

  /** El documento que se está editando, para guardarlo como diagrama de un proyecto. */
  currentDocument(): { module: string; text: string; name?: string } | undefined {
    const { module, text, analysis } = this.state;
    if (!module || !text.trim()) return undefined;
    const workspace = analysis.status === 'ok' ? (analysis.document as { workspace?: { name?: unknown } }).workspace : undefined;
    return { module: module.id, text, name: typeof workspace?.name === 'string' ? workspace.name : undefined };
  }

  /**
   * Los documentos con los que se resuelven los enlaces entre diagramas. Con un proyecto abierto son sus diagramas (el que se
   * está editando, con el texto vivo); si no, el borrador de cada módulo, uno por módulo.
   */
  async suiteDocuments(): Promise<SuiteDocument[]> {
    const projects = this.options.projects;
    const project = projects?.project;
    if (projects && project) {
      const docs: SuiteDocument[] = [];
      for (const meta of project.diagrams) {
        let text: string | undefined;
        if (meta.id === projects.getState().diagramId) text = this.state.text;
        else {
          const cached = this.diagramTexts.get(meta.id);
          if (cached && cached.updatedAt === meta.updatedAt) text = cached.text;
          else {
            const diagram = await projects.store.getDiagram(project.id, meta.id).catch(() => undefined);
            if (diagram) this.diagramTexts.set(meta.id, { updatedAt: diagram.updatedAt, text: (text = diagram.text) });
          }
        }
        if (text?.trim()) docs.push({ moduleId: meta.module, diagramId: meta.id, label: meta.name, text });
      }
      return docs;
    }
    const docs: SuiteDocument[] = [];
    for (const source of this.sources) {
      const text = await this.draftText(source.id);
      if (text?.trim()) docs.push({ moduleId: source.id, label: source.label, text });
    }
    return docs;
  }

  async loadExample(): Promise<void> {
    const { moduleId } = this.state;
    if (!moduleId) return;
    const text = await this.source(moduleId).example?.();
    if (text === undefined) return;
    this.useDocumentText(text);
  }

  markSaved(): void {
    this.set({ modified: false });
  }

  setReadOnly(readOnly: boolean): void {
    this.set({ readOnly });
  }

  setStatus(status: string | undefined, modified?: boolean): void {
    this.set({ status, ...(modified === undefined ? {} : { modified }) });
  }

  // ───────────── vistas ─────────────

  /** `false` si la vista no existe en el documento actual. */
  setView(viewId: string): boolean {
    if (!isKnownView(this.state.choices, viewId)) return false;
    if (viewId !== this.state.viewId) {
      this.set({ viewId });
      this.scheduleRender(0);
    }
    return true;
  }

  scheduleRender(delay: number): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.render(), delay);
  }

  /** Dibuja la vista activa. Con un documento inválido conserva el último dibujo válido. */
  async render(): Promise<void> {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    const { module, analysis, viewId } = this.state;
    if (!module || analysis.status !== 'ok') return;
    if (!canRender(module)) {
      this.set({ svg: undefined, rendering: false, renderError: `El módulo «${module.name}» no tiene vista de diagrama en este banco de trabajo.` });
      return;
    }
    const token = ++this.renderToken;
    this.set({ rendering: true });
    try {
      const svg = await renderSvg(module, analysis.document, viewId);
      if (token === this.renderToken) this.set({ svg, rendering: false, renderError: undefined });
    } catch (error) {
      if (token === this.renderToken) this.set({ rendering: false, renderError: (error as Error).message });
    }
  }

  // ───────────── operaciones sobre el documento actual ─────────────

  private current(): { module: AnyModule; document: unknown } {
    const { module, analysis } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    if (analysis.status !== 'ok') {
      const why = analysis.status === 'empty' ? 'el documento está vacío' : analysis.status === 'syntax' ? `no es JSON válido (${analysis.error})` : 'no cumple el esquema del módulo';
      throw new InvalidDocumentError(`No se puede continuar: ${why}.`, analysis.status === 'schema' ? analysis.issues : []);
    }
    return { module, document: analysis.document };
  }

  exportAs(format: string, viewId?: string): Promise<ExportedFile> {
    const { module, document } = this.current();
    return exportDocument(module, document, format, { viewId: viewId ?? this.state.viewId });
  }

  /**
   * Abre el texto de un archivo. Un JSON del módulo se carga tal cual; un JSON que no cumple su esquema pero que un
   * importador reconoce por el contenido (el `manifest.json` de dbt, un plan de Terraform) se importa, y el resto de
   * archivos se importan. Devuelve el resultado de la importación, o `undefined` si se cargó como documento.
   */
  async openText(text: string, file: string): Promise<ImportResult | undefined> {
    const { module } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    if (/\.json$/i.test(file) && (analyzeText(module, text).status === 'ok' || !module.importers.some((i) => i.detect?.(text)))) {
      this.useDocumentText(text);
      return undefined;
    }
    return this.importFrom(text, undefined, { file });
  }

  async importFrom(text: string, importerId?: string, context: { name?: string; file?: string } = {}): Promise<ImportResult> {
    const { module } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    const result = await importText(module, text, importerId, { name: context.name, file: context.file, fallbackName: context.file?.replace(/\.[^.]+$/, '') });
    this.useDocumentText(pretty(result.document), { importer: result.importer, file: context.file, warnings: result.warnings });
    return result;
  }

  /**
   * Importa varios archivos como uno solo (los `.tf` de un stack de Terraform): el documento es el mismo que el de importar sus
   * textos concatenados y los avisos y errores dicen de qué archivo vienen. Todos deben ser del mismo formato y de uno que se
   * pueda repartir en varios archivos (`Importer.multiFile`); si no, falla con el motivo y no toca el documento.
   */
  async importFiles(files: SourceFile[], importerId?: string): Promise<ImportResult> {
    const { module } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    const result = await importSourceFiles(module, files, importerId);
    this.useDocumentText(pretty(result.document), { importer: result.importer, file: files.length === 1 ? files[0].name : `${files.length} archivos`, warnings: result.warnings });
    return result;
  }

  /** Informes y conversiones del módulo. Los informes leen el documento del editor; las conversiones, el que se les pasa. */
  run(command: string, run: CommandRun & { fromEditor?: boolean }): Promise<CommandOutput> {
    const { module } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    return runCommand(module, command, { ...run, input: run.input ?? (run.fromEditor === false ? undefined : this.state.text) });
  }

  // ───────────── capacidades ─────────────

  /** Capacidades de los módulos pedidos (por defecto, todos: los carga si hace falta). */
  async capabilities(ids?: string[]): Promise<SuiteCapabilities> {
    const wanted = ids ?? this.moduleIds;
    const modules = await Promise.all(wanted.map((id) => this.loadModule(id)));
    return {
      protocol: this.options.protocol ?? EMBED_PROTOCOL_VERSION,
      suite: this.options.suite ?? 'IArk - DIAgrams',
      available: this.moduleIds,
      modules: modules.map(moduleCapabilities),
    };
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.listeners.clear();
  }
}

function asInvalid(analysis: Exclude<Analysis, { status: 'ok' }>): InvalidDocumentError {
  if (analysis.status === 'empty') return new InvalidDocumentError('El documento está vacío.');
  if (analysis.status === 'syntax') return new InvalidDocumentError(`El documento no es JSON válido: ${analysis.error}`);
  return new InvalidDocumentError(`Documento inválido:\n${analysis.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}`, analysis.issues);
}
