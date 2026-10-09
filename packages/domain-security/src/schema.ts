import { parseUrn, refTypeSchema } from '@iark/kernel';
import { z } from 'zod';
import {
  ASSET_KINDS,
  AUTHENTICATIONS,
  CLASSIFICATIONS,
  CONTROL_KINDS,
  CONTROL_STANDARDS,
  CONTROL_STATUSES,
  ELEMENT_LABELS,
  IMPACTS,
  LIKELIHOODS,
  SECURITY_DOCUMENT_VERSION,
  STRIDE,
  THREAT_STATUSES,
  TRUST_LEVELS,
  indexElements,
  type ElementKind,
  type SecurityDocument,
} from './types';

const idSchema = z.string().min(1, 'El id no puede estar vacío').max(120);
const nameSchema = z.string().min(1, 'El nombre no puede estar vacío');

export const zoneSchema = z.object({
  id: idSchema,
  name: nameSchema,
  trust: z.enum(TRUST_LEVELS).optional(),
  parentId: idSchema.optional(),
  description: z.string().optional(),
});

export const assetSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(ASSET_KINDS),
  zoneId: idSchema,
  description: z.string().optional(),
  technology: z.string().optional(),
  owner: z.string().optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  encryptedAtRest: z.boolean().optional(),
  authentication: z.enum(AUTHENTICATIONS).optional(),
  rotation: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const flowSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  description: z.string().optional(),
  protocol: z.string().optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  encrypted: z.boolean().optional(),
  authentication: z.enum(AUTHENTICATIONS).optional(),
});

export const threatSchema = z.object({
  id: idSchema,
  title: nameSchema,
  category: z.enum(STRIDE),
  targetId: idSchema,
  likelihood: z.enum(LIKELIHOODS).optional(),
  impact: z.enum(IMPACTS).optional(),
  status: z.enum(THREAT_STATUSES).optional(),
  description: z.string().optional(),
  controlIds: z.array(idSchema).optional(),
  suggested: z.boolean().optional(),
});

export const controlSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(CONTROL_KINDS),
  status: z.enum(CONTROL_STATUSES).optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
  standard: z.enum(CONTROL_STANDARDS).optional(),
});

/** Esquema estructural + reglas de integridad (ids únicos, zonas sin ciclos, flujos entre activos, amenazas sobre activos o flujos, controles existentes). */
export const securityDocumentSchema = z
  .object({
    version: z.literal(SECURITY_DOCUMENT_VERSION).default(SECURITY_DOCUMENT_VERSION),
    workspace: z.object({ name: z.string().default('Arquitectura de seguridad'), description: z.string().optional() }).default({ name: 'Arquitectura de seguridad' }),
    zones: z.array(zoneSchema).default([]),
    assets: z.array(assetSchema).default([]),
    flows: z.array(flowSchema).default([]),
    threats: z.array(threatSchema).default([]),
    controls: z.array(controlSchema).default([]),
  })
  .superRefine((input, ctx) => {
    const doc = input as unknown as SecurityDocument;
    const issue = (path: Array<string | number>, message: string): void => void ctx.addIssue({ code: 'custom', path, message });
    const kindName = (k: ElementKind): string => ELEMENT_LABELS[k].toLowerCase();

    // Los ids son únicos entre zonas, activos, flujos, amenazas y controles: las amenazas apuntan a activos o flujos.
    const seen = new Map<string, ElementKind>();
    const collections: Array<[ElementKind, keyof SecurityDocument, Array<{ id: string }>]> = [
      ['zone', 'zones', doc.zones],
      ['asset', 'assets', doc.assets],
      ['flow', 'flows', doc.flows],
      ['threat', 'threats', doc.threats],
      ['control', 'controls', doc.controls],
    ];
    for (const [kind, key, items] of collections) {
      items.forEach((item, i) => {
        const previous = seen.get(item.id);
        if (previous) issue([key, i, 'id'], `Id duplicado: "${item.id}" (ya lo usa ${kindName(previous)})`);
        else seen.set(item.id, kind);
      });
    }
    const elements = indexElements(doc);
    const zones = new Map(doc.zones.map((z) => [z.id, z]));
    const controls = new Map(doc.controls.map((c) => [c.id, c]));

    doc.zones.forEach((z, i) => {
      if (z.parentId === undefined) return;
      if (z.parentId === z.id) return issue(['zones', i, 'parentId'], `"${z.id}" no puede ser su propio padre`);
      if (!zones.has(z.parentId)) {
        const other = elements.get(z.parentId);
        return issue(['zones', i, 'parentId'], other ? `El padre de "${z.id}" debe ser una zona, pero "${other.id}" es ${kindName(other.kind)}` : `"${z.id}" referencia un padre inexistente: "${z.parentId}"`);
      }
      const visited = new Set([z.id]);
      for (let p: string | undefined = z.parentId; p !== undefined; p = zones.get(p)?.parentId) {
        if (visited.has(p)) return issue(['zones', i, 'parentId'], `La jerarquía de zonas de "${z.id}" es circular`);
        visited.add(p);
      }
    });

    doc.assets.forEach((a, i) => {
      if (!zones.has(a.zoneId)) {
        const other = elements.get(a.zoneId);
        issue(['assets', i, 'zoneId'], other ? `La zona de "${a.id}" debe ser una zona, pero "${other.id}" es ${kindName(other.kind)}` : `"${a.id}" referencia una zona inexistente: "${a.zoneId}"`);
      }
      if (a.ref !== undefined && !parseUrn(a.ref)) issue(['assets', i, 'ref'], `La referencia de "${a.id}" no es una URN válida (urn:iark:<módulo>:<id>): "${a.ref}"`);
      if (a.encryptedAtRest !== undefined && a.kind !== 'datastore' && a.kind !== 'secret') issue(['assets', i, 'encryptedAtRest'], `"${a.id}" no es un almacén de datos ni un secreto: el cifrado en reposo solo se declara en los almacenes y los secretos`);
      if (a.authentication !== undefined && a.kind !== 'identity' && a.kind !== 'channel') issue(['assets', i, 'authentication'], `"${a.id}" no es una identidad ni un canal: la autenticación del activo solo se declara en ellos`);
      if (a.rotation !== undefined && a.kind !== 'secret') issue(['assets', i, 'rotation'], `"${a.id}" no es un secreto: la rotación solo se declara en los secretos`);
      if (a.encrypted !== undefined && a.kind !== 'channel') issue(['assets', i, 'encrypted'], `"${a.id}" no es un canal de confianza: el cifrado del canal solo se declara en los canales`);
    });

    const signatures = new Set<string>();
    doc.flows.forEach((f, i) => {
      const [source, target] = [elements.get(f.sourceId), elements.get(f.targetId)];
      for (const [field, id, e] of [['sourceId', f.sourceId, source], ['targetId', f.targetId, target]] as const) {
        if (!e) issue(['flows', i, field], `El flujo "${f.id}" referencia un activo inexistente: "${id}"`);
        else if (e.kind !== 'asset') issue(['flows', i, field], `Un flujo une activos, pero "${e.id}" es ${kindName(e.kind)}`);
      }
      if (!source || !target || source.kind !== 'asset' || target.kind !== 'asset') return;
      if (f.sourceId === f.targetId) return issue(['flows', i, 'targetId'], `El flujo "${f.id}" no puede unir un activo consigo mismo`);
      const signature = `${f.sourceId}|${f.targetId}|${f.protocol ?? ''}|${f.description ?? ''}`;
      if (signatures.has(signature)) issue(['flows', i, 'targetId'], `El flujo "${f.id}" repite otro igual ("${f.sourceId}" → "${f.targetId}")`);
      signatures.add(signature);
    });

    doc.threats.forEach((t, i) => {
      const target = elements.get(t.targetId);
      if (!target) issue(['threats', i, 'targetId'], `La amenaza "${t.id}" apunta a un elemento inexistente: "${t.targetId}"`);
      else if (target.kind !== 'asset' && target.kind !== 'flow') issue(['threats', i, 'targetId'], `Una amenaza recae sobre un activo o un flujo, pero "${target.id}" es ${kindName(target.kind)}`);
      const listed = new Set<string>();
      (t.controlIds ?? []).forEach((id, j) => {
        if (!controls.has(id)) {
          const other = elements.get(id);
          issue(['threats', i, 'controlIds', j], other ? `La amenaza "${t.id}" la mitiga un control, pero "${other.id}" es ${kindName(other.kind)}` : `La amenaza "${t.id}" referencia un control inexistente: "${id}"`);
        } else if (listed.has(id)) issue(['threats', i, 'controlIds', j], `La amenaza "${t.id}" repite el control "${id}"`);
        listed.add(id);
      });
    });
  });

export type SecurityValidation = { ok: true; document: SecurityDocument } | { ok: false; issues: Array<{ path: string; message: string }> };

export function validateSecurityDocument(input: unknown): SecurityValidation {
  const result = securityDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data as SecurityDocument };
  return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) };
}

export function formatSecurityIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n');
}

export function securityJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(securityDocumentSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
