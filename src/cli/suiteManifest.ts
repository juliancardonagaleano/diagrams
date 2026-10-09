import { buildManifest, type ModuleManifest, type ModuleRegistry, type ProjectsAuth, type SuiteManifest } from '@iark/kernel';

export const SUITE_NAME = 'IArk - DIAgrams';

/** Módulos cuyo editor propio es la aplicación principal (`index.html`); el resto los abre el banco de trabajo (`modulos.html`). */
const OWN_EDITOR = new Set(['c4']);

export interface SuiteManifestOptions {
  version: string;
  /**
   * Prefijo de la API HTTP de la instancia, relativo al manifiesto (`../api`); solo lo declara `iark serve`. El sitio
   * estático (GitHub Pages) no tiene API, así que su manifiesto no anuncia `api`.
   */
  api?: string;
  /** La instancia sirve el sitio (editores embebibles y JSON Schema estáticos). Por defecto sí; un servicio solo con API, no. */
  site?: boolean;
  /** La instancia tiene un espacio de trabajo (`iark serve --workspace`): anuncia la API de proyectos. Hace falta `api`. */
  projects?: boolean;
  /** Cómo se autentica la API de proyectos: `bearer` (`iark serve --tokens`) o `none` (por omisión). Solo se anuncia junto a `projects`. */
  projectsAuth?: ProjectsAuth;
  /** La instancia ofrece los cambios de proyectos en tiempo real (`GET /api/events`). Solo se anuncia junto a `projects`. */
  events?: boolean;
}

/**
 * El manifiesto, con `projects` (la URL de la API de proyectos, relativa al manifiesto) y `projectsAuth` solo si la instancia
 * tiene espacio de trabajo. Ambos campos los conoce ya `manifestSchema` del núcleo.
 */
export type InstanceManifest = SuiteManifest;

/**
 * Manifiesto de federación de una instancia (`iark.manifest/1`). Las URL de `endpoints` son relativas al propio manifiesto,
 * que se publica en `/.well-known/iark.json`: `../modulos.html` es el banco de trabajo, `../schema/…` los JSON Schema.
 * Así el mismo manifiesto vale bajo cualquier ruta base (GitHub Pages sirve bajo `/<repositorio>/`).
 */
export function suiteManifest(registry: ModuleRegistry, options: SuiteManifestOptions): InstanceManifest {
  const site = options.site ?? true;
  const api = options.api?.replace(/\/+$/, '');
  const endpoints: Record<string, ModuleManifest['endpoints']> = {};
  for (const module of registry.list()) {
    // Un módulo de terceros (cargado desde `iark.config.json`) no está en el sitio: ni su editor en el banco de trabajo ni su JSON
    // Schema estático existen, porque el sitio enlaza los seis módulos incorporados al compilarse. Se anuncian solo la API y el
    // esquema que sirve la API; la web no puede abrirlo (ver docs/plugins.md, «Límites»).
    const external = registry.originOf(module.id) !== undefined;
    const found = {
      ...(site && !external ? { embed: OWN_EDITOR.has(module.id) ? '../' : `../modulos.html?module=${module.id}` } : {}),
      ...(site && !external ? { schema: `../schema/${module.id}-document.schema.json` } : api ? { schema: `${api}/${module.id}/schema` } : {}),
      ...(api ? { api: `${api}/${module.id}` } : {}),
    };
    if (Object.keys(found).length > 0) endpoints[module.id] = found;
  }
  return {
    ...buildManifest(registry, { name: SUITE_NAME, version: options.version, endpoints }),
    ...(options.projects && api ? { projects: `${api}/projects`, projectsAuth: options.projectsAuth ?? 'none', ...(options.events ? { projectsEvents: `${api}/events` } : {}) } : {}),
  };
}
