import { z } from 'zod';
import { contractVersionOf } from './contract';
import { MANIFEST_SCHEMA_ID } from './endpoint';
import { EMBED_PROTOCOL_VERSION } from './protocol';
import type { ModuleRegistry } from './registry';

/**
 * Manifiesto de federación: cada instancia publica `/.well-known/iark.json` con los módulos que ofrece, para que un
 * shell o un anfitrión los descubra sin acoplarse a su código. `buildManifest` lo genera y `manifestSchema` valida el
 * de una instancia remota antes de usarlo.
 */
export { MANIFEST_SCHEMA_ID };

export const moduleManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  /**
   * Versión del contrato `DomainModule` contra la que se escribió el módulo. Opcional al leer: una instancia anterior a
   * `contractVersion` no lo publica y se toma como 1. Quien consume el manifiesto (el shell) rechaza el módulo si exige un
   * contrato mayor que el que entiende.
   */
  contractVersion: z.number().int().min(1).optional(),
  documentVersion: z.string(),
  importFormats: z.array(z.string()),
  exportFormats: z.array(z.string()),
  /**
   * URLs (absolutas o relativas al manifiesto) de las superficies que ofrece la instancia para este módulo. El esquema solo
   * pide «cadena»: quien las usa las resuelve con `resolveEndpointUrl`, que rechaza todo lo que no acabe en `http:`/`https:`.
   */
  endpoints: z
    .object({
      embed: z.string().optional(),
      api: z.string().optional(),
      schema: z.string().optional(),
    })
    .optional(),
});

/** Cómo se autentica quien llama a la API de proyectos de la instancia: `bearer` (cabecera `Authorization: Bearer <token>`) o `none` (sin autenticación). */
export const PROJECTS_AUTH = ['bearer', 'none'] as const;
export type ProjectsAuth = (typeof PROJECTS_AUTH)[number];

export const manifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA_ID),
  name: z.string(),
  version: z.string(),
  /**
   * Versión (`mayor.menor`) del protocolo `postMessage` de los editores embebibles de la instancia. Opcional al leer: una
   * instancia anterior no lo publica y se toma como «1.0». Una versión mayor distinta de la nuestra no se puede embeber.
   */
  protocol: z.string().optional(),
  modules: z.array(moduleManifestSchema),
  /** URL (absoluta o relativa al manifiesto) de la API de proyectos; solo la declara una instancia con espacio de trabajo (`iark serve --workspace`). */
  projects: z.string().optional(),
  /** Cómo se autentica esa API; acompaña a `projects`. */
  projectsAuth: z.enum(PROJECTS_AUTH).optional(),
  /** URL (absoluta o relativa al manifiesto) del canal de cambios en tiempo real (`GET /api/events`, Server-Sent Events); acompaña a `projects` y solo la declara una instancia que lo ofrece. Sin ella, se sondea. */
  projectsEvents: z.string().optional(),
});

export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type SuiteManifest = z.infer<typeof manifestSchema>;

export interface ManifestOptions {
  name: string;
  version: string;
  /** Endpoints por id de módulo (p. ej. la URL del widget embebible). */
  endpoints?: Record<string, ModuleManifest['endpoints']>;
}

export function buildManifest(registry: ModuleRegistry, options: ManifestOptions): SuiteManifest {
  return {
    schema: MANIFEST_SCHEMA_ID,
    name: options.name,
    version: options.version,
    protocol: EMBED_PROTOCOL_VERSION,
    modules: registry.list().map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      ...(m.description ? { description: m.description } : {}),
      contractVersion: contractVersionOf(m),
      documentVersion: m.documentVersion,
      importFormats: m.importers.map((i) => i.id),
      exportFormats: m.exporters.map((e) => e.id),
      ...(options.endpoints?.[m.id] ? { endpoints: options.endpoints[m.id] } : {}),
    })),
  };
}
