import type { AiSpec } from '@iark/kernel';
import { z } from 'zod';
import { formatSecurityIssues, validateSecurityDocument } from '../schema';
import {
  ASSET_KINDS,
  AUTHENTICATIONS,
  CLASSIFICATIONS,
  CONTROL_KINDS,
  CONTROL_STATUSES,
  IMPACTS,
  LIKELIHOODS,
  SECURITY_DOCUMENT_VERSION,
  STRIDE,
  THREAT_STATUSES,
  TRUST_LEVELS,
  type SecurityDocument,
} from '../types';

// Lo que produce el modelo: todos los campos presentes (null si no aplican), como exige la salida estructurada.
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const generatedZone = z.object({
  id: z.string(),
  name: z.string(),
  trust: nullable(z.enum(TRUST_LEVELS)),
  parentId: nullable(z.string()),
  description: nullable(z.string()),
});

const generatedAsset = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ASSET_KINDS),
  zoneId: z.string(),
  description: nullable(z.string()),
  technology: nullable(z.string()),
  owner: nullable(z.string()),
  classification: nullable(z.enum(CLASSIFICATIONS)),
  encryptedAtRest: nullable(z.boolean()),
  authentication: nullable(z.enum(AUTHENTICATIONS)),
  rotation: nullable(z.boolean()),
  encrypted: nullable(z.boolean()),
});

const generatedFlow = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  description: nullable(z.string()),
  protocol: nullable(z.string()),
  classification: nullable(z.enum(CLASSIFICATIONS)),
  encrypted: nullable(z.boolean()),
  authentication: nullable(z.enum(AUTHENTICATIONS)),
});

const generatedThreat = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(STRIDE),
  targetId: z.string(),
  likelihood: nullable(z.enum(LIKELIHOODS)),
  impact: nullable(z.enum(IMPACTS)),
  status: nullable(z.enum(THREAT_STATUSES)),
  description: nullable(z.string()),
  controlIds: nullable(z.array(z.string())),
});

const generatedControl = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(CONTROL_KINDS),
  status: nullable(z.enum(CONTROL_STATUSES)),
  description: nullable(z.string()),
  owner: nullable(z.string()),
});

export const generatedSecuritySchema = z.object({
  workspace: z.object({ name: z.string(), description: nullable(z.string()) }),
  zones: z.array(generatedZone),
  assets: z.array(generatedAsset),
  flows: z.array(generatedFlow),
  threats: z.array(generatedThreat),
  controls: z.array(generatedControl),
});

export type GeneratedSecurity = z.infer<typeof generatedSecuritySchema>;

/** Quita los `null` que exige la salida estructurada: el documento usa campos ausentes. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

export function generatedToSecurity(generated: GeneratedSecurity): { ok: true; document: SecurityDocument } | { ok: false; issues: string } {
  const result = validateSecurityDocument({ version: SECURITY_DOCUMENT_VERSION, ...dropNulls(generated) });
  return result.ok ? result : { ok: false, issues: formatSecurityIssues(result.issues) };
}

export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedSecuritySchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export function systemPrompt(): string {
  return `Eres un arquitecto de seguridad experto en modelado de amenazas (STRIDE sobre diagramas de flujo de datos), zonas de confianza y controles.
Tu tarea es convertir una descripción en lenguaje natural en un modelo de arquitectura de seguridad estructurado en JSON.
NO produces coordenadas: el diagramador coloca los elementos después. Concéntrate en el modelo.

Zonas ("zones"): fronteras de confianza. trust: "untrusted" (Internet, redes de terceros), "dmz" (perímetro expuesto), "internal"
(por defecto) o "restricted" (datos y secretos críticos). "parentId" es la zona que contiene a esta (una zona
restringida dentro de la red interna). Todo activo pertenece a una zona.

Activos ("assets"), cada uno en una zona ("zoneId"):
- "actor" (persona o usuario), "external" (sistema de un tercero), "process" (componente que ejecuta código: API, servicio, worker,
  balanceador, broker), "datastore" (base de datos, caché, almacenamiento, cola persistente), "identity" (proveedor de identidad:
  IdP, directorio, SSO), "secret" (secreto, clave o certificado concreto, no el almacén que lo guarda) y "channel" (canal de confianza
  entre zonas: VPN, túnel, mTLS; se pone en una zona y los flujos que lo atraviesan pasan por él).
- classification (public, internal, confidential, restricted) = la clasificación más alta de los datos que trata o guarda.
- encryptedAtRest solo en almacenes de datos y secretos: true si están cifrados en reposo, false si no; null si no se sabe.
- authentication ("none", "password", "token", "mtls" o "sso") solo en identidades y canales; rotation (true si se rota periódicamente)
  solo en secretos; encrypted solo en canales (true si cifran el tráfico). null en el resto o si no se sabe.
- technology y owner solo si se mencionan.

Flujos de datos ("flows"): sourceId envía datos a targetId (activos distintos). protocol (HTTPS, gRPC, AMQP, SQL…), description (qué
datos viajan), classification, encrypted (true/false; null si no se sabe) y authentication ("none", "password", "token", "mtls"
o "sso"; null si no se sabe). Un flujo que cruza de una zona menos confiable a otra más confiable debe autenticarse y cifrarse.

Amenazas ("threats"): categoría STRIDE (spoofing, tampering, repudiation, information-disclosure, denial-of-service,
elevation-of-privilege) sobre un activo o un flujo ("targetId"). Aplica STRIDE por elemento: actores y sistemas externos solo
suplantación y repudio; almacenes de datos y secretos manipulación, repudio, divulgación y denegación de servicio; flujos
manipulación, divulgación y denegación de servicio; canales suplantación, manipulación y divulgación; los procesos y las
identidades, las seis. likelihood (low, medium, high), impact (low, medium, high,
critical) y status (open por defecto, mitigated, accepted). Cada amenaza cita en "controlIds" los controles que la mitigan.
Prioriza los flujos que cruzan fronteras y los activos con datos confidenciales o restringidos; no inventes amenazas genéricas.

Controles ("controls"): kind (authentication, authorization, encryption, logging, validation, network, rate-limit, backup,
secrets, other) y status ("implemented" por defecto o "planned"). Una amenaza solo es "mitigated" si tiene al menos un control
implementado.

Ids únicos en kebab-case ASCII entre zonas, activos, flujos, amenazas y controles. Responde en el idioma de la instrucción del
usuario (nombres, descripciones). Sé concreto y no inventes elementos que la descripción no justifique.`;
}

export function toGenerated(doc: SecurityDocument): GeneratedSecurity {
  const n = <T,>(v: T | undefined): T | null => v ?? null;
  return {
    workspace: { name: doc.workspace.name, description: n(doc.workspace.description) },
    zones: doc.zones.map((z) => ({ id: z.id, name: z.name, trust: n(z.trust), parentId: n(z.parentId), description: n(z.description) })),
    assets: doc.assets.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      zoneId: a.zoneId,
      description: n(a.description),
      technology: n(a.technology),
      owner: n(a.owner),
      classification: n(a.classification),
      encryptedAtRest: n(a.encryptedAtRest),
      authentication: n(a.authentication),
      rotation: n(a.rotation),
      encrypted: n(a.encrypted),
    })),
    flows: doc.flows.map((f) => ({
      id: f.id,
      sourceId: f.sourceId,
      targetId: f.targetId,
      description: n(f.description),
      protocol: n(f.protocol),
      classification: n(f.classification),
      encrypted: n(f.encrypted),
      authentication: n(f.authentication),
    })),
    threats: doc.threats.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      targetId: t.targetId,
      likelihood: n(t.likelihood),
      impact: n(t.impact),
      status: n(t.status),
      description: n(t.description),
      controlIds: n(t.controlIds),
    })),
    controls: doc.controls.map((c) => ({ id: c.id, name: c.name, kind: c.kind, status: n(c.status), description: n(c.description), owner: n(c.owner) })),
  };
}

export const securityAiSpec: AiSpec<SecurityDocument> = {
  generationSchema: generatedSecuritySchema,
  generationJsonSchema,
  system: systemPrompt,
  user(instruction, base) {
    if (!base) return `Genera el modelo de arquitectura de seguridad para la siguiente descripción:\n\n${instruction}`;
    return (
      `Este es el modelo de seguridad actual en JSON:\n\n${JSON.stringify(toGenerated(base), null, 2)}\n\n` +
      `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. Conserva los ids ` +
      `existentes de lo que no cambia y solo añade, modifica o elimina lo que la instrucción requiera:\n\n${instruction}`
    );
  },
  retry: (issues) => `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`,
  toDocument: (generated) => generatedToSecurity(generated as GeneratedSecurity),
  // Para `iark explain` y `iark review`: la proyección compacta del documento y qué destacar y qué mirar en este módulo.
  serialize: toGenerated,
  explainGuide:
    'Describe las zonas de confianza y las fronteras entre ellas, qué activos hay en cada una y cuáles son sensibles, los flujos de datos que cruzan fronteras (con su protocolo, cifrado y autenticación), las amenazas identificadas con su categoría STRIDE y los controles que las mitigan, y qué riesgo queda abierto.',
  reviewGuide:
    'Mira: flujos que cruzan de una zona menos confiable a otra más confiable sin autenticación o sin cifrado; activos confidenciales o restringidos sin cifrado en reposo o sin ningún control asociado; amenazas abiertas sin control, o marcadas como mitigadas sin un control implementado; categorías STRIDE sin cubrir en los activos expuestos; amenazas sin probabilidad ni impacto; controles planificados que nadie ha implementado o que no mitigan ninguna amenaza; secretos sin rotación; falta de registro y auditoría; zonas con más privilegio del necesario.',
};
