import type { IncomingMessage } from 'node:http';
import { HttpError } from './httpError';

/** Piezas comunes de las rutas JSON de `iark serve` (proyectos, miembros, administración): el cuerpo como objeto y los métodos admitidos. */

export type ReadBody = (req: IncomingMessage) => Promise<string>;

/** Responde 405 con la lista de métodos que admite la ruta. */
export const allow = (methods: string): never => {
  throw new HttpError(405, `Este endpoint solo admite ${methods}.`, { allow: methods });
};

/** ¿La petición trae `Content-Type: application/json`? (Un formulario o un `fetch` `no-cors` no pueden enviarlo.) */
export const isJson = (req: IncomingMessage): boolean => (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

/** El cuerpo como objeto JSON (400 si no lo es). */
export async function bodyObject(readBody: ReadBody, req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'El cuerpo debe ser JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'El cuerpo debe ser un objeto JSON.');
  return value as Record<string, unknown>;
}
