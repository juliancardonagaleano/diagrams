import { bundleToText, createBundle, HttpProjectStore, importBundle, parseBundle, snapshotProject, type ImportedProject, type ProjectStore } from '@iark/kernel';
import { t } from '../i18n';
import { loadBackend, type BackendConfig } from './backend';
import { IndexedDbProjectStore } from './indexedDbStore';
import type { SessionBackend } from './session';

/**
 * Copiar un proyecto de un almacén a otro (del navegador a un servidor, o al revés) con el archivo único del núcleo:
 * instantánea → archivo `iark.project/1` → importación en el destino. Es la misma ruta que «Exportar» e «Importar proyecto»
 * (sin pasar por un archivo en disco), así que tampoco pisa nada: si el nombre ya existe en el destino, el copiado se llama
 * «Nombre (2)». Si algo falla a mitad, la importación deshace el proyecto a medio crear.
 */
export async function copyProject(source: ProjectStore, projectId: string, target: ProjectStore): Promise<ImportedProject> {
  const snapshot = await snapshotProject(source, projectId);
  // Se pasa por el texto del archivo para validarlo igual que uno importado a mano (módulos, tamaño, ids repetidos).
  const bundle = parseBundle(bundleToText(createBundle(snapshot, { generator: 'DIAgrams' })));
  return importBundle(target, bundle);
}

/** El otro almacén: hacia donde se puede copiar sin cambiar el activo. Se le abre su propio `ProjectStore`, que no es el de la sesión. */
export interface CopyTarget {
  kind: 'local' | 'remote';
  /** Para las frases: «en este navegador», «en el servidor localhost:8787». */
  where: string;
  /** El texto del botón: «Copiar a este navegador», «Copiar al servidor (localhost:8787)» y, sin servidor conocido, «Copiar a un servidor…». */
  label: string;
  /** `false` si aún no hay servidor al que copiar (hay que conectarse primero). */
  ready: boolean;
  /** Un almacén temporal del destino y cómo soltarlo. */
  open(): { store: ProjectStore; close(): Promise<void> | void };
}

const noop = (): void => undefined;

export function copyTargetFor(active: SessionBackend, options: { config?: BackendConfig; fetch?: typeof fetch } = {}): CopyTarget {
  if (active.kind === 'remote') {
    return {
      kind: 'local',
      where: t('copy.where.local'),
      label: t('copy.label.local'),
      ready: true,
      open: () => {
        const store = new IndexedDbProjectStore();
        return { store, close: () => store.close() };
      },
    };
  }
  const config = options.config ?? loadBackend();
  const server = config.kind === 'remote' ? config : config.server;
  if (!server) {
    return {
      kind: 'remote',
      where: t('copy.where.unknown'),
      label: t('copy.label.connect'),
      ready: false,
      open: () => {
        throw new Error(t('copy.connectFirst'));
      },
    };
  }
  const host = new URL(server.url).host;
  return {
    kind: 'remote',
    where: t('copy.where.server', { host }),
    label: t('copy.label.server', { host }),
    ready: true,
    open: () => ({ store: new HttpProjectStore({ baseUrl: server.url, token: server.token, fetch: options.fetch }), close: noop }),
  };
}
