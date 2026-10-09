import { indexElements, KIND_LABELS, type Capability, type EnterpriseDocument } from '../types';
import { listViews } from '../views';
import { drawioShapeStyle, type PortSide } from '@iark/kernel';
import { EDGE_STYLES, ELEMENT_ICONS, ELEMENT_SHAPES, INK, IMPORTANCE_STROKE, capabilityPaint, edgeLabel, elementLines, graphNodeStyle, layoutView, supportingApplications } from './render';

/** Icono del tipo como imagen SVG incrustada (draw.io acepta `image=data:image/svg+xml,<base64>` sin el `;base64`). */
function iconImage(paths: string[]): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
  return `shape=image;html=1;imageAspect=0;image=data:image/svg+xml,${btoa(svg)};`;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** Estilo draw.io de un tipo de relación: color, trazo, punta de flecha y adorno de origen (rombo de la composición, punto de la asignación). */
function edgeStyle(kind: keyof typeof EDGE_STYLES): string {
  const e = EDGE_STYLES[kind];
  const end = e.head === 'none' ? 'endArrow=none;' : e.head === 'open' ? 'endArrow=open;endFill=0;' : 'endArrow=block;';
  const start = e.tail === 'diamond' ? 'startArrow=diamondThin;startFill=1;' : e.tail === 'dot' ? 'startArrow=oval;startFill=1;' : '';
  return `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=${e.stroke};strokeWidth=${e.width ?? 1.5};${end}${start}${e.dashed ? 'dashed=1;' : ''}`;
}

/** Centro de cada lado de un nodo en las coordenadas relativas de draw.io (0 a 1), para fijar por dónde sale y entra una arista cuya colocación lo decide. */
const SIDE_POINT: Record<PortSide, [number, number]> = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5] };
function portStyle(sides: { source: PortSide; target: PortSide } | undefined): string {
  if (!sides) return '';
  const at = (prefix: 'exit' | 'entry', side: PortSide): string => `${prefix}X=${SIDE_POINT[side][0]};${prefix}Y=${SIDE_POINT[side][1]};${prefix}Dx=0;${prefix}Dy=0;`;
  return at('exit', sides.source) + at('entry', sides.target);
}

/** Exporta todas las vistas (mapa de capacidades, paisaje y unidades) a un `.drawio`, una página por vista, ya colocadas. */
export async function toDrawio(doc: EnterpriseDocument): Promise<string> {
  const pages: string[] = [];
  const all = indexElements(doc);
  const capabilities = new Map<string, Capability>(doc.capabilities.map((c) => [c.id, c]));
  const apps = supportingApplications(doc);
  for (const v of listViews(doc)) {
    const { view, layout, elements, edges, contextIds, groupLabels, matrix } = await layoutView(doc, v.id);
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(groupLabels?.get(g.id) ?? all.get(g.id)!.name)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f8fafc;strokeColor=#94a3b8;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      let value: string;
      let style: string;
      let icon: string[] | undefined;
      if (matrix) {
        const m = matrix.nodes.get(b.id)!;
        const [title, ...rest] = m.lines;
        value = m.kind === 'cell' ? esc(title) : [`<b>${esc(title)}</b>`, ...rest.map(esc)].join('<br>');
        style = `${drawioShapeStyle(m.shape)}whiteSpace=wrap;html=1;fillColor=${m.fill};fontColor=${INK};strokeColor=${m.stroke};${m.dashed ? 'dashed=1;' : ''}`;
        icon = m.kind === 'capability' || m.kind === 'application' ? ELEMENT_ICONS[m.kind] : undefined;
      } else if (view.type === 'capabilities') {
        const c = capabilities.get(b.id)!;
        const supporting = apps.get(b.id) ?? [];
        const count = supporting.length;
        const paint = capabilityPaint(c, view.colorBy ?? 'maturity', supporting);
        const [title, ...rest] = elementLines(all.get(b.id)!, doc);
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc), count === 0 ? '<i>sin aplicación</i>' : `${count} ${count === 1 ? 'aplicación' : 'aplicaciones'}`].join('<br>');
        style = `${drawioShapeStyle(ELEMENT_SHAPES.capability)}whiteSpace=wrap;html=1;fillColor=${paint.fill};fontColor=${INK};strokeColor=${c.importance ? IMPORTANCE_STROKE[c.importance] : '#495057'};${count === 0 ? 'dashed=1;' : ''}`;
        icon = ELEMENT_ICONS.capability;
      } else {
        const e = elements.get(b.id)!;
        const s = graphNodeStyle(e, doc, contextIds.has(b.id));
        const [title, ...rest] = s.lines;
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc), `<i>${KIND_LABELS[e.kind]}</i>`].join('<br>');
        style = `${drawioShapeStyle(ELEMENT_SHAPES[e.kind])}whiteSpace=wrap;html=1;fillColor=${s.fill};fontColor=${INK};strokeColor=${s.stroke.slice(0, 7)};${s.dashed ? 'dashed=1;' : ''}`;
        icon = ELEMENT_ICONS[e.kind];
      }
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
      if (icon) cells.push(`<mxCell id="i-${esc(b.id)}" value="" style="${iconImage(icon)}" vertex="1" parent="1"><mxGeometry x="${b.x + 7}" y="${b.y + 5}" width="16" height="16" as="geometry"/></mxCell>`);
    }
    for (const e of layout.edges) {
      const { relation, source, target } = edges.get(e.id)!;
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(edgeLabel(relation) ?? '')}" style="${edgeStyle(relation.kind)}${portStyle(e.sides)}" edge="1" parent="1" source="n-${esc(source)}" target="n-${esc(target)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="DIAgrams" agent="DIAgrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
