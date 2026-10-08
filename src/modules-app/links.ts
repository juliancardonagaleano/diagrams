import { analyzeText, buildTraceGraph, DEFAULT_LINK_TYPE, formatUrn, parseUrn, TRACE_LINK_TYPES, type AnyModule, type EntityRef, type TraceGraph, type TraceInput } from '@iark/kernel';
import type { SuiteDocument, WorkbenchController } from './controller';

/**
 * Enlaces entre diagramas de distintos módulos. Los documentos solo guardan URN (`urn:iark:<módulo>:<id>`); ningún
 * módulo conoce a otro. El banco de trabajo reúne los documentos disponibles, construye el grafo de trazabilidad del núcleo y
 * con él resuelve a dónde lleva un enlace y quién apunta a un elemento. Sin proyecto, los documentos son el activo y los
 * borradores (o ejemplos) de los demás módulos; con un proyecto abierto, son sus diagramas, varios por módulo si los hay: la
 * URN se resuelve en todo el proyecto y, si dos diagramas del mismo módulo definen el mismo id, apunta al primero.
 */

export interface ResolvedRef {
  moduleId: string;
  elementId: string;
  urn: string;
}

export interface Backlink {
  urn: string;
  moduleId: string;
  moduleLabel: string;
  elementId: string;
  name: string;
  kind: string;
  /** Tipo del enlace (`refType` de quien apunta; `depends-on` si no declara ninguno). */
  type: string;
}

export interface LinkTypeOption {
  id: string;
  /** Lo que se lee en el selector: el id, con «por omisión» en el de siempre y «propio» en uno fuera del vocabulario. */
  label: string;
  description: string;
}

/**
 * Los tipos que ofrece el selector de enlace: el vocabulario sugerido y, si el elemento ya trae uno propio (de otro módulo, de
 * un tercero), ese también, para no perderlo al abrir el panel. Sin tipo declarado queda seleccionado `depends-on`.
 */
export function linkTypeOptions(current?: string): LinkTypeOption[] {
  const suggested = TRACE_LINK_TYPES.map((t) => ({ id: t.id, label: t.id === DEFAULT_LINK_TYPE ? `${t.id} (por omisión)` : t.id, description: t.description }));
  if (!current || suggested.some((t) => t.id === current)) return suggested;
  return [...suggested, { id: current, label: `${current} (propio)`, description: 'Tipo de enlace fuera del vocabulario sugerido; se respeta tal cual.' }];
}

export function resolveRef(urn: string): ResolvedRef | undefined {
  const parsed = parseUrn(urn);
  return parsed ? { moduleId: parsed.module, elementId: parsed.id, urn } : undefined;
}

/** Dónde está definido un elemento: los diagramas del proyecto que lo contienen (uno solo si no hay proyecto). */
export interface Owner {
  /** `undefined` fuera de un proyecto: el documento es el borrador del módulo. */
  diagramId?: string;
  label: string;
}

interface Snapshot {
  graph: TraceGraph;
  /** URN → documentos que la definen, en el orden del conjunto. */
  owners: Map<string, Owner[]>;
  /** Entidades referenciables por módulo, sin repetir ids. */
  entities: Map<string, EntityRef[]>;
}

export class SuiteLinks {
  private snapshot: Snapshot | undefined;
  private signature = '';

  constructor(private readonly controller: WorkbenchController) {}

  /** Grafo, dueños y entidades con todos los documentos disponibles; se reconstruye solo si algún texto cambió. */
  private async build(): Promise<Snapshot> {
    const docs: SuiteDocument[] = await this.controller.suiteDocuments();
    const signature = docs.map((d) => `${d.moduleId}:${d.diagramId ?? ''}:${d.text.length}:${hash(d.text)}`).join('|');
    if (this.snapshot && signature === this.signature) return this.snapshot;
    const inputs: TraceInput[] = [];
    const owners = new Map<string, Owner[]>();
    const entities = new Map<string, EntityRef[]>();
    for (const doc of docs) {
      let module: AnyModule;
      try {
        module = await this.controller.loadModule(doc.moduleId);
      } catch {
        continue;
      }
      const analysis = analyzeText(module, doc.text);
      if (analysis.status !== 'ok') continue;
      inputs.push({ module, document: analysis.document, source: doc.label });
      const known = entities.get(module.id) ?? [];
      for (const entity of module.entities?.(analysis.document) ?? []) {
        const urn = formatUrn(module.id, entity.id);
        owners.set(urn, [...(owners.get(urn) ?? []), { diagramId: doc.diagramId, label: doc.label }]);
        if (!known.some((e) => e.id === entity.id)) known.push(entity);
      }
      entities.set(module.id, known);
    }
    this.snapshot = { graph: buildTraceGraph(inputs, { allowRepeatedModules: true }), owners, entities };
    this.signature = signature;
    return this.snapshot;
  }

  /** Grafo de trazabilidad con todos los documentos disponibles. */
  async graphOf(): Promise<TraceGraph> {
    return (await this.build()).graph;
  }

  /** Los documentos que definen la URN (en un proyecto, los diagramas; si hay varios, la referencia es ambigua). */
  async owners(urn: string): Promise<Owner[]> {
    return (await this.build()).owners.get(urn) ?? [];
  }

  /** Quién apunta al elemento `elementId` del módulo `moduleId`. */
  async backlinks(moduleId: string, elementId: string): Promise<Backlink[]> {
    const graph = await this.graphOf();
    const urn = formatUrn(moduleId, elementId);
    const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
    return graph.links
      .filter((l) => l.to === urn)
      .flatMap((l) => {
        const n = byUrn.get(l.from);
        return n ? [{ urn: n.urn, moduleId: n.module, moduleLabel: this.label(n.module), elementId: n.id, name: n.name, kind: n.kind, type: l.type }] : [];
      });
  }

  /** Elementos referenciables de un módulo (de todos sus diagramas si hay proyecto), para elegir el destino de un enlace sin escribir la URN. */
  async entities(moduleId: string): Promise<EntityRef[]> {
    return (await this.build()).entities.get(moduleId) ?? [];
  }

  /** ¿Existe el destino de esta URN en los documentos disponibles? `undefined` si el módulo no se conoce. */
  async exists(urn: string): Promise<boolean | undefined> {
    const ref = resolveRef(urn);
    if (!ref || !this.controller.moduleIds.includes(ref.moduleId)) return undefined;
    const graph = await this.graphOf();
    return graph.nodes.some((n) => n.urn === urn);
  }

  label(moduleId: string): string {
    return this.controller.sources.find((s) => s.id === moduleId)?.label ?? moduleId;
  }
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 7) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
