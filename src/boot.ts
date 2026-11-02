/**
 * Entrada de `/`. El inicio es la suite. El editor C4 clásico sigue en `/?editor=1` y, embebido, en `/?embed=1`.
 * `/?surface=home&embed=1` incrusta el inicio. `/?manifest=` monta el shell que descubre los módulos de una instancia.
 */
const params = new URLSearchParams(window.location.search);
const embed = params.get('embed') === '1';
const editor = params.get('editor') === '1' || (embed && params.get('surface') !== 'home');
// El protocolo embebido vive en el editor C4 anterior. `?classic=1` también lo abre a propósito.
const studio = !embed && params.get('classic') !== '1' && (params.get('studio') === '1' || params.get('editor') === '1');

if (studio) {
  await import('./studio/main.tsx');
} else if (editor) {
  await import('./app/main.tsx');
} else if (params.has('manifest')) {
  const { renderSuiteShell } = await import('./shell/document');
  renderSuiteShell();
  await import('./shell/main.ts');
} else {
  await import('./home/main.tsx');
}

export {};
