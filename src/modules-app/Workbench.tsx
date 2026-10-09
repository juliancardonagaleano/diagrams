import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkbenchController } from './controller';
import { canRender, countBySeverity, diffDocuments, diffSummaryLine, locateId, type AttachmentSpec } from '@iark/kernel';
import { useBulkInsert } from './bulkInsert';
import { readFile } from './files';
import { AttachmentsPanel } from './attachments';
import { DiagramCanvas } from './canvas/DiagramCanvas';
import type { LinkTools } from './canvas/Inspector';
import { resolveRef, SuiteLinks } from './links';
import { EditHistory } from './canvas/history';
import { DiagramPanel, ExportPanel, FilePicker, ImportPanel, IssuesPanel, ReportsPanel } from './panels';
import { compareMarks, readComparable } from './compare';
import { ComparePanel, type CompareState } from './ComparePanel';
import { ProjectBar } from './ProjectBar';
import { getLoginNotice, setLoginNotice } from '../projects/login';
import { ProjectsDialog } from '../projects/ProjectsDialog';
import { tabIndexDePestana, teclasDePestanas } from './a11y/pestanas';

type PanelId = 'canvas' | 'attachments' | 'diagram' | 'issues' | 'reports' | 'compare' | 'export' | 'import';

export interface WorkbenchProps {
  controller: WorkbenchController;
  /** Modo embebido: se ofrecen «Guardar» y «Salir» y el anfitrión decide qué se hace con el documento. */
  embed?: boolean;
  ui?: 'full' | 'min';
  dialog?: { title: string; message: string; button?: string };
  onDismissDialog?(): void;
  onSave?(exit: boolean): void;
  onExit?(): void;
}

const LINE_HEIGHT = 18;

export function Workbench({ controller, embed = false, ui = 'full', dialog, onDismissDialog, onSave, onExit }: WorkbenchProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [panel, setPanel] = useState<PanelId | undefined>();
  const history = useMemo(() => new EditHistory(), [state.moduleId]);

  // ── Enlaces entre diagramas: seguir una URN lleva al módulo destino con el elemento encuadrado; la miga permite volver.
  interface Stop {
    moduleId: string;
    /** En un proyecto, el diagrama en el que se estaba (un módulo puede tener varios). */
    diagramId?: string;
    viewId?: string;
    elementId?: string;
    label: string;
  }
  const suiteLinks = useMemo(() => new SuiteLinks(controller), [controller]);
  const [trail, setTrail] = useState<Stop[]>([]);
  const [focus, setFocus] = useState<{ moduleId: string; id: string } | undefined>();
  const selectedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focus && focus.moduleId !== state.moduleId) setFocus(undefined);
  }, [focus, state.moduleId]);
  const [attachmentId, setAttachmentId] = useState<string | undefined>();
  useEffect(() => setAttachmentId(undefined), [state.moduleId]);
  // Comparar versiones: la otra versión (la base) con la que se compara el documento actual. Es de cada módulo.
  const [base, setBase] = useState<{ name: string; document: unknown } | undefined>();
  useEffect(() => setBase(undefined), [state.moduleId]);
  const projects = controller.projects;
  /** El gestor de proyectos: cerrado, abierto, o abierto con «Dónde se guardan» desplegado (para volver a conectar). */
  // Si el inicio de sesión de GitHub no pudo terminar, se abre directamente «Dónde se guardan», que dice por qué y deja volver a intentarlo.
  const [showProjects, setShowProjects] = useState<false | 'list' | 'storage'>(() => (getLoginNotice()?.kind === 'error' ? 'storage' : false));
  const [toast, setToast] = useState<string | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const jsonEditor = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useBulkInsert(jsonEditor, (value) => controller.setText(value));

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 4000);
  }, []);

  // Al volver de iniciar sesión con GitHub, se confirma con un aviso (el error, en cambio, se queda en el panel hasta que la persona lo descarte).
  useEffect(() => {
    const login = getLoginNotice();
    if (login?.kind !== 'ok') return;
    notify(login.message);
    setLoginNotice(undefined);
  }, [notify]);

  const goTo = useCallback(
    async (moduleId: string, elementId?: string, diagramId?: string): Promise<void> => {
      const project = controller.projects?.project;
      // Con varios diagramas por módulo, ir a un módulo es ir a un diagrama concreto del proyecto.
      if (diagramId && project && controller.projects?.getState().diagramId !== diagramId) await controller.openDiagram(project.id, diagramId);
      else await controller.selectModule(moduleId);
      if (!elementId) return;
      const { module: target, analysis } = controller.getState();
      // C4 tiene una vista por nivel y un elemento solo se ve en las suyas: se abre la vista cuyo alcance es el elemento (o la primera que lo dibuja).
      if (target?.id === 'c4' && analysis.status === 'ok') {
        const doc = analysis.document as { views?: Array<{ id: string; scopeId?: string; elements?: Array<{ id: string }> }> };
        const view = doc.views?.find((v) => v.scopeId === elementId) ?? doc.views?.find((v) => v.elements?.some((e) => e.id === elementId));
        if (view) controller.setView(view.id);
      }
      setFocus({ moduleId, id: elementId });
      setPanel('canvas');
    },
    [controller],
  );

  const followRef = useCallback(
    async (urn: string): Promise<void> => {
      const ref = resolveRef(urn);
      if (!ref) return notify(`La referencia «${urn}» no es una URN válida (urn:iark:<módulo>:<id>).`);
      if (!controller.moduleIds.includes(ref.moduleId)) return notify(`El módulo «${ref.moduleId}» no está en este banco de trabajo.`);
      const exists = await suiteLinks.exists(urn);
      const inProject = !!controller.projects?.project;
      if (exists === false) notify(`El elemento «${ref.elementId}» no existe en ${inProject ? 'ningún diagrama del proyecto' : `el documento actual de ${suiteLinks.label(ref.moduleId)}`}.`);
      const owners = exists ? await suiteLinks.owners(urn) : [];
      const currentDiagram = controller.projects?.getState().diagramId;
      // En un proyecto, la URN puede estar en varios diagramas del mismo módulo: se prefiere el actual y si no el primero.
      const target = owners.find((o) => o.diagramId === currentDiagram) ?? owners[0];
      if (owners.length > 1 && owners.some((o) => o.diagramId)) {
        notify(`«${ref.elementId}» está en varios diagramas (${owners.map((o) => o.label).join(', ')}): se abre «${target.label}».`);
      }
      const from = controller.getState();
      if (from.moduleId) {
        const label = `${suiteLinks.label(from.moduleId)}${selectedRef.current ? ` · ${selectedRef.current}` : ''}`;
        setTrail((t) => [...t, { moduleId: from.moduleId!, diagramId: currentDiagram, viewId: from.viewId, elementId: selectedRef.current, label }]);
      }
      await goTo(ref.moduleId, ref.elementId, target?.diagramId);
    },
    [controller, goTo, notify, suiteLinks],
  );

  const goBack = useCallback(async (): Promise<void> => {
    const stop = trail[trail.length - 1];
    if (!stop) return;
    setTrail((t) => t.slice(0, -1));
    await goTo(stop.moduleId, stop.elementId, stop.diagramId);
    if (stop.viewId) controller.setView(stop.viewId);
  }, [controller, goTo, trail]);

  const linkTools = useMemo<LinkTools>(
    () => ({
      modules: controller.sources.map((s) => ({ id: s.id, label: s.label })),
      entities: (id) => suiteLinks.entities(id),
      backlinks: (moduleId, elementId) => suiteLinks.backlinks(moduleId, elementId),
      follow: (urn) => void followRef(urn),
    }),
    [controller, followRef, suiteLinks],
  );

  const reveal = useCallback(
    (id: string) => {
      const el = jsonEditor.current;
      const found = locateId(controller.getState().text, id);
      if (!el || !found) return;
      el.focus();
      el.setSelectionRange(found.index, found.index + found.length);
      const line = el.value.slice(0, found.index).split('\n').length;
      el.scrollTop = Math.max(0, (line - 3) * LINE_HEIGHT);
    },
    [controller],
  );

  const openFile = async (file: File) => {
    try {
      const result = await controller.openText(await readFile(file), file.name);
      if (result) notify(`Importado desde ${result.importer}${result.warnings.length ? ` con ${result.warnings.length} avisos (se ven en la pestaña Importar)` : ''}`);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const openAttachment = useCallback((id: string) => {
    setAttachmentId(id);
    setPanel('attachments');
  }, []);

  const { module, analysis } = state;
  // La diferencia se recalcula con cada edición válida del documento actual; con uno inválido no hay diferencia que mostrar.
  const compare = useMemo<{ state: CompareState; canvas?: ReturnType<typeof compareMarks> } | undefined>(() => {
    if (!base) return undefined;
    if (!module || analysis.status !== 'ok') return { state: { name: base.name } };
    const diff = diffDocuments(base.document, analysis.document, module.diff);
    return { state: { name: base.name, diff }, canvas: compareMarks(diff, base.document) };
  }, [base, module, analysis]);

  const loadCompare = useCallback(
    async (text: string, name: string): Promise<string | undefined> => {
      if (!module) return 'No hay ningún módulo activo.';
      const result = await readComparable(module, text, name);
      if (!result.ok) return result.reason;
      setBase({ name, document: result.document });
      return undefined;
    },
    [module],
  );

  // El diálogo de «Abrir archivo…» ofrece el JSON del módulo y las extensiones de todos sus importadores (.sql, .tf, .yaml, .archimate…).
  const openAccept = [...new Set(['.json', '.mmd', '.mermaid', '.md', ...(module?.importers.flatMap((i) => i.extensions.map((e) => `.${e.split('.').pop()}`)) ?? [])]), 'text/plain', 'application/json'].join(',');
  const counts = analysis.status === 'ok' ? countBySeverity(analysis.issues) : { error: 0, warning: 0, info: 0 };
  const problemCount = analysis.status === 'ok' ? analysis.issues.length : analysis.status === 'schema' ? analysis.issues.length : analysis.status === 'syntax' ? 1 : 0;
  const panelProps = { controller, state, reveal, notify };

  const editor = module?.editor;
  const attachments = editor?.attachments as AttachmentSpec<unknown> | undefined;
  const hasCanvas = !!editor;
  const fallback: PanelId = hasCanvas ? 'canvas' : 'diagram';
  const active: PanelId = panel === 'attachments' && !attachments ? fallback : (panel ?? fallback);
  const canvasMode = active === 'canvas' && hasCanvas;
  const renders = module ? canRender(module) : true;
  const tabs: Array<[PanelId, string]> = [
    ...(hasCanvas ? ([['canvas', 'Lienzo']] as Array<[PanelId, string]>) : []),
    ...(attachments ? ([['attachments', attachments.label]] as Array<[PanelId, string]>) : []),
    ['diagram', hasCanvas ? (renders ? 'Vista SVG' : 'JSON') : 'Diagrama'],
    ['issues', `Problemas${problemCount ? ` (${problemCount})` : ''}`],
    ['reports', 'Informes'],
    ['compare', compare?.state.diff ? `Comparar (${compare.state.diff.summary.total})` : 'Comparar'],
    ['export', 'Exportar'],
    // Los avisos de la última importación (venga de donde venga) se ven en esta pestaña hasta que se edite el documento.
    ['import', `Importar${state.lastImport?.warnings.length ? ` (${state.lastImport.warnings.length})` : ''}`],
  ];

  return (
    <div className="wb" data-ui={ui}>
      {/* WCAG 2.4.1: quien navega con teclado salta la cabecera y las pestañas y va directo al contenido. */}
      <a
        className="wb-skip"
        href="#wb-contenido"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Saltar al contenido
      </a>
      <header className="wb-header">
          {ui === 'full' ? (
            <>
              <h1 className="wb-title">
                <a className="wb-brand" href="./" title="Abrir el editor C4">
                  IArk - DIAgrams <small>Módulos</small>
                </a>
              </h1>
              <div className="wb-modules" role="tablist" aria-label="Módulos" onKeyDown={teclasDePestanas}>
                {controller.sources.map((s, i) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={s.id === state.moduleId}
                    tabIndex={tabIndexDePestana(s.id === state.moduleId, !controller.sources.some((o) => o.id === state.moduleId), i === 0)}
                    onClick={() => void controller.selectModule(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {!embed && (
                <a className="wb-link" href="trazabilidad.html" title="Enlaces entre los documentos de varios módulos">
                  Trazabilidad
                </a>
              )}
            </>
          ) : (
            <h1 className="wb-visually-hidden">{module ? `${module.name}: banco de trabajo` : 'Banco de trabajo de IArk - DIAgrams'}</h1>
          )}
          <div className="wb-actions">
            <button type="button" disabled={!state.moduleId} onClick={() => void controller.loadExample()}>
              Cargar ejemplo
            </button>
            <FilePicker label="Abrir archivo…" accept={openAccept} disabled={!state.moduleId} onFile={(file) => void openFile(file)} />
            {embed && (
              <>
                <button type="button" onClick={() => onSave?.(false)}>
                  Guardar
                </button>
                <button type="button" className="primary" onClick={() => onSave?.(true)}>
                  Guardar y salir
                </button>
                <button type="button" onClick={() => onExit?.()}>
                  Salir
                </button>
              </>
            )}
          </div>
      </header>

      {projects && !embed && ui === 'full' && <ProjectBar controller={controller} state={state} onManage={(panel) => setShowProjects(panel ?? 'list')} notify={notify} />}

      {trail.length > 0 && (
        <div className="wb-trail" role="navigation" aria-label="Diagramas recorridos" data-testid="trail">
          {trail.map((stop, i) => (
            <span key={i}>{stop.label} ›</span>
          ))}
          <strong>{module ? suiteLinks.label(module.id) : ''}</strong>
          <button type="button" onClick={() => void goBack()} title="Alt+↑" data-testid="trail-back">
            ← Volver
          </button>
        </div>
      )}
      <main className="wb-main" id="wb-contenido" ref={mainRef} tabIndex={-1} data-mode={canvasMode || active === 'attachments' ? 'canvas' : undefined}>
        <section className="wb-editor" aria-label="Documento">
          <div className="wb-bar">
            <strong>{module ? `${module.name} · v${module.version}` : state.loading ? 'Cargando módulo…' : 'Elige un módulo'}</strong>
            <span>{state.readOnly ? 'Solo lectura' : state.modified ? 'Sin guardar' : ''}</span>
          </div>
          <textarea
            ref={jsonEditor}
            aria-label="Documento JSON"
            spellCheck={false}
            value={state.text}
            readOnly={state.readOnly || !module}
            placeholder={module ? 'Pega o escribe el documento JSON del módulo, o pulsa «Cargar ejemplo».' : ''}
            onChange={(e) => controller.setText(e.target.value)}
          />
          <div className="wb-foot" role="status" data-testid="editor-status">
            {state.error ? (
              <span className="wb-chip error">{state.error}</span>
            ) : analysis.status === 'empty' ? (
              <span>Documento vacío</span>
            ) : analysis.status === 'syntax' ? (
              <span className="wb-chip error">JSON inválido: {analysis.error}</span>
            ) : analysis.status === 'schema' ? (
              <span className="wb-chip error">{analysis.issues.length} errores de esquema</span>
            ) : (
              <span>
                <span className="wb-chip ok">Válido</span> {counts.error} errores · {counts.warning} avisos · {counts.info} notas
              </span>
            )}
            {state.status && <span> · {state.status}</span>}
          </div>
        </section>

        <section className="wb-side">
          <div className="wb-tabs" role="tablist" aria-label="Paneles" onKeyDown={teclasDePestanas}>
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={active === id} tabIndex={active === id ? 0 : -1} onClick={() => setPanel(id)}>
                {label}
              </button>
            ))}
          </div>
          {canvasMode && compare && (
            <div className="wb-compare-bar" role="status" data-testid="compare-bar">
              <span>
                Comparando con <strong>{compare.state.name}</strong>
                {compare.state.diff ? `: ${diffSummaryLine(compare.state.diff)}` : ': el documento actual no es válido.'}
              </span>
              <span className="wb-compare-legend" aria-hidden="true">
                <i data-diff="added" /> nuevo <i data-diff="modified" /> modificado <i data-diff="removed" /> quitado
              </span>
              <button type="button" onClick={() => setPanel('compare')}>
                Ver cambios
              </button>
              <button type="button" onClick={() => setBase(undefined)} data-testid="compare-bar-clear">
                Quitar comparación
              </button>
            </div>
          )}
          {canvasMode && editor && (
            <DiagramCanvas
              moduleId={module!.id}
              spec={editor as never}
              document={analysis.status === 'ok' ? analysis.document : undefined}
              text={state.text}
              viewId={state.viewId}
              views={state.choices.views}
              onView={(id) => controller.setView(id)}
              readOnly={state.readOnly}
              history={history}
              onText={(t) => controller.setText(t)}
              notify={notify}
              focusId={focus?.moduleId === module!.id ? focus.id : undefined}
              links={linkTools}
              onBack={trail.length > 0 ? () => void goBack() : undefined}
              onSelect={(id) => (selectedRef.current = id)}
              onOpenAttachment={openAttachment}
              compare={compare?.canvas}
            />
          )}
          {active === 'attachments' && attachments && (
            <AttachmentsPanel
              attachments={attachments}
              document={analysis.status === 'ok' ? analysis.document : undefined}
              text={state.text}
              readOnly={state.readOnly}
              history={history}
              onText={(t) => controller.setText(t)}
              notify={notify}
              selectedId={attachmentId}
              onSelect={setAttachmentId}
              onOpenUsage={(id) => {
                setFocus({ moduleId: module!.id, id });
                setPanel('canvas');
              }}
            />
          )}
          {active === 'diagram' && <DiagramPanel {...panelProps} />}
          {active === 'issues' && <IssuesPanel {...panelProps} />}
          {active === 'reports' && <ReportsPanel {...panelProps} />}
          {active === 'compare' && (
            <ComparePanel
              accept={openAccept}
              analysis={analysis}
              compare={compare?.state}
              onLoad={loadCompare}
              onClear={() => setBase(undefined)}
              onFocus={(id) => void goTo(state.moduleId!, id)}
            />
          )}
          {active === 'export' && <ExportPanel {...panelProps} />}
          {active === 'import' && <ImportPanel {...panelProps} />}
        </section>
      </main>

      {showProjects && projects && (
        <ProjectsDialog
          session={projects}
          modules={controller.sources.map((s) => ({ id: s.id, label: s.label }))}
          onOpen={(projectId, diagram) => controller.openDiagram(projectId, diagram.id)}
          current={() => controller.currentDocument()}
          template={(moduleId, kind) => controller.template(moduleId, kind)}
          onClose={() => setShowProjects(false)}
          notify={notify}
          initialPanel={showProjects === 'storage' ? 'storage' : undefined}
        />
      )}
      {toast && (
        <div className="wb-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
      {dialog && (
        <div className="wb-toast" role="alertdialog" aria-label={dialog.title}>
          <strong>{dialog.title}</strong>
          {dialog.message}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="primary" onClick={() => onDismissDialog?.()}>
              {dialog.button ?? 'Aceptar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
