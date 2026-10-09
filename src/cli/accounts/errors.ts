import { HttpError } from '../httpError';
import { AccountError } from './store';

/**
 * Los errores del almacén de cuentas, con el código HTTP que les corresponde y su `code`:
 * `invalid` 400, `not-found` 404, `limit`, `last-admin` y `conflict` 409, `not-invited` y `disabled` 403 (los de entrar, que ninguna ruta de
 * proyectos o de administración provoca). `unreachable` (la base de la red no responde o está saturada) es pasajero: 503 con `Retry-After`. Lo demás (el
 * archivo no se puede escribir) es un fallo del servicio: 500. En ambos casos el motivo va al registro del servidor (stderr), nunca a quien llama: ni la ruta
 * del disco ni el servidor, el usuario o la cadena de conexión de la base.
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
    case 'unreachable':
      process.stderr.write(`error de las cuentas: ${error.message}\n`);
      return new HttpError(503, 'El servicio no puede acceder a las cuentas ahora mismo (la base de datos no responde). Vuelva a intentarlo en unos segundos; si sigue así, avise a quien lo administra.', { code: 'unavailable' }, { 'Retry-After': '5' });
    default:
      process.stderr.write(`error de las cuentas: ${error.message}\n`);
      return new HttpError(500, 'El servicio no puede guardar las cuentas ahora mismo (permisos o disco). Avise a quien lo administra.', { code: 'unavailable' });
  }
}
