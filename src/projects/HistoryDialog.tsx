import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { describeContent, diffSummaryLine, formatFieldChange, ProjectError, type AnyModule, type ChangedEntry, type DiagramMeta, type DiagramVersion, type DiffEntry, type VersionMeta } from '@iark/kernel';
import { PROJECT_ROLE_LABEL } from './people';
import type { ProjectSession, RestoreResult, VersionRights } from './session';
import { changesBetween, type VersionChange } from './versionDiff';
import './projects.css';

export interface HistoryDialogProps {
  session: ProjectSession;
  projectId: string;
  /** El diagrama abierto, cuyo historial se muestra. */
  diagram: DiagramMeta;
  /** El módulo del diagrama: su motor de diff resume qué cambió entre una versión y el contenido de ahora. */
  loadModule(id: string): Promise<AnyModule>;
  /**
   * Restaura la versión y carga el resultado en el editor de quien abrió el cuadro (la sesión guarda lo pendiente, restaura y devuelve el
   * diagrama como quedó). Rechaza con el motivo si no se pudo (un conflicto, un rol insuficiente…).
   */
  onRestore(versionId: number): Promise<RestoreResult>;
  onClose(): void;
  notify?(message: string): void;
}

/** Qué se está haciendo con la versión elegida: nada, confirmando restaurarla, poniéndole nombre o confirmando borrarla. */
type Mode = 'idle' | 'restore' | 'name' | 'delete';

type Detail =
  | { id: number; state: 'loading' }
  | { id: number; state: 'ready'; version: DiagramVersion; change: VersionChange }
  | { id: number; state: 'error'; message: string };

/** Hasta cuántos cambios de cada clase se enseñan; el resto se cuenta («… y 12 más»). */
const SHOWN_PER_SECTION = 40;

const SECTIONS = [
  { kind: 'added', title: 'Añadidos', sign: '+' },
  { kind: 'removed', title: 'Quitados', sign: '−' },
  { kind: 'changed', title: 'Modificados', sign: '~' },
] as const;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const when = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
};
const sizeOf = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1).replace('.', ',')} kB` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

/** Lo que le pasa a la persona según el error: el mensaje del servidor (claro y en español) y, cuando hay algo que hacer, qué. */
function explain(error: unknown): string {
  if (!(error instanceof ProjectError)) return error instanceof Error ? error.message : String(error);
  if (error.code === 'unauthorized') return 'Tu sesión caducó (o se cerró desde otro sitio): cierra este cuadro e inicia sesión de nuevo en «Dónde se guardan».';
  if (error.code === 'forbidden') return `${error.message} Puede que tu rol en el proyecto haya cambiado.`;
  if (error.code === 'conflict') return `${error.message} Resuelve el conflicto en la barra del proyecto («Quedarme con mi versión» o «Cargar la otra») y vuelve a abrir el historial.`;
  return error.message;
}

/** Los cambios de una clase, agrupados por la lista del documento a la que pertenecen. */
function byCollection(entries: readonly DiffEntry[]): Array<[string, DiffEntry[]]> {
  const groups = new Map<string, DiffEntry[]>();
  for (const e of entries) groups.set(e.collection, [...(groups.get(e.collection) ?? []), e]);
  return [...groups];
}

function Changes({ change, versionId }: { change: VersionChange; versionId: number }) {
  if (change.status === 'same') {
    return (
      <p className="pj-hint" data-testid="history-changes" data-status="same">
        Sin cambios de contenido frente al diagrama actual (la maquetación guardada y el orden de las listas no cuentan como cambios).
      </p>
    );
  }
  if (change.status === 'unreadable') {
    return (
      <p className="pj-hint" role="status" data-testid="history-changes" data-status="unreadable">
        No se pudo resumir qué cambió: {change.reason}
      </p>
    );
  }
  const { diff } = change;
  let remaining = 0;
  return (
    <div data-testid="history-changes" data-status="changed">
      <p className="pj-history-summary" data-testid="history-summary">
        <strong>{diffSummaryLine(diff)}</strong> De la versión {versionId} al diagrama actual.
      </p>
      {SECTIONS.map(({ kind, title, sign }) => {
        const entries: DiffEntry[] = diff[kind];
        if (entries.length === 0) return null;
        const shown = entries.slice(0, SHOWN_PER_SECTION);
        remaining += entries.length - shown.length;
        return (
          <section key={kind} className="pj-history-section" aria-label={title} data-testid={`history-${kind}`}>
            <h4>
              <span className={`pj-history-sign pj-history-${kind}`} aria-hidden="true">
                {sign}
              </span>{' '}
              {title} ({entries.length})
            </h4>
            {byCollection(shown).map(([collection, group]) => (
              <div key={collection} className="pj-history-group">
                <h5>{collection === 'documento' ? 'Campos del documento' : collection}</h5>
                <ul>
                  {group.map((entry) => (
                    <li key={`${entry.collection}/${entry.id}`}>
                      <strong>{entry.collection === 'documento' ? 'Campos del documento' : entry.label}</strong>
                      {entry.kind && <small> {entry.kind}</small>}
                      {kind === 'changed' && (entry as ChangedEntry).fields.length > 0 && (
                        <ul className="pj-history-fields">
                          {(entry as ChangedEntry).fields.map((f) => (
                            <li key={f.path}>
                              <code>{f.path}</code>: {formatFieldChange(f)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
      {remaining > 0 && <p className="pj-hint">… y {plural(remaining, 'cambio más', 'cambios más')} que no se muestran aquí.</p>}
    </div>
  );
}

/**
 * «Historial de versiones» de un diagrama: cada guardado deja una versión, con su fecha, quién la guardó y, si alguien se lo puso, un nombre. Desde aquí
 * se ve qué cambió entre una versión y el diagrama de ahora (el mismo motor que `iark diff`), se restaura una versión y se nombran las que merece la pena
 * conservar.
 *
 * Decisiones de diseño:
 * - Restaurar no borra nada: el contenido de esa versión se guarda como una versión nueva y lo que había antes sigue en el historial, así que se deshace
 *   restaurando la anterior. Aun así pide confirmación en el propio cuadro (con el foco en «No»): sustituye lo que se ve en el editor.
 * - Antes de abrirse, la sesión guarda lo que esté pendiente del diagrama, para que «el contenido de ahora» sea el que está en el historial.
 * - Los botones que el rol de quien mira no permite se muestran desactivados y dicen por qué; el servidor lo comprueba además en cada petición.
 * - Una versión con nombre no se sustituye ni se descarta sola; borrarla (solo quien administra el proyecto) también pide confirmación.
 * - Si el servidor no guarda historial (es anterior a esta función) el cuadro lo cuenta en lugar de fallar, y los diagramas se siguen guardando.
 */
export function HistoryDialog({ session, projectId, diagram, loadModule, onRestore, onClose, notify }: HistoryDialogProps) {
  const projectName = session.getState().projects.find((p) => p.id === projectId)?.name ?? projectId;
  const host = session.backend.kind === 'remote' ? session.backend.host : undefined;
  const [versions, setVersions] = useState<VersionMeta[] | undefined>();
  const [current, setCurrent] = useState<{ text: string; hash: string } | undefined>();
  const [rights, setRights] = useState<VersionRights>({ restore: false, label: false, remove: false });
  /** El historial no se pudo leer y no hay nada que mostrar: el servidor no lo guarda, no hay permiso, la sesión caducó o no se llega a él. */
  const [blocked, setBlocked] = useState<{ code: 'unsupported' | 'forbidden' | 'unauthorized' | 'other'; message: string } | undefined>();
  const [selected, setSelected] = useState<number | undefined>();
  const [detail, setDetail] = useState<Detail | undefined>();
  const [mode, setMode] = useState<Mode>('idle');
  const [labelText, setLabelText] = useState('');
  const [labelError, setLabelError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const dialog = useRef<HTMLDivElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const loaded = useRef(false);
  const selectedNow = useRef<number | undefined>(undefined);
  /** Las versiones no cambian nunca: lo ya leído no se vuelve a pedir. */
  const cache = useRef(new Map<number, DiagramVersion>());
  /** Qué hacer con el foco cuando termina lo que se estaba haciendo y la pantalla se vuelve a pintar. */
  const focusAfter = useRef<'restore' | 'name' | 'delete' | 'list' | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    // Se abre con el foco dentro y, al cerrarse, lo devuelve a quien lo abrió.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    return () => {
      alive.current = false;
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const choose = (id: number | undefined): void => {
    selectedNow.current = id;
    setSelected(id);
  };

  /** Lee el historial y el diagrama de ahora. `select` elige esa versión; si no, se conserva la elegida o se elige la última que difiere de lo actual. */
  const load = async (select?: number): Promise<void> => {
    setLoading(true);
    try {
      await session.flush();
      const found = await session.store.getDiagram(projectId, diagram.id);
      if (!alive.current) return;
      if (!found) {
        setBlocked({ code: 'other', message: `El diagrama «${diagram.name}» ya no existe en el proyecto.` });
        return;
      }
      const [list, mine] = await Promise.all([session.listVersions(projectId, diagram.id), session.versionRights(projectId)]);
      if (!alive.current) return;
      const now = { text: found.text, hash: describeContent(found.text).hash };
      loaded.current = true;
      setVersions(list);
      setCurrent(now);
      setRights(mine);
      setBlocked(undefined);
      const keep = select ?? selectedNow.current;
      choose(list.some((v) => v.id === keep) ? keep : (list.find((v) => v.hash !== now.hash) ?? list[0])?.id);
    } catch (e) {
      if (!alive.current) return;
      const message = explain(e);
      const code = e instanceof ProjectError ? e.code : undefined;
      if (code === 'unsupported' || code === 'forbidden' || code === 'unauthorized') setBlocked({ code, message });
      else if (!loaded.current) setBlocked({ code: 'other', message });
      else setError((previous) => previous ?? message);
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // solo al abrirlo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // La versión elegida: su documento y qué cambió frente al diagrama de ahora.
  useEffect(() => {
    if (selected === undefined || !current) {
      setDetail(undefined);
      return;
    }
    let stale = false;
    setDetail({ id: selected, state: 'loading' });
    void (async () => {
      try {
        let version = cache.current.get(selected);
        if (!version) {
          version = await session.getVersion(projectId, diagram.id, selected);
          if (version) cache.current.set(selected, version);
        }
        if (stale) return;
        if (!version) {
          setDetail({ id: selected, state: 'error', message: `La versión ${selected} ya no existe (el historial descarta las automáticas más viejas). Actualiza la lista.` });
          return;
        }
        const change: VersionChange = version.hash === current.hash ? { status: 'same' } : changesBetween(await loadModule(diagram.module), version.text, current.text);
        if (!stale) setDetail({ id: selected, state: 'ready', version, change });
      } catch (e) {
        if (!stale) setDetail({ id: selected, state: 'error', message: explain(e) });
      }
    })();
    return () => {
      stale = true;
    };
    // la sesión, el módulo y el diagrama no cambian mientras el cuadro está abierto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, current]);

  // Cuando termina lo que se estaba haciendo, el foco vuelve a donde estaba la persona, no a la nada.
  useEffect(() => {
    const want = focusAfter.current;
    if (!want || busy) return;
    focusAfter.current = undefined;
    const root = dialog.current;
    const target = want === 'list' ? root?.querySelector<HTMLElement>('[data-version][aria-current="true"]') : root?.querySelector<HTMLElement>(`[data-focus="${want}"]:not(:disabled)`);
    (target ?? root?.querySelector<HTMLElement>('[data-version][aria-current="true"]') ?? root)?.focus();
  });

  const startMode = (next: Mode): void => {
    setMode(next);
    setLabelError(undefined);
    setError(undefined);
    if (next === 'name') setLabelText(versions?.find((v) => v.id === selected)?.label ?? '');
  };
  const stopMode = (back: 'restore' | 'name' | 'delete'): void => {
    focusAfter.current = back;
    setMode('idle');
    setLabelError(undefined);
  };

  const select = (id: number): void => {
    if (id === selected) return;
    choose(id);
    setMode('idle');
    setLabelError(undefined);
    setError(undefined);
    setNote(undefined);
  };

  const meta = versions?.find((v) => v.id === selected);
  /** Su contenido es justo el del diagrama de ahora (no hay nada que restaurar); «Actual» lo lleva solo la más reciente que lo tiene. */
  const isActual = !!meta && !!current && meta.hash === current.hash;
  const actualId = current ? versions?.find((v) => v.hash === current.hash)?.id : undefined;
  const newest = versions?.[0];

  /** Una operación sobre la versión elegida: sin errores ni avisos anteriores; si falla, el motivo y la lista como la tiene el servidor. */
  const act = async (work: () => Promise<void>, failure: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(`${failure} ${explain(e)}`);
      await load();
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const said = (text: string): void => {
    setNote(text);
    notify?.(text);
  };

  const restore = (): void => {
    if (!meta) return;
    const before = newest;
    focusAfter.current = 'list';
    setMode('idle');
    void act(async () => {
      const result = await onRestore(meta.id);
      said(
        result.unchanged
          ? `«${diagram.name}» ya tenía el contenido de la versión ${meta.id}: no se guardó nada.`
          : `Versión ${meta.id} restaurada: quedó guardada como la versión ${result.version.id}.${before ? ` Lo que había antes sigue en la versión ${before.id}: para deshacerlo, restáurala.` : ''}`,
      );
      await load(result.version.id);
    }, `No se pudo restaurar la versión ${meta.id}.`);
  };

  const saveLabel = (event: FormEvent): void => {
    event.preventDefault();
    if (!meta) return;
    const label = labelText.trim();
    if (!label) {
      setLabelError('Escribe un nombre para la versión (por ejemplo «Entrega 1»).');
      labelInput.current?.focus();
      return;
    }
    focusAfter.current = 'name';
    setMode('idle');
    void act(async () => {
      const named = await session.labelVersion(projectId, diagram.id, meta.id, label);
      said(`Versión ${meta.id} nombrada «${named.label}»: ya no se descartará sola.`);
      await load(meta.id);
    }, `No se pudo nombrar la versión ${meta.id}.`);
  };

  const remove = (): void => {
    if (!meta) return;
    const index = versions?.findIndex((v) => v.id === meta.id) ?? -1;
    const neighbour = versions?.[index + 1] ?? versions?.[index - 1];
    focusAfter.current = 'list';
    setMode('idle');
    void act(async () => {
      await session.deleteVersion(projectId, diagram.id, meta.id);
      cache.current.delete(meta.id);
      said(`Se borró la versión ${meta.id}${meta.label ? ` «${meta.label}»` : ''} del historial.`);
      choose(neighbour?.id);
      await load(neighbour?.id);
    }, `No se pudo borrar la versión ${meta.id}.`);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (mode !== 'idle') stopMode(mode);
      else onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Foco atrapado dentro del cuadro.
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])].filter((el) => el.tabIndex >= 0 && !el.closest('[hidden]'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /** Flechas, inicio y fin en la lista: mueven la elección (y el foco) entre versiones, como en cualquier lista de opciones. */
  const onListKeyDown = (event: KeyboardEvent): void => {
    if (!versions || versions.length === 0) return;
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, versions.findIndex((v) => v.id === selected));
    const next = event.key === 'ArrowDown' ? Math.min(versions.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : versions.length - 1;
    const id = versions[next].id;
    if (id === selected) return;
    select(id);
    // el foco acompaña a la elección (el botón ya está en la lista; el orden de tabulación se actualiza al repintar)
    dialog.current?.querySelector<HTMLElement>(`[data-version="${id}"]`)?.focus();
  };

  const named = versions?.filter((v) => v.label !== undefined).length ?? 0;
  const readOnlyReason =
    rights.role === 'viewer' ? `Tu rol en el proyecto (${PROJECT_ROLE_LABEL.viewer.toLowerCase()}) permite consultar el historial, pero no restaurar ni nombrar versiones.` : undefined;
  const restoreHint = readOnlyReason ?? (isActual ? 'Esta versión es igual al diagrama actual: no hay nada que restaurar.' : undefined);

  return (
    <div className="pj-overlay pj-history-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pj-dialog pj-history" role="dialog" aria-modal="true" aria-labelledby="pj-history-title" ref={dialog} tabIndex={-1} onKeyDown={onKeyDown} data-testid="history-dialog">
        <header className="pj-head">
          <div className="pj-history-title">
            <h2 id="pj-history-title">Historial de versiones</h2>
            <small className="pj-hint">
              «{diagram.name}» · proyecto «{projectName}»{host ? ` · servidor ${host}` : ''}
            </small>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>

        {error && (
          <p className="pj-error" role="alert" data-testid="history-error">
            {error}
          </p>
        )}
        {note && (
          <p className="pj-ok" role="status" data-testid="history-note">
            {note}
          </p>
        )}

        {blocked ? (
          <div className="pj-history-message">
            <p className="pj-error" role="alert" data-testid="history-blocked" data-code={blocked.code}>
              {blocked.message}
            </p>
            {blocked.code === 'unsupported' && <p className="pj-hint">Los diagramas se siguen guardando con normalidad; solo falta el historial. Actualiza IArk en el servidor para tenerlo.</p>}
            {blocked.code === 'other' && (
              <p>
                <button type="button" onClick={() => void load()} disabled={loading}>
                  {loading ? 'Reintentando…' : 'Reintentar'}
                </button>
              </p>
            )}
          </div>
        ) : versions === undefined ? (
          <p className="pj-empty pj-history-message" role="status">
            Cargando el historial…
          </p>
        ) : versions.length === 0 ? (
          <p className="pj-empty pj-history-message" role="status" data-testid="history-empty">
            Este diagrama todavía no tiene versiones: aparecerán con el próximo guardado.
          </p>
        ) : (
          <div className="pj-history-body">
            <section className="pj-history-list" aria-label="Versiones">
              <div className="pj-history-listhead">
                <p className="pj-hint" data-testid="history-count" role="status">
                  {plural(versions.length, 'versión', 'versiones')}
                  {named > 0 ? ` · ${plural(named, 'con nombre', 'con nombre')}` : ''}
                </p>
                <button type="button" onClick={() => void load()} disabled={busy || loading}>
                  {loading ? 'Actualizando…' : 'Actualizar'}
                </button>
              </div>
              <ol className="pj-history-items" aria-busy={loading} onKeyDown={onListKeyDown}>
                {versions.map((v) => {
                  const active = v.id === selected;
                  const actual = v.id === actualId;
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        className="pj-history-item"
                        aria-current={active ? 'true' : undefined}
                        tabIndex={active ? 0 : -1}
                        data-version={v.id}
                        data-testid="history-item"
                        data-label={v.label}
                        data-actual={actual ? 'true' : undefined}
                        onClick={() => select(v.id)}
                      >
                        <span className="pj-history-item-top">
                          <strong>Versión {v.id}</strong>
                          {v.label && <span className="pj-chip pj-named">«{v.label}»</span>}
                          {actual && <span className="pj-chip pj-on">Actual</span>}
                        </span>
                        <small>
                          <time dateTime={v.savedAt}>{when(v.savedAt)}</time>
                          {v.savedBy ? ` · ${v.savedBy}` : ''}
                        </small>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>

            <section className="pj-history-detail" aria-label={meta ? `Detalle de la versión ${meta.id}` : 'Detalle de la versión'} data-testid="history-detail" aria-busy={detail?.state === 'loading'}>
              {meta && (
                <>
                  <h3>
                    Versión {meta.id}
                    {meta.label && <span className="pj-chip pj-named">«{meta.label}»</span>}
                    {isActual && <span className="pj-chip pj-on">{meta.id === actualId ? 'Actual' : 'Igual a la actual'}</span>}
                  </h3>
                  <dl className="pj-history-meta">
                    <div>
                      <dt>Guardada</dt>
                      <dd>
                        <time dateTime={meta.savedAt}>{when(meta.savedAt)}</time>
                      </dd>
                    </div>
                    <div>
                      <dt>Por</dt>
                      <dd>{meta.savedBy ?? 'no se sabe (este almacén no identifica a quien guarda)'}</dd>
                    </div>
                    <div>
                      <dt>Tamaño</dt>
                      <dd>{sizeOf(meta.size)}</dd>
                    </div>
                    {meta.restoredFrom !== undefined && (
                      <div>
                        <dt>Origen</dt>
                        <dd>Restaurada de la versión {meta.restoredFrom}</dd>
                      </div>
                    )}
                  </dl>

                  {detail?.state === 'loading' && (
                    <p className="pj-empty" role="status">
                      Calculando los cambios…
                    </p>
                  )}
                  {detail?.state === 'error' && (
                    <p className="pj-error" role="alert" data-testid="history-detail-error">
                      {detail.message}
                    </p>
                  )}
                  {detail?.state === 'ready' && <Changes change={detail.change} versionId={meta.id} />}

                  <div className="pj-history-actions" role="group" aria-label={`Acciones sobre la versión ${meta.id}`}>
                    {mode === 'restore' ? (
                      <span className="pj-confirm pj-history-confirm" role="alert" data-testid="history-confirm-restore">
                        ¿Restaurar la versión {meta.id}? El diagrama «{diagram.name}» pasará a tener su contenido, guardado como una versión nueva. Lo que hay ahora no se pierde: queda en el historial y se puede recuperar restaurándolo.{' '}
                        <button type="button" className="pj-primary" onClick={restore} disabled={busy}>
                          Sí, restaurar
                        </button>
                        <button type="button" onClick={() => stopMode('restore')} autoFocus>
                          No
                        </button>
                      </span>
                    ) : mode === 'delete' ? (
                      <span className="pj-confirm pj-history-confirm" role="alert" data-testid="history-confirm-delete">
                        ¿Borrar la versión {meta.id}
                        {meta.label ? ` «${meta.label}»` : ''} del historial? No se puede deshacer.{' '}
                        <button type="button" className="pj-danger" onClick={remove} disabled={busy}>
                          Sí, borrar
                        </button>
                        <button type="button" onClick={() => stopMode('delete')} autoFocus>
                          No
                        </button>
                      </span>
                    ) : mode === 'name' ? (
                      <form className="pj-history-name" onSubmit={saveLabel} aria-label={`Nombrar la versión ${meta.id}`} noValidate>
                        <label className="pj-grow">
                          Nombre de la versión
                          <input
                            ref={labelInput}
                            autoFocus
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={120}
                            placeholder="Entrega 1"
                            value={labelText}
                            aria-invalid={labelError ? true : undefined}
                            aria-describedby={labelError ? 'pj-history-name-help pj-history-name-error' : 'pj-history-name-help'}
                            onChange={(e) => {
                              setLabelText(e.target.value);
                              setLabelError(undefined);
                            }}
                          />
                        </label>
                        <span className="pj-actions">
                          <button type="submit" className="pj-primary" disabled={busy}>
                            Guardar nombre
                          </button>
                          <button type="button" onClick={() => stopMode('name')}>
                            Cancelar
                          </button>
                        </span>
                        <small id="pj-history-name-help" className="pj-hint">
                          Una versión con nombre no se sustituye ni se descarta sola cuando el historial se rota.
                        </small>
                        {labelError && (
                          <small id="pj-history-name-error" className="pj-error pj-history-field-error" role="alert" data-testid="history-name-error">
                            {labelError}
                          </small>
                        )}
                      </form>
                    ) : (
                      <>
                        <span className="pj-actions">
                          <button type="button" className="pj-primary" onClick={() => startMode('restore')} disabled={busy || !rights.restore || isActual || detail?.state !== 'ready'} aria-describedby={restoreHint ? 'pj-history-restore-hint' : undefined} data-focus="restore">
                            Restaurar esta versión
                          </button>
                          <button type="button" onClick={() => startMode('name')} disabled={busy || !rights.label} aria-describedby={readOnlyReason ? 'pj-history-restore-hint' : undefined} data-focus="name">
                            {meta.label ? 'Cambiar el nombre' : 'Nombrar versión'}
                          </button>
                          {meta.label && rights.remove && (
                            <button type="button" className="pj-danger-outline" onClick={() => startMode('delete')} disabled={busy} data-focus="delete">
                              Borrar esta versión
                            </button>
                          )}
                        </span>
                        {restoreHint && (
                          <small id="pj-history-restore-hint" className="pj-hint" data-testid="history-hint">
                            {restoreHint}
                          </small>
                        )}
                        {meta.label && !rights.remove && rights.role === 'editor' && (
                          <small className="pj-hint">Borrar una versión con nombre lo decide quien administra el proyecto.</small>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
