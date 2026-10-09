import { findChildView } from '../../model/factories';
import { deriveView, type DerivedBoundary, type DerivedNode, type DerivedView } from '../../model/viewDerivation';
import type { C4Document } from '../../model/types';
import {
  boundaryLabel,
  boundaryStyle,
  c4TypeLabel,
  cardElementLabel,
  cardElementStyle,
  elementLabel,
  elementStyle,
  relationshipLabel,
  relationshipStyle,
  type DrawioLocale,
} from './styles';

/** Notación de los elementos: librería C4 de draw.io ('c4') o tarjetas estilo drawdb ('card'). */
export type DrawioNotation = 'c4' | 'card';

export interface DrawioOptions {
  /** Idioma de las etiquetas de tipo (c4Type). */
  locale?: DrawioLocale;
  /** Fecha para el atributo `modified` (por defecto ahora). */
  modified?: Date;
  /** Solo exportar estas vistas (ids). Por defecto todas. */
  viewIds?: string[];
  /** Notación de las figuras (por defecto 'c4'). */
  notation?: DrawioNotation;
  /** Incluir los quiebres de ruta calculados por el autolayout como waypoints (por defecto true). */
  waypoints?: boolean;
}

export class DrawioExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawioExportError';
  }
}

/**
 * Convierte un documento C4 a XML de draw.io (`.drawio`, sin comprimir).
 * Cada vista se convierte en una página. Los elementos deben estar posicionados
 * (ejecute autolayout antes si faltan coordenadas).
 */
export function toDrawio(doc: C4Document, options: DrawioOptions = {}): string {
  const locale = options.locale ?? 'es';
  const modified = (options.modified ?? new Date()).toISOString();
  const views = options.viewIds ? doc.views.filter((v) => options.viewIds!.includes(v.id)) : doc.views;
  if (views.length === 0) throw new DrawioExportError('El documento no tiene vistas que exportar');

  // Enlaces entre páginas: un elemento con vista hija exportada (sistema → C2, contenedor → C3) enlaza a esa página.
  const exportedIds = new Set(views.map((v) => v.id));
  const pageLinks = new Map<string, string>();
  for (const el of doc.model.elements) {
    const child = findChildView(doc, el.id);
    if (child && exportedIds.has(child.id)) pageLinks.set(el.id, child.id);
  }
  const notation = options.notation ?? 'c4';
  const waypoints = options.waypoints ?? true;
  const pages = views.map((v) => diagramXml(deriveView(doc, v.id), locale, pageLinks, notation, waypoints));
  return (
    `<mxfile host="DIAgrams" modified="${modified}" agent="DIAgrams" version="24.0.0" type="device">\n` +
    pages.join('\n') +
    `\n</mxfile>\n`
  );
}

function diagramXml(
  derived: DerivedView,
  locale: DrawioLocale,
  pageLinks: Map<string, string> = new Map(),
  notation: DrawioNotation = 'c4',
  waypoints = true,
): string {
  const { view, nodes, boundaries, edges } = derived;
  const unpositioned = nodes.filter((n) => !n.positioned);
  if (unpositioned.length > 0) {
    throw new DrawioExportError(
      `La vista "${view.id}" tiene elementos sin posición (${unpositioned.map((n) => n.id).join(', ')}). Ejecute el autolayout antes de exportar.`,
    );
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const boundaryById = new Map(boundaries.map((b) => [b.id, b]));
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];

  // Boundaries primero (de más externo a más interno) para que las celdas padre precedan a las hijas.
  const depth = (b: DerivedBoundary): number => (b.boundaryId ? 1 + depth(boundaryById.get(b.boundaryId)!) : 0);
  const orderedBoundaries = [...boundaries].sort((a, b) => depth(a) - depth(b));

  const absolute = (id: string): { x: number; y: number } => {
    const b = boundaryById.get(id);
    if (b) return { x: b.x ?? 0, y: b.y ?? 0 };
    const n = nodeById.get(id)!;
    return { x: n.x!, y: n.y! };
  };
  const relativeTo = (parentId: string | undefined, x: number, y: number): { x: number; y: number } => {
    if (!parentId) return { x, y };
    const p = absolute(parentId);
    return { x: x - p.x, y: y - p.y };
  };

  for (const b of orderedBoundaries) {
    // Boundary sin ningún hijo (vista/alcance vacío): sin geometría calculada, se omite en vez de
    // dibujar una caja falsa en (0,0). Si tuviera hijos sin posicionar, ya se habría lanzado arriba.
    if (b.width === undefined || b.height === undefined) continue;
    const el = b.element;
    const typeKey = el.type === 'container' ? 'boundary-container' : 'boundary-softwareSystem';
    const geo = relativeTo(b.boundaryId, b.x ?? 0, b.y ?? 0);
    cells.push(
      objectCell(
        cellId('el', b.id),
        { c4Name: el.name, c4Type: c4TypeLabel(locale, typeKey), label: boundaryLabel() },
        `<mxCell style="${boundaryStyle()}" vertex="1" parent="${parentCell(b.boundaryId)}">` +
          `<mxGeometry x="${geo.x}" y="${geo.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`,
      ),
    );
  }

  for (const n of nodes) {
    const el = n.element;
    const geo = relativeTo(n.boundaryId, n.x!, n.y!);
    const attrs: Record<string, string> = {
      c4Name: el.name,
      c4Type: c4TypeLabel(locale, el.type),
      c4Description: el.description ?? '',
      label: notation === 'card' ? cardElementLabel(el) : elementLabel(el),
    };
    if (el.type === 'container' || el.type === 'component') attrs.c4Technology = el.technology ?? '';
    const childPage = pageLinks.get(el.id);
    if (childPage && childPage !== view.id) attrs.link = `data:page/id,${childPage}`;
    const style = notation === 'card' ? cardElementStyle(el) : elementStyle(el);
    cells.push(
      objectCell(
        cellId('el', n.id),
        attrs,
        `<mxCell style="${style}" vertex="1" parent="${parentCell(n.boundaryId)}">` +
          `<mxGeometry x="${geo.x}" y="${geo.y}" width="${n.width}" height="${n.height}" as="geometry"/></mxCell>`,
      ),
    );
  }

  const routes = new Map((view.edges ?? []).map((r) => [r.id, r]));
  for (const e of edges) {
    const rel = e.relationship;
    const hasTech = !!rel.technology;
    const attrs: Record<string, string> = {
      c4Type: c4TypeLabel(locale, 'relationship'),
      c4Description: rel.description ?? '',
      label: relationshipLabel(hasTech),
    };
    if (hasTech) attrs.c4Technology = rel.technology!;
    // Waypoints del autolayout (quiebres intermedios en coordenadas absolutas; las aristas cuelgan de la capa raíz).
    const route = waypoints ? routes.get(e.id) : undefined;
    const bends = route ? route.points.slice(1, -1) : [];
    const geometry =
      bends.length > 0
        ? `<mxGeometry relative="1" as="geometry"><Array as="points">${bends.map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('')}</Array></mxGeometry>`
        : `<mxGeometry relative="1" as="geometry"/>`;
    cells.push(
      objectCell(
        cellId('rel', e.id),
        attrs,
        `<mxCell style="${relationshipStyle()}" edge="1" parent="1" source="${cellId('el', e.sourceId)}" target="${cellId('el', e.targetId)}">${geometry}</mxCell>`,
      ),
    );
  }

  return (
    `  <diagram id="${escapeAttr(view.id)}" name="${escapeAttr(view.title ?? view.id)}">\n` +
    `    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">\n` +
    `      <root>\n` +
    cells.map((c) => `        ${c}`).join('\n') +
    `\n      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>`
  );
}

function parentCell(boundaryId: string | undefined): string {
  return boundaryId ? cellId('el', boundaryId) : '1';
}

/**
 * Id de celda drawio con prefijo según su clase ('el' para elementos/boundaries, 'rel' para
 * relaciones). Evita dos colisiones posibles con el id crudo del usuario: con los ids reservados
 * `"0"`/`"1"` del root de cada página, y entre un elemento y una relación que comparten el mismo
 * id (el schema solo garantiza unicidad dentro de cada colección, no entre ambas).
 */
function cellId(kind: 'el' | 'rel', id: string): string {
  return `${kind}-${escapeAttr(id)}`;
}

function objectCell(id: string, attrs: Record<string, string>, inner: string): string {
  const attrString = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(' ');
  return `<object placeholders="1" ${attrString} id="${id}">${inner}</object>`;
}

export function escapeAttr(value: string): string {
  return value
    // Caracteres de control no válidos en XML 1.0 (se descartan; tab, LF y CR sí son válidos).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

export type { DerivedNode };
