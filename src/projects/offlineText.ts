import { tp } from '../i18n';
import type { ProjectsState } from './session';

/**
 * El texto del indicador de guardado cuando hay trabajo sin conexión o un conflicto por resolver. Lo comparten el banco de trabajo
 * y el editor C4 para decir lo mismo con las mismas palabras. `undefined` si no toca (se muestra el estado de siempre).
 */
export interface OfflineIndicator {
  kind: 'offline' | 'conflict';
  text: string;
}

export function offlineIndicator(state: ProjectsState): OfflineIndicator | undefined {
  const offline = state.offline;
  if (!offline) return undefined;
  if (offline.conflicts > 0) {
    return { kind: 'conflict', text: tp('offline.conflicts', offline.conflicts) };
  }
  // `save: 'offline'` sin nada en la cola no ocurre (el cambio se guarda o se cae al aviso de error), pero se cuenta como uno por si acaso.
  const waiting = Math.max(offline.waiting, state.save === 'offline' ? 1 : 0);
  if (waiting > 0) return { kind: 'offline', text: tp('offline.waiting', waiting) };
  return undefined;
}
