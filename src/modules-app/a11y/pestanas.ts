/**
 * Teclado de una lista de pestañas (`role="tablist"`) según el patrón de WAI-ARIA: flechas izquierda y derecha pasan a la pestaña vecina
 * (dando la vuelta), Inicio y Fin van a la primera y la última, y la pestaña a la que se llega se activa. Solo la pestaña activa es
 * parada del tabulador (`tabIndex` 0; las demás -1), así que cruzar la lista cuesta una pulsación de Tab y no una por pestaña.
 */
interface TeclaLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  preventDefault(): void;
}

/** Pestaña a la que lleva una tecla, dado el orden actual: `undefined` si la tecla no es de navegación. */
export function pestanaDestino(key: string, actual: number, total: number): number | undefined {
  if (total === 0) return undefined;
  if (key === 'ArrowRight') return (actual + 1) % total;
  if (key === 'ArrowLeft') return (actual - 1 + total) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return undefined;
}

/** Manejador `onKeyDown` de la lista de pestañas: mueve el foco a la pestaña de destino y la activa pulsándola. */
export function teclasDePestanas(e: TeclaLike): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const list = e.currentTarget as HTMLElement | null;
  const from = (e.target as HTMLElement | null)?.closest<HTMLElement>('[role="tab"]');
  if (!list || !from) return;
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((tab) => !(tab as HTMLButtonElement).disabled);
  const to = pestanaDestino(e.key, tabs.indexOf(from), tabs.length);
  if (to === undefined) return;
  e.preventDefault();
  tabs[to].focus();
  tabs[to].click();
}

/** `tabIndex` de una pestaña: 0 la activa (o la primera si ninguna lo está), -1 las demás. */
export const tabIndexDePestana = (selected: boolean, ningunaActiva: boolean, primera: boolean): 0 | -1 => (selected || (ningunaActiva && primera) ? 0 : -1);
