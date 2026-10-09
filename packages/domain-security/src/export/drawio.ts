import { drawioShapeStyle, type SvgNodeStyle } from '@iark/kernel';
import type { SecurityDocument } from '../types';
import { listViews } from '../views';
import { groupStyle, layoutView } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

function nodeStyle(s: SvgNodeStyle): string {
  return `${drawioShapeStyle(s.shape)}whiteSpace=wrap;html=1;fillColor=${s.fill};fontColor=#ffffff;strokeColor=${s.stroke.slice(0, 7)};${s.dashed ? 'dashed=1;' : ''}`;
}

/** Exporta todas las vistas (flujos de datos y modelo de amenazas) a un `.drawio`, una página por vista, ya colocadas; cada zona con el color de su nivel de confianza. */
export async function toDrawio(doc: SecurityDocument): Promise<string> {
  const pages: string[] = [];
  for (const v of listViews(doc)) {
    const { view, layout, nodes, groups, scene, edges } = await layoutView(doc, v.id);
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      const zone = groupStyle(scene.groups.get(g.id));
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(groups.get(g.id) ?? g.id)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=${zone.fill};strokeColor=${zone.stroke};verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      const s = nodes.get(b.id)!;
      const [title, ...rest] = s.lines;
      const value = [`<b>${esc(title)}</b>`, ...rest.map(esc), ...(s.note ? [esc(s.note)] : []), ...(s.badge ? [`<i>${esc(s.badge)}</i>`] : [])].join('<br>');
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${nodeStyle(s)}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
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
