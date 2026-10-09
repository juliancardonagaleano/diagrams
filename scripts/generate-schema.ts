import { mkdirSync, writeFileSync } from 'node:fs';
import { documentJsonSchema } from '@core/model/schema';
import { generationJsonSchema } from '@core/ai/generationSchema';
import { dataModule } from '@iark/domain-data';
import { enterpriseModule } from '@iark/domain-enterprise';
import { platformIconPackJsonSchema, platformModule } from '@iark/domain-platform';
import { securityModule } from '@iark/domain-security';
import { integrationModule } from '@iark/domain-integration';
import { iarkConfigJsonSchema } from '../src/cli/plugins/config';

mkdirSync('schema', { recursive: true });
const doc = { $id: 'https://github.com/juliancardonagaleano/diagrams/schema/c4-document.schema.json', title: 'Documento C4 (DIAgrams)', ...documentJsonSchema() };
writeFileSync('schema/c4-document.schema.json', JSON.stringify(doc, null, 2) + '\n');
const gen = { $id: 'https://github.com/juliancardonagaleano/diagrams/schema/c4-generation.schema.json', title: 'Modelo C4 sin coordenadas (salida de IA)', ...generationJsonSchema() };
writeFileSync('schema/c4-generation.schema.json', JSON.stringify(gen, null, 2) + '\n');

// Esquemas de los demás módulos, a través de su contrato.
const base = 'https://github.com/juliancardonagaleano/diagrams/schema';
const integrationDoc = { $id: `${base}/integration-document.schema.json`, title: 'Documento de integración (DIAgrams)', ...(integrationModule.jsonSchema() as object) };
writeFileSync('schema/integration-document.schema.json', JSON.stringify(integrationDoc, null, 2) + '\n');
const integrationGen = { $id: `${base}/integration-generation.schema.json`, title: 'Modelo de integración (salida de IA)', ...(integrationModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/integration-generation.schema.json', JSON.stringify(integrationGen, null, 2) + '\n');
const dataDoc = { $id: `${base}/data-document.schema.json`, title: 'Documento de datos (DIAgrams)', ...(dataModule.jsonSchema() as object) };
writeFileSync('schema/data-document.schema.json', JSON.stringify(dataDoc, null, 2) + '\n');
const dataGen = { $id: `${base}/data-generation.schema.json`, title: 'Modelo de datos (salida de IA)', ...(dataModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/data-generation.schema.json', JSON.stringify(dataGen, null, 2) + '\n');
const enterpriseDoc = { $id: `${base}/enterprise-document.schema.json`, title: 'Documento empresarial (DIAgrams)', ...(enterpriseModule.jsonSchema() as object) };
writeFileSync('schema/enterprise-document.schema.json', JSON.stringify(enterpriseDoc, null, 2) + '\n');
const enterpriseGen = { $id: `${base}/enterprise-generation.schema.json`, title: 'Modelo empresarial (salida de IA)', ...(enterpriseModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/enterprise-generation.schema.json', JSON.stringify(enterpriseGen, null, 2) + '\n');

const platformDoc = { $id: `${base}/platform-document.schema.json`, title: 'Documento de plataforma (DIAgrams)', ...(platformModule.jsonSchema() as object) };
writeFileSync('schema/platform-document.schema.json', JSON.stringify(platformDoc, null, 2) + '\n');
const platformGen = { $id: `${base}/platform-generation.schema.json`, title: 'Modelo de plataforma (salida de IA)', ...(platformModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/platform-generation.schema.json', JSON.stringify(platformGen, null, 2) + '\n');

const platformIcons = { $id: `${base}/platform-icon-pack.schema.json`, title: 'Paquete de iconos de plataforma (DIAgrams)', ...platformIconPackJsonSchema() };
writeFileSync('schema/platform-icon-pack.schema.json', JSON.stringify(platformIcons, null, 2) + '\n');

const securityDoc = { $id: `${base}/security-document.schema.json`, title: 'Documento de seguridad (DIAgrams)', ...(securityModule.jsonSchema() as object) };
writeFileSync('schema/security-document.schema.json', JSON.stringify(securityDoc, null, 2) + '\n');
const securityGen = { $id: `${base}/security-generation.schema.json`, title: 'Modelo de seguridad (salida de IA)', ...(securityModule.ai!.generationJsonSchema() as object) };
writeFileSync('schema/security-generation.schema.json', JSON.stringify(securityGen, null, 2) + '\n');
// La configuración de DIAgrams (`iark.config.json`): módulos de terceros que carga el CLI y el servicio.
writeFileSync('schema/iark-config.schema.json', JSON.stringify(iarkConfigJsonSchema(), null, 2) + '\n');
console.log('Esquemas escritos en schema/');
