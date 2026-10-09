import { Command, InvalidArgumentError } from 'commander';
import { explainPrompts, GenerationError, generateText, reviewPrompts, type CommentaryKind, type CommentaryLang, type ModuleRegistry } from '@iark/kernel';
import { DEFAULT_AI_MODEL } from '@core/ai/generate';
import { addBudgetOptions, addModelOptions, reportText, tokenLimitOptions, withAiErrors } from './ai';
import { info, writeOutput } from './io';
import { DEFAULT_MODULE } from './registry';

/**
 * `iark explain` y `iark review`: un modelo narra el diagrama a quien no lo conoce, o lo revisa (inconsistencias, riesgos,
 * ausencias) con las incidencias de `validate()` como contexto. Funcionan con cualquier módulo a través de su `AiSpec`; la salida es
 * Markdown. Son solo del CLI: el servicio `iark serve` no llama a ningún modelo (ver `docs/ia.md`).
 */

/** Lee un diagrama (JSON del módulo o una fuente importable, de un archivo o de la entrada estándar) y lo valida. */
export type DiagramReader = (moduleId: string, file: string | undefined, useStdin: boolean) => Promise<unknown>;

function parseLang(value: string): CommentaryLang {
  const v = value.toLowerCase();
  if (v !== 'es' && v !== 'en') throw new InvalidArgumentError('Idioma inválido. Use: es, en');
  return v;
}

const DESCRIPTIONS: Record<CommentaryKind, string> = {
  explain: 'Narra un diagrama en lenguaje natural (Markdown) para quien no lo conoce, con un modelo de IA',
  review: 'Revisa un diagrama (inconsistencias, riesgos y ausencias) con un modelo de IA, apoyándose en las incidencias de `validate`',
};

export function registerCommentary(program: Command, registry: ModuleRegistry, readDiagram: DiagramReader): void {
  for (const kind of ['explain', 'review'] as const) {
    const command = program
      .command(kind)
      .description(DESCRIPTIONS[kind])
      .argument('[archivo]', 'diagrama de entrada: JSON del módulo o cualquier fuente que ese módulo importe (o "-" para stdin)')
      .option('--stdin', 'leer el diagrama de la entrada estándar')
      .option('-o, --out <archivo.md>', 'archivo Markdown de salida (por defecto stdout)')
      .option('--module <id>', 'módulo de la suite (ver `iark modules`)', DEFAULT_MODULE)
      .option('--lang <es|en>', 'idioma de la respuesta', parseLang, 'es');
    addModelOptions(command, DEFAULT_AI_MODEL);
    addBudgetOptions(command);
    command.action(async (file: string | undefined, opts) => {
      const module = registry.require(opts.module);
      const document = await readDiagram(opts.module, file, Boolean(opts.stdin));
      // La revisión parte de lo que ya dicen las reglas del módulo: se le pasan al modelo como contexto.
      const issues = kind === 'review' ? module.validate(document) : [];
      if (kind === 'review') {
        const count = (severity: string) => issues.filter((i) => i.severity === severity).length;
        info(`El validador del módulo «${module.id}» encontró ${count('error')} error(es), ${count('warning')} aviso(s) y ${count('info')} nota(s); se le pasan al modelo.`);
      }
      const prompts = (kind === 'explain' ? explainPrompts : reviewPrompts)({ module, document, issues, lang: opts.lang });
      const result = await withAiErrors(() =>
        generateText({
          ...prompts,
          defaultModel: DEFAULT_AI_MODEL,
          provider: opts.provider,
          model: opts.model,
          effort: opts.effort,
          ...tokenLimitOptions(opts),
          onProgress: info,
        }),
      );
      reportText(result);
      if (!result.text.trim()) throw new GenerationError('El modelo no devolvió texto.');
      writeOutput(opts.out, result.text.endsWith('\n') ? result.text : `${result.text}\n`);
      if (opts.out) info(`${kind === 'explain' ? 'Explicación' : 'Revisión'} escrita en ${opts.out}`);
    });
  }
}
