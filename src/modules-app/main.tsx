// Antes que cualquier otro import (se crean esquemas de zod al cargarlos): sin el modo JIT de zod no hay violaciones de la CSP por `new Function`.
import '@iark/kernel/jitless';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './workbench.css';
import { Workbench } from './Workbench';
import { createModuleBridge, type ModuleBridge } from './bridge';
import { WorkbenchController } from './controller';
import { localDrafts, MODULE_SOURCES } from './modules';
import { currentHostOriginSources, resolveHostOrigin } from '../embed/hostOrigin';
import { MODULE_PROTOCOL_VERSION } from '../embed/moduleProtocol';
import { getProjectSession } from '../projects/factory';
import { completeGithubLogin } from '../projects/login';

/**
 * Banco de trabajo de los módulos de la suite (`modulos.html`). Con `?embed=1&proto=json&module=<id>&origin=<origen del
 * anfitrión>` habla el protocolo postMessage de `src/embed/moduleProtocol.ts`; sin él, es una página normal con borradores
 * en localStorage.
 */
const params = new URLSearchParams(window.location.search);
const embed = params.get('embed') === '1' && window.parent !== window;
const moduleParam = params.get('module') ?? undefined;
/** `?project=<id>&diagram=<id>`: abre ese diagrama de un proyecto (así enlaza el editor C4 a los diagramas de otros módulos). */
const projectParam = params.get('project') ?? undefined;
const diagramParam = params.get('diagram') ?? undefined;

/**
 * Origen del anfitrión: el que declara `origin`, o el de quien nos incrusta (`ancestorOrigins`, o el `referrer`). Nunca `*` ni un
 * origen opaco: el documento viaja en los eventos. Si el navegador no da ninguno, el del propio banco: solo lo oiría un anfitrión
 * del mismo origen, y un padre de otro origen no recibe nada.
 */
const hostOrigin = resolveHostOrigin(currentHostOriginSources()) ?? window.location.origin;

type Theme = 'light' | 'dark';
const preferredTheme = (): Theme => {
  const requested = params.get('theme');
  if (requested === 'light' || requested === 'dark') return requested;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
};

function Root() {
  // Los proyectos se guardan donde diga la configuración: en este navegador (IndexedDB) o en un servidor propio. En modo embebido guarda el anfitrión, no esta pantalla.
  const projects = useMemo(() => (embed ? undefined : getProjectSession()), []);
  const controller = useMemo(
    () => new WorkbenchController(MODULE_SOURCES, { storage: embed ? undefined : localDrafts, protocol: MODULE_PROTOCOL_VERSION, projects }),
    [projects],
  );
  const [ui, setUi] = useState<'full' | 'min'>(params.get('ui') === 'min' ? 'min' : 'full');
  const [dialog, setDialog] = useState<{ title: string; message: string; button?: string } | undefined>();
  const bridge = useRef<ModuleBridge | undefined>(undefined);

  useEffect(() => {
    applyTheme(preferredTheme());
    if (!embed) {
      const fallback = (): Promise<void> => controller.selectModule(moduleParam && controller.moduleIds.includes(moduleParam) ? moduleParam : controller.moduleIds[0]);
      void (async () => {
        const last = await projects?.init();
        // Un enlace a un diagrama manda; si no, se reabre lo último que se estaba editando (salvo que la URL pida un módulo).
        if (projects && projectParam && diagramParam && projects.getState().projects.some((p) => p.id === projectParam)) {
          await controller.openDiagram(projectParam, diagramParam);
        } else if (projects && !moduleParam && last?.projectId) {
          if (last.diagramId) await controller.openDiagram(last.projectId, last.diagramId);
          else await controller.enterProject(last.projectId);
        }
        if (!controller.getState().moduleId) await fallback();
      })();
      // Lo que esté pendiente se guarda al ocultar o cerrar la pestaña; si no pudo guardarse, se avisa antes de cerrar.
      const flush = (): void => void projects?.flush();
      const guard = (event: BeforeUnloadEvent): void => {
        if (projects?.dirty) event.preventDefault();
      };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
      window.addEventListener('beforeunload', guard);
      return () => {
        window.removeEventListener('pagehide', flush);
        window.removeEventListener('beforeunload', guard);
      };
    }
    const post = (event: unknown): void => window.parent.postMessage(JSON.stringify(event), hostOrigin);
    const instance = createModuleBridge({
      controller,
      post,
      module: moduleParam,
      configure: params.get('configure') === '1',
      onConfigure: (config) => {
        if (config.theme) applyTheme(config.theme);
        if (config.ui) setUi(config.ui);
      },
      onDialog: setDialog,
    });
    bridge.current = instance;
    const listener = (event: MessageEvent): void => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return;
      void instance.receive(event.data);
    };
    window.addEventListener('message', listener);
    void instance.start().catch((error) => post({ event: 'error', message: (error as Error).message }));
    return () => {
      window.removeEventListener('message', listener);
      instance.dispose();
    };
  }, [controller]);

  return (
    <Workbench
      controller={controller}
      embed={embed}
      ui={ui}
      dialog={dialog}
      onDismissDialog={() => setDialog(undefined)}
      onSave={(exit) => void bridge.current?.receive({ action: 'save', exit })}
      onExit={() => void bridge.current?.receive({ action: 'exit' })}
    />
  );
}

// Si la página acaba de volver de GitHub (`#iark_code=…`), la sesión se termina de crear **antes** de montar nada: la sesión de proyectos que
// crea `Root` lee la configuración al nacer. No espera nada si no se viene de un inicio de sesión; en modo embebido guarda el anfitrión.
void (embed ? Promise.resolve() : completeGithubLogin()).then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
