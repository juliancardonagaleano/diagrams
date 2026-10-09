import { useState, useSyncExternalStore } from 'react';
import { projectErrorText } from '../i18n/errores';
import { useT } from '../i18n/react';
import { HistoryDialog } from '../projects/lazy';
import { NewerVersionNotice } from '../projects/NewerVersionNotice';
import { OfflineActions } from '../projects/OfflineActions';
import { offlineIndicator } from '../projects/offlineText';
import type { WorkbenchController, WorkbenchState } from './controller';

/**
 * Barra del proyecto abierto: cuál es, qué diagrama se está editando, cómo va el guardado y cómo abrir el gestor.
 * Con un diagrama abierto, sus cambios se guardan solos; sin él, el documento es un borrador y se ofrece guardarlo. Con un diagrama abierto en un
 * almacén que guarda versiones, «Historial…» abre el historial de versiones de ese diagrama (ver, comparar, restaurar y nombrar).
 */
export function ProjectBar({
  controller,
  state,
  onManage,
  notify,
}: {
  controller: WorkbenchController;
  state: WorkbenchState;
  /** Abre el gestor; con `storage`, directamente en «Dónde se guardan» (para volver a conectar con el servidor). */
  onManage(panel?: 'storage'): void;
  notify(message: string): void;
}) {
  const { t } = useT();
  const session = controller.projects!;
  const projects = useSyncExternalStore(session.subscribe, session.getState);
  const [showHistory, setShowHistory] = useState(false);
  const project = projects.projects.find((p) => p.id === projects.projectId);
  const moduleLabel = (id: string): string => controller.sources.find((s) => s.id === id)?.label ?? id;
  const attached = project?.diagrams.find((d) => d.id === projects.diagramId);
  const draft = !!project && !attached && !!controller.currentDocument();
  const remote = session.remote;
  const where = remote ? ` · ${t('bar.status.onServer')}` : '';
  const rejected = projects.errorCode === 'unauthorized' || projects.syncErrorCode === 'unauthorized' || projects.saveErrorCode === 'unauthorized';
  const forbidden = projects.saveErrorCode === 'forbidden';
  // Con una sesión de persona (inicio de sesión de GitHub) no se «rechaza un token»: la sesión caducó, y un 403 es el rol en el proyecto, no un token que cambiar.
  const withSession = session.credential === 'session';
  const rejectedText = withSession ? t('bar.status.sessionExpired') : t('bar.status.tokenRejected');
  const run = (work: () => Promise<void>): void => void work().catch((error: Error) => notify(projectErrorText(error)));
  // Con un servidor, el trabajo sin conexión y los conflictos tienen su propio texto y su propia resolución (tres salidas, con confirmación).
  const indicator = offlineIndicator(projects);
  const queuedConflict = (projects.offline?.conflicts ?? 0) > 0;
  const statusText = !projects.available
    ? remote
      ? projects.errorCode === 'unauthorized'
        ? rejectedText
        : t('bar.status.serverDown')
      : t('bar.status.storageDown')
    : attached
      ? projects.save === 'pending' || projects.save === 'saving'
        ? t('bar.status.saving')
        : projects.save === 'error'
          ? projects.saveErrorCode === 'unauthorized'
            ? withSession
              ? t('bar.status.rejectedSession')
              : t('bar.status.rejectedToken', { detail: projects.saveError ?? t('bar.status.notSaved') })
            : projects.saveErrorCode === 'forbidden'
              ? t('bar.status.forbidden', { detail: projects.saveError ?? t('bar.status.forbiddenDetail') })
              : t('bar.status.failed', { detail: projects.saveError ?? t('bar.status.unknownError') })
          : projects.save === 'conflict'
            ? t('bar.status.conflict')
            : `${t('bar.status.saved', { name: project?.name ?? '' })}${where}${projects.syncError ? ` (${t('bar.status.syncLost')})` : ''}`
      : draft
        ? t('bar.status.draft')
        : '';

  const byModule = new Map<string, NonNullable<typeof project>['diagrams']>();
  for (const d of project?.diagrams ?? []) byModule.set(d.module, [...(byModule.get(d.module) ?? []), d]);

  const bar = (
    <div className="wb-projectbar" role="region" aria-label={t('bar.region')} data-testid="project-bar" data-live={projects.eventsState ?? 'off'}>
      <label>
        {t('bar.project')}
        <select aria-label={t('bar.project')} value={projects.projectId ?? ''} onChange={(e) => run(() => controller.enterProject(e.target.value || undefined))} disabled={!projects.available}>
          <option value="">{t('bar.noProject')}</option>
          {projects.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <label>
          {t('bar.diagram')}
          <select
            aria-label={t('bar.diagram')}
            value={attached?.id ?? ''}
            onChange={(e) => e.target.value && run(() => controller.openDiagram(project.id, e.target.value))}
            disabled={project.diagrams.length === 0 && !draft}
          >
            {!attached && <option value="">{project.diagrams.length === 0 ? t('bar.noDiagrams') : t('bar.draftOption')}</option>}
            {[...byModule].map(([module, list]) => (
              <optgroup key={module} label={moduleLabel(module)}>
                {list.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <button type="button" onClick={() => onManage()} disabled={!projects.available && projects.projects.length === 0 && !projects.error}>
        {t('bar.manage')}
      </button>
      {attached && session.canVersion && (
        <button type="button" onClick={() => setShowHistory(true)} aria-haspopup="dialog" data-testid="history-open">
          {t('bar.history')}
        </button>
      )}
      {draft && project && (
        <button type="button" className="primary" onClick={() => run(() => controller.saveToProject())} data-testid="save-to-project">
          {t('bar.saveTo', { name: project.name })}
        </button>
      )}
      <span className="wb-save" role="status" data-testid="save-status" data-save={indicator ? indicator.kind : attached ? projects.save : draft ? 'draft' : 'none'}>
        {indicator ? indicator.text : statusText}
      </span>
      {rejected && remote && (
        <button type="button" className="primary" onClick={() => onManage('storage')} data-testid="reconnect">
          {withSession ? t('bar.signIn') : t('bar.reconnect')}
        </button>
      )}
      {forbidden && remote && !rejected && !withSession && (
        <button type="button" onClick={() => onManage('storage')} data-testid="reconnect">
          {t('bar.changeToken')}
        </button>
      )}
      {attached && projects.save === 'error' && projects.saveErrorCode !== 'unauthorized' && (
        <button type="button" onClick={() => run(() => session.retry())}>
          {t('common.retry')}
        </button>
      )}
      {remote && <OfflineActions session={session} resolve={(choice, key, name) => controller.resolveConflict(choice, { key, name })} />}
      {remote && attached && <NewerVersionNotice session={session} load={() => controller.loadNewer()} notify={notify} />}
      {attached && projects.save === 'conflict' && !queuedConflict && (
        <span className="wb-conflict" role="alert" data-testid="save-conflict">
          {remote ? t('bar.conflict.remote', { name: attached.name }) : t('bar.conflict.local', { name: attached.name })}
          <button type="button" onClick={() => run(() => controller.resolveConflict('overwrite'))}>
            {t('bar.conflict.keep')}
          </button>
          <button type="button" onClick={() => run(() => controller.resolveConflict('reload'))}>
            {t('bar.conflict.reload')}
          </button>
        </span>
      )}
      {state.replaced && (
        <span className="wb-conflict" role="status" data-testid="replaced-note">
          {t('bar.replaced', { label: state.replaced.label })}
          <button type="button" onClick={() => controller.undoReplace()} data-testid="undo-replace">
            {t('bar.undo')}
          </button>
          <button type="button" onClick={() => controller.dismissReplaced()} aria-label={t('bar.dismissNotice')}>
            ✕
          </button>
        </span>
      )}
    </div>
  );

  return (
    <>
      {bar}
      {showHistory && project && attached && (
        <HistoryDialog
          session={session}
          projectId={project.id}
          diagram={attached}
          loadModule={(id) => controller.loadModule(id)}
          onRestore={(versionId) => controller.restoreVersion(versionId)}
          onClose={() => setShowHistory(false)}
          notify={notify}
        />
      )}
    </>
  );
}
