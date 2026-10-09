import type { EdgeNotation, EditorEdge, EditorGraph, EditorNode, NodeNotation } from '@iark/kernel';

/**
 * Nombres accesibles de los nodos y las relaciones del lienzo, para lectores de pantalla (WCAG 4.1.2 y 1.1.1): tipo, nombre y a qué
 * se conecta, en una frase. El dibujo es la única fuente de esa información para quien no lo ve; por eso el nombre de un nodo dice
 * también con quién se relaciona, y el de una relación, de dónde a dónde va.
 */

/** Cuántos vecinos se nombran antes de resumir con «y N más» (la lista completa está en el panel de propiedades y en la lista de elementos). */
const MAX_NOMBRES = 4;

export type MarcaCambio = 'added' | 'modified' | 'removed';

const CAMBIO: Record<MarcaCambio, string> = {
  added: 'Nuevo respecto a la versión con la que se compara',
  modified: 'Modificado respecto a la versión con la que se compara',
  removed: 'Quitado respecto a la versión con la que se compara',
};

/** Texto de una marca de la comparación de versiones. */
export const textoCambio = (diff: MarcaCambio): string => CAMBIO[diff];

/** Relaciones de cada nodo, ya resueltas a nombres: se calcula una vez por grafo y sirve para describir todos los nodos. */
export interface IndiceRelaciones {
  salientes: Map<string, string[]>;
  entrantes: Map<string, string[]>;
  hijos: Map<string, number>;
  nombres: Map<string, string>;
}

export function indexarRelaciones(graph: EditorGraph): IndiceRelaciones {
  const nombres = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const salientes = new Map<string, string[]>();
  const entrantes = new Map<string, string[]>();
  const hijos = new Map<string, number>();
  for (const e of graph.edges) {
    const origen = nombres.get(e.source);
    const destino = nombres.get(e.target);
    if (origen === undefined || destino === undefined) continue;
    salientes.set(e.source, [...(salientes.get(e.source) ?? []), destino]);
    entrantes.set(e.target, [...(entrantes.get(e.target) ?? []), origen]);
  }
  for (const n of graph.nodes) if (n.parentId && nombres.has(n.parentId)) hijos.set(n.parentId, (hijos.get(n.parentId) ?? 0) + 1);
  return { salientes, entrantes, hijos, nombres };
}

/** «A, B, C y 2 más». */
export function enumerar(nombres: readonly string[], max = MAX_NOMBRES): string {
  if (nombres.length <= max) return nombres.length <= 1 ? (nombres[0] ?? '') : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
  return `${nombres.slice(0, max).join(', ')} y ${nombres.length - max} más`;
}

const plural = (n: number, uno: string, varios: string): string => (n === 1 ? uno : varios);

/**
 * Frase que lee un lector de pantalla al llegar a un nodo: «Contenedor: API de pedidos, Node.js. Dentro de «Sistema de pedidos».
 * Sale hacia 2: Base de datos y Cola. Recibe de 1: Web. Enlaza con otro módulo. Modificado respecto a la versión con la que se compara.»
 */
export function describirNodo(node: EditorNode, notation: Pick<NodeNotation, 'label'>, indice: IndiceRelaciones, diff?: MarcaCambio): string {
  const partes = [`${notation.label}: ${node.label}${node.sublabel ? `, ${node.sublabel}` : ''}`];
  const padre = node.parentId ? indice.nombres.get(node.parentId) : undefined;
  if (padre) partes.push(`Dentro de «${padre}»`);
  const hijos = indice.hijos.get(node.id) ?? 0;
  if (hijos > 0) partes.push(`Contiene ${hijos} ${plural(hijos, 'elemento', 'elementos')}`);
  const salientes = indice.salientes.get(node.id) ?? [];
  if (salientes.length > 0) partes.push(`Sale hacia ${salientes.length}: ${enumerar(salientes)}`);
  const entrantes = indice.entrantes.get(node.id) ?? [];
  if (entrantes.length > 0) partes.push(`Recibe de ${entrantes.length}: ${enumerar(entrantes)}`);
  if (node.ref) partes.push('Enlaza con otro módulo (Alt+flecha abajo para ir)');
  if (node.badges && node.badges.length > 0) partes.push(`Etiquetas: ${node.badges.join(', ')}`);
  if (diff) partes.push(textoCambio(diff));
  return `${partes.join('. ')}.`;
}

/** Frase de una relación: «Relación Usa «Lee pedidos»: de Web a API de pedidos.» */
export function describirRelacion(edge: EditorEdge, notation: Pick<EdgeNotation, 'label'>, indice: IndiceRelaciones, diff?: Exclude<MarcaCambio, 'removed'>): string {
  const origen = indice.nombres.get(edge.source) ?? edge.source;
  const destino = indice.nombres.get(edge.target) ?? edge.target;
  const texto = [edge.label, ...(edge.badges ?? []).map((b) => `«${b}»`)].filter(Boolean).join(' ');
  const base = `${notation.label}${texto ? ` «${texto}»` : ''}: de ${origen} a ${destino}.`;
  return diff ? `${base} ${textoCambio(diff)}.` : base;
}

/** Aviso que se anuncia al cambiar la selección (región `aria-live`). */
export function anunciarSeleccion(nombres: readonly string[]): string {
  if (nombres.length === 0) return 'Selección vacía.';
  if (nombres.length === 1) return `Seleccionado: ${nombres[0]}.`;
  return `${nombres.length} elementos seleccionados.`;
}
