/**
 * Contraste de color según WCAG 2.x (criterios 1.4.3 y 1.4.11): luminancia relativa y razón de contraste.
 * Lo usan el lienzo (tinta legible sobre el relleno de un nodo, título de una zona) y la prueba que mide los pares de color de los
 * temas (`contraste.test.ts`).
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Texto normal de nivel AA (1.4.3). */
export const MIN_TEXTO = 4.5;
/** Componentes de interfaz, iconos y texto grande de nivel AA (1.4.11 y 1.4.3). */
export const MIN_COMPONENTE = 3;

/** Acepta `#rgb`, `#rrggbb` y `rgb()/rgba()` (el canal alfa se ignora: quien mezcla con transparencia usa `mezclar`). */
export function parseColor(css: string): Rgb | undefined {
  const text = css.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return { r: parseInt(short[1] + short[1], 16), g: parseInt(short[2] + short[2], 16), b: parseInt(short[3] + short[3], 16) };
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/i.exec(text);
  if (long) return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16) };
  const fn = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(text);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
  return undefined;
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Luminancia relativa (0 negro, 1 blanco). */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razón de contraste entre dos colores (de 1 a 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Razón de contraste entre dos colores CSS; `undefined` si alguno no se entiende. */
export function contrastOf(fg: string, bg: string): number | undefined {
  const a = parseColor(fg);
  const b = parseColor(bg);
  return a && b ? contrastRatio(a, b) : undefined;
}

const toHex = ({ r, g, b }: Rgb): string => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** Color `fg` con opacidad `alpha` sobre `bg` (lo que ve la persona cuando el relleno es translúcido). */
export function mezclar(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return { r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha) };
}

/**
 * Elige, entre una tinta oscura y una clara, la de mayor contraste con `fill`; si ninguna llega a 4,5:1 (un tono medio con tintas
 * que no son negro ni blanco puros), cae a negro o blanco, que siempre llegan. Con un color que no se entiende, la clara.
 */
export function tintaLegible(fill: string, oscura = '#0b1f33', clara = '#ffffff'): string {
  const bg = parseColor(fill);
  if (!bg) return clara;
  const dark = parseColor(oscura)!;
  const light = parseColor(clara)!;
  const best = contrastRatio(dark, bg) >= contrastRatio(light, bg) ? oscura : clara;
  if (contrastRatio(parseColor(best)!, bg) >= MIN_TEXTO) return best;
  return contrastRatio({ r: 0, g: 0, b: 0 }, bg) >= contrastRatio({ r: 255, g: 255, b: 255 }, bg) ? '#000000' : '#ffffff';
}

/**
 * Oscurece `color` (mezclándolo con negro, en pasos pequeños) hasta que llegue a `min` de contraste sobre `fondo`; conserva el tono.
 * Si el color ya cumple, lo devuelve igual. Sirve para el título de una zona, cuyo color lo da la notación o la persona.
 */
export function oscurecerHasta(color: string, fondo: string, min = MIN_TEXTO): string {
  const fg = parseColor(color);
  const bg = parseColor(fondo);
  if (!fg || !bg) return color;
  if (contrastRatio(fg, bg) >= min) return color;
  const black: Rgb = { r: 0, g: 0, b: 0 };
  for (let i = 1; i <= 20; i++) {
    const next = mezclar(black, i / 20, fg);
    if (contrastRatio(next, bg) >= min) return toHex(next);
  }
  return '#000000';
}
