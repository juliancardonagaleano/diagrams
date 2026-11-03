import '@iark/kernel/jitless';
import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './workbench.css';
import { Workbench } from './Workbench';
import { createModuleBridge, type ModuleBridge, type RelatedHandlers } from './bridge';
import { WorkbenchController } from './controller';
import { localDrafts, MODULE_SOURCES } from './modules';
import { currentHostOriginSources, resolveHostOrigin } from '../embed/hostOrigin';
import { MODULE_PROTOCOL_VERSION } from '../embed/moduleProtocol';
import { getProjectSession } from '../projects/factory';
import { completeGithubLogin } from '../projects/login';
import { initLang } from '../i18n';
import type { ModuleSlotHost } from '../mfe/contract';

const StudioApp = lazy(() => import('../studio/StudioApp'));

export interface BootModuleRemoteOptions {
  moduleId: string;
  host?: ModuleSlotHost;
  search: URLSearchParams;
}

function Root({ moduleId, host, search }: BootModuleRemoteOptions) {
  const sources = useMemo(() => MODULE_SOURCES.filter((s) => s.id === moduleId), [moduleId]);
  const embed = search.get('embed') === '1' && window.parent !== window;
  const moduleParam = search.get('module') ?? moduleId;
  const projectParam = search.get('project') ?? host?.getContext().projectId;
  const diagramParam = search.get('diagram') ?? host?.getContext().diagramId;
  const hostOrigin = resolveHostOrigin(currentHostOriginSources()) ?? window.location.origin;

  const projects = useMemo(() => (embed ? undefined : getProjectSession()), [embed]);
  const controller = useMemo(
    () => new WorkbenchController(sources, { storage: embed ? undefined : localDrafts, protocol: MODULE_PROTOCOL_VERSION, projects }),
    [projects, sources],
  );
  const [ui, setUi] = useState<'full' | 'min'>(search.get('ui') === 'min' ? 'min' : 'full');
  const [dialog, setDialog] = useState<{ title: string; message: string; button?: string } | undefined>();
  const bridge = useRef<ModuleBridge | undefined>(undefined);
  const relatedRef = useRef<RelatedHandlers | undefined>(undefined);

  useEffect(() => {
    const theme = search.get('theme') ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'light';
    if (!embed) {
      void (async () => {
        const last = await projects?.init();
        if (projects && projectParam && diagramParam && projects.getState().projects.some((p) => p.id === projectParam)) {
          await controller.openDiagram(projectParam, diagramParam);
        } else if (projects && !search.get('module') && last?.projectId) {
          if (last.diagramId) await controller.openDiagram(last.projectId, last.diagramId);
          else await controller.enterProject(last.projectId);
        }
        if (!controller.getState().moduleId) await controller.selectModule(moduleId);
      })();
      const flush = (): void => void projects?.flush();
      const guard = (event: BeforeUnloadEvent): void => {
        if (projects?.dirty) event.preventDefault();
      };
      window.addEventListener('pagehide', flush);
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
      configure: search.get('configure') === '1',
      onConfigure: (config) => {
        if (config.theme) document.documentElement.dataset.theme = config.theme;
        if (config.ui) setUi(config.ui);
      },
      onDialog: setDialog,
      related: () => relatedRef.current,
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
  }, [controller, diagramParam, embed, host, moduleId, moduleParam, projectParam, projects, search]);

  if (!embed && search.get('bank') !== '1') {
    return (
      <Suspense fallback={null}>
        <StudioApp controller={controller} />
      </Suspense>
    );
  }

  return (
    <Workbench
      controller={controller}
      embed={embed}
      ui={ui}
      dialog={dialog}
      onDismissDialog={() => setDialog(undefined)}
      onSave={(exit) => void bridge.current?.receive({ action: 'save', exit })}
      onExit={() => void bridge.current?.receive({ action: 'exit' })}
      relatedRef={embed ? relatedRef : undefined}
    />
  );
}

let mountedRoot: ReactDOM.Root | undefined;

export function bootModuleRemote(options: BootModuleRemoteOptions): { unmount: () => void } {
  initLang();
  const container = document.getElementById('root');
  if (!container) throw new Error('Falta #root para montar el remoto.');
  mountedRoot?.unmount();
  mountedRoot = ReactDOM.createRoot(container);
  void (options.search.get('embed') === '1' ? Promise.resolve() : completeGithubLogin()).then(() => {
    mountedRoot!.render(
      <React.StrictMode>
        <Root {...options} />
      </React.StrictMode>,
    );
  });
  return { unmount: () => { mountedRoot?.unmount(); mountedRoot = undefined; } };
}
