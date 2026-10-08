import type { CommandSpec } from '@iark/kernel';
import { PlatformImportError } from '../import/fromMermaid';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import { RESOURCE_LABELS, SERVICE_LABELS, serviceKindOf } from '../types';
import { subjectOfNetwork, subjectOfResource, subjectOfService } from './index';
import { IconPackError, iconCatalog, parseIconPack, resolveIcon, type IconSubject } from './registry';
import type { IconPack } from './types';

/** Lee un archivo de texto. El módulo también se empaqueta para el navegador, así que `node:fs` se carga solo al ejecutar el comando. */
async function readTextFile(path: string): Promise<string> {
  const specifier = 'node:fs/promises';
  try {
    const fs = (await import(/* @vite-ignore */ specifier)) as { readFile(path: string, encoding: 'utf8'): Promise<string> };
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    throw new PlatformImportError(`No se pudo leer el paquete de iconos «${path}»: ${(error as Error).message}`);
  }
}

export const iconCommands: CommandSpec[] = [
  {
    name: 'icons',
    description:
      'Paquetes de iconos de proveedores de nube (AWS y Azure incluidos, los de workspace.iconPacks y el de --pack) y el icono que se dibuja para cada recurso, servicio o red que indica un proveedor; valida un paquete propio',
    input: { description: 'documento de plataforma en JSON' },
    // `local`: lee un archivo de la máquina que ejecuta el comando, así que el servicio HTTP (`runCommand` con `remote`) lo rechaza.
    options: [{ flags: '--pack <archivo>', description: 'paquete de iconos propio en JSON: se valida y se suma a los del documento (solo en el CLI local)', local: true }],
    run: async ({ input, options }) => {
      if (!input) throw new PlatformImportError('Falta la entrada: indica un archivo JSON o usa --stdin (documento de plataforma).');
      let parsed: unknown;
      try {
        parsed = JSON.parse(input);
      } catch (error) {
        throw new PlatformImportError(`La entrada no es JSON válido: ${(error as Error).message}`);
      }
      const result = validatePlatformDocument(parsed);
      if (!result.ok) throw new PlatformImportError(`Documento de plataforma inválido:\n${formatPlatformIssues(result.issues)}`);
      const doc = result.document;

      const extra: IconPack[] = [];
      if (typeof options.pack === 'string' && options.pack) {
        try {
          extra.push(parseIconPack(await readTextFile(options.pack)));
        } catch (error) {
          if (error instanceof IconPackError) throw new PlatformImportError(`${options.pack}: ${error.message}`);
          throw error;
        }
      }
      const catalog = iconCatalog(doc, extra);
      const out = ['Paquetes de iconos', ''];
      for (const p of catalog.providers) {
        const services = Object.keys(p.icons);
        out.push(`- ${p.provider} · ${p.name} (acento ${p.color}): ${services.length} servicios [paquetes: ${p.packIds.join(', ')}]`, `  ${services.join(', ')}`);
      }
      if (extra.length > 0) out.push('', `Paquete ${extra[0].id} (${options.pack as string}): válido, ${Object.keys(extra[0].icons).length} servicios.`);

      const rows: string[] = [];
      const row = (label: string, subject: IconSubject): void => {
        if (!subject.provider) return;
        const icon = resolveIcon(catalog, subject);
        rows.push(`- ${label}: ${icon ? `${icon.provider} · ${icon.service} (${icon.label})${icon.suggested ? ' · sugerido por su clase y tecnología' : ''}` : `proveedor «${subject.provider}»${subject.service ? `, servicio «${subject.service}»` : ''}: sin icono`}`);
      };
      for (const r of doc.resources) row(`${RESOURCE_LABELS[r.kind]} «${r.name}»`, subjectOfResource(r));
      for (const s of doc.services) row(`${SERVICE_LABELS[serviceKindOf(s)]} «${s.name}»`, subjectOfService(s));
      for (const n of doc.networks) row(`Red «${n.name}»`, subjectOfNetwork(n));
      out.push('', rows.length > 0 ? 'Iconos del documento' : 'Ningún elemento del documento indica un proveedor de nube (provider + service).', ...rows);
      return out.join('\n');
    },
  },
];
