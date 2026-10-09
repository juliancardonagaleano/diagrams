import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { joinSourceFiles } from '@iark/kernel';
import { InvalidDocumentError, WorkbenchController } from './controller';
import { SOURCES, example, newController, platformModule } from './testing';

describe('WorkbenchController', () => {
  it('activa un módulo cargándolo bajo demanda, con su ejemplo y la primera vista', async () => {
    let loads = 0;
    const counting = SOURCES.map((s) => ({ ...s, load: async () => (loads++, s.load()) }));
    const controller = new WorkbenchController(counting, { renderDelay: 0 });
    expect(loads).toBe(0);
    await controller.selectModule('data');
    await controller.render();
    const state = controller.getState();
    expect(loads).toBe(1);
    expect(state.moduleId).toBe('data');
    expect(state.analysis.status).toBe('ok');
    expect(state.viewId).toBe(state.choices.views[0].id);
    expect(state.svg?.startsWith('<svg')).toBe(true);
    expect(state.modified).toBe(false);
    await controller.selectModule('data');
    expect(loads).toBe(1);
  });

  it('un texto inválido conserva el último dibujo válido y se recupera al corregirlo', async () => {
    const controller = newController();
    await controller.selectModule('security');
    await controller.render();
    const svg = controller.getState().svg;
    expect(svg).toBeTruthy();

    controller.setText('{ "version": ');
    await controller.render();
    expect(controller.getState().analysis.status).toBe('syntax');
    expect(controller.getState().svg).toBe(svg);
    expect(controller.getState().modified).toBe(true);

    controller.setText(example('seguridad-ejemplo.json'));
    await controller.render();
    expect(controller.getState().analysis.status).toBe('ok');
  });

  it('cambia de vista solo a las que existen, incluidas las de traza', async () => {
    const controller = newController();
    await controller.selectModule('security');
    expect(controller.setView('blast:pedidos')).toBe(true);
    await controller.render();
    expect(controller.getState().viewId).toBe('blast:pedidos');
    expect(controller.getState().svg).toContain('<svg');
    expect(controller.setView('blast:nadie')).toBe(false);
    expect(controller.getState().viewId).toBe('blast:pedidos');
  });

  it('si la vista activa deja de existir al editar, vuelve a la primera', async () => {
    const controller = newController();
    await controller.selectModule('security');
    controller.setView('blast:pedidos');
    const doc = JSON.parse(example('seguridad-ejemplo.json'));
    doc.threats = doc.threats.filter((t: { targetId: string }) => t.targetId !== 'pedidos');
    doc.assets = doc.assets.filter((a: { id: string }) => a.id !== 'pedidos');
    doc.flows = doc.flows.filter((f: { sourceId: string; targetId: string }) => f.sourceId !== 'pedidos' && f.targetId !== 'pedidos');
    controller.setText(JSON.stringify(doc));
    const state = controller.getState();
    expect(state.analysis.status).toBe('ok');
    expect(state.viewId).toBe(state.choices.views[0].id);
  });

  it('carga documentos del anfitrión; con strict rechaza los inválidos sin tocar el estado', async () => {
    const controller = newController();
    await controller.selectModule('security');
    const before = controller.getState().text;
    await expect(controller.loadDocument({ version: '9.9', zones: 3 }, { strict: true })).rejects.toBeInstanceOf(InvalidDocumentError);
    expect(controller.getState().text).toBe(before);

    const analysis = await controller.loadDocument(JSON.parse(example('ventas-datos.json')), { module: 'data', strict: true });
    expect(analysis.status).toBe('ok');
    expect(controller.getState().moduleId).toBe('data');
    expect(controller.getState().modified).toBe(false);

    await controller.loadDocument('{ "roto": ', {});
    expect(controller.getState().analysis.status).toBe('syntax');
  });

  it('solo lectura: ignora las ediciones', async () => {
    const controller = newController();
    await controller.selectModule('security');
    controller.setReadOnly(true);
    const before = controller.getState().text;
    controller.setText('{}');
    expect(controller.getState().text).toBe(before);
  });

  it('exporta el documento actual y explica por qué no puede si es inválido', async () => {
    const controller = newController();
    await controller.selectModule('platform');
    const file = await controller.exportAs('mermaid');
    expect(file.data.startsWith('flowchart')).toBe(true);
    controller.setText('nada');
    await expect(async () => controller.exportAs('json')).rejects.toThrow(/No se puede continuar/);
  });

  it('importar Mermaid sustituye el documento y cuenta como cambio', async () => {
    const controller = newController();
    await controller.selectModule('security');
    const mermaid = (await controller.exportAs('mermaid', 'dfd')).data;
    await controller.selectModule('platform');
    await controller.selectModule('security');
    const result = await controller.importFrom(mermaid);
    expect(result.importer).toBe('mermaid');
    expect(controller.getState().modified).toBe(true);
    expect(controller.getState().analysis.status).toBe('ok');
  });

  describe('openText (Abrir archivo…)', () => {
    // Un módulo de plataforma con un importador de JSON extra, como el `manifest.json` de dbt en Datos.
    // (con una clave de plataforma de tipo equivocado, para que no valide como documento del módulo)
    const manifest = JSON.stringify({ fake_manifest: true, environments: 'no es una lista' });
    const withJsonImporter = new WorkbenchController(
      SOURCES.map((s) =>
        s.id !== 'platform'
          ? s
          : {
              ...s,
              load: async () => ({
                ...platformModule,
                importers: [
                  ...platformModule.importers,
                  {
                    id: 'falso',
                    label: 'Falso',
                    extensions: ['.json'],
                    detect: (text: string) => text.includes('fake_manifest'),
                    import: () => ({ document: JSON.parse(example('plataforma-ejemplo.json')), warnings: ['aviso de prueba'] }),
                  },
                ],
              }),
            },
      ),
      { renderDelay: 0 },
    );

    it('un JSON que es un documento del módulo se carga tal cual, sin importar', async () => {
      await withJsonImporter.selectModule('platform');
      const result = await withJsonImporter.openText(example('plataforma-ejemplo.json'), 'plataforma.json');
      expect(result).toBeUndefined();
      expect(withJsonImporter.getState().analysis.status).toBe('ok');
      expect(withJsonImporter.getState().modified).toBe(true);
    });

    it('un JSON que no cumple el esquema pero que un importador reconoce se importa', async () => {
      await withJsonImporter.selectModule('platform');
      const result = await withJsonImporter.openText(manifest, 'manifest.json');
      expect(result?.importer).toBe('falso');
      expect(result?.warnings).toEqual(['aviso de prueba']);
      expect(withJsonImporter.getState().analysis.status).toBe('ok');
    });

    it('un JSON que ni cumple el esquema ni reconoce ningún importador se carga para corregirlo', async () => {
      const controller = newController();
      await controller.selectModule('security');
      const result = await controller.openText('{ "threats": 5 }', 'roto.json');
      expect(result).toBeUndefined();
      expect(controller.getState().analysis.status).toBe('schema');
    });

    it('un archivo que no es JSON se importa', async () => {
      const controller = newController();
      await controller.selectModule('security');
      const mermaid = (await controller.exportAs('mermaid', 'dfd')).data;
      const result = await controller.openText(mermaid, 'dfd.mmd');
      expect(result?.importer).toBe('mermaid');
      expect(controller.getState().analysis.status).toBe('ok');
    });
  });

  describe('avisos de la importación (lastImport)', () => {
    const avisos = ['aviso uno', 'aviso dos'];
    /** Plataforma con un importador `.fake` que devuelve el ejemplo con avisos (o sin ellos si el texto lo pide). */
    const avisado = () =>
      new WorkbenchController(
        SOURCES.map((s) =>
          s.id !== 'platform'
            ? s
            : {
                ...s,
                load: async () => ({
                  ...platformModule,
                  importers: [
                    ...platformModule.importers,
                    { id: 'falso', label: 'Falso', extensions: ['.fake'], detect: (t: string) => t.startsWith('FAKE'), import: (t: string) => ({ document: JSON.parse(example('plataforma-ejemplo.json')), warnings: t.includes('limpio') ? [] : avisos }) },
                  ],
                }),
              },
        ),
        { renderDelay: 0 },
      );

    it('importFrom deja el importador, el archivo y los avisos en el estado', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      expect(controller.getState().lastImport).toBeUndefined();
      await controller.importFrom('FAKE', 'falso', { file: 'tienda.fake' });
      expect(controller.getState().lastImport).toEqual({ importer: 'falso', file: 'tienda.fake', warnings: avisos });
    });

    it('«Abrir archivo…» (openText) los deja también, igual que la pestaña Importar', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      const result = await controller.openText('FAKE', 'tienda.fake');
      expect(result?.warnings).toEqual(avisos);
      expect(controller.getState().lastImport).toEqual({ importer: 'falso', file: 'tienda.fake', warnings: avisos });
    });

    it('una importación sin avisos deja la lista vacía (y reemplaza los de la anterior)', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      await controller.importFrom('FAKE', 'falso');
      await controller.importFrom('FAKE limpio', 'falso', { file: 'otra.fake' });
      expect(controller.getState().lastImport).toEqual({ importer: 'falso', file: 'otra.fake', warnings: [] });
    });

    it('se descartan al editar el documento, aunque sea un cambio mínimo; el mismo texto no cuenta como edición', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      await controller.importFrom('FAKE', 'falso');
      controller.setText(controller.getState().text);
      expect(controller.getState().lastImport?.warnings).toEqual(avisos);
      controller.setText(`${controller.getState().text}\n`);
      expect(controller.getState().lastImport).toBeUndefined();
    });

    it('se descartan al cargar un documento, un ejemplo, un JSON con «Abrir archivo…» o al cambiar de módulo', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      const importa = () => controller.importFrom('FAKE', 'falso', { file: 'x.fake' });

      await importa();
      await controller.loadDocument(example('plataforma-ejemplo.json'));
      expect(controller.getState().lastImport).toBeUndefined();

      await importa();
      await controller.loadExample();
      expect(controller.getState().lastImport).toBeUndefined();

      await importa();
      expect(await controller.openText(example('plataforma-ejemplo.json'), 'plataforma.json')).toBeUndefined();
      expect(controller.getState().lastImport).toBeUndefined();

      await importa();
      controller.useDocumentText(example('plataforma-ejemplo.json'));
      expect(controller.getState().lastImport).toBeUndefined();

      await importa();
      await controller.selectModule('security');
      expect(controller.getState().lastImport).toBeUndefined();
    });

    it('un error de importación no toca ni el documento ni los avisos anteriores', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      await controller.importFrom('FAKE', 'falso');
      await expect(controller.importFrom('FAKE', 'no-existe')).rejects.toThrow(/no importa/);
      expect(controller.getState().lastImport?.warnings).toEqual(avisos);
    });

    it('marcar como guardado, cambiar de vista o dibujar no los quita', async () => {
      const controller = avisado();
      await controller.selectModule('platform');
      await controller.importFrom('FAKE', 'falso');
      controller.markSaved();
      controller.setStatus('hola');
      await controller.render();
      expect(controller.getState().lastImport?.warnings).toEqual(avisos);
    });
  });

  describe('importFiles (varios archivos a la vez)', () => {
    const FOLDER = 'tests/fixtures/importar/terraform/aws-tienda-multiarchivo';
    const files = readdirSync(FOLDER)
      .filter((n) => n.endsWith('.tf'))
      .map((name) => ({ name, text: readFileSync(`${FOLDER}/${name}`, 'utf8') }));

    it('los .tf de un stack se importan como uno: el mismo documento que importar sus textos concatenados', async () => {
      const together = newController();
      await together.selectModule('platform');
      const result = await together.importFiles(files);
      expect(result.importer).toBe('terraform');
      expect(together.getState().modified).toBe(true);
      expect(together.getState().analysis.status).toBe('ok');
      // Sus avisos quedan en el estado, como los de cualquier otra importación.
      expect(together.getState().lastImport).toEqual({ importer: 'terraform', file: `${files.length} archivos`, warnings: result.warnings });
      expect(result.warnings.length).toBeGreaterThan(0);

      const concatenated = newController();
      await concatenated.selectModule('platform');
      await concatenated.importFrom(joinSourceFiles(files).text, 'terraform');
      expect(together.getState().text).toBe(concatenated.getState().text);
      // El orden en que se eligieron no cambia nada.
      const reversed = newController();
      await reversed.selectModule('platform');
      await reversed.importFiles([...files].reverse());
      expect(reversed.getState().text).toBe(together.getState().text);
    });

    it('un error de sintaxis dice de qué archivo y no toca el documento', async () => {
      const controller = newController();
      await controller.selectModule('platform');
      const before = controller.getState().text;
      const broken = files.map((f) => (f.name === 'datos.tf' ? { ...f, text: `${f.text}\nresource "aws_sqs_queue" "x" {\n  name = "sin cerrar\n}\n` } : f));
      await expect(controller.importFiles(broken)).rejects.toThrow(/El HCL de Terraform no es válido \(datos\.tf, línea \d+\): cadena sin cerrar\./);
      expect(controller.getState().text).toBe(before);
    });

    it('archivos de distinto formato, o de un formato que no se reparte, se rechazan con el motivo', async () => {
      const controller = newController();
      await controller.selectModule('platform');
      const before = controller.getState().text;
      await expect(controller.importFiles([...files, { name: 'otro.yaml', text: 'a: 1' }])).rejects.toThrow(/no son todos del mismo formato: solo se leen juntos los \.tf o los \.yaml, \.yml/);
      await expect(controller.importFiles(files, 'kubernetes')).rejects.toThrow(/«kubernetes» no se puede leer repartido en varios archivos/);
      expect(controller.getState().text).toBe(before);
      await controller.selectModule('security');
      await expect(controller.importFiles(files)).rejects.toThrow(/no importa varios archivos a la vez/);
    });
  });

  it('los informes leen el documento del editor', async () => {
    const controller = newController();
    await controller.selectModule('security');
    const report = await controller.run('risks', {});
    expect(report.output).toContain('Amenazas:');
  });

  it('guarda y lee borradores por módulo', async () => {
    const drafts = new Map<string, string>();
    const controller = new WorkbenchController(SOURCES, {
      renderDelay: 0,
      storage: { read: (id) => drafts.get(id) ?? null, write: (id, text) => void drafts.set(id, text) },
    });
    await controller.selectModule('data');
    controller.setText('{ "version": "1.0" }');
    expect(drafts.get('data')).toBe('{ "version": "1.0" }');
    await controller.selectModule('security');
    await controller.selectModule('data');
    expect(controller.getState().text).toBe('{ "version": "1.0" }');
  });

  it('avisa si el módulo no existe y no se rompe', async () => {
    const controller = newController();
    await controller.selectModule('no-existe');
    expect(controller.getState().error).toMatch(/no ofrece el módulo «no-existe»/);
    expect(controller.getState().loading).toBe(false);
  });

  it('capacidades: todas o solo las de los módulos pedidos', async () => {
    const controller = newController();
    const some = await controller.capabilities(['data']);
    expect(some.available).toEqual(['integration', 'data', 'enterprise', 'platform', 'security']);
    expect(some.modules.map((m) => m.id)).toEqual(['data']);
    expect((await controller.capabilities()).modules).toHaveLength(5);
  });
});
