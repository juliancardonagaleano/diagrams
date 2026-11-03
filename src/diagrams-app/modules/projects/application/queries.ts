import type { ProjectStore } from '@iark/kernel';

/** Lectura: bypass directo a infraestructura (spec 003, backend-coredomain). */
export async function listProjectsQuery(store: ProjectStore) {
  return store.listProjects();
}
