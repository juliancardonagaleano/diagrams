import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactElement } from 'react';
import { ProjectError, type DiagramMeta, type ProjectSummary } from '@iark/kernel';
import { downloadText } from '../modules-app/files';
import { loadBackend } from './backend';
import { copyProject, copyTargetFor, type CopyTarget } from './copy';
import { PROJECT_ROLE_HELP, PROJECT_ROLE_LABEL } from './people';
import type { ProjectSession } from './session';
import { ShareDialog } from './ShareDialog';
import { StoragePanel, type StoragePanelProps } from './StoragePanel';
import './projects.css';

export type TemplateKind = 'example' | 'blank';

export interface ProjectsDialogProps {
  session: ProjectSession;
  /** Módulos entre los que se puede elegir al crear un diagrama. */
  modules: Array<{ id: string; label: string }>;
  /** Abre el diagrama en el editor de esta pantalla (o lleva a donde se edita). Después se cierra el diálogo. */
  onOpen(projectId: string, diagram: DiagramMeta): void | Promise<void>;
  /** El documento que se está editando, para ofrecer «Guardar el documento actual en este proyecto». */
  current?(): { module: string; text: string; name?: string } | undefined;
  /** Texto con el que empieza un diagrama nuevo; `undefined` si el módulo no ofrece esa plantilla. */
  template?(moduleId: string, kind: TemplateKind): Promise<string | undefined>;
  onClose(): void;
  notify?(message: string): void;
  /** Abre el diálogo con «Dónde se guardan» desplegado (para volver a conectar cuando el servidor no aceptó el token). */
  initialPanel?: 'storage';
  /** A dónde ofrece copiar el proyecto. Por defecto, el otro almacén (este navegador si hay servidor; el servidor conocido si no). */
  copyTarget?: CopyTarget;
  /** Ajustes de «Dónde se guardan» (las pruebas ponen un `fetch` simulado, otros almacenes del navegador o una recarga falsa). */
  storage?: Pick<StoragePanelProps, 'fetch' | 'areas' | 'page' | 'reload' | 'startLogin' | 'detect'>;
}

const agoFormat = (iso: string): string => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return 'hace un momento';
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `hace ${Math.round(seconds / 3600)} h`;
  return new Date(time).toLocaleDateString('es');
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

type Target = { kind: 'project' | 'diagram'; id: string };

/**
 * Gestor de proyectos: lista, crea, renombra, borra, exporta e importa proyectos y abre, crea, renombra, duplica y borra sus
 * diagramas. Es el mismo en el banco de trabajo y en el editor C4; no conoce a ninguno de los dos (solo a la sesión).
 */
export function ProjectsDialog({ session, modules, onOpen, current, template, onClose, notify, initialPanel, copyTarget, storage }: ProjectsDialogProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const { projects } = state;
  const remote = session.remote;
  const host = session.backend.kind === 'remote' ? session.backend.host : undefined;
  const [selectedId, setSelectedId] = useState<string | undefined>(state.projectId ?? projects[0]?.id);
  const selected: ProjectSummary | undefined = projects.find((p) => p.id === selectedId) ?? projects[0];
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<(Target & { value: string }) | undefined>();
  const [confirming, setConfirming] = useState<Target | undefined>();
  const [newProject, setNewProject] = useState('');
  const [newDiagram, setNewDiagram] = useState({ module: modules[0]?.id ?? '', name: '', template: 'example' as TemplateKind });
  const [saveName, setSaveName] = useState('');
  const [note, setNote] = useState<string | undefined>();
  const rejected = state.errorCode === 'unauthorized' || state.syncErrorCode === 'unauthorized' || state.saveErrorCode === 'unauthorized';
  const [storageOpen, setStorageOpen] = useState(initialPanel === 'storage' || (remote && rejected));
  /** El proyecto que se quería copiar a un servidor aún no conectado (o que lo rechazó): el panel ofrece copiarlo al conectar. */
  const [copyIntent, setCopyIntent] = useState<{ id: string; name: string } | undefined>();
  const [serverVersion, setServerVersion] = useState(0);
  /** El proyecto que se está compartiendo (el cuadro «Compartir…» abierto) y el de «¿Salir del proyecto?» pendiente de confirmar. */
  const [sharing, setSharing] = useState<string | undefined>();
  const [leaving, setLeaving] = useState<string | undefined>();
  const shareButton = useRef<HTMLButtonElement>(null);
  /** Hay una copia a otro almacén en curso: sus errores son del otro servidor, no de este. */
  const copying = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const moduleLabel = useMemo(() => new Map(modules.map((m) => [m.id, m.label])), [modules]);
  const live = current?.();

  useEffect(() => {
    // Si el panel ya llevó el foco a su campo (el servidor rechazó el token: abre directamente en el token), se respeta.
    if (dialogRef.current?.contains(document.activeElement)) return;
    dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, []);
  // Con un servidor, mientras el gestor está abierto la lista se mantiene al día (no hay aviso entre equipos); lee al abrir.
  useEffect(() => session.watch(), [session]);
  useEffect(() => {
    if (!selected && projects.length > 0) setSelectedId(projects[0].id);
  }, [selected, projects]);
  useEffect(() => {
    setEditing(undefined);
    setConfirming(undefined);
    setCopyIntent(undefined);
    setLeaving(undefined);
    setSharing(undefined);
  }, [selected?.id]);
  // Si dejó de ser administrador (otra persona le cambió el rol) o el proyecto ya no está en su lista, el cuadro de compartir no tiene sentido.
  useEffect(() => {
    if (sharing && projects.find((p) => p.id === sharing)?.role !== 'admin') setSharing(undefined);
  }, [sharing, projects]);
  // Al cerrar «Compartir…» el foco vuelve al botón que lo abrió.
  const wasSharing = useRef(false);
  useEffect(() => {
    if (wasSharing.current && !sharing) shareButton.current?.focus();
    wasSharing.current = sharing !== undefined;
  }, [sharing]);

  /**
   * ¿Este error se arregla con otro token o volviendo a entrar, en «Dónde se guardan»? Con una sesión de persona un 403 no es eso: es el rol que
   * tiene en ese proyecto (se arregla pidiendo que se lo cambien), y mandarla a cambiar de token no la ayuda.
   */
  const needsCredential = (error: ProjectError): boolean => error.code === 'unauthorized' || (error.code === 'forbidden' && session.credential !== 'session');

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
      // El servidor no aceptó el token (o su rol no alcanza): el formulario para escribir otro está en «Dónde se guardan».
      if (e instanceof ProjectError && needsCredential(e)) setStorageOpen(true);
      // Una sesión que dejó de valer se nota al escribir: se relee la lista para que el estado (y «Dónde se guardan») lo diga como es.
      if (e instanceof ProjectError && e.code === 'unauthorized' && !copying.current && session.remote) void session.refresh({ background: true });
    } finally {
      copying.current = false;
      setBusy(false);
    }
  };

  // «Copiar a…»: el otro almacén. Se recalcula al cambiar el servidor conocido (el panel avisa con `onChange`).
  const resolveTarget = (): CopyTarget => copyTarget ?? copyTargetFor(session.backend, { fetch: storage?.fetch, config: loadBackend(storage?.areas) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(resolveTarget, [copyTarget, session, storage?.fetch, storage?.areas, serverVersion]);

  /** Copia el proyecto con el archivo único del núcleo a un almacén temporal del destino (la sesión sigue en el suyo). */
  const copyTo = (project: ProjectSummary, to: CopyTarget): void =>
    void act(async () => {
      await session.flush();
      const { store, close } = to.open();
      copying.current = true;
      try {
        const imported = await copyProject(session.store, project.id, store);
        const text = `Copiado como «${imported.project.name}» ${to.where}${imported.renamedFrom ? `: ya había uno llamado «${imported.renamedFrom}»` : ''}.`;
        setNote(text);
        setCopyIntent(undefined);
        notify?.(text);
      } catch (error) {
        if (error instanceof ProjectError) {
          if (needsCredential(error)) {
            setCopyIntent({ id: project.id, name: project.name });
            setStorageOpen(true);
          }
          throw new ProjectError(error.code, `No se pudo copiar «${project.name}» ${to.where}: ${error.message}`, error.info);
        }
        throw error;
      } finally {
        await close();
      }
    });

  const copySelected = (project: ProjectSummary): void => {
    if (!target.ready) {
      // Sin servidor al que copiar: se lleva al formulario de conexión, que ofrece copiar en cuanto el servidor responde.
      setCopyIntent({ id: project.id, name: project.name });
      setStorageOpen(true);
      return;
    }
    copyTo(project, target);
  };

  const open = (projectId: string, diagram: DiagramMeta): Promise<void> =>
    act(async () => {
      await onOpen(projectId, diagram);
      onClose();
    });

  const submitNewProject = (event: FormEvent): void => {
    event.preventDefault();
    if (!newProject.trim()) return;
    void act(async () => {
      const project = await session.createProject(newProject);
      setSelectedId(project.id);
      setNewProject('');
    });
  };

  const submitNewDiagram = (event: FormEvent): void => {
    event.preventDefault();
    if (!selected || !newDiagram.module) return;
    void act(async () => {
      const text = (await template?.(newDiagram.module, newDiagram.template)) ?? '';
      const meta = await session.createDiagram({ module: newDiagram.module, name: newDiagram.name.trim() || undefined, text }, selected.id);
      setNewDiagram((d) => ({ ...d, name: '' }));
      await onOpen(selected.id, meta);
      onClose();
    });
  };

  const submitSaveCurrent = (event: FormEvent): void => {
    event.preventDefault();
    if (!selected || !live) return;
    void act(async () => {
      const meta = await session.createDiagram({ module: live.module, name: saveName.trim() || live.name || undefined, text: live.text }, selected.id);
      setSaveName('');
      notify?.(`Guardado como «${meta.name}» en el proyecto «${selected.name}». Los cambios se guardan solos.`);
      onClose();
    });
  };

  const commitRename = (): void => {
    if (!editing) return;
    const { kind, id, value } = editing;
    void act(async () => {
      if (kind === 'project') await session.renameProject(id, value);
      else if (selected) await session.renameDiagram(selected.id, id, value);
      setEditing(undefined);
    });
  };

  const confirmDelete = (): void => {
    if (!confirming) return;
    const { kind, id } = confirming;
    void act(async () => {
      if (kind === 'project') await session.deleteProject(id);
      else if (selected) await session.deleteDiagram(selected.id, id);
      setConfirming(undefined);
      dialogRef.current?.focus();
    });
  };

  const leaveProject = (project: ProjectSummary): void =>
    void act(async () => {
      await session.leaveProject(project.id);
      setLeaving(undefined);
      const text = `Saliste de «${project.name}»: ya no aparece en tu lista.`;
      setNote(text);
      notify?.(text);
    });

  const exportProject = (project: ProjectSummary): void =>
    void act(async () => {
      const { fileName, text } = await session.exportProject(project.id);
      downloadText(fileName, text, 'application/json');
      notify?.(`Proyecto «${project.name}» exportado en ${fileName}.`);
    });

  const importFile = (file: File): void =>
    void act(async () => {
      const imported = await session.importProject(await file.text());
      setSelectedId(imported.project.id);
      notify?.(
        `Proyecto importado como «${imported.project.name}» (${plural(imported.diagrams, 'diagrama', 'diagramas')})${imported.renamedFrom ? `: ya había uno llamado «${imported.renamedFrom}»` : ''}.`,
      );
    });

  // Escape se escucha en el documento: al borrar algo el botón que tenía el foco desaparece y el foco cae en el `body`.
  const escape = useRef<() => void>(() => undefined);
  escape.current = () => {
    if (sharing) setSharing(undefined);
    else if (editing) setEditing(undefined);
    else if (confirming) setConfirming(undefined);
    else if (storageOpen) setStorageOpen(false);
    else onClose();
  };
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      escape.current();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    // Foco atrapado dentro del diálogo.
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const nameCell = (kind: Target['kind'], id: string, name: string, open?: () => void): ReactElement => {
    if (editing && editing.kind === kind && editing.id === id) {
      return (
        <form
          className="pj-inline"
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
        >
          <input
            type="text"
            aria-label={`Nuevo nombre de ${name}`}
            value={editing.value}
            autoFocus
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(undefined);
              }
            }}
          />
          <button type="submit" className="pj-primary" disabled={busy}>
            Guardar
          </button>
          <button type="button" onClick={() => setEditing(undefined)}>
            Cancelar
          </button>
        </form>
      );
    }
    return open ? (
      <button type="button" className="pj-link" onClick={open} disabled={busy}>
        {name}
      </button>
    ) : (
      <span>{name}</span>
    );
  };

  const isConfirming = (kind: Target['kind'], id: string): boolean => confirming?.kind === kind && confirming.id === id;
  const deleteControls = (kind: Target['kind'], id: string, name: string, warning: string, denied?: string): ReactElement =>
    isConfirming(kind, id) ? (
      <span className="pj-confirm" role="alert">
        {warning}{' '}
        <button type="button" className="pj-danger" onClick={confirmDelete} disabled={busy}>
          Sí, borrar
        </button>
        <button type="button" onClick={() => setConfirming(undefined)}>
          No
        </button>
      </span>
    ) : (
      <button type="button" onClick={() => setConfirming({ kind, id })} disabled={busy || denied !== undefined} title={denied} aria-label={`Borrar ${name}`}>
        Borrar
      </button>
    );

  // Lo que la persona puede hacer en el proyecto elegido. Sin `role` (este navegador, o un servidor con tokens: el rol del token vale para todo el
  // espacio de trabajo) no se limita nada aquí y decide el servidor; con él se deshace lo que el servidor rechazaría de todos modos.
  const role = selected?.role;
  const canWrite = role !== 'viewer';
  const readOnly = 'Tienes el rol de lector en este proyecto: puedes abrirlo, pero no cambiarlo.';
  const sharable = session.canShare && role === 'admin';
  const leavable = session.canShare && role !== undefined && role !== 'admin';

  return (
    <>
    <div className="pj-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pj-dialog" role="dialog" aria-modal="true" aria-labelledby="pj-title" ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown} data-testid="projects-dialog">
        <header className="pj-head">
          <h2 id="pj-title">Proyectos</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>

        {!state.available && (
          <p className="pj-warn" role="alert">
            {remote
              ? `No se pudo usar el servidor${host ? ` ${host}` : ''}${state.error ? `: ${state.error.replace(/\.+$/, '')}` : ''}. Revisa «Dónde se guardan» aquí abajo.`
              : `El almacenamiento del navegador no está disponible${state.error ? `: ${state.error}` : ''}. Los proyectos no se pueden guardar aquí; sí puedes exportar e importar archivos.`}
          </p>
        )}
        {remote && state.available && state.syncError && (
          <p className="pj-warn" role="status" data-testid="projects-sync-error">
            Sin conexión con el servidor{host ? ` ${host}` : ''}: la lista puede estar desactualizada ({state.syncError}). Se vuelve a intentar sola.
          </p>
        )}
        {error && (
          <p className="pj-error" role="alert" data-testid="projects-error">
            {error}
          </p>
        )}
        {note && (
          <p className="pj-ok" role="status" data-testid="projects-note">
            {note}
          </p>
        )}

        <StoragePanel
          session={session}
          open={storageOpen}
          onToggle={(open) => {
            setStorageOpen(open);
            if (!open) setCopyIntent(undefined);
          }}
          copyFor={copyIntent && !remote ? { name: copyIntent.name } : undefined}
          onCopy={() => {
            const project = projects.find((p) => p.id === copyIntent?.id);
            setServerVersion((v) => v + 1);
            setStorageOpen(false);
            // el servidor que el panel acaba de guardar ya es el destino: se lee de nuevo, no del `useMemo` del render anterior
            if (project) copyTo(project, resolveTarget());
          }}
          onChange={() => setServerVersion((v) => v + 1)}
          notify={notify}
          {...storage}
        />

        <div className="pj-body">
          <nav className="pj-list" aria-label="Proyectos">
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <button type="button" className="pj-item" aria-current={p.id === selected?.id ? 'true' : undefined} onClick={() => setSelectedId(p.id)}>
                    <strong>{p.name}</strong>
                    <small>
                      {plural(p.diagrams.length, 'diagrama', 'diagramas')}
                      {p.role && (
                        <>
                          {' · '}
                          <span data-testid="project-role" data-role={p.role} title={`${PROJECT_ROLE_LABEL[p.role]}: ${PROJECT_ROLE_HELP[p.role]}`}>
                            {PROJECT_ROLE_LABEL[p.role].toLowerCase()}
                          </span>
                        </>
                      )}
                      {p.id === state.projectId ? ' · abierto' : ''}
                    </small>
                  </button>
                </li>
              ))}
              {projects.length === 0 && <li className="pj-empty">Aún no hay proyectos. Crea el primero aquí abajo.</li>}
            </ul>
            <form className="pj-form" onSubmit={submitNewProject} aria-label="Crear proyecto">
              <label htmlFor="pj-new-project">Nuevo proyecto</label>
              <div className="pj-row">
                <input id="pj-new-project" type="text" value={newProject} placeholder="Nombre del proyecto" maxLength={120} onChange={(e) => setNewProject(e.target.value)} />
                <button type="submit" className="pj-primary" disabled={busy || !newProject.trim() || !state.available}>
                  Crear
                </button>
              </div>
            </form>
            <label className="pj-file">
              Importar proyecto…
              <input
                type="file"
                accept=".json,application/json"
                aria-label="Importar proyecto desde un archivo"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importFile(file);
                  e.target.value = '';
                }}
              />
            </label>
          </nav>

          <section className="pj-detail" aria-label="Proyecto seleccionado">
            {!selected ? (
              <p className="pj-empty">Elige o crea un proyecto para ver sus diagramas.</p>
            ) : (
              <>
                <div className="pj-title-row">
                  <h3>{nameCell('project', selected.id, selected.name)}</h3>
                  <span className="pj-actions">
                    {role && (
                      <span className="pj-chip" data-testid="project-role-detail" data-role={role} title={`${PROJECT_ROLE_LABEL[role]}: ${PROJECT_ROLE_HELP[role]}`}>
                        Tu rol: {PROJECT_ROLE_LABEL[role].toLowerCase()}
                      </span>
                    )}
                    {!(editing?.kind === 'project' && editing.id === selected.id) && (
                      <button type="button" onClick={() => setEditing({ kind: 'project', id: selected.id, value: selected.name })} disabled={busy || !canWrite} title={canWrite ? undefined : readOnly}>
                        Renombrar
                      </button>
                    )}
                    <button type="button" onClick={() => exportProject(selected)} disabled={busy}>
                      Exportar
                    </button>
                    <button type="button" onClick={() => copySelected(selected)} disabled={busy} data-testid="copy-project">
                      {target.label}
                    </button>
                    {sharable && (
                      <button type="button" ref={shareButton} onClick={() => setSharing(selected.id)} disabled={busy} data-testid="share-project">
                        Compartir…
                      </button>
                    )}
                    {leavable &&
                      (leaving === selected.id ? (
                        <span className="pj-confirm" role="alert">
                          ¿Salir de «{selected.name}»? Dejará de aparecer en tu lista y alguien tendrá que volver a compartírtelo.{' '}
                          <button type="button" className="pj-danger" onClick={() => leaveProject(selected)} disabled={busy}>
                            Sí, salir
                          </button>
                          <button type="button" onClick={() => setLeaving(undefined)}>
                            No
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setLeaving(selected.id)} disabled={busy} data-testid="leave-project">
                          Salir del proyecto
                        </button>
                      ))}
                    {deleteControls(
                      'project',
                      selected.id,
                      selected.name,
                      `¿Borrar «${selected.name}» y sus ${plural(selected.diagrams.length, 'diagrama', 'diagramas')}? No se puede deshacer.`,
                      role !== undefined && role !== 'admin' ? 'Solo quien administra el proyecto puede borrarlo.' : undefined,
                    )}
                  </span>
                </div>
                {selected.description && <p className="pj-desc">{selected.description}</p>}
                {!canWrite && (
                  <p className="pj-hint" data-testid="project-readonly">
                    {readOnly}
                  </p>
                )}

                {selected.diagrams.length === 0 ? (
                  <p className="pj-empty">Este proyecto no tiene diagramas todavía.</p>
                ) : (
                  <table className="pj-table">
                    <thead>
                      <tr>
                        <th scope="col">Diagrama</th>
                        <th scope="col">Módulo</th>
                        <th scope="col">Modificado</th>
                        <th scope="col">
                          <span className="pj-visually-hidden">Acciones</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.diagrams.map((d) => (
                        <tr key={d.id} data-testid="project-diagram" data-current={d.id === state.diagramId && selected.id === state.projectId ? 'true' : undefined}>
                          <td>{nameCell('diagram', d.id, d.name, () => void open(selected.id, d))}</td>
                          <td>
                            <span className="pj-chip">{moduleLabel.get(d.module) ?? d.module}</span>
                          </td>
                          <td>{agoFormat(d.updatedAt)}</td>
                          <td className="pj-actions">
                            {!(editing?.kind === 'diagram' && editing.id === d.id) && (
                              <>
                                <button type="button" onClick={() => void open(selected.id, d)} disabled={busy} aria-label={`Abrir ${d.name}`}>
                                  Abrir
                                </button>
                                <button type="button" onClick={() => setEditing({ kind: 'diagram', id: d.id, value: d.name })} disabled={busy || !canWrite} title={canWrite ? undefined : readOnly} aria-label={`Renombrar ${d.name}`}>
                                  Renombrar
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void act(async () => {
                                      const copy = await session.duplicateDiagram(selected.id, d.id);
                                      notify?.(`Duplicado como «${copy.name}».`);
                                    })
                                  }
                                  disabled={busy || !canWrite}
                                  title={canWrite ? undefined : readOnly}
                                  aria-label={`Duplicar ${d.name}`}
                                >
                                  Duplicar
                                </button>
                              </>
                            )}
                            {deleteControls('diagram', d.id, d.name, `¿Borrar «${d.name}»?`, canWrite ? undefined : readOnly)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <form className="pj-form" onSubmit={submitNewDiagram} aria-label="Nuevo diagrama">
                  <strong>Añadir un diagrama a «{selected.name}»</strong>
                  <div className="pj-row">
                    <label>
                      Módulo
                      <select aria-label="Módulo del diagrama nuevo" value={newDiagram.module} onChange={(e) => setNewDiagram({ ...newDiagram, module: e.target.value })}>
                        {modules.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Nombre
                      <input type="text" aria-label="Nombre del diagrama nuevo" value={newDiagram.name} placeholder="Sin título" maxLength={120} onChange={(e) => setNewDiagram({ ...newDiagram, name: e.target.value })} />
                    </label>
                    <label>
                      Empezar con
                      <select aria-label="Con qué empieza el diagrama nuevo" value={newDiagram.template} onChange={(e) => setNewDiagram({ ...newDiagram, template: e.target.value as TemplateKind })}>
                        <option value="example">El ejemplo del módulo</option>
                        <option value="blank">Un documento vacío</option>
                      </select>
                    </label>
                    <button type="submit" className="pj-primary" disabled={busy || !newDiagram.module || !canWrite} title={canWrite ? undefined : readOnly}>
                      Crear y abrir
                    </button>
                  </div>
                </form>

                {live && (
                  <form className="pj-form" onSubmit={submitSaveCurrent} aria-label="Guardar el documento actual">
                    <strong>Guardar el documento que estás editando</strong>
                    <div className="pj-row">
                      <label>
                        Nombre
                        <input type="text" aria-label="Nombre del documento actual" value={saveName} placeholder={live.name || 'Sin título'} maxLength={120} onChange={(e) => setSaveName(e.target.value)} />
                      </label>
                      <button type="submit" className="pj-primary" disabled={busy || !canWrite} title={canWrite ? undefined : readOnly}>
                        Guardar en «{selected.name}»
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </section>
        </div>

        <footer className="pj-foot" data-testid="projects-foot">
          {remote ? (
            <>
              Los proyectos se guardan en el servidor {host}: los ven las personas y equipos que se conecten a él (la lista se actualiza sola mientras la miras). Para una copia de seguridad en un archivo, usa <strong>Exportar</strong> e{' '}
              <strong>Importar proyecto</strong>.
            </>
          ) : (
            <>
              Los proyectos se guardan en este navegador. Para llevarlos a otro equipo o tener una copia de seguridad, usa <strong>Exportar</strong> e <strong>Importar proyecto</strong>.
            </>
          )}
        </footer>
      </div>
    </div>
    {sharing && selected && selected.id === sharing && (
      <ShareDialog session={session} project={{ id: selected.id, name: selected.name }} onClose={() => setSharing(undefined)} notify={notify} onLeft={() => setSelectedId(undefined)} />
    )}
    </>
  );
}
