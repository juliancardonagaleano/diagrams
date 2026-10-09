import { uniqueId, type EditorAction } from '@iark/kernel';
import { CATALOG_ACTIONS } from './catalog-actions';
import { pipelineNodeId } from './export/render';
import { sensitivity } from './issues';
import { traceLineage } from './lineage';
import { CLASSIFICATIONS, CLASSIFICATION_RANK, ENTITY_KINDS, hasPii, type Classification, type DataAsset, type DataDocument, type Pipeline } from './types';

/** `flow:<pipeline>:in|out:<activo>`: la arista que une un activo con un pipeline en el lienzo. */
const FLOW_EDGE = /^flow:(.+):(in|out):(.+)$/;

const NOT_AN_ASSET = 'Selecciona uno o varios activos de datos.';

/** Activos de la selección (se ignoran pipelines y relaciones). */
function selectedAssets(doc: DataDocument, ids: string[]): DataAsset[] {
  const byId = new Map(doc.assets.map((a) => [a.id, a]));
  return [...new Set(ids)].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

const allIds = (doc: DataDocument): string[] => [...doc.assets.map((a) => a.id), ...doc.pipelines.map((p) => p.id), ...doc.domains.map((d) => d.id), ...(doc.contracts ?? []).map((c) => c.id), ...(doc.terms ?? []).map((t) => t.id)];

// ───────────── Agrupar en dominio ─────────────

const GROUP_DOMAIN: EditorAction<DataDocument> = {
  id: 'group-domain',
  label: 'Agrupar en dominio…',
  hint: 'Asigna los activos seleccionados a un dominio de datos (lo crea si no existe)',
  needs: 'many',
  prompt: {
    label: 'Nombre del dominio',
    placeholder: 'Ventas',
    initial: (doc, ids) => {
      const counts = new Map<string, number>();
      for (const a of selectedAssets(doc, ids)) {
        const name = doc.domains.find((d) => d.id === a.domainId)?.name;
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
    },
    suggestions: (doc) => doc.domains.map((d) => d.name),
  },
  disabled: (doc, ids) => (selectedAssets(doc, ids).length === 0 ? NOT_AN_ASSET : undefined),
  run(doc, ids, input) {
    const name = (input ?? '').trim();
    if (!name) return { ok: false, reason: 'Indica el nombre del dominio.' };
    const assets = selectedAssets(doc, ids);
    if (assets.length === 0) return { ok: false, reason: NOT_AN_ASSET };
    const known = doc.domains.find((d) => d.name.toLowerCase() === name.toLowerCase() || d.id === name);
    const domain = known ?? { id: uniqueId(name, allIds(doc)), name };
    const chosen = new Set(assets.map((a) => a.id));
    return {
      ok: true,
      id: assets[0].id,
      document: { ...doc, domains: known ? doc.domains : [...doc.domains, domain], assets: doc.assets.map((a) => (chosen.has(a.id) ? { ...a, domainId: domain.id } : a)) },
    };
  },
};

// ───────────── Propagar clasificación aguas abajo ─────────────

interface Spread {
  rank: number;
  pii: boolean;
}

/** Qué activos aguas abajo de la selección heredarían una clasificación mayor o los datos personales (sin atravesar los pipelines que anonimizan). */
function spreadFrom(doc: DataDocument, ids: string[]): Map<string, Spread> {
  const byId = new Map(doc.assets.map((a) => [a.id, a]));
  const wanted = new Map<string, Spread>();
  for (const start of selectedAssets(doc, ids)) {
    const rank = sensitivity(start);
    if (rank === undefined) continue;
    const pii = hasPii(start);
    for (const step of traceLineage(doc, start.id, 'downstream', { stopAtAnonymizing: true }).downstream) {
      const target = byId.get(step.assetId);
      if (!target) continue;
      const current = target.classification ? CLASSIFICATION_RANK[target.classification] : -1;
      const next = wanted.get(target.id) ?? { rank: current, pii: hasPii(target) };
      wanted.set(target.id, { rank: Math.max(next.rank, rank), pii: next.pii || pii });
    }
  }
  const changed = new Map<string, Spread>();
  for (const [id, want] of wanted) {
    const target = byId.get(id)!;
    const current = target.classification ? CLASSIFICATION_RANK[target.classification] : -1;
    if (want.rank > current || (want.pii && !hasPii(target))) changed.set(id, want);
  }
  return changed;
}

const PROPAGATE: EditorAction<DataDocument> = {
  id: 'propagate-classification',
  label: 'Propagar clasificación',
  hint: 'Lleva la clasificación y los datos personales de los activos seleccionados a todo lo que se alimenta de ellos, hasta un pipeline que anonimice',
  needs: 'many',
  disabled(doc, ids) {
    const assets = selectedAssets(doc, ids);
    if (assets.length === 0) return NOT_AN_ASSET;
    if (!assets.some((a) => sensitivity(a) !== undefined)) return 'Ningún activo seleccionado tiene clasificación ni datos personales.';
    return spreadFrom(doc, ids).size === 0 ? 'Todo lo que se alimenta de la selección ya tiene al menos esa clasificación.' : undefined;
  },
  run(doc, ids) {
    const changed = spreadFrom(doc, ids);
    if (changed.size === 0) return { ok: false, reason: 'No hay nada que propagar: la selección no tiene clasificación o lo que depende de ella ya la tiene.' };
    return {
      ok: true,
      document: {
        ...doc,
        assets: doc.assets.map((a) => {
          const want = changed.get(a.id);
          if (!want) return a;
          const level = CLASSIFICATIONS.find((c) => CLASSIFICATION_RANK[c] === want.rank) as Classification | undefined;
          const current = a.classification ? CLASSIFICATION_RANK[a.classification] : -1;
          return { ...a, ...(level && want.rank > current ? { classification: level } : {}), ...(want.pii && !hasPii(a) ? { pii: true } : {}) };
        }),
      },
    };
  },
};

// ───────────── Enmascarar ─────────────

/** Activo y pipelines afectados por «Enmascarar»: la arista `flow:p:in:A` (solo ese pipeline) o el activo A (todos los que lo leen). */
function maskTarget(doc: DataDocument, id: string | undefined): { asset: DataAsset; pipelines: Pipeline[] } | string {
  if (!id) return 'Selecciona un activo con datos personales o una de sus aristas de entrada a un pipeline.';
  const flow = FLOW_EDGE.exec(id);
  const assetId = flow ? flow[3] : id;
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset) return 'Selecciona un activo con datos personales o una de sus aristas de entrada a un pipeline.';
  if (flow && flow[2] === 'out') return 'Selecciona la entrada del pipeline (la flecha que lee el dato), no su salida.';
  if (!ENTITY_KINDS.includes(asset.kind)) return 'Solo se enmascaran tablas, vistas, archivos y streams.';
  const sensitive = hasPii(asset) || (asset.classification !== undefined && CLASSIFICATION_RANK[asset.classification] >= CLASSIFICATION_RANK.confidential);
  if (!sensitive) return `«${asset.name}» no tiene datos personales ni una clasificación confidencial o restringida.`;
  const pipelines = doc.pipelines.filter((p) => p.inputs.includes(asset.id) && (!flow || p.id === flow[1]));
  if (pipelines.length === 0) return `Ningún pipeline lee «${asset.name}»: no hay nada que enmascarar.`;
  return { asset, pipelines };
}

/** El pipeline lee `to` en lugar de `from`, y sus mapeos de columnas parten de él. */
function rewired(p: Pipeline, from: string, to: string): Pipeline {
  const next: Pipeline = { ...p, inputs: [...new Set(p.inputs.map((x) => (x === from ? to : x)))] };
  if (p.mappings) next.mappings = p.mappings.map((m) => (m.from.assetId === from ? { ...m, from: { ...m.from, assetId: to } } : m));
  return next;
}

const MASK: EditorAction<DataDocument> = {
  id: 'mask',
  label: 'Enmascarar',
  hint: 'Inserta un pipeline que anonimiza el activo (o su entrada a un pipeline) y lo lee en su lugar una copia sin datos personales',
  needs: 'one',
  disabled(doc, ids) {
    const target = maskTarget(doc, ids[0]);
    return typeof target === 'string' ? target : undefined;
  },
  run(doc, ids) {
    const target = maskTarget(doc, ids[0]);
    if (typeof target === 'string') return { ok: false, reason: target };
    const { asset, pipelines } = target;
    const taken = allIds(doc);
    const maskedId = uniqueId(`${asset.id}-anonimizado`, taken);
    const pipelineId = uniqueId(`enmascarar-${asset.id}`, [...taken, maskedId]);
    const { pii: _pii, retention: _retention, contractId: _contract, ref: _ref, refType: _refType, tags: _tags, ...base } = asset;
    const masked: DataAsset = {
      ...base,
      id: maskedId,
      name: `${asset.name} (anonimizado)`,
      classification: 'internal',
      ...(asset.columns ? { columns: asset.columns.map(({ pii: _p, ...column }) => column) } : {}),
    };
    const pipeline: Pipeline = {
      id: pipelineId,
      name: `Enmascarar ${asset.name}`,
      kind: 'batch',
      inputs: [asset.id],
      outputs: [maskedId],
      description: `Anonimiza los datos personales de «${asset.name}» antes de que los lean otros pipelines.`,
      anonymizes: true,
      ...(asset.columns?.length ? { mappings: asset.columns.map((c) => ({ from: { assetId: asset.id, column: c.name }, to: { assetId: maskedId, column: c.name }, transform: c.pii ? 'anonimiza' : 'copia' })) } : {}),
    };
    const rewire = new Set(pipelines.map((p) => p.id));
    return {
      ok: true,
      id: pipelineNodeId(pipelineId),
      document: {
        ...doc,
        assets: [...doc.assets, masked],
        pipelines: [...doc.pipelines.map((p) => (rewire.has(p.id) ? rewired(p, asset.id, maskedId) : p)), pipeline],
      },
    };
  },
};

export const DATA_ACTIONS: Array<EditorAction<DataDocument>> = [GROUP_DOMAIN, PROPAGATE, MASK, ...CATALOG_ACTIONS];

