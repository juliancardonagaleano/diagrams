import { HttpError } from '../httpError';
import { AccountError } from './store';

/**
 * Los errores del almacén de cuentas, con el código HTTP que les corresponde y su `code`:
 * `invalid` 400, `not-found` 404, `limit`, `last-admin` y `conflict` 409, `not-invited` y `disabled` 403 (los de entrar, que ninguna ruta de
 * proyectos o de administración provoca). Lo demás (el archivo no se puede escribir) es un fallo del servicio: 500 sin la ruta del disco.
 */
export function accountHttpError(error: AccountError): HttpError {
  switch (error.code) {
    case 'invalid':
      return new HttpError(400, error.message, { code: 'invalid' });
    case 'not-found':
      return new HttpError(404, error.message, { code: 'not-found' });
    case 'limit':
    case 'last-admin':
    case 'conflict':
      return new HttpError(409, error.message, { code: error.code });
    case 'not-invited':
    case 'disabled':
      return new HttpError(403, error.message, { code: error.code });
    default:
      process.stderr.write(`error de las cuentas: ${error.message}\n`);
      return new HttpError(500, 'El servicio no puede guardar las cuentas ahora mismo (permisos o disco). Avise a quien lo administra.', { code: 'unavailable' });
  }
}
