import { pretty, type EditorSpec, type EditResult, type FieldSpec } from '@iark/kernel';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Input, Tabs, TabPane, TextArea } from '@douyinfe/semi-ui';
import { LanguageSelect } from '../i18n/react';
import { DiagramCanvas, type CanvasCommands } from '../modules-app/canvas/DiagramCanvas';
import { EditHistory } from '../modules-app/canvas/history';
import type { WorkbenchController } from '../modules-app/controller';
import { downloadText } from '../modules-app/files';
import { ProjectBar } from '../modules-app/ProjectBar';
import { getLoginNotice } from '../projects/login';
import { ProjectsDialog } from '../projects/lazy';

type Panel = 'elements' | 'relationships' | 'views' | 'json' | 'ai';

/**
 * Marco del editor C4 clásico sobre el lienzo común. El documento lo lleva `WorkbenchController`;
 * cada módulo sigue en su `EditorSpec`.
 */
export function StudioApp({ controller }: { controller: WorkbenchController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const history = useMemo(() => new EditHistory(), [state.moduleId]);
  const commands = useRef<CanvasCommands | null>(null);
  const [, setCommandTick] = useState(0);
  const [panel, setPanel] = useState<Panel>('elements');
  const [focusId, setFocusId] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [showProjects, setShowProjects] = useState<false | 'list' | 'storage'>(() => (getLoginNotice()?.kind === 'error' ? 'storage' : false));
  const [toast, setToast] = useState<string | undefined>();
  const notify = useCallback((message: string) => setToast(message), []);
  const editor = state.module?.editor as EditorSpec<unknown> | undefined;
  const document = state.analysis.status === 'ok' ? state.analysis.document : undefined;
  const graph = editor && document ? editor.project(document, state.viewId) : undefined;
  const crumbs = editor && document ? (editor.breadcrumb?.(document, state.viewId) ?? []) : [];
  const canDrawio = !!state.module?.exporters.some((item) => item.id === 'drawio');

  const onCommands = useCallback((next: CanvasCommands) => {
    const prev = commands.current;
    commands.current = next;
    if (!prev || prev.canUndo !== next.canUndo || prev.canRedo !== next.canRedo) setCommandTick((n) => n + 1);
  }, []);

  const commit = (result: EditResult<unknown>): void => {
    if (!result.ok) {
      notify(result.reason);
      return;
    }
    if (result.document !== document) {
      history.record(state.text);
      controller.setText(pretty(result.document));
    }
    if (result.view && result.view !== state.viewId) controller.setView(result.view);
    if (result.id) {
      setSelectedId(result.id);
      setFocusId(result.id);
    }
  };

  const pick = (id: string) => {
    setSelectedId(id);
    setFocusId(id);
    setPanel('elements');
  };

  const exportDrawio = async () => {
    try {
      const file = await controller.exportAs('drawio');
      const name = (state.module?.name ?? 'diagrama').toLowerCase().replace(/\s+/g, '-');
      downloadText(`${name}${file.extension}`, file.data, file.mime);
    } catch (error) {
      notify((error as Error).message);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <div className="h-full flex flex-col overflow-hidden theme">
      <header className="c4-header mesa-bar flex justify-between items-center border-b px-3 py-1.5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <a href="./" className="h-8 w-8 rounded-md flex items-center justify-center text-white font-bold text-sm flex-none" style={{ backgroundColor: 'var(--c4-primary)', textDecoration: 'none' }}>
            IA
          </a>
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-medium truncate">{state.module?.name ?? 'DIAgrams'}</h1>
            <div className="flex items-center gap-1 flex-wrap">
              {controller.sources.map((source) => (
                <button key={source.id} type="button" className="c4-menu-item" aria-current={source.id === state.moduleId ? 'true' : undefined} onClick={() => void controller.selectModule(source.id)} style={source.id === state.moduleId ? { color: 'var(--c4-primary)', fontWeight: 600 } : undefined}>
                  {source.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-none">
          <LanguageSelect className="iark-lang" />
          <button type="button" className="c4-menu-item" disabled={!state.moduleId} onClick={() => void controller.loadExample()}>
            Ejemplo
          </button>
          {canDrawio && (
            <button type="button" className="c4-menu-item" data-testid="studio-export-drawio" onClick={() => void exportDrawio()} style={{ background: 'var(--c4-primary)', color: '#fff', borderRadius: 6, padding: '6px 12px' }}>
              Exportar .drawio
            </button>
          )}
        </div>
      </header>
      {controller.projects && <ProjectBar controller={controller} state={state} onManage={(panelId) => setShowProjects(panelId ?? 'list')} notify={notify} />}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="flex h-full flex-none" style={{ width: 374 }} aria-label="Panel lateral">
          <div className="flex flex-col h-full flex-1 min-w-0 sidesheet-theme border-r border-color">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <Tabs type="card" activeKey={panel} onChange={(key) => setPanel(key as Panel)} tabBarClassName="sticky top-0 z-10 sidesheet-theme px-2 pt-2 c4-tabbar">
                <TabPane tab={`Elementos (${graph?.nodes.length ?? 0})`} itemKey="elements">
                  <Elements editor={editor} document={document} selectedId={selectedId} nodes={graph?.nodes ?? []} readOnly={state.readOnly} onPick={pick} onCommit={commit} onAdd={(kind) => commands.current?.addNode(kind)} />
                </TabPane>
                <TabPane tab={`Relaciones (${graph?.edges.length ?? 0})`} itemKey="relationships">
                  <ul className="m-0 p-3 flex flex-col gap-2 list-none">
                    {(graph?.edges ?? []).map((edge) => (
                      <li key={edge.id}>
                        <button type="button" className={edge.id === selectedId ? 'c4-card is-selected w-full' : 'c4-card w-full'} onClick={() => pick(edge.id)} style={{ border: 0, background: 'transparent', textAlign: 'left' }}>
                          <span className="c4-card-header">
                            <strong>{edge.label || edge.kind}</strong>
                            <span className="text-color-3 text-sm">{labelOf(graph?.nodes ?? [], edge.source)} → {labelOf(graph?.nodes ?? [], edge.target)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </TabPane>
                <TabPane tab={`Vistas (${state.choices.views.length})`} itemKey="views">
                  <ul className="m-0 p-3 flex flex-col gap-2 list-none">
                    {state.choices.views.filter((view) => !view.variantOf).map((view) => (
                      <li key={view.id}>
                        <button type="button" className="c4-card w-full" onClick={() => controller.setView(view.id)} style={{ border: 0, textAlign: 'left', background: view.id === state.viewId ? 'var(--semi-color-fill-0)' : 'transparent' }}>
                          <span className="c4-card-header">{view.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </TabPane>
                <TabPane tab="JSON" itemKey="json">
                  <TextArea value={state.text} onChange={(value) => controller.setText(value)} autosize={{ minRows: 16 }} className="m-3" aria-label="Documento JSON" />
                </TabPane>
                {state.moduleId === 'c4' && (
                  <TabPane tab="IA" itemKey="ai">
                    <AiPane text={state.text} readOnly={state.readOnly} onApply={(value) => controller.setText(value)} />
                  </TabPane>
                )}
              </Tabs>
            </div>
          </div>
        </aside>
        <main id="c4-lienzo" className="relative flex-1 min-w-0 h-full overflow-hidden flex flex-col" aria-label="Lienzo del diagrama">
          {editor && (
            <DiagramCanvas
              chrome="embedded"
              moduleId={state.moduleId ?? ''}
              spec={editor}
              document={document}
              text={state.text}
              viewId={state.viewId}
              views={state.choices.views}
              onView={(id) => controller.setView(id)}
              readOnly={state.readOnly}
              history={history}
              onText={(value) => controller.setText(value)}
              notify={notify}
              focusId={focusId}
              onSelect={(id) => setSelectedId(id)}
              onCommands={onCommands}
            />
          )}
          {!editor && <p className="p-6 text-color-2">{state.loading ? 'Cargando…' : (state.error ?? 'Este módulo no tiene editor gráfico.')}</p>}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-24px)]">
            <div className="py-1.5 px-3 flex items-center gap-2 rounded-xl toolbar-theme border border-color text-sm">
              <button type="button" className="c4-menu-item" onClick={() => commands.current?.fit()}>Ajustar</button>
              <button type="button" className="c4-menu-item" disabled={!commands.current?.canUndo} onClick={() => commands.current?.undo()}>Deshacer</button>
              <button type="button" className="c4-menu-item" disabled={!commands.current?.canRedo} onClick={() => commands.current?.redo()}>Rehacer</button>
              <button type="button" className="c4-menu-item" data-testid="studio-autolayout" onClick={() => commands.current?.autoLayout()} style={{ color: 'var(--c4-primary)' }}>Autolayout</button>
            </div>
          </div>
          {crumbs.length > 0 && (
            <div className="absolute bottom-3 left-3 z-10" data-testid="studio-crumbs">
              <div className="py-1 px-2 rounded-lg toolbar-theme border border-color text-sm">
                {crumbs.map((crumb, index) => (
                  <button key={crumb.id} type="button" className="c4-menu-item" disabled={index === crumbs.length - 1} onClick={() => controller.setView(crumb.id)}>
                    {index > 0 ? '› ' : ''}{crumb.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
      {showProjects && controller.projects && (
        <ProjectsDialog
          session={controller.projects}
          modules={controller.sources.map((source) => ({ id: source.id, label: source.label }))}
          onOpen={(projectId, diagram) => controller.openDiagram(projectId, diagram.id)}
          current={() => controller.currentDocument()}
          template={(moduleId, kind) => controller.template(moduleId, kind)}
          onClose={() => setShowProjects(false)}
          notify={notify}
          initialPanel={showProjects === 'storage' ? 'storage' : undefined}
        />
      )}
      {toast && <div className="wb-toast" role="status">{toast}</div>}
    </div>
  );
}

function labelOf(nodes: Array<{ id: string; label: string }>, id: string): string {
  return nodes.find((node) => node.id === id)?.label ?? id;
}

function Elements({
  editor,
  document,
  nodes,
  selectedId,
  readOnly,
  onPick,
  onCommit,
  onAdd,
}: {
  editor?: EditorSpec<unknown>;
  document: unknown;
  nodes: Array<{ id: string; kind: string; label: string }>;
  selectedId?: string;
  readOnly: boolean;
  onPick(id: string): void;
  onCommit(result: EditResult<unknown>): void;
  onAdd(kind: string): void;
}) {
  const selected = nodes.find((node) => node.id === selectedId);
  const read = editor && document && selected ? editor.read(document, selected.id) : undefined;
  const fields = editor && document && read ? editor.fields({ type: 'node', kind: read.kind }, document, read.values) : [];
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap gap-1">
        {editor?.nodeKinds.filter((kind) => kind.addable !== false).map((kind) => (
          <button key={kind.kind} type="button" className="c4-menu-item" disabled={readOnly} onClick={() => onAdd(kind.kind)} data-testid={`studio-add-${kind.kind}`}>
            {kind.label}
          </button>
        ))}
      </div>
      {nodes.map((node) => (
        <article key={node.id} className={node.id === selectedId ? 'c4-card is-selected' : 'c4-card'}>
          <button type="button" className="c4-card-header w-full" onClick={() => onPick(node.id)} style={{ border: 0, background: 'transparent', width: '100%' }}>
            <strong className="truncate">{node.label}</strong>
            <span className="text-color-3 text-sm flex-none">{node.kind}</span>
          </button>
          {node.id === selectedId && editor && document !== undefined && (
            <div className="c4-card-body">
              {fields.map((field) => (
                <FieldRow key={field.key} field={field} value={read?.values[field.key]} readOnly={readOnly} onChange={(value) => onCommit(editor.update(document, node.id, { [field.key]: value }))} />
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function FieldRow({ field, value, readOnly, onChange }: { field: FieldSpec; value: unknown; readOnly: boolean; onChange(value: unknown): void }) {
  if (field.type === 'boolean') {
    return (
      <label className="c4-field">
        <span style={{ width: 92 }}>{field.label}</span>
        <input type="checkbox" checked={value === true} disabled={readOnly} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  if (field.type === 'longtext') {
    return (
      <label className="c4-field" style={{ alignItems: 'start' }}>
        <span style={{ width: 92 }}>{field.label}</span>
        <TextArea value={typeof value === 'string' ? value : ''} disabled={readOnly} onChange={onChange} autosize={{ minRows: 2, maxRows: 6 }} />
      </label>
    );
  }
  if (field.type === 'select') {
    return (
      <label className="c4-field">
        <span style={{ width: 92 }}>{field.label}</span>
        <select value={typeof value === 'string' ? value : ''} disabled={readOnly} onChange={(event) => onChange(event.target.value)} aria-label={field.label}>
          {field.allowEmpty && <option value="">—</option>}
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    );
  }
  const shown = Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value);
  return (
    <label className="c4-field">
      <span style={{ width: 92 }}>{field.label}</span>
      <Input size="small" value={shown} disabled={readOnly} aria-label={field.label} onChange={(next) => onChange(field.type === 'number' ? Number(next) : field.type === 'list' ? next.split(',').map((item) => item.trim()).filter(Boolean) : next)} />
    </label>
  );
}

function AiPane({ text, readOnly, onApply }: { text: string; readOnly: boolean; onApply(text: string): void }) {
  const [instruction, setInstruction] = useState('');
  const [pasted, setPasted] = useState('');
  const [note, setNote] = useState<string | undefined>();
  const copy = async () => {
    const { standalonePrompt } = await import('@iark/domain-c4');
    let base: unknown;
    try {
      base = JSON.parse(text);
    } catch {
      base = undefined;
    }
    const prompt = standalonePrompt(instruction.trim() || 'Describe aquí el sistema.', base as never);
    await navigator.clipboard.writeText(prompt).catch(() => undefined);
    setNote('Prompt copiado. Pégalo en un asistente y trae el JSON.');
  };
  return (
    <div className="p-3 flex flex-col gap-2 text-sm">
      <TextArea value={instruction} onChange={setInstruction} placeholder="Describe el sistema" autosize={{ minRows: 3, maxRows: 8 }} />
      <button type="button" className="c4-menu-item" onClick={() => void copy()} style={{ background: 'var(--c4-primary)', color: '#fff', borderRadius: 6 }}>
        Copiar prompt para IA
      </button>
      <TextArea value={pasted} onChange={setPasted} placeholder="Pega el JSON generado" autosize={{ minRows: 4, maxRows: 10 }} disabled={readOnly} />
      <button type="button" className="c4-menu-item" disabled={readOnly || !pasted.trim()} onClick={() => { onApply(pasted); setPasted(''); setNote('Modelo cargado'); }}>
        Cargar JSON
      </button>
      {note && <p className="m-0 text-color-2">{note}</p>}
    </div>
  );
}
