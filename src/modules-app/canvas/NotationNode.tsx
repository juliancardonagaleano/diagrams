import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import type { NodeMark, PortSide } from '@iark/kernel';
import type { DiffMark, FlowNodeData } from './flow';
import { oscurecerHasta } from '../a11y/contraste';
import { ShapeSvg, textColorFor } from './shapes';

export type NotationNodeType = Node<FlowNodeData, 'notation'>;

/** Insignia de un elemento al comparar versiones. */
const DIFF_TEXT: Record<DiffMark, { text: string; title: string }> = {
  added: { text: 'Nuevo', title: 'Añadido respecto a la versión con la que se compara' },
  modified: { text: 'Modificado', title: 'Distinto de la versión con la que se compara' },
  removed: { text: 'Quitado', title: 'Estaba en la versión con la que se compara y ya no está' },
};

function DiffBadge({ id, diff }: { id: string; diff: DiffMark }) {
  return (
    <span className="cv-diff" data-diff={diff} title={DIFF_TEXT[diff].title} data-testid={`diff-${id}`}>
      {DIFF_TEXT[diff].text}
    </span>
  );
}

/**
 * Marcas del nodo (`EditorNode.marks`; Plataforma: «≈ Producción», el equivalente en otro entorno): píldoras blancas en la esquina inferior
 * izquierda. Cada una es una imagen con su frase completa por nombre accesible y por ayuda (`title`); el texto corto es solo lo que se ve.
 */
function NodeMarks({ id, marks }: { id: string; marks: readonly NodeMark[] }) {
  return (
    <div className="cv-node-marks" data-testid={`marks-${id}`}>
      {marks.map((m, i) => (
        <span key={i} className="cv-node-mark" role="img" aria-label={m.title} title={m.title} data-testid={`mark-${id}-${i}`}>
          {m.text}
        </span>
      ))}
    </div>
  );
}

/** Fondo claro del lienzo (en los dos temas el dibujo va sobre claro): sobre él se mide el título de una zona. */
const LIENZO = '#f4f5f7';

/**
 * Color del título de una zona: el de su borde, oscurecido lo justo para llegar a 4,5:1 (WCAG 1.4.3). El título lleva su propio fondo
 * (`LIENZO`, ver `.cv-group-title`), así que se mide contra él y no contra la mezcla de teñidos de la zona y de las zonas que la contienen.
 */
function inkOfZone(line: string): string {
  return oscurecerHasta(line, LIENZO);
}

const POSITIONS: Record<PortSide, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

/** Ficha de un icono de proveedor (un servicio de una nube): fondo blanco, borde y trazos del color de acento, sobre la esquina del nodo. */
function ProviderIcon({ id, paths, color, zone }: { id: string; paths: string[]; color: string; zone?: boolean }) {
  return (
    <svg className={zone ? 'cv-cloud-icon cv-cloud-icon-zone' : 'cv-cloud-icon'} width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" data-testid={`icon-${id}`} data-provider-icon={color}>
      <rect x={0.75} y={0.75} width={22.5} height={22.5} rx={5} fill="#ffffff" stroke={color} strokeWidth={1.5} />
      <g transform="translate(4 4)" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** Nodo del lienzo: la figura y el color los dicta la notación del módulo; los nodos con hijos se dibujan como zona. */
function NotationNodeImpl({ data, selected }: NodeProps<NotationNodeType>) {
  const { node, notation, group, width, height, diff } = data;
  const fill = node.fill ?? notation.fill;
  const ink = textColorFor(fill);
  // El icono propio del nodo (el servicio de una nube) sustituye al de su tipo; con color de acento es una ficha de proveedor.
  const provider = node.icon && node.icon.length > 0 && node.iconColor ? node.icon : undefined;
  const icon = node.icon ?? notation.icon;
  // La figura propia del nodo (un contenedor C4 que es una base de datos) sustituye a la de su tipo.
  const shape = node.shape ?? notation.shape;

  if (group) {
    const line = node.stroke ?? fill;
    const tint = node.fill ? { background: `color-mix(in srgb, ${node.fill} 14%, transparent)` } : undefined;
    return (
      <div className="cv-group" style={{ width, height, borderColor: line, ...(node.border ? { borderStyle: node.border } : {}), ...tint }} data-selected={selected || undefined} data-diff={diff} data-testid={`node-${node.id}`} data-kind={node.kind}>
        <Handle type="target" position={Position.Left} />
        {provider && <ProviderIcon id={node.id} paths={provider} color={node.iconColor!} zone />}
        <span className="cv-group-title" style={{ color: inkOfZone(line) }}>
          {notation.glyph} {notation.label}: {node.label}
          {node.ref && (
            <span className="cv-link cv-link-inline" title={`Enlaza con ${node.ref} (doble clic o Alt+↓ para ir)`} data-testid={`link-${node.id}`}>
              ⤷
            </span>
          )}
        </span>
        {node.marks && node.marks.length > 0 && <NodeMarks id={node.id} marks={node.marks} />}
        {diff && <DiffBadge id={node.id} diff={diff} />}
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div className="cv-node" style={{ width, height, color: ink }} data-selected={selected || undefined} data-diff={diff} data-testid={`node-${node.id}`} data-kind={node.kind} data-shape={shape}>
      <ShapeSvg shape={shape} width={width} height={height} fill={fill} stroke={node.stroke ?? notation.stroke} dashed={node.dashed} />
      {!notation.bare && <Handle type="target" position={Position.Left} />}
      {provider ? (
        <ProviderIcon id={node.id} paths={provider} color={node.iconColor!} />
      ) : (
        icon &&
        icon.length > 0 && (
          <svg className="cv-type-icon" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-testid={`icon-${node.id}`}>
            {icon.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </svg>
        )
      )}
      {node.lines ? (
        <div className="cv-node-text cv-card-text">
          <span className="cv-kind">{notation.label}</span>
          <strong>{node.label}</strong>
          {node.sublabel && <span className="cv-sub">{node.sublabel}</span>}
          <ul className="cv-lines">
            {node.lines.map((line, i) => (
              <li key={i} data-emphasis={node.lineEmphasis?.[i]}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="cv-node-text">
          {!notation.bare && <span className="cv-kind">{notation.label}</span>}
          <strong>{node.label}</strong>
          {node.sublabel && <span className="cv-sub">{node.sublabel}</span>}
        </div>
      )}
      {node.ref && (
        <span className="cv-link" title={`Enlaza con ${node.ref} (doble clic o Alt+↓ para ir)`} data-testid={`link-${node.id}`}>
          ⤷
        </span>
      )}
      {node.badges && node.badges.length > 0 && (
        <div className="cv-badges">
          {node.badges.map((b) => (
            <span key={b}>{b}</span>
          ))}
        </div>
      )}
      {node.marks && node.marks.length > 0 && <NodeMarks id={node.id} marks={node.marks} />}
      {diff && <DiffBadge id={node.id} diff={diff} />}
      {!notation.bare && <Handle type="source" position={Position.Right} />}
      {data.handles?.map((h) => (
        <Handle key={`${h.type}-${h.side}`} id={h.side} type={h.type} position={POSITIONS[h.side]} />
      ))}
    </div>
  );
}

export const NotationNode = memo(NotationNodeImpl);
