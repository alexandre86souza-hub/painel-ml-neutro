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
    campanhas: '<path d="M4 12.5V5a1 1 0 0 1 1-1h7.5L20 11.5 12.5 19z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
    ads: '<path d="M4 10v4h3l5 4V6L7 10H4Z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
    full: '<path d="M3 8h11v9H3zM14 11h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    devolucoes: '<path d="M9 7 5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-3"/>',
    empresa: '<path d="M4 20V8l6-3v15M10 20V10l10 3v7M4 20h16"/>',
    shopee: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
    amazon: '<path d="M4 9h16v10H4z"/><path d="M8 9V6h8v3"/><path d="M7 14c3 2 7 2 10 0"/>',
    publicar: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 9v6M9 12h6"/>',
    navegador: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.4 2.6 2.4 12.8 0 16M12 4c-2.4 2.6-2.4 12.8 0 16"/>',
    config: '<path d="M5 8h14M5 16h14"/><circle cx="10" cy="8" r="2.3"/><circle cx="15" cy="16" r="2.3"/>',
  };
  const ITENS = [
    ['/geral.html', 'Todas as contas', 'geral'],
    ['/', 'Dashboard', 'dashboard'],
    ['/vendas.html?dias=1', 'Vendas Hoje', 'hoje'],
    ['/vendas.html', 'Pedidos', 'pedidos'],
    ['/performance.html', 'Performance', 'performance'],
    ['/abc.html', 'Análise ABC', 'abc'],
    ['/produtos.html', 'Produtos', 'produtos'],
    ['/anuncios.html', 'Anúncios', 'anuncios'],
    ['/promocoes.html', 'Campanhas', 'campanhas'],
    ['/ads.html', 'Histórico ADS', 'ads'],
    ['/full.html', 'Full', 'full'],
    null,
    ['/devolucoes.html', 'Devoluções', 'devolucoes'],
    ['/empresa.html', 'Empresa e custos', 'empresa'],
    ['/shopee.html', 'Shopee', 'shopee'],
    ['/amazon.html', 'Amazon', 'amazon'],
    ['/publicar.html', 'Publicar', 'publicar'],
    ['/navegador.html', 'Navegador', 'navegador'],
    ['/configuracao.html', 'Configurações', 'config'],
  ];
  // Identidade do painel (nome e logo da empresa, tela Empresa). O último valor fica no
  // navegador para a marca aparecer junto com a página; o servidor confirma em seguida.
  const PADRAO = 'Painel Mercado Livre';
  // Contas de outros marketplaces: "amazon" e "shopee-{loja}". As telas delas (e as do ML com
  // ?conta=…) mostram a identidade daquela conta e os dados dela.
  const PARAM = new URLSearchParams(location.search).get('conta');
  const EXT = ['/amazon.html', '/amazon-anuncios.html', '/amazon-ads.html'].includes(location.pathname) ? 'amazon'
    : /^(amazon|shopee-\d+)$/.test(PARAM || '') ? PARAM : null;
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
    shopee: ['/vendas.html', '/performance.html', '/abc.html', '/empresa.html'] };
  const tipo = (ext) => (ext === 'amazon' ? 'amazon' : 'shopee');
  const comConta = (href, ext = EXT) => {
    const u = new URL(href, location.origin);
    if (tipo(ext) === 'amazon') {
      if (u.pathname === '/' || u.pathname === '/inicio.html') return '/amazon.html';
      if (u.pathname === '/anuncios.html') return '/amazon-anuncios.html';
      if (u.pathname === '/ads.html') return '/amazon-ads.html';
    } else if (u.pathname === '/' || u.pathname === '/inicio.html') return `/vendas.html?conta=${ext}`;
    else if (u.pathname === '/anuncios.html') return `/shopee-anuncios.html?conta=${ext}`;
    else if (u.pathname === '/ads.html') return `/shopee-ads.html?conta=${ext}`;
    if (!TELAS[tipo(ext)].includes(u.pathname)) return href;
    u.searchParams.set('conta', ext);
    return u.pathname + u.search;
  };
  const telaDaConta = (ext) => {
    const aquiTem = TELAS[tipo(ext)].includes(location.pathname) || ['/anuncios.html', '/ads.html'].includes(location.pathname);
    if (aquiTem) { const u = new URL(location.href); u.searchParams.delete('conta'); return comConta(u.pathname + u.search, ext); }
    return tipo(ext) === 'amazon' ? '/amazon.html' : `/vendas.html?conta=${ext}`;
  };
  const semConta = () => {
    if (location.pathname === '/amazon.html') return '/';
    if (location.pathname === '/amazon-anuncios.html') return '/anuncios.html';
    if (location.pathname === '/amazon-ads.html' || location.pathname === '/shopee-ads.html') return '/ads.html';
    if (location.pathname === '/shopee-anuncios.html') return '/anuncios.html';
    const u = new URL(location.href); u.searchParams.delete('conta');
    return u.pathname + u.search;
  };
  // Conta externa na lista: a mesma tela com ela (ou a tela dela). Conta do ML estando numa
  // externa: troca a ativa e volta para a mesma tela sem a externa.
  document.addEventListener('change', async (ev) => {
    if (!ev.target || ev.target.id !== 'selConta') return;
    if (/^(amazon|shopee-\d+)$/.test(ev.target.value)) {
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

  // Amazon e lojas da Shopee entram no fim da lista de contas de todas as telas (cada tela monta
  // a sua lista; aqui só acrescenta as opções depois que ela aparece).
  const ler = (u) => fetch(u, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([ler('/api/amazon/config'), ler('/api/shopee/config')]).then(([amz, sh]) => {
    const extras = [];
    if (amz?.conectada_em) extras.push({ valor: 'amazon', nome: `${amz.vendedor || 'AMAZON'} · Amazon` });
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
  for (const it of ITENS) {
    if (!it) { const hr = document.createElement('hr'); hr.className = 'nav-sep'; nav.appendChild(hr); continue; }
    const [href, rotulo, icone] = it;
    const a = document.createElement('a');
    a.href = EXT ? comConta(href) : href;
    const [caminho, query] = href.split('?');
    const atual = (caminho === aqui || (NA_AMAZON && caminho === '/' && aqui === '/amazon.html')
      || (caminho === '/anuncios.html' && ['/amazon-anuncios.html', '/shopee-anuncios.html'].includes(aqui))
      || (caminho === '/ads.html' && ['/amazon-ads.html', '/shopee-ads.html'].includes(aqui)))
      && (caminho !== '/vendas.html' || (query === 'dias=1') === hoje);
    if (atual) a.setAttribute('aria-current', 'page');
    a.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONE[icone]}</svg>`;
    a.appendChild(document.createTextNode(rotulo));
    nav.appendChild(a);
  }
})();
