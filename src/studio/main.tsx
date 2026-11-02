import '@iark/kernel/jitless';
import React, { useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import '@douyinfe/semi-ui/lib/es/_base/base.css';
import '../modules-app/workbench.css';
import '../app/styles.css';
import { WorkbenchController } from '../modules-app/controller';
import { localDrafts, MODULE_SOURCES } from '../modules-app/modules';
import { MODULE_PROTOCOL_VERSION } from '../embed/moduleProtocol';
import { getProjectSession } from '../projects/factory';
import { initLang } from '../i18n';
import StudioApp from './StudioApp';

initLang();

const params = new URLSearchParams(window.location.search);
const moduleParam = params.get('module') ?? (params.get('editor') === '1' ? 'c4' : undefined);
const projectParam = params.get('project') ?? undefined;
const diagramParam = params.get('diagram') ?? undefined;

function Root() {
  const projects = useMemo(() => getProjectSession(), []);
  const controller = useMemo(
    () => new WorkbenchController(MODULE_SOURCES, { storage: localDrafts, protocol: MODULE_PROTOCOL_VERSION, projects }),
    [projects],
  );

  useEffect(() => {
    const requested = params.get('theme');
    document.body.setAttribute('theme-mode', requested === 'dark' ? 'dark' : 'light');
    const fallback = (): Promise<void> => controller.selectModule(moduleParam && controller.moduleIds.includes(moduleParam) ? moduleParam : controller.moduleIds[0]);
    void (async () => {
      const last = await projects.init();
      if (projectParam && diagramParam && projects.getState().projects.some((project) => project.id === projectParam)) {
        await controller.openDiagram(projectParam, diagramParam);
      } else if (!moduleParam && last?.projectId) {
        if (last.diagramId) await controller.openDiagram(last.projectId, last.diagramId);
        else await controller.enterProject(last.projectId);
      }
      if (!controller.getState().moduleId) await fallback();
    })();
    const flush = (): void => void projects.flush();
    const guard = (event: BeforeUnloadEvent): void => {
      if (projects.dirty) event.preventDefault();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
    window.addEventListener('beforeunload', guard);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', guard);
    };
  }, [controller, projects]);

  return <StudioApp controller={controller} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
