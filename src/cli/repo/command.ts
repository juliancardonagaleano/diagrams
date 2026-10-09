import { InvalidArgumentError } from 'commander';
import { CliError, info } from '../io';
import { withClonedRepo } from './clone';
import { repoGlobProblem } from './filter';
import { formatReport, formatSummary } from './format';
import { repoInstruction } from './prompt';
import { MAX_BUDGET_BYTES, scanRepo, type RepoDigest } from './scan';
import { classifyRepoSource, isValidRepoRef, REF_ERROR } from './source';

/**
 * Pegamento entre el CLI y el escáner: opciones de `generate` y `prompt` (`--from-repo`, `--repo-ref`, `--repo-budget`,
 * `--dry-run`), su validación y el aviso de lo que se envía. `--from-repo` acepta una carpeta o la URL de un repositorio git
 * (se clona en superficial a un directorio temporal: ver `clone.ts`). Nada de esto se expone por `iark serve`: leería el
 * disco del servidor o abriría conexiones desde él.
 */

export const FROM_REPO_HELP = 'dibuja la arquitectura leyendo un repositorio: una carpeta local o la URL de git (https://, ssh:// o git@host:grupo/repo.git; se clona en superficial a un directorio temporal que se borra); al modelo solo se envía un resumen acotado y sin secretos (ver «Privacidad» abajo)';
export const FROM_REPO_PROMPT_HELP = 'incluye en el prompt un resumen de un repositorio: una carpeta local o la URL de git (se clona en superficial a un directorio temporal que se borra), acotado y sin secretos; ver `iark prompt --help`';
export const REPO_REF_HELP = 'con una URL en --from-repo: rama o etiqueta que se clona (por defecto, la rama por defecto del repositorio)';
export const REPO_INCLUDE_HELP = 'con --from-repo (repetible): limita el CONTENIDO del resumen a los archivos clave que cuadren con el patrón (formato .gitignore, relativo a la raíz); el árbol de carpetas sigue entero';
export const REPO_EXCLUDE_HELP = 'con --from-repo (repetible): quita del resumen (árbol y contenido) lo que cuadre con el patrón (formato .gitignore); se lista como omitido «excluido por --repo-exclude»';
export const REPO_BUDGET_HELP = 'con --from-repo: tamaño máximo del resumen en KB (por defecto 60, máximo 1024)';
export const DRY_RUN_HELP = 'con --from-repo: imprime el prompt completo (lo que se enviaría) y, por stderr, los archivos incluidos y omitidos con su motivo; no llama a ningún modelo (con una URL sí clona el repositorio, que necesita su contenido)';

/** Qué URL de git se aceptan y cómo se clonan; sale en `--help` de `generate` y de `prompt`. `destino` dice a quién llega el resumen. */
function repoUrlHelp(destino: string): string {
  return `
URL de git (--from-repo <url> [--repo-ref <rama|etiqueta>]):
  - Se aceptan https://host/grupo/repo.git, ssh://git@host/grupo/repo.git y la forma git@host:grupo/repo.git. Se rechazan http://
    (sin cifrar), git://, file://, ext:: y cualquier otro transporte, las URL con usuario o token dentro (usa el gestor de
    credenciales de git o ssh) y los valores que empiezan por «-». Una ruta que existe como carpeta local es siempre una carpeta.
  - Se ejecuta SOLO \`git clone\` (sin shell), en superficial (--depth 1, una rama, sin etiquetas ni submódulos ni hooks), en un
    directorio temporal que se borra siempre al terminar, también si falla o lo interrumpes. Tiempo máximo: 120 s. Después no se
    ejecuta nada del clon: se lee como una carpeta más. Los submódulos no se siguen.
  - Los repositorios privados usan la red y las credenciales que ya tengas en git (gestor de credenciales) y en ssh (claves,
    ssh-agent, ~/.ssh/config). DIAgrams no las lee, no las guarda ni las muestra, y git no pregunta contraseñas (falla en su lugar).
  - ${destino}`;
}

/** Los filtros `--repo-include` y `--repo-exclude`; sale en `--help` de `generate` y de `prompt`. */
const REPO_FILTER_HELP = `
Filtros (--repo-include <glob>, --repo-exclude <glob>; se pueden repetir):
  - Los patrones se escriben como en un .gitignore (sin «!») y son relativos a la raíz del repositorio: *.md vale en cualquier carpeta,
    docs/*.md solo en docs/, /src ancla a la raíz, legacy/ solo carpetas, ** cruza carpetas. Ejemplo: --repo-include 'services/pedidos/'
    --repo-exclude '**/*.test.ts' --repo-exclude 'legacy/'.
  - --repo-exclude quita lo que cuadre de TODO el resumen (árbol, componentes y contenido) y lo lista como «excluido por --repo-exclude».
  - --repo-include limita el contenido a los archivos clave que cuadren; el árbol de carpetas y la lista de componentes siguen enteros.
    Si ambos cuadran con un archivo, gana --repo-exclude. Solo reducen: no añaden archivos que la lista de archivos clave no lea.
  - Nunca hacen legible lo que la lista de secretos prohíbe: un --repo-include que nombre .env, una clave o *.tfstate no lo abre, y lo
    que entra sigue pasando por la redacción de secretos.`;

export const REPO_PRIVACY_HELP = `
Desde un repositorio (--from-repo <carpeta|url>):
  Lee una CARPETA LOCAL o CLONA una URL de git (ver abajo) y envía al modelo, junto a tu instrucción, un resumen acotado:
  árbol de carpetas, lenguajes, rutas de componentes y el contenido recortado de los archivos que revelan la arquitectura (README
  y docs, manifiestos, Dockerfile y compose, Kubernetes/Helm/Terraform, OpenAPI/AsyncAPI/proto/GraphQL, CI, esquemas SQL, puntos
  de entrada). El resto del código fuente solo aparece como nombres de carpetas y archivos, nunca su contenido. Combínalo con
  --module y con --from (refinar un documento existente).
${repoUrlHelp('--dry-run también clona (necesita el contenido) pero no llama a ningún modelo; sin --dry-run, el resumen\n    (acotado y sin secretos) va al modelo que elijas con --provider y --model.')}
${REPO_FILTER_HELP}

Privacidad:
  - Con una carpeta no ejecuta git ni nada del repositorio; con una URL ejecuta únicamente el \`git clone\` de arriba y nada del clon.
    No sigue enlaces simbólicos, no sale de la carpeta y respeta .gitignore (en un clon no se aplica: solo trae lo versionado).
  - No lee .env* (ni sus valores ni sus nombres; de .env.example solo los NOMBRES), claves privadas, credenciales, .npmrc, .netrc,
    *.tfstate, terraform.tfvars ni documentos Secret de Kubernetes. Omite node_modules, dist, build, vendor, binarios y lockfiles.
  - Todo el texto incluido pasa por una redacción de secretos (tokens, claves de API, JWT, cabeceras Authorization, contraseñas
    en asignaciones y cadenas de conexión, claves privadas PEM): el valor se sustituye por [REDACTADO].
  - El contenido del repositorio va al modelo como datos, no como instrucciones.
  - Topes: presupuesto del resumen (--repo-budget), máximo de archivos y de bytes por archivo.
  - --repo-include y --repo-exclude solo pueden reducir lo que se envía: nunca saltan la lista de secretos ni la redacción.
  - Antes de enviar, \`iark generate … --from-repo <carpeta|url> --dry-run\` (o \`iark prompt … --from-repo <carpeta|url>\`) muestra exactamente qué se enviaría, sin llamar a ningún modelo.`;

/** `--help` de `prompt`: lo de la URL (no lleva el bloque de privacidad entero, que está en `generate --help`). */
export const REPO_PROMPT_HELP = repoUrlHelp('`iark prompt` clona la URL (necesita el contenido) pero no llama a ningún modelo: imprime el prompt (con el resumen acotado y sin\n    secretos) para que lo pegues donde quieras. Privacidad completa (qué se lee, qué se omite, redacción de secretos): `iark generate --help`.') + REPO_FILTER_HELP;

/** `--repo-budget`: KB (admite decimales) → bytes. */
export function parseRepoBudget(value: string): number {
  const kb = Number.parseFloat(value);
  if (!Number.isFinite(kb) || kb < 1 || kb * 1024 > MAX_BUDGET_BYTES) {
    throw new InvalidArgumentError(`El presupuesto del resumen debe ser un número de KB entre 1 y ${MAX_BUDGET_BYTES / 1024}.`);
  }
  return Math.round(kb * 1024);
}

/** `--repo-ref`: nombre de rama o etiqueta (validado al leer la opción; nunca puede leerse como una opción de git). */
export function parseRepoRef(value: string): string {
  if (!isValidRepoRef(value)) throw new InvalidArgumentError(REF_ERROR);
  return value;
}

/** `--repo-include` / `--repo-exclude`: cada uso añade un patrón (validado al leer la opción). */
function globCollector(option: string): (value: string, previous: string[] | undefined) => string[] {
  return (value, previous) => {
    const problem = repoGlobProblem(value);
    if (problem) throw new InvalidArgumentError(`El patrón de ${option} no vale: ${problem}.`);
    return [...(previous ?? []), value];
  };
}
export const collectRepoInclude = globCollector('--repo-include');
export const collectRepoExclude = globCollector('--repo-exclude');

export interface RepoFlags {
  fromRepo?: string;
  repoRef?: string;
  repoInclude?: string[];
  repoExclude?: string[];
  repoBudget?: number;
  dryRun?: boolean;
}

/**
 * `--repo-ref`, `--repo-budget` y `--dry-run` solo tienen sentido con `--from-repo`, y `--repo-ref` solo con una URL. La URL se
 * valida aquí, antes de leer nada ni clonar (un valor inválido falla al instante).
 */
export function assertRepoFlags(opts: RepoFlags): void {
  if (opts.fromRepo !== undefined) {
    const source = classifyRepoSource(opts.fromRepo);
    if (opts.repoRef !== undefined && source.kind === 'folder') {
      throw new CliError('--repo-ref solo vale con una URL de git en --from-repo; una carpeta local se lee tal como está (haz el checkout de la rama que quieras antes).', 2);
    }
    return;
  }
  if (opts.repoRef !== undefined) throw new CliError('--repo-ref solo se usa junto con --from-repo <url> (la rama o etiqueta que se clona).', 2);
  if (opts.repoBudget !== undefined) throw new CliError('--repo-budget solo se usa junto con --from-repo <carpeta|url>.', 2);
  if (opts.repoInclude?.length) throw new CliError('--repo-include solo se usa junto con --from-repo <carpeta|url> (limita el contenido del resumen).', 2);
  if (opts.repoExclude?.length) throw new CliError('--repo-exclude solo se usa junto con --from-repo <carpeta|url> (quita archivos del resumen).', 2);
  if (opts.dryRun) throw new CliError('--dry-run solo se usa junto con --from-repo <carpeta|url> (es la vista previa de lo que se enviaría).', 2);
}

export interface RepoContext {
  digest: RepoDigest;
  /** La instrucción del usuario con el resumen del repositorio incorporado. */
  instruction: string;
}

/**
 * Lee lo de `--from-repo` (la carpeta, o el clon temporal de la URL) y construye la instrucción ampliada; `undefined` si no se
 * pidió. Con una URL avisa por stderr de que clona, y el directorio temporal desaparece antes de volver (también si falla).
 */
export async function prepareRepo(instruction: string, opts: RepoFlags, moduleId: string): Promise<RepoContext | undefined> {
  if (opts.fromRepo === undefined) return undefined;
  const source = classifyRepoSource(opts.fromRepo);
  let digest: RepoDigest;
  if (source.kind === 'folder') {
    digest = scanRepo(source.path, { budgetBytes: opts.repoBudget, include: opts.repoInclude, exclude: opts.repoExclude });
  } else {
    info(`Clonando ${source.display} (${opts.repoRef !== undefined ? `rama ${opts.repoRef}` : 'rama por defecto'}, historial superficial)…`);
    digest = await withClonedRepo({ url: source.url, ref: opts.repoRef, display: source.display }, (folder) => scanRepo(folder, { budgetBytes: opts.repoBudget, remote: { name: source.name }, include: opts.repoInclude, exclude: opts.repoExclude }));
  }
  return { digest, instruction: repoInstruction(instruction, digest, moduleId) };
}

/** Dice por stderr qué lleva el resumen; con `sending` (generate sin --dry-run), que se va a enviar al modelo. */
export function reportRepoSummary(digest: RepoDigest, sending = false): void {
  info(formatSummary(digest));
  if (sending) info('Se enviará este resumen al modelo junto con tu instrucción; para ver el texto exacto antes de enviar, repite el comando con --dry-run.');
  if (digest.redactions > 0) info(`Aviso: se redactaron ${digest.redactions} valor(es) con aspecto de secreto; con --dry-run puedes ver exactamente qué texto se envía.`);
}

/** La lista de archivos incluidos y omitidos con su motivo (`--dry-run`), por stderr: stdout queda solo con el prompt. */
export function reportRepoFiles(digest: RepoDigest): void {
  info(formatSummary(digest));
  info(formatReport(digest));
}
