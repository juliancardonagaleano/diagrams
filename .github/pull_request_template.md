## Antes

<!-- Cómo era y por qué dolía: el síntoma, el límite o la ausencia. Si hay un issue, enlázalo (Cierra #123). -->

## Después

<!-- Cómo queda. Una frase sobre qué hace este cambio. -->

## Cómo

<!-- Qué se tocó y por qué así: los archivos o módulos clave, la decisión de diseño y las alternativas que descartaste. -->

## Verificación

<!-- Lo que ejecutaste y el resultado real, tal cual salió. No anotes lo que no corriste. Por ejemplo:
- `npm run typecheck`: sin errores
- `npx vitest run packages/domain-data`: pasan (pega el resumen real de Vitest)
- `npm run e2e`: no ejecutado (el cambio no toca el sitio)
-->

- [ ] `npm run typecheck`
- [ ] Pruebas relacionadas con el cambio (o `npm test`)
- [ ] `npm run verify` completo, si el cambio toca el sitio, el CLI o el empaquetado

## Lista de comprobación

- [ ] **Incluye pruebas** que fallaban antes del cambio (arreglos) o que cubren el comportamiento nuevo y sus bordes. Si no hacen falta (solo documentación o configuración), explica por qué en «Cómo».
- [ ] No añade dependencias sin declarar: `tests/dependencias-paquetes.test.ts` y `tests/runtime-deps.test.ts` pasan.
- [ ] Si cambia módulos, esquemas o el manifiesto, regeneré `npm run schema` y `npm run manifest`.
- [ ] Si cambia un esquema, subí `documentVersion`, añadí la migración y conservé la foto del documento antiguo (`tests/fixtures/documentos/`); ver `docs/versionado-documentos.md`.
- [ ] Comentarios y documentación en español, sin `any` nuevos.
- [ ] Es una sola PR por tema: nada ajeno a lo descrito arriba.

## Licencia

- [ ] Acepto que mi aportación se publique bajo la licencia [MIT](https://github.com/juliancardonagaleano/iark-diagrams/blob/master/LICENSE) del proyecto.
- [ ] No incluye código, iconos, logotipos ni textos de terceros sin licencia compatible con MIT (los iconos de nubes son glifos propios, no los logotipos oficiales).
- [ ] No describe una vulnerabilidad sin corregir: para eso, [SECURITY.md](https://github.com/juliancardonagaleano/iark-diagrams/blob/master/SECURITY.md).
