import type { ProjectsState } from './session';

/**
 * El texto del indicador de guardado cuando hay trabajo sin conexión o un conflicto por resolver. Lo comparten el banco de trabajo
 * y el editor C4 para decir lo mismo con las mismas palabras. `undefined` si no toca (se muestra el estado de siempre).
 */
export interface OfflineIndicator {
  kind: 'offline' | 'conflict';
  text: string;
}

const plural = (n: number, one: string, many: string): string => `${n === 1 ? one : many}`;

export function offlineIndicator(state: ProjectsState): OfflineIndicator | undefined {
  const offline = state.offline;
  if (!offline) return undefined;
  if (offline.conflicts > 0) {
    return { kind: 'conflict', text: offline.conflicts === 1 ? 'Hay un conflicto que resolver' : `Hay ${offline.conflicts} conflictos que resolver` };
  }
  // `save: 'offline'` sin nada en la cola no ocurre (el cambio se guarda o se cae al aviso de error), pero se cuenta como uno por si acaso.
  const waiting = Math.max(offline.waiting, state.save === 'offline' ? 1 : 0);
  if (waiting > 0) return { kind: 'offline', text: `Sin conexión: ${waiting} ${plural(waiting, 'cambio pendiente', 'cambios pendientes')}` };
  return undefined;
}
