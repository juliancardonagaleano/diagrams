import { Button, Dropdown, Input, Modal, Tag, Toast, Tooltip } from '@douyinfe/semi-ui';
import { IconDownload, IconEdit, IconExit, IconSave } from '@douyinfe/semi-icons';
import { useEffect, useRef, useState } from 'react';
import { useActions } from '../../hooks/useActions';
import { isEmbedMode, useDocumentStore, useTemporalStore } from '../../store/documentStore';
import { relativeTime } from '../../utils/files';
import { AboutModal, ShortcutsModal } from './HelpModals';
import { MermaidPreviewModal } from './MermaidPreviewModal';
import { NewerVersionNotice } from '../../../projects/NewerVersionNotice';
import { OfflineActions } from '../../../projects/OfflineActions';
import { offlineIndicator } from '../../../projects/offlineText';
import { C4_MODULE, type ProjectBinding } from '../../projects/useProjectBinding';
import { DIRECTIONS, DISTRIBUTIONS } from './FloatingToolbar';
import { LanguageSelect, useT } from '../../../i18n/react';

const Logo = () => (
  <div className="flex items-center gap-2 select-none" aria-hidden="true">
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
  const trigger = useRef<HTMLButtonElement>(null);
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
                  // El foco vuelve al botón del menú antes de actuar (WCAG 2.4.3): si la opción abre un diálogo, al cerrarlo el foco regresa
                  // aquí y no a una opción del menú que ya no se ve.
                  trigger.current?.focus();
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
      <button type="button" ref={trigger} className="c4-menu-item hover-2" aria-haspopup="menu" aria-expanded={open}>
        {label}
      </button>
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

const SAVE_KEY = { idle: 'ed.save.saved', pending: 'ed.save.saving', saving: 'ed.save.saving', saved: 'ed.save.saved', error: 'ed.save.error', conflict: 'ed.save.conflict', offline: 'ed.save.offline' } as const;

export function ControlPanel({ onEmbedSave, onEmbedExit, projects }: ControlPanelProps) {
  const { t } = useT();
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
  // Al terminar de renombrar, el foco vuelve al botón del título (WCAG 2.4.3).
  const titleButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editingTitle) titleButton.current?.focus();
    wasEditing.current = editingTitle;
  }, [editingTitle]);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMermaid, setShowMermaid] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(timer);
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
        title: t('ed.replace.title'),
        content: t('ed.replace.content', { diagram: attached.name, project: openProject.name }),
        okText: t('ed.replace.ok'),
        cancelText: t('common.cancel'),
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
      title: t('ed.discard.title'),
      content: t('ed.discard.content'),
      okText: t('ed.discard.ok'),
      cancelText: t('common.cancel'),
      okType: 'danger',
      onOk: proceed,
    });
  };

  const saveToProject = (): void => {
    if (!projectSession || !openProject) return;
    const { module, text, name: docName } = projects!.binding.current();
    void projectSession
      .createDiagram({ module, name: docName, text })
      .then((meta) => Toast.success(t('ed.savedToProject', { name: meta.name, project: openProject.name })))
      .catch((error: Error) => Toast.error(error.message));
  };

  const projectItems: MenuProps['items'] = projects
    ? [
        { key: 'projects', label: t('ed.f.projects'), onClick: () => projects.onManage(), closeMenu: true },
        ...(openProject && !attached ? [{ key: 'save-project', label: t('ed.f.saveInProject', { project: openProject.name }), onClick: saveToProject }] : []),
        ...(canHistory ? [{ key: 'history', label: t('ed.f.history'), onClick: () => projects.onHistory?.(), closeMenu: true }] : []),
        ...(attached ? [{ key: 'detach-project', label: t('ed.f.detach'), onClick: () => void projectSession?.release() }] : []),
        { key: 'dp', label: '', divider: true },
      ]
    : [];

  const fileMenu: MenuProps['items'] = isEmbedMode
    ? [
        { key: 'save', label: t('ed.f.save'), onClick: () => onEmbedSave?.(false), shortcut: 'Ctrl+S' },
        { key: 'save-exit', label: t('ed.f.saveExit'), onClick: () => onEmbedSave?.(true) },
        { key: 'd1', label: '', divider: true },
        { key: 'export', label: t('ed.f.exportC4More'), onClick: () => void actions.exportDrawio('c4') },
        { key: 'export-card', label: t('ed.f.exportCardMore'), onClick: () => void actions.exportDrawio('card') },
        { key: 'export-mermaid', label: t('ed.f.exportMermaidMore'), onClick: () => void actions.exportMermaid('c4') },
        { key: 'preview-mermaid', label: t('ed.f.previewMermaid'), onClick: () => setShowMermaid(true), closeMenu: true },
        { key: 'json', label: t('ed.f.downloadJson'), onClick: actions.saveJson },
        { key: 'd2', label: '', divider: true },
        { key: 'exit', label: t('ed.f.exitNoSave'), onClick: onEmbedExit },
      ]
    : [
        ...projectItems,
        { key: 'new', label: t('ed.f.new'), onClick: () => confirmDiscard(newDocument) },
        { key: 'sample', label: t('ed.f.sample'), onClick: () => confirmDiscard(loadSample) },
        { key: 'open', label: t('ed.f.openJson'), onClick: () => confirmDiscard(actions.openJson), shortcut: 'Ctrl+O' },
        { key: 'import-drawio', label: t('ed.f.importDrawio'), onClick: () => confirmDiscard(actions.importDrawio) },
        { key: 'import-dsl', label: t('ed.f.importDsl'), onClick: () => confirmDiscard(actions.importDsl) },
        { key: 'import-mermaid', label: t('ed.f.importMermaid'), onClick: () => confirmDiscard(actions.importMermaid) },
        { key: 'd1', label: '', divider: true },
        { key: 'save', label: t('ed.f.saveJson'), onClick: actions.saveJson, shortcut: 'Ctrl+S' },
        { key: 'export', label: t('ed.f.exportC4'), onClick: () => void actions.exportDrawio('c4'), shortcut: 'Ctrl+E' },
        { key: 'export-card', label: t('ed.f.exportCard'), onClick: () => void actions.exportDrawio('card') },
        { key: 'export-mermaid', label: t('ed.f.exportMermaid'), onClick: () => void actions.exportMermaid('c4') },
        { key: 'export-mermaid-flow', label: t('ed.f.exportMermaidFlow'), onClick: () => void actions.exportMermaid('flowchart') },
        { key: 'copy-mermaid', label: t('ed.f.copyMermaid'), onClick: () => void actions.exportMermaid('c4', 'clipboard') },
        { key: 'preview-mermaid', label: t('ed.f.previewMermaid'), onClick: () => setShowMermaid(true), closeMenu: true },
      ];

  const editMenu: MenuProps['items'] = [
    { key: 'undo', label: t('ed.e.undo'), onClick: actions.undo, disabled: pastStates === 0 || readOnly, shortcut: 'Ctrl+Z' },
    { key: 'redo', label: t('ed.e.redo'), onClick: actions.redo, disabled: futureStates === 0 || readOnly, shortcut: 'Ctrl+Y' },
    { key: 'd1', label: '', divider: true },
    { key: 'delete', label: t('ed.e.delete'), onClick: actions.deleteSelection, disabled: selection.kind === 'none' || readOnly, shortcut: t('ed.e.deleteKey') },
    { key: 'd2', label: '', divider: true },
    { key: 'layout', label: t('ed.e.layout'), onClick: () => void actions.autoLayout(), disabled: readOnly, shortcut: 'Ctrl+L' },
  ];

  const viewMenu: MenuProps['items'] = [
    { key: 'header', label: t('ed.v.header'), checked: ui.showHeader, onClick: () => setUi({ showHeader: !ui.showHeader }) },
    { key: 'sidebar', label: t('ed.v.sidebar'), checked: ui.showSidebar, onClick: () => setUi({ showSidebar: !ui.showSidebar }) },
    { key: 'issues', label: t('ed.v.issues'), checked: ui.showIssues, onClick: () => setUi({ showIssues: !ui.showIssues }) },
    { key: 'd1', label: '', divider: true },
    { key: 'grid', label: t('ed.v.grid'), checked: ui.showGrid, onClick: () => setUi({ showGrid: !ui.showGrid }) },
    { key: 'minimap', label: t('ed.v.minimap'), checked: ui.showMinimap, onClick: () => setUi({ showMinimap: !ui.showMinimap }) },
    { key: 'd2', label: '', divider: true },
    { key: 'theme', label: t('ed.v.dark'), checked: ui.theme === 'dark', onClick: () => setUi({ theme: ui.theme === 'dark' ? 'light' : 'dark' }) },
    { key: 'd3', label: '', divider: true },
    { key: 'style-c4', label: t('ed.v.styleC4'), checked: ui.nodeStyle === 'c4', onClick: () => setUi({ nodeStyle: 'c4' }) },
    { key: 'style-card', label: t('ed.v.styleCard'), checked: ui.nodeStyle === 'card', onClick: () => setUi({ nodeStyle: 'card' }) },
  ];

  const settingsMenu: MenuProps['items'] = [
    ...DIRECTIONS.map((d) => ({
      key: `dir-${d.value}`,
      label: t('ed.s.direction', { value: d.label }),
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
      label: t('ed.s.density', { value: d === 'auto' ? t('ed.s.density.auto') : d === 'compact' ? t('ed.s.density.compact') : t('ed.s.density.spacious') }),
      checked: ui.density === d,
      onClick: () => setUi({ density: d }),
    })),
  ];

  const helpMenu: MenuProps['items'] = [
    { key: 'shortcuts', label: t('ed.h.shortcuts'), onClick: () => setShowShortcuts(true) },
    { key: 'about', label: t('ed.h.about'), onClick: () => setShowAbout(true) },
    { key: 'c4', label: t('ed.h.c4'), onClick: () => window.open('https://c4model.com', '_blank', 'noopener') },
  ];

  // Con un servidor el estado lo dice («· servidor») y un token rechazado se avisa aparte, con el botón para volver a conectar.
  const remote = projectSession?.remote === true;
  const rejected =
    remote && !!projectState && (projectState.errorCode === 'unauthorized' || projectState.syncErrorCode === 'unauthorized' || projectState.saveErrorCode === 'unauthorized');
  const forbidden = remote && !rejected && projectState?.saveErrorCode === 'forbidden';
  // Con una sesión de persona (inicio de sesión de GitHub) no se «rechaza un token»: la sesión caducó, y un 403 es el rol en el proyecto, no un token que cambiar.
  const withSession = projectSession?.credential === 'session';
  const rejectedText = withSession ? t('bar.status.sessionExpired') : t('bar.status.tokenRejected');
  // Con un servidor, el trabajo sin conexión y los conflictos tienen su propio texto y su propia resolución (tres salidas, con confirmación).
  const indicator = projectState ? offlineIndicator(projectState) : undefined;
  const queuedConflict = (projectState?.offline?.conflicts ?? 0) > 0;
  const projectStatus = indicator
    ? indicator.text
    : remote && projectState && !projectState.available
      ? projectState.errorCode === 'unauthorized'
        ? rejectedText
        : t('bar.status.serverDown')
      : attached && projectState
        ? projectState.save === 'error' && projectState.saveErrorCode === 'unauthorized'
          ? rejectedText
          : projectState.save === 'error' && projectState.saveErrorCode === 'forbidden'
            ? t('ed.save.forbidden')
            : projectState.save === 'saved' || projectState.save === 'idle'
              ? t(remote ? 'ed.save.savedInServer' : 'ed.save.savedIn', { state: t(SAVE_KEY[projectState.save]), project: openProject?.name ?? '' })
              : t(SAVE_KEY[projectState.save])
        : undefined;
  const chipText = openProject ? (attached ? t('ed.chip.projectDiagram', { project: openProject.name, diagram: attached.name }) : t('ed.chip.project', { project: openProject.name })) : t('ed.chip.none');
  const projectChip = remote ? t('ed.chip.server', { text: chipText }) : chipText;
  const status = statusMessage ?? projectStatus ?? (modified ? t('ed.save.unsaved') : relativeTime(lastSavedAt));

  return (
    <header className="flex justify-between items-center border-b border-color px-3 py-1.5 gap-3 theme">
      <a
        className="c4-skip"
        href="#c4-lienzo"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('c4-lienzo')?.focus();
        }}
      >
        {t('ed.skip')}
      </a>
      <div className="flex items-center gap-3 min-w-0">
        <Logo />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <IconEdit size="small" className="text-color-3 flex-none" />
            {editingTitle ? (
              <Input
                autoFocus
                size="small"
                aria-label={t('ed.diagramName')}
                defaultValue={name}
                className="w-64"
                onBlur={(e) => {
                  setWorkspaceName(e.target.value.trim() || t('ed.defaultName'));
                  setEditingTitle(false);
                }}
                onEnterPress={(e) => {
                  setWorkspaceName((e.target as HTMLInputElement).value.trim() || t('ed.defaultName'));
                  setEditingTitle(false);
                }}
              />
            ) : (
              <h1 className="m-0 min-w-0 text-xl font-medium truncate">
                <button type="button" ref={titleButton} className="c4-title-button cursor-text hover-1 rounded px-1 -mx-1" onClick={() => !readOnly && setEditingTitle(true)} title={readOnly ? undefined : t('ed.renameDiagram')} aria-disabled={readOnly || undefined}>
                  {name}
                </button>
              </h1>
            )}
            <Tag size="small" color="grey">
              C4 JSON v1.0
            </Tag>
            {readOnly && (
              <Tag size="small" color="orange">
                {t('ed.readOnly')}
              </Tag>
            )}
            {projects && (
              <Tag size="small" color={attached ? 'blue' : 'grey'} onClick={() => projects.onManage()} className="cursor-pointer" data-testid="project-chip" aria-label={t('ed.openProjects')}>
                {projectChip}
              </Tag>
            )}
          </div>
          <div className="flex items-center gap-1 -ml-1">
            <Menu label={t('ed.menu.file')} items={fileMenu} />
            <Menu label={t('ed.menu.edit')} items={editMenu} />
            <Menu label={t('ed.menu.view')} items={viewMenu} />
            <Menu label={t('ed.menu.settings')} items={settingsMenu} />
            <Menu label={t('ed.menu.help')} items={helpMenu} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-none">
        {rejected && (
          <Button size="small" type="warning" onClick={() => projects?.onManage('storage')} data-testid="reconnect">
            {withSession ? t('ed.signIn') : t('ed.reconnect')}
          </Button>
        )}
        {forbidden && !withSession && (
          <Button size="small" type="warning" onClick={() => projects?.onManage('storage')} data-testid="reconnect">
            {t('ed.changeToken')}
          </Button>
        )}
        {canHistory && (
          <Button size="small" onClick={() => projects?.onHistory?.()} aria-haspopup="dialog" data-testid="history-open">
            {t('ed.historyButton')}
          </Button>
        )}
        {remote && attached && projectState?.save === 'error' && projectState.saveErrorCode !== 'unauthorized' && (
          <Button size="small" onClick={() => void projectSession?.retry()} data-testid="retry-save">
            {t('common.retry')}
          </Button>
        )}
        {remote && projectSession && <OfflineActions session={projectSession} resolve={(choice, key, name) => projects!.binding.resolveConflict(choice, { key, name })} />}
        {remote && attached && projectSession && <NewerVersionNotice session={projectSession} load={() => projects!.binding.loadNewer()} notify={(message) => Toast.error(message)} />}
        {attached && projectState?.save === 'conflict' && !queuedConflict && (
          <span className="flex items-center gap-2 text-sm" role="alert" data-testid="save-conflict">
            {remote ? t('ed.conflict.remote', { name: attached.name }) : t('ed.conflict.local', { name: attached.name })}
            <Button size="small" onClick={() => resolveConflict('overwrite')}>
              {t('ed.conflict.keepMine')}
            </Button>
            <Button size="small" onClick={() => resolveConflict('reload')}>
              {t('ed.conflict.loadOther')}
            </Button>
          </span>
        )}
        <span
          className={indicator ? 'c4-save-note text-sm' : 'text-sm text-color-2 hidden md:inline'}
          role="status"
          data-testid="save-status"
          data-save={indicator ? indicator.kind : attached ? projectState?.save : undefined}
          data-live={remote ? (projectState?.eventsState ?? 'off') : undefined}
        >
          {status}
        </span>
        {!isEmbedMode && <LanguageSelect className="iark-lang c4-lang" />}
        {isEmbedMode ? (
          <>
            <Tooltip content={t('ed.exitTip')}>
              <Button icon={<IconExit />} theme="borderless" aria-label={t('ed.exit')} onClick={onEmbedExit}>
                {t('ed.exit')}
              </Button>
            </Tooltip>
            <Button icon={<IconSave />} aria-label={t('ed.f.save')} onClick={() => onEmbedSave?.(false)} disabled={readOnly}>
              {t('ed.f.save')}
            </Button>
            <Button icon={<IconSave />} theme="solid" type="primary" aria-label={t('ed.f.saveExit')} onClick={() => onEmbedSave?.(true)} disabled={readOnly}>
              {t('ed.f.saveExit')}
            </Button>
          </>
        ) : (
          <Button icon={<IconDownload />} theme="solid" type="primary" size="large" className="!rounded-md" aria-label={t('ed.exportDrawio')} onClick={() => void actions.exportDrawio()}>
            {t('ed.exportDrawio')}
          </Button>
        )}
      </div>
      <AboutModal visible={showAbout} onClose={() => setShowAbout(false)} />
      <ShortcutsModal visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <MermaidPreviewModal visible={showMermaid} onClose={() => setShowMermaid(false)} />
    </header>
  );
}
