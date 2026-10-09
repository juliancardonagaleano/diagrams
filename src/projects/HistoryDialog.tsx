import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { describeContent, formatValue, ProjectError, type AnyModule, type ChangedEntry, type DiagramMeta, type DiagramVersion, type DiffEntry, type DocumentDiff, type FieldChange, type VersionMeta } from '@iark/kernel';
import { projectErrorText } from '../i18n/errores';
import { formatBytes } from '../i18n/format';
import { formatDate, t, tp } from '../i18n';
import { useT } from '../i18n/react';
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
  { kind: 'added', sign: '+' },
  { kind: 'removed', sign: '−' },
  { kind: 'changed', sign: '~' },
] as const;

const sectionTitle = (kind: (typeof SECTIONS)[number]['kind']): string => (kind === 'added' ? t('hist.section.added') : kind === 'removed' ? t('hist.section.removed') : t('hist.section.changed'));

const when = (iso: string): string => (Number.isNaN(Date.parse(iso)) ? iso : formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' }));
const sizeOf = formatBytes;

/** «2 añadidos, 1 quitado, 3 modificados (5 campos)»: el resumen de `iark diff`, pero en el idioma de la interfaz (el del núcleo está solo en español). */
function summaryLine(diff: DocumentDiff): string {
  const { added, removed, changed, moved, fields, total } = diff.summary;
  if (total === 0) return moved > 0 ? t('hist.summary.sameMoved', { moved: tp('hist.n.movedItems', moved) }) : t('hist.summary.same');
  const parts = [
    added > 0 && tp('hist.n.added', added),
    removed > 0 && tp('hist.n.removed', removed),
    changed > 0 && t('hist.summary.changedFields', { changed: tp('hist.n.changed', changed), fields: tp('hist.n.fields', fields) }),
  ].filter((part): part is string => !!part);
  return moved > 0 ? t('hist.summary.lineMoved', { parts: parts.join(', '), moved: tp('hist.n.moved', moved) }) : t('hist.summary.line', { parts: parts.join(', ') });
}

/** Lo que cambió en un campo, en una línea: `"A" → "B"`, o `+beta −legacy` si es una lista de valores. */
function fieldChange(field: FieldChange): string {
  if (field.added || field.removed) return [...(field.added ?? []).map((v) => `+${String(v)}`), ...(field.removed ?? []).map((v) => `−${String(v)}`)].join(' ');
  const value = (v: unknown): string => (v === undefined ? t('hist.noValue') : formatValue(v));
  return `${value(field.before)} → ${value(field.after)}`;
}

/** Lo que le pasa a la persona según el error: el mensaje (traducido por su motivo) y, cuando hay algo que hacer, qué. */
function explain(error: unknown): string {
  if (!(error instanceof ProjectError)) return projectErrorText(error);
  if (error.code === 'unauthorized') return t('common.sessionExpired');
  if (error.code === 'forbidden') return `${projectErrorText(error)} ${t('hist.roleChanged')}`;
  if (error.code === 'conflict') return `${projectErrorText(error)} ${t('hist.resolveConflict')}`;
  return projectErrorText(error);
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
        {t('hist.noContentChanges')}
      </p>
    );
  }
  if (change.status === 'unreadable') {
    return (
      <p className="pj-hint" role="status" data-testid="history-changes" data-status="unreadable">
        {t('hist.cannotSummarize', { reason: change.reason })}
      </p>
    );
  }
  const { diff } = change;
  let remaining = 0;
  return (
    <div data-testid="history-changes" data-status="changed">
      <p className="pj-history-summary" data-testid="history-summary">
        <strong>{summaryLine(diff)}</strong> {t('hist.fromTo', { id: versionId })}
      </p>
      {SECTIONS.map(({ kind, sign }) => {
        const title = sectionTitle(kind);
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
                <h5>{collection === 'documento' ? t('hist.documentFields') : collection}</h5>
                <ul>
                  {group.map((entry) => (
                    <li key={`${entry.collection}/${entry.id}`}>
                      <strong>{entry.collection === 'documento' ? t('hist.documentFields') : entry.label}</strong>
                      {entry.kind && <small> {entry.kind}</small>}
                      {kind === 'changed' && (entry as ChangedEntry).fields.length > 0 && (
                        <ul className="pj-history-fields">
                          {(entry as ChangedEntry).fields.map((f) => (
                            <li key={f.path}>
                              <code>{f.path}</code>: {fieldChange(f)}
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
      {remaining > 0 && <p className="pj-hint">{tp('hist.more', remaining)}</p>}
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
  const { t, tp } = useT();
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
        setBlocked({ code: 'other', message: t('hist.missingDiagram', { name: diagram.name }) });
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
          setDetail({ id: selected, state: 'error', message: t('hist.versionGone', { id: selected }) });
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
          ? t('hist.unchanged', { name: diagram.name, id: meta.id })
          : before
            ? t('hist.restoredBefore', { id: meta.id, newId: result.version.id, before: before.id })
            : t('hist.restored', { id: meta.id, newId: result.version.id }),
      );
      await load(result.version.id);
    }, t('hist.failedRestore', { id: meta.id }));
  };

  const saveLabel = (event: FormEvent): void => {
    event.preventDefault();
    if (!meta) return;
    const label = labelText.trim();
    if (!label) {
      setLabelError(t('hist.nameRequired'));
      labelInput.current?.focus();
      return;
    }
    focusAfter.current = 'name';
    setMode('idle');
    void act(async () => {
      const named = await session.labelVersion(projectId, diagram.id, meta.id, label);
      said(t('hist.labeled', { id: meta.id, label: named.label ?? label }));
      await load(meta.id);
    }, t('hist.failedLabel', { id: meta.id }));
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
      said(meta.label ? t('hist.deletedNamed', { id: meta.id, label: meta.label }) : t('hist.deleted', { id: meta.id }));
      choose(neighbour?.id);
      await load(neighbour?.id);
    }, t('hist.failedDelete', { id: meta.id }));
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
    rights.role === 'viewer' ? t('hist.viewerOnly', { role: PROJECT_ROLE_LABEL.viewer.toLowerCase() }) : undefined;
  const restoreHint = readOnlyReason ?? (isActual ? t('hist.sameAsDiagram') : undefined);

  return (
    <div className="pj-overlay pj-history-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pj-dialog pj-history" role="dialog" aria-modal="true" aria-labelledby="pj-history-title" ref={dialog} tabIndex={-1} onKeyDown={onKeyDown} data-testid="history-dialog">
        <header className="pj-head">
          <div className="pj-history-title">
            <h2 id="pj-history-title">{t('hist.title')}</h2>
            <small className="pj-hint">
              {host ? t('hist.subtitleHost', { name: diagram.name, project: projectName, host }) : t('hist.subtitle', { name: diagram.name, project: projectName })}
            </small>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
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
            {blocked.code === 'unsupported' && <p className="pj-hint">{t('hist.unsupportedHint')}</p>}
            {blocked.code === 'other' && (
              <p>
                <button type="button" onClick={() => void load()} disabled={loading}>
                  {loading ? t('hist.retrying') : t('common.retry')}
                </button>
              </p>
            )}
          </div>
        ) : versions === undefined ? (
          <p className="pj-empty pj-history-message" role="status">
            {t('hist.loading')}
          </p>
        ) : versions.length === 0 ? (
          <p className="pj-empty pj-history-message" role="status" data-testid="history-empty">
            {t('hist.empty')}
          </p>
        ) : (
          <div className="pj-history-body">
            <section className="pj-history-list" aria-label={t('hist.list')}>
              <div className="pj-history-listhead">
                <p className="pj-hint" data-testid="history-count" role="status">
                  {tp('hist.count', versions.length)}
                  {named > 0 ? ` · ${t('hist.named', { count: named })}` : ''}
                </p>
                <button type="button" onClick={() => void load()} disabled={busy || loading}>
                  {loading ? t('hist.refreshing') : t('hist.refresh')}
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
                          <strong>{t('hist.version', { id: v.id })}</strong>
                          {v.label && <span className="pj-chip pj-named">«{v.label}»</span>}
                          {actual && <span className="pj-chip pj-on">{t('hist.current')}</span>}
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

            <section className="pj-history-detail" aria-label={meta ? t('hist.detailOf', { id: meta.id }) : t('hist.detail')} data-testid="history-detail" aria-busy={detail?.state === 'loading'}>
              {meta && (
                <>
                  <h3>
                    {t('hist.version', { id: meta.id })}
                    {meta.label && <span className="pj-chip pj-named">«{meta.label}»</span>}
                    {isActual && <span className="pj-chip pj-on">{meta.id === actualId ? t('hist.current') : t('hist.sameAsCurrent')}</span>}
                  </h3>
                  <dl className="pj-history-meta">
                    <div>
                      <dt>{t('hist.saved')}</dt>
                      <dd>
                        <time dateTime={meta.savedAt}>{when(meta.savedAt)}</time>
                      </dd>
                    </div>
                    <div>
                      <dt>{t('hist.by')}</dt>
                      <dd>{meta.savedBy ?? t('hist.unknownAuthor')}</dd>
                    </div>
                    <div>
                      <dt>{t('hist.size')}</dt>
                      <dd>{sizeOf(meta.size)}</dd>
                    </div>
                    {meta.restoredFrom !== undefined && (
                      <div>
                        <dt>{t('hist.origin')}</dt>
                        <dd>{t('hist.restoredFrom', { id: meta.restoredFrom })}</dd>
                      </div>
                    )}
                  </dl>

                  {detail?.state === 'loading' && (
                    <p className="pj-empty" role="status">
                      {t('hist.computing')}
                    </p>
                  )}
                  {detail?.state === 'error' && (
                    <p className="pj-error" role="alert" data-testid="history-detail-error">
                      {detail.message}
                    </p>
                  )}
                  {detail?.state === 'ready' && <Changes change={detail.change} versionId={meta.id} />}

                  <div className="pj-history-actions" role="group" aria-label={t('hist.actionsOf', { id: meta.id })}>
                    {mode === 'restore' ? (
                      <span className="pj-confirm pj-history-confirm" role="alert" data-testid="history-confirm-restore">
                        {t('hist.confirmRestore', { id: meta.id, name: diagram.name })}{' '}
                        <button type="button" className="pj-primary" onClick={restore} disabled={busy}>
                          {t('hist.yesRestore')}
                        </button>
                        <button type="button" onClick={() => stopMode('restore')} autoFocus>
                          {t('common.no')}
                        </button>
                      </span>
                    ) : mode === 'delete' ? (
                      <span className="pj-confirm pj-history-confirm" role="alert" data-testid="history-confirm-delete">
                        {meta.label ? t('hist.confirmDeleteNamed', { id: meta.id, label: meta.label }) : t('hist.confirmDelete', { id: meta.id })}{' '}
                        <button type="button" className="pj-danger" onClick={remove} disabled={busy}>
                          {t('pj.yesDelete')}
                        </button>
                        <button type="button" onClick={() => stopMode('delete')} autoFocus>
                          {t('common.no')}
                        </button>
                      </span>
                    ) : mode === 'name' ? (
                      <form className="pj-history-name" onSubmit={saveLabel} aria-label={t('hist.nameForm', { id: meta.id })} noValidate>
                        <label className="pj-grow">
                          {t('hist.nameLabel')}
                          <input
                            ref={labelInput}
                            autoFocus
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={120}
                            placeholder={t('hist.namePlaceholder')}
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
                            {t('hist.saveName')}
                          </button>
                          <button type="button" onClick={() => stopMode('name')}>
                            {t('common.cancel')}
                          </button>
                        </span>
                        <small id="pj-history-name-help" className="pj-hint">
                          {t('hist.nameHelp')}
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
                            {t('hist.restore')}
                          </button>
                          <button type="button" onClick={() => startMode('name')} disabled={busy || !rights.label} aria-describedby={readOnlyReason ? 'pj-history-restore-hint' : undefined} data-focus="name">
                            {meta.label ? t('hist.rename') : t('hist.nameVersion')}
                          </button>
                          {meta.label && rights.remove && (
                            <button type="button" className="pj-danger-outline" onClick={() => startMode('delete')} disabled={busy} data-focus="delete">
                              {t('hist.deleteVersion')}
                            </button>
                          )}
                        </span>
                        {restoreHint && (
                          <small id="pj-history-restore-hint" className="pj-hint" data-testid="history-hint">
                            {restoreHint}
                          </small>
                        )}
                        {meta.label && !rights.remove && rights.role === 'editor' && (
                          <small className="pj-hint">{t('hist.adminDeletes')}</small>
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
