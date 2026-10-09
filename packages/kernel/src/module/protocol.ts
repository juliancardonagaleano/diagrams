import { compareMajorMinor, parseMajorMinor } from './version';

/**
 * Versión del protocolo `postMessage` entre la página anfitriona y el iframe embebido (el del editor C4 y el del banco de
 * trabajo de módulos), en formato `mayor.menor`. Sube la menor cuando se añaden campos, acciones o eventos opcionales (lo
 * desconocido se ignora); sube la mayor cuando algo deja de entenderse. El apretón de manos (`init` del iframe y `load` del
 * anfitrión) la lleva, y `negotiateProtocol` decide si los dos lados pueden hablar.
 *
 * Sin dependencias a propósito (solo `version.ts`, que tampoco importa nada): lo usan el SDK de anfitrión y el Web Component.
 */
export const EMBED_PROTOCOL_VERSION = '1.0';

/** Lo que se asume de un lado que no declara versión: los anfitriones y embebidos anteriores a la negociación hablaban 1.0. */
export const DEFAULT_PROTOCOL_VERSION = '1.0';

/** Código del `error` que emite un lado cuando el otro habla una versión mayor distinta del protocolo. */
export const INCOMPATIBLE_PROTOCOL_CODE = 'incompatible-protocol';

export type ProtocolNegotiation =
  /** Pueden hablar: `version` es la menor de las dos (la que entienden ambos); lo que el otro lado añadió en una menor posterior se ignora. */
  | { ok: true; version: string; local: string; remote: string }
  /** No pueden: la versión mayor difiere (`major`) o la del otro lado ilegible (`invalid`). `message` está dicho para quien lo lee. */
  | { ok: false; reason: 'major' | 'invalid'; local: string; remote: string; message: string };

/**
 * Decide si el lado local (versión `local`) y el remoto (`remote`) pueden hablar. Una diferencia de versión MAYOR es
 * incompatible; una de menor se acepta y se habla la menor de las dos. Un lado sin versión (`undefined`) se trata como 1.0.
 */
export function negotiateProtocol(local: string | undefined, remote: string | undefined): ProtocolNegotiation {
  const localVersion = local ?? DEFAULT_PROTOCOL_VERSION;
  const remoteVersion = remote ?? DEFAULT_PROTOCOL_VERSION;
  const mine = parseMajorMinor(localVersion);
  const theirs = parseMajorMinor(remoteVersion);
  if (!mine) {
    return { ok: false, reason: 'invalid', local: localVersion, remote: remoteVersion, message: `La versión local del protocolo embebido (${JSON.stringify(localVersion)}) no tiene el formato «mayor.menor».` };
  }
  if (!theirs) {
    return {
      ok: false,
      reason: 'invalid',
      local: localVersion,
      remote: remoteVersion,
      message: `La versión del protocolo embebido del otro lado (${JSON.stringify(remoteVersion)}) no tiene el formato «mayor.menor»; este lado habla la ${localVersion}.`,
    };
  }
  if (mine.major !== theirs.major) {
    const older = mine.major < theirs.major ? 'este lado' : 'el otro lado';
    return {
      ok: false,
      reason: 'major',
      local: localVersion,
      remote: remoteVersion,
      message: `Protocolo embebido incompatible: este lado habla la versión ${localVersion} y el otro la ${remoteVersion} (la versión mayor es distinta). Actualiza ${older}, que es el más antiguo.`,
    };
  }
  return { ok: true, version: compareMajorMinor(mine, theirs) <= 0 ? localVersion : remoteVersion, local: localVersion, remote: remoteVersion };
}
