import { drawioShapeStyle, readableTextColor } from '@iark/kernel';
import { KIND_LABELS, type IntegrationDocument, type IntegrationNode } from '../types';
import { PATTERN_INFO } from '../patterns';
import { listViews } from '../views';
import { NODE_SHAPES, colorOf, contractLine, layoutView } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** Texto de una etiqueta HTML de draw.io (se escapa otra vez como atributo XML al escribirla). */
const html = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

function nodeValue(doc: IntegrationDocument, n: IntegrationNode): string {
  if (n.kind === 'pattern') {
    const label = n.pattern ? PATTERN_INFO[n.pattern].label : '';
    return [`<b>${html(n.name)}</b>`, label && label !== n.name ? html(label) : ''].filter(Boolean).join('<br>');
  }
  const contract = contractLine(doc, n);
  return [`<b>${html(n.name)}</b>`, n.technology ? html(n.technology) : '', contract ? html(contract) : '', `<i>${KIND_LABELS[n.kind]}</i>`].filter(Boolean).join('<br>');
}

/** Exporta todas las vistas a un `.drawio`, una página por vista, ya colocadas con el autolayout. Las zonas y los contenedores son celdas de grupo que contienen a sus nodos. */
export async function toDrawio(doc: IntegrationDocument): Promise<string> {
  const pages: string[] = [];
  for (const view of listViews(doc)) {
    const { layout, nodes, interactions, labels, zones, parents } = await layoutView(doc, view.id);
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    const boxes = new Map([...layout.groups, ...layout.nodes].map((b) => [b.id, b]));
    const cellId = (id: string): string => `n-${esc(id)}`;
    const place = (id: string): string => {
      const b = boxes.get(id)!;
      const parent = parents.get(id);
      const origin = parent ? boxes.get(parent) : undefined;
      return `parent="${parent ? cellId(parent) : '1'}"><mxGeometry x="${b.x - (origin?.x ?? 0)}" y="${b.y - (origin?.y ?? 0)}" width="${b.width}" height="${b.height}" as="geometry"/>`;
    };

    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      const zone = zoneById.get(g.id);
      const label = zone ? `Dominio: ${zone.name}` : `${KIND_LABELS[nodes.get(g.id)!.kind]}: ${nodes.get(g.id)!.name}`;
      const colors = zone ? `fillColor=${zone.fill};strokeColor=${zone.stroke};` : 'fillColor=#f8fafc;strokeColor=#94a3b8;';
      cells.push(
        `<mxCell id="${cellId(g.id)}" value="${esc(label)}" style="rounded=1;whiteSpace=wrap;html=1;container=1;collapsible=0;dashed=1;${colors}fontColor=#475569;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" ${place(g.id)}</mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      const n = nodes.get(b.id)!;
      const fill = colorOf(n);
      // El actor lleva su texto fuera de la figura, sobre el fondo de la página.
      const ink = NODE_SHAPES[n.kind] === 'actor' ? '#0f172a' : readableTextColor(fill);
      const style = `${drawioShapeStyle(NODE_SHAPES[n.kind])}whiteSpace=wrap;html=1;fillColor=${fill};fontColor=${ink};strokeColor=#0f172a;${n.external ? 'dashed=1;' : ''}`;
      cells.push(`<mxCell id="${cellId(b.id)}" value="${esc(nodeValue(doc, n))}" style="${style}" vertex="1" ${place(b.id)}</mxCell>`);
    }
    for (const e of layout.edges) {
      const it = interactions.get(e.id)!;
      const dashed = it.style !== 'request-response' ? 'dashed=1;' : '';
      const width = it.style === 'event' || it.style === 'stream' ? 'strokeWidth=3;' : '';
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(html(labels.get(e.id) ?? ''))}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;${dashed}${width}" edge="1" parent="1" source="${cellId(it.sourceId)}" target="${cellId(it.targetId)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="DIAgrams" agent="DIAgrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
