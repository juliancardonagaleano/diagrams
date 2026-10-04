import type { ModuleIssue } from '@iark/kernel';
import { catalogIssues } from './catalog';
import { contractEngine } from './contract';
import { checkType, keyTypeAdvice, listEngines, resolveEngine, suggestTypes, unkeyableType } from './engines';
import { inheritance } from './inherit';
import { findLineageCycles, indexLineage } from './lineage';
import { CLASSIFICATION_LABELS, CLASSIFICATION_RANK, ENTITY_KINDS, KIND_LABELS, hasPii, isCatalogKind, type Column, type ColumnRef, type DataAsset, type DataDocument, type Pipeline } from './types';

const CONFIDENTIAL = CLASSIFICATION_RANK.confidential;

/** Sensibilidad de un activo: su clasificación o, si tiene datos personales y no la declara, confidencial como mínimo. */
export function sensitivity(asset: DataAsset): number | undefined {
  if (asset.classification) return CLASSIFICATION_RANK[asset.classification];
  return hasPii(asset) ? CONFIDENTIAL : undefined;
}

type AssetLabel = (a: DataAsset) => string;

/**
 * Linaje de columnas de un pipeline: un mapeo a (o desde) una columna que el activo no declara y datos personales que
 * llegan a una columna no marcada como tal (salvo que el pipeline anonimice). Los informes y modelos sin columnas
 * declaradas aceptan cualquier nombre, porque describen indicadores y no tablas.
 */
function mappingIssues(p: Pipeline, assets: Map<string, DataAsset>, label: AssetLabel): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const column = (r: ColumnRef): { asset?: DataAsset; column?: Column; missing: boolean } => {
    const asset = assets.get(r.assetId);
    const found = asset?.columns?.find((c) => c.name === r.column);
    const free = !!asset && !found && (asset.columns?.length ?? 0) === 0 && !ENTITY_KINDS.includes(asset.kind);
    return { asset, column: found, missing: !!asset && !found && !free };
  };
  const reported = new Set<string>();
  for (const m of p.mappings ?? []) {
    const from = column(m.from);
    const to = column(m.to);
    for (const [ref, c] of [[m.from, from], [m.to, to]] as const) {
      const key = `${ref.assetId}.${ref.column}`;
      if (!c.missing || reported.has(key)) continue;
      reported.add(key);
      issues.push({ severity: 'warning', elementId: p.id, message: `El pipeline «${p.name}» mapea la columna «${ref.column}», que ${label(c.asset!)} no declara.` });
    }
    if (!p.anonymizes && from.column?.pii && to.asset && to.column && !to.column.pii) {
      issues.push({
        severity: 'warning',
        elementId: to.asset.id,
        message: `La columna «${to.column.name}» de ${label(to.asset)} recibe datos personales de «${m.from.column}» (${label(from.asset!)}) por el pipeline «${p.name}» pero no está marcada como PII. Si anonimiza los datos, márcalo con anonymizes.`,
      });
    }
  }
  return issues;
}

/**
 * Motor de base de datos: uno que no está en el registro, columnas con un tipo que el motor no tiene (con el equivalente que sí) y un
 * contrato que declara otro servidor que el del activo. Solo se evalúa lo que declara un motor (`engine`), así que un documento
 * sin motores no recibe ningún aviso nuevo.
 */
function engineIssues(doc: DataDocument, contracts: Map<string, { name: string; content?: string }>, engineOf: (id: string) => string | undefined, label: AssetLabel): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  for (const a of doc.assets) {
    if (a.engine && !resolveEngine(a.engine)) {
      issues.push({ severity: 'warning', elementId: a.id, message: `El motor «${a.engine}» de ${label(a)} no está en el registro (${listEngines().map((e) => e.id).join(', ')}): no se validan los tipos de sus columnas ni se genera su DDL.` });
    }
    const engine = resolveEngine(engineOf(a.id));
    if (!engine) continue;
    for (const c of a.columns ?? []) {
      if (!c.type) continue;
      const result = checkType(engine, c.type);
      if (result.ok) continue;
      const alternatives = suggestTypes(engine, c.type);
      issues.push({
        severity: engine.lenient ? 'info' : 'warning',
        elementId: a.id,
        message: `La columna «${c.name}» de ${label(a)} declara el tipo «${c.type}», que no existe en ${engine.label}${alternatives.length ? `. ¿Quisiste decir ${alternatives.map((t) => `«${t}»`).join(', ')}?` : '.'}`,
      });
    }
    // Una clave primaria (o única) de un tipo que el motor no admite como clave (`text` en MySQL, `clob` en Oracle): el CREATE TABLE que se genera falla.
    for (const c of a.kind === 'table' ? a.columns ?? [] : []) {
      // Una columna `pk` y `uk` a la vez es solo clave primaria: el DDL no repite el UNIQUE.
      const kind = c.keys?.includes('pk') ? 'pk' : c.keys?.includes('uk') ? 'uk' : undefined;
      const type = kind ? unkeyableType(engine, c.type, kind) : undefined;
      if (type) issues.push({ severity: 'warning', elementId: a.id, message: `La columna «${c.name}» de ${label(a)} es clave ${kind === 'pk' ? 'primaria' : 'única'} de tipo «${type}», que ${engine.label} no admite como clave: su CREATE TABLE falla. ${keyTypeAdvice(engine, type)}` });
    }
    const contract = a.contractId ? contracts.get(a.contractId) : undefined;
    const declared = contract?.content ? contractEngine(contract.content) : undefined;
    if (contract && declared && declared.id !== engine.id) {
      issues.push({ severity: 'warning', elementId: a.id, message: `El contrato «${contract.name}» declara el servidor ${declared.label} pero ${label(a)} está en ${engine.label}.` });
    }
  }
  return issues;
}

/**
 * Reglas de gobierno y calidad del modelo de datos (avisos que no invalidan el documento pero conviene corregir):
 * datos personales sin clasificar o clasificados a la baja a lo largo del linaje, activos sin responsable, sin origen o
 * sin uso, pipelines sin frecuencia, ciclos de linaje y relaciones N:M sin tabla intermedia.
 */
export function analyzeData(doc: DataDocument): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const label = (a: DataAsset): string => `${KIND_LABELS[a.kind]} «${a.name}»`;
  const { producers, consumers } = indexLineage(doc);
  const inRelation = new Set(doc.relations.flatMap((r) => [r.sourceId, r.targetId]));
  const children = new Map<string, DataAsset[]>();
  for (const a of doc.assets) if (a.parentId) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);

  const { ownerOf, domainOf, engineOf } = inheritance(doc);
  const contracts = new Map((doc.contracts ?? []).map((c) => [c.id, c]));
  // Un dato derivado se produce dentro de la plataforma: informes, modelos y lo que vive en un almacén o un lago.
  const isDerived = (a: DataAsset): boolean =>
    a.kind === 'report' || a.kind === 'model' || (['table', 'view', 'file'].includes(a.kind) && ['warehouse', 'lake'].includes(assets.get(a.parentId ?? '')?.kind ?? ''));
  const participates = (a: DataAsset): boolean => producers.has(a.id) || consumers.has(a.id) || inRelation.has(a.id) || (children.get(a.id) ?? []).some(participates);

  for (const a of doc.assets) {
    const pii = hasPii(a);
    const rank = sensitivity(a);
    if (pii && !a.classification) {
      issues.push({ severity: 'warning', elementId: a.id, message: `${label(a)} contiene datos personales pero no tiene clasificación.` });
    } else if (pii && a.classification && CLASSIFICATION_RANK[a.classification] < CONFIDENTIAL) {
      issues.push({ severity: 'warning', elementId: a.id, message: `${label(a)} contiene datos personales pero está clasificado como ${CLASSIFICATION_LABELS[a.classification]}: como mínimo debería ser confidencial.` });
    }
    if (pii && !a.retention) issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} contiene datos personales y no declara política de retención.` });

    if (!a.external && !ownerOf(a.id) && !isCatalogKind(a.kind)) {
      issues.push({
        severity: pii || (rank ?? 0) >= CONFIDENTIAL ? 'warning' : 'info',
        elementId: a.id,
        message: `${label(a)} no tiene responsable (owner).`,
      });
    }

    if (isDerived(a) && !producers.has(a.id)) issues.push({ severity: 'warning', elementId: a.id, message: `${label(a)} no tiene origen: ningún pipeline lo escribe.` });
    if (!participates(a) && a.kind !== 'source' && !isCatalogKind(a.kind)) {
      issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} no participa en ningún pipeline ni relación.` });
    }
    if (doc.domains.length > 0 && !a.parentId && !domainOf(a.id)) {
      issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} no pertenece a ningún dominio.` });
    }
    if (a.kind === 'table' && (a.columns?.length ?? 0) > 0 && !a.columns!.some((c) => c.keys?.includes('pk'))) {
      issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} no declara clave primaria.` });
    }
  }

  issues.push(...engineIssues(doc, contracts, engineOf, label));

  for (const d of doc.domains) {
    if (!doc.assets.some((a) => a.domainId === d.id)) issues.push({ severity: 'info', elementId: d.id, message: `El dominio «${d.name}» no tiene activos.` });
  }

  for (const p of doc.pipelines) {
    if (!p.schedule && ['batch', 'elt', 'replication', 'api'].includes(p.kind)) {
      issues.push({ severity: 'info', elementId: p.id, message: `El pipeline «${p.name}» no declara su frecuencia (schedule).` });
    }
    issues.push(...mappingIssues(p, assets, label));
    if (p.anonymizes) continue;
    for (const inId of p.inputs) {
      const input = assets.get(inId);
      const inRank = input ? sensitivity(input) : undefined;
      if (!input || inRank === undefined) continue;
      for (const outId of p.outputs) {
        const output = assets.get(outId);
        if (!output) continue;
        const outRank = sensitivity(output);
        const why = input.classification ? `clasificado como ${CLASSIFICATION_LABELS[input.classification]}` : 'con datos personales';
        if (output.classification === undefined && !hasPii(output)) {
          issues.push({ severity: 'warning', elementId: outId, message: `${label(output)} deriva de ${label(input)} (${why}) por el pipeline «${p.name}» pero no tiene clasificación.` });
        } else if (outRank !== undefined && outRank < inRank) {
          issues.push({
            severity: 'warning',
            elementId: outId,
            message: `${label(output)} se clasifica como ${CLASSIFICATION_LABELS[output.classification ?? 'confidential']} pero deriva de ${label(input)} (${why}) por el pipeline «${p.name}». Si anonimiza los datos, márcalo con anonymizes.`,
          });
        }
        if (hasPii(input) && !hasPii(output)) {
          issues.push({ severity: 'info', elementId: outId, message: `${label(output)} deriva de ${label(input)}, que tiene datos personales, y no está marcado como tal.` });
        }
      }
    }
  }

  for (const cycle of findLineageCycles(doc)) {
    issues.push({ severity: 'warning', elementId: cycle[0], message: `Linaje circular: ${cycle.map((id) => assets.get(id)?.name ?? id).join(' → ')}.` });
  }

  for (const r of doc.relations) {
    const s = assets.get(r.sourceId);
    const t = assets.get(r.targetId);
    if (r.cardinality === 'N:M' && s?.kind === 'table' && t?.kind === 'table') {
      issues.push({ severity: 'info', elementId: r.id, message: `La relación N:M entre «${s.name}» y «${t.name}» normalmente se resuelve con una tabla intermedia.` });
    }
  }

  issues.push(...catalogIssues(doc, sensitivity));
  return issues;
}
