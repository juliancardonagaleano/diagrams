import { z } from 'zod';
import { extractJson } from '../util/extractJson';
import { ProjectError } from './errors';
import { cleanName, MODULE_ID, slugify, uniqueName } from './names';
import type { ProjectSnapshot, ProjectStore, ProjectSummary } from './types';

/**
 * Un proyecto entero en un solo archivo (`*.iark-project.json`): para pasarlo de un navegador a otro, guardarlo en git,
 * mandarlo por correo o hacer copia de seguridad. Lleva los documentos tal cual, sin transformarlos.
 */
export const PROJECT_BUNDLE_FORMAT = 'iark.project';
export const PROJECT_BUNDLE_VERSION = 1;
export const PROJECT_BUNDLE_EXTENSION = '.iark-project.json';
/** Más diagramas que esto en un solo proyecto no es un uso razonable; acota lo que se acepta de un archivo ajeno. */
export const MAX_BUNDLE_DIAGRAMS = 500;

export interface BundleDiagram {
  /** Id que tenía en el almacén de origen: solo sirve para distinguir diagramas dentro del archivo. */
  id: string;
  module: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  /** El documento ya interpretado como JSON. */
  document?: unknown;
  /** El texto tal cual, cuando no era JSON válido (un borrador a medias). Si hay `document`, no se usa. */
  text?: string;
}

export interface ProjectBundle {
  format: typeof PROJECT_BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  generator?: string;
  project: { name: string; description?: string };
  diagrams: BundleDiagram[];
}

const bundleSchema = z.object({
  format: z.literal(PROJECT_BUNDLE_FORMAT, { error: `No es un proyecto de IArk (falta "format": "${PROJECT_BUNDLE_FORMAT}").` }),
  version: z.number().int().min(1),
  exportedAt: z.string().optional().default(''),
  generator: z.string().optional(),
  project: z.object({ name: z.string(), description: z.string().optional() }),
  diagrams: z
    .array(
      z.object({
        id: z.string().min(1),
        module: z.string().regex(MODULE_ID, 'módulo inválido'),
        name: z.string(),
        createdAt: z.string().optional(),
        updatedAt: z.string().optional(),
        document: z.unknown().optional(),
        text: z.string().optional(),
      }),
    )
    .max(MAX_BUNDLE_DIAGRAMS, `Un proyecto no puede tener más de ${MAX_BUNDLE_DIAGRAMS} diagramas.`),
});

/** El archivo de un proyecto: los documentos que son JSON válido van como objeto; el resto, como texto. */
export function createBundle(snapshot: ProjectSnapshot, options: { now?: Date; generator?: string } = {}): ProjectBundle {
  return {
    format: PROJECT_BUNDLE_FORMAT,
    version: PROJECT_BUNDLE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    ...(options.generator ? { generator: options.generator } : {}),
    project: { name: snapshot.name, ...(snapshot.description ? { description: snapshot.description } : {}) },
    diagrams: snapshot.diagrams.map((d) => {
      const base = { id: d.id, module: d.module, name: d.name, createdAt: d.createdAt, updatedAt: d.updatedAt };
      try {
        return { ...base, document: JSON.parse(extractJson(d.text)) as unknown };
      } catch {
        return { ...base, text: d.text };
      }
    }),
  };
}

export const bundleToText = (bundle: ProjectBundle): string => `${JSON.stringify(bundle, null, 2)}\n`;

/** Nombre de archivo sugerido para el proyecto (`tienda.iark-project.json`). */
export const bundleFileName = (projectName: string): string => `${slugify(projectName, 'proyecto')}${PROJECT_BUNDLE_EXTENSION}`;

/** Lee y valida el archivo de un proyecto. Rechaza con `ProjectError('invalid')` y un mensaje que dice qué falla. */
export function parseBundle(text: string): ProjectBundle {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ProjectError('invalid', `El archivo no es JSON válido: ${(error as Error).message}`, { reason: 'bundle-not-json', params: { detail: (error as Error).message } });
  }
  if (json && typeof json === 'object' && (json as { format?: unknown }).format !== PROJECT_BUNDLE_FORMAT) {
    throw new ProjectError('invalid', `No es un proyecto de IArk: falta "format": "${PROJECT_BUNDLE_FORMAT}". (Un diagrama suelto se abre con «Abrir archivo…».)`, { reason: 'bundle-not-project', params: { format: PROJECT_BUNDLE_FORMAT } });
  }
  const parsed = bundleSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(raíz)'}: ${i.message}`);
    throw new ProjectError('invalid', `El archivo del proyecto no es válido:\n${issues.join('\n')}`, { reason: 'bundle-invalid', params: { issues: issues.join('\n') } });
  }
  const bundle = parsed.data;
  if (bundle.version > PROJECT_BUNDLE_VERSION) {
    throw new ProjectError('invalid', `Este proyecto se guardó con una versión más nueva del formato (${bundle.version}); esta instalación entiende hasta la ${PROJECT_BUNDLE_VERSION}.`, {
      reason: 'bundle-newer',
      params: { found: bundle.version, supported: PROJECT_BUNDLE_VERSION },
    });
  }
  const ids = new Set<string>();
  for (const [index, diagram] of bundle.diagrams.entries()) {
    if (ids.has(diagram.id)) throw new ProjectError('invalid', `El diagrama ${index + 1} repite el id «${diagram.id}».`, { reason: 'bundle-duplicate-id', params: { index: index + 1, id: diagram.id } });
    ids.add(diagram.id);
    if (diagram.document === undefined && diagram.text === undefined) throw new ProjectError('invalid', `El diagrama «${diagram.name}» no trae ni "document" ni "text".`, { reason: 'bundle-no-content', params: { name: diagram.name } });
  }
  return bundle as ProjectBundle;
}

export interface ImportedProject {
  project: ProjectSummary;
  /** El nombre con el que se creó, si hubo que cambiarlo porque ya existía uno igual. */
  renamedFrom?: string;
  diagrams: number;
}

/**
 * Crea un proyecto nuevo con el contenido del archivo. Nunca pisa uno existente: si el nombre ya está tomado se le añade
 * « (2)». Si algo falla a mitad, el proyecto a medio crear se deshace.
 */
export async function importBundle(store: ProjectStore, bundle: ProjectBundle, options: { name?: string } = {}): Promise<ImportedProject> {
  const wanted = cleanName(options.name ?? bundle.project.name, 'del proyecto');
  const name = uniqueName(wanted, (await store.listProjects()).map((p) => p.name));
  const project = await store.createProject({ name, description: bundle.project.description });
  try {
    const taken: string[] = [];
    for (const diagram of bundle.diagrams) {
      const label = uniqueName(cleanName(diagram.name, 'del diagrama'), taken);
      taken.push(label);
      const text = diagram.document !== undefined ? JSON.stringify(diagram.document, null, 2) : (diagram.text ?? '');
      await store.saveDiagram(project.id, { module: diagram.module, name: label, text });
    }
  } catch (error) {
    await store.deleteProject(project.id).catch(() => undefined);
    throw error;
  }
  return { project: (await store.getProject(project.id)) ?? project, ...(name !== wanted ? { renamedFrom: wanted } : {}), diagrams: bundle.diagrams.length };
}
