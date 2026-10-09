import type { es } from '../es';
import { comun } from './comun';
import { errores } from './errores';
import { barra } from './barra';
import { gestor } from './gestor';
import { historial } from './historial';
import { administracion } from './administracion';
import { editor } from './editor';

/** La traducción al inglés: el tipo obliga a tener todas las claves del catálogo de origen. */
export const en: Record<keyof typeof es, string> = { ...comun, ...errores, ...barra, ...gestor, ...historial, ...administracion, ...editor };
