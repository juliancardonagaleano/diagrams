import { parseUrn, refTypeSchema } from '@iark/kernel';
import { z } from 'zod';
import {
  CONTRACT_FORMATS,
  CRITICALITIES,
  INTEGRATION_DOCUMENT_VERSION,
  INTERACTION_STYLES,
  NODE_KINDS,
  PARENT_KINDS,
  PATTERNS,
  type IntegrationDocument,
} from './types';

const idSchema = z.string().min(1, 'El id no puede estar vacío').max(120);

export const nodeSchema = z.object({
  id: idSchema,
  kind: z.enum(NODE_KINDS),
  name: z.string().min(1, 'El nombre no puede estar vacío'),
  description: z.string().optional(),
  technology: z.string().optional(),
  owner: z.string().optional(),
  external: z.boolean().optional(),
  parentId: idSchema.optional(),
  ref: z.string().optional(),
  refType: refTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  contractId: idSchema.optional(),
  pattern: z.enum(PATTERNS).optional(),
  domain: z.string().optional(),
});

export const contractSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  format: z.enum(CONTRACT_FORMATS),
  version: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
});

export const interactionSchema = z.object({
  id: idSchema,
  sourceId: idSchema,
  targetId: idSchema,
  style: z.enum(INTERACTION_STYLES),
  protocol: z.string().optional(),
  pattern: z.enum(PATTERNS).optional(),
  contractId: idSchema.optional(),
  description: z.string().optional(),
  dataObjects: z.array(z.string()).optional(),
  criticality: z.enum(CRITICALITIES).optional(),
  order: z.number().optional(),
});

export const flowSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(z.object({ interactionId: idSchema, note: z.string().optional() })).default([]),
});

/** Esquema estructural + reglas semánticas de integridad (referencias y jerarquía). */
export const integrationDocumentSchema = z
  .object({
    version: z.literal(INTEGRATION_DOCUMENT_VERSION).default(INTEGRATION_DOCUMENT_VERSION),
    workspace: z.object({ name: z.string().default('Mapa de integración'), description: z.string().optional() }).default({ name: 'Mapa de integración' }),
    nodes: z.array(nodeSchema).default([]),
    contracts: z.array(contractSchema).default([]),
    interactions: z.array(interactionSchema).default([]),
    flows: z.array(flowSchema).default([]),
  })
  .superRefine((doc, ctx) => {
    const issue = (path: Array<string | number>, message: string): void => void ctx.addIssue({ code: 'custom', path, message });

    const contracts = new Set<string>();
    doc.contracts.forEach((c, i) => {
      if (contracts.has(c.id)) issue(['contracts', i, 'id'], `Id de contrato duplicado: "${c.id}"`);
      contracts.add(c.id);
    });

    const nodes = new Map<string, (typeof doc.nodes)[number]>();
    doc.nodes.forEach((n, i) => {
      if (nodes.has(n.id)) issue(['nodes', i, 'id'], `Id de nodo duplicado: "${n.id}"`);
      nodes.set(n.id, n);
    });
    doc.nodes.forEach((n, i) => {
      if (n.parentId !== undefined) {
        const parent = nodes.get(n.parentId);
        const expected = PARENT_KINDS[n.kind];
        if (!parent) issue(['nodes', i, 'parentId'], `El nodo "${n.id}" referencia un padre inexistente: "${n.parentId}"`);
        else if (!expected) issue(['nodes', i, 'parentId'], `Un nodo de tipo "${n.kind}" no puede tener padre`);
        else if (!expected.includes(parent.kind)) issue(['nodes', i, 'parentId'], `El padre de "${n.id}" (${n.kind}) debe ser de tipo ${expected.map((k) => `"${k}"`).join(' o ')}, pero "${parent.id}" es "${parent.kind}"`);
      }
      if (n.ref !== undefined && !parseUrn(n.ref)) issue(['nodes', i, 'ref'], `La referencia de "${n.id}" no es una URN válida (urn:iark:<módulo>:<id>): "${n.ref}"`);
      if (n.contractId !== undefined && !contracts.has(n.contractId)) issue(['nodes', i, 'contractId'], `El nodo "${n.id}" referencia un contrato inexistente: "${n.contractId}"`);
      if (n.kind === 'pattern' && n.pattern === undefined) issue(['nodes', i, 'pattern'], `El nodo "${n.id}" es de tipo "pattern": indica qué patrón aplica`);
      if (n.kind !== 'pattern' && n.pattern !== undefined) issue(['nodes', i, 'pattern'], `Solo un nodo de tipo "pattern" lleva patrón; "${n.id}" es "${n.kind}" (para marcar una interacción usa su propio campo "pattern")`);
    });

    const interactions = new Set<string>();
    doc.interactions.forEach((it, i) => {
      if (interactions.has(it.id)) issue(['interactions', i, 'id'], `Id de interacción duplicado: "${it.id}"`);
      interactions.add(it.id);
      if (!nodes.has(it.sourceId)) issue(['interactions', i, 'sourceId'], `La interacción "${it.id}" tiene un origen inexistente: "${it.sourceId}"`);
      if (!nodes.has(it.targetId)) issue(['interactions', i, 'targetId'], `La interacción "${it.id}" tiene un destino inexistente: "${it.targetId}"`);
      if (it.sourceId === it.targetId) issue(['interactions', i, 'targetId'], `La interacción "${it.id}" no puede unir un nodo consigo mismo`);
      if (it.contractId !== undefined && !contracts.has(it.contractId)) issue(['interactions', i, 'contractId'], `La interacción "${it.id}" referencia un contrato inexistente: "${it.contractId}"`);
    });

    const flows = new Set<string>();
    doc.flows.forEach((f, i) => {
      if (flows.has(f.id)) issue(['flows', i, 'id'], `Id de flujo duplicado: "${f.id}"`);
      flows.add(f.id);
      f.steps.forEach((s, j) => {
        if (!interactions.has(s.interactionId)) issue(['flows', i, 'steps', j, 'interactionId'], `El flujo "${f.id}" referencia una interacción inexistente: "${s.interactionId}"`);
      });
    });
  });

export type IntegrationValidation = { ok: true; document: IntegrationDocument } | { ok: false; issues: Array<{ path: string; message: string }> };

export function validateIntegrationDocument(input: unknown): IntegrationValidation {
  const result = integrationDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, document: result.data as IntegrationDocument };
  return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) };
}

export function formatIntegrationIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.map((i) => `- ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n');
}

export function integrationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(integrationDocumentSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
