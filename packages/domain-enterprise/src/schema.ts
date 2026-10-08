import { parseUrn, refTypeSchema } from '@iark/kernel';
import { z } from 'zod';
import {
  CRITICALITIES,
  ENTERPRISE_DOCUMENT_VERSION,
  IMPORTANCES,
  KIND_LABELS,
  LIFECYCLES,
  MATURITY_MAX,
  MATURITY_MIN,
  RELATION_KINDS,
  RELATION_LABELS,
  RELATION_RULES,
  STRATEGIES,
  TECHNOLOGY_KINDS,
  indexElements,
  type ElementKind,
  type EnterpriseDocument,
} from './types';

const idSchema = z.string().min(1, 'El id no puede estar vacío').max(120);
const nameSchema = z.string().min(1, 'El nombre no puede estar vacío');
const END_OF_LIFE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

export const unitSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  parentId: idSchema.optional(),
  external: z.boolean().optional(),
});

export const capabilitySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  parentId: idSchema.optional(),
  ownerId: idSchema.optional(),
  importance: z.enum(IMPORTANCES).optional(),
  maturity: z.number().int().min(MATURITY_MIN).max(MATURITY_MAX).optional(),
  tags: z.array(z.string()).optional(),
});

export const processSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  ownerId: idSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const applicationSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  technology: z.string().optional(),
  vendor: z.string().optional(),
  ownerId: idSchema.optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  external: z.boolean().optional(),
  annualCost: z.number().min(0, 'El coste anual no puede ser negativo').optional(),
  users: z.number().int('Los usuarios son un número entero').min(0, 'Los usuarios no pueden ser negativos').optional(),
  strategy: z.enum(STRATEGIES).optional(),
  endOfLife: z.string().regex(END_OF_LIFE, 'El fin de soporte debe tener la forma AAAA-MM o AAAA-MM-DD').optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const technologySchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  kind: z.enum(TECHNOLOGY_KINDS).optional(),
  version: z.string().optional(),
  ownerId: idSchema.optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  endOfLife: z.string().regex(END_OF_LIFE, 'El fin de soporte debe tener la forma AAAA-MM o AAAA-MM-DD').optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const valueStreamSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  ownerId: idSchema.optional(),
  stakeholder: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const valueStageSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  streamId: idSchema,
  value: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const businessServiceSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: z.string().optional(),
  ownerId: idSchema.optional(),
  audience: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const relationSchema = z.object({
  id: idSchema,
  kind: z.enum(RELATION_KINDS),
  sourceId: idSchema,
  targetId: idSchema,
  description: z.string().optional(),
});

/** Esquema estructural + reglas de integridad (ids únicos, jerarquías sin ciclos, referencias y tipos de relación). */
export const enterpriseDocumentSchema = z
  .object({
    version: z.literal(ENTERPRISE_DOCUMENT_VERSION).default(ENTERPRISE_DOCUMENT_VERSION),
    workspace: z.object({ name: z.string().default('Arquitectura empresarial'), description: z.string().optional() }).default({ name: 'Arquitectura empresarial' }),
    units: z.array(unitSchema).default([]),
    capabilities: z.array(capabilitySchema).default([]),
    processes: z.array(processSchema).default([]),
    applications: z.array(applicationSchema).default([]),
    technologies: z.array(technologySchema).default([]),
    valueStreams: z.array(valueStreamSchema).default([]),
    valueStages: z.array(valueStageSchema).default([]),
    businessServices: z.array(businessServiceSchema).default([]),
    relations: z.array(relationSchema).default([]),
  })
  .superRefine((input, ctx) => {
    const doc = input as unknown as EnterpriseDocument;
    const issue = (path: Array<string | number>, message: string): void => void ctx.addIssue({ code: 'custom', path, message });

    // Los ids son únicos entre todos los tipos de elemento: las relaciones apuntan a cualquiera de ellos.
    const seen = new Map<string, ElementKind>();
    const collections: Array<[ElementKind, keyof EnterpriseDocument, Array<{ id: string }>]> = [
      ['unit', 'units', doc.units],
      ['capability', 'capabilities', doc.capabilities],
      ['process', 'processes', doc.processes],
      ['application', 'applications', doc.applications],
      ['technology', 'technologies', doc.technologies],
      ['stream', 'valueStreams', doc.valueStreams],
      ['stage', 'valueStages', doc.valueStages],
      ['service', 'businessServices', doc.businessServices],
    ];
    for (const [kind, key, items] of collections) {
      items.forEach((item, i) => {
        const previous = seen.get(item.id);
        if (previous) issue([key, i, 'id'], `Id duplicado: "${item.id}" (ya lo usa ${KIND_LABELS[previous].toLowerCase()})`);
        else seen.set(item.id, kind);
      });
    }
    const elements = indexElements(doc);

    const checkTree = (key: 'units' | 'capabilities', kind: ElementKind, items: Array<{ id: string; parentId?: string }>): void => {
      const parents = new Map(items.map((x) => [x.id, x.parentId]));
      items.forEach((x, i) => {
        if (x.parentId === undefined) return;
        if (x.parentId === x.id) return issue([key, i, 'parentId'], `"${x.id}" no puede ser su propio padre`);
        const parent = elements.get(x.parentId);
        if (!parent) return issue([key, i, 'parentId'], `"${x.id}" referencia un padre inexistente: "${x.parentId}"`);
        if (parent.kind !== kind) return issue([key, i, 'parentId'], `El padre de "${x.id}" debe ser ${KIND_LABELS[kind].toLowerCase()}, pero "${parent.id}" es ${KIND_LABELS[parent.kind].toLowerCase()}`);
        const visited = new Set([x.id]);
        for (let p: string | undefined = x.parentId; p !== undefined; p = parents.get(p)) {
          if (visited.has(p)) return issue([key, i, 'parentId'], `La jerarquía de "${x.id}" es circular`);
          visited.add(p);
        }
      });
    };
    checkTree('units', 'unit', doc.units);
    checkTree('capabilities', 'capability', doc.capabilities);

    const owned: Array<[string, Array<{ id: string; ownerId?: string }>]> = [
      ['capabilities', doc.capabilities],
      ['processes', doc.processes],
      ['applications', doc.applications],
      ['technologies', doc.technologies],
      ['valueStreams', doc.valueStreams],
      ['businessServices', doc.businessServices],
    ];
    for (const [key, items] of owned) {
      items.forEach((x, i) => {
        if (x.ownerId === undefined) return;
        const owner = elements.get(x.ownerId);
        if (!owner) issue([key, i, 'ownerId'], `"${x.id}" referencia una unidad inexistente: "${x.ownerId}"`);
        else if (owner.kind !== 'unit') issue([key, i, 'ownerId'], `El responsable de "${x.id}" debe ser una unidad, pero "${owner.id}" es ${KIND_LABELS[owner.kind].toLowerCase()}`);
      });
    }
    doc.valueStages.forEach((x, i) => {
      const stream = elements.get(x.streamId);
      if (!stream) issue(['valueStages', i, 'streamId'], `La etapa "${x.id}" referencia un flujo de valor inexistente: "${x.streamId}"`);
      else if (stream.kind !== 'stream') issue(['valueStages', i, 'streamId'], `El flujo de la etapa "${x.id}" debe ser un flujo de valor, pero "${stream.id}" es ${KIND_LABELS[stream.kind].toLowerCase()}`);
    });
    for (const [key, items] of [['applications', doc.applications], ['technologies', doc.technologies]] as const) {
      items.forEach((x, i) => {
        if (x.ref !== undefined && !parseUrn(x.ref)) issue([key, i, 'ref'], `La referencia de "${x.id}" no es una URN válida (urn:iark:<módulo>:<id>): "${x.ref}"`);
      });
    }

    const relationIds = new Set<string>();
    const signatures = new Set<string>();
    doc.relations.forEach((r, i) => {
      if (relationIds.has(r.id)) issue(['relations', i, 'id'], `Id de relación duplicado: "${r.id}"`);
      relationIds.add(r.id);
      const source = elements.get(r.sourceId);
      const target = elements.get(r.targetId);
      if (!source) issue(['relations', i, 'sourceId'], `La relación "${r.id}" referencia un elemento inexistente: "${r.sourceId}"`);
      if (!target) issue(['relations', i, 'targetId'], `La relación "${r.id}" referencia un elemento inexistente: "${r.targetId}"`);
      if (!source || !target) return;
      if (r.sourceId === r.targetId) return issue(['relations', i, 'targetId'], `La relación "${r.id}" no puede unir un elemento consigo mismo`);
      if (!RELATION_RULES[r.kind].some(([from, to]) => from === source.kind && to === target.kind)) {
        const allowed = RELATION_RULES[r.kind].map(([from, to]) => `${KIND_LABELS[from].toLowerCase()} → ${KIND_LABELS[to].toLowerCase()}`).join(' o ');
        issue(['relations', i, 'kind'], `La relación "${r.id}" (${RELATION_LABELS[r.kind]}) no puede unir ${KIND_LABELS[source.kind].toLowerCase()} → ${KIND_LABELS[target.kind].toLowerCase()}: solo admite ${allowed}`);
      }
      const signature = `${r.kind}|${r.sourceId}|${r.targetId}`;
      if (signatures.has(signature)) issue(['relations', i, 'targetId'], `La relación "${r.id}" repite otra igual (${RELATION_LABELS[r.kind]} "${r.sourceId}" → "${r.targetId}")`);
      signatures.add(signature);
    });
  });

export type EnterpriseValidation = { ok: true; document: EnterpriseDocument } | { ok: false; issues: Array<{ path: string; message: string }> };

export function validateEnterpriseDocument(input: unknown): EnterpriseValidation {
  const result = enterpriseDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data as EnterpriseDocument };
  return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) };
}

export function formatEnterpriseIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n');
}

export function enterpriseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(enterpriseDocumentSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
