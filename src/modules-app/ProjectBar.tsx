import { useSyncExternalStore } from 'react';
import type { WorkbenchController, WorkbenchState } from './controller';

/**
 * Barra del proyecto abierto: cuál es, qué diagrama se está editando, cómo va el guardado y cómo abrir el gestor.
 * Con un diagrama abierto, sus cambios se guardan solos; sin él, el documento es un borrador y se ofrece guardarlo.
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
  const session = controller.projects!;
  const projects = useSyncExternalStore(session.subscribe, session.getState);
  const project = projects.projects.find((p) => p.id === projects.projectId);
  const moduleLabel = (id: string): string => controller.sources.find((s) => s.id === id)?.label ?? id;
  const attached = project?.diagrams.find((d) => d.id === projects.diagramId);
  const draft = !!project && !attached && !!controller.currentDocument();
  const remote = session.remote;
  const where = remote ? ' · servidor' : '';
  const rejected = projects.errorCode === 'unauthorized' || projects.syncErrorCode === 'unauthorized' || projects.saveErrorCode === 'unauthorized';
  const forbidden = projects.saveErrorCode === 'forbidden';
  // Con una sesión de persona (inicio de sesión de GitHub) no se «rechaza un token»: la sesión caducó, y un 403 es el rol en el proyecto, no un token que cambiar.
  const withSession = session.credential === 'session';
  const rejectedText = withSession ? 'Tu sesión caducó' : 'El servidor no aceptó el token';
  const run = (work: () => Promise<void>): void => void work().catch((error: Error) => notify(error.message));

  const byModule = new Map<string, NonNullable<typeof project>['diagrams']>();
  for (const d of project?.diagrams ?? []) byModule.set(d.module, [...(byModule.get(d.module) ?? []), d]);

  return (
    <div className="wb-projectbar" role="region" aria-label="Proyecto" data-testid="project-bar">
      <label>
        Proyecto
        <select aria-label="Proyecto" value={projects.projectId ?? ''} onChange={(e) => run(() => controller.enterProject(e.target.value || undefined))} disabled={!projects.available}>
          <option value="">Sin proyecto (borrador)</option>
          {projects.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {project && (
        <label>
          Diagrama
          <select
            aria-label="Diagrama"
            value={attached?.id ?? ''}
            onChange={(e) => e.target.value && run(() => controller.openDiagram(project.id, e.target.value))}
            disabled={project.diagrams.length === 0 && !draft}
          >
            {!attached && <option value="">{project.diagrams.length === 0 ? 'Sin diagramas todavía' : 'Borrador (sin guardar en el proyecto)'}</option>}
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
        Proyectos…
      </button>
      {draft && project && (
        <button type="button" className="primary" onClick={() => run(() => controller.saveToProject())} data-testid="save-to-project">
          Guardar en «{project.name}»
        </button>
      )}
      <span className="wb-save" role="status" data-testid="save-status" data-save={attached ? projects.save : draft ? 'draft' : 'none'}>
        {!projects.available
          ? remote
            ? projects.errorCode === 'unauthorized'
              ? rejectedText
              : 'Servidor no disponible'
            : 'Almacenamiento no disponible'
          : attached
            ? projects.save === 'pending' || projects.save === 'saving'
              ? 'Guardando…'
              : projects.save === 'error'
                ? projects.saveErrorCode === 'unauthorized'
                  ? `${rejectedText}: ${withSession ? 'los últimos cambios no se han guardado' : (projects.saveError ?? 'no se guardaron los últimos cambios')}`
                  : projects.saveErrorCode === 'forbidden'
                    ? `Sin permiso para guardar en el servidor: ${projects.saveError ?? 'el rol de este token no lo permite'}`
                    : `No se pudo guardar: ${projects.saveError ?? 'error desconocido'}`
                : projects.save === 'conflict'
                  ? 'Hay un conflicto de guardado'
                  : `Guardado en «${project?.name}»${where}${projects.syncError ? ' (sin conexión con el servidor)' : ''}`
            : draft
              ? 'Borrador: aún no está en el proyecto'
              : ''}
      </span>
      {rejected && remote && (
        <button type="button" className="primary" onClick={() => onManage('storage')} data-testid="reconnect">
          {withSession ? 'Iniciar sesión' : 'Volver a conectar'}
        </button>
      )}
      {forbidden && remote && !rejected && !withSession && (
        <button type="button" onClick={() => onManage('storage')} data-testid="reconnect">
          Cambiar de token
        </button>
      )}
      {attached && projects.save === 'error' && projects.saveErrorCode !== 'unauthorized' && (
        <button type="button" onClick={() => run(() => session.retry())}>
          Reintentar
        </button>
      )}
      {attached && projects.save === 'conflict' && (
        <span className="wb-conflict" role="alert" data-testid="save-conflict">
          {remote ? 'Otra persona u otro equipo guardó' : 'Otra pestaña guardó'} «{attached.name}» mientras lo editabas.
          <button type="button" onClick={() => run(() => controller.resolveConflict('overwrite'))}>
            Quedarme con mi versión
          </button>
          <button type="button" onClick={() => run(() => controller.resolveConflict('reload'))}>
            Cargar la otra
          </button>
        </span>
      )}
      {state.replaced && (
        <span className="wb-conflict" role="status" data-testid="replaced-note">
          Se reemplazó el contenido de «{state.replaced.label}».
          <button type="button" onClick={() => controller.undoReplace()} data-testid="undo-replace">
            Deshacer
          </button>
          <button type="button" onClick={() => controller.dismissReplaced()} aria-label="Descartar aviso">
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
