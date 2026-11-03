function e(){document.getElementById(`root`)?.remove(),document.title=`DIAgrams · Suite`;let e=document.createElement(`div`);e.className=`sh`,e.innerHTML=`
    <header class="sh-header mesa-bar" aria-label="Suite de DIAgrams">
      <h1 class="wb-title"><a class="wb-brand" href="./">DIAgrams <small>Suite</small></a></h1>
      <form id="manifest-form" aria-label="Instancia">
        <label class="wb-visually-hidden" for="manifest-url">Manifiesto de la instancia</label>
        <input id="manifest-url" type="text" spellcheck="false" />
        <button type="submit" class="primary">Conectar</button>
      </form>
      <a class="sh-link" href="/trace">Trazabilidad</a>
      <span class="wb-chip info" id="state" role="status">conectando…</span>
    </header>
    <div class="sh-body">
      <nav class="sh-nav" id="modules" aria-label="Módulos"></nav>
      <main class="sh-stage" id="stage" tabindex="-1" aria-label="Módulo abierto en la suite"></main>
      <aside class="sh-side">
        <div class="sh-info" id="info" tabindex="0" role="region" aria-label="Datos del módulo abierto"></div>
        <div class="wb-bar"><strong id="log-title">Eventos recibidos por postMessage</strong></div>
        <div class="sh-log" id="log" tabindex="0" role="region" aria-labelledby="log-title"></div>
      </aside>
    </div>`;let t=document.createElement(`a`);t.className=`wb-skip`,t.href=`#stage`,t.textContent=`Saltar al contenido`,document.body.append(t,e)}export{e as renderSuiteShell};