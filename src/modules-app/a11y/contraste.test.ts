import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastOf, MIN_COMPONENTE, MIN_TEXTO, mezclar, oscurecerHasta, parseColor, tintaLegible, contrastRatio } from './contraste';

/**
 * Medida de contraste (WCAG 1.4.3 y 1.4.11) de los pares de color de Mesa (`src/theme/mesa.css`), el cromo de la suite.
 * Cada par es «tinta sobre fondo» con el mínimo que le toca: 4,5:1 si es texto, 3:1 si es un componente de interfaz.
 * Si añades un color a un tema, añade aquí su par: la prueba falla antes de que lo vea una persona con baja visión.
 */
const css = readFileSync('src/theme/mesa.css', 'utf8');

function reglas(): Array<{ selectors: string[]; body: string }> {
  const sinNotas = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...sinNotas.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    body: m[2],
  }));
}

function varsDe(selector: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const regla of reglas()) {
    if (!regla.selectors.includes(selector)) continue;
    for (const m of regla.body.matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  }
  return vars;
}

function resuelto(vars: Record<string, string>): Record<string, string> {
  const ver = (nombre: string, visto = new Set<string>()): string => {
    if (visto.has(nombre)) return '';
    visto.add(nombre);
    const raw = vars[nombre] ?? '';
    const alias = /^var\(--([\w-]+)\)$/.exec(raw);
    return alias ? ver(alias[1], visto) : raw;
  };
  return Object.fromEntries(Object.keys(vars).map((nombre) => [nombre, ver(nombre)]));
}

function mapaWb(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [nombre, valor] of Object.entries(resuelto(vars))) {
    if (nombre.startsWith('wb-')) out[nombre.slice(3)] = valor;
  }
  return out;
}

const claro = mapaWb(varsDe(':root'));
const oscuro = mapaWb({ ...varsDe(':root'), ...varsDe(":root[data-theme='dark']") });
const TEMAS = { claro, oscuro } as const;

/** [tinta, fondo, mínimo, qué se mide]. Un nombre es una variable `--wb-*`; lo que empieza por `#` es un color literal. */
const PARES: Array<[string, string, number, string]> = [
  ['text', 'bg', MIN_TEXTO, 'texto sobre el fondo de la página'],
  ['text', 'surface', MIN_TEXTO, 'texto sobre las superficies'],
  ['text', 'surface-2', MIN_TEXTO, 'texto sobre superficies secundarias'],
  ['text', 'info-bg', MIN_TEXTO, 'texto sobre avisos informativos y filas resaltadas'],
  ['text', 'warning-bg', MIN_TEXTO, 'texto sobre avisos de advertencia'],
  ['text-2', 'bg', MIN_TEXTO, 'texto secundario sobre el fondo'],
  ['text-2', 'surface', MIN_TEXTO, 'texto secundario sobre superficies'],
  ['text-2', 'surface-2', MIN_TEXTO, 'texto secundario sobre superficies secundarias'],
  ['text-2', 'info-bg', MIN_TEXTO, 'texto secundario sobre filas resaltadas'],
  ['primary-ink', 'surface', MIN_TEXTO, 'enlaces y pestaña activa sobre superficies'],
  ['primary-ink', 'bg', MIN_TEXTO, 'enlaces sobre el fondo de la página'],
  ['primary-ink', 'surface-2', MIN_TEXTO, 'enlaces sobre superficies secundarias'],
  ['primary-ink', 'info-bg', MIN_TEXTO, 'enlaces sobre filas resaltadas'],
  ['primary-text', 'primary', MIN_TEXTO, 'texto de los botones principales y del módulo activo'],
  ['primary-text', 'primary-hover', MIN_TEXTO, 'texto de los botones principales al pasar el ratón'],
  ['error', 'surface', MIN_TEXTO, 'errores sobre superficies'],
  ['error', 'error-bg', MIN_TEXTO, 'etiqueta de error'],
  ['warning', 'surface', MIN_TEXTO, 'advertencias sobre superficies'],
  ['warning', 'warning-bg', MIN_TEXTO, 'etiqueta y aviso de advertencia'],
  ['info', 'info-bg', MIN_TEXTO, 'etiqueta informativa'],
  ['ok', 'info-bg', MIN_TEXTO, 'etiqueta «Válido»'],
  ['ok', 'surface', MIN_TEXTO, 'confirmaciones sobre superficies'],
  ['#ffffff', 'ok-solid', MIN_TEXTO, 'signo «+» de lo añadido al comparar'],
  ['#ffffff', 'error-solid', MIN_TEXTO, 'signo «−» de lo quitado al comparar'],
  ['#ffffff', 'warning-solid', MIN_TEXTO, 'signo «~» de lo modificado al comparar'],
  ['muted', 'surface', MIN_TEXTO, 'texto atenuado (`--wb-muted`)'],
  // Componentes de interfaz (1.4.11): lo que permite ver dónde está un control y cuál tiene el foco.
  ['focus', 'surface', MIN_COMPONENTE, 'anillo de foco sobre superficies'],
  ['focus', 'bg', MIN_COMPONENTE, 'anillo de foco sobre el fondo'],
  ['focus', 'surface-2', MIN_COMPONENTE, 'anillo de foco sobre superficies secundarias'],
  ['focus', 'info-bg', MIN_COMPONENTE, 'anillo de foco sobre filas resaltadas'],
  ['control-border', 'surface', MIN_COMPONENTE, 'borde de los campos de texto y selectores sobre superficies'],
  ['control-border', 'bg', MIN_COMPONENTE, 'borde de los campos sobre el fondo'],
  ['control-border', 'surface-2', MIN_COMPONENTE, 'borde de los campos sobre superficies secundarias'],
  ['primary-ink', 'surface', MIN_COMPONENTE, 'subrayado de la pestaña activa'],
];

const valor = (tema: Record<string, string>, nombre: string): string => (nombre.startsWith('#') ? nombre : (tema[nombre] ?? ''));

describe('contraste de los temas del banco de trabajo (WCAG 2.2 AA)', () => {
  for (const [nombreTema, tema] of Object.entries(TEMAS)) {
    describe(`tema ${nombreTema}`, () => {
      it.each(PARES)('%s sobre %s ≥ %s:1 (%s)', (tinta, fondo, minimo, queEs) => {
        const t = valor(tema, tinta);
        const f = valor(tema, fondo);
        expect(parseColor(t), `${tinta} (${t}) no es un color que se pueda medir`).toBeDefined();
        expect(parseColor(f), `${fondo} (${f}) no es un color que se pueda medir`).toBeDefined();
        const razon = contrastOf(t, f)!;
        expect(razon, `${queEs}: ${tinta} ${t} sobre ${fondo} ${f} da ${razon.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimo);
      });
    });
  }

  it('el mapa de calor de la trazabilidad conserva el contraste de su texto (lo cuida trace.css)', () => {
    const trace = readFileSync('src/trace-app/trace.css', 'utf8');
    const pares = [...trace.matchAll(/background:\s*(#[0-9a-f]{6});\s*color:\s*(#[0-9a-f]{6});/gi)].map((m) => [m[2], m[1]] as const);
    expect(pares.length).toBeGreaterThanOrEqual(4);
    for (const [tinta, fondo] of pares) expect(contrastOf(tinta, fondo), `${tinta} sobre ${fondo}`).toBeGreaterThanOrEqual(MIN_TEXTO);
  });
});

/**
 * Editor clásico: las tintas de cromo (`--c4-text-muted`, `--c4-danger-text`, `--c4-primary-text`, `--c4-focus`) salen de Mesa
 * y se miden contra las superficies de Semi UI que de verdad las llevan debajo. Los fondos son los que midió axe: la página
 * (#fff / #16161a), los botones y menús claros u oscuros (#f5f5f5, #e8e8e8; #43444a, #48494e, #4d4e53).
 */
function mapaC4(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [nombre, valor] of Object.entries(resuelto(vars))) {
    if (nombre.startsWith('c4-')) out[nombre.slice(3)] = valor;
    else out[nombre] = valor;
  }
  return out;
}

const clasicoClaro = mapaC4(varsDe(':root'));
const clasicoOscuro = mapaC4({ ...varsDe(':root'), ...varsDe("body[theme-mode='dark']") });

const PARES_CLASICOS: Array<[string, string[], string[], number, string]> = [
  // [variable, fondos en tema claro, fondos en tema oscuro, mínimo, qué se mide]
  ['text-muted', ['#ffffff', '#f5f5f5', '#e8e8e8'], ['#16161a', '#43444a', '#4d4e53'], MIN_TEXTO, 'texto atenuado de las fichas, atajos de los menús y ayudas'],
  ['danger-text', ['#f5f5f5', '#e8e8e8', '#ffffff'], ['#43444a', '#4d4e53'], MIN_TEXTO, 'texto de los botones de peligro (Eliminar)'],
  ['primary-text', ['#f5f5f5', '#e8e8e8', '#ffffff'], ['#3d3e43', '#43444a', '#48494e'], MIN_TEXTO, 'texto de los botones primarios claros (Autolayout)'],
  ['focus', ['#ffffff', '#f5f5f5'], ['#16161a', '#27272a'], MIN_COMPONENTE, 'anillo de foco'],
];

describe('contraste de los temas del editor clásico (WCAG 2.2 AA)', () => {
  for (const [nombreTema, tema, indice] of [
    ['claro', clasicoClaro, 1],
    ['oscuro', clasicoOscuro, 2],
  ] as const) {
    describe(`tema ${nombreTema}`, () => {
      for (const par of PARES_CLASICOS) {
        const [variable, , , minimo, queEs] = par;
        const fondos = par[indice];
        it.each(fondos)(`--c4-${variable} sobre %s ≥ ${minimo}:1 (${queEs})`, (fondo) => {
          const tinta = tema[variable];
          expect(parseColor(tinta ?? ''), `--c4-${variable} (${tinta}) no es un color que se pueda medir`).toBeDefined();
          const razon = contrastOf(tinta, fondo)!;
          expect(razon, `${queEs}: ${tinta} sobre ${fondo} da ${razon.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimo);
        });
      }
    });
  }

  it('el relleno primario del tema oscuro aguanta el texto blanco de los botones sólidos', () => {
    const primario = clasicoOscuro['mesa-accent'];
    expect(primario).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastOf('#ffffff', primario)!).toBeGreaterThanOrEqual(MIN_TEXTO);
  });
});

describe('utilidades de contraste', () => {
  it('reproduce los valores de referencia de WCAG', () => {
    expect(contrastOf('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastOf('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Gris #767676 sobre blanco: el mínimo clásico que llega a 4,5:1.
    expect(contrastOf('#767676', '#ffffff')!).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf('#777777', '#ffffff')!).toBeLessThan(4.5);
  });

  it('entiende #rgb, #rrggbb y rgb()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#1168bd')).toEqual({ r: 17, g: 104, b: 189 });
    expect(parseColor('rgb(239, 68, 68)')).toEqual({ r: 239, g: 68, b: 68 });
    expect(parseColor('azul')).toBeUndefined();
  });

  it('la tinta legible elige la de mayor contraste, también en los tonos medios donde un umbral de brillo se equivoca', () => {
    expect(tintaLegible('#ffffff')).toBe('#0b1f33');
    expect(tintaLegible('#0b1f33')).toBe('#ffffff');
    for (const fill of ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#14b8a6', '#6b7280', '#1168bd', '#85bbf0', '#999999']) {
      expect(contrastOf(tintaLegible(fill), fill), fill).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('oscurecer un color hasta el contraste pedido conserva el tono y no toca lo que ya cumple', () => {
    const fondo = '#fde5e5';
    expect(oscurecerHasta('#7f1d1d', fondo)).toBe('#7f1d1d');
    const rojo = oscurecerHasta('#ef4444', fondo);
    expect(contrastOf(rojo, fondo)!).toBeGreaterThanOrEqual(4.5);
    const { r, g, b } = parseColor(rojo)!;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(oscurecerHasta('no-es-color', fondo)).toBe('no-es-color');
  });

  it('mezclar un relleno translúcido da el color que ve la persona', () => {
    const mezcla = mezclar({ r: 0, g: 0, b: 0 }, 0.5, { r: 255, g: 255, b: 255 });
    expect(mezcla.r).toBeCloseTo(127.5, 5);
    expect(contrastRatio(mezcla, { r: 255, g: 255, b: 255 })).toBeGreaterThan(3.9);
  });
});
