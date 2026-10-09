import { describe, expect, it } from 'vitest';
import { desplazar, direccionDe, ETIQUETAS_LIENZO, vecinoEnDireccion, type Caja } from './teclado';

/**
 * Disposición (cada caja de 100 × 50):
 *
 *   zona: marco que contiene a «a» y «b»
 *   a(0,0)   b(200,0)   c(400,0)
 *   d(0,150)            e(400,150)
 */
const caja = (id: string, x: number, y: number, width = 100, height = 50): Caja => ({ id, x, y, width, height });
const CAJAS: Caja[] = [caja('zona', -20, -20, 340, 100), caja('a', 0, 0), caja('b', 200, 0), caja('c', 400, 0), caja('d', 0, 150), caja('e', 400, 150)];

describe('vecinoEnDireccion', () => {
  it('va al elemento más cercano en la dirección de la flecha', () => {
    expect(vecinoEnDireccion(CAJAS, 'a', 'right')).toBe('b');
    expect(vecinoEnDireccion(CAJAS, 'b', 'right')).toBe('c');
    expect(vecinoEnDireccion(CAJAS, 'c', 'left')).toBe('b');
    expect(vecinoEnDireccion(CAJAS, 'a', 'down')).toBe('d');
    expect(vecinoEnDireccion(CAJAS, 'e', 'up')).toBe('c');
  });

  it('prefiere lo alineado a lo que está en diagonal, y lo que está en el cono de la flecha a lo que queda fuera de él', () => {
    // Desde «b»: «d» queda abajo a la izquierda y «e» abajo a la derecha, más lejos; hacia abajo gana el menos desviado.
    expect(vecinoEnDireccion(CAJAS, 'b', 'down')).toBe('d');
    // Desde «d», la zona queda arriba a la derecha, más arriba que a la derecha (fuera del cono de «derecha»): gana «b», que está dentro y más cerca que «e».
    expect(vecinoEnDireccion(CAJAS, 'd', 'right')).toBe('b');
    expect(vecinoEnDireccion(CAJAS, 'b', 'down')).not.toBe('zona');
  });

  it('no sube a la zona que contiene al elemento de partida', () => {
    expect(vecinoEnDireccion(CAJAS, 'a', 'up')).toBeUndefined();
    expect(vecinoEnDireccion(CAJAS, 'a', 'left')).toBeUndefined();
  });

  it('si no hay nada en esa dirección, o el origen no existe, no se mueve el foco', () => {
    expect(vecinoEnDireccion(CAJAS, 'c', 'right')).toBeUndefined();
    expect(vecinoEnDireccion(CAJAS, 'fantasma', 'right')).toBeUndefined();
    expect(vecinoEnDireccion([], 'a', 'right')).toBeUndefined();
  });

  it('alcanza todos los elementos desde cualquiera con alguna secuencia de flechas', () => {
    const alcanzados = new Set<string>(['a']);
    const pendientes = ['a'];
    while (pendientes.length > 0) {
      const desde = pendientes.pop()!;
      for (const d of ['left', 'right', 'up', 'down'] as const) {
        const siguiente = vecinoEnDireccion(CAJAS, desde, d);
        if (siguiente && !alcanzados.has(siguiente)) {
          alcanzados.add(siguiente);
          pendientes.push(siguiente);
        }
      }
    }
    // La zona se alcanza con el tabulador: las flechas llevan entre elementos, no a la zona que los contiene.
    expect([...alcanzados].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('direccionDe y desplazar', () => {
  it('traduce las flechas y desplaza una posición en pasos', () => {
    expect(direccionDe('ArrowLeft')).toBe('left');
    expect(direccionDe('ArrowDown')).toBe('down');
    expect(direccionDe('a')).toBeUndefined();
    expect(desplazar({ x: 10, y: 10 }, 'right', 12)).toEqual({ x: 22, y: 10 });
    expect(desplazar({ x: 10, y: 10 }, 'up', 12)).toEqual({ x: 10, y: -2 });
  });
});

describe('textos del lienzo en español', () => {
  it('describe las teclas del lienzo y avisa del movimiento con la nueva posición', () => {
    expect(ETIQUETAS_LIENZO['node.a11yDescription.default']).toContain('Mayús más flechas: mover');
    const aviso = ETIQUETAS_LIENZO['node.a11yDescription.ariaLiveMessage'] as (p: { direction: string; x: number; y: number }) => string;
    expect(aviso({ direction: 'ArrowRight', x: 120.4, y: 60 })).toBe('Elemento movido a la derecha. Nueva posición, x: 120, y: 60');
    expect(ETIQUETAS_LIENZO['controls.zoomIn.ariaLabel']).toBe('Acercar');
  });
});
