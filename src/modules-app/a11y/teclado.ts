import type { AriaLabelConfig } from '@xyflow/react';

/**
 * Navegación con teclado por el lienzo (WCAG 2.1.1 y 2.1.2): moverse de un elemento a otro con las flechas, según dónde estén dibujados,
 * y los textos en español que React Flow lee a los lectores de pantalla (por omisión están en inglés).
 */
export type Direccion = 'left' | 'right' | 'up' | 'down';

export interface Caja {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const DIRECCION_DE_TECLA: Record<string, Direccion | undefined> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** Dirección que significa una tecla de flecha, o `undefined` si no lo es. */
export const direccionDe = (key: string): Direccion | undefined => DIRECCION_DE_TECLA[key];

const centro = (c: Caja): { x: number; y: number } => ({ x: c.x + c.width / 2, y: c.y + c.height / 2 });
const contiene = (a: Caja, b: Caja): boolean => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;

/**
 * Elemento al que lleva pulsar una flecha desde `desde`: el más cercano en esa dirección dentro de un cono de 45°, dando más peso a lo que está
 * alineado que a lo que está en diagonal; si el cono está vacío, el más cercano fuera de él. Una zona que contiene al elemento de partida no cuenta (no se «sube» a su zona con una flecha: eso es
 * Escape o el panel de propiedades). Si nada queda en esa dirección, devuelve `undefined` y el foco se queda donde estaba.
 */
export function vecinoEnDireccion(cajas: readonly Caja[], desde: string, direccion: Direccion): string | undefined {
  const origen = cajas.find((c) => c.id === desde);
  if (!origen) return undefined;
  const c0 = centro(origen);
  let mejor: { id: string; puntos: number; enCono: boolean } | undefined;
  for (const caja of cajas) {
    if (caja.id === desde || contiene(caja, origen)) continue;
    const c = centro(caja);
    const dx = c.x - c0.x;
    const dy = c.y - c0.y;
    const avance = direccion === 'right' ? dx : direccion === 'left' ? -dx : direccion === 'down' ? dy : -dy;
    const lateral = Math.abs(direccion === 'left' || direccion === 'right' ? dy : dx);
    if (avance <= 0) continue;
    // Dentro de un cono de 45° a cada lado de la flecha gana siempre algo del cono; fuera de él solo se llega si no hay nada dentro.
    const enCono = lateral <= avance;
    // El castigo lateral pesa el doble: a igual distancia, gana lo más alineado.
    const puntos = avance * avance + 4 * lateral * lateral;
    if (!mejor || (enCono && !mejor.enCono) || (enCono === mejor.enCono && puntos < mejor.puntos)) mejor = { id: caja.id, puntos, enCono };
  }
  return mejor?.id;
}

/** Mueve una posición `paso` píxeles en `direccion`. */
export function desplazar(posicion: { x: number; y: number }, direccion: Direccion, paso: number): { x: number; y: number } {
  return {
    x: posicion.x + (direccion === 'right' ? paso : direccion === 'left' ? -paso : 0),
    y: posicion.y + (direccion === 'down' ? paso : direccion === 'up' ? -paso : 0),
  };
}

const NOMBRE_DIRECCION: Record<string, string> = { ArrowUp: 'arriba', ArrowDown: 'abajo', ArrowLeft: 'a la izquierda', ArrowRight: 'a la derecha' };

/** Textos de React Flow en español: descripciones de los nodos y relaciones, aviso al moverlos y nombres de los controles. */
export const ETIQUETAS_LIENZO: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default':
    'Intro, F2 o Espacio: seleccionar y abrir las propiedades. Flechas: ir al elemento vecino. Mayús más flechas: mover el elemento. Supr: borrar. Escape: quitar la selección.',
  'node.a11yDescription.keyboardDisabled':
    'Intro, F2 o Espacio: seleccionar y abrir las propiedades. Flechas: ir al elemento vecino. Mayús más flechas: mover el elemento. Supr: borrar. Escape: quitar la selección.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => `Elemento movido ${NOMBRE_DIRECCION[direction] ?? direction}. Nueva posición, x: ${Math.round(x)}, y: ${Math.round(y)}`,
  'edge.a11yDescription.default': 'Intro o Espacio: seleccionar la relación y abrir sus propiedades. Supr: borrarla. Escape: quitar la selección.',
  'controls.ariaLabel': 'Controles del lienzo',
  'controls.zoomIn.ariaLabel': 'Acercar',
  'controls.zoomOut.ariaLabel': 'Alejar',
  'controls.fitView.ariaLabel': 'Ajustar a la ventana',
  'controls.interactive.ariaLabel': 'Activar o desactivar la interacción',
  'minimap.ariaLabel': 'Minimapa del diagrama',
  'handle.ariaLabel': 'Punto de conexión',
};
