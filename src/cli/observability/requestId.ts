import { randomUUID } from 'node:crypto';

/**
 * El identificador de cada petición de `iark serve`: sale en la cabecera de la respuesta `X-Request-Id`, en el registro de accesos, en la
 * auditoría y en el aviso de un error interno, para seguir una misma petición por todos ellos (y por el proxy, si este lo pone).
 *
 * Se acepta el que traiga la petición (`X-Request-Id`) si es sensato: de 1 a 64 caracteres entre letras, dígitos, `.`, `_`, `:` y `-`. Es lo
 * bastante laxo para los UUID, los identificadores de traza y los que ponen los proxies, y lo bastante estricto para que nunca pueda
 * contener comillas, saltos de línea ni nada que confunda a un lector de registros o parta una cabecera. Si no cumple (o no viene, o viene
 * repetido: Node lo une con «, ») se ignora y se genera un UUID v4. No es un secreto ni una identidad: quien llama elige el suyo, así que
 * sirve para correlacionar, nunca para autorizar.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const isSafeRequestId = (value: unknown): value is string => typeof value === 'string' && SAFE_REQUEST_ID.test(value);

export function requestIdFrom(header: string | string[] | undefined): string {
  return isSafeRequestId(header) ? header : randomUUID();
}
