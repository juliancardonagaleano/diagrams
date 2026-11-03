/**
 * Entrada de `/`. El inicio es la suite. Rutas canónicas (`/studio`, `/editor`, `/modules/:id`, …) las resuelve
 * `src/shell/spaRoutes.ts`; las consultas históricas (`/?editor=1`, `/?manifest=`, `/?embed=1`) siguen igual.
 */
import { bootSpaTarget, resolveSpaBootTarget } from './shell/spaRoutes';

const params = new URLSearchParams(window.location.search);
const target = resolveSpaBootTarget(window.location.pathname, params);
await bootSpaTarget(target);

export {};
