import { ProjectError, type ProjectErrorCode, type ProjectErrorReason } from '@iark/kernel';
import { formatBytes } from './format';
import { getLang, tAny, type MessageKey } from './index';

/**
 * El texto de cada motivo de error (`ProjectError.info.reason`). El `Record` exige una clave por cada motivo que el núcleo declara: añadir un motivo
 * al tipo sin su texto no compila. Las claves están escritas enteras (no se arman con el motivo) para que la prueba de paridad las vea usadas.
 */
export const REASON_KEYS: Record<ProjectErrorReason, MessageKey> = {
  'name-not-text': 'error.name-not-text',
  'name-empty': 'error.name-empty',
  'name-too-long': 'error.name-too-long',
  'module-invalid': 'error.module-invalid',
  'document-not-text': 'error.document-not-text',
  'project-missing': 'error.project-missing',
  'diagram-missing': 'error.diagram-missing',
  'diagram-missing-in': 'error.diagram-missing-in',
  'project-exists': 'error.project-exists',
  'diagram-exists': 'error.diagram-exists',
  'diagram-module-fixed': 'error.diagram-module-fixed',
  'diagram-changed': 'error.diagram-changed',
  'version-missing': 'error.version-missing',
  'bundle-not-json': 'error.bundle-not-json',
  'bundle-not-project': 'error.bundle-not-project',
  'bundle-invalid': 'error.bundle-invalid',
  'bundle-newer': 'error.bundle-newer',
  'bundle-duplicate-id': 'error.bundle-duplicate-id',
  'bundle-no-content': 'error.bundle-no-content',
  'policy-range': 'error.policy-range',
  'version-id-invalid': 'error.version-id-invalid',
  'version-limit': 'error.version-limit',
  'version-unnamed': 'error.version-unnamed',
  'versions-unsupported': 'error.versions-unsupported',
  'address-invalid': 'error.address-invalid',
  'address-scheme': 'error.address-scheme',
  'address-credentials': 'error.address-credentials',
  'login-missing': 'error.login-missing',
  'server-no-session': 'error.server-no-session',
  'server-no-member': 'error.server-no-member',
  'server-no-account': 'error.server-no-account',
  'server-no-restore': 'error.server-no-restore',
  'server-no-version': 'error.server-no-version',
  'server-not-json': 'error.server-not-json',
  'server-timeout': 'error.server-timeout',
  'server-unreachable': 'error.server-unreachable',
  'server-versions-unsupported': 'error.server-versions-unsupported',
  'last-admin': 'error.last-admin',
  'account-locked': 'error.account-locked',
  limit: 'error.limit',
  'limit-projects': 'error.limit-projects',
  'limit-diagrams': 'error.limit-diagrams',
  'limit-bytes': 'error.limit-bytes',
  'invalid-grant': 'error.invalid-grant',
  'token-required': 'error.token-required',
  'token-forbidden': 'error.token-forbidden',
  'rate-limited': 'error.rate-limited',
  'rate-limited-wait': 'error.rate-limited-wait',
  'too-large': 'error.too-large',
  'bad-request': 'error.bad-request',
  'no-projects-api': 'error.no-projects-api',
  'http-error': 'error.http-error',
  'server-status': 'error.server-status',
  'server-status-detail': 'error.server-status-detail',
  'newer-unsaved': 'error.newer-unsaved',
  'logout-unsupported': 'error.logout-unsupported',
  'share-unsupported': 'error.share-unsupported',
  'admin-unsupported': 'error.admin-unsupported',
  'not-member-anymore': 'error.not-member-anymore',
  'diagram-gone': 'error.diagram-gone',
  'save-needs-project': 'error.save-needs-project',
  'history-unsupported': 'error.history-unsupported',
  'restore-conflict': 'error.restore-conflict',
  'restore-unsaved': 'error.restore-unsaved',
  'module-unknown': 'error.module-unknown',
  'storage-full': 'error.storage-full',
  'storage-unavailable': 'error.storage-unavailable',
  'storage-no-idb': 'error.storage-no-idb',
  'storage-blocked': 'error.storage-blocked',
  'login-no-crypto': 'error.login-no-crypto',
  'login-no-storage': 'error.login-no-storage',
  'offline-browser': 'error.offline-browser',
  'offline-check-failed': 'error.offline-check-failed',
  'offline-send-failed': 'error.offline-send-failed',
};

/** Qué significa cada código (`ProjectError.code`) cuando no hay un motivo más preciso. */
export const CODE_KEYS: Record<ProjectErrorCode, MessageKey> = {
  'not-found': 'error.code.not-found',
  exists: 'error.code.exists',
  invalid: 'error.code.invalid',
  conflict: 'error.code.conflict',
  unavailable: 'error.code.unavailable',
  unauthorized: 'error.code.unauthorized',
  forbidden: 'error.code.forbidden',
  unsupported: 'error.code.unsupported',
};

const KIND_KEYS: Record<string, MessageKey> = {
  project: 'error.kind.project',
  diagram: 'error.kind.diagram',
  version: 'error.kind.version',
  token: 'error.kind.token',
  name: 'error.kind.name',
};

const SETTING_KEYS: Record<string, MessageKey> = {
  coalesceSeconds: 'error.setting.coalesceSeconds',
  keepAutomatic: 'error.setting.keepAutomatic',
  maxVersions: 'error.setting.maxVersions',
};

/** Los parámetros del motivo como los necesita el texto: el tipo de nombre y el ajuste, traducidos; los tamaños, escritos como tamaños. */
function paramsFor(reason: ProjectErrorReason, raw: Record<string, string | number>): Record<string, string | number> {
  const params = { ...raw };
  if (typeof params.kind === 'string') params.kind = tAny(KIND_KEYS[params.kind] ?? 'error.kind.name');
  if (typeof params.setting === 'string' && SETTING_KEYS[params.setting]) params.setting = tAny(SETTING_KEYS[params.setting]);
  if (reason === 'limit-bytes') {
    if (typeof params.used === 'number') params.used = formatBytes(params.used);
    if (typeof params.limit === 'number') params.limit = formatBytes(params.limit);
  }
  return params;
}

/**
 * Lo que se le cuenta a la persona de un error. Se traduce por el motivo (`info.reason`) que puso el cliente y no por el texto, que viene en español
 * (o en el idioma del servidor). Reglas:
 * - En español, si el error trae el texto del servidor (`info.serverMessage`), se muestra ese: es lo que escribió el servidor, con su detalle.
 * - En otro idioma, con un motivo conocido, su traducción; un error del servidor sin motivo (por ejemplo «ya existe un proyecto llamado X») dice qué significa su
 *   código y añade entre paréntesis lo que dijo el servidor.
 * - Cualquier otra cosa (un `Error` cualquiera, un texto), su `message` tal cual.
 */
export function projectErrorText(error: unknown): string {
  if (!(error instanceof ProjectError)) return error instanceof Error ? error.message : String(error);
  const { reason, params, serverMessage } = error.info;
  if (getLang() === 'es' && serverMessage) return error.message;
  if (reason) {
    const key = REASON_KEYS[reason];
    if (key) return tAny(key, paramsFor(reason, params ?? {}));
  }
  if (getLang() === 'es') return error.message;
  const generic = tAny(CODE_KEYS[error.code]);
  return serverMessage ? tAny('error.with-server-text', { message: generic, serverMessage }) : error.message;
}
