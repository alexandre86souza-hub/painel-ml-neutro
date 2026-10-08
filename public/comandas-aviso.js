// Aviso de COMANDA NOVA em todas as telas (carregado pelo sino.js) para quem tem a Expedição: faixa
// laranja no topo, som (gerado aqui, sem arquivo), título piscando e notificação do Windows. Pergunta a
// /api/comandas a cada minuto (o painel relê os marketplaces a cada 3 min). As comandas já vistas ficam
// no navegador (localStorage), divididas entre as abas: só uma aba toca para a mesma comanda.
(function () {
  if (document.getElementById('avisoComanda')) return;
  const CHAVE = 'painel.comandas.vistas', SOM = 'painel.comandas.som';
  const ler = (k, padrao) => { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch { return padrao; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const somLigado = () => ler(SOM, true) !== false;

  const css = document.createElement('style');
  css.textContent = `
    #avisoComanda{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:200;width:min(560px,calc(100vw - 32px));
      background:#ea580c;color:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(234,88,12,.45);padding:14px 16px;
      display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:center;animation:avisoPulsa 1.2s ease-in-out infinite}
    #avisoComanda[hidden]{display:none}
    #avisoComanda .ic{font-size:30px;grid-row:span 2}
    #avisoComanda b{font-size:17px}
    #avisoComanda .lista{font-size:13px;opacity:.95;line-height:1.4}
    #avisoComanda .acoes{grid-column:1 / -1;display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    #avisoComanda button,#avisoComanda a{font:inherit;font-size:13px;font-weight:700;border-radius:10px;padding:7px 12px;cursor:pointer;text-decoration:none}
    #avisoComanda a{background:#fff;color:#c2410c;border:0}
    #avisoComanda button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.7)}
    @keyframes avisoPulsa{0%,100%{box-shadow:0 18px 50px rgba(234,88,12,.45)}50%{box-shadow:0 0 0 6px rgba(234,88,12,.35),0 18px 50px rgba(234,88,12,.55)}}
    @media (prefers-reduced-motion: reduce){#avisoComanda{animation:none}}`;
  document.head.appendChild(css);

  const box = document.createElement('div');
  box.id = 'avisoComanda'; box.hidden = true; box.setAttribute('role', 'alert');
  box.innerHTML = '<span class="ic" aria-hidden="true">📦</span><b></b><div class="lista"></div><div class="acoes">'
    + '<a href="/comandas.html">Abrir comandas</a><button type="button" data-x="ok">Ok, vi</button><button type="button" data-x="som"></button></div>';
  document.body.appendChild(box);
  const titulo = box.querySelector('b'), lista = box.querySelector('.lista'), btSom = box.querySelector('[data-x="som"]');
  const pintarSom = () => { btSom.textContent = somLigado() ? '🔔 Som ligado' : '🔕 Som desligado'; };
  pintarSom();

  // Som: três toques (ding-dong) feitos pelo Web Audio. O navegador só libera o áudio depois de um clique
  // ou tecla na página; até lá vale a notificação do Windows (que tem o som do sistema).
  let ctx = null;
  const audio = () => { try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch {} return ctx; };
  for (const ev of ['click', 'keydown']) document.addEventListener(ev, () => audio(), { once: true, capture: true });
  function tocar() {
    const c = audio(); if (!c) return;
    if (c.state !== 'running') c.resume().catch(() => {});   // suspenso: as notas tocam quando o navegador liberar
    const nota = (freq, ini, dur) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, c.currentTime + ini);
      g.gain.exponentialRampToValueAtTime(0.5, c.currentTime + ini + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ini + dur);
      o.connect(g).connect(c.destination); o.start(c.currentTime + ini); o.stop(c.currentTime + ini + dur + 0.05);
    };
    for (let i = 0; i < 3; i++) { nota(988, i * 0.9, 0.35); nota(784, i * 0.9 + 0.3, 0.5); }
  }

  // Título piscando enquanto o aviso estiver aberto
  const tituloOriginal = document.title;
  let pisca = null;
  const piscar = (n) => { clearInterval(pisca); let v = false; pisca = setInterval(() => { v = !v; document.title = v ? `📦 ${n} comanda(s) nova(s)` : tituloOriginal; }, 1000); };
  const fechar = () => { box.hidden = true; clearInterval(pisca); document.title = tituloOriginal; };

  box.querySelector('[data-x="ok"]').onclick = fechar;
  btSom.onclick = () => { gravar(SOM, !somLigado()); pintarSom(); if (somLigado()) { audio(); tocar(); } };

  let pendentes = [];
  function mostrar(novas) {
    pendentes = [...novas, ...pendentes].slice(0, 30);
    titulo.textContent = pendentes.length === 1 ? 'Nova comanda para separar' : `${pendentes.length} comandas novas para separar`;
    lista.textContent = pendentes.slice(0, 4).map((c) => `${c.categoria} ${c.numero} · ${c.loja}${c.cliente ? ' · ' + c.cliente : ''}`).join('\n');
    lista.style.whiteSpace = 'pre-line';
    if (pendentes.length > 4) lista.textContent += `\n+ ${pendentes.length - 4}`;
    box.hidden = false;
    piscar(pendentes.length);
    if (somLigado()) tocar();
    if ('Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(titulo.textContent, { body: lista.textContent, tag: 'comanda-nova', requireInteraction: true });
        n.onclick = () => { window.focus(); location.href = '/comandas.html'; }; } catch {}
    }
  }

  async function conferir() {
    let r;
    try { r = await fetch('/api/comandas', { credentials: 'same-origin' }); if (!r.ok) return; r = await r.json(); } catch { return; }
    // só o que é para fazer: não impressa e não manual (a comanda manual foi alguém daqui que criou)
    const fila = (r.comandas || []).filter((c) => !c.impressa_em && c.canal !== 'manual');
    if (typeof window.contadorMenu === 'function') window.contadorMenu('/comandas.html', (r.comandas || []).filter((c) => !c.impressa_em).length);
    const vistas = ler(CHAVE, null);
    if (!Array.isArray(vistas)) { gravar(CHAVE, fila.map((c) => c.chave)); return; }   // 1ª vez neste navegador: sem alarme
    const ja = new Set(vistas);
    const novas = fila.filter((c) => !ja.has(c.chave));
    if (!novas.length) return;
    gravar(CHAVE, [...novas.map((c) => c.chave), ...vistas].slice(0, 3000));   // outra aba que conferir depois não toca de novo
    if (location.pathname === '/comandas.html' && typeof window.recarregarComandas === 'function') window.recarregarComandas();
    mostrar(novas);
  }

  // Botão "Testar aviso de comanda" (menu): toca o som e manda uma notificação de exemplo agora.
  window.testarAvisoComanda = async () => {
    audio();
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const exemplo = [{ categoria: 'Teste', numero: 0, loja: 'Aviso de comanda', cliente: 'som e notificação' }];
    const antes = pendentes; pendentes = [];
    mostrar(exemplo); pendentes = antes;
    if (!somLigado()) lista.textContent += '\n(o som está desligado: clique em "Som desligado" para ligar)';
    if (!('Notification' in window) || Notification.permission !== 'granted') lista.textContent += '\n(notificação do Windows bloqueada neste navegador)';
  };

  fetch('/api/eu', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((eu) => {
    if (!eu || !(eu.admin || (eu.paginas || []).includes('/comandas.html'))) return;
    conferir();
    setInterval(conferir, 60000);
  }).catch(() => {});
})();
