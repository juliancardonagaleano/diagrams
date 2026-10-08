import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { commandInfos, optionInfo, runCommand } from './operations';
import type { CommandSpec, DomainModule } from './types';

/**
 * `runCommand` con `remote: true` (lo que usa el servicio HTTP): las opciones y los argumentos marcados `local` (leen o escriben
 * en la máquina que ejecuta el comando) se rechazan sin ejecutar nada, con el mismo mensaje exista o no lo que se pide.
 */

function moduleWith(run: CommandSpec['run'], extra: Partial<CommandSpec> = {}): { module: DomainModule<{ n: number }>; calls: Array<Parameters<CommandSpec['run']>[0]> } {
  const calls: Array<Parameters<CommandSpec['run']>[0]> = [];
  const module: DomainModule<{ n: number }> = {
    id: 'demo',
    name: 'Demo',
    version: '1',
    documentVersion: '1',
    schema: z.object({ n: z.number() }),
    jsonSchema: () => ({}),
    validate: () => [],
    importers: [],
    exporters: [],
    cliCommands: [
      {
        name: 'lee',
        description: 'Lee un paquete de un archivo',
        args: [{ name: 'carpeta', description: 'carpeta de trabajo', local: true }, { name: 'etiqueta', description: 'texto libre' }],
        options: [
          { flags: '--pack <archivo>', description: 'archivo con el paquete', local: true },
          { flags: '--catalogo-local <ruta>', description: 'catálogo del disco, por omisión el de la casa', default: '/etc/catalogo', local: true },
          { flags: '-n, --nombre <nombre>', description: 'un nombre cualquiera' },
          { flags: '--fuerte', description: 'en mayúsculas', default: false },
        ],
        run: (context) => {
          calls.push(context);
          return run(context);
        },
        ...extra,
      },
    ],
  };
  return { module, calls };
}

describe('CommandOption.local', () => {
  it('se expone en la información de las opciones (para que una superficie remota no las ofrezca)', () => {
    const { module } = moduleWith(() => 'ok');
    const options = commandInfos(module)[0].options;
    expect(options.find((o) => o.key === 'pack')?.local).toBe(true);
    expect(options.find((o) => o.key === 'nombre')).not.toHaveProperty('local');
    expect(optionInfo({ flags: '--x', description: '' })).not.toHaveProperty('local');
  });
});

describe('runCommand en remoto', () => {
  it('rechaza una opción local sin ejecutar el comando, con el mismo mensaje sea cual sea el valor', async () => {
    const { module, calls } = moduleWith(() => 'ok');
    const messages = new Set<string>();
    for (const pack of ['/etc/hostname', '/no/existe/nunca.json', '../../x', 'C:\\Windows\\win.ini', true, 7, { a: 1 }]) {
      const error = await runCommand(module, 'lee', { options: { pack: pack as string } }, { remote: true }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      messages.add((error as Error).message);
    }
    expect(messages.size).toBe(1);
    const [message] = [...messages];
    expect(message).toContain('«--pack»');
    expect(message).toContain('solo está disponible en el CLI local');
    expect(message).not.toMatch(/etc|nunca|Windows/); // nada de lo que pidió vuelve en la respuesta
    expect(calls).toHaveLength(0);
  });

  it('antes que cualquier otra comprobación: no depende de si falta un argumento o la entrada', async () => {
    const { module } = moduleWith(() => 'ok', { input: { description: 'documento' }, args: [{ name: 'obligatorio', description: 'x', required: true }] });
    await expect(runCommand(module, 'lee', { options: { pack: '/x' } }, { remote: true })).rejects.toThrow(/solo está disponible en el CLI local/);
  });

  it('rechaza también un argumento posicional local, y una opción local con un valor por omisión no lo rellena', async () => {
    const { module, calls } = moduleWith(() => 'ok');
    await expect(runCommand(module, 'lee', { args: ['/srv/datos'] }, { remote: true })).rejects.toThrow(/El argumento «carpeta» de «lee» solo está disponible en el CLI local/);
    expect(calls).toHaveLength(0);
    const out = await runCommand(module, 'lee', { args: [' ', 'etiqueta'] }, { remote: true });
    expect(out.output).toBe('ok');
    expect(calls[0].options).toEqual({ fuerte: false }); // sin `catalogoLocal: '/etc/catalogo'`
  });

  it('lo que no es local sigue funcionando igual en remoto, y las opciones vacías o en falso no cuentan', async () => {
    const { module, calls } = moduleWith(() => 'listo');
    const result = await runCommand(module, 'lee', { args: ['', 'ana'], options: { nombre: 'Ana', fuerte: true, pack: '', catalogoLocal: undefined } }, { remote: true });
    expect(result).toEqual({ command: 'lee', kind: 'report', output: 'listo', warnings: [] });
    expect(calls[0].options).toEqual({ nombre: 'Ana', fuerte: true });
    // una clave que el comando no declara se ignora, no llega al comando
    await runCommand(module, 'lee', { options: { otra: '/etc/passwd', 'pack ': '/etc/passwd' } as never }, { remote: true });
    expect(calls[1].options).toEqual({ fuerte: false });
  });

  it('en local (por omisión) todo se acepta, con el valor por omisión incluido', async () => {
    const { module, calls } = moduleWith(() => 'ok');
    await runCommand(module, 'lee', { args: ['/srv/datos'], options: { pack: '/tmp/paquete.json' } });
    expect(calls[0].options).toEqual({ pack: '/tmp/paquete.json', catalogoLocal: '/etc/catalogo', fuerte: false });
    expect(calls[0].args).toEqual(['/srv/datos']);
    await runCommand(module, 'lee', { options: { pack: '/tmp/paquete.json' } }, { remote: false });
    expect(calls).toHaveLength(2);
  });
});
