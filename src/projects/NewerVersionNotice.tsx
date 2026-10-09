import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { projectErrorText } from '../i18n/errores';
import { useT } from '../i18n/react';
import type { ProjectSession } from './session';
import './projects.css';

export interface NewerVersionNoticeProps {
  session: ProjectSession;
  /**
   * Carga la versión más nueva en el editor (cada pantalla lo conecta con su anfitrión, que recibe el diagrama de `session.loadNewer()` y lo pone en pantalla).
   * Rechaza con el motivo si no se pudo (por ejemplo, porque entre tanto se escribió algo que se perdería).
   */
  load(): Promise<void>;
  /** Cómo contar un fallo al cargar (cada pantalla tiene su aviso). */
  notify(message: string): void;
}

/**
 * «Hay una versión más nueva»: otra persona, otro equipo u otra pestaña guardó el diagrama abierto en el servidor y aquí no hay nada pendiente. Ofrece cargarla o
 * ignorar el aviso; no hace nada solo (no hay edición colaborativa: lo que se está escribiendo no se toca nunca). Si aquí hay cambios sin guardar el aviso no sale:
 * al guardarse, el conflicto de siempre (con sus tres salidas) decide sin perder nada.
 *
 * Accesibilidad: el mensaje vive en una región `role="status"` (cortés) que está siempre en la página, vacía mientras no hay aviso, para que los lectores de
 * pantalla anuncien el texto cuando aparece; los botones son botones normales, alcanzables con el teclado en orden de lectura. Al cargar, el foco pasa a la región
 * (el botón desaparece) y esta anuncia el resultado, para que quien navega con teclado o lector no pierda el sitio.
 */
export function NewerVersionNotice({ session, load, notify }: NewerVersionNoticeProps) {
  const { t } = useT();
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const region = useRef<HTMLSpanElement>(null);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const refocus = useRef(false);
  const name = session.diagram?.name;
  const newer = session.remote ? state.newer : undefined;

  // El «ya está cargada» se retira solo; el siguiente aviso lo sustituye.
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(undefined), 6000);
    return () => clearTimeout(timer);
  }, [done]);
  useEffect(() => {
    if (newer) setDone(undefined);
  }, [newer]);
  // El botón pulsado desapareció con el aviso y el foco se perdió: vuelve a la región, que ahora cuenta el resultado (si la persona no se fue a otro sitio entre tanto).
  useEffect(() => {
    if (done && (document.activeElement === document.body || document.activeElement === null)) region.current?.focus();
  }, [done]);

  if (!session.remote) return null;

  const loadNow = (): void => {
    setBusy(true);
    region.current?.focus(); // el botón se deshabilita mientras carga: el foco espera en la región
    load()
      .then(() => setDone(t('newer.loaded', { name: name ?? t('newer.theDiagram') })))
      .catch((error: Error) => {
        notify(projectErrorText(error));
        refocus.current = true;
      })
      .finally(() => setBusy(false));
  };
  // Si no se pudo cargar, el botón sigue ahí (ya habilitado) y recupera el foco.
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    region.current?.parentElement?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [busy]);

  const shownName = name ?? t('newer.thisDiagram');
  const text = newer ? (newer.by ? t('newer.by', { by: newer.by, name: shownName }) : t('newer.noBy', { name: shownName })) : (done ?? '');
  return (
    <span className="pj-newer" data-testid="newer-version" data-active={newer ? 'true' : 'false'}>
      <span ref={region} role="status" aria-live="polite" tabIndex={-1} className="pj-newer-text" data-testid="newer-version-text">
        {text}
      </span>
      {newer && (
        <>
          <button type="button" className="pj-primary" onClick={loadNow} disabled={busy} data-testid="newer-version-load">
            {t('newer.load')}
          </button>
          <button type="button" onClick={() => session.dismissNewer()} aria-label={t('newer.ignoreLabel')} data-testid="newer-version-dismiss">
            {t('newer.ignore')}
          </button>
        </>
      )}
    </span>
  );
}
