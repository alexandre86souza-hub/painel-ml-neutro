// Promoções da Magalu na tela Campanhas (campanhas-canais.html?conta=magalu): lista das promoções que a loja pode
// entrar ou já entrou, entrar em uma ou várias, sair, produtos de cada uma (preço promocional, limite, lucro no
// preço) e criar promoção da própria loja. Escrita só pelo clique, com confirmação. Usa as funções da tela
// (el, $, api, post, real, numero, pct, aviso, dataBR, diaInput, carregar).
(function(){
  const SIT = { available: ['disponível', 'azul'], pending: ['aguardando', 'azul'], processing: ['processando', 'cinza'], active: ['ativa', 'verde'],
    finished: ['encerrada', 'cinza'], suspended: ['suspensa', 'desce'], error: ['com erro', 'desce'], expired: ['vencida', 'cinza'], awaiting_approval: ['em aprovação', 'azul'] };
  const chip = (s) => el('span', 'chip ' + (SIT[s]?.[1] || ''), SIT[s]?.[0] || s || '—');
  const TIPO = { absolute_discount: 'Preço Promocional', percentage_discount: 'Desconto à Vista', fidelity_discount: 'Cliente Ouro', coupon_discount: 'Cupom', freight_discount: 'Frete' };
  const valorTxt = (v) => !v ? null : v.variavel ? `${v.tipo === 'reais' ? real(v.min) : numero(v.min) + '%'} a ${v.tipo === 'reais' ? real(v.max) : numero(v.max) + '%'}`
    : v.tipo === 'variavel' ? 'variável' : v.tipo === 'reais' ? real(v.valor) : `${numero(v.valor)}%`;
  const dh = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const escolhidas = new Set();

  const lista = (dados) => dados.promocoes_loja || [];

  function pintarLista(box, dados){
    box.innerHTML = '';
    if(dados.erro_promocoes) box.appendChild(el('p', 'recusas', 'Não consegui ler as promoções da Magalu agora: ' + dados.erro_promocoes));
    const lst = lista(dados);
    box.appendChild(el('p', 'sub', 'Promoções que a Magalu liberou para a sua loja (as dela e as que você criou). Marque várias para entrar de uma vez, ou abra os produtos de cada uma para escolher preço e quantidade.'));
    if(!lst.length){
      box.appendChild(el('p', 'recusas', 'A Magalu não devolveu nenhuma promoção pela API para a sua loja, embora o Portal do Seller mostre várias. Isso acontece quando a loja ainda não foi liberada pela Magalu para promoções por integração. Peça no atendimento da Magalu (Portal do Seller → Ajuda → abrir chamado): "Quero liberar meu seller na Open API de Promoções (allowlist do módulo promocional) para ver e aderir às campanhas pelo meu sistema." Assim que liberarem, elas aparecem aqui sozinhas.'));
      // o suporte da Magalu pede o log da requisição: o painel monta, sem o token
      const bLog = el('button', 'bt', 'Gerar log para o suporte da Magalu'); bLog.type = 'button';
      const saida = el('div');
      bLog.onclick = async () => {
        bLog.disabled = true; saida.innerHTML = '';
        try{
          const r = await api('/api/magalu/campanhas/log');
          const ta = el('textarea'); ta.readOnly = true; ta.value = r.log; ta.rows = 16;
          ta.style.cssText = 'width:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin-top:8px';
          ta.setAttribute('aria-label', 'Log da requisição para o suporte da Magalu');
          const bC = el('button', 'bt', 'Copiar log'); bC.type = 'button';
          bC.onclick = async () => { try{ await navigator.clipboard.writeText(ta.value); bC.textContent = 'Copiado'; }catch{ ta.select(); } };
          saida.append(el('p', 'sub', 'Cole no chamado da Magalu. O token de acesso não aparece (vai como [oculto]).'), ta, bC);
        }catch(e){ saida.appendChild(el('p', 'recusas', e.message)); }
        bLog.disabled = false;
      };
      box.append(bLog, saida);
      return;
    }
    const t = el('table'); const cab = el('tr');
    const ckT = el('input'); ckT.type = 'checkbox'; ckT.setAttribute('aria-label', 'Marcar todas as disponíveis');
    const podeEntrar = (p) => !p.aderiu_em && !['finished', 'suspended', 'error'].includes(p.situacao) && p.origem !== 'self_service';
    ckT.onchange = () => { for(const p of lst) if(podeEntrar(p)) ckT.checked ? escolhidas.add(p.id) : escolhidas.delete(p.id); pintarLista(box, dados); };
    const th0 = el('th'); th0.appendChild(ckT); cab.appendChild(th0);
    for(const h of ['Promoção', 'Desconto ao cliente', 'Quem paga', 'Período', 'Situação', '']) cab.appendChild(el('th', null, h));
    t.appendChild(cab);
    for(const p of lst){
      const tr = el('tr');
      const td0 = el('td');
      if(podeEntrar(p)){ const ck = el('input'); ck.type = 'checkbox'; ck.checked = escolhidas.has(p.id); ck.setAttribute('aria-label', 'Escolher ' + (p.nome || p.id));
        ck.onchange = () => { ck.checked ? escolhidas.add(p.id) : escolhidas.delete(p.id); barra(); }; td0.appendChild(ck); }
      const nome = el('td'); nome.appendChild(el('b', null, p.nome || p.id));
      nome.appendChild(el('div', 'skus', [TIPO[p.tipo] || p.tipo_nome, p.origem === 'self_service' ? 'criada por você' : 'da Magalu', p.cupom ? 'cupom ' + p.cupom : null,
        p.escopo === 'full_catalog' ? 'todo o catálogo' : p.escopo === 'admin_choice' ? 'produtos pré-selecionados' : 'você escolhe os produtos'].filter(Boolean).join(' · ')));
      if(p.descricao && p.descricao !== p.nome) nome.appendChild(el('div', 'skus', p.descricao));
      const quem = el('td', null, [p.voce && 'você ' + valorTxt(p.voce), p.magalu && (p.magalu.valor || p.magalu.variavel || p.magalu.tipo === 'variavel') && 'Magalu ' + valorTxt(p.magalu)].filter(Boolean).join(' + ') || '—');
      const per = el('td', null, `${dh(p.inicio)} a ${dh(p.fim)}`); if(p.prazo) per.appendChild(el('div', 'skus', 'entrar até ' + dh(p.prazo)));
      const sit = el('td'); sit.appendChild(p.aderiu_em ? el('span', 'chip verde', 'participando') : chip(p.situacao));
      if(p.aderiu_em) sit.appendChild(el('div', 'skus', 'desde ' + dh(p.aderiu_em)));
      const ac = el('td'); ac.style.whiteSpace = 'nowrap';
      const bP = el('button', 'bt pequeno', 'Produtos'); bP.type = 'button'; bP.onclick = () => produtos(p);
      ac.appendChild(bP);
      if(podeEntrar(p)){ const b = el('button', 'bt pequeno primario', 'Participar'); b.type = 'button'; b.onclick = () => aderir([p.id], lst); ac.append(' ', b); }
      if(p.aderiu_em){ const b = el('button', 'bt pequeno', 'Sair'); b.type = 'button'; b.onclick = () => sair(p); ac.append(' ', b); }
      tr.append(td0, nome, el('td', null, valorTxt(p.desconto) || '—'), quem, per, sit, ac);
      t.appendChild(tr);
    }
    const rol = el('div', 'tabela-rolagem'); rol.appendChild(t); box.appendChild(rol);
    const b = el('div', 'acoes-camp'); b.id = 'mgBarra'; box.appendChild(b);
    const det = el('div'); det.id = 'mgProdutos'; box.appendChild(det);
    function barra(){
      b.innerHTML = '';
      if(!escolhidas.size) return;
      const ok = el('button', 'bt primario', `Participar das ${numero(escolhidas.size)} promoção(ões) escolhida(s)`); ok.type = 'button';
      ok.onclick = () => aderir([...escolhidas], lst);
      const limpar = el('button', 'bt', 'Desmarcar'); limpar.type = 'button'; limpar.onclick = () => { escolhidas.clear(); pintarLista(box, dados); };
      b.append(ok, limpar);
    }
    barra();
  }

  async function aderir(ids, lst){
    const nomes = ids.map((id) => lst.find((p) => p.id === id)).filter(Boolean);
    if(!confirm(`Entrar em ${ids.length} promoção(ões) da Magalu?\n\n${nomes.map((p) => `• ${p.nome}${p.voce ? ' — você investe ' + valorTxt(p.voce) : ''}`).join('\n')}\n\nAo entrar, você aceita a comissão e a coparticipação no desconto de cada campanha.`)) return;
    try{
      const r = await post('/api/magalu/campanhas/aderir', { ids });
      const erros = r.resultado.filter((x) => !x.ok);
      aviso(`Você entrou em ${numero(r.aderidas)} promoção(ões).` + (erros.length ? ' Não entrou em: ' + erros.map((x) => `${nomes.find((p) => p.id === x.id)?.nome || x.id} (${x.erro})`).join('; ') : ''), erros.length ? '' : 'ok');
      escolhidas.clear(); carregar(true);
    }catch(e){ aviso('A Magalu recusou: ' + e.message); }
  }

  const MOTIVOS = [['low_margin', 'Margem insuficiente'], ['out_of_stock', 'Sem estoque'], ['price_conflict', 'Conflito com a política de preço'],
    ['not_interested', 'Não tenho interesse'], ['wrong_products', 'Os produtos não combinam com o catálogo'], ['other', 'Outro']];
  function pedirMotivo(){
    const txt = MOTIVOS.map(([, d], i) => `${i + 1} - ${d}`).join('\n');
    const r = prompt('Motivo (opcional). Digite o número:\n' + txt, '1');
    if(r === null) return null;
    const m = MOTIVOS[Number(r) - 1];
    if(!m) return {};
    if(m[0] === 'other'){ const d = prompt('Escreva o motivo:'); if(!d) return null; return { motivo: 'other', motivo_texto: d }; }
    return { motivo: m[0] };
  }
  async function sair(p){
    if(!confirm(`Sair da promoção "${p.nome}"?\n\nTodos os produtos perdem o desconto NA HORA e voltam ao preço normal.`)) return;
    const m = pedirMotivo(); if(m === null) return;
    try{ await post('/api/magalu/campanhas/sair', { id: p.id, ...m }); aviso(`Você saiu da promoção "${p.nome}".`, 'ok'); carregar(true); }
    catch(e){ aviso('A Magalu recusou: ' + e.message); }
  }

  // Produtos de uma promoção: preço promocional e limite editáveis, lucro no preço, remover e incluir anúncios
  async function produtos(p){
    const box = $('mgProdutos'); box.innerHTML = '';
    box.appendChild(el('h3', null, 'Produtos — ' + (p.nome || p.id)));
    box.appendChild(el('p', 'carregando', 'Perguntando à Magalu…'));
    box.scrollIntoView({ behavior: 'smooth' });
    let r;
    try{ r = await api('/api/magalu/campanhas/skus?id=' + encodeURIComponent(p.id)); }
    catch(e){ box.lastChild.remove(); box.appendChild(el('p', 'recusas', e.message)); return; }
    box.lastChild.remove();
    const lucroDe = (x, preco) => (x.custo_unit != null && x.taxa_pct != null && preco > 0 ? preco * (1 - x.taxa_pct - r.imposto_pct / 100) - x.custo_unit - (r.embalagem_pedido || 0) : null);
    const lucroTd = (td, x, preco) => { const l = lucroDe(x, preco); td.textContent = l == null ? (x.custo_unit == null ? 'sem custo' : '—') : `${real(l)} (${pct(l / preco)})`; td.className = 'dinheiro ' + (l == null ? '' : l < 0 ? 'neg' : 'pos'); };
    box.appendChild(el('p', 'sub', `${numero(r.itens.length)} produto(s) na promoção. Lucro = preço − taxa média do SKU na Magalu (comissão, tarifa e frete) − imposto − custo − embalagem. ` +
      (p.aderiu_em ? 'Você já participa: mudanças valem depois de confirmadas (o painel confirma sozinho ao salvar).' : 'Você ainda não participa: as mudanças entram quando você clicar Participar.')));
    const mud = new Map(), rem = new Set();
    if(r.itens.length){
      const t = el('table'); const cab = el('tr');
      for(const h of ['', 'Produto', 'Preço normal', 'Preço promocional', 'Desconto', 'Quem paga', 'Lucro na promoção', 'Limite de un.', 'Situação']) cab.appendChild(el('th', null, h));
      t.appendChild(cab);
      for(const x of r.itens){
        const tr = el('tr');
        const td0 = el('td'); const ck = el('input'); ck.type = 'checkbox'; ck.setAttribute('aria-label', 'Remover ' + x.sku); ck.onchange = () => { ck.checked ? rem.add(x.sku) : rem.delete(x.sku); botoes(); }; td0.appendChild(ck);
        const ip = el('input'); ip.type = 'number'; ip.step = '0.01'; ip.min = '0.01'; ip.value = x.preco_promo != null ? x.preco_promo.toFixed(2) : ''; ip.setAttribute('aria-label', 'Preço promocional de ' + x.sku);
        const il = el('input'); il.type = 'number'; il.min = '1'; il.step = '1'; il.value = x.limite ?? ''; il.setAttribute('aria-label', 'Limite de unidades de ' + x.sku); il.style.width = '70px';
        const off = el('td'); const lu = el('td');
        const recalc = () => { const v = Number(ip.value); off.textContent = x.preco && v > 0 ? pct(1 - v / x.preco) : '—'; lucroTd(lu, x, v); };
        const marcar = () => { mud.set(x.sku, { sku: x.sku, preco: ip.value === '' ? null : Number(ip.value), limite: il.value === '' ? null : Number(il.value) }); recalc(); botoes(); };
        ip.oninput = marcar; il.oninput = marcar; recalc();
        const tdp = el('td', 'previa'); tdp.appendChild(ip); const tdl = el('td', 'previa'); tdl.appendChild(il);
        const sit = el('td'); sit.appendChild(chip(x.situacao)); if(x.vendidos) sit.appendChild(el('div', 'skus', `${numero(x.vendidos)} vendido(s)`));
        tr.append(td0, celulaProduto(null, x.titulo, x.sku + (x.sku_painel ? ' · ' + x.sku_painel : '') + (x.estoque != null ? ` · estoque ${numero(x.estoque)}` : '')),
          el('td', 'dinheiro', x.preco != null ? real(x.preco) : '—'), tdp, off,
          el('td', null, [x.voce && 'você ' + valorTxt(x.voce), x.magalu && x.magalu.valor ? 'Magalu ' + valorTxt(x.magalu) : null].filter(Boolean).join(' + ') || '—'), lu, tdl, sit);
        t.appendChild(tr);
      }
      const rol = el('div', 'tabela-rolagem'); rol.appendChild(t); box.appendChild(rol);
    }
    const acoes = el('div', 'acoes-camp'); box.appendChild(acoes);
    const res = el('div', 'recusas'); box.appendChild(res);
    function botoes(){
      acoes.innerHTML = '';
      if(mud.size){ const b = el('button', 'bt primario', `Salvar ${numero(mud.size)} alteração(ões)`); b.type = 'button'; b.onclick = () => enviar([...mud.values()]); acoes.appendChild(b); }
      if(rem.size){ const b = el('button', 'bt', `Tirar ${numero(rem.size)} produto(s) da promoção`); b.type = 'button'; b.onclick = remover; acoes.appendChild(b); }
    }
    async function enviar(itens){
      const baixo = itens.filter((i) => { const x = r.itens.find((y) => y.sku === i.sku) || r.anuncios.find((y) => y.sku === i.sku); const l = x && i.preco ? lucroDe(x, i.preco) : null; return l != null && l < 0; });
      if(!confirm(`Enviar ${itens.length} produto(s) para a promoção "${p.nome}" na Magalu?` + (baixo.length ? `\n\nATENÇÃO: ${baixo.length} ficam com PREJUÍZO no preço promocional (${baixo.map((x) => x.sku).join(', ')}).` : ''))) return;
      res.textContent = '';
      try{
        const x = await post('/api/magalu/campanhas/skus', { id: p.id, itens });
        const erros = x.resultado.filter((y) => !y.ok);
        aviso(`${numero(x.alterados)} produto(s) enviados.` + (x.aplicado === true ? ' Confirmados na promoção.' : typeof x.aplicado === 'string' ? ' A confirmação falhou: ' + x.aplicado : x.participa ? '' : ' Entram quando você clicar Participar.'), erros.length ? '' : 'ok');
        res.textContent = erros.map((y) => `${y.sku}: ${y.erro}`).join('\n');
        if(!erros.length) produtos(p);
      }catch(e){ aviso('A Magalu recusou: ' + e.message); }
    }
    async function remover(){
      if(!confirm(`Tirar ${rem.size} produto(s) da promoção "${p.nome}"? Eles voltam ao preço normal.`)) return;
      const m = pedirMotivo(); if(m === null) return;
      try{
        const x = await post('/api/magalu/campanhas/skus/remover', { id: p.id, skus: [...rem], ...m });
        const erros = x.resultado.filter((y) => !y.ok);
        aviso(`${numero(x.removidos)} produto(s) tirados da promoção.` + (typeof x.aplicado === 'string' ? ' A confirmação falhou: ' + x.aplicado : ''), erros.length ? '' : 'ok');
        res.textContent = erros.map((y) => `${y.sku}: ${y.erro}`).join('\n');
        if(!erros.length) produtos(p);
      }catch(e){ aviso('A Magalu recusou: ' + e.message); }
    }
    // incluir anúncios (promoção em que você escolhe os produtos)
    if(p.escopo !== 'full_catalog' && r.anuncios.length){
      const d = el('details'); d.style.marginTop = '14px';
      d.appendChild(el('summary', null, `Incluir anúncios na promoção (${numero(r.anuncios.length)} ativos fora dela)`));
      const f = el('div', 'filtros');
      const busca = el('input'); busca.type = 'search'; busca.placeholder = 'Buscar por produto ou SKU'; busca.setAttribute('aria-label', 'Buscar anúncio');
      const lp = el('label', 'sub'); lp.style.cssText = 'display:flex;gap:6px;align-items:center';
      const ipct = el('input'); ipct.type = 'number'; ipct.min = '1'; ipct.max = '90'; ipct.step = '0.5'; ipct.value = p.desconto && !p.desconto.variavel && p.desconto.tipo === 'pct' ? p.desconto.valor : 10; ipct.style.width = '70px';
      lp.append('Desconto (%)', ipct);
      f.append(busca, lp); d.appendChild(f);
      const tb = el('div', 'tabela-rolagem'); d.appendChild(tb);
      const ac = el('div', 'acoes-camp'); d.appendChild(ac);
      const esc = new Set();
      const pintar = () => {
        const q = busca.value.trim().toLowerCase();
        const l = r.anuncios.filter((a) => !q || [a.titulo, a.sku, a.sku_painel].some((t) => (t || '').toLowerCase().includes(q))).slice(0, 300);
        const t = el('table'); const cab = el('tr');
        for(const h of ['', 'Anúncio', 'Preço', 'Preço promocional', 'Lucro na promoção', 'Vendas 30 d']) cab.appendChild(el('th', null, h));
        t.appendChild(cab);
        for(const a of l){
          const tr = el('tr'); const td0 = el('td'); const ck = el('input'); ck.type = 'checkbox'; ck.checked = esc.has(a.sku); ck.setAttribute('aria-label', 'Incluir ' + a.sku);
          ck.onchange = () => { ck.checked ? esc.add(a.sku) : esc.delete(a.sku); bt(); }; td0.appendChild(ck);
          const pp = a.preco ? Math.round(a.preco * (1 - Number(ipct.value) / 100) * 100) / 100 : null;
          const lu = el('td'); lucroTd(lu, a, pp);
          tr.append(td0, celulaProduto(null, a.titulo, a.sku + (a.sku_painel ? ' · ' + a.sku_painel : '') + (a.estoque != null ? ` · estoque ${numero(a.estoque)}` : '')),
            el('td', 'dinheiro', a.preco ? real(a.preco) : '—'), el('td', 'dinheiro', pp ? real(pp) : '—'), lu, el('td', null, numero(a.vendas_30 || 0)));
          t.appendChild(tr);
        }
        tb.innerHTML = ''; tb.appendChild(t);
      };
      const bt = () => { ac.innerHTML = ''; if(!esc.size) return;
        const b = el('button', 'bt primario', `Incluir ${numero(esc.size)} anúncio(s) com ${ipct.value}% de desconto`); b.type = 'button';
        b.onclick = () => enviar([...esc].map((s) => r.anuncios.find((a) => a.sku === s)).filter((a) => a && a.preco)
          .map((a) => ({ sku: a.sku, preco: Math.round(a.preco * (1 - Number(ipct.value) / 100) * 100) / 100 })));
        ac.appendChild(b); };
      busca.oninput = pintar; ipct.oninput = () => { pintar(); bt(); };
      d.ontoggle = () => { if(d.open && !tb.firstChild) pintar(); };
      box.appendChild(d);
    }
  }

  // Criar promoção da própria loja
  function pintarCriar(box){
    box.innerHTML = '';
    box.appendChild(el('p', 'sub', 'Promoção da sua loja na Magalu. Preço Promocional: depois de criar, abra "Produtos" na lista acima e inclua os anúncios com o preço de cada um. Desconto à Vista e Cliente Ouro: % que você dá. Cupom: código que o cliente digita.'));
    const f = el('div', 'form-camp');
    const campo = (rot, inp) => { const l = el('label', null, rot); l.appendChild(inp); f.appendChild(l); return inp; };
    const inp = (tipo, val) => { const i = el('input'); i.type = tipo; if(val != null) i.value = val; return i; };
    const sel = el('select'); sel.style.cssText = 'font:inherit;font-size:14px;padding:8px 10px;border:1px solid #d5d7db;border-radius:9px';
    for(const [v, t] of [['absolute_discount', 'Preço Promocional'], ['percentage_discount', 'Desconto à Vista'], ['fidelity_discount', 'Cliente Ouro'], ['coupon_discount', 'Cupom de Desconto']]){ const o = el('option', null, t); o.value = v; sel.appendChild(o); }
    campo('Tipo', sel);
    const nome = campo('Nome', inp('text')); nome.maxLength = 120;
    const ini = campo('Início', inp('date', diaInput(Date.now()))), fim = campo('Fim', inp('date', diaInput(Date.now() + 7 * 864e5)));
    const escopo = el('select'); escopo.style.cssText = sel.style.cssText;
    for(const [v, t] of [['seller_choice', 'Produtos que eu escolher'], ['full_catalog', 'Todo o catálogo']]){ const o = el('option', null, t); o.value = v; escopo.appendChild(o); }
    const lEsc = el('label', null, 'Produtos'); lEsc.appendChild(escopo); f.appendChild(lEsc);
    const pctI = inp('number', 5); pctI.min = '1'; pctI.max = '90'; pctI.step = '0.5'; const lPct = el('label', null, 'Desconto (%)'); lPct.appendChild(pctI); f.appendChild(lPct);
    const cup = inp('text'); cup.maxLength = 11; const lCup = el('label', null, 'Código do cupom'); lCup.appendChild(cup); f.appendChild(lCup);
    const cupTipo = el('select'); cupTipo.style.cssText = sel.style.cssText;
    for(const [v, t] of [['percentage', 'em %'], ['value', 'em R$']]){ const o = el('option', null, t); o.value = v; cupTipo.appendChild(o); }
    const lCupT = el('label', null, 'Desconto do cupom'); lCupT.appendChild(cupTipo); f.appendChild(lCupT);
    const cupV = inp('number', 10); cupV.min = '1'; cupV.step = '0.5'; const lCupV = el('label', null, 'Valor do cupom'); lCupV.appendChild(cupV); f.appendChild(lCupV);
    const cupTot = inp('number', 100); cupTot.min = '1'; const lCupTot = el('label', null, 'Total de cupons'); lCupTot.appendChild(cupTot); f.appendChild(lCupTot);
    const cupCpf = inp('number', 1); cupCpf.min = '1'; const lCupCpf = el('label', null, 'Usos por CPF/CNPJ'); lCupCpf.appendChild(cupCpf); f.appendChild(lCupCpf);
    box.appendChild(f);
    const ops = el('div', 'acoes-camp');
    const lim = el('label', 'sub'); const limC = inp('checkbox'); lim.append(limC, ' limitar unidades vendidas por produto');
    const div = el('label', 'sub'); const divC = inp('checkbox'); div.append(divC, ' deixar a Magalu divulgar o cupom (ex.: carrinho abandonado)');
    ops.append(lim, div); box.appendChild(ops);
    const ver = () => {
      const t = sel.value;
      lEsc.hidden = t === 'absolute_discount';
      lPct.hidden = !['percentage_discount', 'fidelity_discount'].includes(t);
      for(const x of [lCup, lCupT, lCupV, lCupTot, lCupCpf, div]) x.hidden = t !== 'coupon_discount';
      lim.hidden = !['absolute_discount', 'fidelity_discount'].includes(t) || (t !== 'absolute_discount' && escopo.value === 'full_catalog');
    };
    sel.onchange = ver; escopo.onchange = ver; ver();
    const ac = el('div', 'acoes-camp'); const bt = el('button', 'bt primario', 'Criar promoção na Magalu'); bt.type = 'button'; ac.appendChild(bt); box.appendChild(ac);
    bt.onclick = async () => {
      const corpo = { tipo: sel.value, nome: nome.value.trim(), inicio: ini.value, fim: fim.value, escopo: escopo.value, pct: Number(pctI.value),
        cupom: cup.value.trim(), cupom_tipo: cupTipo.value, cupom_valor: Number(cupV.value), cupom_total: Number(cupTot.value), cupom_por_cpf: Number(cupCpf.value),
        limitar_unidades: limC.checked, divulgar: divC.checked };
      if(!corpo.nome){ aviso('Dê um nome à promoção.'); return; }
      const tipoTxt = sel.options[sel.selectedIndex].text;
      if(!confirm(`Criar a promoção "${corpo.nome}" (${tipoTxt}) na Magalu, de ${dataBR(ini.value + 'T12:00:00')} a ${dataBR(fim.value + 'T12:00:00')}?`)) return;
      bt.disabled = true;
      try{
        const r = await post('/api/magalu/campanhas/criar', corpo);
        aviso(`Promoção criada na Magalu${r.id ? ' (código ' + r.id + ')' : ''}. A Magalu leva alguns instantes para processar.` + (r.escopo === 'seller_choice' ? ' Depois abra "Produtos" nela, na lista acima, para incluir os anúncios.' : ''), 'ok');
        nome.value = '';
        setTimeout(() => carregar(true), 3000);
      }catch(e){ aviso('A Magalu recusou: ' + e.message); }
      finally{ bt.disabled = false; }
    };
  }

  window.MagaluPromocoes = { pintarLista, pintarCriar, disponiveis: (dados) => lista(dados).filter((p) => !p.aderiu_em && !['finished', 'suspended', 'error'].includes(p.situacao)).length };
})();
