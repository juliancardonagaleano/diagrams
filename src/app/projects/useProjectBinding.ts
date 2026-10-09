import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { DiagramMeta } from '@iark/kernel';
import { formatIssues, validateDocument } from '@core/model/schema';
import type { C4Document } from '@core/model/types';
import { getProjectSession as sharedProjectSession, resetProjectSession as resetSharedProjectSession } from '../../projects/factory';
import type { ConflictChoice, ProjectSession, ProjectsState } from '../../projects/session';
import { isEmbedMode, useDocumentStore } from '../store/documentStore';
import { extractJson } from '../utils/files';

/** Módulo del editor C4: solo sus diagramas se abren aquí; los de otros módulos se abren en el banco de trabajo. */
export const C4_MODULE = 'c4';

const serialize = (doc: C4Document): string => JSON.stringify(doc, null, 2);

/** Enlace al banco de trabajo con ese diagrama abierto (`modulos.html` está junto al editor, en la misma carpeta del sitio). */
export const workbenchUrl = (projectId: string, diagramId: string): string => `modulos.html?project=${encodeURIComponent(projectId)}&diagram=${encodeURIComponent(diagramId)}`;

/**
 * La sesión de proyectos de esta pestaña (una sola, de la fábrica compartida con el banco de trabajo: guarda en este navegador
 * o en el servidor configurado). En modo embebido no hay: guarda el anfitrión.
 */
export function getProjectSession(): ProjectSession | undefined {
  return isEmbedMode ? undefined : sharedProjectSession();
}

/** Suelta la sesión compartida (la siguiente petición crea otra). Solo para las pruebas. */
export const resetProjectSession = resetSharedProjectSession;

export interface ProjectBinding {
  session: ProjectSession | undefined;
  state: ProjectsState | undefined;
  /** Abre un diagrama del proyecto: en el editor si es C4 y, si no, lleva al banco de trabajo. Rechaza con el motivo si no se puede. */
  open(projectId: string, diagram: DiagramMeta): Promise<void>;
  /** El documento del editor, para guardarlo en un proyecto. */
  current(): { module: string; text: string; name: string };
  /**
   * Resuelve un conflicto de guardado (otra pestaña, otra persona u otro equipo guardó el mismo diagrama): conservar esta versión, cargar la guardada o
   * guardar la propia como diagrama nuevo. Con `key` se resuelve el de otro diagrama que quedó pendiente en el navegador.
   */
  resolveConflict(choice: ConflictChoice, options?: { key?: string; name?: string }): Promise<void>;
}

const NO_STATE = { subscribe: () => () => undefined, getState: () => undefined as ProjectsState | undefined };

/**
 * Conecta el editor C4 con los proyectos: reabre el último diagrama C4 que se editaba, guarda solos los cambios del
 * diagrama abierto, avisa al cerrar la pestaña si algo quedó sin guardar y abre diagramas de proyecto en el editor.
 */
export function useProjectBinding(): ProjectBinding {
  const session = useMemo(() => getProjectSession(), []);
  const state = useSyncExternalStore(session?.subscribe ?? NO_STATE.subscribe, session?.getState ?? NO_STATE.getState);
  /** Texto con el que el editor y el proyecto están de acuerdo: un cambio solo se guarda si lo difiere. */
  const baseline = useRef<string | undefined>(undefined);
  /** Mientras se abre un diagrama, el cambio de documento es la carga, no una edición. */
  const loading = useRef(0);
  const started = useRef(false);

  /** Carga el texto de un diagrama C4 en el editor. Lanza con el motivo si no es un documento C4 válido. */
  const load = useCallback((text: string, name: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(extractJson(text));
    } catch (error) {
      throw new Error(`El diagrama «${name}» no es JSON válido: ${(error as Error).message}`);
    }
    const result = validateDocument(json);
    if (!result.ok) throw new Error(`El diagrama «${name}» no es un documento C4 válido:\n${formatIssues(result.issues)}`);
    // El cambio de documento que sigue es la carga, no una edición: no se vuelve a guardar.
    loading.current += 1;
    try {
      baseline.current = serialize(result.document);
      useDocumentStore.getState().setDocument(result.document, { markSaved: true });
    } finally {
      loading.current -= 1;
    }
  }, []);

  const open = useCallback(
    async (projectId: string, diagram: DiagramMeta): Promise<void> => {
      if (!session) throw new Error('Los proyectos no están disponibles en el modo embebido.');
      if (diagram.module !== C4_MODULE) {
        await session.flush();
        // Queda como lo último abierto: el banco de trabajo lo reabre desde ahí.
        await session.openDiagram(projectId, diagram.id);
        window.location.assign(workbenchUrl(projectId, diagram.id));
        return;
      }
      const opened = await session.openDiagram(projectId, diagram.id);
      try {
        load(opened.text, diagram.name);
      } catch (error) {
        session.detach();
        throw error;
      }
    },
    [session, load],
  );

  // Arranque: carga la lista y reabre el último diagrama C4 que se estaba editando (si lo último fue de otro módulo, solo recuerda el proyecto).
  useEffect(() => {
    if (!session || started.current) return;
    started.current = true;
    void (async () => {
      const last = await session.init();
      const meta = session.getState().projects.find((p) => p.id === last?.projectId)?.diagrams.find((d) => d.id === last?.diagramId);
      if (last?.projectId && meta?.module === C4_MODULE) await open(last.projectId, meta).catch(() => undefined);
    })();
  }, [session, open]);

  useEffect(() => {
    if (!session) return;
    const attachedC4 = (): boolean => session.attached && session.diagram?.module === C4_MODULE;
    // Un documento nuevo en el editor mientras hay un diagrama C4 abierto es una edición: se guarda tras una pausa.
    const stopDoc = useDocumentStore.subscribe((now, before) => {
      if (now.doc === before.doc || loading.current > 0 || !attachedC4()) return;
      const text = serialize(now.doc);
      if (text === baseline.current) return;
      baseline.current = text;
      session.queueSave(text);
    });
    // Guardar el documento actual como diagrama del proyecto lo deja abierto: desde ahí, el editor y el proyecto coinciden.
    let diagramId = session.getState().diagramId;
    const stopSession = session.subscribe(() => {
      const s = session.getState();
      if (s.diagramId !== diagramId) {
        diagramId = s.diagramId;
        if (loading.current === 0 && attachedC4()) baseline.current = serialize(useDocumentStore.getState().doc);
      }
      // «Cambios sin guardar» del editor se refiere al archivo JSON; con un diagrama de proyecto abierto lo guarda el proyecto.
      if (s.save === 'saved' && attachedC4() && useDocumentStore.getState().modified) useDocumentStore.getState().markSaved();
    });
    const flush = (): void => void session.flush();
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const guard = (event: BeforeUnloadEvent): void => {
      if (session.dirty) event.preventDefault();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', guard);
    return () => {
      stopDoc();
      stopSession();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', guard);
    };
  }, [session]);

  const resolveConflict = useCallback(
    async (choice: ConflictChoice, options: { key?: string; name?: string } = {}): Promise<void> => {
      if (!session) return;
      const diagram = await session.resolveConflict(choice, options);
      if (diagram) load(diagram.text, diagram.name);
    },
    [session, load],
  );

  const current = useCallback((): { module: string; text: string; name: string } => {
    const { doc } = useDocumentStore.getState();
    return { module: C4_MODULE, text: serialize(doc), name: doc.workspace.name };
  }, []);

  return { session, state, open, current, resolveConflict };
}
