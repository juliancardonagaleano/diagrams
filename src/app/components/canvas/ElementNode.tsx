import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import { C4_COLORS, C4_EXTERNAL_COLOR, ELEMENT_TYPE_LABELS, type C4Element } from '@core/model/types';
import { tintaLegible } from '../../../modules-app/a11y/contraste';
import { C4Shape, shapeGeometry, shapeOf } from './C4Shape';

export type ElementNodeData = {
  element: C4Element;
  readOnly?: boolean;
  /** 'c4': notación clásica (cajas de color); 'card': tarjeta estilo drawdb. */
  nodeStyle?: 'c4' | 'card';
  /** Id de la vista hija (C2/C3) a la que se navega con doble clic, si existe. */
  childViewId?: string;
};
export type ElementNodeType = Node<ElementNodeData, 'element'>;

export function elementColor(el: C4Element): string {
  if (el.color) return el.color;
  return el.external ? C4_EXTERNAL_COLOR : C4_COLORS[el.type];
}

/** Color de texto legible sobre el relleno: el de mayor contraste, siempre al menos 4,5:1 (WCAG 1.4.3). */
export function textColorFor(fill: string): string {
  return tintaLegible(fill);
}

function shapeIcon(el: C4Element): string | null {
  switch (el.shape) {
    case 'database':
      return '🛢';
    case 'queue':
      return '📨';
    case 'browser':
      return '🌐';
    case 'mobile':
      return '📱';
    default:
      return null;
  }
}

function typeLineFor(el: C4Element): string {
  return el.type === 'container' || el.type === 'component'
    ? `[${ELEMENT_TYPE_LABELS[el.type]}${el.technology ? `: ${el.technology}` : ''}]`
    : `[${ELEMENT_TYPE_LABELS[el.type]}${el.external ? ' externo' : ''}]`;
}

function DrillBadge({ childViewId, textColor }: { childViewId?: string; textColor: string }) {
  if (!childViewId) return null;
  return (
    <span className="c4-drill-badge" title="Doble clic para abrir el nivel inferior" style={{ color: textColor, borderColor: textColor }}>
      ⤵
    </span>
  );
}

function Handles({ readOnly }: { readOnly?: boolean }) {
  return (
    <>
      <Handle type="source" position={Position.Top} id="top" isConnectable={!readOnly} />
      <Handle type="source" position={Position.Right} id="right" isConnectable={!readOnly} />
      <Handle type="source" position={Position.Bottom} id="bottom" isConnectable={!readOnly} />
      <Handle type="source" position={Position.Left} id="left" isConnectable={!readOnly} />
    </>
  );
}

function ElementNodeComponent({ data, selected, width, height }: NodeProps<ElementNodeType>) {
  const el = data.element;
  const color = elementColor(el);
  const typeLine = typeLineFor(el);
  const w = width ?? 240;
  const h = height ?? 130;

  if (data.nodeStyle === 'card') {
    const icon = shapeIcon(el);
    return (
      <div className={`c4-node group ${selected ? 'selected' : ''} ${el.type === 'person' ? 'is-person' : ''} ${data.childViewId ? 'has-child' : ''}`} style={{ width: w, height: h }}>
        <div className="c4-node-strip" style={{ backgroundColor: color }}>
          {el.type === 'person' && (
            <svg width="30" height="30" viewBox="0 0 24 24" fill="white" aria-hidden>
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
            </svg>
          )}
        </div>
        <div className="c4-node-header" title={el.name}>
          <span className="truncate">{el.name}</span>
          {icon && <span className="text-sm">{icon}</span>}
          <DrillBadge childViewId={data.childViewId} textColor="currentColor" />
        </div>
        <div className="c4-node-type">{typeLine}</div>
        {el.description && <div className="c4-node-desc">{el.description}</div>}
        <Handles readOnly={data.readOnly} />
      </div>
    );
  }

  const textColor = textColorFor(color);
  const { padding } = shapeGeometry(el);
  return (
    <div
      className={`c4-shape shape-${shapeOf(el)} ${selected ? 'selected' : ''} ${data.childViewId ? 'has-child' : ''}`}
      style={{ width: w, height: h, color: textColor }}
      title={el.description ? `${el.name}\n${el.description}` : el.name}
    >
      <C4Shape element={el} width={w} height={h} fill={color} />
      <div className="c4-shape-text" style={{ padding: `${padding[0]}px ${padding[1]}px ${padding[2]}px ${padding[3]}px` }}>
        <div className="c4-shape-name">{el.name}</div>
        <div className="c4-shape-type">{typeLine}</div>
        {el.description && <div className="c4-shape-desc">{el.description}</div>}
      </div>
      <DrillBadge childViewId={data.childViewId} textColor={textColor} />
      <Handles readOnly={data.readOnly} />
    </div>
  );
}

export const ElementNode = memo(ElementNodeComponent);
