import { normalizeBaseUrl } from '@iark/kernel';

/**
 * El servidor que el sitio propone por omisión. Es para quien aloja el frontend aparte del servicio (por ejemplo el sitio en GitHub
 * Pages y `iark serve` en otra máquina): se fija al compilar con `VITE_IARK_SERVER` (en el despliegue de Pages sale de la variable del
 * repositorio `IARK_SERVER_URL`) y SOLO rellena la dirección del panel «Dónde se guardan»: no conecta, no inicia sesión y no cambia el
 * sitio donde se guardan los proyectos hasta que la persona pulse «Conectar» o «Entrar con GitHub». Una dirección guardada de antes
 * manda siempre.
 *
 * Solo se acepta una dirección que el navegador puede usar de verdad: `https://`, o `http://` en la propia máquina. Cualquier otra cosa
 * (vacía, mal escrita, `http://` ajeno, con usuario o contraseña) se ignora en silencio: un error de configuración no debe romper el panel.
 */
export function defaultServerUrl(raw: string | undefined = import.meta.env?.VITE_IARK_SERVER): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.username || url.password) return undefined;
    const loopback = url.hostname === 'localhost' || /^127(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return undefined;
    return normalizeBaseUrl(text);
  } catch {
    return undefined;
  }
}
