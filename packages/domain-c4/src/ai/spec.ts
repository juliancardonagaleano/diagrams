import type { AiSpec } from '@iark/kernel';
import { autoLayoutDocument } from '../layout/elkLayout';
import { formatIssues } from '../model/schema';
import type { C4Document } from '../model/types';
import { documentToGenerated, generatedDocumentSchema, generatedToDocument, generationJsonSchema, type GeneratedDocument } from './generationSchema';
import { retryPrompt, systemPrompt, userPrompt } from './prompt';

/** Cómo genera el módulo C4 con IA: prompts, esquema de salida sin coordenadas y autolayout final. */
export const c4AiSpec: AiSpec<C4Document> = {
  generationSchema: generatedDocumentSchema,
  generationJsonSchema,
  system: systemPrompt,
  user: userPrompt,
  retry: retryPrompt,
  toDocument(generated) {
    const result = generatedToDocument(generated as GeneratedDocument);
    return result.ok ? { ok: true, document: result.document } : { ok: false, issues: formatIssues(result.issues) };
  },
  finish: (document) => autoLayoutDocument(document, { force: true }),
  // Para `iark explain` y `iark review`: el modelo sin coordenadas y qué destacar y qué mirar en C4.
  serialize: documentToGenerated,
  explainGuide:
    'Narra de lo general a lo particular: primero las personas y el sistema en su entorno (contexto), después los contenedores que lo componen y, si hay vistas de componentes, el interior de cada contenedor. Di qué tecnología usa cada pieza y con qué protocolo se hablan.',
  reviewGuide:
    'Mira: elementos sin descripción o sin tecnología; sistemas o contenedores sin ninguna relación; relaciones sin descripción o sin protocolo; un contenedor compartido por varios sistemas; acceso directo a la base de datos de otro sistema; ausencia de quien autentica a las personas; puntos únicos de fallo (una base de datos o una cola de la que depende todo); sistemas externos críticos sin alternativa; vistas que no cuentan lo que su título promete o que dejan fuera elementos del modelo.',
};
