import { comun } from './comun';
import { errores } from './errores';
import { barra } from './barra';
import { gestor } from './gestor';
import { historial } from './historial';
import { administracion } from './administracion';
import { editor } from './editor';

/** El catálogo de origen: de él salen las claves (`MessageKey`). El inglés (`../en`) debe tener las mismas claves y parámetros. */
export const es = { ...comun, ...errores, ...barra, ...gestor, ...historial, ...administracion, ...editor } as const;
