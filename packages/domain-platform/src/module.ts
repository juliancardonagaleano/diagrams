import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { looksLikeMermaid, sourceFilesOf } from '@iark/kernel';
import { platformAiSpec } from './ai/generation';
import { platformCommands } from './commands';
import { platformEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromCloudFormation, looksLikeCloudFormation } from './import/fromCloudFormation';
import { fromKubernetes, looksLikeKubernetes } from './import/fromKubernetes';
import { fromMermaid } from './import/fromMermaid';
import { iconCommands } from './icons/commands';
import { iconIssues } from './icons/issues';
import { fromTerraform, fromTerraformFiles } from './import/fromTerraform';
import { looksLikeTerraform } from './import/terraformModel';
import { analyzePlatform } from './issues';
import { platformDocumentSchema, platformJsonSchema } from './schema';
import { PLATFORM_DOCUMENT_VERSION, type PlatformDocument } from './types';
import { listViews } from './views';

const mermaidImporter: Importer<PlatformDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const terraformImporter: Importer<PlatformDocument> = {
  id: 'terraform',
  label: 'Terraform',
  // `.tf.json` llega al registro como `.json` (solo mira la última extensión): ese caso se reconoce por el contenido.
  extensions: ['.tf', '.tf.json', '.tfstate'],
  detect: looksLikeTerraform,
  // Los `.tf` de una carpeta (o varios archivos) se leen juntos: `text` es su concatenación y `extra.files` el detalle por archivo.
  multiFile: { extensions: ['.tf'] },
  import: (text, ctx) => {
    const files = sourceFilesOf(ctx.extra);
    const options = { name: ctx.name, fallbackName: ctx.fallbackName, file: ctx.file };
    return files && files.length > 1 ? fromTerraformFiles(files, options) : fromTerraform(text, options);
  },
};

const kubernetesImporter: Importer<PlatformDocument> = {
  id: 'kubernetes',
  label: 'Kubernetes',
  extensions: ['.yaml', '.yml'],
  detect: looksLikeKubernetes,
  import: (text, ctx) => fromKubernetes(text, { name: ctx.name, fallbackName: ctx.fallbackName, file: ctx.file }),
};

const cloudformationImporter: Importer<PlatformDocument> = {
  id: 'cloudformation',
  label: 'AWS CloudFormation',
  // Sin `.json`: Terraform (`plan.json`, `terraform show -json`) también es JSON y, siendo el único que lo declarase, un único
  // candidato ganaría siempre. Una plantilla JSON se reconoce por el contenido; las de YAML (con `!Ref`, `!Sub`…) por `.yaml` o `.yml`.
  extensions: ['.yaml', '.yml', '.template', '.cfn'],
  detect: looksLikeCloudFormation,
  import: (text, ctx) => fromCloudFormation(text, { name: ctx.name, fallbackName: ctx.fallbackName, file: ctx.file }),
};

const mermaidExporter: Exporter<PlatformDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId }),
};

const svgExporter: Exporter<PlatformDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<PlatformDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc, ctx) => toDrawio(doc, ctx.viewId),
};

/**
 * Módulo de arquitectura de plataforma: entornos, redes, recursos aprovisionados (clústeres, bases de datos, colas…),
 * servicios, dónde se despliega cada uno, de quién depende y los pipelines de CI/CD que los construyen y promueven.
 * Ofrece la topología, una vista de despliegue por entorno (redes y anfitriones anidados), la entrega continua y el
 * análisis de impacto. Sus servicios y recursos pueden apuntar a elementos de otros módulos por URN (`ref`), p. ej. un
 * sistema del mapa de integración.
 */
export const platformModule: DomainModule<PlatformDocument> = {
  id: 'platform',
  name: 'Arquitectura de plataforma',
  version: '0.1.0',
  description: 'Entornos, redes, recursos, servicios, despliegues y pipelines, con topología, despliegue por entorno e impacto; importa de Mermaid, Terraform, Kubernetes y CloudFormation y exporta a Mermaid, SVG y draw.io.',
  documentVersion: PLATFORM_DOCUMENT_VERSION,
  schema: platformDocumentSchema as unknown as DomainModule<PlatformDocument>['schema'],
  jsonSchema: platformJsonSchema,
  validate: (doc): ModuleIssue[] => [...analyzePlatform(doc), ...iconIssues(doc)],
  importers: [mermaidImporter, terraformImporter, kubernetesImporter, cloudformationImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: platformAiSpec,
  entities: (doc): EntityRef[] => [
    ...doc.environments.map((e) => ({ id: e.id, name: e.name, kind: 'environment' })),
    ...doc.networks.map((n) => ({ id: n.id, name: n.name, kind: 'network' })),
    ...doc.resources.map((r) => ({ id: r.id, name: r.name, kind: 'resource' })),
    ...doc.services.map((s) => ({ id: s.id, name: s.name, kind: 'service' })),
    ...doc.pipelines.map((p) => ({ id: p.id, name: p.name, kind: 'pipeline' })),
  ],
  views: (doc): ViewRef[] => listViews(doc).map((v) => ({ id: v.id, title: v.title })),
  traceViews: [
    { prefix: 'impact', label: 'Impacto', applies: (e) => e.kind === 'service' || e.kind === 'resource' },
    { prefix: 'depends', label: 'Dependencias', applies: (e) => e.kind === 'service' || e.kind === 'resource' },
    { prefix: 'focus', label: 'Entorno', applies: (e) => e.kind === 'service' || e.kind === 'resource' },
    { prefix: 'compare', label: 'Comparar con el siguiente entorno', applies: (e) => e.kind === 'environment' },
  ],
  cliCommands: [...platformCommands, ...iconCommands],
  // Comparar versiones: las etapas de un pipeline son una secuencia (de entorno en entorno), así que su orden es contenido.
  diff: { ordered: ['pipelines.stages'] },
  editor: platformEditor,
};
