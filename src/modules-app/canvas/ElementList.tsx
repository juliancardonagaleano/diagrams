import { useMemo } from 'react';
import type { EditorGraph, EditorSpec } from '@iark/kernel';

interface Props {
  spec: EditorSpec<unknown>;
  graph: EditorGraph;
  /** Elementos y relaciones seleccionados. */
  selected: ReadonlySet<string>;
  /** Selecciona el elemento, lo encuadra (esté o no dibujado en pantalla) y le pasa el foco. */
  onGo(id: string): void;
  onClose(): void;
}

/**
 * Lista de los elementos y las relaciones del diagrama, como alternativa al dibujo (WCAG 1.1.1, 2.1.1 y 2.4.3). Sirve a quien navega con
 * teclado o lector de pantalla y sirve de salvavidas cuando el lienzo no dibuja los nodos que quedan fuera de la pantalla: aquí están todos,
 * agrupados como en el dibujo, y cada uno lleva a su elemento aunque haya que desplazar la vista hasta él.
 */
export function ElementList({ spec, graph, selected, onGo, onClose }: Props) {
  const rows = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const depth = (id: string): number => {
      let d = 0;
      for (let p = byId.get(id)?.parentId; p && byId.has(p) && d < 20; p = byId.get(p)?.parentId) d++;
      return d;
    };
    // Cada zona seguida de sus miembros, en el orden del documento.
    const children = new Map<string | undefined, typeof graph.nodes>();
    for (const n of graph.nodes) {
      const parent = n.parentId && byId.has(n.parentId) ? n.parentId : undefined;
      children.set(parent, [...(children.get(parent) ?? []), n]);
    }
    const ordered: Array<(typeof graph.nodes)[number]> = [];
    const walk = (parent: string | undefined): void => {
      for (const n of children.get(parent) ?? []) {
        ordered.push(n);
        walk(n.id);
      }
    };
    walk(undefined);
    return ordered.map((n) => ({ node: n, depth: depth(n.id), kind: spec.nodeKinds.find((k) => k.kind === n.kind)?.label ?? n.kind }));
  }, [graph, spec]);

  const names = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.label])), [graph]);
  const edges = graph.edges.filter((e) => names.has(e.source) && names.has(e.target));

  return (
    <section className="cv-list" aria-label="Lista de elementos del diagrama" data-testid="element-list">
      <div className="cv-list-head">
        <h2>
          Elementos ({rows.length}) y relaciones ({edges.length})
        </h2>
        <button type="button" className="cv-tool" onClick={onClose}>
          Cerrar la lista
        </button>
      </div>
      <p className="cv-hint">Elige uno para seleccionarlo, llevar la vista hasta él y pasarle el foco del teclado.</p>
      {rows.length === 0 && <p className="cv-hint">Este diagrama no tiene elementos.</p>}
      <ul className="cv-list-nodes" aria-label="Elementos">
        {rows.map(({ node, depth, kind }) => (
          <li key={node.id} style={{ paddingInlineStart: depth * 14 }}>
            <button type="button" className="cv-list-item" aria-pressed={selected.has(node.id)} onClick={() => onGo(node.id)} data-testid={`list-node-${node.id}`}>
              <span className="cv-list-kind">{kind}</span> {node.label}
            </button>
          </li>
        ))}
      </ul>
      {edges.length > 0 && (
        <ul className="cv-list-edges" aria-label="Relaciones">
          {edges.map((e) => {
            const label = [e.label, ...(e.badges ?? []).map((b) => `«${b}»`)].filter(Boolean).join(' ');
            const kind = spec.edgeKinds.find((k) => k.kind === e.kind)?.label ?? e.kind;
            return (
              <li key={e.id}>
                <button type="button" className="cv-list-item" aria-pressed={selected.has(e.id)} onClick={() => onGo(e.id)} data-testid={`list-edge-${e.id}`}>
                  <span className="cv-list-kind">{kind}</span> {names.get(e.source)} → {names.get(e.target)}
                  {label ? ` · ${label}` : ''}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
