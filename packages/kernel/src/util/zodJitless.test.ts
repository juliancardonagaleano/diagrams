import { afterEach, describe, expect, it, vi } from 'vitest';

/** La configuración global de zod, leída después de importar `zodJitless` (con la misma copia de zod que usa él). */
async function jitlessAfterImport(): Promise<boolean | undefined> {
  vi.resetModules();
  await import('./zodJitless');
  const { z } = await import('zod');
  return z.config().jitless;
}

describe('zodJitless', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    (await import('zod')).z.config({ jitless: false });
  });

  it('en Node (CLI, servicio) no toca la configuración de zod: allí no hay CSP y el JIT sigue como siempre', async () => {
    expect(await jitlessAfterImport()).not.toBe(true);
  });

  it('en un navegador (hay `window`) desactiva el JIT, para que zod no sondee `new Function` bajo una CSP sin unsafe-eval', async () => {
    vi.stubGlobal('window', {});
    expect(await jitlessAfterImport()).toBe(true);
  });

  it('con el JIT desactivado zod valida igual, y no sondea `new Function`', async () => {
    vi.stubGlobal('window', {});
    await jitlessAfterImport();
    const { z } = await import('zod');
    const nativeFunction = globalThis.Function;
    const probes: unknown[] = [];
    // Un intento de compilar código con `Function` (lo que hace el sondeo JIT de zod) quedaría anotado aquí.
    globalThis.Function = new Proxy(nativeFunction, { construct: (target, args) => (probes.push(args), Reflect.construct(target, args)) }) as FunctionConstructor;
    try {
      const schema = z.object({ id: z.string(), size: z.number().int() });
      expect(schema.safeParse({ id: 'a', size: 3 }).success).toBe(true);
      expect(schema.safeParse({ id: 'a', size: 'x' }).success).toBe(false);
    } finally {
      globalThis.Function = nativeFunction;
    }
    expect(probes).toEqual([]);
  });
});
