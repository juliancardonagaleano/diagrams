import { Toast } from '@douyinfe/semi-ui';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { Canvas } from './components/canvas/Canvas';
import { Breadcrumb } from './components/header/Breadcrumb';
import { ControlPanel } from './components/header/ControlPanel';
import { FloatingToolbar } from './components/header/FloatingToolbar';
import { SidePanel } from './components/sidepanel/SidePanel';
import { useEmbedBridge } from './embed/useEmbedBridge';
import { useActions } from './hooks/useActions';
import { useProjectBinding } from './projects/useProjectBinding';
import { MODULE_SOURCES } from '../modules-app/modules';
import { getLoginNotice, setLoginNotice } from '../projects/login';
import { ProjectsDialog } from '../projects/ProjectsDialog';
import { isEmbedMode, useDocumentStore } from './store/documentStore';

const params = new URLSearchParams(window.location.search);

export default function App() {
  const ui = useDocumentStore((s) => s.ui);
  const setUi = useDocumentStore((s) => s.setUi);
  const embed = useEmbedBridge();
  const actions = useActions();
  const projects = useProjectBinding();
  /** El gestor de proyectos: cerrado, abierto, o abierto con «Dónde se guardan» desplegado (para volver a conectar). */
  // Si el inicio de sesión de GitHub no pudo terminar, se abre directamente «Dónde se guardan», que dice por qué y deja volver a intentarlo.
  const [showProjects, setShowProjects] = useState<false | 'list' | 'storage'>(() => (getLoginNotice()?.kind === 'error' ? 'storage' : false));

  // Al volver de iniciar sesión con GitHub, se confirma con un aviso (el error, en cambio, se queda en el panel hasta que la persona lo descarte).
  useEffect(() => {
    const login = getLoginNotice();
    if (login?.kind !== 'ok') return;
    Toast.success(login.message);
    setLoginNotice(undefined);
  }, []);

  // Tema (mecanismo nativo de Semi UI) + parámetros de URL.
  useEffect(() => {
    document.body.setAttribute('theme-mode', ui.theme);
  }, [ui.theme]);
  useEffect(() => {
    const theme = params.get('theme');
    if (theme === 'dark' || theme === 'light') setUi({ theme });
    if (params.get('ui') === 'min') setUi({ showHeader: false, showSidebar: false, showMinimap: false });
    const view = params.get('view');
    if (view && useDocumentStore.getState().doc.views.some((v) => v.id === view)) useDocumentStore.getState().setActiveView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Atajos de teclado globales.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) actions.redo();
        else actions.undo();
      } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        actions.redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isEmbedMode) void embed.save(false);
        else actions.saveJson();
      } else if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        void actions.exportDrawio();
      } else if (mod && e.key.toLowerCase() === 'o' && !isEmbedMode) {
        e.preventDefault();
        void actions.openJson();
      } else if (mod && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void actions.autoLayout();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        e.preventDefault();
        actions.deleteSelection();
      } else if (e.altKey && e.key === 'ArrowUp' && !typing) {
        e.preventDefault();
        useDocumentStore.getState().drillUp();
      } else if (e.altKey && e.key === 'ArrowDown' && !typing) {
        e.preventDefault();
        const sel = useDocumentStore.getState().selection;
        if (sel.kind === 'element') useDocumentStore.getState().drillDown(sel.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, embed]);

  return (
    <ReactFlowProvider>
      <div className="h-full flex flex-col overflow-hidden theme">
        {ui.showHeader && <ControlPanel onEmbedSave={(exit) => void embed.save(exit)} onEmbedExit={embed.exit} projects={projects.session ? { binding: projects, onManage: (panel) => setShowProjects(panel ?? 'list') } : undefined} />}
        <div className="flex h-full min-h-0 overflow-hidden">
          {ui.showSidebar && <SidePanel />}
          <div className="relative flex-1 min-w-0 h-full overflow-hidden">
            <Canvas />
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100%-24px)]">
              <FloatingToolbar onEmbedSave={(exit) => void embed.save(exit)} />
            </div>
            <div className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-24px)]">
              <Breadcrumb />
            </div>
          </div>
        </div>
        {showProjects && projects.session && (
          <ProjectsDialog
            session={projects.session}
            modules={MODULE_SOURCES.map((s) => ({ id: s.id, label: s.label }))}
            onOpen={projects.open}
            current={projects.current}
            template={async (id, kind) => {
              const source = MODULE_SOURCES.find((s) => s.id === id);
              return kind === 'blank' ? source?.blank?.() : source?.example?.();
            }}
            onClose={() => setShowProjects(false)}
            notify={(message) => Toast.info(message)}
            initialPanel={showProjects === 'storage' ? 'storage' : undefined}
          />
        )}
      </div>
    </ReactFlowProvider>
  );
}
