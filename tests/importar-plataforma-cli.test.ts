import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// Importar Terraform y Kubernetes al módulo de plataforma de punta a punta con el CLI empaquetado tal como se publica:
// `iark import --module platform --format terraform|kubernetes archivo` (la opción real es `--format`; `auto` lo deduce de
// la extensión o del contenido), y lo importado se valida y se exporta con los mismos comandos del módulo.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

let bundle: CliBundle;
let cli: string;
beforeAll(async () => {
  bundle = await buildCliBundle('importar-plataforma');
  cli = bundle.cli;
});
afterAll(() => bundle?.dispose());

const run = (args: string[], input?: string) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'iark-importar-plataforma-'));

const TF = 'tests/fixtures/importar/terraform';
const K8S = 'tests/fixtures/importar/kubernetes';
const importTo = (args: string[], input?: string) => {
  const r = run(['import', '--module', 'platform', ...args], input);
  expect(r.status, r.stderr).toBe(0);
  return { doc: JSON.parse(r.stdout), stderr: r.stderr, stdout: r.stdout };
};

describe('iark import --module platform --format terraform', () => {
  it('importa un .tf: documento de plataforma, resumen y avisos agrupados por stderr', () => {
    const { doc, stderr } = importTo(['--format', 'terraform', `${TF}/aws-tienda/main.tf`]);
    expect(doc.workspace.name).toBe('aws-tienda');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'production', kind: 'prod', provider: 'aws' })]);
    expect(doc.networks).toHaveLength(8);
    expect(doc.resources).toHaveLength(11);
    expect(doc.dependencies.length).toBeGreaterThan(5);
    expect(stderr).toMatch(/Importado "aws-tienda" en el módulo platform: \d+ elementos, 5 aviso\(s\)\./);
    expect(stderr).toMatch(/aviso: 1 recurso de un tipo sin mapear, que no se importa: aws_xray_group\./);
    expect(stderr).toMatch(/aviso: 22 recursos de soporte/);
  });

  it('con auto deduce el formato por la extensión (.tf, .tfstate) y por el contenido (plan, .tf.json, stdin)', () => {
    for (const [file, expected] of [
      [`${TF}/aws-tienda/main.tf`, 'aws-tienda'],
      [`${TF}/aws-tienda-staging/terraform.tfstate`, 'aws-tienda-staging'],
      [`${TF}/aws-tienda-dev/plan.json`, 'aws-tienda-dev'],
      [`${TF}/json-config/main.tf.json`, 'json-config'],
      [`${TF}/azure-aks/main.tf`, 'azure-aks'],
      [`${TF}/gcp-gke/main.tf`, 'gcp-gke'],
    ]) {
      const { doc } = importTo([file]);
      expect(doc.workspace.name, file).toBe(expected);
      expect(doc.resources.length, file).toBeGreaterThan(1);
    }
    const viaStdin = importTo(['--stdin'], readFileSync(`${TF}/azure-aks/main.tf`, 'utf8'));
    expect(viaStdin.doc.resources.map((r: { id: string }) => r.id)).toContain('kubernetes-cluster-main');
    expect(viaStdin.doc.environments[0]).toMatchObject({ id: 'tienda-pre', provider: 'azure' });
  });

  it('importar dos veces el mismo archivo da exactamente la misma salida', () => {
    const a = importTo(['--format', 'terraform', `${TF}/aws-tienda/main.tf`]);
    const b = importTo(['--format', 'terraform', `${TF}/aws-tienda/main.tf`]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stderr).toBe(b.stderr);
  });

  it('--name y --out; el resultado pasa validate --module platform sin errores ni avisos', () => {
    const out = join(dir, 'tienda.platform.json');
    const r = run(['import', '--module', 'platform', '--format', 'terraform', '--name', 'Tienda en AWS', '-o', out, `${TF}/aws-tienda/main.tf`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).workspace.name).toBe('Tienda en AWS');
    const valid = run(['validate', out, '--module', 'platform', '--strict']);
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    expect(valid.stdout).toMatch(/Documento válido \(módulo platform\)\. 0 error\(es\), 0 aviso\(s\)/);
  });

  it('lo importado se exporta con convert: Mermaid de la vista de despliegue del entorno, SVG y draw.io', () => {
    const out = join(dir, 'vista.platform.json');
    expect(run(['import', '--module', 'platform', '--format', 'terraform', '-o', out, `${TF}/aws-tienda/main.tf`]).status).toBe(0);
    const mmd = run(['convert', out, '--module', 'platform', '--to', 'mermaid', '--view', 'env:production']);
    expect(mmd.status, mmd.stderr).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart/);
    expect(mmd.stdout).toContain('tienda-production-orders');
    const svg = join(dir, 'tienda.svg');
    expect(run(['convert', out, '--module', 'platform', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('<svg');
    const drawio = join(dir, 'tienda.drawio');
    expect(run(['convert', out, '--module', 'platform', '--out', drawio]).status).toBe(0);
    expect(readFileSync(drawio, 'utf8')).toContain('<mxfile');
  });

  it('no filtra por stdout las contraseñas del estado ni del plan', () => {
    const state = run(['import', '--module', 'platform', `${TF}/aws-tienda-staging/terraform.tfstate`]);
    const plan = run(['import', '--module', 'platform', `${TF}/aws-tienda-dev/plan.json`]);
    for (const r of [state, plan]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout + r.stderr).not.toMatch(/S3cr3t-p4ss|plan-time-password/);
    }
  });

  it('prompt --from acepta un .tf como documento base', () => {
    const r = run(['prompt', 'Añade una caché', '--module', 'platform', '--from', `${TF}/aws-tienda/main.tf`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Documento base importado de terraform/);
    expect(r.stdout).toContain('tienda-production-orders');
  });

  it('un Terraform roto o ajeno falla con código 2 y un mensaje claro (sin traza)', () => {
    const broken = run(['import', '--module', 'platform', '--format', 'terraform', '--stdin'], 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16\n}\n');
    expect(broken.status).toBe(2);
    expect(broken.stderr).toMatch(/El HCL de Terraform no es válido \(línea 2\): cadena sin cerrar/);
    expect(broken.stderr).not.toMatch(/\n\s+at /);
    const empty = run(['import', '--module', 'platform', '--format', 'terraform', '--stdin'], '');
    expect(empty.status).toBe(2);
    const other = run(['import', '--module', 'platform', '--format', 'terraform', `${K8S}/tienda/manifests.yaml`]);
    expect(other.status).toBe(2);
    expect(other.stderr).toMatch(/Terraform/);
  });
});

describe('iark import --module platform --format kubernetes', () => {
  it('importa un manifiesto multi-documento: servicios, despliegues, recursos y dependencias', () => {
    const { doc, stderr } = importTo(['--format', 'kubernetes', `${K8S}/tienda/manifests.yaml`]);
    expect(doc.workspace.name).toBe('tienda');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'production', kind: 'prod', provider: 'kubernetes' })]);
    expect(doc.services.map((s: { id: string }) => s.id)).toEqual(['api', 'web', 'limpieza-carritos']);
    expect(doc.deployments).toHaveLength(3);
    expect(doc.resources.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(['postgres', 'redis', 'ingress-tienda', 'kubernetes']));
    expect(doc.dependencies.length).toBeGreaterThan(8);
    expect(stderr).toMatch(/Importado "tienda" en el módulo platform: \d+ elementos, 5 aviso\(s\)\./);
    expect(stderr).toMatch(/aviso: Los manifiestos no declaran el clúster/);
  });

  it('con auto deduce el formato por la extensión (.yaml, .yml) y por el contenido (stdin, otras extensiones)', () => {
    const text = readFileSync(`${K8S}/tienda-kubectl/get-all.yaml`, 'utf8');
    const yml = join(dir, 'contenidos.yml');
    const txt = join(dir, 'cuaderno.txt');
    writeFileSync(yml, text);
    writeFileSync(txt, text);
    expect(importTo([`${K8S}/tienda-kubectl/get-all.yaml`]).doc.workspace.name).toBe('tienda-kubectl');
    expect(importTo([yml]).doc.workspace.name).toBe('contenidos');
    expect(importTo([txt]).doc.services.map((s: { id: string }) => s.id)).toEqual(['blog']);
    expect(importTo(['--stdin'], text).doc.services.map((s: { id: string }) => s.id)).toEqual(['blog']);
    for (const f of ['multi-entorno/entornos.yaml', 'malla-gateway/gateway.yaml']) expect(importTo([`${K8S}/${f}`]).doc.environments.length).toBeGreaterThan(0);
  });

  it('importar dos veces el mismo archivo da exactamente la misma salida', () => {
    const a = importTo(['--format', 'kubernetes', `${K8S}/tienda/manifests.yaml`]);
    const b = importTo(['--format', 'kubernetes', `${K8S}/tienda/manifests.yaml`]);
    expect(a.stdout).toBe(b.stdout);
  });

  it('nunca imprime valores de Secret, y lo importado valida y se exporta', () => {
    const out = join(dir, 'k8s.platform.json');
    const r = run(['import', '--module', 'platform', '-o', out, `${K8S}/tienda/manifests.yaml`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr + readFileSync(out, 'utf8')).not.toMatch(/UzNjcjN0LWs4cy1kby1ub3QtbGVhayE=|K8s-S3cr3t|YXBwX3VzZXI=/);
    const valid = run(['validate', out, '--module', 'platform', '--strict']);
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    const mmd = run(['convert', out, '--module', 'platform', '--to', 'mermaid', '--view', 'env:production']);
    expect(mmd.status, mmd.stderr).toBe(0);
    expect(mmd.stdout).toMatch(/^flowchart/);
    expect(mmd.stdout).toContain('limpieza-carritos');
    const svg = join(dir, 'k8s.svg');
    expect(run(['convert', out, '--module', 'platform', '--out', svg]).status).toBe(0);
    expect(readFileSync(svg, 'utf8')).toContain('<svg');
  });

  it('un YAML roto o ajeno falla con código 2 y un mensaje claro (sin traza)', () => {
    const broken = run(['import', '--module', 'platform', '--format', 'kubernetes', '--stdin'], 'apiVersion: v1\nkind: Namespace\nmetadata:\n\tname: x\n');
    expect(broken.status).toBe(2);
    expect(broken.stderr).toMatch(/El YAML de Kubernetes no es válido \(línea 4\)/);
    expect(broken.stderr).not.toMatch(/\n\s+at /);
    const helm = run(['import', '--module', 'platform', '--format', 'kubernetes', '--stdin'], 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n');
    expect(helm.status).toBe(2);
    expect(helm.stderr).toMatch(/helm template/);
    const other = run(['import', '--module', 'platform', '--format', 'kubernetes', `${TF}/aws-tienda/main.tf`]);
    expect(other.status).toBe(2);
  });
});

describe('iark: formatos del módulo de plataforma', () => {
  it('modules lista los tres importadores y el manifiesto los declara', () => {
    expect(run(['modules']).stdout).toMatch(/^platform {2}Arquitectura de plataforma {2}v0\.1\.0\n {4}importa: mermaid, terraform, kubernetes, cloudformation {2}· {2}exporta: mermaid, svg, drawio/m);
    const manifest = JSON.parse(run(['modules', '--json']).stdout);
    const platform = manifest.modules.find((m: { id: string }) => m.id === 'platform');
    expect(platform.importFormats).toEqual(['mermaid', 'terraform', 'kubernetes', 'cloudformation']);
  });

  it('un formato inválido lista los del módulo; Mermaid sigue importándose igual', () => {
    const bad = run(['import', '--module', 'platform', '--format', 'pulumi', `${TF}/aws-tienda/main.tf`]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Formato inválido «pulumi»\. Use: auto, kubernetes, mermaid, terraform\./);
    const { doc } = importTo(['--stdin'], 'flowchart LR\n  subgraph e["Entorno: Producción"]\n    a[Web] --> b[(Datos)]\n  end\n');
    expect(doc.services.length + doc.resources.length).toBeGreaterThan(1);
  });

  it('un archivo que no es de ningún formato dice cuáles hay', () => {
    const file = join(dir, 'notas.xyz');
    writeFileSync(file, 'esto no es nada importable');
    const r = run(['import', '--module', 'platform', file]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/No se reconoce el formato de ".*notas\.xyz": use --format kubernetes, mermaid o terraform\./);
  });
});
