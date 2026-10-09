# Rendimiento con diagramas grandes

Qué pasa cuando un diagrama tiene cientos o miles de elementos: cuánto tardan el autolayout y el lienzo, qué se hizo al respecto (acción 11 de la fase 3 del [plan de robustecimiento](roadmap.md)), cómo se mide y qué fijan las pruebas. Las cifras salen de `npm run perf` y están anotadas tal como salieron, también las que no favorecen.

Qué cambia al usarlo:

- **El autolayout ya no congela la página.** ELK (el motor de colocación) es síncrono; antes corría en el hilo principal y un diagrama de 1000 nodos dejaba la página sin responder entre 12 y 13 s. Ahora corre en un Web Worker: la tarea más larga del hilo principal pasa de 12,6 s a 0,4 s (Integración, 1025 nodos) y de 13,4 s a 1,2 s (Seguridad, 1022 nodos).
- **Mientras calcula, el lienzo lo dice** («Calculando la colocación de N elementos…», pasados 400 ms) y deja **cancelar**: queda la colocación provisional en cuadrícula, se avisa y «Autolayout» lo reintenta.
- **Con diagramas grandes, la colocación sale antes**: a partir de 600 nodos se usa el modo rápido de ELK, que en Node ahorra del 40 al 65 % del tiempo en Integración, Seguridad y Datos (Plataforma casi no cambia; ver «Decisiones»).
- **El lienzo común monta solo lo que se ve** a partir de 150 nodos, y seleccionar o arrastrar un nodo ya no repinta los demás.
- **Las páginas cargan menos JavaScript**: ELK (≈1,4 MB) deja de ir en el trozo de C4 que descargaban todas las páginas. `suite.html` pasa de 1795 kB a 367 kB al abrir; `modulos.html`, de 2379 kB a 953 kB.

## Cómo se mide

```bash
npm run build:app                   # lo que miden el lienzo y los trozos (dist/app)
npm run perf                        # layout + lienzo + trozos con los tamaños por omisión (100, 500, 1000 y 2000)
npm run perf -- layout              # el autolayout (ELK) en Node: un proceso por caso, con tope de tiempo
npm run perf -- canvas              # el lienzo en un Chromium real: primer nodo, asentado, tareas largas, DOM, memoria
npm run perf -- chunks              # el tamaño de cada trozo de dist/app y la carga inicial de cada página
npm run perf -- canvas --elk thread # lo mismo con ELK en el hilo principal (?elk=thread), con la MISMA compilación
npm run perf -- canvas --c4 bench   # C4 en el lienzo común del banco de trabajo (por omisión se abre en el editor clásico)
npm run perf -- layout --modes normal,fast --sizes 1000,2000 --runs 1   # esfuerzo de ELK forzado (integración, datos, plataforma, seguridad)
```

Opciones: `--modules c4,integration,…`, `--sizes 100,500`, `--runs 3` (repeticiones por caso), `--timeout 180` (segundos por caso), `--port`, `--json salida.json`. Los diagramas salen de generadores deterministas (`tests/perf/generators.ts`: una semilla fija, 100/500/1000/2000 «nodos» por módulo, con relaciones y, donde el módulo lo permite, agrupaciones anidadas). `npm run perf` **no forma parte de `npm test` ni del CI**: el reloj de un CI es lento y variable.

Qué mide cada cosa:

- **Layout (ELK)** en Node: de `parse` a `layout`, la llamada de ELK; para C4, `layoutView` en sus modos `smart` (el de siempre: prueba varias variantes y se queda con la mejor), `fast` e `interactive`.
- **Primer nodo / Asentado** en Chromium: desde que empieza la navegación hasta que React Flow dibuja el primer nodo (el de la colocación provisional) y hasta que el lienzo está asentado (`data-layout="ready"`: autolayout aplicado y cámara encuadrada).
- **Tarea más larga / Bloqueado / Mayor hueco del pulso**: lo que estuvo sin responder el hilo principal (API Long Tasks, suma de lo que pasa de 50 ms, y el mayor hueco entre dos pulsos de un temporizador de 50 ms).
- **Nodos en el DOM** (`.react-flow__node` montados al terminar), **Montón JS** (memoria de JavaScript de la página tras forzar la recolección; **no incluye el hilo de trabajo**) y **RSS del navegador** (memoria residente de todos los procesos de Chromium, hilo de trabajo incluido).

**Máquina**: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 núcleos, 15.7 GB de RAM, Node v22.22.0, linux. Chromium 141 sin pantalla (headless, sin GPU). Fecha: 2026-10-09. Medida con la máquina compartida con otros procesos del entorno: una pasada intermedia del lienzo se hizo con la carga en torno a 7 (4 núcleos) y salió hasta un 40 % peor en C4, así que **se descartó y se repitió con la máquina en reposo (carga 1–2)**; las tablas de «Después» son de esa segunda pasada. Aun así, trata las cifras como órdenes de magnitud y compara siempre dentro de una misma tabla: entre paréntesis van el mínimo y el máximo de las 3 repeticiones.

Dos particularidades de los generadores que conviene saber:

- Los diagramas sintéticos son **enormes en superficie** (el de Integración con 2050 nodos ocupa 67 583 × 144 483 px, el de Seguridad con 2042, 84 935 × 164 904 px): muchos componentes sueltos que ELK apila. Uno real de 1000 nodos suele ser más compacto.
- En el banco de trabajo, **Empresarial** abre su primera vista (`capabilities`), que no es la `landscape` que dibuja el generador y muestra de 20 a 400 elementos con la colocación propia del módulo (no pasa por ELK). Por eso sus filas del lienzo no crecen con el tamaño. En la tabla de ELK en Node, en cambio, sí se mide la vista `landscape` con 102–2040 nodos.

## Antes

Commit `25de5fd` (el primero de esta rama: solo añade el generador y el script de medición; no cambia el comportamiento).

### Autolayout (ELK en Node)

| Módulo | Modo | Tamaño | Nodos | Aristas | Validar | Proyectar | Layout (ELK) | Construir flujo |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| c4 | smart | 100 | 99 | 150 | 2 ms (1 ms–6 ms) | - | 3655 ms (3468 ms–5149 ms) | - |
| c4 | smart | 500 | 499 | 734 | 15 ms (4 ms–20 ms) | - | 30.2 s (27.8 s–38.6 s) | - |
| c4 | smart | 1000 | 999 | 1504 | 12 ms (11 ms–17 ms) | - | 97.9 s (97.7 s–98.6 s) | - |
| c4 | smart | 2000 | - | - | - | - | **más de 420 s (cortado)** | - |
| c4 | fast | 100 | 99 | 150 | 3 ms (1 ms–6 ms) | - | 399 ms (265 ms–684 ms) | - |
| c4 | fast | 500 | 499 | 734 | 7 ms (6 ms–19 ms) | - | 2198 ms (1972 ms–2740 ms) | - |
| c4 | fast | 1000 | 999 | 1504 | 12 ms (12 ms–27 ms) | - | 6903 ms (6641 ms–7273 ms) | - |
| c4 | fast | 2000 | 1999 | 2994 | 17 ms (11 ms–35 ms) | - | 27.0 s (26.9 s–27.5 s) | - |
| c4 | interactive | 100 | 99 | 150 | 2 ms (1 ms–7 ms) | - | 3466 ms (3286 ms–3917 ms) | - |
| c4 | interactive | 500 | 499 | 734 | 8 ms (5 ms–15 ms) | - | 28.2 s (28.2 s–28.6 s) | - |
| c4 | interactive | 1000 | 999 | 1504 | 15 ms (10 ms–38 ms) | - | 102.1 s (100.4 s–104.0 s) | - |
| c4 | interactive | 2000 | - | - | - | - | **más de 420 s (cortado)** | - |
| integration | default | 100 | 104 | 94 | 1 ms (1 ms–5 ms) | 1 ms (1 ms–3 ms) | 463 ms (379 ms–826 ms) | 1 ms (1 ms–2 ms) |
| integration | default | 500 | 514 | 475 | 9 ms (5 ms–11 ms) | 20 ms (20 ms–40 ms) | 3857 ms (3259 ms–4549 ms) | 5 ms (2 ms–6 ms) |
| integration | default | 1000 | 1025 | 961 | 21 ms (12 ms–28 ms) | 55 ms (49 ms–76 ms) | 10.1 s (9893 ms–11.1 s) | 5 ms (5 ms–7 ms) |
| integration | default | 2000 | 2050 | 1944 | 27 ms (10 ms–69 ms) | 254 ms (207 ms–367 ms) | 46.2 s (43.2 s–47.9 s) | 38 ms (33 ms–50 ms) |
| data | default | 100 | 102 | 82 | 2 ms (1 ms–8 ms) | 3 ms (1 ms–3 ms) | 275 ms (245 ms–600 ms) | 1 ms (1 ms–2 ms) |
| data | default | 500 | 504 | 398 | 7 ms (6 ms–20 ms) | 13 ms (4 ms–18 ms) | 744 ms (599 ms–1368 ms) | 3 ms (2 ms–5 ms) |
| data | default | 1000 | 1002 | 794 | 27 ms (22 ms–30 ms) | 23 ms (13 ms–29 ms) | 1336 ms (986 ms–2698 ms) | 6 ms (3 ms–8 ms) |
| data | default | 2000 | 2004 | 1589 | 35 ms (13 ms–39 ms) | 70 ms (45 ms–80 ms) | 2594 ms (1764 ms–3716 ms) | 10 ms (9 ms–18 ms) |
| enterprise | default | 100 | 102 | 118 | 6 ms (1 ms–8 ms) | 4 ms (1 ms–5 ms) | 275 ms (187 ms–397 ms) | 0 ms (0 ms–1 ms) |
| enterprise | default | 500 | 510 | 598 | 8 ms (6 ms–15 ms) | 7 ms (7 ms–19 ms) | 891 ms (743 ms–1284 ms) | 4 ms (2 ms–8 ms) |
| enterprise | default | 1000 | 1020 | 1198 | 25 ms (22 ms–35 ms) | 27 ms (21 ms–32 ms) | 2019 ms (1425 ms–2702 ms) | 7 ms (5 ms–16 ms) |
| enterprise | default | 2000 | 2040 | 2398 | 32 ms (21 ms–45 ms) | 44 ms (37 ms–95 ms) | 3839 ms (2978 ms–5271 ms) | 8 ms (5 ms–18 ms) |
| platform | default | 100 | 103 | 118 | 3 ms (2 ms–12 ms) | 3 ms (2 ms–7 ms) | 435 ms (408 ms–892 ms) | 0 ms (0 ms–5 ms) |
| platform | default | 500 | 502 | 585 | 17 ms (16 ms–23 ms) | 30 ms (18 ms–33 ms) | 3054 ms (2738 ms–3939 ms) | 2 ms (2 ms–4 ms) |
| platform | default | 1000 | 1004 | 1182 | 22 ms (20 ms–37 ms) | 79 ms (76 ms–88 ms) | 9489 ms (9334 ms–10.6 s) | 5 ms (4 ms–6 ms) |
| platform | default | 2000 | 2005 | 2395 | 57 ms (27 ms–62 ms) | 283 ms (248 ms–288 ms) | 30.0 s (29.0 s–32.3 s) | 25 ms (11 ms–41 ms) |
| security | default | 100 | 105 | 154 | 5 ms (2 ms–9 ms) | 2 ms (2 ms–6 ms) | 603 ms (424 ms–1026 ms) | 1 ms (1 ms–2 ms) |
| security | default | 500 | 515 | 738 | 19 ms (9 ms–21 ms) | 17 ms (7 ms–24 ms) | 5830 ms (5362 ms–6084 ms) | 5 ms (4 ms–6 ms) |
| security | default | 1000 | 1022 | 1506 | 36 ms (21 ms–44 ms) | 30 ms (28 ms–37 ms) | 15.0 s (14.2 s–18.3 s) | 10 ms (6 ms–22 ms) |
| security | default | 2000 | 2042 | 2997 | 63 ms (51 ms–76 ms) | 62 ms (55 ms–93 ms) | 64.7 s (51.9 s–66.1 s) | 24 ms (14 ms–111 ms) |

Lectura: el coste crece más que linealmente. A 1000 nodos, de 7 s (C4 `fast`) a 98 s (C4 `smart`, que prueba varias variantes de ELK); a 2000 nodos, Integración tarda 46 s, Seguridad 65 s y C4 `smart` pasa de los 420 s (el caso se cortó). Datos y Empresarial son baratos (3–4 s a 2000 nodos). El modo `interactive` de C4 salió igual que `smart`: en las vistas con jerarquía (la del generador) recurre a la misma estrategia, así que no es una alternativa más rápida. En Node no hay nada que bloquear; en el navegador, ELK corría en el hilo principal.

### Lienzo en Chromium (ELK en el hilo principal)

| Módulo | Nodos | Aristas | Primer nodo | Asentado | Layout (página) | Tarea más larga | Bloqueado (>50 ms) | Mayor hueco del pulso | Nodos en el DOM | Montón JS | RSS del navegador | Estado «calculando» |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| c4 | 99 | 150 | 4584 ms (4578 ms–4663 ms) | 4707 ms (4693 ms–4778 ms) | - | 545 ms (520 ms–559 ms) | 3124 ms (3070 ms–3199 ms) | 601 ms (576 ms–637 ms) | 100 / 4132 elem. | 27 MB | 814 MB | no |
| c4 | 499 | 734 | 20.7 s (20.3 s–21.1 s) | 21.4 s (20.9 s–21.8 s) | - | 1515 ms (1482 ms–1601 ms) | 19.3 s (18.8 s–19.7 s) | 1943 ms (1544 ms–2015 ms) | 500 / 19572 elem. | 68 MB | 917 MB | no |
| c4 | 999 | 1504 | 60.0 s (58.2 s–60.4 s) | 62.0 s (60.3 s–62.6 s) | - | 3337 ms (3236 ms–3385 ms) | 59.8 s (58.1 s–60.4 s) | 4613 ms (4611 ms–4673 ms) | 1000 / 39272 elem. | 122 MB | 1049 MB | no |
| c4 | 2000 | 2994 | **no asentado en 240 s** | | | 13.4 s | 243.9 s | 16.2 s | 2000 | 227 MB | 1306 MB | |
| integration | 104 | 94 | 443 ms (435 ms–449 ms) | 2255 ms (2117 ms–2399 ms) | 1563 ms (1486 ms–1696 ms) | 855 ms (855 ms–880 ms) | 1389 ms (1328 ms–1518 ms) | 1123 ms (1089 ms–1142 ms) | 104 / 1698 elem. | 23 MB | 813 MB | no |
| integration | 514 | 475 | 666 ms (517 ms–691 ms) | 9033 ms (8706 ms–9325 ms) | 7712 ms (7545 ms–8193 ms) | 4116 ms (3941 ms–4292 ms) | 8032 ms (7697 ms–8411 ms) | 4759 ms (4724 ms–4935 ms) | 514 / 7712 elem. | 73 MB | 894 MB | no |
| integration | 1025 | 961 | 1018 ms (982 ms–1110 ms) | 27.0 s (25.6 s–27.5 s) | 24.9 s (22.6 s–25.4 s) | 12.6 s (11.6 s–13.0 s) | 26.0 s (24.5 s–26.4 s) | 13.8 s (12.9 s–14.3 s) | 1025 / 15270 elem. | 157 MB | 1011 MB | no |
| integration | 2050 | 1944 | 1310 ms (1287 ms–1689 ms) | 86.1 s (74.3 s–96.3 s) | 83.5 s (71.5 s–93.0 s) | 41.1 s (36.5 s–46.7 s) | 85.4 s (73.7 s–95.5 s) | 42.8 s (38.9 s–49.6 s) | 2050 / 30440 elem. | 455 MB | 1402 MB | no |
| data | 102 | 82 | 365 ms (348 ms–428 ms) | 1222 ms (1207 ms–1269 ms) | 668 ms (615 ms–668 ms) | 304 ms (303 ms–325 ms) | 484 ms (460 ms–499 ms) | 574 ms (507 ms–581 ms) | 102 / 1600 elem. | 18 MB | 799 MB | no |
| data | 504 | 398 | 506 ms (499 ms–593 ms) | 2484 ms (2461 ms–2762 ms) | 1754 ms (1718 ms–2041 ms) | 848 ms (817 ms–929 ms) | 1661 ms (1609 ms–1941 ms) | 1308 ms (1289 ms–1546 ms) | 504 / 7091 elem. | 36 MB | 845 MB | no |
| data | 1002 | 794 | 737 ms (682 ms–753 ms) | 3859 ms (3796 ms–3926 ms) | 2867 ms (2832 ms–2937 ms) | 1266 ms (1265 ms–1341 ms) | 2997 ms (2906 ms–3028 ms) | 2139 ms (2129 ms–2228 ms) | 1002 / 13913 elem. | 59 MB | 893 MB | no |
| data | 2004 | 1589 | 1084 ms (983 ms–1152 ms) | 6714 ms (6682 ms–6758 ms) | 5301 ms (5212 ms–5371 ms) | 2196 ms (2174 ms–2252 ms) | 5740 ms (5736 ms–5812 ms) | 3728 ms (3593 ms–3898 ms) | 2004 / 27630 elem. | 103 MB | 984 MB | no |
| enterprise | 20 | 0 | 286 ms (283 ms–288 ms) | 589 ms (578 ms–595 ms) | 17 ms (17 ms–22 ms) | 67 ms (59 ms–72 ms) | 17 ms (9 ms–22 ms) | 125 ms (93 ms–136 ms) | 20 / 488 elem. | 6 MB | 784 MB | no |
| enterprise | 100 | 0 | 334 ms (322 ms–340 ms) | 648 ms (640 ms–669 ms) | 40 ms (39 ms–42 ms) | 111 ms (107 ms–112 ms) | 61 ms (57 ms–76 ms) | 211 ms (187 ms–228 ms) | 100 / 1696 elem. | 8 MB | 786 MB | no |
| enterprise | 200 | 0 | 395 ms (389 ms–411 ms) | 775 ms (744 ms–781 ms) | 72 ms (70 ms–80 ms) | 189 ms (185 ms–199 ms) | 203 ms (171 ms–211 ms) | 371 ms (333 ms–379 ms) | 200 / 3206 elem. | 11 MB | 802 MB | no |
| enterprise | 400 | 0 | 646 ms (618 ms–697 ms) | 1174 ms (1111 ms–1197 ms) | 135 ms (135 ms–139 ms) | 414 ms (409 ms–474 ms) | 524 ms (507 ms–574 ms) | 693 ms (688 ms–736 ms) | 400 / 6226 elem. | 16 MB | 824 MB | no |
| platform | 89 | 118 | 330 ms (325 ms–345 ms) | 1421 ms (1412 ms–1488 ms) | 841 ms (813 ms–931 ms) | 402 ms (396 ms–482 ms) | 682 ms (650 ms–765 ms) | 616 ms (613 ms–732 ms) | 89 / 2083 elem. | 19 MB | 805 MB | no |
| platform | 442 | 585 | 506 ms (468 ms–517 ms) | 3480 ms (3400 ms–3544 ms) | 2605 ms (2559 ms–2677 ms) | 1261 ms (1191 ms–1276 ms) | 2580 ms (2518 ms–2690 ms) | 1881 ms (1799 ms–1916 ms) | 442 / 9434 elem. | 41 MB | 854 MB | no |
| platform | 885 | 1182 | 859 ms (759 ms–943 ms) | 7547 ms (6996 ms–7754 ms) | 5901 ms (5416 ms–6097 ms) | 2468 ms (2421 ms–2709 ms) | 6721 ms (6139 ms–6807 ms) | 3711 ms (3701 ms–4074 ms) | 885 / 18722 elem. | 69 MB | 909 MB | no |
| platform | 1785 | 2395 | 1353 ms (1329 ms–1364 ms) | 18.8 s (18.6 s–19.1 s) | 15.2 s (14.9 s–15.7 s) | 6606 ms (6346 ms–7749 ms) | 17.9 s (17.7 s–18.3 s) | 9473 ms (9160 ms–10.6 s) | 1785 / 37582 elem. | 126 MB | 1044 MB | no |
| security | 105 | 154 | 388 ms (342 ms–429 ms) | 2398 ms (2177 ms–2428 ms) | 1771 ms (1581 ms–1775 ms) | 905 ms (853 ms–941 ms) | 1597 ms (1420 ms–1603 ms) | 1208 ms (1149 ms–1230 ms) | 105 / 2245 elem. | 25 MB | 821 MB | no |
| security | 515 | 738 | 614 ms (587 ms–614 ms) | 11.6 s (11.1 s–11.7 s) | 10.5 s (10.0 s–10.6 s) | 5186 ms (4880 ms–5222 ms) | 10.7 s (10.2 s–10.8 s) | 5962 ms (5729 ms–6054 ms) | 515 / 10289 elem. | 95 MB | 923 MB | no |
| security | 1022 | 1506 | 1516 ms (1506 ms–1656 ms) | 28.8 s (28.8 s–32.9 s) | 26.3 s (26.2 s–30.2 s) | 13.4 s (13.2 s–14.8 s) | 28.1 s (28.1 s–32.1 s) | 15.5 s (15.4 s–17.1 s) | 1022 / 20539 elem. | 208 MB | 1081 MB | no |
| security | 2042 | 2997 | 4934 ms (4774 ms–5515 ms) | 114.7 s (105.1 s–123.9 s) | 105.7 s (96.2 s–114.5 s) | 51.4 s (46.7 s–56.6 s) | 113.9 s (104.3 s–123.0 s) | 58.7 s (53.6 s–64.5 s) | 2042 / 40805 elem. | 575 MB | 1576 MB | no |

Lectura: el hilo principal queda bloqueado casi todo lo que dura la colocación (columna «Bloqueado» ≈ «Asentado»): 12,6 s de una sola tarea con 1025 nodos de Integración, 41 s con 2050; 51 s de una tarea con 2042 nodos de Seguridad, que asienta a los 115 s. Todos los nodos estaban en el DOM (con 1000 nodos, unos 15 000 elementos en Integración, 20 000 en Seguridad y 39 000 en C4), y el montón de JavaScript llegaba a 455–575 MB con 2000 nodos. En el navegador la colocación de Integración y Seguridad tardó entre 1,7 y 2,5 veces lo que en Node con el mismo tamaño (24,9 s contra 10,1 s con 1000 nodos de Integración). El editor C4 (`index.html`) no asentó el caso de 2000 nodos en 240 s.

### Trozos de la compilación

| Trozo | Tamaño | gzip | En la carga inicial de |
|---|---:|---:|---|
| `domain-c4-N8I54U48.js` | 1683.1 kB | 518.3 kB | index.html, modulos.html, suite.html, trazabilidad.html |
| `elk-276RUBZZ-DWITELAW.js` | 1456.4 kB | 446.1 kB | bajo demanda |
| `chunk-FOHPRMQF-DzxwRta7.js` | 662.1 kB | 141.6 kB | bajo demanda |
| `main-Bdh1fDza.js` | 437.5 kB | 121.6 kB | index.html |
| `ProjectsDialog-i2YlRP_Z.js` | 435.7 kB | 132.7 kB | index.html, modulos.html |
| `cytoscape.esm-Yq6u8L66.js` | 434.9 kB | 136.5 kB | bajo demanda |
| `katex-ZlcWpGUi.js` | 258.7 kB | 76.3 kB | bajo demanda |
| `chunk-O7XYJQB3-D7o3F7is.js` | 239.5 kB | 36.5 kB | bajo demanda |
| `src-BsAxAjsP.js` | 226.9 kB | 71.2 kB | bajo demanda |
| `usecaseDiagram-POWQR4AR-DA0XIRjQ.js` | 186.7 kB | 49.7 kB | bajo demanda |
| `src-BQ1BZCzA.js` | 185.2 kB | 60.6 kB | bajo demanda |
| `architectureDiagram-NJMV4G6O-uRt8PFuH.js` | 148.9 kB | 40.7 kB | bajo demanda |
| `src-UtY5Ch2Y.js` | 145.5 kB | 48.5 kB | bajo demanda |
| `src-CnJU8J4J.js` | 131.6 kB | 42.6 kB | bajo demanda |
| `sequenceDiagram-PO4LG4MO-Ded1fp59.js` | 117.3 kB | 31.0 kB | bajo demanda |
| `chunk-7INBJB4K-Dix7gr9C.js` | 115.5 kB | 28.8 kB | bajo demanda |
| `modulos-vXVv6xSm.js` | 108.3 kB | 33.5 kB | modulos.html |
| `swimlanes-2SLR337P-jb-x0G3-.js` | 106.2 kB | 35.6 kB | bajo demanda |
| `browser-DK8YNcLO.js` | 96.6 kB | 29.7 kB | bajo demanda |
| `zod-C3StKava.js` | 94.7 kB | 26.4 kB | index.html, modulos.html, suite.html, trazabilidad.html |

| Página | Carga inicial (JS) | gzip | Trozos |
|---|---:|---:|---:|
| index.html | 2704.5 kB | 817.6 kB | 8 |
| modulos.html | 2379.1 kB | 731.2 kB | 9 |
| suite.html | 1794.8 kB | 552.0 kB | 7 |
| trazabilidad.html | 1804.5 kB | 554.7 kB | 6 |

Lectura: el trozo `domain-c4` (1683 kB) llevaba dentro ELK (≈1,4 MB), el módulo C4 y el núcleo, y **lo descargaban todas las páginas** en su carga inicial. Tres trozos pasaban de 500 kB (`domain-c4`, la copia de ELK de mermaid y el analizador de mermaid), con `chunkSizeWarningLimit: 2000` para que Vite no avisara.

## Qué se cambió

### 1. ELK fuera del hilo principal (`packages/kernel/src/graph/elk.ts`, `elkWorker.ts`)

`layoutElk(grafo, { signal })` decide dónde corre ELK y devuelve el mismo grafo JSON de siempre:

- **Navegador con `Worker`**: un hilo de trabajo (`elkWorker.ts`) con su copia de ELK. Atiende de uno en uno (ELK es síncrono dentro del hilo; encolar varios no los acelera y sí impediría descartar los que ya no hacen falta). Cancelar un cálculo en cola lo descarta; cancelar el que está en marcha **termina el hilo** (ELK no se puede interrumpir desde dentro) y el siguiente arranca otro.
- **Sin `Worker`** (Node, jsdom, el hilo de cálculo de `iark serve`), **o si el hilo no arranca** (la política de seguridad lo bloquea, no se encuentra su archivo): ELK se carga bajo demanda (`import()`) y corre en el hilo actual, como hasta ahora. Es la «salida de emergencia» y es lo que usan todas las pruebas y el CLI.
- `?elk=thread` en la dirección fuerza el hilo principal (diagnóstico y comparaciones).
- `layoutGraph` (el autolayout genérico) y el layout de C4 (`packages/domain-c4/src/layout/elkLayout.ts`: se cambió solo la llamada a ELK; los candidatos, la calidad y el resto no se tocaron) usan la misma API que antes. `layoutGraph` admite además `signal` (cancelar) y `effort: 'fast'`.
- La política de seguridad de `iark serve` (`default-src 'self'; script-src 'self'`) permite un hilo de trabajo del mismo origen (`worker-src` cae en `script-src`); no permitiría uno `blob:`, por eso el hilo es un archivo del sitio. Lo fija `tests/e2e/seguridad-cabeceras.spec.ts`.
- ELK tiene **dos protocolos** y el empaquetado con `new ELK()` falla dentro de un hilo de trabajo (`elk-worker.min.js` se instala como `onmessage` cuando detecta que no hay `document`): por eso `elkWorker.ts` solo importa `elk-worker.min.js` y `elk.ts` (`nativeElkWorker`) habla su protocolo (`register` y `layout`).

### 2. El lienzo común (`src/modules-app/canvas/DiagramCanvas.tsx`, `autolayout.ts`, `stable.ts`)

- **Estado «calculando» visible y cancelable**: pasados 400 ms de cálculo aparece «Calculando la colocación de N elementos…» con el botón «Cancelar». Cambiar de vista o de estructura mientras tanto cancela el cálculo anterior (no compite por el hilo); al desmontar también.
- **Recorte de nodos fuera de pantalla** (`onlyRenderVisibleElements`) con 150 o más nodos (`CULL_FROM_NODES`). Por debajo se montan todos (cada nodo queda en el DOM para lectores de pantalla y tabulador). La selección, la comparación («Comparar») y los enlaces no dependen del DOM, así que funcionan con nodos fuera de pantalla; el encuadre usa los tamaños declarados, no los medidos. `?cull=on|off` en la dirección lo fuerza (diagnóstico; las pruebas con jsdom que necesitan todos los nodos lo apagan).
- **Objetos estables** (`stable.ts`): `buildFlow` rehace todos los nodos y aristas en cada cambio; `decorateNodes`/`decorateEdges` conservan el objeto anterior de cada uno mientras no cambie lo que dibuja (selección, posición arrastrada, marca de comparación), porque React Flow compara por identidad. Seleccionar un nodo cambia un objeto, no cientos.
- **Sin recálculos de más**: el autolayout solo se rehace cuando cambia la estructura (`structureKey`, que ahora se memoiza), no al editar un texto de propiedades; lo fija una prueba.
- `autolayoutGraph` (`autolayout.ts`) saca del componente la colocación para que la calcule igual el script de medición; deja una marca de User Timing `iark:autolayout` por cada cálculo (se ve en el panel «Rendimiento» del navegador).

### 3. Trozos de la compilación (`vite.config.ts`)

- ELK deja de ir dentro de `domain-c4`: el hilo de trabajo es su propio archivo (`elkWorker-*.js`) y la salida de emergencia, el trozo `elk-hilo-principal-*.js`, que solo se descarga si no hay hilo de trabajo. `domain-c4` pasa de 1683 kB a 255 kB.
- `chunkSizeWarningLimit` baja de 2000 a **1600 kB**. No se pudo llegar a los 500 kB de Vite: ELK (≈1,43 MB) es un único archivo minificado que no se puede partir, y sale en tres sitios (el hilo de trabajo, la salida de emergencia y la copia 0.9.3 que trae mermaid para su layout `elk`), los tres bajo demanda. **La vara real** no es el aviso (solo admite un número) sino `tests/e2e/tamano-trozos.spec.ts`: ningún trozo pasa de **500 kB** salvo cuatro excepciones con su motivo y su propio tope (`scripts/perf/limites.ts`): ELK ×3 y el analizador de mermaid (≈660 kB, también bajo demanda).
- La carga de cada módulo ya era perezosa (`import()` en `src/modules-app/modules.ts`); lo que la ensanchaba era ELK dentro del trozo de C4.

## Después

Commit `27b90de` y siguientes (las tablas se midieron con la compilación de ese código).

### Autolayout (ELK en Node)

| Módulo | Modo | Tamaño | Nodos | Aristas | Validar | Proyectar | Layout (ELK) | Construir flujo | Extensión del dibujo |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| integration | default | 100 | 104 | 94 | 2 ms (1 ms–5 ms) | 1 ms (1 ms–4 ms) | 398 ms (333 ms–967 ms) | 1 ms (1 ms–3 ms) | 7333 × 3234 px |
| integration | default | 500 | 514 | 475 | 5 ms (4 ms–11 ms) | 17 ms (16 ms–19 ms) | 3309 ms (3200 ms–3990 ms) | 4 ms (3 ms–4 ms) | 22274 × 30720 px |
| integration | default | 1000 | 1025 | 961 | 18 ms (11 ms–19 ms) | 53 ms (52 ms–58 ms) | 4144 ms (3948 ms–5557 ms) | 8 ms (7 ms–14 ms) | 37637 × 70690 px |
| integration | default | 2000 | 2050 | 1944 | 14 ms (7 ms–36 ms) | 202 ms (194 ms–203 ms) | 14.9 s (14.1 s–16.3 s) | 18 ms (6 ms–21 ms) | 67583 × 144483 px |
| data | default | 100 | 102 | 82 | 2 ms (2 ms–12 ms) | 1 ms (1 ms–3 ms) | 145 ms (101 ms–661 ms) | 1 ms (0 ms–1 ms) | 2752 × 3814 px |
| data | default | 500 | 504 | 398 | 10 ms (4 ms–14 ms) | 7 ms (6 ms–15 ms) | 476 ms (399 ms–1125 ms) | 3 ms (2 ms–4 ms) | 5324 × 16564 px |
| data | default | 1000 | 1002 | 794 | 16 ms (13 ms–18 ms) | 20 ms (11 ms–23 ms) | 610 ms (485 ms–1420 ms) | 4 ms (4 ms–7 ms) | 6097 × 30163 px |
| data | default | 2000 | 2004 | 1589 | 25 ms (19 ms–38 ms) | 46 ms (45 ms–51 ms) | 1100 ms (916 ms–2111 ms) | 11 ms (5 ms–27 ms) | 8576 × 54457 px |
| enterprise | default | 100 | 102 | 118 | 2 ms (1 ms–10 ms) | 1 ms (1 ms–2 ms) | 125 ms (87 ms–552 ms) | 0 ms (0 ms–1 ms) | 2810 × 4469 px |
| enterprise | default | 500 | 510 | 598 | 10 ms (4 ms–14 ms) | 5 ms (3 ms–8 ms) | 442 ms (385 ms–1002 ms) | 2 ms (2 ms–3 ms) | 5590 × 25000 px |
| enterprise | default | 1000 | 1020 | 1198 | 13 ms (13 ms–19 ms) | 13 ms (9 ms–20 ms) | 737 ms (588 ms–1458 ms) | 4 ms (3 ms–5 ms) | 8170 × 45916 px |
| enterprise | default | 2000 | 2040 | 2398 | 30 ms (17 ms–32 ms) | 38 ms (38 ms–46 ms) | 1666 ms (1507 ms–2538 ms) | 9 ms (9 ms–12 ms) | 13190 × 91139 px |
| platform | default | 100 | 103 | 118 | 3 ms (2 ms–12 ms) | 3 ms (2 ms–7 ms) | 425 ms (358 ms–939 ms) | 0 ms (0 ms–2 ms) | 5580 × 4563 px |
| platform | default | 500 | 502 | 585 | 15 ms (9 ms–20 ms) | 25 ms (25 ms–36 ms) | 3081 ms (2803 ms–3984 ms) | 2 ms (2 ms–3 ms) | 19769 × 26918 px |
| platform | default | 1000 | 1004 | 1182 | 21 ms (17 ms–35 ms) | 80 ms (73 ms–90 ms) | 9206 ms (8525 ms–10.2 s) | 4 ms (4 ms–6 ms) | 41956 × 64348 px |
| platform | default | 2000 | 2005 | 2395 | 44 ms (43 ms–60 ms) | 270 ms (221 ms–327 ms) | 29.2 s (28.4 s–31.8 s) | 16 ms (13 ms–23 ms) | 73453 × 154404 px |
| security | default | 100 | 105 | 154 | 2 ms (2 ms–7 ms) | 2 ms (1 ms–5 ms) | 481 ms (439 ms–1015 ms) | 1 ms (1 ms–2 ms) | 6971 × 6766 px |
| security | default | 500 | 515 | 738 | 14 ms (7 ms–17 ms) | 12 ms (8 ms–17 ms) | 5546 ms (5124 ms–5548 ms) | 4 ms (3 ms–4 ms) | 25998 × 37177 px |
| security | default | 1000 | 1022 | 1506 | 26 ms (24 ms–29 ms) | 19 ms (18 ms–30 ms) | 7247 ms (6175 ms–7455 ms) | 9 ms (7 ms–15 ms) | 46824 × 78318 px |
| security | default | 2000 | 2042 | 2997 | 42 ms (31 ms–51 ms) | 61 ms (55 ms–61 ms) | 23.1 s (22.3 s–27.0 s) | 16 ms (12 ms–25 ms) | 84935 × 164904 px |

C4 no se volvió a medir en Node: su algoritmo no cambió (solo la llamada a ELK; ver las tablas del lienzo para C4 en el navegador). Con el modo rápido (≥ 600 nodos) los tiempos bajan: Integración 1025 nodos, de 10,1 s a 4,1 s; 2050, de 46,2 s a 14,9 s; Seguridad 2042, de 64,7 s a 23,1 s; Datos 2004, de 2594 ms a 1100 ms; Plataforma casi no cambia (30,0 s → 29,2 s: su coste no está en minimizar cruces). El dibujo mide lo mismo: en una pasada de una repetición con `--modes normal,fast`, la extensión de Integración con 2050 nodos fue idéntica (67 583 × 144 483 px) y la de Seguridad con 2042 nodos, 87 285 × 170 480 px (normal) y 84 935 × 164 904 px (rápido).

### Lienzo en Chromium (ELK en el hilo de trabajo)

| Módulo | Nodos | Aristas | Primer nodo | Asentado | Layout (página) | Tarea más larga | Bloqueado (>50 ms) | Mayor hueco del pulso | Nodos en el DOM | Montón JS | RSS del navegador | Estado «calculando» |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| c4 | 99 | 150 | 4518 ms (4424 ms–4599 ms) | 4643 ms (4547 ms–4725 ms) | - | 173 ms (171 ms–196 ms) | 234 ms (230 ms–300 ms) | 250 ms (247 ms–301 ms) | 100 / 4132 elem. | 14 MB | 921 MB | no |
| c4 | 499 | 734 | 21.3 s (20.9 s–21.6 s) | 21.9 s (21.6 s–22.3 s) | - | 652 ms (513 ms–753 ms) | 5642 ms (5499 ms–5661 ms) | 1070 ms (906 ms–1129 ms) | 500 / 19572 elem. | 42 MB | 1045 MB | no |
| c4 | 999 | 1504 | 63.9 s (62.5 s–66.0 s) | 66.0 s (64.7 s–68.1 s) | - | 1800 ms (1648 ms–1924 ms) | 20.2 s (19.3 s–20.5 s) | 2707 ms (2592 ms–2858 ms) | 1000 / 39272 elem. | 78 MB | 1144 MB | no |
| c4 | 2000 | 2994 | **no asentado en 240 s** | | | 5055 ms | 62.6 s | 7764 ms | 2000 | 148 MB | 1343 MB | |
| integration | 104 | 94 | 245 ms (218 ms–265 ms) | 1444 ms (1435 ms–1489 ms) | 940 ms (928 ms–950 ms) | 87 ms (84 ms–88 ms) | 37 ms (34 ms–38 ms) | 171 ms (153 ms–172 ms) | 104 / 1698 elem. | 9 MB | 861 MB | sí |
| integration | 514 | 475 | 379 ms (379 ms–404 ms) | 4901 ms (4695 ms–5367 ms) | 4015 ms (3845 ms–4385 ms) | 209 ms (206 ms–236 ms) | 503 ms (436 ms–577 ms) | 366 ms (344 ms–368 ms) | 157 / 4164 elem. | 16 MB | 995 MB | sí |
| integration | 1025 | 961 | 537 ms (522 ms–577 ms) | 6273 ms (6207 ms–6688 ms) | 5249 ms (5196 ms–5264 ms) | 429 ms (365 ms–439 ms) | 832 ms (762 ms–1201 ms) | 675 ms (637 ms–679 ms) | 41 / 4014 elem. | 18 MB | 1111 MB | sí |
| integration | 2050 | 1944 | 964 ms (950 ms–982 ms) | 18.0 s (16.9 s–19.0 s) | 16.2 s (15.0 s–16.7 s) | 801 ms (792 ms–830 ms) | 2089 ms (2047 ms–2511 ms) | 1403 ms (1371 ms–1409 ms) | 0 / 6341 elem. | 27 MB | 1511 MB | sí |
| data | 102 | 82 | 243 ms (242 ms–256 ms) | 1005 ms (999 ms–1008 ms) | 501 ms (493 ms–502 ms) | 90 ms (85 ms–92 ms) | 40 ms (35 ms–42 ms) | 177 ms (156 ms–187 ms) | 102 / 1600 elem. | 9 MB | 834 MB | sí |
| data | 504 | 398 | 363 ms (346 ms–366 ms) | 2022 ms (1894 ms–2039 ms) | 1205 ms (1101 ms–1210 ms) | 199 ms (194 ms–206 ms) | 425 ms (393 ms–449 ms) | 338 ms (304 ms–357 ms) | 186 / 3129 elem. | 14 MB | 907 MB | sí |
| data | 1002 | 794 | 507 ms (444 ms–524 ms) | 2726 ms (2712 ms–2777 ms) | 1607 ms (1603 ms–1647 ms) | 335 ms (297 ms–338 ms) | 893 ms (889 ms–894 ms) | 566 ms (544 ms–577 ms) | 214 / 4034 elem. | 18 MB | 943 MB | sí |
| data | 2004 | 1589 | 750 ms (710 ms–818 ms) | 4178 ms (4090 ms–4459 ms) | 2658 ms (2611 ms–2803 ms) | 594 ms (560 ms–633 ms) | 1674 ms (1575 ms–1753 ms) | 1056 ms (1015 ms–1093 ms) | 209 / 5156 elem. | 25 MB | 1014 MB | sí |
| enterprise | 20 | 0 | 228 ms (216 ms–237 ms) | 516 ms (493 ms–527 ms) | 17 ms (15 ms–19 ms) | 67 ms (61 ms–69 ms) | 17 ms (11 ms–19 ms) | 116 ms (89 ms–132 ms) | 20 / 488 elem. | 6 MB | 774 MB | no |
| enterprise | 100 | 0 | 273 ms (266 ms–308 ms) | 589 ms (582 ms–614 ms) | 36 ms (36 ms–42 ms) | 112 ms (110 ms–116 ms) | 69 ms (67 ms–72 ms) | 221 ms (216 ms–228 ms) | 100 / 1696 elem. | 8 MB | 778 MB | no |
| enterprise | 200 | 0 | 354 ms (338 ms–356 ms) | 749 ms (723 ms–758 ms) | 65 ms (57 ms–76 ms) | 198 ms (177 ms–198 ms) | 218 ms (194 ms–226 ms) | 394 ms (356 ms–395 ms) | 200 / 3206 elem. | 10 MB | 795 MB | no |
| enterprise | 400 | 0 | 539 ms (539 ms–549 ms) | 1117 ms (1113 ms–1117 ms) | 120 ms (110 ms–120 ms) | 391 ms (389 ms–402 ms) | 544 ms (537 ms–561 ms) | 712 ms (712 ms–712 ms) | 400 / 6226 elem. | 15 MB | 815 MB | no |
| platform | 89 | 118 | 276 ms (247 ms–276 ms) | 1185 ms (1128 ms–1201 ms) | 658 ms (634 ms–670 ms) | 99 ms (92 ms–110 ms) | 61 ms (42 ms–72 ms) | 178 ms (175 ms–215 ms) | 89 / 2083 elem. | 10 MB | 856 MB | sí |
| platform | 442 | 585 | 413 ms (410 ms–419 ms) | 2464 ms (2411 ms–2570 ms) | 1624 ms (1617 ms–1744 ms) | 230 ms (224 ms–253 ms) | 453 ms (396 ms–466 ms) | 388 ms (382 ms–414 ms) | 64 / 2733 elem. | 14 MB | 916 MB | sí |
| platform | 885 | 1182 | 555 ms (546 ms–596 ms) | 3556 ms (3339 ms–3563 ms) | 2387 ms (2223 ms–2439 ms) | 410 ms (400 ms–456 ms) | 986 ms (920 ms–993 ms) | 672 ms (672 ms–729 ms) | 81 / 3830 elem. | 18 MB | 952 MB | sí |
| platform | 1785 | 2395 | 1154 ms (1127 ms–1159 ms) | 6731 ms (6606 ms–6805 ms) | 4784 ms (4662 ms–4948 ms) | 992 ms (976 ms–1016 ms) | 2164 ms (2014 ms–2226 ms) | 1482 ms (1458 ms–1527 ms) | 30 / 4899 elem. | 25 MB | 1013 MB | sí |
| security | 105 | 154 | 262 ms (238 ms–263 ms) | 1683 ms (1618 ms–1696 ms) | 1140 ms (1062 ms–1146 ms) | 99 ms (95 ms–108 ms) | 77 ms (75 ms–92 ms) | 219 ms (206 ms–224 ms) | 105 / 2245 elem. | 10 MB | 898 MB | sí |
| security | 515 | 738 | 482 ms (477 ms–501 ms) | 6856 ms (6717 ms–6935 ms) | 5811 ms (5665 ms–5920 ms) | 338 ms (322 ms–356 ms) | 713 ms (665 ms–734 ms) | 506 ms (488 ms–532 ms) | 100 / 4781 elem. | 18 MB | 1032 MB | sí |
| security | 1022 | 1506 | 1348 ms (1294 ms–1397 ms) | 9259 ms (9201 ms–9395 ms) | 7228 ms (6977 ms–7236 ms) | 1204 ms (1164 ms–1257 ms) | 1987 ms (1747 ms–2104 ms) | 1486 ms (1403 ms–1531 ms) | 20 / 6153 elem. | 23 MB | 1229 MB | sí |
| security | 2042 | 2997 | 4544 ms (4521 ms–4873 ms) | 26.4 s (26.1 s–27.3 s) | 20.9 s (20.6 s–21.6 s) | 4415 ms (4392 ms–4744 ms) | 5611 ms (5567 ms–5850 ms) | 4911 ms (4856 ms–5241 ms) | 1 / 8176 elem. | 33 MB | 1646 MB | sí |

### Antes → después (medianas del lienzo)

| Módulo | Nodos | Asentado | Tarea más larga del hilo principal | Bloqueado (>50 ms, suma) | Nodos en el DOM | Montón JS |
|---|---:|---:|---:|---:|---:|---:|
| c4 | 99 | 4707 ms → 4643 ms | 545 ms → 173 ms | 3124 ms → 234 ms | 100 → 100 | 27 → 14 MB |
| c4 | 499 | 21.4 s → 21.9 s | 1515 ms → 652 ms | 19.3 s → 5642 ms | 500 → 500 | 68 → 42 MB |
| c4 | 999 | 62.0 s → 66.0 s | 3337 ms → 1800 ms | 59.8 s → 20.2 s | 1000 → 1000 | 123 → 78 MB |
| c4 | 1999 | no asentó en 240 s → no asentó en 240 s | no asentó en 240 s → no asentó en 240 s | no asentó en 240 s → no asentó en 240 s | 2000 → 2000 | 227 → 148 MB |
| integration | 104 | 2255 ms → 1444 ms | 855 ms → 87 ms | 1389 ms → 37 ms | 104 → 104 | 23 → 9 MB |
| integration | 514 | 9033 ms → 4900 ms | 4116 ms → 209 ms | 8032 ms → 503 ms | 514 → 157 | 73 → 16 MB |
| integration | 1025 | 27.0 s → 6273 ms | 12.6 s → 429 ms | 26.0 s → 832 ms | 1025 → 41 | 157 → 18 MB |
| integration | 2050 | 86.1 s → 18.0 s | 41.1 s → 801 ms | 85.4 s → 2089 ms | 2050 → 0 | 455 → 27 MB |
| data | 102 | 1222 ms → 1005 ms | 304 ms → 90 ms | 484 ms → 40 ms | 102 → 102 | 18 → 9 MB |
| data | 504 | 2484 ms → 2022 ms | 848 ms → 199 ms | 1661 ms → 425 ms | 504 → 186 | 36 → 14 MB |
| data | 1002 | 3859 ms → 2726 ms | 1266 ms → 335 ms | 2997 ms → 893 ms | 1002 → 214 | 59 → 18 MB |
| data | 2004 | 6714 ms → 4178 ms | 2196 ms → 594 ms | 5740 ms → 1674 ms | 2004 → 209 | 103 → 25 MB |
| enterprise | 20 | 589 ms → 516 ms | 67 ms → 67 ms | 17 ms → 17 ms | 20 → 20 | 6 → 6 MB |
| enterprise | 100 | 648 ms → 589 ms | 111 ms → 112 ms | 61 ms → 69 ms | 100 → 100 | 8 → 8 MB |
| enterprise | 200 | 775 ms → 749 ms | 189 ms → 198 ms | 203 ms → 218 ms | 200 → 200 | 11 → 10 MB |
| enterprise | 400 | 1174 ms → 1117 ms | 414 ms → 391 ms | 524 ms → 544 ms | 400 → 400 | 16 → 15 MB |
| platform | 89 | 1421 ms → 1185 ms | 402 ms → 99 ms | 682 ms → 61 ms | 89 → 89 | 19 → 10 MB |
| platform | 442 | 3480 ms → 2464 ms | 1261 ms → 230 ms | 2580 ms → 453 ms | 442 → 64 | 41 → 14 MB |
| platform | 885 | 7546 ms → 3556 ms | 2468 ms → 410 ms | 6721 ms → 986 ms | 885 → 81 | 69 → 18 MB |
| platform | 1785 | 18.8 s → 6731 ms | 6606 ms → 992 ms | 17.9 s → 2164 ms | 1785 → 30 | 126 → 25 MB |
| security | 105 | 2398 ms → 1683 ms | 905 ms → 99 ms | 1597 ms → 77 ms | 105 → 105 | 25 → 10 MB |
| security | 515 | 11.6 s → 6856 ms | 5186 ms → 338 ms | 10.7 s → 713 ms | 515 → 100 | 95 → 18 MB |
| security | 1022 | 28.8 s → 9258 ms | 13.4 s → 1204 ms | 28.1 s → 1987 ms | 1022 → 20 | 208 → 22 MB |
| security | 2042 | 114.7 s → 26.4 s | 51.4 s → 4415 ms | 113.9 s → 5611 ms | 2042 → 1 | 575 → 33 MB |

«Montón JS» es el de la última repetición y no incluye el hilo de trabajo. Lectura:

- **El hilo principal ya no se bloquea con el cálculo**: la tarea más larga baja de 12,6 s a 0,43 s (Integración, 1025 nodos), de 41,1 s a 0,80 s (Integración, 2050), de 13,4 s a 1,2 s (Seguridad, 1022) y de 51,4 s a 4,4 s (Seguridad, 2042). El tiempo asentado cae de 27,0 s a 6,3 s (Integración, 1025), de 86,1 s a 18,0 s (Integración, 2050), de 28,8 s a 9,3 s (Seguridad, 1022) y de 114,7 s a 26,4 s (Seguridad, 2042). Parte de esa mejora es el modo rápido de ELK, no el hilo de trabajo (ver la tabla siguiente).
- **Se montan muchos menos nodos**: de 1025 a 41 en Integración, de 2042 a 1 en Seguridad. (Con 0–1 nodos en pantalla no es una avería: con diagramas de ese tamaño el encuadre llega al zoom mínimo, 0,1, y la zona central no tiene ningún nodo; antes los nodos estaban en el DOM pero tampoco se veían; el minimapa muestra dónde está el dibujo.)
- **Memoria**: el montón de JavaScript de la página cae (455 → 27 MB con 2050 nodos de Integración; 575 → 33 MB con 2042 de Seguridad), pero la memoria residente de todo el navegador **sube un poco** (1402 → 1511 MB y 1576 → 1646 MB): el hilo de trabajo tiene su propia copia de ELK y su propio montón.
- **C4 en el editor clásico** (`index.html`, `src/app/`, que no se tocó y no recorta nodos; ver abajo C4 en el lienzo común): ELK ya no es lo que bloquea (tiempo bloqueado de 19,3 s a 5,6 s con 499 nodos y de 59,8 s a 20,2 s con 999), pero el resto del cálculo de C4 (`smartLayout`: evaluar candidatos, rutas, calidad) sigue en el hilo principal, y **la colocación no es más rápida**: 21,4 s → 21,9 s con 499 nodos y 62,0 s → 66,0 s con 999 (un 6 % más lento, con los rangos sin solaparse; no se investigó). Con 2000 nodos sigue sin asentar en 240 s. El editor clásico de C4 no muestra «Calculando…» ni deja cancelar (es el de `src/app/`, que no se tocó).

### C4 en el lienzo común del banco de trabajo

Tras fusionar `master` (C4 pasó a abrirse también en el lienzo común: `modulos.html?module=c4`), se midió C4 ahí (`npm run perf -- canvas --c4 bench`, 3 repeticiones, commit `74b6bb3`), con el hilo de trabajo y con `?elk=thread` (misma compilación, una pasada con cada opción seguidas).

Con el hilo de trabajo:

| Módulo | Nodos | Aristas | Primer nodo | Asentado | Layout (página) | Tarea más larga | Bloqueado (>50 ms) | Mayor hueco del pulso | Nodos en el DOM | Montón JS | RSS del navegador | Estado «calculando» |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| c4 | 100 | 150 | 237 ms (231 ms–268 ms) | 7181 ms (7175 ms–7398 ms) | 6663 ms (6660 ms–6876 ms) | 88 ms (84 ms–98 ms) | 73 ms (49 ms–84 ms) | 172 ms (165 ms–184 ms) | 100 / 2028 elem. | 10 MB | 947 MB | sí |
| c4 | 500 | 734 | 372 ms (332 ms–485 ms) | 30.6 s (29.2 s–31.4 s) | 29.8 s (28.5 s–30.7 s) | 558 ms (511 ms–575 ms) | 8661 ms (8090 ms–8700 ms) | 562 ms (517 ms–581 ms) | 89 / 2795 elem. | 14 MB | 1008 MB | sí |
| c4 | 1000 | 1504 | 462 ms (449 ms–495 ms) | 89.2 s (87.5 s–90.4 s) | 88.2 s (86.3 s–89.3 s) | 1531 ms (1520 ms–1534 ms) | 32.7 s (32.0 s–33.9 s) | 1547 ms (1522 ms–1572 ms) | 96 / 4055 elem. | 20 MB | 1133 MB | sí |

Con ELK en el hilo principal (`?elk=thread`):

| Módulo | Nodos | Aristas | Primer nodo | Asentado | Layout (página) | Tarea más larga | Bloqueado (>50 ms) | Mayor hueco del pulso | Nodos en el DOM | Montón JS | RSS del navegador | Estado «calculando» |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| c4 | 100 | 150 | 264 ms (244 ms–280 ms) | 7859 ms (7721 ms–7940 ms) | 7333 ms (7184 ms–7382 ms) | 523 ms (512 ms–563 ms) | 5121 ms (5003 ms–5189 ms) | 914 ms (906 ms–935 ms) | 100 / 2029 elem. | 23 MB | 794 MB | sí |
| c4 | 500 | 734 | 386 ms (366 ms–408 ms) | 38.9 s (38.3 s–39.7 s) | 37.9 s (37.4 s–38.6 s) | 1485 ms (1417 ms–1611 ms) | 35.2 s (34.6 s–36.0 s) | 2665 ms (2562 ms–2933 ms) | 89 / 2796 elem. | 41 MB | 836 MB | sí |
| c4 | 1000 | 1504 | 564 ms (531 ms–565 ms) | 123.6 s (119.6 s–125.4 s) | 121.6 s (117.4 s–123.3 s) | 3704 ms (3540 ms–3962 ms) | 119.7 s (115.8 s–121.6 s) | 7939 ms (6745 ms–8532 ms) | 96 / 4056 elem. | 65 MB | 877 MB | sí |

Lectura: el tiempo que tarda en asentarse **es el de siempre o algo menor** (100 nodos, 7,9 s → 7,2 s; 500, 38,9 s → 30,6 s; 1000, 123,6 s → 89,2 s), pero el hilo principal queda libre: lo bloqueado pasa de 5,1 s a 73 ms (100 nodos), de 35,2 s a 8,7 s (500) y de 119,7 s a 32,7 s (1000). Lo que sigue bloqueando es el resto del cálculo de C4 (`smartLayout` evalúa candidatos y rutas en el hilo principal, con ELK en el hilo de trabajo): tareas de hasta 1,5 s con 1000 nodos. El estado «Calculando…» sí aparece y deja cancelar (la señal de cancelación llega hasta ELK, y `smartLayout` la comprueba entre candidatos). Con 1000 nodos solo se montan 96 en el DOM (recorte).

### Hilo de trabajo contra hilo principal con la misma compilación

La comparación más limpia: la misma compilación, una pasada con cada opción seguidas (`npm run perf -- canvas --elk thread` contra el valor por omisión), con la máquina en reposo. Aquí **solo** cambia dónde corre ELK (el modo rápido actúa en las dos).

| Módulo | Nodos | Asentado (hilo principal) | Asentado (hilo de trabajo) | Tarea más larga (principal) | Tarea más larga (trabajo) | Bloqueado (principal) | Bloqueado (trabajo) |
|---|---:|---:|---:|---:|---:|---:|---:|
| c4 | 99 | 4812 ms | 4963 ms | 500 ms | 213 ms | 3134 ms | 316 ms |
| c4 | 499 | 21.9 s | 22.3 s | 1609 ms | 632 ms | 19.7 s | 5818 ms |
| integration | 104 | 1856 ms | 1457 ms | 731 ms | 95 ms | 1132 ms | 51 ms |
| integration | 514 | 7925 ms | 4986 ms | 3779 ms | 208 ms | 7138 ms | 479 ms |
| security | 105 | 2103 ms | 1719 ms | 817 ms | 102 ms | 1331 ms | 89 ms |
| security | 515 | 11.2 s | 6957 ms | 5230 ms | 349 ms | 10.4 s | 755 ms |

El hilo de trabajo no acelera el cálculo (C4: 21,9 s contra 22,3 s; es un hilo más, con el coste de pasar el grafo): lo que hace es dejar libre el hilo principal. En Integración con 514 nodos, la tarea más larga pasa de 3,8 s a 0,2 s y lo bloqueado, de 7,1 s a 0,5 s. En Seguridad con 515 nodos, de 5,2 s a 0,35 s. El propio cálculo también salió más rápido en el hilo de trabajo que en el principal en Integración y Seguridad (el layout visto desde la página: 4,1 s contra 7,2 s con 514 nodos de Integración; no se investigó por qué).

### Trozos de la compilación

| Trozo | Tamaño | gzip | En la carga inicial de |
|---|---:|---:|---|
| `elk-276RUBZZ-FOqlE9Of.js` | 1456.4 kB | 446.2 kB | bajo demanda |
| `elk-hilo-principal-DhtxzzJY.js` | 1431.1 kB | 435.4 kB | bajo demanda |
| `elkWorker-bWnmAZJ6.js` | 1424.0 kB | 432.7 kB | bajo demanda |
| `chunk-FOHPRMQF-DzxwRta7.js` | 662.1 kB | 141.6 kB | bajo demanda |
| `main-3QlDzKX6.js` | 437.5 kB | 121.6 kB | index.html |
| `ProjectsDialog-ALigCR1Y.js` | 435.7 kB | 132.7 kB | index.html, modulos.html |
| `cytoscape.esm-Yq6u8L66.js` | 434.9 kB | 136.5 kB | bajo demanda |
| `katex-ZlcWpGUi.js` | 258.7 kB | 76.3 kB | bajo demanda |
| `domain-c4-BUfjuaEo.js` | 256.1 kB | 84.5 kB | index.html, modulos.html, suite.html, trazabilidad.html |
| `chunk-O7XYJQB3-DLGBgliJ.js` | 239.5 kB | 36.5 kB | bajo demanda |
| `src-BEwYF6Pq.js` | 226.8 kB | 71.2 kB | bajo demanda |
| `usecaseDiagram-POWQR4AR-DULLahJ2.js` | 186.7 kB | 49.7 kB | bajo demanda |
| `src-2Zk2Ev8I.js` | 185.2 kB | 60.6 kB | bajo demanda |
| `architectureDiagram-NJMV4G6O-LQD4MJkh.js` | 148.9 kB | 40.7 kB | bajo demanda |
| `src-C0dq8ExO.js` | 145.5 kB | 48.5 kB | bajo demanda |
| `src-DRkrYIdL.js` | 131.6 kB | 42.6 kB | bajo demanda |
| `sequenceDiagram-PO4LG4MO-BoWlN_73.js` | 117.3 kB | 31.0 kB | bajo demanda |
| `chunk-7INBJB4K-C-A4oIfB.js` | 115.5 kB | 28.8 kB | bajo demanda |
| `modulos-BDJ-AY4W.js` | 111.4 kB | 34.5 kB | modulos.html |
| `swimlanes-2SLR337P-Di4T93en.js` | 106.2 kB | 35.6 kB | bajo demanda |

| Página | Carga inicial (JS) | gzip | Trozos |
|---|---:|---:|---:|
| index.html | 1276.4 kB | 383.3 kB | 8 |
| modulos.html | 954.1 kB | 297.9 kB | 9 |
| suite.html | 367.8 kB | 118.2 kB | 7 |
| trazabilidad.html | 376.4 kB | 120.4 kB | 6 |

Lectura: `domain-c4` pasa de 1683 kB a 255 kB y ya no arrastra ELK; las páginas cargan **menos** al abrirse (`index.html`, de 2704 kB a 1276 kB; `modulos.html`, de 2379 kB a 953 kB; `suite.html`, de 1795 kB a 367 kB; `trazabilidad.html`, de 1805 kB a 376 kB). El total de JavaScript de la compilación **sube** (8915 kB → 10 353 kB): ELK aparece dos veces más (hilo de trabajo y salida de emergencia), ambas bajo demanda y la segunda solo si no hay `Worker`. Tras fusionar `master` (que añadió más código a las páginas) la carga inicial medida con el comando de los trozos es: `index.html` 1309 kB, `modulos.html` 985 kB, `suite.html` 388 kB y `trazabilidad.html` 397 kB; las cuatro siguen por debajo de las de antes de la rama (2704, 2379, 1795 y 1805 kB).

## Decisiones (cambiables)

| Qué | Valor | Dónde | Por qué |
|---|---|---|---|
| Desde cuántos nodos el autolayout usa el modo rápido de ELK | 600 | `FAST_LAYOUT_FROM_NODES` en `src/modules-app/canvas/autolayout.ts` | De 500 a 2000 nodos el modo rápido ahorra del 40 al 60 % del tiempo en Integración y Seguridad (una repetición por caso) y deja prácticamente el mismo tamaño de dibujo; por debajo de 600 la colocación sigue siendo exactamente la de antes. No se midió la calidad visual (cruces) más allá del tamaño del dibujo. |
| Opciones del modo rápido | `thoroughness 1`, sin ajuste voraz de cruces | `FAST_OPTIONS` en `packages/kernel/src/graph/layout.ts` | Son las que reducen el tiempo sin cambiar capas ni espaciados. Plataforma casi no lo nota. |
| Desde cuántos nodos el lienzo recorta lo que no se ve | 150 | `CULL_FROM_NODES` en `DiagramCanvas.tsx` | Por debajo, montarlos todos es lo más barato y deja cada nodo en el DOM; por encima, cada nodo cuesta unos 15–20 elementos del DOM. |
| Cuándo aparece «Calculando…» | tras 400 ms | `BUSY_AFTER_MS` en `DiagramCanvas.tsx` | Evita el parpadeo en los diagramas pequeños. |
| Aviso de tamaño de Vite | 1600 kB (antes 2000) | `chunkSizeWarningLimit` en `vite.config.ts` | Lo justifica ELK (1,46 MB). La vara de verdad es el tope de 500 kB por trozo del e2e, con las excepciones de `scripts/perf/limites.ts`. |

## Qué fijan las pruebas

Ninguna prueba de `npm test` ni del CI falla por tiempo. Fijan lo estructural:

- `packages/kernel/src/graph/elk.test.ts`: el cálculo se pide al hilo de trabajo (un `Worker` de mentira), de uno en uno; cancelar uno en cola lo descarta, cancelar el que corre termina el hilo y el siguiente arranca otro; si no hay `Worker`, si crearlo lanza o si el hilo falla antes de contestar, se calcula en el hilo actual; `?elk=thread` lo fuerza; el protocolo de ELK.
- `src/modules-app/canvas/DiagramCanvas.scale.test.tsx`: con 1000 nodos se montan en el DOM muchos menos (el recorte), con menos de 150 se montan todos; la selección, el foco y los enlaces funcionan con nodos fuera de pantalla; el estado «calculando» y «Cancelar»; el aviso tras cancelar.
- `src/modules-app/canvas/stable.test.ts`: seleccionar o mover un nodo cambia solo su objeto.
- `tests/e2e/tamano-trozos.spec.ts` (sobre `dist/app`): 500 kB por trozo salvo las excepciones de `scripts/perf/limites.ts` (y que cada excepción siga haciendo falta), tope de carga inicial por página, y que ELK no esté en ninguna carga inicial. La lógica está en `scripts/perf/chunks.ts` y se prueba aparte (`tests/perf/chunks.test.ts`).
- `packages/domain-c4/src/layout/elkLayout.test.ts`: la señal de cancelación aborta el layout de C4 (también en `smartLayout`, entre candidatos) y no se confunde con un fallo que deba recuperarse.
- `tests/e2e/rendimiento-lienzo.spec.ts`: con un diagrama de 500 nodos, el cálculo corre en el hilo de trabajo (se ve en `page.on('worker')`) sin caer a la salida de emergencia, aparece «Calculando…» y la página responde mientras tanto (un umbral muy holgado: 4 s de hueco como máximo, frente a ≈10 s con ELK en el hilo principal), se puede cancelar y reintentar, y con la vista acercada solo se montan los nodos que caen en pantalla y se puede seleccionar uno.
- `tests/e2e/seguridad-cabeceras.spec.ts`: el hilo de trabajo funciona con la política de seguridad de `iark serve` puesta, sin violaciones.
- `tests/perf/generators.test.ts`: los generadores son deterministas y producen documentos válidos con los tamaños que dicen.

## Límites conocidos y pendiente

- **Editor clásico de C4 (`src/app/`)**: usa el hilo de trabajo a través del layout de C4, pero no tiene estado «calculando», no deja cancelar y no recorta nodos; en modo `smart` con 1000 nodos son más de 60 s. No se tocó en esta rama. En el lienzo común del banco de trabajo, C4 sí tiene «Calculando…», cancelación y recorte (ver arriba), pero `smartLayout` sigue evaluando candidatos en el hilo principal (tareas de hasta 1,5 s con 1000 nodos) y tarda 89 s en asentar: queda pendiente evaluarlo fuera del hilo principal o con menos candidatos a partir de cierto tamaño.
- **Tras llegar la colocación, el hilo principal aún trabaja** entre 0,4 s (1000 nodos) y 4–5 s (2000): copiar el resultado del hilo, construir el flujo y pintar. No se perfiló.
- **Sin simplificación a zoom lejano**: si el diagrama es denso y cabe entero en pantalla, el recorte no ahorra nada (se montan todos los nodos). Una versión reducida del nodo a zoom bajo sería lo siguiente.
- **El encuadre de diagramas enormes** llega al zoom mínimo (0,1) sin abarcarlos.
- **Interacción no medida**: no se midieron los fotogramas al arrastrar o al hacer zoom, ni cuánto tarda seleccionar un nodo, ni antes ni después. La mejora de «objetos estables» se fija con una prueba estructural, no con un tiempo.
- **Calidad del modo rápido**: solo se comparó el tamaño del dibujo; no se contaron cruces de aristas ni se revisó visualmente.
- **Memoria**: la residente de todo el navegador sube unos 70–110 MB por el hilo de trabajo.
- **Los generadores son sintéticos**: sirven para comparar antes y después, no para predecir cuánto tarda un diagrama real.
- **ELK 0.9.3 de mermaid** (el layout `elk` de la vista previa de Mermaid) sigue siendo una segunda copia de ELK en la compilación, bajo demanda; no se puede compartir con la 0.12.
- **Paquetes publicados** (`@iark/kernel`, `@iark/domain-*`): su `elkWorker.ts` no se publica; en un navegador esos paquetes caen en la salida de emergencia (ELK en el hilo principal), como antes. En Node, nada cambia.
