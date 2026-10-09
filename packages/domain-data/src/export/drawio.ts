import { drawioShapeStyle } from '@iark/kernel';
import { linkLabel } from '../links';
import { KIND_LABELS, TERM_LABEL, type DataDocument } from '../types';
import { exportViews } from '../views';
import { ASSET_SHAPES, KIND_COLORS, LINK_STYLES, TERM_FILL, TERM_STROKE, catalogLine, colorOf, entityLines, governanceLine, isDashed, layoutView, pipelineLine, relationEnds, relationLabel, relationMultiplicities, strokeOf, termLines } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** Exporta todas las vistas (linaje, ERD en pata de gallo y en UML, y dominios) a un `.drawio`, una página por vista, ya colocadas con el autolayout. */
export async function toDrawio(doc: DataDocument): Promise<string> {
  const pages: string[] = [];
  for (const view of exportViews(doc)) {
    const { layout, assets, pipelineNodes, termNodes, edges, contextIds } = await layoutView(doc, view.id);
    const erd = view.type === 'erd';
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      const a = assets.get(g.id)!;
      const glossary = a.kind === 'glossary';
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(`${KIND_LABELS[a.kind]}: ${a.name}`)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=${glossary ? TERM_FILL : '#f8fafc'};strokeColor=${glossary ? TERM_STROKE : '#94a3b8'};verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      const pipeline = pipelineNodes.get(b.id);
      const term = termNodes.get(b.id);
      let value: string;
      let style: string;
      if (term) {
        const [title, ...rest] = termLines(term);
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc), `<i>${TERM_LABEL}</i>`].join('<br>');
        style = `rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=${TERM_FILL};fontColor=#0f172a;strokeColor=${TERM_STROKE};`;
      } else if (pipeline) {
        value = [`<b>${esc(pipeline.name)}</b>`, esc(pipelineLine(pipeline)), pipeline.tool ? esc(pipeline.tool) : ''].filter(Boolean).join('<br>');
        style = 'rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#334155;fontColor=#ffffff;strokeColor=#0f172a;';
      } else if (erd) {
        const a = assets.get(b.id)!;
        const [title, ...rest] = entityLines(a);
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc)].join('<br>');
        style = `rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=8;fillColor=#ffffff;fontColor=#0f172a;strokeColor=${KIND_COLORS[a.kind]};`;
      } else {
        const a = assets.get(b.id)!;
        const context = contextIds.has(b.id);
        const detail = catalogLine(a, (doc.terms ?? []).filter((t) => t.glossaryId === a.id).length);
        value = [`<b>${esc(a.name)}</b>`, detail ? esc(detail) : '', a.technology ? esc(a.technology) : '', `<i>${KIND_LABELS[a.kind]}</i>`, governanceLine(a) ? esc(governanceLine(a)) : ''].filter(Boolean).join('<br>');
        style = `${drawioShapeStyle(ASSET_SHAPES[a.kind])}whiteSpace=wrap;html=1;fillColor=${colorOf(a, context)};fontColor=#ffffff;strokeColor=${strokeOf(a).slice(0, 7)};${a.external || context ? 'dashed=1;' : ''}`;
      }
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
    }
    for (const e of layout.edges) {
      const { source, target, relation, pipeline, link } = edges.get(e.id)!;
      const linkStyle = link ? LINK_STYLES[link.kind] : undefined;
      const dashed = isDashed(pipeline) || linkStyle?.dashed ? 'dashed=1;' : '';
      const uml = !!relation && view.notation === 'uml';
      const ends = relation && !uml ? relationEnds(relation) : undefined;
      const arrows = uml
        ? 'startArrow=none;endArrow=none;'
        : ends
          ? `startArrow=${ends.source === 'one' ? 'ERone' : 'ERmany'};startFill=0;endArrow=${ends.target === 'one' ? 'ERone' : 'ERmany'};endFill=0;`
          : linkStyle
            ? `endArrow=${linkStyle.head === 'open' ? 'open' : 'block'};strokeColor=${linkStyle.stroke};fontColor=${linkStyle.stroke};`
            : 'endArrow=block;';
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(relation ? relationLabel(relation, view.notation) : link ? linkLabel(link) : '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;${arrows}${dashed}" edge="1" parent="1" source="n-${esc(source)}" target="n-${esc(target)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
      // La multiplicidad UML de cada extremo es una etiqueta de la arista (`x` = -1 junto al origen, 1 junto al destino).
      if (uml && relation) {
        const m = relationMultiplicities(relation);
        for (const [side, text, x] of [['source', m.source, -0.85], ['target', m.target, 0.85]] as const) {
          cells.push(
            `<mxCell id="e-${esc(e.id)}-${side}" value="${esc(text)}" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];" vertex="1" connectable="0" parent="e-${esc(e.id)}"><mxGeometry x="${x}" relative="1" as="geometry"><mxPoint y="-10" as="offset"/></mxGeometry></mxCell>`,
          );
        }
      }
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="DIAgrams" agent="DIAgrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
