import { shapeParts, type ShapeKind } from '@iark/kernel';
import { tintaLegible } from '../a11y/contraste';

/** Tinta del texto sobre el relleno de un nodo: la de mayor contraste (el umbral de brillo del núcleo dejaba tonos medios por debajo de 4,5:1). */
export const textColorFor = (fill: string): string => tintaLegible(fill);

export function darken(hex: string, amount = 34): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number): string => Math.max(0, v - amount).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

interface Props {
  shape: ShapeKind;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  dashed?: boolean;
}

/** Figuras de las notaciones de los módulos, dibujadas en SVG al tamaño exacto del nodo con la geometría del núcleo (la misma que escriben los exportadores SVG). Las comparten el lienzo y la paleta. */
export function ShapeSvg({ shape, width: w, height: h, fill, stroke, dashed }: Props) {
  const line = stroke ?? darken(fill);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden="true">
      {shapeParts(shape, w, h).map((part, i) =>
        part.role === 'body' ? (
          <path key={i} d={part.d} fill={fill} stroke={line} strokeWidth={1.5} strokeDasharray={dashed ? '6 4' : undefined} />
        ) : (
          <path key={i} d={part.d} fill="none" stroke={line} strokeWidth={1.5} strokeOpacity={part.opacity} />
        ),
      )}
    </svg>
  );
}
