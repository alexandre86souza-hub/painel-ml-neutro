// Menu lateral, igual em todas as telas: um lugar só para mudar a ordem ou um item.
// Carregado logo depois do <nav id="menuPainel">, sem defer, para o menu aparecer junto com a página.
(function () {
  const ICONE = {
    dashboard: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    geral: '<circle cx="12" cy="12" r="8"/><path d="M12 12V4M12 12l6.5 4.5M12 12l-6.5 4.5"/>',
    hoje: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    pedidos: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    performance: '<path d="M4 18 9 12l4 3 7-8"/><path d="M16 7h4v4"/>',
    abc: '<path d="M5 19V9M10 19V5M15 19v-7M20 19v-3"/>',
    produtos: '<path d="M4 8 12 4l8 4-8 4-8-4Z"/><path d="M4 8v8l8 4 8-4V8M12 12v8"/>',
    anuncios: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    calculadora: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11v6M8 15h2M12 15h2M8 18h6"/>',
    campanhas: '<path d="M4 12.5V5a1 1 0 0 1 1-1h7.5L20 11.5 12.5 19z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
    ads: '<path d="M4 10v4h3l5 4V6L7 10H4Z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
    full: '<path d="M3 8h11v9H3zM14 11h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    devolucoes: '<path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-3"/>',
    mensagens: '<path d="M4 6h16v10H9l-5 4V6Z"/><path d="M8 10h8M8 13h5"/>',
    reputacao: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4l-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z"/>',
    financeiro: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 9v.01M17 15v.01"/>',
    empresa: '<path d="M4 20V8l6-3v15M10 20V10l10 3v7M4 20h16"/>',
    shopee: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
    amazon: '<path d="M4 9h16v10H4z"/><path d="M8 9V6h8v3"/><path d="M7 14c3 2 7 2 10 0"/>',
    leroy: '<path d="M3 11 12 4l9 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
    magalu: '<path d="M4 7h16v12H4z"/><path d="M8 7a4 4 0 0 1 8 0"/><path d="M9 12l3 3 3-3"/>',
    comandas: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    estoque: '<path d="M3 9l9-5 9 5v10H3z"/><path d="M7 19v-6h10v6M7 16h10"/>',
    publicar: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 9v6M9 12h6"/>',
    navegador: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.4 2.6 2.4 12.8 0 16M12 4c-2.4 2.6-2.4 12.8 0 16"/>',
    usuarios: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>',
    sair: '<path d="M10 5H5v14h5"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    senha: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    config: '<path d="M5 8h14M5 16h14"/><circle cx="10" cy="8" r="2.3"/><circle cx="15" cy="16" r="2.3"/>',
    escuro: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    claro: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  };
  // Grupos do menu (cada um abre e fecha; o estado fica no navegador). recolhido = começa fechado.
  const GRUPOS = [
    { nome: 'Visão geral', itens: [
      ['/geral.html', 'Todas as contas', 'geral'],
      ['/', 'Dashboard', 'dashboard'],
      ['/vendas.html?dias=1', 'Vendas hoje', 'hoje']] },
    { nome: 'Operação', itens: [
      ['/comandas.html', 'Comandas', 'comandas'],
      ['/estoque.html', 'Estoque', 'estoque'],
      ['/mensagens.html', 'Mensagens', 'mensagens'],
      ['/devolucoes.html', 'Devoluções', 'devolucoes']] },
    { nome: 'Vendas e análise', itens: [
      ['/vendas.html', 'Pedidos', 'pedidos'],
      ['/performance.html', 'Performance', 'performance'],
      ['/abc.html', 'Análise ABC', 'abc'],
      ['/full.html', 'Full', 'full'],
      ['/reputacao.html', 'Reputação', 'reputacao']] },
    { nome: 'Anúncios e marketing', itens: [
      ['/anuncios.html', 'Anúncios', 'anuncios'],
      ['/produtos.html', 'Produtos', 'produtos'],
      ['/promocoes.html', 'Campanhas', 'campanhas'],
      ['/ads.html', 'Publicidade (Ads)', 'ads'],
      ['/publicar.html', 'Publicar', 'publicar'],
      ['/calculadora.html', 'Calculadora reversa', 'calculadora']] },
    { nome: 'Financeiro', itens: [
      ['/financeiro.html', 'Financeiro', 'financeiro'],
      ['/empresa.html', 'Empresa e custos', 'empresa']] },
    { nome: 'Conexões e sistema', recolhido: true, itens: [
      ['/shopee.html', 'Shopee', 'shopee'],
      ['/amazon.html', 'Amazon', 'amazon'],
      ['/leroy.html', 'Leroy Merlin', 'leroy'],
      ['/magalu.html', 'Magalu', 'magalu'],
      ['/navegador.html', 'Navegador', 'navegador'],
      ['/usuarios.html', 'Usuários', 'usuarios'],
      ['/configuracao.html', 'Configurações', 'config']] },
  ];
  // Identidade do painel (nome e logo da empresa, tela Empresa). O último valor fica no
  // navegador para a marca aparecer junto com a página; o servidor confirma em seguida.
  const PADRAO = 'Painel Mercado Livre';
  // Contas de outros marketplaces: "amazon", "leroy" e "shopee-{loja}". As telas delas (e as do ML com
  // ?conta=…) mostram a identidade daquela conta e os dados dela.
  const PARAM = new URLSearchParams(location.search).get('conta');
  const EXT = ['/amazon.html', '/amazon-anuncios.html', '/amazon-ads.html'].includes(location.pathname) ? 'amazon'
    : location.pathname === '/leroy.html' ? 'leroy' : location.pathname === '/magalu.html' ? 'magalu'
    : /^(amazon|leroy|magalu|shopee-\d+)$/.test(PARAM || '') ? PARAM : null;
  const NA_AMAZON = EXT === 'amazon';
  const QM = EXT ? `conta=${EXT}&` : '';
  const GUARDA = EXT ? 'painel.marca.' + EXT : 'painel.marca';
  function pintarMarca(m) {
    const box = document.getElementById('marcaPainel');
    if (box) {
      box.textContent = '';
      if (m.tem_logo) {
        const img = document.createElement('img');
        img.className = 'marca-logo-painel'; img.alt = m.nome; img.src = '/api/marca/logo?' + QM + 'v=' + encodeURIComponent(m.v || '0');
        box.appendChild(img);
      } else {
        const t = document.createElement('span'); t.className = 'marca-nome'; t.textContent = m.nome; box.appendChild(t);
      }
    }
    // título da aba: "Tela — Nome da empresa" (só com nome próprio)
    const base = document.title.split(' — ')[0];
    document.title = m.personalizado ? base + ' — ' + m.nome : base;
  }
  let guardada = null;
  try { guardada = JSON.parse(localStorage.getItem(GUARDA) || 'null'); } catch {}
  pintarMarca(guardada || { nome: PADRAO, personalizado: false, tem_logo: false });
  const buscarMarca = () => fetch('/api/marca' + (EXT ? '?conta=' + EXT : '')).then((r) => (r.ok ? r.json() : null)).then((m) => {
    if (!m) return;
    try { localStorage.setItem(GUARDA, JSON.stringify(m)); } catch {}
    pintarMarca(m);
  }).catch(() => {});
  // depois que a página terminou de montar (uma tela pode trocar o título ao abrir)
  if (document.readyState === 'complete') buscarMarca(); else window.addEventListener('load', buscarMarca);
  window.atualizarMarca = buscarMarca;   // a tela Empresa chama depois de salvar
  // Telas que mostram cada conta externa (com ?conta=…). A Amazon tem telas próprias de
  // Dashboard, Anúncios e Ads; na Shopee o Dashboard é a tela Pedidos.
  const TELAS = { amazon: ['/vendas.html', '/performance.html', '/abc.html', '/empresa.html', '/full.html'],
    shopee: ['/vendas.html', '/performance.html', '/abc.html', '/empresa.html'],
    leroy: ['/vendas.html', '/performance.html', '/abc.html', '/empresa.html'],
    magalu: ['/vendas.html', '/performance.html', '/abc.html', '/empresa.html'] };
  const tipo = (ext) => (ext === 'amazon' || ext === 'leroy' || ext === 'magalu' ? ext : 'shopee');
  const comConta = (href, ext = EXT) => {
    const u = new URL(href, location.origin);
    if (tipo(ext) === 'amazon') {
      if (u.pathname === '/' || u.pathname === '/inicio.html') return '/amazon.html';
      if (u.pathname === '/anuncios.html') return '/amazon-anuncios.html';
      if (u.pathname === '/ads.html') return '/amazon-ads.html';
      if (u.pathname === '/publicar.html') return '/publicar-canais.html?conta=amazon';
      if (u.pathname === '/promocoes.html') return '/campanhas-canais.html?conta=amazon';
    } else if (tipo(ext) === 'leroy' || tipo(ext) === 'magalu') {
      if (u.pathname === '/' || u.pathname === '/inicio.html') return `/vendas.html?conta=${ext}`;
      if (u.pathname === '/promocoes.html') return `/campanhas-canais.html?conta=${ext}`;
      if (u.pathname === '/anuncios.html' && ext === 'magalu') return '/magalu-anuncios.html?conta=magalu';
    } else if (u.pathname === '/' || u.pathname === '/inicio.html') return `/vendas.html?conta=${ext}`;
    else if (u.pathname === '/anuncios.html') return `/shopee-anuncios.html?conta=${ext}`;
    else if (u.pathname === '/ads.html') return `/shopee-ads.html?conta=${ext}`;
    else if (u.pathname === '/promocoes.html') return `/shopee-campanhas.html?conta=${ext}`;
    else if (u.pathname === '/devolucoes.html') return `/shopee-devolucoes.html?conta=${ext}`;
    else if (u.pathname === '/publicar.html') return `/publicar-canais.html?conta=${ext}`;
    if (!TELAS[tipo(ext)].includes(u.pathname)) return href;
    u.searchParams.set('conta', ext);
    return u.pathname + u.search;
  };
  const telaDaConta = (ext) => {
    const aquiTem = TELAS[tipo(ext)].includes(location.pathname) || ['/anuncios.html', '/ads.html', '/publicar.html'].includes(location.pathname)
      || ['/promocoes.html', '/campanhas-canais.html', '/shopee-campanhas.html'].includes(location.pathname)
      || (tipo(ext) === 'shopee' && location.pathname === '/devolucoes.html');
    // campanhas: de uma conta para outra, a tela de campanhas da outra
    if (['/campanhas-canais.html', '/shopee-campanhas.html'].includes(location.pathname)) return comConta('/promocoes.html', ext);
    if (aquiTem) { const u = new URL(location.href); u.searchParams.delete('conta'); return comConta(u.pathname + u.search, ext); }
    return tipo(ext) === 'amazon' ? '/amazon.html' : `/vendas.html?conta=${ext}`;   // Leroy: a tela Pedidos
  };
  const semConta = () => {
    if (['/amazon.html', '/leroy.html', '/magalu.html'].includes(location.pathname)) return '/';
    if (location.pathname === '/amazon-anuncios.html') return '/anuncios.html';
    if (location.pathname === '/amazon-ads.html' || location.pathname === '/shopee-ads.html') return '/ads.html';
    if (location.pathname === '/shopee-anuncios.html' || location.pathname === '/magalu-anuncios.html') return '/anuncios.html';
    if (location.pathname === '/shopee-campanhas.html' || location.pathname === '/campanhas-canais.html') return '/promocoes.html';
    if (location.pathname === '/shopee-devolucoes.html') return '/devolucoes.html';
    if (location.pathname === '/publicar-canais.html') return '/publicar.html';
    const u = new URL(location.href); u.searchParams.delete('conta');
    return u.pathname + u.search;
  };
  // Conta externa na lista: a mesma tela com ela (ou a tela dela). Conta do ML estando numa
  // externa: troca a ativa e volta para a mesma tela sem a externa.
  document.addEventListener('change', async (ev) => {
    if (!ev.target || ev.target.id !== 'selConta') return;
    if (/^(amazon|leroy|magalu|shopee-\d+)$/.test(ev.target.value)) {
      ev.stopImmediatePropagation();
      location.href = telaDaConta(ev.target.value);
      return;
    }
    try { localStorage.removeItem('painel.marca'); } catch {}
    if (EXT) {
      ev.stopImmediatePropagation();
      await fetch('/api/accounts/active', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ml_user_id: Number(ev.target.value) }) });
      location.href = semConta();
    }
  }, true);

  // Amazon, Leroy e lojas da Shopee entram no fim da lista de contas de todas as telas (cada tela monta
  // a sua lista; aqui só acrescenta as opções depois que ela aparece).
  const ler = (u) => fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([ler('/api/amazon/config'), ler('/api/shopee/config'), ler('/api/leroy/config'), ler('/api/magalu/config')]).then(([amz, sh, lm, mgl]) => {
    const extras = [];
    if (amz?.conectada_em) extras.push({ valor: 'amazon', nome: `${amz.vendedor || 'AMAZON'} · Amazon` });
    if (lm?.conectada_em) extras.push({ valor: 'leroy', nome: `${lm.loja || 'Loja'} · Leroy Merlin` });
    if (mgl?.conectada_em) extras.push({ valor: 'magalu', nome: `${mgl.loja || 'Loja'} · Magalu` });
    for (const l of sh?.lojas || []) extras.push({ valor: `shopee-${l.shop_id}`, nome: `${l.nome || 'Loja ' + l.shop_id} · Shopee` });
    if (!extras.length) return;
    const pendurar = () => {
      const sel = document.getElementById('selConta');
      if (!sel || !sel.options.length) return;
      for (const x of extras) {
        if ([...sel.options].some((o) => o.value === x.valor)) continue;
        const o = document.createElement('option');
        o.value = x.valor; o.textContent = x.nome; o.selected = EXT === x.valor;
        sel.appendChild(o);
      }
      sel.hidden = false;
    };
    const vigiar = () => {
      const sel = document.getElementById('selConta');
      if (!sel) return;
      pendurar();
      new MutationObserver(pendurar).observe(sel, { childList: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', vigiar); else vigiar();
  });

  const nav = document.getElementById('menuPainel');
  if (!nav) return;
  const aqui = location.pathname === '/inicio.html' ? '/' : location.pathname;
  const hoje = new URLSearchParams(location.search).get('dias') === '1';
  let fechados = null;
  try { fechados = JSON.parse(localStorage.getItem('painel.menu.fechados') || 'null'); } catch {}
  if (!Array.isArray(fechados)) fechados = GRUPOS.filter((g) => g.recolhido).map((g) => g.nome);
  for (const g of GRUPOS) {
    const box = document.createElement('div'); box.className = 'nav-grupo';
    const tit = document.createElement('button'); tit.type = 'button'; tit.textContent = g.nome;
    const lista = document.createElement('div'); lista.className = 'nav-itens';
    box.append(tit, lista); nav.appendChild(box);
    for (const it of g.itens) lista.appendChild(itemDoMenu(it));
    // a tela aberta fica sempre à vista, mesmo num grupo fechado
    const aberto = !fechados.includes(g.nome) || !!lista.querySelector('[aria-current]');
    tit.setAttribute('aria-expanded', String(aberto)); lista.hidden = !aberto;
    tit.onclick = () => {
      const abrir = lista.hidden; lista.hidden = !abrir; tit.setAttribute('aria-expanded', String(abrir));
      fechados = abrir ? fechados.filter((n) => n !== g.nome) : [...new Set([...fechados, g.nome])];
      try { localStorage.setItem('painel.menu.fechados', JSON.stringify(fechados)); } catch {}
    };
  }
  function itemDoMenu(it) {
    const [href, rotulo, icone] = it;
    const a = document.createElement('a');
    a.href = EXT ? comConta(href) : href;
    const [caminho, query] = href.split('?');
    const atual = (caminho === aqui || (NA_AMAZON && caminho === '/' && aqui === '/amazon.html')
      || (caminho === '/anuncios.html' && ['/amazon-anuncios.html', '/shopee-anuncios.html', '/magalu-anuncios.html'].includes(aqui))
      || (caminho === '/ads.html' && ['/amazon-ads.html', '/shopee-ads.html'].includes(aqui))
      || (caminho === '/promocoes.html' && ['/shopee-campanhas.html', '/campanhas-canais.html'].includes(aqui)) || (caminho === '/devolucoes.html' && aqui === '/shopee-devolucoes.html') || (caminho === '/publicar.html' && aqui === '/publicar-canais.html'))
      && (caminho !== '/vendas.html' || (query === 'dias=1') === hoje);
    if (atual) a.setAttribute('aria-current', 'page');
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONE[icone]}</svg>`;
    a.appendChild(document.createTextNode(rotulo));
    return a;
  }
  // Contador ao lado de um item (ex.: comandas a imprimir, por public/comandas-aviso.js). 0 tira.
  window.contadorMenu = (caminho, n) => {
    for (const a of nav.querySelectorAll('a')) {
      if (new URL(a.href, location.origin).pathname !== caminho) continue;
      let c = a.querySelector('.nav-cont');
      if (!n) { if (c) c.remove(); continue; }
      if (!c) { c = document.createElement('span'); c.className = 'nav-cont'; a.appendChild(c); }
      c.textContent = n > 99 ? '99+' : String(n);
    }
  };

  // Usuário do escritório (usuarios.js): o menu mostra só as telas dos módulos dele. O servidor é quem
  // barra de verdade; aqui é só para não oferecer o que não abre. A lista fica no navegador para o menu
  // já nascer filtrado na próxima tela.
  const filtrar = (eu) => {
    if (!eu || eu.admin || !Array.isArray(eu.paginas)) return;
    for (const a of [...nav.querySelectorAll('a')]) {
      const p = new URL(a.href, location.origin).pathname;
      if (!eu.paginas.includes(p === '/' ? '/inicio.html' : p)) a.remove();
    }
    for (const g of [...nav.querySelectorAll('.nav-grupo')]) if (!g.querySelector('a')) g.remove();
  };
  const rodape = (eu) => {
    if (!eu || document.getElementById('menuEu')) return;
    const box = document.createElement('div'); box.id = 'menuEu';
    const hr = document.createElement('hr'); hr.className = 'nav-sep'; box.appendChild(hr);
    const quem = document.createElement('div');
    quem.style.cssText = 'font-size:12px;opacity:.75;padding:4px 12px';
    quem.textContent = eu.admin ? 'Administrador' : eu.nome + ' (' + eu.login + ')';
    box.appendChild(quem);
    const item = (href, rotulo, icone) => { const a = document.createElement('a'); a.href = href;
      a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONE[icone] + '</svg>'; a.appendChild(document.createTextNode(rotulo)); return a; };
    // tema claro / escuro (public/tema.js), por pessoa neste navegador
    const tema = item('#', '', 'escuro');
    const pintarTema = () => { const escuro = document.documentElement.dataset.tema === 'escuro';
      tema.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONE[escuro ? 'claro' : 'escuro'] + '</svg>';
      tema.appendChild(document.createTextNode(escuro ? 'Tema claro' : 'Tema escuro')); };
    tema.onclick = (ev) => { ev.preventDefault(); if (window.trocarTema) window.trocarTema(); pintarTema(); };
    pintarTema();
    box.appendChild(tema);
    if (!eu.admin) box.appendChild(item('/trocar-senha', 'Trocar minha senha', 'senha'));
    const sair = item('#', 'Sair', 'sair');
    sair.onclick = (ev) => { ev.preventDefault(); const f = document.createElement('form'); f.method = 'POST'; f.action = '/sair'; document.body.appendChild(f); f.submit(); };
    box.appendChild(sair);
    nav.appendChild(box);
  };
  let guardado = null;
  try { guardado = JSON.parse(localStorage.getItem('painel.eu') || 'null'); } catch {}
  filtrar(guardado);
  fetch('/api/eu', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((eu) => {
    if (!eu) return;
    try { localStorage.setItem('painel.eu', JSON.stringify(eu)); } catch {}
    // outra pessoa entrou neste navegador e o menu nasceu filtrado pela anterior: monta de novo
    if (guardado && !guardado.admin && JSON.stringify(guardado.paginas) !== JSON.stringify(eu.paginas)) { location.reload(); return; }
    filtrar(eu); rodape(eu);
  }).catch(() => {});
})();
