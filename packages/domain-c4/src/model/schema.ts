import { z } from 'zod';
import { migrateValue, parseUrn, refTypeSchema } from '@iark/kernel';
import { c4MigrationSource } from './migrations';
import {
  DOCUMENT_VERSION,
  PARENT_TYPE,
  VIEW_SCOPE_TYPE,
  type C4Document,
} from './types';

const idSchema = z.string().min(1, 'El id no puede estar vacío').max(120);

export const elementTypeSchema = z.enum(['person', 'softwareSystem', 'container', 'component']);
export const elementShapeSchema = z.enum(['default', 'database', 'queue', 'browser', 'mobile']);
export const viewTypeSchema = z.enum(['systemContext', 'container', 'component']);
export const layoutDirectionSchema = z.enum(['DOWN', 'RIGHT', 'UP', 'LEFT']);

export const elementSchema = z.object({
  id: idSchema,
  type: elementTypeSchema,
  name: z.string().min(1, 'El nombre no puede estar vacío'),
  description: z.string().optional(),
  technology: z.string().optional(),
  tags: z.array(z.string()).optional(),
  external: z.boolean().optional(),
  parentId: idSchema.optional(),
  shape: elementShapeSchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'El color debe ser hexadecimal (#RRGGBB)')
    .optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
});

export const relationshipSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  description: z.string().optional(),
  technology: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const viewElementSchema = z.object({
  id: idSchema,
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const layoutDensitySchema = z.enum(['auto', 'compact', 'spacious']);

export const layoutDistributionSchema = z.enum(['auto', 'centered', 'elk']);

export const layoutOptionsSchema = z.object({
  direction: layoutDirectionSchema.optional(),
  spacing: z.number().positive().optional(),
  layerSpacing: z.number().positive().optional(),
  density: layoutDensitySchema.optional(),
  distribution: layoutDistributionSchema.optional(),
});

export const pointSchema = z.object({ x: z.number(), y: z.number() });

export const viewEdgeSchema = z.object({
  id: idSchema,
  points: z.array(pointSchema).min(2),
  label: pointSchema.optional(),
});

export const viewSchema = z.object({
  id: idSchema,
  type: viewTypeSchema,
  scopeId: idSchema.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  elements: z.array(viewElementSchema).default([]),
  edges: z.array(viewEdgeSchema).optional(),
  layout: layoutOptionsSchema.optional(),
});

export const workspaceSchema = z.object({
  name: z.string().default('Diagrama C4'),
  description: z.string().optional(),
});

export const modelSchema = z.object({
  elements: z.array(elementSchema).default([]),
  relationships: z.array(relationshipSchema).default([]),
});

/**
 * Esquema estructural + reglas semánticas (referencias y jerarquía C4).
 */
export const documentSchema = z
  .object({
    version: z.literal(DOCUMENT_VERSION).default(DOCUMENT_VERSION),
    workspace: workspaceSchema.default({ name: 'Diagrama C4' }),
    model: modelSchema.default({ elements: [], relationships: [] }),
    views: z.array(viewSchema).default([]),
  })
  .superRefine((doc, ctx) => {
    const elements = new Map<string, (typeof doc.model.elements)[number]>();
    doc.model.elements.forEach((el, i) => {
      if (elements.has(el.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['model', 'elements', i, 'id'],
          message: `Id de elemento duplicado: "${el.id}"`,
        });
      }
      elements.set(el.id, el);
    });

    doc.model.elements.forEach((el, i) => {
      if (el.ref !== undefined && !parseUrn(el.ref)) {
        ctx.addIssue({ code: 'custom', path: ['model', 'elements', i, 'ref'], message: `La referencia de "${el.id}" no es una URN válida (urn:iark:<módulo>:<id>): "${el.ref}"` });
      }
      const expectedParent = PARENT_TYPE[el.type];
      if (el.parentId !== undefined) {
        const parent = elements.get(el.parentId);
        if (!parent) {
          ctx.addIssue({
            code: 'custom',
            path: ['model', 'elements', i, 'parentId'],
            message: `El elemento "${el.id}" referencia un padre inexistente: "${el.parentId}"`,
          });
        } else if (!expectedParent) {
          ctx.addIssue({
            code: 'custom',
            path: ['model', 'elements', i, 'parentId'],
            message: `Un elemento de tipo "${el.type}" no puede tener padre`,
          });
        } else if (parent.type !== expectedParent) {
          ctx.addIssue({
            code: 'custom',
            path: ['model', 'elements', i, 'parentId'],
            message: `El padre de "${el.id}" (${el.type}) debe ser de tipo "${expectedParent}", pero "${parent.id}" es "${parent.type}"`,
          });
        }
      }
    });

    const relIds = new Set<string>();
    doc.model.relationships.forEach((rel, i) => {
      if (relIds.has(rel.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['model', 'relationships', i, 'id'],
          message: `Id de relación duplicado: "${rel.id}"`,
        });
      }
      relIds.add(rel.id);
      if (!elements.has(rel.sourceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['model', 'relationships', i, 'sourceId'],
          message: `La relación "${rel.id}" tiene un origen inexistente: "${rel.sourceId}"`,
        });
      }
      if (!elements.has(rel.targetId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['model', 'relationships', i, 'targetId'],
          message: `La relación "${rel.id}" tiene un destino inexistente: "${rel.targetId}"`,
        });
      }
      if (rel.sourceId === rel.targetId) {
        ctx.addIssue({
          code: 'custom',
          path: ['model', 'relationships', i, 'targetId'],
          message: `La relación "${rel.id}" no puede unir un elemento consigo mismo`,
        });
      }
    });

    const viewIds = new Set<string>();
    doc.views.forEach((view, i) => {
      if (viewIds.has(view.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['views', i, 'id'],
          message: `Id de vista duplicado: "${view.id}"`,
        });
      }
      viewIds.add(view.id);
      if (view.scopeId !== undefined) {
        const scope = elements.get(view.scopeId);
        const expected = VIEW_SCOPE_TYPE[view.type];
        if (!scope) {
          ctx.addIssue({
            code: 'custom',
            path: ['views', i, 'scopeId'],
            message: `La vista "${view.id}" referencia un alcance inexistente: "${view.scopeId}"`,
          });
        } else if (scope.type !== expected) {
          ctx.addIssue({
            code: 'custom',
            path: ['views', i, 'scopeId'],
            message: `El alcance de una vista "${view.type}" debe ser de tipo "${expected}", pero "${scope.id}" es "${scope.type}"`,
          });
        } else if (view.type === 'systemContext' && !view.elements.some((ve) => ve.id === scope.id)) {
          // En contexto el sistema no es un boundary: es un nodo más y debe estar en la vista.
          ctx.addIssue({
            code: 'custom',
            path: ['views', i, 'elements'],
            message: `La vista "${view.id}" (systemContext) debe incluir su alcance "${scope.id}" entre sus elementos`,
          });
        }
      }
      const seen = new Set<string>();
      view.elements.forEach((ve, j) => {
        if (!elements.has(ve.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['views', i, 'elements', j, 'id'],
            message: `La vista "${view.id}" incluye un elemento inexistente: "${ve.id}"`,
          });
        }
        if (seen.has(ve.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['views', i, 'elements', j, 'id'],
            message: `La vista "${view.id}" incluye "${ve.id}" más de una vez`,
          });
        }
        seen.add(ve.id);
      });
    });
  });

export type DocumentInput = z.input<typeof documentSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  /** `migrated` solo está si el documento venía de una versión anterior y se migró antes de validarlo (ver `C4_MIGRATIONS`). */
  | { ok: true; document: C4Document; migrated?: { from: string; to: string } }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Valida y normaliza un documento (aplica valores por defecto). Si venía de una versión anterior del formato lo migra antes
 * (`C4_MIGRATIONS`); si es de una más nueva, o de una anterior sin migración, lo rechaza diciendo por qué.
 */
export function validateDocument(input: unknown): ValidationResult {
  const migration = migrateValue(c4MigrationSource, input);
  if (migration.status === 'unsupported') return { ok: false, issues: [{ path: 'version', message: migration.message }] };
  const result = documentSchema.safeParse(migration.document);
  if (result.success) {
    return { ok: true, document: result.data as C4Document, ...(migration.status === 'migrated' ? { migrated: { from: migration.from, to: migration.to } } : {}) };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/** Igual que `validateDocument` pero lanza un error con los problemas formateados. */
export function parseDocument(input: unknown): C4Document {
  const result = validateDocument(input);
  if (result.ok) return result.document;
  throw new DocumentValidationError(result.issues);
}

export class DocumentValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Documento C4 inválido:\n${formatIssues(issues)}`);
    this.name = 'DocumentValidationError';
  }
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  - ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n');
}

/** JSON Schema del documento (draft 2020-12), útil para prompts de IA y herramientas externas. */
export function documentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(documentSchema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
}
