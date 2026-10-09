import { Button, Dropdown, Input, Modal, Tag, Toast, Tooltip } from '@douyinfe/semi-ui';
import { IconDownload, IconEdit, IconExit, IconSave } from '@douyinfe/semi-icons';
import { useEffect, useState } from 'react';
import { useActions } from '../../hooks/useActions';
import { isEmbedMode, useDocumentStore, useTemporalStore } from '../../store/documentStore';
import { relativeTime } from '../../utils/files';
import { AboutModal, ShortcutsModal } from './HelpModals';
import { MermaidPreviewModal } from './MermaidPreviewModal';
import { C4_MODULE, type ProjectBinding } from '../../projects/useProjectBinding';
import { DIRECTIONS, DISTRIBUTIONS } from './FloatingToolbar';

const Logo = () => (
  <div className="flex items-center gap-2 select-none">
    <div className="h-8 w-8 rounded-md flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: 'var(--c4-primary)' }}>
      IA
    </div>
  </div>
);

interface MenuProps {
  label: string;
  items: Array<{ key: string; label: string; onClick?: () => void; disabled?: boolean; divider?: boolean; checked?: boolean; shortcut?: string; closeMenu?: boolean }>;
}

function Menu({ label, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      trigger="click"
      position="bottomLeft"
      visible={open}
      onVisibleChange={setOpen}
      render={
        <Dropdown.Menu>
          {items.map((it) =>
            it.divider ? (
              <Dropdown.Divider key={it.key} />
            ) : (
              <Dropdown.Item
                key={it.key}
                onClick={() => {
                  it.onClick?.();
                  // Las opciones que abren un diálogo cierran el menú: si no, quedaría por encima del diálogo.
                  if (it.closeMenu) setOpen(false);
                }}
                disabled={it.disabled}
              >
                <div className="flex items-center justify-between gap-6 w-full min-w-[220px]">
                  <span>
                    {it.checked !== undefined && <span className="inline-block w-4">{it.checked ? '✓' : ''}</span>}
                    {it.label}
                  </span>
                  {it.shortcut && <span className="text-xs text-color-3">{it.shortcut}</span>}
                </div>
              </Dropdown.Item>
            ),
          )}
        </Dropdown.Menu>
      }
    >
      <div className="c4-menu-item hover-2">{label}</div>
    </Dropdown>
  );
}

export interface ControlPanelProps {
  /** Callbacks del modo embebido. */
  onEmbedSave?: (exit: boolean) => void;
  onEmbedExit?: () => void;
  /** Proyectos guardados (solo fuera del modo embebido). `onHistory` abre el historial de versiones del diagrama abierto. */
  projects?: { binding: ProjectBinding; onManage: (panel?: 'storage') => void; onHistory?: () => void };
}

const SAVE_LABEL = { idle: 'Guardado', pending: 'Guardando…', saving: 'Guardando…', saved: 'Guardado', error: 'No se pudo guardar', conflict: 'Conflicto de guardado' } as const;

export function ControlPanel({ onEmbedSave, onEmbedExit, projects }: ControlPanelProps) {
  const name = useDocumentStore((s) => s.doc.workspace.name);
  const setWorkspaceName = useDocumentStore((s) => s.setWorkspaceName);
  const ui = useDocumentStore((s) => s.ui);
  const setUi = useDocumentStore((s) => s.setUi);
  const modified = useDocumentStore((s) => s.modified);
  const lastSavedAt = useDocumentStore((s) => s.lastSavedAt);
  const statusMessage = useDocumentStore((s) => s.statusMessage);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const newDocument = useDocumentStore((s) => s.newDocument);
  const loadSample = useDocumentStore((s) => s.loadSample);
  const selection = useDocumentStore((s) => s.selection);
  const pastStates = useTemporalStore((t) => t.pastStates.length);
  const futureStates = useTemporalStore((t) => t.futureStates.length);
  const actions = useActions();
  const [editingTitle, setEditingTitle] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMermaid, setShowMermaid] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);

  // Descartar el documento actual (Nuevo/Cargar ejemplo/Abrir JSON/Importar .drawio o DSL) sin guardar antes pide
  // confirmación, igual que ya hace `useEmbedBridge.exit()` cuando hay cambios sin guardar.
  const projectState = projects?.binding.state;
  const projectSession = projects?.binding.session;
  const attached = projectSession && projectSession.attached && projectSession.diagram?.module === C4_MODULE ? projectSession.diagram : undefined;
  const openProject = projectSession?.project;
  /** El historial de versiones se ofrece con un diagrama C4 abierto en un almacén que las guarda. */
  const canHistory = !!attached && !!projects?.onHistory && projectSession?.canVersion === true;
  const resolveConflict = (choice: 'overwrite' | 'reload'): void => {
    void projects?.binding.resolveConflict(choice).catch((error: Error) => Toast.error(error.message));
  };
  const confirmDiscard = (proceed: () => void) => {
    // Con un diagrama de proyecto abierto, sustituir el documento también sustituye lo guardado en el proyecto.
    if (attached && openProject) {
      Modal.confirm({
        title: 'Reemplazar el diagrama del proyecto',
        content: `El diagrama «${attached.name}» del proyecto «${openProject.name}» se guarda solo: lo que cargues lo reemplazará en el proyecto. ¿Deseas continuar?`,
        okText: 'Reemplazar',
        cancelText: 'Cancelar',
        okType: 'danger',
        onOk: proceed,
      });
      return;
    }
    if (!modified) {
      proceed();
      return;
    }
    Modal.confirm({
      title: 'Descartar cambios sin guardar',
      content: 'Hay cambios sin guardar en el diagrama actual. ¿Deseas continuar de todos modos?',
      okText: 'Continuar',
      cancelText: 'Cancelar',
      okType: 'danger',
      onOk: proceed,
    });
  };

  const saveToProject = (): void => {
    if (!projectSession || !openProject) return;
    const { module, text, name: docName } = projects!.binding.current();
    void projectSession
      .createDiagram({ module, name: docName, text })
      .then((meta) => Toast.success(`Guardado como «${meta.name}» en el proyecto «${openProject.name}». Los cambios se guardan solos.`))
      .catch((error: Error) => Toast.error(error.message));
  };

  const projectItems: MenuProps['items'] = projects
    ? [
        { key: 'projects', label: 'Proyectos…', onClick: () => projects.onManage(), closeMenu: true },
        ...(openProject && !attached ? [{ key: 'save-project', label: `Guardar en el proyecto «${openProject.name}»`, onClick: saveToProject }] : []),
        ...(canHistory ? [{ key: 'history', label: 'Historial de versiones…', onClick: () => projects.onHistory?.(), closeMenu: true }] : []),
        ...(attached ? [{ key: 'detach-project', label: 'Dejar de guardar en el proyecto', onClick: () => void projectSession?.release() }] : []),
        { key: 'dp', label: '', divider: true },
      ]
    : [];

  const fileMenu: MenuProps['items'] = isEmbedMode
    ? [
        { key: 'save', label: 'Guardar', onClick: () => onEmbedSave?.(false), shortcut: 'Ctrl+S' },
        { key: 'save-exit', label: 'Guardar y salir', onClick: () => onEmbedSave?.(true) },
        { key: 'd1', label: '', divider: true },
        { key: 'export', label: 'Exportar .drawio (notación C4)…', onClick: () => void actions.exportDrawio('c4') },
        { key: 'export-card', label: 'Exportar .drawio (tarjetas)…', onClick: () => void actions.exportDrawio('card') },
        { key: 'export-mermaid', label: 'Exportar Mermaid (.mmd)…', onClick: () => void actions.exportMermaid('c4') },
        { key: 'preview-mermaid', label: 'Vista previa de Mermaid…', onClick: () => setShowMermaid(true), closeMenu: true },
        { key: 'json', label: 'Descargar JSON…', onClick: actions.saveJson },
        { key: 'd2', label: '', divider: true },
        { key: 'exit', label: 'Salir sin guardar', onClick: onEmbedExit },
      ]
    : [
        ...projectItems,
        { key: 'new', label: 'Nuevo diagrama', onClick: () => confirmDiscard(newDocument) },
        { key: 'sample', label: 'Cargar ejemplo (banca en línea)', onClick: () => confirmDiscard(loadSample) },
        { key: 'open', label: 'Abrir JSON…', onClick: () => confirmDiscard(actions.openJson), shortcut: 'Ctrl+O' },
        { key: 'import-drawio', label: 'Importar .drawio…', onClick: () => confirmDiscard(actions.importDrawio) },
        { key: 'import-dsl', label: 'Importar Structurizr DSL…', onClick: () => confirmDiscard(actions.importDsl) },
        { key: 'import-mermaid', label: 'Importar Mermaid…', onClick: () => confirmDiscard(actions.importMermaid) },
        { key: 'd1', label: '', divider: true },
        { key: 'save', label: 'Guardar JSON', onClick: actions.saveJson, shortcut: 'Ctrl+S' },
        { key: 'export', label: 'Exportar .drawio (notación C4)', onClick: () => void actions.exportDrawio('c4'), shortcut: 'Ctrl+E' },
        { key: 'export-card', label: 'Exportar .drawio (tarjetas)', onClick: () => void actions.exportDrawio('card') },
        { key: 'export-mermaid', label: 'Exportar Mermaid (.mmd)', onClick: () => void actions.exportMermaid('c4') },
        { key: 'export-mermaid-flow', label: 'Exportar Mermaid (diagrama de flujo)', onClick: () => void actions.exportMermaid('flowchart') },
        { key: 'copy-mermaid', label: 'Copiar vista como Mermaid', onClick: () => void actions.exportMermaid('c4', 'clipboard') },
        { key: 'preview-mermaid', label: 'Vista previa de Mermaid…', onClick: () => setShowMermaid(true), closeMenu: true },
      ];

  const editMenu: MenuProps['items'] = [
    { key: 'undo', label: 'Deshacer', onClick: actions.undo, disabled: pastStates === 0 || readOnly, shortcut: 'Ctrl+Z' },
    { key: 'redo', label: 'Rehacer', onClick: actions.redo, disabled: futureStates === 0 || readOnly, shortcut: 'Ctrl+Y' },
    { key: 'd1', label: '', divider: true },
    { key: 'delete', label: 'Eliminar selección', onClick: actions.deleteSelection, disabled: selection.kind === 'none' || readOnly, shortcut: 'Supr' },
    { key: 'd2', label: '', divider: true },
    { key: 'layout', label: 'Autolayout de la vista', onClick: () => void actions.autoLayout(), disabled: readOnly, shortcut: 'Ctrl+L' },
  ];

  const viewMenu: MenuProps['items'] = [
    { key: 'header', label: 'Cabecera', checked: ui.showHeader, onClick: () => setUi({ showHeader: !ui.showHeader }) },
    { key: 'sidebar', label: 'Panel lateral', checked: ui.showSidebar, onClick: () => setUi({ showSidebar: !ui.showSidebar }) },
    { key: 'issues', label: 'Panel de problemas', checked: ui.showIssues, onClick: () => setUi({ showIssues: !ui.showIssues }) },
    { key: 'd1', label: '', divider: true },
    { key: 'grid', label: 'Cuadrícula', checked: ui.showGrid, onClick: () => setUi({ showGrid: !ui.showGrid }) },
    { key: 'minimap', label: 'Minimapa', checked: ui.showMinimap, onClick: () => setUi({ showMinimap: !ui.showMinimap }) },
    { key: 'd2', label: '', divider: true },
    { key: 'theme', label: 'Tema oscuro', checked: ui.theme === 'dark', onClick: () => setUi({ theme: ui.theme === 'dark' ? 'light' : 'dark' }) },
    { key: 'd3', label: '', divider: true },
    { key: 'style-c4', label: 'Notación C4 clásica', checked: ui.nodeStyle === 'c4', onClick: () => setUi({ nodeStyle: 'c4' }) },
    { key: 'style-card', label: 'Tarjetas (estilo drawdb)', checked: ui.nodeStyle === 'card', onClick: () => setUi({ nodeStyle: 'card' }) },
  ];

  const settingsMenu: MenuProps['items'] = [
    ...DIRECTIONS.map((d) => ({
      key: `dir-${d.value}`,
      label: `Dirección del autolayout: ${d.label}`,
      checked: ui.direction === d.value,
      onClick: () => setUi({ direction: d.value }),
    })),
    { key: 'd0', label: '', divider: true },
    ...DISTRIBUTIONS.map((d) => ({
      key: `dist-${d.value}`,
      label: d.label,
      checked: ui.distribution === d.value,
      onClick: () => setUi({ distribution: d.value }),
    })),
    { key: 'd1', label: '', divider: true },
    ...(['auto', 'compact', 'spacious'] as const).map((d) => ({
      key: `density-${d}`,
      label: `Densidad del autolayout: ${d === 'auto' ? 'automática (según relaciones)' : d === 'compact' ? 'compacta' : 'amplia'}`,
      checked: ui.density === d,
      onClick: () => setUi({ density: d }),
    })),
  ];

  const helpMenu: MenuProps['items'] = [
    { key: 'shortcuts', label: 'Atajos de teclado', onClick: () => setShowShortcuts(true) },
    { key: 'about', label: 'Acerca del diagramador', onClick: () => setShowAbout(true) },
    { key: 'c4', label: 'Modelo C4 (c4model.com)', onClick: () => window.open('https://c4model.com', '_blank', 'noopener') },
  ];

  // Con un servidor el estado lo dice («· servidor») y un token rechazado se avisa aparte, con el botón para volver a conectar.
  const remote = projectSession?.remote === true;
  const rejected =
    remote && !!projectState && (projectState.errorCode === 'unauthorized' || projectState.syncErrorCode === 'unauthorized' || projectState.saveErrorCode === 'unauthorized');
  const forbidden = remote && !rejected && projectState?.saveErrorCode === 'forbidden';
  // Con una sesión de persona (inicio de sesión de GitHub) no se «rechaza un token»: la sesión caducó, y un 403 es el rol en el proyecto, no un token que cambiar.
  const withSession = projectSession?.credential === 'session';
  const rejectedText = withSession ? 'Tu sesión caducó' : 'El servidor no aceptó el token';
  const projectStatus =
    remote && projectState && !projectState.available
      ? projectState.errorCode === 'unauthorized'
        ? rejectedText
        : 'Servidor no disponible'
      : attached && projectState
        ? projectState.save === 'error' && projectState.saveErrorCode === 'unauthorized'
          ? rejectedText
          : projectState.save === 'error' && projectState.saveErrorCode === 'forbidden'
            ? 'Sin permiso para guardar en el servidor'
            : `${SAVE_LABEL[projectState.save]}${projectState.save === 'saved' || projectState.save === 'idle' ? ` en «${openProject?.name}»${remote ? ' · servidor' : ''}` : ''}`
        : undefined;
  const status = statusMessage ?? projectStatus ?? (modified ? 'Cambios sin guardar' : relativeTime(lastSavedAt));

  return (
    <header className="flex justify-between items-center border-b border-color px-3 py-1.5 gap-3 theme">
      <div className="flex items-center gap-3 min-w-0">
        <Logo />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IconEdit size="small" className="text-color-3 flex-none" />
            {editingTitle ? (
              <Input
                autoFocus
                size="small"
                defaultValue={name}
                className="w-64"
                onBlur={(e) => {
                  setWorkspaceName(e.target.value.trim() || 'Diagrama C4');
                  setEditingTitle(false);
                }}
                onEnterPress={(e) => {
                  setWorkspaceName((e.target as HTMLInputElement).value.trim() || 'Diagrama C4');
                  setEditingTitle(false);
                }}
              />
            ) : (
              <div className="text-xl font-medium truncate cursor-text hover-1 rounded px-1 -mx-1" onClick={() => !readOnly && setEditingTitle(true)} title="Renombrar diagrama">
                {name}
              </div>
            )}
            <Tag size="small" color="grey">
              C4 JSON v1.0
            </Tag>
            {readOnly && (
              <Tag size="small" color="orange">
                solo lectura
              </Tag>
            )}
            {projects && (
              <Tag size="small" color={attached ? 'blue' : 'grey'} onClick={() => projects.onManage()} className="cursor-pointer" data-testid="project-chip" aria-label="Abrir los proyectos">
                {openProject ? `Proyecto: ${openProject.name}${attached ? ` › ${attached.name}` : ''}` : 'Sin proyecto'}
                {remote ? ' · servidor' : ''}
              </Tag>
            )}
          </div>
          <div className="flex items-center gap-1 -ml-1">
            <Menu label="Archivo" items={fileMenu} />
            <Menu label="Editar" items={editMenu} />
            <Menu label="Ver" items={viewMenu} />
            <Menu label="Ajustes" items={settingsMenu} />
            <Menu label="Ayuda" items={helpMenu} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-none">
        {rejected && (
          <Button size="small" type="warning" onClick={() => projects?.onManage('storage')} data-testid="reconnect">
            {withSession ? 'Iniciar sesión' : 'Volver a conectar'}
          </Button>
        )}
        {forbidden && !withSession && (
          <Button size="small" type="warning" onClick={() => projects?.onManage('storage')} data-testid="reconnect">
            Cambiar de token
          </Button>
        )}
        {canHistory && (
          <Button size="small" onClick={() => projects?.onHistory?.()} aria-haspopup="dialog" data-testid="history-open">
            Historial…
          </Button>
        )}
        {remote && attached && projectState?.save === 'error' && projectState.saveErrorCode !== 'unauthorized' && (
          <Button size="small" onClick={() => void projectSession?.retry()} data-testid="retry-save">
            Reintentar
          </Button>
        )}
        {attached && projectState?.save === 'conflict' && (
          <span className="flex items-center gap-2 text-sm" role="alert" data-testid="save-conflict">
            {remote ? 'Otra persona u otro equipo guardó' : 'Otra pestaña guardó'} «{attached.name}» mientras lo editabas.
            <Button size="small" onClick={() => resolveConflict('overwrite')}>
              Quedarme con mi versión
            </Button>
            <Button size="small" onClick={() => resolveConflict('reload')}>
              Cargar la otra
            </Button>
          </span>
        )}
        <span className="text-sm text-color-2 hidden md:inline" role="status" data-testid="save-status" data-save={attached ? projectState?.save : undefined}>
          {status}
        </span>
        {isEmbedMode ? (
          <>
            <Tooltip content="Cerrar sin guardar">
              <Button icon={<IconExit />} theme="borderless" aria-label="Salir" onClick={onEmbedExit}>
                Salir
              </Button>
            </Tooltip>
            <Button icon={<IconSave />} aria-label="Guardar" onClick={() => onEmbedSave?.(false)} disabled={readOnly}>
              Guardar
            </Button>
            <Button icon={<IconSave />} theme="solid" type="primary" aria-label="Guardar y salir" onClick={() => onEmbedSave?.(true)} disabled={readOnly}>
              Guardar y salir
            </Button>
          </>
        ) : (
          <Button icon={<IconDownload />} theme="solid" type="primary" size="large" className="!rounded-md" aria-label="Exportar .drawio" onClick={() => void actions.exportDrawio()}>
            Exportar .drawio
          </Button>
        )}
      </div>
      <AboutModal visible={showAbout} onClose={() => setShowAbout(false)} />
      <ShortcutsModal visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <MermaidPreviewModal visible={showMermaid} onClose={() => setShowMermaid(false)} />
    </header>
  );
}
