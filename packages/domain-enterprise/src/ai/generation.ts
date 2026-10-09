import type { AiSpec } from '@iark/kernel';
import { z } from 'zod';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import { CRITICALITIES, ENTERPRISE_DOCUMENT_VERSION, IMPORTANCES, LIFECYCLES, RELATION_KINDS, STRATEGIES, TECHNOLOGY_KINDS, type EnterpriseDocument } from '../types';

// Lo que produce el modelo: todos los campos presentes (null si no aplican), como exige la salida estructurada.
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const generatedUnit = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  parentId: nullable(z.string()),
  external: nullable(z.boolean()),
});

const generatedCapability = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  parentId: nullable(z.string()),
  ownerId: nullable(z.string()),
  importance: nullable(z.enum(IMPORTANCES)),
  maturity: nullable(z.number()),
});

const generatedProcess = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  ownerId: nullable(z.string()),
});

const generatedApplication = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  technology: nullable(z.string()),
  vendor: nullable(z.string()),
  ownerId: nullable(z.string()),
  lifecycle: nullable(z.enum(LIFECYCLES)),
  criticality: nullable(z.enum(CRITICALITIES)),
  external: nullable(z.boolean()),
  annualCost: nullable(z.number()),
  users: nullable(z.number()),
  strategy: nullable(z.enum(STRATEGIES)),
  endOfLife: nullable(z.string()),
});

const generatedTechnology = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  kind: nullable(z.enum(TECHNOLOGY_KINDS)),
  version: nullable(z.string()),
  ownerId: nullable(z.string()),
  lifecycle: nullable(z.enum(LIFECYCLES)),
  endOfLife: nullable(z.string()),
});

const generatedStream = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  ownerId: nullable(z.string()),
  stakeholder: nullable(z.string()),
});

const generatedStage = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  streamId: z.string(),
  value: nullable(z.string()),
});

const generatedService = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  ownerId: nullable(z.string()),
  audience: nullable(z.string()),
});

const generatedRelation = z.object({
  id: z.string(),
  kind: z.enum(RELATION_KINDS),
  sourceId: z.string(),
  targetId: z.string(),
  description: nullable(z.string()),
});

export const generatedEnterpriseSchema = z.object({
  workspace: z.object({ name: z.string(), description: nullable(z.string()) }),
  units: z.array(generatedUnit),
  capabilities: z.array(generatedCapability),
  processes: z.array(generatedProcess),
  applications: z.array(generatedApplication),
  technologies: z.array(generatedTechnology),
  // Flujos de valor y servicios de negocio: opcionales (un modelo que no los produce sigue siendo válido).
  valueStreams: z.array(generatedStream).default([]),
  valueStages: z.array(generatedStage).default([]),
  businessServices: z.array(generatedService).default([]),
  relations: z.array(generatedRelation),
});

export type GeneratedEnterprise = z.infer<typeof generatedEnterpriseSchema>;

/** Quita los `null` que exige la salida estructurada: el documento usa campos ausentes. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

export function generatedToEnterprise(generated: GeneratedEnterprise): { ok: true; document: EnterpriseDocument } | { ok: false; issues: string } {
  const result = validateEnterpriseDocument({ version: ENTERPRISE_DOCUMENT_VERSION, ...dropNulls(generated) });
  return result.ok ? result : { ok: false, issues: formatEnterpriseIssues(result.issues) };
}

export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedEnterpriseSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export function systemPrompt(): string {
  return `Eres un arquitecto empresarial experto en TOGAF y ArchiMate: mapas de capacidades, portafolio de aplicaciones y tecnología.
Tu tarea es convertir una descripción en lenguaje natural en un modelo de arquitectura empresarial estructurado en JSON.
NO produces coordenadas: el diagramador coloca los elementos después. Concéntrate en el modelo.

Elementos (todos con id único en kebab-case ASCII, compartido entre tipos):
- "units": unidades de la organización (direcciones, áreas, equipos) que actúan de responsables. parentId = unidad que la contiene.
  external = true para terceros. Los responsables (ownerId) son SIEMPRE ids de unidades, nunca texto libre.
- "capabilities": capacidades de negocio, lo que la empresa sabe hacer (Gestión de pedidos, Atención al cliente), no
  cómo. Forman un árbol con parentId (el mapa de capacidades): 3 a 8 de primer nivel, con subcapacidades solo si aportan.
  importance: "differentiating" (da ventaja competitiva), "core" (imprescindible) o "supporting" (de apoyo/commodity).
  maturity: entero de 1 (inicial) a 5 (optimizada), solo si la descripción lo permite deducir.
- "processes": procesos de negocio concretos (Alta de pedido, Cierre mensual).
- "applications": aplicaciones y sistemas. technology = producto o pila ("SAP S/4HANA", "Java + PostgreSQL"), vendor si es de
  un tercero, external = true para SaaS/terceros. lifecycle: "planned", "active" (por defecto), "sunset" (en retirada) o
  "retired". criticality: "low", "medium", "high" o "critical". ownerId = unidad responsable de negocio.
  Datos de gestión, solo si la descripción los da: annualCost (coste anual, número), users (número de usuarios, entero),
  strategy ("keep" conservar, "migrate" migrar, "replace" reemplazar o "retire" retirar) y endOfLife ("AAAA-MM" o "AAAA-MM-DD").
- "technologies": plataformas y tecnología sobre la que corren las aplicaciones (Kubernetes, AWS, PostgreSQL 16).
  kind: "platform", "infrastructure", "database", "runtime", "middleware" o "service". version si se conoce.
  lifecycle igual que en aplicaciones; endOfLife ("AAAA-MM" o "AAAA-MM-DD") solo si la descripción da la fecha de fin de soporte.
- "valueStreams": flujos de valor de principio a fin vistos por quien recibe el valor (Del pedido a la entrega); stakeholder =
  quien lo recibe. Sus etapas son "valueStages" (streamId = id del flujo), en el ORDEN en que ocurren; value = lo que aporta
  la etapa. Solo si la descripción habla de un flujo, una cadena de valor o etapas; si no, déjalos vacíos.
- "businessServices": servicios de negocio que la empresa ofrece a sus clientes (Envío a domicilio); audience = a quién.
  Expone procesos y capacidades con la relación "exposes". Solo si la descripción los menciona; si no, vacío.

Relaciones ("relations"), con estas reglas de origen → destino (sourceId → targetId):
- "supports": aplicación → capacidad, o aplicación → proceso. La aplicación soporta a la capacidad o al proceso.
- "realizes": proceso → capacidad. El proceso realiza la capacidad.
- "runs-on": aplicación → tecnología en la que se ejecuta.
- "depends-on": aplicación → otra aplicación de la que depende, o tecnología → otra tecnología. Un elemento nunca se relaciona consigo mismo.
- "composes": el todo → su parte (aplicación → módulo, proceso → subproceso, tecnología → componente), del mismo tipo.
- "flows-to": flujo de información o de trabajo de una aplicación a otra, o de un proceso a otro.
- "assigned-to": unidad → proceso que ejecuta (sourceId es la unidad).
- "triggers": proceso → proceso al que pone en marcha.
- "enables": capacidad → etapa de un flujo de valor que habilita (sourceId es la capacidad).
- "exposes": servicio de negocio → proceso o capacidad que expone a sus clientes (sourceId es el servicio).
Toda capacidad hoja debería estar soportada por al menos una aplicación (directamente o por un proceso que la realiza), y
toda aplicación debería soportar algo y tener responsable.

Responde en el idioma de la instrucción del usuario (nombres, descripciones). Sé concreto y no inventes elementos que la
descripción no justifique.`;
}

export function toGenerated(doc: EnterpriseDocument): GeneratedEnterprise {
  const n = <T,>(v: T | undefined): T | null => v ?? null;
  return {
    workspace: { name: doc.workspace.name, description: n(doc.workspace.description) },
    units: doc.units.map((u) => ({ id: u.id, name: u.name, description: n(u.description), parentId: n(u.parentId), external: n(u.external) })),
    capabilities: doc.capabilities.map((c) => ({ id: c.id, name: c.name, description: n(c.description), parentId: n(c.parentId), ownerId: n(c.ownerId), importance: n(c.importance), maturity: n(c.maturity) })),
    processes: doc.processes.map((p) => ({ id: p.id, name: p.name, description: n(p.description), ownerId: n(p.ownerId) })),
    applications: doc.applications.map((a) => ({
      id: a.id,
      name: a.name,
      description: n(a.description),
      technology: n(a.technology),
      vendor: n(a.vendor),
      ownerId: n(a.ownerId),
      lifecycle: n(a.lifecycle),
      criticality: n(a.criticality),
      external: n(a.external),
      annualCost: n(a.annualCost),
      users: n(a.users),
      strategy: n(a.strategy),
      endOfLife: n(a.endOfLife),
    })),
    technologies: doc.technologies.map((t) => ({
      id: t.id,
      name: t.name,
      description: n(t.description),
      kind: n(t.kind),
      version: n(t.version),
      ownerId: n(t.ownerId),
      lifecycle: n(t.lifecycle),
      endOfLife: n(t.endOfLife),
    })),
    valueStreams: doc.valueStreams.map((v) => ({ id: v.id, name: v.name, description: n(v.description), ownerId: n(v.ownerId), stakeholder: n(v.stakeholder) })),
    valueStages: doc.valueStages.map((v) => ({ id: v.id, name: v.name, description: n(v.description), streamId: v.streamId, value: n(v.value) })),
    businessServices: doc.businessServices.map((b) => ({ id: b.id, name: b.name, description: n(b.description), ownerId: n(b.ownerId), audience: n(b.audience) })),
    relations: doc.relations.map((r) => ({ id: r.id, kind: r.kind, sourceId: r.sourceId, targetId: r.targetId, description: n(r.description) })),
  };
}

export const enterpriseAiSpec: AiSpec<EnterpriseDocument> = {
  generationSchema: generatedEnterpriseSchema,
  generationJsonSchema,
  system: systemPrompt,
  user(instruction, base) {
    if (!base) return `Genera el modelo de arquitectura empresarial para la siguiente descripción:\n\n${instruction}`;
    return (
      `Este es el modelo de arquitectura empresarial actual en JSON:\n\n${JSON.stringify(toGenerated(base), null, 2)}\n\n` +
      `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. Conserva los ids ` +
      `existentes de lo que no cambia y solo añade, modifica o elimina lo que la instrucción requiera:\n\n${instruction}`
    );
  },
  retry: (issues) => `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`,
  toDocument: (generated) => generatedToEnterprise(generated as GeneratedEnterprise),
  // Para `iark explain` y `iark review`: la proyección compacta del documento y qué destacar y qué mirar en este módulo.
  serialize: toGenerated,
  explainGuide:
    'Narra por capas, de negocio a tecnología: las capacidades de la empresa (y cuáles son diferenciadoras o de apoyo), los procesos que las realizan, las aplicaciones que los soportan y la tecnología sobre la que corren; menciona el ciclo de vida (planificada, activa, en retirada) y la criticidad de las aplicaciones y quién es responsable de cada pieza.',
  reviewGuide:
    'Mira: capacidades hoja sin ninguna aplicación que las soporte; aplicaciones que no soportan nada o sin responsable; varias aplicaciones para la misma capacidad (solapamiento); tecnología en retirada o con fin de soporte vencido bajo aplicaciones críticas; aplicaciones críticas sin estrategia de evolución; procesos sin responsable; capacidades diferenciadoras con poca madurez; flujos de valor con etapas sin capacidad que las habilite.',
};
