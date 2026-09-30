'use strict';
// Telas de acompanhamento: Performance, Análise ABC, Full, qualidade dos anúncios e avisos
// (venda nova, mensagem, anúncio pausado). Mesmo padrão dos outros módulos: criar(deps)
// devolve rotas que o server.js registra (sessão, origem e MCP iguais às outras).
//
// Medido em 29/09/2026 numa conta real:
//   - Full: 70 anúncios com logistic_type=fulfillment; conta com estoque multi-origem — o
//     estoque NO ARMAZÉM DO ML é /user-products/{id}/stock, locations[type=meli_facility]
//     (o /inventories/{id}/stock/fulfillment dava 0 para todos). Venda que saiu do Full tem
//     order_items[].stock.node_id do armazém ("BRSP04", "BRSP02"); a do depósito do
//     vendedor, "BRP1234567891" (vendas.origem).
//   - Qualidade: /item/{id}/performance -> score (0-100), level e buckets[].variables[] com
//     status PENDING/COMPLETED e o título do objetivo ("Crie um vídeo…", "Preencha as
//     características…"). Uma chamada por anúncio: fica 3 dias no SQLite.
//   - Mensagens: /messages/unread?role=seller&tag=post_sale -> results por pedido/pacote.

const A = require('./public/analise.js');

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round((v || 0) * 100) / 100;
// Venda que saiu do armazém do ML: node_id do Full (BRSP04…), não o depósito do vendedor (BRP…).
const ehFull = (origem) => !!origem && !/^BRP\d+$/.test(origem);

// Canal de envio de uma venda: a origem do estoque diz se saiu do Full; o resto vem do
// logistic_type do envio (medido em 30/09/2026: "self_service" = Flex). Função pura: testada.
const CANAIS = { full: 'Full', flex: 'Flex', envios: 'Mercado Envios', outros: 'Outros', pendente: 'Ainda lendo' };
function canalDe(origem, tipo) {
  if (ehFull(origem) || tipo === 'fulfillment') return 'full';
  if (tipo === 'self_service') return 'flex';
  if (['cross_docking', 'xd_drop_off', 'drop_off'].includes(tipo)) return 'envios';
  return tipo ? 'outros' : 'pendente';
}
// Soma as linhas de venda por canal (pedidos distintos, unidades, faturamento). Função pura: testada.
function porCanal(linhas) {
  const m = new Map();
  for (const l of linhas) {
    const k = canalDe(l.origem, l.tipo);
    const x = m.get(k) || { canal: k, nome: CANAIS[k], pedidos: new Set(), unidades: 0, faturamento: 0 };
    x.pedidos.add(l.order_id); x.unidades += l.quantidade || 0; x.faturamento += l.faturamento || 0;
    m.set(k, x);
  }
  const total = [...m.values()].reduce((s, x) => s + x.faturamento, 0);
  return ['full', 'flex', 'envios', 'outros', 'pendente'].filter((k) => m.has(k) || ['full', 'flex', 'envios'].includes(k)).map((k) => {
    const x = m.get(k) || { canal: k, nome: CANAIS[k], pedidos: new Set(), unidades: 0, faturamento: 0 };
    return { canal: k, nome: x.nome, pedidos: x.pedidos.size, unidades: x.unidades, faturamento: r2(x.faturamento),
      ticket: x.pedidos.size ? r2(x.faturamento / x.pedidos.size) : null,
      participacao: total > 0 ? x.faturamento / total : 0 };
  });
}

// Qualidade de um anúncio a partir de /item/{id}/performance. Função pura: testada.
function lerQualidade(p) {
  const pendentes = [];
  for (const b of p?.buckets || []) {
    for (const v of b.variables || []) {
      if (v.status !== 'PENDING') continue;
      pendentes.push({ grupo: b.title || b.key, chave: v.key, titulo: v.title || v.key,
        dica: v.rules?.[0]?.wordings?.title || null,
        // ficha técnica, fotos, GTIN, título: o que deixa o anúncio "incompleto"
        cadastro: /TECHNICAL|ATTRIBUTE|SPECIFICATION|GTIN|PICTURE|TITLE|DESCRIPTION/i.test(v.key || '') });
    }
  }
  return { score: p?.score ?? null, nivel: p?.level ?? null, pendentes };
}

// Dias de estoque no Full pela média diária de vendas do Full. Função pura: testada.
function cobertura(estoque, vendidas, dias) {
  const media = dias > 0 ? vendidas / dias : 0;
  return { media_dia: media, dias: media > 0 ? Math.floor(estoque / media) : null };
}

function criar({ ml, mlPaciente, emLotes, contaOuErro, sincronizarVendas, janela, idsDaConta, baixarPedidos, linhasDoPedido, D }) {
  // Vendas baixadas antes de o painel guardar a origem do estoque (Full x depósito): baixa a
  // janela de novo uma vez, como a tela Vendas faz com o SKU.
  async function comOrigem(conta, dias) {
    await sincronizarVendas(conta, dias);
    const de = new Date(Date.now() - dias * 864e5), ate = new Date(Date.now() + 60e3);
    if (D.vendasSemSku(conta.ml_user_id, de.toISOString(), ate.toISOString()) > 0) {
      const pedidos = await baixarPedidos(conta.ml_user_id, 'date_created', de, ate);
      D.vendasGravar(pedidos.flatMap((o) => linhasDoPedido(o, conta.ml_user_id)));
    }
  }
  const intervalo = (dias, fimMs = Date.now()) => {
    const hojeLocal = new Date(fimMs - 3 * 3600e3).toISOString().slice(0, 10);
    const fim = new Date(Date.parse(hojeLocal + 'T03:00:00Z') + 864e5);     // amanhã 00h Brasília
    return { de: new Date(fim.getTime() - dias * 864e5).toISOString(), ate: fim.toISOString() };
  };

  async function infoItens(ids, attrs = 'id,title,thumbnail,permalink,price,available_quantity,status') {
    const lotes = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const out = {};
    await emLotes(lotes, 4, async (lote) => {
      try {
        const r = await ml(`/items?ids=${lote.join(',')}&attributes=${attrs}`);
        for (const x of r) if (x.code === 200) out[x.body.id] = x.body;
      } catch { /* enfeite */ }
    });
    return out;
  }

  const somaPor = (linhas, chave) => linhas.reduce((s, l) => s + (l[chave] || 0), 0);

  // ---------- Performance ----------
  async function performance(conta, dias) {
    await sincronizarVendas(conta, Math.min(150, dias * 2));
    const atual = intervalo(dias);
    const antes = intervalo(dias, Date.parse(atual.de) - 1 + 3 * 3600e3);
    const diaria = D.vendasPorDia(conta.ml_user_id, atual.de, atual.ate);
    const diariaAntes = D.vendasPorDia(conta.ml_user_id, antes.de, antes.ate);
    const tot = (l) => ({ faturamento: r2(somaPor(l, 'faturamento')), pedidos: somaPor(l, 'pedidos'),
      unidades: somaPor(l, 'unidades'), tarifas: r2(somaPor(l, 'tarifas')) });
    const t = tot(diaria), ta = tot(diariaAntes);
    t.ticket = t.pedidos ? t.faturamento / t.pedidos : 0; ta.ticket = ta.pedidos ? ta.faturamento / ta.pedidos : 0;
    const visitas = async (j) => {
      const d = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
      const r = await ml(`/users/${conta.ml_user_id}/items_visits?date_from=${d(j.de)}&date_to=${d(new Date(Date.parse(j.ate) - 864e5).toISOString())}`)
        .catch(() => null);
      return r?.total_visits ?? null;
    };
    const [v, va] = await Promise.all([visitas(atual), visitas(antes)]);
    t.visitas = v; ta.visitas = va;
    t.conversao = v ? t.pedidos / v : null; ta.conversao = va ? ta.pedidos / va : null;
    const canc = (j) => D.db.prepare(`SELECT COUNT(DISTINCT order_id) AS n FROM vendas WHERE ml_user_id=? AND data>=? AND data<?
      AND status='cancelled'`).get(conta.ml_user_id, j.de, j.ate).n;
    t.cancelados = canc(atual); ta.cancelados = canc(antes);

    // quem mais subiu e mais caiu (faturamento do período contra o anterior)
    const porItem = (j) => Object.fromEntries(D.vendasResumo(conta.ml_user_id, { ...j, meio: j.de })
      .map((x) => [x.item_id, x]));
    const pa = porItem(atual), pb = porItem(antes);
    const ids = [...new Set([...Object.keys(pa), ...Object.keys(pb)])];
    const mov = ids.map((id) => ({ id, atual: pa[id]?.faturamento || 0, antes: pb[id]?.faturamento || 0,
      unidades: pa[id]?.unidades || 0, unidades_antes: pb[id]?.unidades || 0 }))
      .map((x) => ({ ...x, delta: x.atual - x.antes }));
    const sobe = mov.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10);
    const cai = mov.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10);
    const info = await infoItens([...sobe, ...cai].map((x) => x.id));
    const nome = (x) => ({ ...x, titulo: info[x.id]?.title || null, foto: info[x.id]?.thumbnail || null });
    // série diária alinhada (dia 1 do período atual com dia 1 do anterior)
    const serie = A.diasDaJanela(dias).map((dia, i) => {
      const a = diaria.find((d) => d.dia === dia);
      const b = diariaAntes[i];
      return { dia, faturamento: a?.faturamento || 0, pedidos: a?.pedidos || 0, anterior: b?.faturamento || 0 };
    });
    return { dias, atual: t, anterior: ta, serie, sobe: sobe.map(nome), cai: cai.map(nome) };
  }

  // ---------- Performance por canal de envio (Full, Flex, Mercado Envios) ----------
  // O tipo de logística é uma chamada por envio: até 500 envios novos por abertura, o resto
  // nas próximas (a tela pede de novo sozinha enquanto houver pendentes). Fica no SQLite.
  async function logistica(conta, dias) {
    await comOrigem(conta, dias);
    const j = intervalo(dias);
    const id = conta.ml_user_id;
    const faltam = D.enviosSemLogistica(id, j.de, j.ate, 500);
    await emLotes(faltam, 8, async (envio) => {
      const s = await mlPaciente(`/shipments/${envio}`, id).catch(() => null);
      if (s) D.logisticaGravar(id, envio, s.logistic_type || s.logistic?.type || 'desconhecido');
    });
    const pendentes = D.enviosSemLogistica(id, j.de, j.ate, 5000).length;
    const canais = porCanal(D.vendasComLogistica(id, j.de, j.ate));
    return { dias, de: j.de, ate: j.ate, canais, envios_pendentes: pendentes,
      total: { pedidos: canais.reduce((s, c) => s + c.pedidos, 0), faturamento: r2(canais.reduce((s, c) => s + c.faturamento, 0)) } };
  }

  // ---------- Análise ABC ----------
  async function abc(conta, dias) {
    await sincronizarVendas(conta, dias);
    const j = janela(dias);
    const res = D.vendasResumo(conta.ml_user_id, j);
    const curva = A.curvaABC(Object.fromEntries(res.map((x) => [x.item_id, x.faturamento])));
    const custos = D.custosDe(res.map((x) => x.item_id));
    const imposto = D.impostoLer(conta.ml_user_id) || 0;
    const total = somaPor(res, 'faturamento');
    let acum = 0;
    const linhas = res.filter((x) => curva[x.item_id]).sort((a, b) => curva[a.item_id].ranking - curva[b.item_id].ranking)
      .map((x) => {
        acum += x.faturamento;
        const f = D.fretePorUnidade(x.item_id, j);
        const frete = f?.unidades ? f.custo / f.unidades : null;
        const c = custos[x.item_id];
        const e = A.economia({ faturamento: x.faturamento, unidades: x.unidades, tarifas: x.tarifas,
          freteUnidade: frete, custo: c?.custo ?? null, outros: c?.outros_total ?? null, impostoPct: imposto });
        return { id: x.item_id, classe: curva[x.item_id].classe, ranking: curva[x.item_id].ranking,
          faturamento: r2(x.faturamento), participacao: curva[x.item_id].participacao, acumulado: total ? acum / total : 0,
          unidades: x.unidades, pedidos: x.pedidos, lucro: e.lucro != null ? r2(e.lucro) : null, margem: e.margem,
          falta: e.falta };
      });
    const info = await infoItens(linhas.map((l) => l.id));
    for (const l of linhas) Object.assign(l, { titulo: info[l.id]?.title || null, foto: info[l.id]?.thumbnail || null,
      estoque: info[l.id]?.available_quantity ?? null, status: info[l.id]?.status || null });
    // Anúncios ativos que não venderam nada no período (ficam fora da curva, que só tem quem faturou).
    const { ids: ativosIds } = await idsDaConta(conta, 'active', null);
    const venderam = new Set(linhas.map((l) => l.id));
    const semVendaIds = ativosIds.filter((id) => !venderam.has(id));
    const infoSem = await infoItens(semVendaIds, 'id,title,thumbnail,permalink,price,available_quantity,status,date_created,sold_quantity');
    const ultimas = D.ultimasVendas(semVendaIds, 1);
    const semVenda = semVendaIds.filter((id) => infoSem[id]).map((id) => {
      const it = infoSem[id];
      const ult = ultimas[id]?.[0] || null;
      return { id, titulo: it.title, foto: it.thumbnail, link: it.permalink, preco: it.price, estoque: it.available_quantity,
        vendidos_total: it.sold_quantity ?? 0, criado_em: it.date_created || null, ultima_venda: ult?.data || null };
    // Primeiro quem já vendeu bem e parou (mais a recuperar). Valor em estoque não entra: o
    // estoque do mesmo produto é compartilhado por vários anúncios (somava R$ 21 milhões).
    }).sort((a, b) => (b.vendidos_total - a.vendidos_total) || String(b.ultima_venda).localeCompare(String(a.ultima_venda)));
    const classes = ['A', 'B', 'C'].map((k) => {
      const ls = linhas.filter((l) => l.classe === k);
      return { classe: k, anuncios: ls.length, faturamento: r2(somaPor(ls, 'faturamento')),
        participacao: total ? somaPor(ls, 'faturamento') / total : 0,
        lucro: r2(ls.reduce((s, l) => s + (l.lucro || 0), 0)), sem_lucro: ls.filter((l) => l.lucro == null).length };
    });
    return { dias, de: j.primeiro, ate: j.ultimo, total: r2(total), classes, linhas,
      sem_venda: { total: semVenda.length, ativos: ativosIds.length,
        ja_venderam: semVenda.filter((x) => x.vendidos_total > 0).length, nunca: semVenda.filter((x) => !x.vendidos_total).length,
        itens: semVenda } };
  }

  // ---------- Full ----------
  let cacheFull = null;
  async function full(conta) {
    if (cacheFull?.conta === conta.ml_user_id && Date.now() - cacheFull.em < 10 * 60e3) return cacheFull.dados;
    const ids = [];
    for (let off = 0; off < 1000; off += 50) {
      const r = await ml(`/users/${conta.ml_user_id}/items/search?logistic_type=fulfillment&limit=50&offset=${off}`);
      ids.push(...(r.results || []));
      if ((r.results || []).length < 50) break;
    }
    const info = await infoItens(ids, 'id,title,thumbnail,permalink,price,available_quantity,status,user_product_id,sold_quantity');
    const ups = [...new Set(Object.values(info).map((i) => i.user_product_id).filter(Boolean))];
    const estoque = {};
    await emLotes(ups, 6, async (up) => {
      const s = await mlPaciente(`/user-products/${up}/stock`, conta.ml_user_id).catch(() => null);
      const loc = s?.locations || [];
      estoque[up] = {
        full: loc.filter((l) => l.type === 'meli_facility').reduce((a, l) => a + (l.quantity || 0), 0),
        deposito: loc.filter((l) => l.type === 'seller_warehouse').reduce((a, l) => a + (l.quantity || 0), 0),
      };
    });
    await comOrigem(conta, 90);
    const desde = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const vendasFull = (d) => Object.fromEntries(D.db.prepare(`SELECT item_id, origem, SUM(quantidade) AS u, SUM(quantidade*preco_unit) AS f
        FROM vendas WHERE ml_user_id=? AND data >= ? AND status IN ('paid','partially_refunded') GROUP BY item_id, origem`)
      .all(conta.ml_user_id, desde(d)).reduce((m, r) => {
        const x = m.get(r.item_id) || { full: 0, deposito: 0, fat_full: 0 };
        if (ehFull(r.origem)) { x.full += r.u; x.fat_full += r.f; } else x.deposito += r.u;
        m.set(r.item_id, x); return m;
      }, new Map()));
    const v30 = vendasFull(30), v60 = vendasFull(60), v90 = vendasFull(90);
    // A média diária usa os dias desde a primeira venda do Full (até 30): a conta começou a
    // vender pelo Full em 25/09/2026 — dividir por 30 dias subestimaria o giro.
    const primeira = D.db.prepare(`SELECT MIN(data) AS d FROM vendas WHERE ml_user_id=? AND origem IS NOT NULL
      AND origem <> '' AND origem NOT GLOB 'BRP[0-9]*'`).get(conta.ml_user_id)?.d;
    const diasBase = primeira ? Math.max(1, Math.min(30, Math.ceil((Date.now() - Date.parse(primeira)) / 864e5))) : 30;
    const itens = ids.filter((id) => info[id]).map((id) => {
      const it = info[id];
      const e = estoque[it.user_product_id] || { full: null, deposito: null };
      const c = cobertura(e.full || 0, v30[id]?.full || 0, diasBase);
      return { id, titulo: it.title, foto: it.thumbnail, link: it.permalink, preco: it.price, status: it.status,
        estoque_full: e.full, estoque_deposito: e.deposito,
        vendas_full_30: v30[id]?.full || 0, vendas_full_60: v60[id]?.full || 0, vendas_full_90: v90[id]?.full || 0,
        vendas_deposito_30: v30[id]?.deposito || 0, faturamento_full_30: r2(v30[id]?.fat_full || 0),
        media_dia: c.media_dia, dias_estoque: c.dias };
    }).sort((a, b) => (b.vendas_full_30 - a.vendas_full_30) || ((b.estoque_full || 0) - (a.estoque_full || 0)));
    // totais da conta: quanto das vendas saiu do Full
    const tot = D.db.prepare(`SELECT origem, SUM(quantidade) AS u, SUM(quantidade*preco_unit) AS f, COUNT(DISTINCT order_id) AS p
      FROM vendas WHERE ml_user_id=? AND data >= ? AND status IN ('paid','partially_refunded') GROUP BY origem`)
      .all(conta.ml_user_id, desde(30));
    const soma = (f) => tot.filter((r) => f(r.origem)).reduce((s, r) => ({ u: s.u + r.u, f: s.f + r.f, p: s.p + r.p }), { u: 0, f: 0, p: 0 });
    const tf = soma(ehFull), tt = soma(() => true);
    const dados = {
      itens, total_anuncios: itens.length, dias_base_media: diasBase, primeira_venda_full: primeira || null,
      com_estoque: itens.filter((i) => i.estoque_full > 0).length,
      unidades_full: itens.reduce((s, i) => s + (i.estoque_full || 0), 0),
      acabando: itens.filter((i) => i.dias_estoque != null && i.dias_estoque < 15).length,
      vendas_30: { full_unidades: tf.u, full_faturamento: r2(tf.f), full_pedidos: tf.p,
        total_faturamento: r2(tt.f), participacao: tt.f ? tf.f / tt.f : 0 },
      em: new Date().toISOString(),
    };
    cacheFull = { conta: conta.ml_user_id, em: Date.now(), dados };
    return dados;
  }

  // ---------- qualidade dos anúncios ----------
  let cacheAtivos = null;
  async function ativos(conta) {
    if (cacheAtivos?.conta === conta.ml_user_id && Date.now() - cacheAtivos.em < 10 * 60e3) return cacheAtivos.lista;
    const { ids } = await idsDaConta(conta, 'active', null);
    const info = await infoItens(ids, 'id,title,thumbnail,permalink,price,available_quantity,status,health,sold_quantity');
    const lista = ids.filter((id) => info[id]).map((id) => info[id]);
    cacheAtivos = { conta: conta.ml_user_id, em: Date.now(), lista };
    return lista;
  }
  const TRES_DIAS = 3 * 864e5;
  async function qualidade(conta, filtro, pagina) {
    const lista = await ativos(conta);
    const q = D.qualidadeDe(lista.map((i) => i.id));
    // até 150 anúncios sem leitura (ou velha) por abertura; o resto vem nas próximas
    const faltam = lista.filter((i) => !q[i.id] || Date.now() - Date.parse(q[i.id].calculado_em) > TRES_DIAS).slice(0, 300);
    await emLotes(faltam, 6, async (it) => {
      const p = await mlPaciente(`/item/${it.id}/performance`, conta.ml_user_id).catch(() => null);
      if (p) D.qualidadeGravar(conta.ml_user_id, it.id, lerQualidade(p));
    });
    const q2 = D.qualidadeDe(lista.map((i) => i.id));
    const pendentesLeitura = lista.filter((i) => !q2[i.id]).length;
    let linhas = lista.map((it) => ({ id: it.id, titulo: it.title, foto: it.thumbnail, link: it.permalink, preco: it.price,
      estoque: it.available_quantity, vendidos: it.sold_quantity, saude: it.health ?? null,
      score: q2[it.id]?.score ?? null, nivel: q2[it.id]?.nivel ?? null, pendentes: q2[it.id]?.pendentes || [] }))
      .filter((l) => l.score != null);
    const cont = {
      incompletos: linhas.filter((l) => l.pendentes.some((p) => p.cadastro)).length,
      ruins: linhas.filter((l) => l.score < 70).length,
      objetivos: linhas.filter((l) => l.pendentes.length).length,
    };
    if (filtro === 'incompletos') linhas = linhas.filter((l) => l.pendentes.some((p) => p.cadastro));
    if (filtro === 'ruins') linhas = linhas.filter((l) => l.score < 70);
    if (filtro === 'objetivos') linhas = linhas.filter((l) => l.pendentes.length);
    // pior qualidade primeiro; no empate, quem vende mais (mais a ganhar)
    linhas.sort((a, b) => (a.score - b.score) || ((b.vendidos || 0) - (a.vendidos || 0)));
    const porPagina = 20;
    return { total_ativos: lista.length, lidos: lista.length - pendentesLeitura, faltam_ler: pendentesLeitura,
      contagem: cont, total: linhas.length, pagina, por_pagina: porPagina,
      media: linhas.length ? linhas.reduce((s, l) => s + l.score, 0) / linhas.length : null,
      itens: linhas.slice(pagina * porPagina, (pagina + 1) * porPagina) };
  }

  // ---------- avisos ----------
  // Gerados quando a tela pergunta (a cada minuto, com o painel aberto): vendas novas da
  // cópia local, mensagens não lidas e anúncios que ficaram pausados. Na primeira vez só
  // marca o que já existe, para não despejar centenas de avisos antigos.
  let ultimaVerificacao = 0;
  async function gerarAvisos(conta) {
    if (Date.now() - ultimaVerificacao < 45e3) return;
    ultimaVerificacao = Date.now();
    const id = conta.ml_user_id;
    const primeira = !D.configLer(`avisos_inicio:${id}`);
    const inicio = D.configLer(`avisos_inicio:${id}`) || new Date().toISOString();
    if (primeira) D.configGravar(`avisos_inicio:${id}`, inicio);

    // vendas novas (depois do início dos avisos)
    await sincronizarVendas(conta, 7).catch(() => null);
    const novas = D.db.prepare(`SELECT order_id, MIN(data) AS data, SUM(quantidade) AS q, SUM(quantidade*preco_unit) AS t,
        MIN(item_id) AS item, MIN(origem) AS origem FROM vendas WHERE ml_user_id=? AND data > ? AND status IN ('paid','partially_refunded')
        GROUP BY order_id ORDER BY data`).all(id, inicio);
    const info = novas.length ? await infoItens([...new Set(novas.map((n) => n.item))].slice(0, 40), 'id,title') : {};
    for (const n of novas) {
      D.avisoCriar(id, { tipo: 'venda', chave: `venda:${n.order_id}`, criado_em: n.data,
        titulo: `Nova venda: ${Number(n.t).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
        texto: `${n.q} un. · ${info[n.item]?.title || n.item}${ehFull(n.origem) ? ' · Full' : ''}`,
        link: `https://www.mercadolivre.com.br/vendas/${n.order_id}/detalhe` });
    }

    // mensagens não lidas do pós-venda
    const msg = await ml(`/messages/unread?role=seller&tag=post_sale`).catch(() => null);
    for (const m of msg?.results || []) {
      const recurso = String(m.resource || '').split('/').pop();
      const qtd = m.count || m.unread || 1;
      D.avisoCriar(id, { tipo: 'mensagem', chave: `msg:${recurso}:${qtd}:${(m.last_message_date || '').slice(0, 16)}`,
        titulo: `${qtd} mensagem(ns) nova(s) de comprador`, texto: `Pedido/pacote ${recurso}`,
        link: `https://www.mercadolivre.com.br/vendas/${recurso}/detalhe` });
    }

    // anúncios pausados (sem estoque, pelo ML) e em revisão
    const conhecidos = new Set(JSON.parse(D.configLer(`avisos_pausados:${id}`) || '[]'));
    const buscar = async (st) => (await ml(`/users/${id}/items/search?status=${st}&orders=last_updated_desc&limit=50`)
      .catch(() => null))?.results || [];
    const [pausados, revisao] = await Promise.all([buscar('paused'), buscar('under_review')]);
    const agora = [...pausados, ...revisao];
    const novosP = agora.filter((x) => !conhecidos.has(x));
    if (novosP.length && !primeira) {
      const det = await infoItens(novosP, 'id,title,status,sub_status');
      for (const x of novosP) {
        const it = det[x]; if (!it) continue;
        const sub = it.sub_status || [];
        const motivo = sub.includes('out_of_stock') ? 'sem estoque'
          : it.status === 'under_review' || sub.some((s) => /moderat|waiting_for_patch|held|forbidden/.test(s)) ? 'pelo Mercado Livre (revisão/moderação)'
            : 'pausado';
        D.avisoCriar(id, { tipo: 'pausa', chave: `pausa:${x}:${new Date().toISOString().slice(0, 10)}`,
          titulo: `Anúncio pausado ${motivo}`, texto: it.title || x,
          link: `/anuncios.html?q=${encodeURIComponent(x)}` });
      }
    }
    D.configGravar(`avisos_pausados:${id}`, JSON.stringify([...new Set([...agora])].slice(0, 500)));
  }

  const dia = (url, padrao, ok) => { const d = Number(url.searchParams.get('dias')) || padrao; return ok.includes(d) ? d : padrao; };

  const rotas = {
    'GET /api/performance': async (url) => performance(contaOuErro(), dia(url, 30, [7, 15, 30, 60, 75])),
    'GET /api/performance/logistica': async (url) => logistica(contaOuErro(), dia(url, 30, [7, 15, 30, 60, 75])),
    'GET /api/abc': async (url) => abc(contaOuErro(), dia(url, 30, [15, 30, 60, 90, 150])),
    'GET /api/full': async (url) => { if (url.searchParams.get('recarregar')) cacheFull = null; return full(contaOuErro()); },
    'GET /api/anuncios/qualidade': async (url) => {
      const conta = contaOuErro();
      if (url.searchParams.get('recarregar')) cacheAtivos = null;
      const f = url.searchParams.get('filtro');
      return qualidade(conta, ['incompletos', 'ruins', 'objetivos'].includes(f) ? f : null,
        Math.max(0, Number(url.searchParams.get('pagina')) || 0));
    },
    'GET /api/avisos': async () => {
      const conta = contaOuErro();
      await gerarAvisos(conta).catch(() => null);
      return { nao_lidos: D.avisosNaoLidos(conta.ml_user_id), avisos: D.avisosListar(conta.ml_user_id, 40) };
    },
    'POST /api/avisos/lidos': async (_u, body) => {
      const conta = contaOuErro();
      const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isInteger) : null;
      D.avisosMarcarLidos(conta.ml_user_id, ids);
      return { ok: true };
    },
  };

  return { rotas, rotasParam: [] };
}

module.exports = { criar, lerQualidade, cobertura, ehFull, canalDe, porCanal };
