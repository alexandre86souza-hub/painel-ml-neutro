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

  window.AdsGestao = { montar };
  $('btNovaCampanha').onclick = () => abrirCampanha(null);
  // o diagnóstico (só leitura) fica num link discreto: mostra se os caminhos da API respondem nesta conta
  $('btDiagAds').onclick = async () => {
    mensagem('Conferindo a API do Ads…');
    try { const d = await api('/api/ads/gestao/diagnostico'); mensagem('Diagnóstico: ' + JSON.stringify(d)); }
    catch (e) { mensagem('Diagnóstico falhou: ' + e.message); }
  };
})();
