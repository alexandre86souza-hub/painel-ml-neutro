// Menu lateral, igual em todas as telas: um lugar só para mudar a ordem ou um item.
// Carregado logo depois do <nav id="menuPainel">, sem defer, para o menu aparecer junto com a página.
(function () {
  const ICONE = {
    dashboard: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    geral: '<circle cx="12" cy="12" r="8"/><path d="M12 12V4M12 12l6.5 4.5M12 12l-6.5 4.5"/>',
    metas: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2"/><path d="M15 9l5-5M17 4h3v3"/>',
    margem: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4M12 17v.01"/>',
    placar: '<path d="M4 20h16"/><path d="M6 16l4-5 3 3 5-7"/><circle cx="18" cy="7" r="1.6"/>',
    caixa: '<path d="M4 7h16v12H4z"/><path d="M4 11h16"/><path d="M15 15h2"/><path d="M8 4h8"/>',
    dre: '<path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h3M14 15h1M9 18h6"/>',
    compras: '<path d="M4 5h2l2 10h10l2-7H7"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
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
    etiquetas: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
    estoque: '<path d="M3 9l9-5 9 5v10H3z"/><path d="M7 19v-6h10v6M7 16h10"/>',
    publicar: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 9v6M9 12h6"/>',
    navegador: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.4 2.6 2.4 12.8 0 16M12 4c-2.4 2.6-2.4 12.8 0 16"/>',
    usuarios: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A4.5 4.5 0 0 1 21 18.5"/>',
    sair: '<path d="M10 5H5v14h5"/><path d="M14 8l4 4-4 4M18 12H9"/>',
    senha: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    config: '<path d="M5 8h14M5 16h14"/><circle cx="10" cy="8" r="2.3"/><circle cx="15" cy="16" r="2.3"/>',
    escuro: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    claro: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    central: '<path d="M4 13a8 8 0 1 1 16 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1.4"/><path d="M5 19h14"/>',
    bling: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 15h5M10 18h3"/>',
    'bling-conexao': '<path d="M9 15l6-6"/><path d="M11 7l1.5-1.5a3.5 3.5 0 0 1 5 5L16 12M13 17l-1.5 1.5a3.5 3.5 0 0 1-5-5L8 12"/>',
    integracoes: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/><path d="M10.5 7h3a3 3 0 0 1 3 3v3.5M13.5 17h-3a3 3 0 0 1-3-3v-3.5"/>',
    vendas: '<path d="M4 5h2l2.2 10.2a1 1 0 0 0 1 .8h8.4a1 1 0 0 0 1-.8L20 8H7"/><circle cx="10" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
    preco: '<path d="M12 3v18"/><path d="M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 1.8 2.6 4.5 3 4.5 1.4 4.5 3.2-2 3.3-4.5 3.3-4.5-1.3-4.5-3"/>',
    inteligencia: '<path d="M9.5 18h5M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
    admin: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    recolher: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M9 4v16"/><path d="M15.5 10 13.5 12l2 2"/>',
    expandir: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M9 4v16"/><path d="M13.5 10l2 2-2 2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    busca: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    sino: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    relogio: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/>',
  };
  // Grupos do menu (cada um abre e fecha; o estado fica no navegador). recolhido = começa fechado.
  // icone = o do grupo (menu recolhido e busca). Só telas que existem: cada item aponta para uma tela real.
  const GRUPOS = [
    { nome: 'Visão geral', icone: 'dashboard', itens: [
      ['/central.html', 'Central de comando', 'central'],
      ['/', 'Dashboard da conta', 'dashboard'],
      ['/geral.html', 'Todas as contas', 'geral'],
      ['/metas.html', 'Metas e faturamento', 'metas']] },
    { nome: 'Vendas', icone: 'vendas', itens: [
      ['/vendas.html?dias=1', 'Vendas hoje', 'hoje'],
      ['/vendas.html', 'Pedidos', 'pedidos'],
      ['/devolucoes.html', 'Devoluções', 'devolucoes'],
      ['/mensagens.html', 'Mensagens', 'mensagens'],
      ['/reputacao.html', 'Reputação', 'reputacao']] },
    { nome: 'Expedição', icone: 'comandas', itens: [
      ['/comandas.html', 'Comandas', 'comandas'],
      ['/etiquetas.html', 'Etiquetas de envio', 'etiquetas'],
      ['/bling.html', 'Notas fiscais (Bling)', 'bling']] },
    { nome: 'Produtos e anúncios', icone: 'produtos', itens: [
      ['/produtos.html', 'Produtos e SKUs', 'produtos'],
      ['/anuncios.html', 'Anúncios', 'anuncios'],
      ['/publicar.html', 'Publicar anúncio', 'publicar']] },
    { nome: 'Marketing e Ads', icone: 'ads', itens: [
      ['/ads.html', 'Publicidade (Ads)', 'ads'],
      ['/promocoes.html', 'Campanhas e promoções', 'campanhas'],
      ['/placar.html', 'Resultado de promoções e Ads', 'placar']] },
    { nome: 'Precificação', icone: 'preco', itens: [
      ['/calculadora.html', 'Calculadora reversa', 'calculadora'],
      ['/margem.html', 'Margem baixa', 'margem']] },
    { nome: 'Estoque', icone: 'estoque', itens: [
      ['/estoque.html', 'Estoque geral', 'estoque'],
      ['/full.html', 'Full e FBA', 'full'],
      ['/compras.html', 'Compras e capital parado', 'compras']] },
    { nome: 'Financeiro', icone: 'financeiro', itens: [
      ['/caixa.html', 'Caixa a receber', 'caixa'],
      ['/dre.html', 'DRE do mês', 'dre'],
      ['/financeiro.html', 'Recebimentos', 'financeiro'],
      ['/empresa.html', 'Empresa e custos', 'empresa']] },
    { nome: 'Inteligência', icone: 'inteligencia', itens: [
      ['/performance.html', 'Performance', 'performance'],
      ['/abc.html', 'Curva ABC', 'abc']] },
    { nome: 'Integrações', icone: 'integracoes', recolhido: true, itens: [
      ['/integracoes.html', 'Todas as integrações', 'integracoes'],
      ['/shopee.html', 'Shopee', 'shopee'],
      ['/amazon.html', 'Amazon', 'amazon'],
      ['/leroy.html', 'Leroy Merlin', 'leroy'],
      ['/magalu.html', 'Magalu', 'magalu'],
      ['/bling-conexao.html', 'Bling', 'bling-conexao'],
      ['/navegador.html', 'Navegador do scraper', 'navegador']] },
    { nome: 'Administração', icone: 'admin', recolhido: true, itens: [
      ['/usuarios.html', 'Usuários e permissões', 'usuarios'],
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
      const nome = m.empresa || m.nome || PADRAO;
      const a = document.createElement('a'); a.href = '/central.html'; a.className = 'sb-marca'; a.setAttribute('aria-label', nome + ' — Central de comando');
      a.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;color:inherit;text-decoration:none';
      const logo = document.createElement('span'); logo.className = 'sb-logo';
      if (m.tem_logo) {
        const img = document.createElement('img');
        img.className = 'marca-logo-painel-mini'; img.alt = ''; img.src = '/api/marca/logo?' + QM + 'v=' + encodeURIComponent(m.v || '0');
        logo.appendChild(img);
      } else logo.textContent = nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || 'P';
      const nomes = document.createElement('span'); nomes.className = 'sb-nomes';
      const b = document.createElement('b'); b.textContent = nome;
      const sub = document.createElement('span'); sub.textContent = EXT && m.nome && m.nome !== nome ? m.nome : 'Gestão de marketplaces';
      nomes.append(b, sub); a.append(logo, nomes); box.appendChild(a);
    }
    // título da aba: "Tela — Nome da empresa" (o nome geral; o da conta pode ser só o do marketplace)
    const base = document.title.split(' — ')[0];
    const nomeAba = m.empresa || (m.personalizado ? m.nome : '');
    document.title = nomeAba ? base + ' — ' + nomeAba : base;
    // ícone da aba: o logo da empresa (senão um ícone simples do painel)
    let ic = document.querySelector('link[rel="icon"]');
    if (!ic) { ic = document.createElement('link'); ic.rel = 'icon'; document.head.appendChild(ic); }
    ic.href = m.tem_logo ? '/api/marca/logo?' + QM + 'v=' + encodeURIComponent(m.v || '0')
      : 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M9 22V10h7a4 4 0 0 1 0 8h-7" fill="none" stroke="#fff" stroke-width="3"/></svg>');
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
  // Telas que a loja não tem (o menu as mostra apagadas, sem trocar de loja). Leroy: o Financeiro são os repasses (leroy.html).
  const SEM_TELA = { amazon: ['/reputacao.html', '/financeiro.html'], shopee: ['/full.html', '/reputacao.html', '/financeiro.html'],
    leroy: ['/full.html', '/reputacao.html', '/ads.html', '/publicar.html'], magalu: ['/full.html', '/reputacao.html', '/ads.html', '/publicar.html', '/financeiro.html'] };
  const comConta = (href, ext = EXT) => {
    const u = new URL(href, location.origin);
    if (SEM_TELA[tipo(ext)].includes(u.pathname)) return null;
    // Dashboard de toda loja = a mesma tela do ML com ?conta= (vendas do dia, gráfico, mais vendidos, resumo de 30 dias)
    if (u.pathname === '/' || u.pathname === '/inicio.html') return `/?conta=${encodeURIComponent(ext)}`;
    // telas de todas as contas: levam a loja escolhida, para a lista do topo não voltar para a conta do ML
    if (DE_TODAS.includes(u.pathname)) { u.searchParams.set('conta', ext); return u.pathname + u.search; }
    if (tipo(ext) === 'amazon') {
      if (u.pathname === '/anuncios.html') return '/amazon-anuncios.html';
      if (u.pathname === '/ads.html') return '/amazon-ads.html';
      if (u.pathname === '/publicar.html') return '/publicar-canais.html?conta=amazon';
      if (u.pathname === '/promocoes.html') return '/campanhas-canais.html?conta=amazon';
      if (u.pathname === '/devolucoes.html') return '/devolucoes-canais.html?conta=amazon';
    } else if (tipo(ext) === 'leroy' || tipo(ext) === 'magalu') {
      if (u.pathname === '/financeiro.html' && ext === 'leroy') return '/leroy.html';
      if (u.pathname === '/promocoes.html') return `/campanhas-canais.html?conta=${ext}`;
      if (u.pathname === '/anuncios.html' && ext === 'magalu') return '/magalu-anuncios.html?conta=magalu';
      if (u.pathname === '/anuncios.html' && ext === 'leroy') return '/leroy-anuncios.html?conta=leroy';
      if (u.pathname === '/devolucoes.html') return `/devolucoes-canais.html?conta=${ext}`;
    } else if (u.pathname === '/anuncios.html') return `/shopee-anuncios.html?conta=${ext}`;
    else if (u.pathname === '/ads.html') return `/shopee-ads.html?conta=${ext}`;
    else if (u.pathname === '/promocoes.html') return `/shopee-campanhas.html?conta=${ext}`;
    else if (u.pathname === '/devolucoes.html') return `/shopee-devolucoes.html?conta=${ext}`;
    else if (u.pathname === '/publicar.html') return `/publicar-canais.html?conta=${ext}`;
    if (!TELAS[tipo(ext)].includes(u.pathname)) return href;
    u.searchParams.set('conta', ext);
    return u.pathname + u.search;
  };
  // Telas que valem para TODAS as contas (a tabela de produtos, o estoque, as comandas…): trocar a loja no topo
  // fica na mesma tela, só com a loja escolhida na lista.
  const DE_TODAS = ['/central.html', '/integracoes.html', '/geral.html', '/metas.html', '/margem.html', '/placar.html', '/caixa.html', '/dre.html', '/compras.html', '/comandas.html', '/etiquetas.html', '/bling.html', '/estoque.html', '/produtos.html', '/mensagens.html', '/calculadora.html',
    '/usuarios.html', '/navegador.html', '/configuracao.html'];
  const telaDaConta = (ext) => {
    if (DE_TODAS.includes(location.pathname)) return location.pathname + '?conta=' + encodeURIComponent(ext);
    const aquiTem = TELAS[tipo(ext)].includes(location.pathname) || ['/anuncios.html', '/ads.html', '/publicar.html'].includes(location.pathname)
      || ['/promocoes.html', '/campanhas-canais.html', '/shopee-campanhas.html'].includes(location.pathname)
      || ['/devolucoes.html', '/', '/inicio.html'].includes(location.pathname);
    // campanhas: de uma conta para outra, a tela de campanhas da outra
    if (['/campanhas-canais.html', '/shopee-campanhas.html'].includes(location.pathname)) return comConta('/promocoes.html', ext);
    if (['/devolucoes-canais.html', '/shopee-devolucoes.html'].includes(location.pathname)) return comConta('/devolucoes.html', ext);
    if (aquiTem) { const u = new URL(location.href); u.searchParams.delete('conta'); const h = comConta(u.pathname + u.search, ext); if (h) return h; }
    return `/?conta=${encodeURIComponent(ext)}`;   // tela que a loja não tem: o Dashboard dela
  };
  const semConta = () => {
    if (DE_TODAS.includes(location.pathname)) return location.pathname;
    if (['/amazon.html', '/leroy.html', '/magalu.html'].includes(location.pathname)) return '/';
    if (location.pathname === '/amazon-anuncios.html') return '/anuncios.html';
    if (location.pathname === '/amazon-ads.html' || location.pathname === '/shopee-ads.html') return '/ads.html';
    if (location.pathname === '/shopee-anuncios.html' || location.pathname === '/magalu-anuncios.html' || location.pathname === '/leroy-anuncios.html') return '/anuncios.html';
    if (location.pathname === '/shopee-campanhas.html' || location.pathname === '/campanhas-canais.html') return '/promocoes.html';
    if (location.pathname === '/shopee-devolucoes.html' || location.pathname === '/devolucoes-canais.html') return '/devolucoes.html';
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

  // Período lembrado por tela (pedido do dono, 03/11/2026: trocar a conta ou a loja mantém o período escolhido).
  // Ordem: ?dias= do endereço › o último escolhido nesta tela (neste navegador) › o padrão da tela; só vale o que existe
  // nos botões dela. Escolher grava os dois, então recarregar (troca de conta do ML) e o link da troca de loja o levam junto.
  const telaPeriodo = () => { const p = location.pathname;
    return /devolucoes/.test(p) ? 'devolucoes' : /ads\.html$/.test(p) ? 'ads' : p; };
  window.periodoInicial = (segId, padrao) => {
    const ok = new Set([...(document.getElementById(segId)?.querySelectorAll('button[data-dias]') || [])].map((b) => b.dataset.dias));
    let guardado = null;
    try { guardado = localStorage.getItem('painel.periodo:' + telaPeriodo()); } catch {}
    const v = [new URLSearchParams(location.search).get('dias'), guardado].find((x) => x != null && ok.has(x));
    return v == null ? padrao : Number.isFinite(Number(v)) ? Number(v) : v;
  };
  window.guardarPeriodo = (v) => {
    // Pedidos não guarda "hoje": a tela Vendas hoje é o item próprio do menu
    if (!(location.pathname === '/vendas.html' && String(v) === '1')) try { localStorage.setItem('painel.periodo:' + telaPeriodo(), String(v)); } catch {}
    const u = new URL(location.href); u.searchParams.set('dias', v);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  };

  const nav = document.getElementById('menuPainel');
  if (!nav) return;
  const raiz = document.documentElement;
  const lateral = nav.closest('.lateral');
  const svg = (nome) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONE[nome] || ''}</svg>`;
  const aqui = location.pathname === '/inicio.html' ? '/' : location.pathname;
  const hoje = new URLSearchParams(location.search).get('dias') === '1';
  let fechados = null;
  try { fechados = JSON.parse(localStorage.getItem('painel.menu.fechados') || 'null'); } catch {}
  if (!Array.isArray(fechados)) fechados = GRUPOS.filter((g) => g.recolhido).map((g) => g.nome);
  for (const g of GRUPOS) {
    const box = document.createElement('div'); box.className = 'nav-grupo'; box.dataset.grupo = g.nome;
    const tit = document.createElement('button'); tit.type = 'button'; tit.className = 'nav-tit';
    tit.innerHTML = svg(g.icone); const tt = document.createElement('span'); tt.className = 'nav-tit-texto'; tt.textContent = g.nome; tit.appendChild(tt);
    const lista = document.createElement('div'); lista.className = 'nav-itens'; lista.dataset.grupo = g.nome;
    lista.id = 'grupo-' + g.nome.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase(); tit.setAttribute('aria-controls', lista.id);
    box.append(tit, lista); nav.appendChild(box);
    for (const it of g.itens) lista.appendChild(itemDoMenu(it));
    if (lista.querySelector('[aria-current]')) box.classList.add('tem-atual');
    // a tela aberta fica sempre à vista, mesmo num grupo fechado
    const aberto = !fechados.includes(g.nome) || !!lista.querySelector('[aria-current]');
    tit.setAttribute('aria-expanded', String(aberto)); lista.hidden = !aberto;
    tit.onclick = () => {
      if (recolhido()) { voar(box, !box.classList.contains('voando')); return; }   // recolhido: abre ao lado
      const abrir = lista.hidden; lista.hidden = !abrir; tit.setAttribute('aria-expanded', String(abrir));
      fechados = abrir ? fechados.filter((n) => n !== g.nome) : [...new Set([...fechados, g.nome])];
      try { localStorage.setItem('painel.menu.fechados', JSON.stringify(fechados)); } catch {}
    };
    // menu recolhido: o grupo abre numa caixa ao lado (mouse, teclado ou toque)
    let saida = null;
    box.addEventListener('mouseenter', () => { clearTimeout(saida); if (recolhido()) voar(box, true); });
    box.addEventListener('mouseleave', () => { saida = setTimeout(() => voar(box, false), 160); });
    box.addEventListener('focusin', () => { if (recolhido()) voar(box, true); });
    box.addEventListener('focusout', (ev) => { if (!box.contains(ev.relatedTarget)) voar(box, false); });
  }
  function recolhido() { return raiz.dataset.menu === 'recolhido' && matchMedia('(min-width:901px)').matches; }
  function voar(box, sim) {
    if (sim) {
      for (const o of nav.querySelectorAll('.nav-grupo.voando')) if (o !== box) o.classList.remove('voando');
      const r = box.querySelector('.nav-tit').getBoundingClientRect();
      box.style.setProperty('--voo-topo', Math.max(8, Math.min(r.top - 6, innerHeight - 80)) + 'px');
    }
    box.classList.toggle('voando', !!sim);
  }
  function itemDoMenu(it) {
    const [href, rotulo, icone] = it;
    const a = document.createElement('a');
    const destino = EXT ? comConta(href) : href;
    if (destino) a.href = destino;
    else { a.className = 'nav-off'; a.setAttribute('aria-disabled', 'true'); a.title = 'Esta loja não tem esta tela'; a.style.opacity = '.4'; a.style.cursor = 'default'; }
    const [caminho, query] = href.split('?');
    const atual = (caminho === aqui || (NA_AMAZON && caminho === '/' && aqui === '/amazon.html')
      || (caminho === '/anuncios.html' && ['/amazon-anuncios.html', '/shopee-anuncios.html', '/magalu-anuncios.html', '/leroy-anuncios.html'].includes(aqui))
      || (caminho === '/ads.html' && ['/amazon-ads.html', '/shopee-ads.html'].includes(aqui))
      || (caminho === '/promocoes.html' && ['/shopee-campanhas.html', '/campanhas-canais.html'].includes(aqui)) || (caminho === '/devolucoes.html' && ['/shopee-devolucoes.html', '/devolucoes-canais.html'].includes(aqui)) || (caminho === '/publicar.html' && aqui === '/publicar-canais.html'))
      && (caminho !== '/vendas.html' || (query === 'dias=1') === hoje);
    if (atual) a.setAttribute('aria-current', 'page');
    a.dataset.icone = icone; a.dataset.rotulo = rotulo;
    a.innerHTML = svg(icone);
    const t = document.createElement('span'); t.className = 'nav-rot'; t.textContent = rotulo; a.appendChild(t);
    return a;
  }
  // Contador ao lado de um item (ex.: comandas a imprimir, por public/comandas-aviso.js). 0 tira.
  // Com o menu recolhido, o grupo do item ganha um ponto vermelho.
  window.contadorMenu = (caminho, n) => {
    for (const a of nav.querySelectorAll('a')) {
      if (new URL(a.href, location.origin).pathname !== caminho) continue;
      let c = a.querySelector('.nav-cont');
      if (!n) { if (c) c.remove(); continue; }
      if (!c) { c = document.createElement('span'); c.className = 'nav-cont'; a.appendChild(c); }
      c.textContent = n > 99 ? '99+' : String(n);
    }
    for (const g of nav.querySelectorAll('.nav-grupo')) g.classList.toggle('tem-aviso', !!g.querySelector('.nav-cont'));
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
  // Rodapé do menu: quem está usando e os botões (tema, recolher, aviso de comanda, senha, sair), com dica
  const rodape = (eu) => {
    if (!eu || document.getElementById('menuEu')) return;
    const box = document.createElement('div'); box.id = 'menuEu';
    const quem = document.createElement('div'); quem.className = 'sb-quem';
    const nomeEu = eu.admin ? 'Administrador' : eu.nome;
    const ini = document.createElement('i'); ini.textContent = (nomeEu.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('') || '?').toUpperCase();
    ini.setAttribute('data-dica', nomeEu);
    const txt = document.createElement('span'); const b = document.createElement('b'); b.textContent = nomeEu;
    const sm = document.createElement('small'); sm.textContent = eu.admin ? 'acesso total' : eu.login; txt.append(b, sm);
    quem.append(ini, txt); box.appendChild(quem);
    const acoes = document.createElement('div'); acoes.className = 'sb-acoes';
    const botao = (rotulo, icone, fn) => { const x = document.createElement('button'); x.type = 'button'; x.innerHTML = svg(icone);
      x.setAttribute('aria-label', rotulo); x.setAttribute('data-dica', rotulo); x.onclick = fn; acoes.appendChild(x); return x; };
    // tema claro / escuro (public/tema.js), por pessoa neste navegador
    const tema = botao('', 'escuro', () => { if (window.trocarTema) window.trocarTema(); pintarTema(); });
    const pintarTema = () => { const escuro = raiz.dataset.tema === 'escuro'; tema.innerHTML = svg(escuro ? 'claro' : 'escuro');
      const r = escuro ? 'Tema claro' : 'Tema escuro'; tema.setAttribute('aria-label', r); tema.setAttribute('data-dica', r); };
    pintarTema();
    const rec = botao('', 'recolher', () => { if (window.recolherMenu) window.recolherMenu(); pintarRec(); });
    rec.classList.add('sb-recolher');
    const pintarRec = () => { const r = raiz.dataset.menu === 'recolhido'; rec.innerHTML = svg(r ? 'expandir' : 'recolher');
      const t = r ? 'Expandir menu' : 'Recolher menu'; rec.setAttribute('aria-label', t); rec.setAttribute('data-dica', t);
      for (const g of nav.querySelectorAll('.nav-grupo.voando')) g.classList.remove('voando'); };
    pintarRec();
    document.addEventListener('painel:rodape', () => { pintarTema(); pintarRec(); });
    // aviso de comanda nova (public/comandas-aviso.js): testa o som e a notificação do Windows
    if (eu.admin || (eu.paginas || []).includes('/comandas.html')) botao('Testar aviso de comanda', 'sino', () => { if (window.testarAvisoComanda) window.testarAvisoComanda(); });
    if (!eu.admin) botao('Trocar minha senha', 'senha', () => { location.href = '/trocar-senha'; });
    botao('Sair', 'sair', () => { const f = document.createElement('form'); f.method = 'POST'; f.action = '/sair'; document.body.appendChild(f); f.submit(); });
    box.appendChild(acoes);
    (lateral || nav).appendChild(box);
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

  // ---------- tela atual: grupo e nome (caminho no cabeçalho e últimas telas abertas) ----------
  const atualA = nav.querySelector('a[aria-current]');
  const telaAtual = atualA ? { href: location.pathname + location.search, t: atualA.dataset.rotulo, g: atualA.closest('.nav-grupo')?.dataset.grupo || '', i: atualA.dataset.icone } : null;
  if (telaAtual && !atualA.classList.contains('nav-off')) {
    try {
      const lista = JSON.parse(localStorage.getItem('painel.recentes') || '[]').filter((x) => x && x.t !== telaAtual.t);
      localStorage.setItem('painel.recentes', JSON.stringify([telaAtual, ...lista].slice(0, 6)));
    } catch {}
  }

  // ---------- cabeçalho: botão do menu (celular), caminho, busca de telas ----------
  function montarCabecalho() {
    const cab = document.querySelector('.conteudo > header');
    if (!cab || cab.dataset.ds) return;
    cab.dataset.ds = '1';
    const esq = document.createElement('div'); esq.className = 'cab-esq';
    const bMenu = document.createElement('button'); bMenu.type = 'button'; bMenu.id = 'cabMenu'; bMenu.className = 'cab-icone';
    bMenu.innerHTML = svg('menu'); bMenu.setAttribute('aria-label', 'Abrir o menu'); bMenu.setAttribute('aria-expanded', 'false');
    bMenu.onclick = () => gaveta(raiz.dataset.gaveta !== 'aberta');
    const tit = document.createElement('div'); tit.className = 'cab-titulo';
    if (telaAtual) {
      const m = document.createElement('nav'); m.className = 'migalhas'; m.setAttribute('aria-label', 'Caminho');
      const inicio = document.createElement('a'); inicio.href = '/central.html'; inicio.textContent = 'Início';
      const s1 = document.createElement('span'); s1.className = 'sep'; s1.textContent = '›';
      const g = document.createElement('span'); g.textContent = telaAtual.g;
      m.append(inicio, s1, g);
      if (telaAtual.g !== telaAtual.t) { const s2 = document.createElement('span'); s2.className = 'sep'; s2.textContent = '›';
        const t = document.createElement('span'); t.textContent = telaAtual.t; t.setAttribute('aria-current', 'page'); m.append(s2, t); }
      tit.appendChild(m);
    }
    // o h1 e a nota do cabeçalho (cada tela pode trocar o texto deles; os elementos são os mesmos)
    for (const el of [...cab.children]) if (el.tagName === 'H1' || el.classList.contains('cabecaNota')) tit.appendChild(el);
    esq.append(bMenu, tit);
    const dir = document.createElement('div'); dir.className = 'cab-dir';
    const busca = document.createElement('button'); busca.type = 'button'; busca.className = 'cab-busca';
    busca.innerHTML = svg('busca') + '<span>Buscar telas…</span><kbd>Ctrl K</kbd>';
    busca.setAttribute('aria-label', 'Buscar telas (Ctrl+K)'); busca.onclick = () => abrirBusca();
    dir.appendChild(busca);
    for (const el of [...cab.children]) dir.appendChild(el);   // lista de contas, sino e o que a tela pôs no cabeçalho
    cab.append(esq, dir);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montarCabecalho); else montarCabecalho();

  // ---------- gaveta do celular ----------
  function gaveta(abrir) {
    if (abrir) {
      raiz.dataset.gaveta = 'aberta';
      if (!document.querySelector('.sb-fundo')) { const f = document.createElement('div'); f.className = 'sb-fundo'; f.onclick = () => gaveta(false); document.body.appendChild(f); }
      const pri = nav.querySelector('a[aria-current]') || nav.querySelector('a');
      setTimeout(() => { if (lateral) lateral.scrollLeft = 0; pri?.focus({ preventScroll: true }); pri?.scrollIntoView({ block: 'nearest' }); }, 220);
    } else {
      delete raiz.dataset.gaveta; document.querySelector('.sb-fundo')?.remove();
    }
    document.getElementById('cabMenu')?.setAttribute('aria-expanded', String(!!abrir));
  }
  nav.addEventListener('click', (ev) => { if (ev.target.closest('a[href]') && raiz.dataset.gaveta === 'aberta') gaveta(false); });
  addEventListener('resize', () => { if (raiz.dataset.gaveta && matchMedia('(min-width:901px)').matches) gaveta(false); });

  // ---------- busca de telas (Ctrl+K ou /) ----------
  const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function opcoesDaBusca() {
    const ops = [];
    for (const a of nav.querySelectorAll('a[href]')) {
      if (a.classList.contains('nav-off')) continue;
      ops.push({ t: a.dataset.rotulo, g: a.closest('.nav-grupo')?.dataset.grupo || '', i: a.dataset.icone, href: a.getAttribute('href') });
    }
    ops.push({ t: raiz.dataset.tema === 'escuro' ? 'Usar o tema claro' : 'Usar o tema escuro', g: 'Ação', i: raiz.dataset.tema === 'escuro' ? 'claro' : 'escuro',
      fazer: () => { window.trocarTema?.(); document.dispatchEvent(new Event('painel:rodape')); } });
    if (matchMedia('(min-width:901px)').matches) ops.push({ t: raiz.dataset.menu === 'recolhido' ? 'Expandir o menu lateral' : 'Recolher o menu lateral', g: 'Ação', i: 'recolher',
      fazer: () => { window.recolherMenu?.(); document.dispatchEvent(new Event('painel:rodape')); } });
    return ops;
  }
  function abrirBusca() {
    if (document.querySelector('.cmdk-fundo')) return;
    const anterior = document.activeElement;
    const fundo = document.createElement('div'); fundo.className = 'cmdk-fundo';
    fundo.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="Buscar telas">
      <div class="cmdk-campo">${svg('busca')}<input type="text" placeholder="Buscar telas e ações…" aria-label="Buscar telas" role="combobox" aria-expanded="true" aria-controls="cmdkLista" autocomplete="off"></div>
      <div class="cmdk-lista" id="cmdkLista" role="listbox"></div>
      <div class="cmdk-pe"><span><kbd>↑</kbd> <kbd>↓</kbd> escolher</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Esc</kbd> fechar</span></div></div>`;
    document.body.appendChild(fundo);
    const campo = fundo.querySelector('input'), lista = fundo.querySelector('.cmdk-lista');
    const todas = opcoesDaBusca();
    let recentes = [];
    try { recentes = JSON.parse(localStorage.getItem('painel.recentes') || '[]').filter((r) => todas.some((o) => o.t === r.t)); } catch {}
    let vis = [], sel = 0;
    const fechar = () => { fundo.remove(); removeEventListener('keydown', teclas, true); anterior?.focus?.(); };
    const ir = (o) => { if (!o) return; fechar(); if (o.fazer) o.fazer(); else location.href = o.href; };
    const pintar = () => {
      const q = semAcento(campo.value).trim().split(/\s+/).filter(Boolean);
      lista.textContent = '';
      const secoes = [];
      if (!q.length) {
        if (recentes.length) secoes.push(['Abertas por último', recentes.map((r) => ({ ...todas.find((o) => o.t === r.t), recente: true }))]);
        secoes.push(['Todas as telas', todas]);
      } else {
        const achou = todas.map((o) => { const alvo = semAcento(o.t + ' ' + o.g); if (!q.every((p) => alvo.includes(p))) return null;
          return { o, nota: (semAcento(o.t).startsWith(q[0]) ? 0 : 1) + (semAcento(o.t).includes(q.join(' ')) ? 0 : 1) }; })
          .filter(Boolean).sort((a, b) => a.nota - b.nota).map((x) => x.o);
        secoes.push(['Resultados', achou]);
      }
      vis = [];
      for (const [nome, ops] of secoes) {
        if (!ops.length) continue;
        const h = document.createElement('div'); h.className = 'cmdk-sec'; h.textContent = nome; lista.appendChild(h);
        for (const o of ops) {
          const idx = vis.length; vis.push(o);
          const el = document.createElement('a'); el.className = 'cmdk-op'; el.setAttribute('role', 'option'); el.id = 'cmdk-' + idx;
          if (o.href) el.href = o.href;
          el.innerHTML = svg(o.recente ? 'relogio' : o.i);
          const t = document.createElement('span'); t.className = 't'; t.textContent = o.t;
          const g = document.createElement('span'); g.className = 'g'; g.textContent = o.g;
          el.append(t, g);
          el.onmouseenter = () => marcar(idx);
          el.onclick = (ev) => { ev.preventDefault(); ir(o); };
          lista.appendChild(el);
        }
      }
      if (!vis.length) { const n = document.createElement('div'); n.className = 'cmdk-nada'; n.textContent = 'Nenhuma tela com esse nome.'; lista.appendChild(n); }
      marcar(0);
    };
    const marcar = (i) => {
      sel = Math.max(0, Math.min(i, vis.length - 1));
      for (const el of lista.querySelectorAll('.cmdk-op')) el.setAttribute('aria-selected', String(el.id === 'cmdk-' + sel));
      const el = document.getElementById('cmdk-' + sel); if (el) { el.scrollIntoView({ block: 'nearest' }); campo.setAttribute('aria-activedescendant', el.id); }
    };
    const teclas = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); fechar(); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); marcar(sel + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); marcar(sel - 1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); ir(vis[sel]); }
    };
    addEventListener('keydown', teclas, true);
    fundo.addEventListener('mousedown', (ev) => { if (ev.target === fundo) fechar(); });
    campo.addEventListener('input', pintar);
    pintar(); campo.focus();
  }
  window.abrirBuscaTelas = abrirBusca;
  addEventListener('keydown', (ev) => {
    const digitando = ev.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if ((ev.key === 'k' || ev.key === 'K') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); abrirBusca(); }
    else if (ev.key === '/' && !digitando && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); abrirBusca(); }
    else if (ev.key === 'Escape' && raiz.dataset.gaveta === 'aberta') gaveta(false);
  });

  // componentes comuns (aviso rápido, confirmação, ordenar tabelas, dicas): public/ui.js
  if (!window.ui) { const sc = document.createElement('script'); sc.src = '/ui.js?v=1'; sc.defer = true; document.head.appendChild(sc); }
})();
