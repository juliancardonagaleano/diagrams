// Módulo de terceros de ejemplo para IArk - DIAgrams: un registro de riesgos (`risk`).
//
// Es un paquete mínimo y completo: esquema, reglas de validación, un exportador a Markdown, un importador de CSV, un comando
// propio (`iark risk top`) y `entities` para que sus riesgos entren en la trazabilidad. SOLO importa de la API pública
// (`@iark/kernel` y `zod`, declarados como peerDependencies en el package.json): nada del repositorio de IArk.
//
// Se escribe en JavaScript con JSDoc para cargarse tal cual, sin compilar; en TypeScript es igual y se compila a ESM antes de
// publicarlo. Guía paso a paso: docs/plugins.md.
import { CONTRACT_VERSION, defineModule, ModuleError, parseUrn } from '@iark/kernel';
import { z } from 'zod';

const STATUSES = /** @type {const} */ (['open', 'mitigating', 'accepted', 'closed']);
const STATUS_LABELS = { open: 'abierto', mitigating: 'en mitigación', accepted: 'aceptado', closed: 'cerrado' };

const riskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Probabilidad e impacto, de 1 (muy baja) a 5 (muy alta). */
  probability: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  status: z.enum(STATUSES).default('open'),
  owner: z.string().optional(),
  mitigation: z.string().optional(),
  /** Elemento de otro módulo al que afecta (`urn:iark:<módulo>:<id>`): es lo que enlaza el riesgo en la trazabilidad. */
  ref: z.string().optional(),
});

const riskDocumentSchema = z.object({
  version: z.literal('1.0').default('1.0'),
  // Como los demás módulos: el nombre del documento va en `workspace.name` (lo usan `iark import`, los proyectos y la comparación).
  workspace: z.object({ name: z.string().default('Registro de riesgos') }).default({ name: 'Registro de riesgos' }),
  risks: z.array(riskSchema).default([]),
});

/** @typedef {z.infer<typeof riskDocumentSchema>} RiskDocument */
/** @typedef {RiskDocument['risks'][number]} Risk */

/** Puntuación de un riesgo (1 a 25) y su nivel. */
const score = (/** @type {Risk} */ risk) => risk.probability * risk.impact;
const level = (/** @type {number} */ points) => (points >= 15 ? 'alto' : points >= 8 ? 'medio' : 'bajo');

/** @param {RiskDocument} document @returns {import('@iark/kernel').ModuleIssue[]} */
function validate(document) {
  /** @type {import('@iark/kernel').ModuleIssue[]} */
  const issues = [];
  const seen = new Set();
  for (const risk of document.risks) {
    if (seen.has(risk.id)) issues.push({ severity: 'error', message: `El riesgo «${risk.id}» está repetido.`, elementId: risk.id });
    seen.add(risk.id);
    if (risk.ref !== undefined && !parseUrn(risk.ref)) {
      issues.push({ severity: 'error', message: `«${risk.ref}» no es una URN válida (urn:iark:<módulo>:<id>).`, elementId: risk.id });
    }
    const active = risk.status === 'open' || risk.status === 'mitigating';
    if (active && level(score(risk)) === 'alto' && !risk.mitigation) {
      issues.push({ severity: 'warning', message: `El riesgo alto «${risk.title}» (${score(risk)} puntos) no tiene mitigación.`, elementId: risk.id });
    }
    if (active && !risk.owner) issues.push({ severity: 'warning', message: `El riesgo «${risk.title}» no tiene responsable.`, elementId: risk.id });
  }
  return issues;
}

/** @param {RiskDocument} document */
const byScore = (document) => [...document.risks].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));

/** Exportador a Markdown: la tabla de riesgos de mayor a menor puntuación. */
const markdownExporter = {
  id: 'md',
  label: 'Markdown',
  extension: '.md',
  mime: 'text/markdown',
  /** @param {RiskDocument} document */
  export(document) {
    const rows = byScore(document).map(
      (r) => `| ${r.id} | ${r.title} | ${r.probability} | ${r.impact} | ${score(r)} (${level(score(r))}) | ${STATUS_LABELS[r.status]} | ${r.owner ?? '-'} |`,
    );
    return [`# ${document.workspace.name}`, '', '| Id | Riesgo | P | I | Puntos | Estado | Responsable |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n');
  },
};

/** Una línea de CSV con comillas dobles opcionales (`"a, b"`, `""` para una comilla). */
function csvCells(/** @type {string} */ line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') (current += '"'), (i += 1);
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') (cells.push(current), (current = ''));
    else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** Importador de CSV: `id,title,probability,impact,status,owner,mitigation,ref`; las filas que no valen se avisan y se saltan. */
const csvImporter = {
  id: 'csv',
  label: 'CSV',
  extensions: ['.csv'],
  detect: (/** @type {string} */ text) => /^id,title,/i.test(text.trimStart()),
  /** @param {string} text @param {import('@iark/kernel').ImportContext} context */
  import(text, context) {
    const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (!header) throw new ModuleError('El CSV está vacío: la primera línea debe ser id,title,probability,impact,status,owner,mitigation,ref.');
    const columns = csvCells(header).map((name) => name.toLowerCase());
    /** @type {string[]} */
    const warnings = [];
    /** @type {unknown[]} */
    const risks = [];
    lines.forEach((line, index) => {
      const cells = csvCells(line);
      const row = Object.fromEntries(columns.map((name, i) => [name, cells[i] === '' ? undefined : cells[i]]));
      const parsed = riskSchema.safeParse({ ...row, probability: Number(row.probability), impact: Number(row.impact) });
      if (parsed.success) risks.push(parsed.data);
      else warnings.push(`Fila ${index + 2} omitida: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    });
    const document = riskDocumentSchema.parse({ workspace: { name: context.name ?? context.fallbackName }, risks });
    return { document, warnings };
  },
};

/** `iark risk top [archivo] -n 3`: los riesgos activos con más puntos. No toca el disco (lo lee el CLI): también vale por la API. */
const topCommand = {
  name: 'top',
  description: 'Lista los riesgos activos con más puntos',
  input: { description: 'Documento de riesgos (JSON)' },
  options: [{ flags: '-n, --limit <n>', description: 'cuántos riesgos mostrar', default: '5' }],
  /** @param {import('@iark/kernel').CommandContext} context */
  run(context) {
    let json;
    try {
      json = JSON.parse(context.input ?? '');
    } catch (error) {
      throw new ModuleError(`La entrada no es JSON válido: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = riskDocumentSchema.safeParse(json);
    if (!parsed.success) throw new ModuleError(`Documento de riesgos inválido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const limit = Math.max(1, Number.parseInt(String(context.options.limit ?? '5'), 10) || 5);
    const active = byScore(parsed.data).filter((r) => r.status === 'open' || r.status === 'mitigating');
    return [`# Riesgos activos con más puntos (${Math.min(limit, active.length)} de ${active.length})`, '', ...active.slice(0, limit).map((r) => `- ${r.id}: ${r.title} (${score(r)}, ${level(score(r))})`)].join('\n');
  },
};

export default defineModule({
  id: 'risk',
  name: 'Registro de riesgos',
  version: '1.0.0',
  description: 'Riesgos con probabilidad e impacto, responsable y mitigación; exporta a Markdown e importa CSV. Módulo de terceros de ejemplo.',
  contractVersion: CONTRACT_VERSION,
  documentVersion: '1.0',
  schema: riskDocumentSchema,
  jsonSchema: () => z.toJSONSchema(riskDocumentSchema, { target: 'draft-2020-12', io: 'input' }),
  validate,
  importers: [csvImporter],
  exporters: [markdownExporter],
  // Cada riesgo es referenciable por URN (`urn:iark:risk:<id>`), y su `ref` lo enlaza con un elemento de otro módulo.
  entities: (document) => document.risks.map((r) => ({ id: r.id, name: r.title, kind: 'risk' })),
  cliCommands: [topCommand],
});
