# Trazabilidad entre módulos

[← Índice de la documentación](indice.md)

Los elementos de un documento pueden apuntar a los de otro módulo con una referencia estable `ref: "urn:iark:<módulo>:<id>"` (por ejemplo, un servicio de plataforma que realiza un sistema de integración, o un activo de seguridad que es un servicio de plataforma). Ningún módulo conoce el código de otro: `iark trace` reúne los documentos y sigue esos enlaces.

```bash
# Enlaces por par de módulos y referencias sin resolver
iark trace integration=examples/pedidos-integracion.json platform=examples/plataforma-ejemplo.json security=examples/seguridad-ejemplo.json
# Impacto de tocar un sistema de integración: qué se apoya en él, entre módulos (y de qué se apoya)
iark trace integration=… platform=… security=… --from integration:pedidos --direction referrers
iark trace … --format mermaid   # un subgrafo por módulo; --format svg para el dibujo; --format json para otras herramientas; --strict falla (código 3) con URN mal formadas o inexistentes
```

- `--direction refs|referrers|both` y `--depth n` acotan el alcance; sin `--from` se muestra el grafo completo.
- Un módulo sin documento aportado no invalida los enlaces hacia él: se listan como «sin resolver» (y no rompen `--strict`).
- El servicio HTTP expone lo mismo en `POST /api/trace` (ver [Servicio HTTP](servicio.md#servicio-http-iark-serve); devuelve el grafo, el informe, el Mermaid y el SVG) y `generate --from …` conserva los `ref` del documento base al refinar con IA, aunque el modelo no los conozca.
- **En la web**: `trazabilidad.html` reúne los documentos de los módulos (ejemplos, archivos o JSON pegado, sin subir nada a ningún servidor), dibuja el grafo con un recuadro por módulo, lista los enlaces por par de módulos y las referencias sin resolver, y calcula el alcance de un elemento (quién se apoya en él, de qué se apoya y a cuántos saltos). Usa el mismo código que el CLI. Se llega desde el banco de trabajo y desde el shell de la suite.
- Los ejemplos (`examples/*.json`) ya traen una cadena real: empresarial → integración, plataforma → integración y seguridad → plataforma.
