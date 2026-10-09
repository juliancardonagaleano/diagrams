import { ICON_TILE, ICON_TILE_OVERHANG, drawioShapeStyle, type SvgNodeStyle } from '@iark/kernel';
import type { PlatformDocument } from '../types';
import { findView, listViews } from '../views';
import { layoutView } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/**
 * Ficha del icono de un servicio de nube como celda de imagen aparte, encima de la esquina de su nodo o zona (draw.io acepta
 * `image=data:image/svg+xml,<base64>` sin el `;base64`): la misma ficha blanca con el color de acento que dibujan el lienzo y el SVG.
 */
function iconCell(id: string, paths: string[], color: string, x: number, y: number): string {
  const glyph = paths.map((d) => `<path d="${esc(d)}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect x="0.75" y="0.75" width="22.5" height="22.5" rx="5" fill="#ffffff" stroke="${color}" stroke-width="1.5"/><g transform="translate(4 4)" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`;
  return `<mxCell id="i-${esc(id)}" value="" style="shape=image;html=1;imageAspect=0;image=data:image/svg+xml,${btoa(svg)};" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${ICON_TILE}" height="${ICON_TILE}" as="geometry"/></mxCell>`;
}

function nodeStyle(s: SvgNodeStyle): string {
  return `${drawioShapeStyle(s.shape)}whiteSpace=wrap;html=1;fillColor=${s.fill};fontColor=#ffffff;strokeColor=${s.stroke.slice(0, 7)};${s.dashed ? 'dashed=1;' : ''}`;
}

/**
 * Exporta todas las vistas (topología, un entorno cada una y entrega continua) a un `.drawio`, una página por vista, ya
 * colocadas. Con `viewId`, solo esa (p. ej. la comparación `compare:<A>:<B>`, que no está entre las vistas por defecto).
 */
export async function toDrawio(doc: PlatformDocument, viewId?: string): Promise<string> {
  const pages: string[] = [];
  for (const v of viewId?.startsWith('compare:') ? [findView(doc, viewId)] : listViews(doc)) {
    const { view, layout, nodes, groups, edges, groupStyles, groupIcons } = await layoutView(doc, v.id);
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      const zone = groupStyles.get(g.id);
      const zoneStyle = zone ? `${zone.border === 'solid' ? 'strokeWidth=2;' : zone.border === 'dotted' ? 'dashed=1;dashPattern=1 4;strokeWidth=2;' : 'dashed=1;'}fillColor=${zone.fill};strokeColor=${zone.stroke};` : 'dashed=1;fillColor=#f8fafc;strokeColor=#94a3b8;';
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(groups.get(g.id) ?? g.id)}" style="rounded=1;whiteSpace=wrap;html=1;${zoneStyle}verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
      const icon = groupIcons.get(g.id);
      if (icon) cells.push(iconCell(g.id, icon.paths, icon.color, g.x + g.width - ICON_TILE + ICON_TILE_OVERHANG, g.y - ICON_TILE_OVERHANG));
    }
    for (const b of layout.nodes) {
      const s = nodes.get(b.id)!;
      const [title, ...rest] = s.lines;
      const value = [`<b>${esc(title)}</b>`, ...rest.map(esc), ...(s.badge ? [`<i>${esc(s.badge)}</i>`] : [])].join('<br>');
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${nodeStyle(s)}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
      if (s.icon && s.iconColor) cells.push(iconCell(b.id, s.icon, s.iconColor, b.x - ICON_TILE_OVERHANG, b.y - ICON_TILE_OVERHANG));
    }
    for (const e of layout.edges) {
      const edge = edges.get(e.id)!;
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(edge.label ?? '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;strokeColor=${edge.stroke};strokeWidth=${edge.width};${edge.dashed ? 'dashed=1;' : ''}" edge="1" parent="1" source="n-${esc(edge.source)}" target="n-${esc(edge.target)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="DIAgrams" agent="DIAgrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
