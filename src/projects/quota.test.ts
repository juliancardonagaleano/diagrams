import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '@iark/kernel';
import { accountLevel, bytesFromMb, draftOf, formatBytes, isUnlimited, levelOf, percentOf, quotaChangeOf, quotaLines, quotaWarning } from './quota';

const usage = (over: Partial<AccountUsage['usage']> = {}, limits: Partial<AccountUsage['limits']> = {}): AccountUsage => ({
  limits: { bytes: 1000, projects: 5, diagramsPerProject: 10, ...limits },
  usage: { bytes: 0, documentBytes: 0, versionBytes: 0, versions: 0, projects: 0, ...over },
  projects: [],
});

describe('quota (interfaz)', () => {
  it('formatBytes escribe como el servicio: de 1024 en 1024 y con coma decimal', () => {
    expect([0, 1023, 1024, 1536, 100 * 1024 * 1024, -4, Number.NaN].map(formatBytes)).toEqual(['0 B', '1023 B', '1 KB', '1,5 KB', '100 MB', '0 B', '0 B']);
  });

  it('levelOf: sin tope, de sobra, cerca desde el 80 % y lleno al llegar; percentOf redondea hacia abajo', () => {
    expect([levelOf(5, 0), levelOf(79, 100), levelOf(80, 100), levelOf(99, 100), levelOf(100, 100), levelOf(120, 100)]).toEqual(['unlimited', 'ok', 'near', 'near', 'full', 'full']);
    expect([percentOf(5, 0), percentOf(999, 1000), percentOf(1000, 1000), percentOf(5000, 1000)]).toEqual([undefined, 99, 100, 100]);
  });

  it('quotaLines: espacio y proyectos, y los diagramas solo si se da el proyecto; sin tope lo dice', () => {
    const lines = quotaLines(usage({ bytes: 250, projects: 2 }), { id: 'p', name: 'Tienda', diagrams: 3 });
    expect(lines.map((l) => [l.kind, l.label, l.text, l.level])).toEqual([
      ['bytes', 'Espacio', '250 B de 1000 B', 'ok'],
      ['projects', 'Proyectos', '2 de 5', 'ok'],
      ['diagrams', 'Diagramas de «Tienda»', '3 de 10', 'ok'],
    ]);
    expect(quotaLines(usage({}, { bytes: 0 })).map((l) => l.text)[0]).toBe('0 B (sin tope)');
    expect(quotaLines(usage()).length).toBe(2);
  });

  it('quotaWarning: nada mientras sobra, «te acercas» desde el 80 % y «se alcanzó» al llegar (lo lleno manda)', () => {
    expect(quotaWarning(quotaLines(usage({ bytes: 790 })))).toBeUndefined();
    expect(quotaWarning(quotaLines(usage({ bytes: 800 })))).toMatchObject({ level: 'near', text: expect.stringContaining('Te acercas al tope del espacio (800 B de 1000 B)') });
    const full = quotaWarning(quotaLines(usage({ bytes: 800, projects: 5 })));
    expect(full).toMatchObject({ level: 'full', text: expect.stringContaining('Se alcanzó el tope de los proyectos (5 de 5)') });
    expect(full?.text).not.toContain('del espacio');
  });

  it('draftOf y quotaChangeOf: el borrador refleja la cuota personal y vuelve a convertirse en el cambio exacto (MB ↔ bytes, null, 0)', () => {
    const limits = { bytes: 256 * 1024 * 1024, projects: 25, diagramsPerProject: 200 };
    expect(draftOf(undefined, limits)).toEqual({ bytes: { mode: 'instance', amount: '256' }, projects: { mode: 'instance', amount: '25' }, diagramsPerProject: { mode: 'instance', amount: '200' } });
    const own = draftOf({ bytes: 1.5 * 1024 * 1024, projects: 0 }, { bytes: 1.5 * 1024 * 1024, projects: 0, diagramsPerProject: 200 });
    expect(own).toMatchObject({ bytes: { mode: 'custom', amount: '1.5' }, projects: { mode: 'none' }, diagramsPerProject: { mode: 'instance' } });
    expect(quotaChangeOf(own)).toEqual({ change: { bytes: 1.5 * 1024 * 1024, projects: 0, diagramsPerProject: null } });
    expect(bytesFromMb(2)).toBe(2097152);
  });

  it('quotaChangeOf rechaza lo que el servidor rechazaría y dice cuál es el campo', () => {
    const base = draftOf(undefined, undefined);
    for (const amount of ['', '0', '-3', 'mucho', '2.5']) {
      expect(quotaChangeOf({ ...base, projects: { mode: 'custom', amount } }), amount).toMatchObject({ field: 'projects', error: expect.stringContaining('los proyectos') });
    }
    expect(quotaChangeOf({ ...base, bytes: { mode: 'custom', amount: '0,5' } })).toEqual({ change: { bytes: 524288, projects: null, diagramsPerProject: null } });
    expect(quotaChangeOf({ ...base, bytes: { mode: 'custom', amount: '' } })).toMatchObject({ field: 'bytes', error: expect.stringContaining('en MB') });
  });

  it('accountLevel toma el peor entre espacio y proyectos; isUnlimited', () => {
    const limits = { bytes: 100, projects: 2, diagramsPerProject: 0 };
    const u = { bytes: 10, documentBytes: 10, versionBytes: 0, versions: 0, projects: 2 };
    expect(accountLevel(u, limits)).toBe('full');
    expect(accountLevel({ ...u, projects: 0 }, limits)).toBe('ok');
    expect(accountLevel(undefined, limits)).toBe('unlimited');
    expect(isUnlimited({ bytes: 0, projects: 0, diagramsPerProject: 0 })).toBe(true);
    expect(isUnlimited(limits)).toBe(false);
  });
});
