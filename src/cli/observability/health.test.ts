import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { directoryWritable, fileReadable, Readiness } from './health';

const folders: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iark-health-'));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Readiness', () => {
  it('suma las comprobaciones: ok solo si todas pasan, y dice cuáles fallan', async () => {
    const ready = new Readiness({ a: () => true, b: async () => true }, { cacheMs: 0 });
    expect(await ready.status()).toEqual({ ok: true, checks: { a: 'ok', b: 'ok' } });
    const broken = new Readiness({ a: () => true, b: async () => false, c: () => { throw new Error('/ruta/secreta'); } }, { cacheMs: 0, warn: () => undefined });
    expect(await broken.status()).toEqual({ ok: false, checks: { a: 'ok', b: 'fail', c: 'fail' } });
    expect(await new Readiness({}, { cacheMs: 0 }).status()).toEqual({ ok: true, checks: {} });
  });

  it('cachea el resultado el plazo indicado y vuelve a comprobar pasado', async () => {
    let calls = 0;
    let now = 0;
    const ready = new Readiness({ a: () => ++calls > 0 }, { cacheMs: 5000, now: () => now });
    await ready.status();
    now = 4999;
    await ready.status();
    expect(calls).toBe(1);
    now = 5000;
    await ready.status();
    expect(calls).toBe(2);
  });

  it('muchas peticiones a la vez comparten una sola ronda de comprobaciones (no es un vector de carga)', async () => {
    let calls = 0;
    const ready = new Readiness({ a: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return true; } }, { cacheMs: 0 });
    const reports = await Promise.all(Array.from({ length: 50 }, () => ready.status()));
    expect(calls).toBe(1);
    expect(reports.every((r) => r.ok)).toBe(true);
  });

  it('una comprobación que se cuelga da fail al pasar el tiempo máximo, sin esperarla', async () => {
    const ready = new Readiness({ lenta: () => new Promise<boolean>(() => undefined), rapida: () => true }, { cacheMs: 0, timeoutMs: 30, warn: () => undefined });
    const started = Date.now();
    expect(await ready.status()).toEqual({ ok: false, checks: { lenta: 'fail', rapida: 'ok' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('avisa una vez cuando una comprobación pasa a fallar y otra cuando vuelve, con su nombre y sin detalles', async () => {
    const warnings: string[] = [];
    let healthy = true;
    const ready = new Readiness({ disco: () => healthy }, { cacheMs: 0, warn: (m) => warnings.push(m) });
    await ready.status();
    expect(warnings).toEqual([]);
    healthy = false;
    await ready.status();
    await ready.status();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('«disco»');
    healthy = true;
    await ready.status();
    await ready.status();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('vuelve a pasar');
  });
});

describe('directoryWritable', () => {
  it('crea y borra una sonda: true en una carpeta normal y no deja restos', async () => {
    const dir = temp();
    expect(await directoryWritable(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('false si la ruta es un archivo o su padre lo es; si la carpeta aún no existe, sondea la existente más cercana', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'archivo'), 'x');
    expect(await directoryWritable(join(dir, 'archivo'))).toBe(false);
    expect(await directoryWritable(join(dir, 'archivo', 'dentro'))).toBe(false);
    expect(await directoryWritable(join(dir, 'aun', 'no', 'existe'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['archivo']);
  });

  it('false si la sonda no se puede crear (la carpeta es de solo lectura para quien no es root)', async () => {
    if (process.getuid?.() === 0) return; // root escribe donde quiera: en ese caso la prueba de «archivo en lugar de carpeta» cubre el fallo
    const dir = temp();
    const sub = join(dir, 'solo-lectura');
    mkdirSync(sub, { mode: 0o500 });
    expect(await directoryWritable(sub)).toBe(false);
  });
});

describe('fileReadable', () => {
  it('true para un archivo normal que se lee; false para una carpeta o algo que no existe', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'cuentas.json'), '{}');
    expect(await fileReadable(join(dir, 'cuentas.json'))).toBe(true);
    expect(await fileReadable(dir)).toBe(false);
    expect(await fileReadable(join(dir, 'no-existe'))).toBe(false);
  });
});
