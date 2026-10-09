import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';
import type { PendingView } from './offlineSync';
import type { ConflictChoice, ProjectSession } from './session';
import './projects.css';

export interface OfflineActionsProps {
  session: ProjectSession;
  /**
   * Resuelve el conflicto de un diagrama (`key` es el del cambio en la cola). Cada pantalla lo conecta con su anfitrión: si el diagrama es el
   * que está en el editor y se elige lo del servidor, el anfitrión carga en pantalla la versión que devuelve la sesión.
   */
  resolve(choice: ConflictChoice, key: string, name?: string): Promise<void>;
}

const PROBLEM_TEXT: Record<NonNullable<PendingView['problem']>, (entry: PendingView) => string> = {
  changed: () => 'Mientras tanto, otra persona u otro equipo cambió este diagrama en el servidor. Tu versión está guardada en este navegador y no se ha pisado nada.',
  gone: () => 'Este diagrama ya no existe en el servidor (alguien lo borró). Tu versión sigue guardada en este navegador.',
  rejected: (entry) => `El servidor no aceptó tu versión${entry.reason ? `: ${entry.reason}` : '.'} Sigue guardada en este navegador.`,
};

type Pending = { key: string; choice: ConflictChoice };

/**
 * Lo que acompaña al indicador de guardado cuando hay trabajo sin conexión: «Reintentar ahora», el aviso de que lo último no cupo en la
 * cola de este navegador y, si hay conflictos, el botón que abre su resolución. No dibuja el indicador (cada pantalla tiene el suyo, con
 * `role="status"`); con un almacén en este navegador, o sin nada que decir, no dibuja nada.
 */
export function OfflineActions({ session, resolve }: OfflineActionsProps) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const offline = state.offline;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const conflicts = offline?.entries.filter((entry) => entry.status === 'conflict') ?? [];

  // Sin conflictos que resolver el cuadro no tiene nada que mostrar: se cierra solo.
  useEffect(() => {
    if (open && conflicts.length === 0) setOpen(false);
  }, [open, conflicts.length]);

  if (!offline) return null;
  const waiting = offline.waiting > 0 || state.save === 'offline';
  if (!waiting && conflicts.length === 0 && !offline.full) return null;

  return (
    <>
      <span className="pj-offline-actions" data-testid="offline-actions">
        {waiting && conflicts.length === 0 && (
          <button type="button" onClick={() => void session.retryNow()} disabled={offline.retrying} data-testid="retry-now">
            {offline.retrying ? 'Reintentando…' : 'Reintentar ahora'}
          </button>
        )}
        {conflicts.length > 0 && (
          <button ref={opener} type="button" className="pj-primary" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="resolve-conflict">
            Resolver el conflicto…
          </button>
        )}
        {offline.full && (
          <p className="pj-offline-full" role="alert" data-testid="offline-full">
            {offline.full}
          </p>
        )}
      </span>
      {open && conflicts.length > 0 && <ConflictDialog entries={conflicts} resolve={resolve} onClose={() => setOpen(false)} opener={opener} />}
    </>
  );
}

function ConflictDialog({ entries, resolve, onClose, opener }: { entries: PendingView[]; resolve: OfflineActionsProps['resolve']; onClose(): void; opener: RefObject<HTMLButtonElement | null> }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState<Pending | undefined>();
  const [copying, setCopying] = useState<{ key: string; name: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    return () => {
      alive.current = false;
      const back = opener.current ?? from;
      if (back && back.isConnected) back.focus();
    };
  }, [opener]);

  // Al abrir una confirmación o la copia, el foco va a su primer botón o campo: se lee y se maneja con el teclado sin buscarla.
  useEffect(() => {
    if (confirming) dialog.current?.querySelector<HTMLElement>('[data-confirm] button')?.focus();
  }, [confirming]);
  useEffect(() => {
    if (copying) dialog.current?.querySelector<HTMLElement>('[data-copy] input')?.focus();
  }, [copying?.key]); // eslint-disable-line react-hooks/exhaustive-deps -- solo al abrirla, no con cada letra

  const run = async (choice: ConflictChoice, key: string, name?: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await resolve(choice, key, name);
      if (alive.current) {
        setConfirming(undefined);
        setCopying(undefined);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirming || copying) {
        setConfirming(undefined);
        setCopying(undefined);
      } else onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Foco atrapado dentro del cuadro.
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
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

  return (
    <div className="pj-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pj-dialog pj-conflict" role="dialog" aria-modal="true" aria-labelledby="pj-conflict-title" ref={dialog} tabIndex={-1} onKeyDown={onKeyDown} data-testid="conflict-dialog">
        <header className="pj-head">
          <h2 id="pj-conflict-title">{entries.length === 1 ? 'Hay un conflicto que resolver' : `Hay ${entries.length} conflictos que resolver`}</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </header>
        <div className="pj-conflict-body">
          <p>Tu versión de cada diagrama no se ha enviado ni se ha pisado la del servidor: se conserva en este navegador hasta que elijas.</p>
          {error && (
            <p className="pj-error" role="alert" data-testid="conflict-error">
              {error}
            </p>
          )}
          <ul className="pj-conflict-list">
            {entries.map((entry) => {
              const gone = entry.problem === 'gone';
              const mine = confirming?.key === entry.key ? confirming : undefined;
              const copy = copying?.key === entry.key ? copying : undefined;
              return (
                <li key={entry.key} className="pj-conflict-item" data-testid="conflict-item" data-diagram={entry.diagramId} data-problem={entry.problem}>
                  <strong>«{entry.name}»</strong>
                  <small>{PROBLEM_TEXT[entry.problem ?? 'changed'](entry)}</small>
                  <div className="pj-conflict-choices" role="group" aria-label={`Qué hacer con «${entry.name}»`}>
                    <button type="button" onClick={() => setConfirming({ key: entry.key, choice: 'reload' })} disabled={busy} data-choice="server">
                      {gone ? 'Descartar la mía' : 'Quedarme con la del servidor'}
                    </button>
                    {!gone && (
                      <button type="button" onClick={() => setConfirming({ key: entry.key, choice: 'overwrite' })} disabled={busy} data-choice="mine">
                        Quedarme con la mía
                      </button>
                    )}
                    <button type="button" onClick={() => setCopying({ key: entry.key, name: `${entry.name} (mi versión)` })} disabled={busy} data-choice="copy">
                      Guardar la mía como diagrama nuevo
                    </button>
                  </div>
                  {mine && (
                    <p className="pj-confirm" role="alert" data-confirm={mine.choice} data-testid="conflict-confirm">
                      {mine.choice === 'reload'
                        ? gone
                          ? `Se descartará tu versión de «${entry.name}». No se puede deshacer.`
                          : `Se descartará tu versión de «${entry.name}» y te quedarás con la que hay en el servidor. No se puede deshacer.`
                        : `Tu versión de «${entry.name}» sustituirá a la que hay ahora en el servidor: lo que cambió la otra persona se perderá.`}
                      <button type="button" className="pj-danger" onClick={() => void run(mine.choice, entry.key)} disabled={busy}>
                        {mine.choice === 'reload' ? (gone ? 'Sí, descartarla' : 'Sí, quedarme con la del servidor') : 'Sí, quedarme con la mía'}
                      </button>
                      <button type="button" onClick={() => setConfirming(undefined)} disabled={busy}>
                        Cancelar
                      </button>
                    </p>
                  )}
                  {copy && (
                    <form
                      className="pj-conflict-copy"
                      data-copy
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (copy.name.trim()) void run('copy', entry.key, copy.name.trim());
                      }}
                    >
                      <label>
                        Nombre del diagrama nuevo
                        <input type="text" value={copy.name} maxLength={120} onChange={(e) => setCopying({ key: entry.key, name: e.target.value })} />
                      </label>
                      <button type="submit" className="pj-primary" disabled={busy || !copy.name.trim()}>
                        Guardar la copia
                      </button>
                      <button type="button" onClick={() => setCopying(undefined)} disabled={busy}>
                        Cancelar
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
