// Gestão das campanhas do Mercado Ads na tela Publicidade (Ads): criar e editar campanha e escolher os anúncios de cada
// uma (colocar, mover de outra campanha, pausar, reativar, tirar). Tudo muda no Mercado Livre na hora, SÓ depois da
// confirmação. Usa os ajudantes da tela (el, $, api, real, pct, razao, SITUACAO_ADS, ESTRATEGIA_ADS) e chama
// recarregarAds() depois de cada mudança. Servidor: ads-gestao.js.
(function () {
  const ESTRATEGIAS = [['profitability', 'Rentabilidade', 'Mostra menos, para quem tem mais chance de comprar. Para quem já vende bem.'],
    ['increase', 'Crescimento', 'Equilíbrio entre rentabilidade e alcance.'],
    ['visibility', 'Visibilidade', 'Investe mais para aparecer para mais gente. Para anúncios novos.']];
  const enviar = (caminho, metodo, corpo) => api(caminho, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  // "11,5", "11.5", "1.250,00" -> número; vazio -> null
  const num = (v) => {
    const s = String(v ?? '').trim().replace(/\s|R\$/g, '');
    if (!s) return null;
    const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) ? n : null;
  };
  const vezes = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x');
  let campanhas = [];

  // ---------- lista de campanhas com os botões ----------
  function montar(lista) {
    campanhas = lista || [];
    const box = $('gestaoCampanhas'); box.innerHTML = '';
    if (!campanhas.length) { box.appendChild(el('p', 'vazio', 'Nenhuma campanha ainda: crie a primeira.')); return; }
    const t = el('table'); const cab = el('tr');
    for (const h of ['Campanha', 'Situação', 'Orçamento/dia', 'Estratégia', 'ROAS objetivo', 'ROAS (período)', '']) cab.appendChild(el('th', null, h));
    const th = el('thead'); th.appendChild(cab); t.appendChild(th);
    const tb = el('tbody');
    const ordem = [...campanhas].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || String(a.nome).localeCompare(String(b.nome)));
    for (const c of ordem) {
      const tr = el('tr');
      const acoes = el('td', 'acoes-gestao');
      const bEd = el('button', 'bt', 'Editar'); bEd.type = 'button'; bEd.onclick = () => abrirCampanha(c);
      const bAn = el('button', 'bt primario', 'Anúncios'); bAn.type = 'button'; bAn.onclick = () => abrirAnuncios(c);
      acoes.append(bEd, bAn);
      tr.append(el('td', 'esq', c.nome), el('td', null, SITUACAO_ADS[c.status] || c.status), el('td', null, real(c.orcamento_diario)),
        el('td', null, ESTRATEGIA_ADS[c.estrategia] || c.estrategia || '—'), el('td', null, vezes(c.roas_alvo)), el('td', null, vezes(c.roas)), acoes);
      tb.appendChild(tr);
    }
    t.appendChild(tb); box.appendChild(t);
  }

  // ---------- criar / editar campanha ----------
  function campo(rotulo, entrada, nota) {
    const w = el('label', 'campo-gestao'); w.append(el('span', null, rotulo), entrada);
    if (nota) w.appendChild(el('small', null, nota));
    return w;
  }
  function abrirCampanha(c) {
    const nova = !c;
    const dlg = $('dlgCampanha'); dlg.innerHTML = '';
    const f = el('form'); f.method = 'dialog';
    f.appendChild(el('h3', null, nova ? 'Criar campanha' : `Editar campanha: ${c.nome}`));
    const iNome = el('input'); iNome.maxLength = 100; iNome.required = true; iNome.value = c?.nome || '';
    const sSit = el('select'); for (const [v, t] of [['active', 'Ativa'], ['paused', 'Pausada']]) { const o = el('option', null, t); o.value = v; sSit.appendChild(o); }
    sSit.value = c?.status === 'paused' ? 'paused' : 'active';
    const iOrc = el('input'); iOrc.inputMode = 'decimal'; iOrc.value = c?.orcamento_diario != null ? String(c.orcamento_diario).replace('.', ',') : '';
    const sEst = el('select'); for (const [v, t] of ESTRATEGIAS) { const o = el('option', null, t); o.value = v; sEst.appendChild(o); }
    sEst.value = String(c?.estrategia || 'profitability').toLowerCase();
    const notaEst = el('small', null, ''); const pintaEst = () => { notaEst.textContent = ESTRATEGIAS.find((e) => e[0] === sEst.value)?.[2] || ''; };
    sEst.onchange = pintaEst; pintaEst();
    const iRoas = el('input'); iRoas.inputMode = 'decimal'; iRoas.value = c?.roas_alvo != null ? String(c.roas_alvo).replace('.', ',') : '';
    const notaRoas = el('small', null, '');
    const pintaRoas = () => { const r = num(iRoas.value); notaRoas.textContent = r >= 1 ? `De 1x a 35x. ACOS equivalente: ${pct(1 / r)} (gasto ÷ venda com Ads). ROAS menor = mais vendas e menos lucro por venda.` : 'De 1x a 35x.'; };
    iRoas.oninput = pintaRoas; pintaRoas();
    const grade = el('div', 'grade-gestao');
    grade.append(campo('Nome', iNome), campo('Situação', sSit),
      campo('Orçamento diário (R$)', iOrc, 'Média por dia do orçamento do mês: num dia o ML pode gastar até o dobro com a sobra dos dias anteriores.'),
      campo('Estratégia', sEst), campo('ROAS objetivo', iRoas));
    grade.lastChild.appendChild(notaRoas); grade.children[3].appendChild(notaEst);
    const status = el('p', 'status-gestao', '');
    const bOk = el('button', 'bt primario', nova ? 'Criar campanha' : 'Salvar mudanças'); bOk.type = 'submit';
    const bX = el('button', 'bt', 'Cancelar'); bX.type = 'button'; bX.onclick = () => dlg.close();
    const rod = el('div', 'rodape-gestao'); rod.append(status, bX, bOk);
    f.append(grade, rod);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const novo = { nome: iNome.value.trim(), status: sSit.value, orcamento: num(iOrc.value), estrategia: sEst.value, roas_alvo: num(iRoas.value) };
      const antes = c ? { nome: c.nome, status: c.status, orcamento: c.orcamento_diario, estrategia: String(c.estrategia || '').toLowerCase(), roas_alvo: c.roas_alvo } : {};
      const corpo = nova ? novo : Object.fromEntries(Object.entries(novo).filter(([k, v]) => String(v) !== String(antes[k] ?? '')));
      if (!Object.keys(corpo).length) { status.textContent = 'Nada mudou.'; return; }
      const rot = { nome: 'Nome', status: 'Situação', orcamento: 'Orçamento diário', estrategia: 'Estratégia', roas_alvo: 'ROAS objetivo' };
      const fmt = (k, v) => (v == null || v === '' ? '—' : k === 'orcamento' ? real(v) : k === 'roas_alvo' ? vezes(v)
        : k === 'status' ? (SITUACAO_ADS[v] || v) : k === 'estrategia' ? (ESTRATEGIAS.find((e) => e[0] === String(v).toLowerCase())?.[1] || v) : v);
      const linhas = Object.keys(corpo).map((k) => nova ? `${rot[k]}: ${fmt(k, corpo[k])}` : `${rot[k]}: ${fmt(k, antes[k])} → ${fmt(k, corpo[k])}`);
      if (!confirm((nova ? 'Criar esta campanha no Mercado Livre?\n\n' : `Mudar a campanha "${c.nome}" no Mercado Livre?\n\n`) + linhas.join('\n')
        + (corpo.status === 'active' && nova ? '\n\nEla começa ativa, mas só gasta depois que você colocar anúncios nela.' : ''))) return;
      bOk.disabled = true; status.textContent = 'Enviando ao Mercado Livre…';
      try {
        const r = nova ? await enviar('/api/ads/campanhas', 'POST', corpo) : await enviar(`/api/ads/campanhas/${c.id}`, 'PUT', corpo);
        dlg.close();
        mensagem(nova ? `Campanha "${r.campanha.nome}" criada. Agora coloque os anúncios nela (botão Anúncios).` : `Campanha "${c.nome}" alterada no Mercado Livre.`);
        recarregarAds();
        if (nova && r.campanha.id) abrirAnuncios({ id: r.campanha.id, nome: r.campanha.nome }, 'adicionar');
      } catch (e) { status.textContent = 'O Mercado Livre recusou: ' + e.message; bOk.disabled = false; }
    };
    dlg.appendChild(f); dlg.showModal(); iNome.focus();
  }

  // ---------- anúncios de uma campanha ----------
  function linhaGrupo(g, marcados, extra) {
    const tr = el('tr');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = marcados.has(g.ad_group_id);
    cb.onchange = () => { if (cb.checked) marcados.add(g.ad_group_id); else marcados.delete(g.ad_group_id); extra.aoMarcar?.(); };
    const tdC = el('td'); tdC.appendChild(cb);
    const tdT = el('td', 'esq');
    const prod = el('div', 'prod-gestao');
    if (g.foto) { const img = el('img'); img.src = g.foto; img.alt = ''; img.loading = 'lazy'; prod.appendChild(img); }
    const txt = el('div'); txt.appendChild(el('b', null, g.titulo || g.itens[0]?.titulo || 'Anúncio'));
    const ids = g.itens.map((i) => i.item_id).filter(Boolean);
    txt.appendChild(el('span', 'pequeno', ids.length > 1 ? `${ids.length} anúncios no grupo: ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''}` : ids[0] || ''));
    if (g.recomendado) txt.appendChild(el('span', 'chip verde', 'recomendado pelo ML'));
    prod.appendChild(txt); tdT.appendChild(prod);
    tr.append(tdC, tdT);
    for (const c of extra.colunas(g)) tr.appendChild(c instanceof Node ? c : el('td', null, c));
    return tr;
  }
  function tabelaGrupos(box, grupos, marcados, cols, colunas, aoMarcar) {
    box.innerHTML = '';
    if (!grupos.length) { box.appendChild(el('p', 'vazio', 'Nenhum anúncio.')); return; }
    const t = el('table'); const cab = el('tr');
    const todos = el('input'); todos.type = 'checkbox'; todos.title = 'Marcar todos';
    todos.onchange = () => { for (const g of grupos) { if (todos.checked) marcados.add(g.ad_group_id); else marcados.delete(g.ad_group_id); } tabelaGrupos(box, grupos, marcados, cols, colunas, aoMarcar); aoMarcar(); };
    todos.checked = grupos.every((g) => marcados.has(g.ad_group_id));
    const th0 = el('th'); th0.appendChild(todos); cab.appendChild(th0);
    for (const h of ['Anúncio', ...cols]) cab.appendChild(el('th', null, h));
    const th = el('thead'); th.appendChild(cab); t.appendChild(th);
    const tb = el('tbody'); for (const g of grupos) tb.appendChild(linhaGrupo(g, marcados, { colunas, aoMarcar })); t.appendChild(tb);
    box.appendChild(t);
  }

  function abrirAnuncios(c, aba = 'campanha') {
    const dlg = $('dlgAnuncios'); dlg.innerHTML = '';
    dlg.appendChild(el('h3', null, `Anúncios da campanha: ${c.nome}`));
    dlg.appendChild(el('p', 'sub', 'O Mercado Livre junta as variações e os anúncios do mesmo produto num GRUPO: colocar, pausar ou tirar vale para o grupo todo.'));
    const abas = el('div', 'seg'); const bCamp = el('button', null, 'Nesta campanha'); const bAdd = el('button', null, 'Adicionar anúncios');
    bCamp.type = bAdd.type = 'button'; abas.append(bCamp, bAdd);
    const corpo = el('div', 'corpo-gestao'); const status = el('p', 'status-gestao', '');
    const bFechar = el('button', 'bt', 'Fechar'); bFechar.type = 'button'; bFechar.onclick = () => dlg.close();
    const acoes = el('div', 'rodape-gestao');
    dlg.append(abas, corpo, acoes);
    const ativa = (b) => { for (const x of [bCamp, bAdd]) x.classList.toggle('ativo', x === b); };
    const titulos = (grupos, ids) => grupos.filter((g) => ids.includes(g.ad_group_id)).map((g) => g.titulo || g.itens[0]?.item_id);

    async function nesta() {
      ativa(bCamp); acoes.innerHTML = ''; corpo.innerHTML = ''; corpo.appendChild(el('p', 'carregando', 'Carregando os anúncios da campanha…'));
      const marcados = new Set();
      const bPausar = el('button', 'bt', 'Pausar'), bAtivar = el('button', 'bt', 'Reativar'), bTirar = el('button', 'bt perigo', 'Tirar da campanha');
      for (const b of [bPausar, bAtivar, bTirar]) { b.type = 'button'; b.disabled = true; }
      acoes.append(status, bPausar, bAtivar, bTirar, bFechar);
      let r;
      try { r = await api(`/api/ads/campanhas/${c.id}/anuncios?dias=30`); } catch (e) { corpo.innerHTML = ''; corpo.appendChild(el('p', 'vazio', 'Não consegui ler: ' + e.message)); return; }
      const aoMarcar = () => { for (const b of [bPausar, bAtivar, bTirar]) b.disabled = !marcados.size; status.textContent = marcados.size ? `${marcados.size} marcado(s)` : `${r.total} grupo(s) na campanha`; };
      const lista = el('div', 'tabela-rolagem lista-gestao'); corpo.innerHTML = ''; corpo.appendChild(lista);
      tabelaGrupos(lista, r.anuncios, marcados, ['Situação', 'Investido 30d', 'Receita 30d', 'ROAS'],
        (g) => [SITUACAO_ADS[g.status] || g.status || '—', real(g.investimento), real(g.receita), vezes(g.roas)], aoMarcar);
      aoMarcar();
      const agir = async (tipo) => {
        const ids = [...marcados];
        const nomes = titulos(r.anuncios, ids);
        const textos = { pausar: `Pausar ${ids.length} grupo(s) de anúncio na campanha "${c.nome}"? Eles param de aparecer no Ads, mas continuam na campanha.`,
          ativar: `Reativar ${ids.length} grupo(s) de anúncio na campanha "${c.nome}"? Eles voltam a gastar.`,
          tirar: `Tirar ${ids.length} grupo(s) de anúncio da campanha "${c.nome}"? Eles ficam fora de qualquer campanha (sem gasto).` };
        if (!confirm(textos[tipo] + '\n\n' + nomes.slice(0, 8).join('\n') + (nomes.length > 8 ? `\n… e mais ${nomes.length - 8}` : ''))) return;
        for (const b of [bPausar, bAtivar, bTirar]) b.disabled = true; status.textContent = 'Enviando ao Mercado Livre…';
        try {
          const res = tipo === 'tirar'
            ? await enviar(`/api/ads/campanhas/${c.id}/remover`, 'POST', { ad_groups: ids, campanha_nome: c.nome, titulos: nomes })
            : await enviar(`/api/ads/campanhas/${c.id}/anuncios`, 'POST', { ad_groups: ids, status: tipo === 'pausar' ? 'paused' : 'active', campanha_nome: c.nome, titulos: nomes });
          mensagem(res.aviso || (tipo === 'tirar' ? `${ids.length} grupo(s) retirado(s) da campanha.` : `${ids.length} grupo(s) ${tipo === 'pausar' ? 'pausado(s)' : 'reativado(s)'}.`));
          recarregarAds(); nesta();
        } catch (e) { status.textContent = 'O Mercado Livre recusou: ' + e.message; aoMarcar(); }
      };
      bPausar.onclick = () => agir('pausar'); bAtivar.onclick = () => agir('ativar'); bTirar.onclick = () => agir('tirar');
    }

    async function adicionar() {
      ativa(bAdd); acoes.innerHTML = ''; corpo.innerHTML = '';
      const marcados = new Set(); let grupos = [];
      const busca = el('input'); busca.type = 'search'; busca.placeholder = 'Buscar por título ou MLB…';
      const soSem = el('input'); soSem.type = 'checkbox';
      const lSem = el('label', 'check-gestao'); lSem.append(soSem, ' só os que não estão em nenhuma campanha');
      const bBuscar = el('button', 'bt', 'Buscar'); bBuscar.type = 'button';
      const barra = el('div', 'barra-gestao'); barra.append(busca, bBuscar, lSem);
      const lista = el('div', 'tabela-rolagem lista-gestao');
      corpo.append(barra, lista);
      const bColocar = el('button', 'bt primario', 'Colocar na campanha'); bColocar.type = 'button'; bColocar.disabled = true;
      acoes.append(status, bFechar, bColocar);
      const aoMarcar = () => {
        bColocar.disabled = !marcados.size;
        const mover = grupos.filter((g) => marcados.has(g.ad_group_id) && g.campanha_id).length;
        status.textContent = marcados.size ? `${marcados.size} marcado(s)` + (mover ? ` · ${mover} sai(em) de outra campanha` : '') : '';
      };
      const carregarLista = async () => {
        lista.innerHTML = ''; lista.appendChild(el('p', 'carregando', 'Lendo os anúncios do Ads (a primeira vez demora um pouco)…'));
        try {
          const q = new URLSearchParams({ q: busca.value.trim(), fora: String(c.id), sem_campanha: soSem.checked ? '1' : '' });
          const r = await api('/api/ads/gestao/anuncios?' + q);
          grupos = r.anuncios;
          tabelaGrupos(lista, grupos, marcados, ['Campanha atual', 'Investido 30d', 'Receita 30d'],
            (g) => [g.campanha ? el('td', null, g.campanha) : el('td', 'pequeno', 'nenhuma'), real(g.investimento), real(g.receita)], aoMarcar);
          if (r.total > grupos.length) lista.appendChild(el('p', 'sub', `Mostrando ${grupos.length} de ${r.total}: busque para achar os outros.`));
          aoMarcar();
        } catch (e) { lista.innerHTML = ''; lista.appendChild(el('p', 'vazio', 'Não consegui ler: ' + e.message)); }
      };
      bBuscar.onclick = carregarLista; busca.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); carregarLista(); } };
      soSem.onchange = carregarLista;
      bColocar.onclick = async () => {
        const ids = [...marcados];
        const escolhidos = grupos.filter((g) => ids.includes(g.ad_group_id));
        const mover = escolhidos.filter((g) => g.campanha_id);
        const nomes = escolhidos.map((g) => (g.titulo || g.itens[0]?.item_id) + (g.campanha ? `  (sai de "${g.campanha}")` : ''));
        if (!confirm(`Colocar ${ids.length} grupo(s) de anúncio na campanha "${c.nome}"?` + (mover.length ? `\n\n${mover.length} já está(ão) em outra campanha e será(ão) MOVIDO(S) para esta.` : '')
          + '\n\n' + nomes.slice(0, 8).join('\n') + (nomes.length > 8 ? `\n… e mais ${nomes.length - 8}` : '') + '\n\nEles começam a gastar pelo orçamento desta campanha.')) return;
        bColocar.disabled = true; status.textContent = 'Enviando ao Mercado Livre…';
        try {
          const res = await enviar(`/api/ads/campanhas/${c.id}/anuncios`, 'POST', { ad_groups: ids, status: 'active', mover: mover.length > 0,
            campanha_nome: c.nome, titulos: escolhidos.map((g) => g.titulo || g.itens[0]?.item_id) });
          mensagem(res.aviso || `${ids.length} grupo(s) colocado(s) na campanha "${c.nome}".`);
          recarregarAds(); nesta();
        } catch (e) { status.textContent = 'O Mercado Livre recusou: ' + e.message; bColocar.disabled = false; }
      };
      carregarLista();
    }
    bCamp.onclick = nesta; bAdd.onclick = adicionar;
    dlg.showModal();
    (aba === 'adicionar' ? adicionar : nesta)();
  }

  function mensagem(t) { const m = $('gestaoMsg'); m.textContent = t; m.style.display = t ? 'block' : 'none'; }

  // ---------- antes e depois de uma data, na campanha escolhida no filtro ----------
  let campAD = null;
  function antesDepois(campanha, mudancas) {
    const bloco = $('blocoAntesDepois');
    if (!campanha) { bloco.hidden = true; campAD = null; return; }
    bloco.hidden = false;
    if (campAD === campanha.id) return;   // mesma campanha: mantém o que o vendedor escolheu
    campAD = campanha.id;
    const dia = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
    const datas = [...new Set((mudancas || []).filter((m) => Number(m.campanha_id) === Number(campanha.id)).map((m) => dia(m.em)))].sort().reverse();
    const ontem = dia(new Date(Date.now() - 864e5).toISOString());
    $('adData').max = ontem;
    $('adData').value = datas[0] && datas[0] <= ontem ? datas[0] : (campanha.criada_em ? dia(campanha.criada_em) : ontem);
    const at = $('adAtalhos'); at.innerHTML = '';
    if (datas.length) {
      at.append('Mudanças:');
      for (const d of datas.slice(0, 6)) { const b = el('button', 'bt', data(d)); b.type = 'button'; b.title = 'Comparar antes e depois de ' + data(d); b.onclick = () => { $('adData').value = d; comparar(); }; at.appendChild(b); }
    }
    if (campanha.criada_em) { const b = el('button', 'bt', 'criação'); b.type = 'button'; b.title = 'Antes e depois de a campanha começar'; b.onclick = () => { $('adData').value = dia(campanha.criada_em); comparar(); }; at.append(' ', b); }
    $('adResultado').innerHTML = '';
    $('adResultado').appendChild(el('p', 'sub', 'Escolha a data e clique Comparar.'));
  }
  async function comparar() {
    const box = $('adResultado'); box.innerHTML = '';
    if (!campAD) return;
    box.appendChild(el('p', 'carregando', 'Somando as vendas e o Ads dos dois períodos…'));
    let r;
    try { r = await api(`/api/ads/campanhas/${campAD}/antes-depois?data=${encodeURIComponent($('adData').value)}&dias=${$('adDias').value}`); }
    catch (e) { box.innerHTML = ''; box.appendChild(el('p', 'vazio', e.message)); return; }
    box.innerHTML = '';
    const j = r.janelas, A = r.total.antes, D = r.total.depois;
    const varDia = (a, d, campo) => { const pa = a[campo] / j.antes.dias, pd = d[campo] / j.depois.dias; return pa > 0 ? pd / pa - 1 : null; };
    const celVar = (v) => { const td = el('td', v == null ? '' : v > 0.03 ? 'mais' : v < -0.03 ? 'menos' : '', v == null ? '—' : (v > 0 ? '+' : '') + pct(v, 0)); return td; };
    box.appendChild(el('p', 'sub', `Antes: ${data(j.antes.de)} a ${data(j.antes.ate)} (${j.antes.dias} dias) · Depois: ${data(j.depois.de)} a ${data(j.depois.ate)} (${j.depois.dias} dias). `
      + (j.depois.dias < j.antes.dias ? 'O depois tem menos dias (vai até ontem): compare pela coluna "por dia". ' : '')
      + 'Os últimos 2 a 3 dias ainda recebem vendas atribuídas ao Ads.'));
    const t = el('table', 'comp'); const cab = el('tr');
    for (const h of ['', 'Antes', 'Depois', 'Variação por dia']) cab.appendChild(el('th', null, h));
    const th = el('thead'); th.appendChild(cab); t.appendChild(th);
    const tb = el('tbody');
    const linha = (rot, a, d, fmt, campo) => { const tr = el('tr'); tr.append(el('td', 'esq', rot), el('td', null, fmt(a)), el('td', null, fmt(d)), campo ? celVar(varDia(A, D, campo)) : el('td', null, '')); tb.appendChild(tr); };
    linha('Unidades vendidas (todas)', A.unidades, D.unidades, numero, 'unidades');
    linha('Faturamento (todas as vendas)', A.faturamento, D.faturamento, real, 'faturamento');
    linha('Lucro das vendas', A.lucro, D.lucro, real, 'lucro');
    linha('Investido no Ads', A.ads_inv, D.ads_inv, real, 'ads_inv');
    linha('Venda atribuída ao Ads', A.ads_rec, D.ads_rec, real, 'ads_rec');
    linha('Lucro depois do Ads', A.lucro_depois_ads, D.lucro_depois_ads, real, 'lucro_depois_ads');
    t.appendChild(tb);
    const rol = el('div', 'tabela-rolagem'); rol.appendChild(t); box.appendChild(rol);
    const ganho = A.lucro_depois_ads != null && D.lucro_depois_ads != null ? D.lucro_depois_ads / j.depois.dias - A.lucro_depois_ads / j.antes.dias : null;
    if (ganho != null) box.appendChild(el('p', 'sub', `Lucro depois do Ads por dia: ${real(A.lucro_depois_ads / j.antes.dias)} antes e ${real(D.lucro_depois_ads / j.depois.dias)} depois (${ganho >= 0 ? '+' : '−'}${real(Math.abs(ganho))} por dia). `
      + 'Lembre que preço, estoque, promoções e a época do ano também mudam a venda: a comparação mostra o que aconteceu, não prova sozinha que foi o Ads.'));
    // pedido grande (um pedido com 3+ un. e mais da metade das unidades do anúncio no período): distorce a comparação
    if (r.pedidos_grandes?.length) {
      const lista = r.pedidos_grandes.slice(0, 5).map((p) => `${numero(p.unidades)} un. num pedido só em "${(p.titulo || '').slice(0, 40)}" (${p.lado}, ${real(p.faturamento)})`).join('; ');
      const SA = r.sem_grandes.antes, SD = r.sem_grandes.depois;
      box.appendChild(el('p', 'aviso-grande', `Atenção, pedido grande: ${lista}${r.pedidos_grandes.length > 5 ? '…' : ''}. Um pedido assim distorce a comparação. `
        + `Sem esses pedidos: unidades ${numero(SA.unidades)} → ${numero(SD.unidades)}; lucro depois do Ads ${real(SA.lucro_depois_ads)} → ${real(SD.lucro_depois_ads)}.`));
    }
    const celUn = (x) => { const td = el('td', null, numero(x.unidades)); if (x.pedido_grande) { td.appendChild(el('span', 'chip amarelo', ` 1 pedido de ${x.pedido_grande.unidades}`)); td.title = 'Um pedido só tem mais da metade dessas unidades'; } return td; };
    if (r.grupos.length > 1) {
      box.appendChild(el('h3', null, 'Por anúncio'));
      const g = el('div', 'tabela-rolagem'); g.id = 'adGrupos'; box.appendChild(g);
      tabela('adGrupos', ['Anúncio', 'Un. antes', 'Un. depois', 'Venda antes', 'Venda depois', 'Ads depois (gasto / venda)', 'Lucro depois do Ads: antes → depois'],
        r.grupos.slice(0, 40).map((x) => [el('td', 'esq', (x.titulo || x.itens[0] || '').slice(0, 60) + (x.status === 'hold' ? ' (fora do ar)' : '')), celUn(x.antes), celUn(x.depois),
          real(x.antes.faturamento), real(x.depois.faturamento), `${real(x.depois.ads_inv)} / ${real(x.depois.ads_rec)}`,
          `${real(x.antes.lucro_depois_ads)} → ${real(x.depois.lucro_depois_ads)}`]));
      if (r.grupos.length > 40) box.appendChild(el('p', 'sub', `Mostrando 40 de ${numero(r.grupos.length)} anúncios (os que mais venderam).`));
    }
  }
  $('adComparar').onclick = comparar;

  window.AdsGestao = { montar, antesDepois };
  $('btNovaCampanha').onclick = () => abrirCampanha(null);
  // o diagnóstico (só leitura) fica num link discreto: mostra se os caminhos da API respondem nesta conta
  $('btDiagAds').onclick = async () => {
    mensagem('Conferindo a API do Ads…');
    try { const d = await api('/api/ads/gestao/diagnostico'); mensagem('Diagnóstico: ' + JSON.stringify(d)); }
    catch (e) { mensagem('Diagnóstico falhou: ' + e.message); }
  };
})();
