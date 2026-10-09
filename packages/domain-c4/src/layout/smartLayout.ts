import { isAbortError } from '@iark/kernel';
import type { DerivedView } from '../model/viewDerivation';
import { BOUNDARY_PADDING, type LayoutDirection } from '../model/types';
import { distributeCentered } from './distribute';
import {
  boundariesFromPositions,
  measureDerived,
  runElkLayout,
  type LayoutResult,
  type LayoutVariant,
  type PositionedElement,
  type ResolvedLayoutParams,
} from './elkLayout';
import { estimateLabelSize } from './labelMetrics';
import { routeEdges } from './router';

/**
 * Autolayout con autocorrección: prueba candidatos (dirección × distribución ×
 * estrategia de ELK) por orden de preferencia y se queda con el primero limpio
 * (0 cruces, 0 solapes) o, si ninguno lo es, con el de mejor puntuación.
 *
 * Prioridad por defecto: C1 arriba→abajo centrado; C2/C3 izquierda→derecha
 * centrado; después las variantes de ELK y por último la otra dirección.
 */

export const BASE_VARIANTS: LayoutVariant[] = [
  { name: 'brandes-koepf' },
  { name: 'network-simplex', nodePlacement: 'NETWORK_SIMPLEX' },
  { name: 'linear-segments', nodePlacement: 'LINEAR_SEGMENTS' },
  { name: 'brandes-koepf+spacing', spacingFactor: 1.35 },
];

export const RESCUE_VARIANTS: LayoutVariant[] = [
  { name: 'layer-sweep-thorough', thoroughness: 100, reverseEdges: true },
  { name: 'network-simplex+spacing', nodePlacement: 'NETWORK_SIMPLEX', spacingFactor: 1.35, thoroughness: 100 },
  { name: 'no-constraints', noLayerConstraints: true, thoroughness: 100 },
];

export interface LayoutCandidate {
  direction: LayoutDirection;
  distribution: 'centered' | 'elk';
  variant: LayoutVariant;
  /** Pertenece a la clase preferida (dirección y distribución preferidas). */
  preferred: boolean;
}

function otherDirection(d: LayoutDirection): LayoutDirection {
  return d === 'DOWN' || d === 'UP' ? 'RIGHT' : 'DOWN';
}

/** Lista ordenada de candidatos según las preferencias resueltas. */
export function buildCandidates(params: ResolvedLayoutParams): LayoutCandidate[] {
  const distributions: Array<'centered' | 'elk'> = params.distribution === 'elk' ? ['elk'] : params.distribution === 'centered' ? ['centered'] : ['centered', 'elk'];
  const directions: LayoutDirection[] = params.directionMode === 'auto' ? [params.direction, otherDirection(params.direction)] : [params.direction];
  const list: LayoutCandidate[] = [];
  directions.forEach((direction, di) => {
    for (const distribution of distributions) {
      const variants = distribution === 'centered' ? BASE_VARIANTS.slice(0, 2) : BASE_VARIANTS;
      for (const variant of variants) {
        list.push({ direction, distribution, variant, preferred: di === 0 && distribution === distributions[0] });
      }
    }
  });
  return list;
}

/** Enrutado propio (con esquiva de nodos y boundaries) para unas posiciones ya calculadas. */
function buildRoutes(derived: DerivedView, positions: PositionedElement[], boundaries: PositionedElement[], direction: LayoutDirection, spacing: number) {
  const containment = new Map<string, Set<string>>();
  const boundaryParent = new Map(derived.boundaries.map((b) => [b.id, b.boundaryId]));
  for (const n of derived.nodes) {
    const set = new Set<string>();
    let current = n.boundaryId;
    while (current && !set.has(current)) {
      set.add(current);
      current = boundaryParent.get(current);
    }
    containment.set(n.id, set);
  }
  return routeEdges({
    rects: positions,
    boundaries,
    containment,
    edges: derived.edges.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: estimateLabelSize(e.relationship.description, e.relationship.technology) })),
    direction,
    spacing,
  });
}

/**
 * Último recurso cuando ELK falla en todos los candidatos: cuadrícula determinista. Los nodos de un
 * mismo boundary quedan contiguos y cada grupo ocupa su propio bloque, así los boundaries (que se
 * derivan del rectángulo de sus hijos) no se solapan. No es bonito, pero exportar nunca se rompe.
 */
export function gridLayout(derived: DerivedView, params: ResolvedLayoutParams): LayoutResult {
  const boundaryParent = new Map(derived.boundaries.map((b) => [b.id, b.boundaryId]));
  const chainKey = (boundaryId?: string): string => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = boundaryId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(cur);
      cur = boundaryParent.get(cur);
    }
    return chain.join('\u0000');
  };
  const maxDepth = Math.max(0, ...derived.nodes.map((n) => (chainKey(n.boundaryId) ? chainKey(n.boundaryId).split('\u0000').length : 0)));
  const pad = BOUNDARY_PADDING;
  const groups = new Map<string, typeof derived.nodes>();
  for (const n of [...derived.nodes].sort((a, b) => chainKey(a.boundaryId).localeCompare(chainKey(b.boundaryId)))) {
    const key = chainKey(n.boundaryId);
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const COLS = 3;
  const x0 = 20 + maxDepth * pad.left;
  const gap = (maxDepth + 1) * (pad.top + pad.bottom);
  let y = 20 + maxDepth * pad.top;
  const positions: PositionedElement[] = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i += COLS) {
      const row = members.slice(i, i + COLS);
      let x = x0;
      for (const n of row) {
        positions.push({ id: n.id, x, y, width: n.width, height: n.height });
        x += n.width + params.spacing;
      }
      y += Math.max(...row.map((n) => n.height)) + params.layerSpacing;
    }
    y += gap;
  }
  const boundaries = boundariesFromPositions(derived, positions);
  const routes = buildRoutes(derived, positions, boundaries, params.direction, params.spacing);
  const result: LayoutResult = { viewId: derived.view.id, positions, boundaries, routes, direction: params.direction, distribution: 'elk' };
  result.quality = { ...measureDerived(derived, positions, boundaries, params.direction, routes), strategy: `${params.direction}/grid` };
  return result;
}

function isClean(r: LayoutResult): boolean {
  const q = r.quality;
  return !!q && q.crossings === 0 && q.edgeNodeOverlaps === 0 && q.labelOverlaps === 0;
}

/** Ejecuta un candidato: ELK y, si procede, distribución centrada + enrutado propio. */
export async function runCandidate(derived: DerivedView, params: ResolvedLayoutParams, candidate: LayoutCandidate): Promise<LayoutResult> {
  const p = { ...params, direction: candidate.direction };
  let base: LayoutResult;
  try {
    base = await runElkLayout(derived, p, candidate.variant);
  } catch (error) {
    if (isAbortError(error) || candidate.variant.noLayerConstraints) throw error;
    base = await runElkLayout(derived, p, { ...candidate.variant, noLayerConstraints: true });
  }
  if (candidate.distribution === 'elk') {
    base.quality = { ...measureDerived(derived, base.positions, base.boundaries, p.direction, base.routes), strategy: `${p.direction}/elk/${candidate.variant.name}` };
    return base;
  }
  const spacingFactor = candidate.variant.spacingFactor ?? 1;
  const distributed = distributeCentered(base.positions, derived, {
    direction: p.direction,
    spacing: Math.round(p.spacing * spacingFactor),
    layerSpacing: Math.round(p.layerSpacing * spacingFactor),
  });
  const boundaries = boundariesFromPositions(derived, distributed.positions);
  const routes = buildRoutes(derived, distributed.positions, boundaries, p.direction, p.spacing);
  const result: LayoutResult = { viewId: derived.view.id, positions: distributed.positions, boundaries, routes, direction: p.direction, distribution: 'centered' };
  result.quality = { ...measureDerived(derived, result.positions, result.boundaries, p.direction, routes), strategy: `${p.direction}/centered/${candidate.variant.name}` };
  return result;
}

export async function smartLayout(derived: DerivedView, params: ResolvedLayoutParams, candidates: LayoutCandidate[] = buildCandidates(params)): Promise<LayoutResult> {
  let best: LayoutResult | null = null;
  let bestScore = Infinity;
  let tried = 0;

  const attempt = async (candidate: LayoutCandidate): Promise<boolean> => {
    let result: LayoutResult;
    try {
      result = await runCandidate(derived, params, candidate);
    } catch (error) {
      // Cancelar no es un fallo del candidato: se propaga y termina todo el layout.
      if (isAbortError(error)) throw error;
      // Un candidato puede hacer fallar a ELK (p. ej. UnsupportedGraphException en grafos jerárquicos):
      // se descarta y se sigue con los demás en vez de abortar todo el layout.
      return false;
    }
    tried += 1;
    // Bonus a la clase preferida: entre resultados no limpios, gana el preferido salvo diferencia clara.
    const effective = result.quality!.score * (candidate.preferred ? 0.8 : 1);
    if (effective < bestScore) {
      bestScore = effective;
      best = result;
    }
    return isClean(result);
  };

  for (const c of candidates) if (await attempt(c)) break;
  if (best && !isClean(best)) {
    for (const v of RESCUE_VARIANTS) {
      if (await attempt({ direction: params.direction, distribution: 'elk', variant: v, preferred: false })) break;
    }
  }

  // Ningún candidato de ELK funcionó: cuadrícula determinista (mejor eso que dejar el documento sin layout).
  const chosen: LayoutResult = best ?? gridLayout(derived, params);
  chosen.quality = { ...chosen.quality!, candidates: tried };
  return chosen;
}
