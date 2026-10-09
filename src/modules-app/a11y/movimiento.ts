/**
 * Movimiento reducido (WCAG 2.3.3, «Animación a partir de interacciones»): quien lo pide en su sistema operativo no ve animaciones que
 * no sean esenciales. Las de CSS las apaga una regla `@media (prefers-reduced-motion: reduce)`; las que dirige el código (los
 * encuadres de la cámara del lienzo) pasan por `duracion`.
 */
export function prefiereMenosMovimiento(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Duración en milisegundos de una animación: 0 si la persona pidió menos movimiento. */
export const duracion = (ms: number): number => (prefiereMenosMovimiento() ? 0 : ms);
