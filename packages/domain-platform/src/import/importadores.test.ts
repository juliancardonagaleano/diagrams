import { readdirSync, readFileSync } from 'node:fs';
import { importFiles, joinSourceFiles, ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { platformModule } from '../module';
import { fromCloudFormation } from './fromCloudFormation';
import { fromHelm } from './fromHelm';
import { fromKubernetes } from './fromKubernetes';
import { PlatformImportError } from './fromMermaid';
import { fromTerraform, fromTerraformFiles } from './fromTerraform';
import { validatePlatformDocument } from '../schema';
import type { PlatformDocument } from '../types';

/** Lo que hace la CLI y el banco de trabajo: elegir el importador del módulo por extensión y, si no, por contenido. */
const registry = new ModuleRegistry().register(platformModule);
const pick = (text: string, file?: string): string | undefined => registry.detectImporter<PlatformDocument>('platform', file, text)?.id;
const read = (path: string): string => readFileSync(path, 'utf8');
const TF = 'tests/fixtures/importar/terraform';
const K8S = 'tests/fixtures/importar/kubernetes';
const CFN = 'tests/fixtures/importar/cloudformation';
const HELM = 'tests/fixtures/importar/helm';

describe('módulo de plataforma: importadores registrados', () => {
  it('declara Mermaid, Terraform, Kubernetes, CloudFormation y Helm, con sus extensiones', () => {
    expect(platformModule.importers.map((i) => [i.id, i.label, i.extensions])).toEqual([
      ['mermaid', 'Mermaid', ['.mmd', '.mermaid', '.md']],
      ['terraform', 'Terraform', ['.tf', '.tf.json', '.tfstate']],
      ['kubernetes', 'Kubernetes', ['.yaml', '.yml']],
      ['cloudformation', 'AWS CloudFormation', ['.yaml', '.yml', '.template', '.cfn']],
      ['helm', 'Helm (Chart.yaml + values.yaml)', ['.yaml', '.yml']],
    ]);
    for (const i of platformModule.importers) expect(typeof i.detect).toBe('function');
  });

  it.each([
    ['tests/fixtures/importar/terraform/aws-tienda/main.tf', 'terraform'],
    [`${TF}/aws-tienda-staging/terraform.tfstate`, 'terraform'],
    [`${TF}/json-config/main.tf.json`, 'terraform'],
    [`${TF}/aws-tienda-dev/plan.json`, 'terraform'],
    [`${TF}/azure-aks/main.tf`, 'terraform'],
    [`${TF}/gcp-gke/main.tf`, 'terraform'],
    [`${K8S}/tienda/manifests.yaml`, 'kubernetes'],
    [`${K8S}/tienda-kubectl/get-all.yaml`, 'kubernetes'],
    [`${K8S}/multi-entorno/entornos.yaml`, 'kubernetes'],
    [`${K8S}/malla-gateway/gateway.yaml`, 'kubernetes'],
    [`${CFN}/tienda-aws.yaml`, 'cloudformation'],
    [`${CFN}/api-contenedores.json`, 'cloudformation'],
    [`${CFN}/sam-notificaciones.yaml`, 'cloudformation'],
    [`${HELM}/tienda/Chart.yaml`, 'helm'],
    [`${HELM}/legado/Chart.yaml`, 'helm'],
    [`${HELM}/tienda-renderizado.yaml`, 'kubernetes'],
    ['examples/banca.mmd', 'mermaid'],
  ])('%s se reconoce como %s, con su nombre de archivo y también solo por el contenido', (path, expected) => {
    const text = read(path);
    expect(pick(text, path)).toBe(expected);
    expect(pick(text)).toBe(expected);
  });

  it('un manifiesto de Kubernetes en un archivo .txt o sin extensión se reconoce por el contenido', () => {
    const text = read(`${K8S}/tienda/manifests.yaml`);
    expect(pick(text, 'manifiestos.txt')).toBe('kubernetes');
    expect(pick(text, 'manifiestos')).toBe('kubernetes');
    expect(pick(read(`${TF}/aws-tienda/main.tf`), 'infra.txt')).toBe('terraform');
  });

  it('el JSON del propio módulo y los de otros módulos no se toman por Terraform ni por Kubernetes', () => {
    for (const file of ['examples/plataforma-ejemplo.json', 'examples/pedidos-integracion.json', 'examples/banca.json', 'examples/seguridad-ejemplo.json']) {
      expect(pick(read(file))).toBeUndefined();
    }
  });

  it('Mermaid con cabecera YAML (---) sigue siendo Mermaid y un YAML con --- inicial sigue siendo Kubernetes', () => {
    expect(pick('---\ntitle: Tienda\n---\nflowchart LR\n  a --> b\n')).toBe('mermaid');
    expect(pick('---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: y\n')).toBe('kubernetes');
  });

  it.each(['importar', 'importacion'])('un texto cualquiera (%s) no se reconoce', (text) => {
    expect(pick(text)).toBeUndefined();
  });

  it('cada importador devuelve un documento válido con su nombre de archivo como nombre del sistema', async () => {
    for (const [file, id, name] of [
      [`${TF}/aws-tienda/main.tf`, 'terraform', 'aws-tienda'],
      [`${TF}/azure-aks/main.tf`, 'terraform', 'azure-aks'],
      [`${K8S}/tienda/manifests.yaml`, 'kubernetes', 'tienda'],
      [`${K8S}/multi-entorno/entornos.yaml`, 'kubernetes', 'entornos'],
    ]) {
      const importer = platformModule.importers.find((i) => i.id === id)!;
      const outcome = await importer.import(read(file), { file, fallbackName: file.split('/').pop() });
      expect(validatePlatformDocument(outcome.document).ok).toBe(true);
      expect(outcome.document.workspace.name).toBe(name);
      expect(Array.isArray(outcome.warnings)).toBe(true);
    }
  });

  it('el nombre explícito del contexto manda sobre el del archivo', async () => {
    const importer = platformModule.importers.find((i) => i.id === 'kubernetes')!;
    const outcome = await importer.import(read(`${K8S}/tienda/manifests.yaml`), { name: 'Tienda online', file: `${K8S}/tienda/manifests.yaml` });
    expect(outcome.document.workspace.name).toBe('Tienda online');
  });

  it('sin ruta de archivo (stdin) se usa el nombre de reserva y, si no, un nombre por defecto', async () => {
    const importer = platformModule.importers.find((i) => i.id === 'terraform')!;
    const text = 'resource "aws_s3_bucket" "a" {\n  bucket = "x"\n}\n';
    expect((await importer.import(text, { fallbackName: 'mi-infra.tf' })).document.workspace.name).toBe('mi-infra');
    expect((await importer.import(text, {})).document.workspace.name).toBe('Arquitectura de plataforma');
  });
});

describe('módulo de plataforma: Terraform repartido en varios archivos', () => {
  const FOLDER = `${TF}/aws-tienda-multiarchivo`;
  const files = readdirSync(FOLDER)
    .filter((n) => n.endsWith('.tf'))
    .map((name) => ({ name, text: read(`${FOLDER}/${name}`) }));

  it('solo Terraform (.tf) y Helm (Chart.yaml + values.yaml) declaran que se leen en varios archivos', () => {
    expect(platformModule.importers.map((i) => [i.id, i.multiFile])).toEqual([
      ['mermaid', undefined],
      ['terraform', { extensions: ['.tf'] }],
      ['kubernetes', undefined],
      ['cloudformation', undefined],
      ['helm', { extensions: ['.yaml', '.yml'] }],
    ]);
  });

  it('importFiles del módulo da el mismo documento que importar los textos concatenados', async () => {
    const together = await importFiles(platformModule, files, undefined, { file: FOLDER });
    const manual = fromTerraform(joinSourceFiles(files).text, { file: FOLDER });
    expect(together.importer).toBe('terraform');
    expect(together.document).toEqual(manual.document);
    expect(together.warnings).toEqual(manual.warnings);
    expect(validatePlatformDocument(together.document).ok).toBe(true);
  });

  it('con el formato pedido (terraform) o sin pedirlo se elige el mismo importador; con otro formato se rechaza', async () => {
    const byId = await importFiles(platformModule, files, 'terraform', { file: FOLDER });
    const auto = await importFiles(platformModule, files, undefined, { file: FOLDER });
    expect(byId).toEqual(auto);
    await expect(importFiles(platformModule, files, 'kubernetes')).rejects.toThrow(/«kubernetes» no se puede leer repartido en varios archivos/);
    await expect(importFiles(platformModule, [...files, { name: 'x.yaml', text: 'a: 1' }])).rejects.toThrow(/no son todos del mismo formato/);
  });

  it('con un error en un archivo, el mensaje dice cuál', async () => {
    const broken = files.map((f) => (f.name === 'red.tf' ? { ...f, text: `${f.text}\nresource "aws_vpc" "otra" {\n  cidr_block = "10.1.0.0/16\n}\n` } : f));
    const line = broken.find((f) => f.name === 'red.tf')!.text.split('\n').findIndex((l) => l.includes('10.1.0.0/16')) + 1;
    await expect(importFiles(platformModule, broken, undefined, { file: FOLDER })).rejects.toThrow(`El HCL de Terraform no es válido (red.tf, línea ${line}): cadena sin cerrar.`);
  });

  it('dañado un archivo (cortado, recortado, símbolos de más) solo da un documento válido o un error de importación', () => {
    let imported = 0;
    for (const name of ['red.tf', 'seguridad.tf', 'entrada.tf']) {
      const base = files.find((f) => f.name === name)!;
      for (let cut = 0; cut < base.text.length; cut += Math.ceil(base.text.length / 40)) {
        const mutated = files.map((f) => (f.name === name ? { ...f, text: f.text.slice(0, cut) + f.text.slice(cut + 37) } : f));
        try {
          expect(validatePlatformDocument(fromTerraformFiles(mutated, {}).document).ok).toBe(true);
          imported += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(PlatformImportError);
        }
      }
    }
    expect(imported).toBeGreaterThan(0);
  });
});

describe('importadores de infraestructura: entradas dañadas', () => {
  // Generador determinista: la misma prueba en cada ejecución. Texto cortado, con un tramo borrado o con símbolos de más:
  // lo único que puede salir es un documento válido o un PlatformImportError, nunca una excepción cualquiera.
  const mutations = (text: string, seed: number): string[] => {
    let state = seed;
    const next = (): number => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const noise = ['{', '}', '"', '[', ']', ':', '\n', '\t', '<<', '${', '---', '#', '- '];
    const out: string[] = [];
    for (let i = 0; i < 25; i += 1) out.push(text.slice(0, Math.floor(next() * text.length)));
    for (let i = 0; i < 25; i += 1) {
      const a = Math.floor(next() * text.length);
      out.push(text.slice(0, a) + text.slice(a + Math.floor(next() * 200)));
    }
    for (let i = 0; i < 25; i += 1) {
      let t = text;
      for (let k = 0; k < 3; k += 1) {
        const p = Math.floor(next() * t.length);
        t = t.slice(0, p) + noise[Math.floor(next() * noise.length)] + t.slice(p);
      }
      out.push(t);
    }
    return out;
  };

  it.each([
    ...['aws-tienda/main.tf', 'aws-tienda-staging/terraform.tfstate', 'aws-tienda-dev/plan.json', 'azure-aks/main.tf', 'json-config/main.tf.json'].map((f) => [`${TF}/${f}`, fromTerraform] as const),
    ...['tienda/manifests.yaml', 'tienda-kubectl/get-all.yaml', 'multi-entorno/entornos.yaml', 'malla-gateway/gateway.yaml'].map((f) => [`${K8S}/${f}`, fromKubernetes] as const),
    ...['tienda-aws.yaml', 'api-contenedores.json', 'sam-notificaciones.yaml'].map((f) => [`${CFN}/${f}`, fromCloudFormation] as const),
    ...['tienda/Chart.yaml', 'legado/Chart.yaml'].map((f) => [`${HELM}/${f}`, (t: string, o: object) => fromHelm([{ name: 'Chart.yaml', text: t }], o)] as const),
    [`${HELM}/tienda-renderizado.yaml`, fromKubernetes] as const,
  ])('%s: truncado, recortado o con símbolos de más solo da un documento válido o un error de importación', (file, importer) => {
    let imported = 0;
    for (const text of mutations(read(file), file.length)) {
      try {
        expect(validatePlatformDocument(importer(text, {}).document).ok).toBe(true);
        imported += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(PlatformImportError);
      }
    }
    expect(imported).toBeGreaterThan(0);
  });
});
