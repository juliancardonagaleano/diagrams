import type { KeyboardEvent, MouseEvent } from 'react';

/**
 * Convierte en operable con teclado un elemento que ya respondía al clic (la cabecera de una tarjeta, una fila de la lista de problemas):
 * lo anuncia como botón, lo hace parada del tabulador y lo activa con Intro o Espacio (WCAG 2.1.1 y 4.1.2). Preferible, donde se pueda,
 * es un `<button>`; esto es para las filas cuyo interior no cabe en uno (contienen otros botones, p. ej. el «ojo» de una tarjeta).
 * `expandido` añade `aria-expanded` (cabeceras que despliegan) y `pulsado`, `aria-pressed`.
 */
export interface Accionable {
  role: 'button';
  tabIndex: 0;
  onClick(event: MouseEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  'aria-expanded'?: boolean;
  'aria-pressed'?: boolean;
}

export function accionable(activar: () => void, estado: { expandido?: boolean; pulsado?: boolean } = {}): Accionable {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: () => activar(),
    onKeyDown: (event) => {
      // Solo si el foco está en la propia fila: Intro o Espacio sobre un botón de su interior es de ese botón.
      if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activar();
      }
    },
    ...(estado.expandido !== undefined ? { 'aria-expanded': estado.expandido } : {}),
    ...(estado.pulsado !== undefined ? { 'aria-pressed': estado.pulsado } : {}),
  };
}
