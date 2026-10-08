import { parseUrn, refTypeSchema } from '@iark/kernel';
import { z } from 'zod';
import { exposeViolation, glossaryViolation, portViolation, termLinkViolation } from './links';
import {
  API_PROTOCOLS,
  ASSET_KINDS,
  CARDINALITIES,
  CLASSIFICATIONS,
  COLUMN_KEYS,
  CONTRACT_FORMATS,
  DATA_DOCUMENT_VERSION,
  ENTITY_KINDS,
  KIND_LABELS,
  PARENT_KINDS,
  PARTICIPATIONS,
  PIPELINE_KINDS,
  TERM_STATUSES,
  type DataDocument,
} from './types';
import { BUILTIN_ENGINE_IDS } from './engines';

const idSchema = z.string().min(1, 'El id no puede estar vacío').max(120);

export const columnSchema = z.object({
  name: z.string().min(1, 'El nombre de la columna no puede estar vacío'),
  type: z.string().optional(),
  keys: z.array(z.enum(COLUMN_KEYS)).optional(),
  nullable: z.boolean().optional(),
  pii: z.boolean().optional(),
  description: z.string().optional(),
});

export const domainSchema = z.object({
  id: idSchema,
  name: z.string().min(1, 'El nombre no puede estar vacío'),
  description: z.string().optional(),
  owner: z.string().optional(),
});

export const assetSchema = z.object({
  id: idSchema,
  kind: z.enum(ASSET_KINDS),
  name: z.string().min(1, 'El nombre no puede estar vacío'),
  description: z.string().optional(),
  technology: z.string().optional(),
  engine: z
    .string()
    .optional()
    .describe(`Motor de base de datos (${BUILTIN_ENGINE_IDS.join(', ')}; el registro de motores es extensible). Lo heredan las tablas, vistas y archivos del activo.`),
  owner: z.string().optional(),
  steward: z.string().optional(),
  domainId: idSchema.optional(),
  parentId: idSchema.optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  pii: z.boolean().optional(),
  retention: z.string().optional(),
  external: z.boolean().optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  columns: z.array(columnSchema).optional(),
  contractId: idSchema.optional(),
  inputPorts: z.array(idSchema).optional(),
  outputPorts: z.array(idSchema).optional(),
  exposes: z.array(idSchema).optional(),
  freshness: z.string().optional(),
  sla: z.string().optional(),
  protocol: z.enum(API_PROTOCOLS).optional(),
  endpoint: z.string().optional(),
});

export const termLinkSchema = z.object({
  assetId: idSchema,
  column: z.string().min(1, 'El nombre de la columna no puede estar vacío').optional(),
});

export const termSchema = z.object({
  id: idSchema,
  name: z.string().min(1, 'El nombre del término no puede estar vacío'),
  definition: z.string().optional(),
  owner: z.string().optional(),
  status: z.enum(TERM_STATUSES).optional(),
  glossaryId: idSchema.optional(),
  synonyms: z.array(z.string()).optional(),
  links: z.array(termLinkSchema).optional(),
});

export const columnRefSchema = z.object({
  assetId: idSchema,
  column: z.string().min(1, 'El nombre de la columna no puede estar vacío'),
});

export const mappingSchema = z.object({
  from: columnRefSchema,
  to: columnRefSchema,
  transform: z.string().optional(),
});

export const pipelineSchema = z.object({
  id: idSchema,
  name: z.string().min(1, 'El nombre no puede estar vacío'),
  kind: z.enum(PIPELINE_KINDS),
  inputs: z.array(idSchema).min(1, 'Un pipeline necesita al menos una entrada'),
  outputs: z.array(idSchema).min(1, 'Un pipeline necesita al menos una salida'),
  tool: z.string().optional(),
  schedule: z.string().optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
  anonymizes: z.boolean().optional(),
  mappings: z.array(mappingSchema).optional(),
});

export const participationSchema = z.literal([...PARTICIPATIONS]);

export const relationSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  cardinality: z.enum(CARDINALITIES),
  description: z.string().optional(),
  sourceMin: participationSchema.optional().describe('Mínimo del origen: 0 = opcional, 1 = obligatorio (por defecto, 1 si la cardinalidad dice «uno» y 0 si dice «varios»).'),
  targetMin: participationSchema.optional().describe('Mínimo del destino: 0 = opcional, 1 = obligatorio (mismos valores por defecto que sourceMin).'),
});

export const contractSchema = z.object({
  id: idSchema,
  name: z.string().min(1, 'El nombre del contrato no puede estar vacío'),
  format: z.enum(CONTRACT_FORMATS),
  version: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
});

/** Esquema estructural + reglas de integridad (referencias, jerarquía y relaciones entre entidades). */
export const dataDocumentSchema = z
  .object({
    version: z.literal(DATA_DOCUMENT_VERSION).default(DATA_DOCUMENT_VERSION),
    workspace: z.object({ name: z.string().default('Arquitectura de datos'), description: z.string().optional() }).default({ name: 'Arquitectura de datos' }),
    domains: z.array(domainSchema).default([]),
    assets: z.array(assetSchema).default([]),
    pipelines: z.array(pipelineSchema).default([]),
    relations: z.array(relationSchema).default([]),
    contracts: z.array(contractSchema).optional(),
    terms: z.array(termSchema).optional(),
  })
  .superRefine((doc, ctx) => {
    const issue = (path: Array<string | number>, message: string): void => void ctx.addIssue({ code: 'custom', path, message });

    const domains = new Set<string>();
    doc.domains.forEach((d, i) => {
      if (domains.has(d.id)) issue(['domains', i, 'id'], `Id de dominio duplicado: "${d.id}"`);
      domains.add(d.id);
    });

    const assets = new Map<string, (typeof doc.assets)[number]>();
    doc.assets.forEach((a, i) => {
      if (assets.has(a.id)) issue(['assets', i, 'id'], `Id de activo duplicado: "${a.id}"`);
      assets.set(a.id, a);
    });
    doc.assets.forEach((a, i) => {
      if (a.domainId !== undefined && !domains.has(a.domainId)) issue(['assets', i, 'domainId'], `El activo "${a.id}" referencia un dominio inexistente: "${a.domainId}"`);
      if (a.parentId !== undefined) {
        const parent = assets.get(a.parentId);
        const allowed = PARENT_KINDS[a.kind];
        if (!parent) issue(['assets', i, 'parentId'], `El activo "${a.id}" referencia un padre inexistente: "${a.parentId}"`);
        else if (!allowed) issue(['assets', i, 'parentId'], `Un activo de tipo "${a.kind}" no puede tener padre`);
        else if (!allowed.includes(parent.kind)) {
          issue(['assets', i, 'parentId'], `El padre de "${a.id}" (${a.kind}) debe ser de tipo ${allowed.map((k) => `"${k}"`).join(', ')}, pero "${parent.id}" es "${parent.kind}"`);
        }
      }
      if (a.ref !== undefined && !parseUrn(a.ref)) issue(['assets', i, 'ref'], `La referencia de "${a.id}" no es una URN válida (urn:iark:<módulo>:<id>): "${a.ref}"`);
      const names = new Set<string>();
      (a.columns ?? []).forEach((c, j) => {
        if (names.has(c.name)) issue(['assets', i, 'columns', j, 'name'], `Columna duplicada en "${a.id}": "${c.name}"`);
        names.add(c.name);
      });
    });

    const contracts = new Set<string>();
    (doc.contracts ?? []).forEach((c, i) => {
      if (contracts.has(c.id)) issue(['contracts', i, 'id'], `Id de contrato duplicado: "${c.id}"`);
      contracts.add(c.id);
    });
    doc.assets.forEach((a, i) => {
      if (a.contractId !== undefined && !contracts.has(a.contractId)) issue(['assets', i, 'contractId'], `El activo "${a.id}" referencia un contrato inexistente: "${a.contractId}"`);
    });

    // Catálogo: puertos de los productos, activos que sirven las APIs y términos del glosario.
    const ports = (a: (typeof doc.assets)[number], i: number, field: 'inputPorts' | 'outputPorts' | 'exposes', rule: (owner: typeof a, asset: typeof a) => string | undefined): void => {
      const seen = new Set<string>();
      (a[field] ?? []).forEach((id, j) => {
        const target = assets.get(id);
        if (!target) issue(['assets', i, field, j], `El activo "${a.id}" referencia un activo inexistente en ${field}: "${id}"`);
        else if (rule(a, target)) issue(['assets', i, field, j], rule(a, target)!);
        if (seen.has(id)) issue(['assets', i, field, j], `El activo "${a.id}" repite "${id}" en ${field}`);
        seen.add(id);
      });
    };
    doc.assets.forEach((a, i) => {
      for (const field of ['inputPorts', 'outputPorts'] as const) if (a[field] !== undefined && a.kind !== 'data-product') issue(['assets', i, field], `Solo un producto de datos tiene ${field}, pero "${a.id}" es de tipo "${a.kind}"`);
      if (a.exposes !== undefined && a.kind !== 'data-api') issue(['assets', i, 'exposes'], `Solo una API de datos tiene exposes, pero "${a.id}" es de tipo "${a.kind}"`);
      if (a.kind === 'data-product') {
        ports(a, i, 'inputPorts', portViolation);
        ports(a, i, 'outputPorts', portViolation);
        (a.outputPorts ?? []).forEach((id, j) => {
          if ((a.inputPorts ?? []).includes(id)) issue(['assets', i, 'outputPorts', j], `El producto "${a.id}" no puede consumir y publicar el mismo activo: "${id}"`);
        });
      } else if (a.kind === 'data-api') ports(a, i, 'exposes', exposeViolation);
    });

    const terms = new Map<string, NonNullable<typeof doc.terms>[number]>();
    (doc.terms ?? []).forEach((t, i) => {
      if (terms.has(t.id)) issue(['terms', i, 'id'], `Id de término duplicado: "${t.id}"`);
      terms.set(t.id, t);
      if (assets.has(t.id)) issue(['terms', i, 'id'], `El término "${t.id}" repite el id de un activo`);
      if (t.glossaryId !== undefined) {
        const glossary = assets.get(t.glossaryId);
        if (!glossary) issue(['terms', i, 'glossaryId'], `El término "${t.id}" referencia un glosario inexistente: "${t.glossaryId}"`);
        else if (glossaryViolation(glossary)) issue(['terms', i, 'glossaryId'], glossaryViolation(glossary)!);
      }
      const linked = new Set<string>();
      (t.links ?? []).forEach((l, j) => {
        const asset = assets.get(l.assetId);
        if (!asset) issue(['terms', i, 'links', j, 'assetId'], `El término "${t.id}" enlaza un activo inexistente: "${l.assetId}"`);
        else if (termLinkViolation(asset)) issue(['terms', i, 'links', j, 'assetId'], termLinkViolation(asset)!);
        const key = `${l.assetId}#${l.column ?? ''}`;
        if (linked.has(key)) issue(['terms', i, 'links', j], `El término "${t.id}" enlaza dos veces "${l.assetId}${l.column ? `.${l.column}` : ''}"`);
        linked.add(key);
      });
    });

    const pipelines = new Set<string>();
    doc.pipelines.forEach((p, i) => {
      if (pipelines.has(p.id)) issue(['pipelines', i, 'id'], `Id de pipeline duplicado: "${p.id}"`);
      pipelines.add(p.id);
      p.inputs.forEach((id, j) => {
        if (!assets.has(id)) issue(['pipelines', i, 'inputs', j], `El pipeline "${p.id}" lee un activo inexistente: "${id}"`);
      });
      p.outputs.forEach((id, j) => {
        if (!assets.has(id)) issue(['pipelines', i, 'outputs', j], `El pipeline "${p.id}" escribe un activo inexistente: "${id}"`);
        else if (p.inputs.includes(id)) issue(['pipelines', i, 'outputs', j], `El pipeline "${p.id}" no puede leer y escribir el mismo activo: "${id}"`);
      });
      (p.mappings ?? []).forEach((m, j) => {
        if (!p.inputs.includes(m.from.assetId)) issue(['pipelines', i, 'mappings', j, 'from', 'assetId'], `El mapeo del pipeline "${p.id}" parte de "${m.from.assetId}", que no es una de sus entradas`);
        if (!p.outputs.includes(m.to.assetId)) issue(['pipelines', i, 'mappings', j, 'to', 'assetId'], `El mapeo del pipeline "${p.id}" llega a "${m.to.assetId}", que no es una de sus salidas`);
      });
    });

    const relations = new Set<string>();
    doc.relations.forEach((r, i) => {
      if (relations.has(r.id)) issue(['relations', i, 'id'], `Id de relación duplicado: "${r.id}"`);
      relations.add(r.id);
      if (r.sourceId === r.targetId) issue(['relations', i, 'targetId'], `La relación "${r.id}" no puede unir un activo consigo mismo`);
      for (const [field, id] of [['sourceId', r.sourceId], ['targetId', r.targetId]] as const) {
        const asset = assets.get(id);
        if (!asset) issue(['relations', i, field], `La relación "${r.id}" referencia un activo inexistente: "${id}"`);
        else if (!ENTITY_KINDS.includes(asset.kind)) {
          issue(['relations', i, field], `La relación "${r.id}" une "${id}" (${KIND_LABELS[asset.kind].toLowerCase()}): solo se relacionan ${ENTITY_KINDS.map((k) => KIND_LABELS[k].toLowerCase()).join(', ')}`);
        }
      }
    });
  });

export type DataValidation = { ok: true; document: DataDocument } | { ok: false; issues: Array<{ path: string; message: string }> };

export function validateDataDocument(input: unknown): DataValidation {
  const result = dataDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data as DataDocument };
  return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) };
}

export function formatDataIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n');
}

export function dataJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(dataDocumentSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
