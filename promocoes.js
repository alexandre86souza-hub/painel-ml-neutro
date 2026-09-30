'use strict';
// Promoções do vendedor (API /seller-promotions, app_version=v2): o que está disponível,
// quais anúncios estão em cada uma, entrar e sair por anúncio, e quanto cada promoção vendeu.
//
// Medido em 28/09/2026 numa conta real:
//   - /seller-promotions/users/{id} lista as promoções abertas para o vendedor (7 na conta);
//   - /seller-promotions/promotions/{id}/items pagina com searchAfter, não com offset;
//   - /seller-promotions/items/{item} traz TODAS as promoções do anúncio com o status dele
//     em cada uma (candidate = pode entrar, pending = entra quando começar, started = dentro);
//   - venda com promoção: /orders/{id}/discounts -> supplier.offer_id; a oferta aponta a
//     promoção em /seller-promotions/offers/{oferta}, até depois de a promoção acabar.
//     Pedido sem desconto responde 404 "discount_not_found".

const V2 = 'app_version=v2';
const PROMO_ID = /^[A-Z0-9][A-Z0-9-]{2,40}$/;
const OFERTA_ID = /^[A-Z]+-[A-Z]{3}\d+-\d+$/;

// O que cada tipo pede para entrar. Os que só pedem a oferta (o preço vem pronto do ML)
// são os que o ML calcula e cofinancia; nos outros o vendedor escolhe o preço.
const TIPOS = {
  DEAL: { nome: 'Campanha do Mercado Livre', preco: true },
  MARKETPLACE_CAMPAIGN: { nome: 'Campanha cofinanciada', preco: false },
  SELLER_CAMPAIGN: { nome: 'Campanha do vendedor', preco: true },
  SMART: { nome: 'Oferta cofinanciada automática', preco: false, oferta: true },
  PRICE_MATCHING: { nome: 'Preço competitivo', preco: false, oferta: true },
  PRICE_MATCHING_MELI_ALL: { nome: 'Preço competitivo (ML paga)', preco: false, oferta: true },
  UNHEALTHY_STOCK: { nome: 'Estoque parado (Full)', preco: false, oferta: true },
  LIGHTNING: { nome: 'Oferta relâmpago', preco: true, estoque: true },
  DOD: { nome: 'Oferta do dia', preco: true },
  VOLUME: { nome: 'Desconto por volume', preco: false },
  PRICE_DISCOUNT: { nome: 'Desconto próprio', preco: true, datas: true },
  PRE_NEGOTIATED: { nome: 'Desconto pré-negociado', preco: false, oferta: true },
  BANK: { nome: 'Desconto no meio de pagamento', preco: false },
};
const tipoNome = (t) => TIPOS[t]?.nome || t || 'Promoção';

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const exigePromo = (id) => { if (!PROMO_ID.test(id || '')) throw erro('id de promoção inválido'); return id; };
const exigeTipo = (t) => { if (!/^[A-Z_]{3,40}$/.test(t || '')) throw erro('tipo de promoção inválido'); return t; };

// Corpo do POST /seller-promotions/items/{item} por tipo. Função pura: testada em test-promocoes.js.
function corpoAdesao(d) {
  const tipo = exigeTipo(d.tipo);
  const regra = TIPOS[tipo] || {};
  const corpo = { promotion_type: tipo };
  if (tipo !== 'PRICE_DISCOUNT') corpo.promotion_id = exigePromo(d.promocao_id);
  if (regra.oferta) {
    if (!OFERTA_ID.test(d.oferta_id || '')) throw erro('Falta a oferta (offer_id) do anúncio nesta promoção.');
    corpo.offer_id = d.oferta_id;
  }
  if (regra.preco) {
    const p = Number(d.preco);
    if (!Number.isFinite(p) || p <= 0) throw erro('Informe o preço promocional.');
    if (Number.isFinite(Number(d.preco_original)) && p >= Number(d.preco_original)) {
      throw erro('O preço promocional precisa ser menor que o preço atual do anúncio.');
    }
    corpo.deal_price = Math.round(p * 100) / 100;
  }
  if (regra.estoque) {
    const e = Number(d.estoque);
    if (!Number.isInteger(e) || e <= 0) throw erro('Informe quantas unidades entram na oferta relâmpago.');
    corpo.stock = e;
  }
  if (regra.datas) {
    // Desconto próprio (documentação, 09/06/2026): datas só valem pelo dia (00h até 23h59),
    // no máximo 14 dias, desconto entre 5% e 80%.
    const soDia = /^\d{4}-\d{2}-\d{2}$/;
    if (soDia.test(d.inicio || '') && soDia.test(d.fim || '')) {
      if (d.fim < d.inicio) throw erro('Informe o início e o fim do desconto (o fim depois do início).');
      if ((Date.parse(d.fim) - Date.parse(d.inicio)) / 864e5 + 1 > 14) throw erro('O desconto próprio pode durar no máximo 14 dias.');
      corpo.start_date = `${d.inicio}T00:00:00`;
      corpo.finish_date = `${d.fim}T23:59:59`;
    } else {
      const ini = new Date(d.inicio), fim = new Date(d.fim);
      if (!d.inicio || !d.fim || Number.isNaN(+ini) || Number.isNaN(+fim) || fim <= ini) {
        throw erro('Informe o início e o fim do desconto (o fim depois do início).');
      }
      corpo.start_date = ini.toISOString().replace(/\.\d{3}Z$/, '');
      corpo.finish_date = fim.toISOString().replace(/\.\d{3}Z$/, '');
    }
    const orig = Number(d.preco_original);
    if (Number.isFinite(orig) && orig > 0 && corpo.deal_price) {
      const desc = 1 - corpo.deal_price / orig;
      if (desc < 0.05 || desc >= 0.8) throw erro('O Mercado Livre aceita desconto próprio entre 5% e 80% do preço atual.');
    }
  }
  return corpo;
}

// Query do DELETE: sair de uma promoção. PRICE_DISCOUNT não tem id de promoção.
function querySaida(d) {
  const tipo = exigeTipo(d.tipo);
  const p = new URLSearchParams({ promotion_type: tipo });
  if (tipo !== 'PRICE_DISCOUNT') p.set('promotion_id', exigePromo(d.promocao_id));
  if (d.oferta_id) {
    if (!OFERTA_ID.test(d.oferta_id)) throw erro('offer_id inválido');
    p.set('offer_id', d.oferta_id);
  }
  return `${p}&${V2}`;
}

// A linha "Sem promoção" e as promoções vêm na mesma lista; a tela compara pelo desconto.
function montarResultado(linhas) {
  const total = linhas.reduce((s, l) => s + (l.faturamento || 0), 0);
  return linhas.map((l) => {
    const fat = l.faturamento || 0, dv = l.desconto_vendedor || 0, dt = l.desconto_total || 0;
    return {
      promocao_id: l.promocao_id || null,
      tipo: l.tipo || null,
      tipo_nome: !l.tipo ? 'Sem promoção' : l.tipo === 'DESCONHECIDA' ? 'Promoção não identificada'
        : l.tipo === 'CUPOM' ? 'Cupom' : tipoNome(l.tipo),
      nome: l.nome || (l.tipo === 'PRICE_DISCOUNT' ? 'Desconto próprio' : null),
      inicio: l.inicio || null, fim: l.fim || null, status: l.status || null,
      pedidos: l.pedidos || 0, anuncios: l.anuncios || 0, unidades: l.unidades || 0,
      faturamento: fat, tarifas: l.tarifas || 0,
      desconto_total: dt, desconto_vendedor: dv, desconto_ml: Math.max(0, dt - dv),
      // quanto do faturamento o vendedor deu de desconto do próprio bolso
      desconto_pct: fat ? dv / (fat + dv) : 0,
      participacao: total ? fat / total : 0,
      // faturamento por real de desconto que saiu do vendedor: o "retorno" da promoção
      retorno: dv > 0 ? fat / dv : null,
    };
  });
}

// Extrai as linhas de desconto de /orders/{id}/discounts: uma por anúncio, a maior manda.
function linhasDoDesconto(json) {
  const porItem = new Map();
  for (const det of json?.details || []) {
    for (const it of det.items || []) {
      if (!it.id) continue;
      const tot = Number(it.amounts?.total) || 0, vend = Number(it.amounts?.seller) || 0;
      const atual = porItem.get(it.id);
      const oferta = det.supplier?.offer_id || null;
      const financiamento = det.supplier?.funding_mode || det.type || null;   // cupom não tem funding_mode
      if (!atual) {
        porItem.set(it.id, { item_id: it.id, oferta_id: oferta, financiamento,
          desconto_total: tot, desconto_vendedor: vend, maior: tot });
      } else {
        atual.desconto_total += tot; atual.desconto_vendedor += vend;
        if (tot > atual.maior) Object.assign(atual, { oferta_id: oferta, financiamento, maior: tot });
      }
    }
  }
  return [...porItem.values()].map(({ maior, ...l }) => l);
}

// Lucro de uma unidade vendida no preço da promoção. Nas promoções cofinanciadas (SMART,
// PRICE_MATCHING…) a parte do ML (meli_percentage do preço original) chega como tarifa menor:
// medido numa venda de 28/09/2026 — tarifa cheia no preço promocional R$ 22,48, cobrada
// R$ 19,86; a diferença (R$ 2,62) é o total do desconto menos a parte do vendedor.
// Sem custo ou sem frete não inventa lucro: devolve null com o que falta. Função pura: testada.
function lucroNoPreco({ preco, precoOriginal, meliPct = 0, tarifa, custo, embalagem = 0, frete, impostoPct = 0 }) {
  const falta = [];
  if (custo == null) falta.push('custo');
  if (frete == null) falta.push('frete');
  if (!tarifa || tarifa.pct == null) falta.push('tarifa');
  if (falta.length || !(preco > 0)) return { lucro: null, margem: null, falta };
  const tarifaCheia = preco * tarifa.pct / 100 + (tarifa.fixa || 0);
  const parteML = (precoOriginal || 0) * (meliPct || 0) / 100;
  const tarifaPaga = Math.max(0, tarifaCheia - parteML);
  const imposto = preco * impostoPct / 100;
  const lucro = preco - tarifaPaga - imposto - frete - custo - (embalagem || 0);
  const r = (v) => Math.round(v * 100) / 100;
  return { lucro: r(lucro), margem: lucro / preco, tarifa: r(tarifaPaga), parte_ml: r(parteML), imposto: r(imposto), falta };
}

// Campanha do vendedor (SELLER_CAMPAIGN, sub_type FLEXIBLE_PERCENTAGE): corpo do POST
// /seller-promotions/promotions. Regras da documentação: até 14 dias, início a partir de
// hoje, datas no formato local sem fuso (o ML trata o início como 00h e o fim como 23h59).
// Função pura: testada.
function corpoCampanha({ nome, inicio, fim }, hoje = new Date()) {
  const n = String(nome || '').trim();
  if (n.length < 3 || n.length > 60) throw erro('Dê um nome à campanha (3 a 60 caracteres).');
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(inicio || '') || !re.test(fim || '')) throw erro('Informe as datas de início e fim.');
  const hojeLocal = new Date(hoje.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  if (inicio < hojeLocal) throw erro('O início não pode ser antes de hoje.');
  if (fim < inicio) throw erro('O fim precisa ser depois do início.');
  const dias = (Date.parse(fim) - Date.parse(inicio)) / 864e5 + 1;
  if (dias > 14) throw erro('O Mercado Livre aceita campanha do vendedor de no máximo 14 dias.');
  return { promotion_type: 'SELLER_CAMPAIGN', name: n, sub_type: 'FLEXIBLE_PERCENTAGE',
    start_date: `${inicio}T00:00:00`, finish_date: `${fim}T00:00:00` };
}

function criar({ ml, mlPaciente, emLotes, contaOuErro, exigeItemId, sincronizarVendas, janela, freteDoItem, idsDaConta, D }) {
  const promocoesDaConta = async (conta) =>
    (await ml(`/seller-promotions/users/${conta.ml_user_id}?${V2}`)).results || [];

  // Quantos anúncios estão dentro (started+pending) e quantos podem entrar (candidate).
  async function contagem(p) {
    const base = `/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?promotion_type=${p.type}&${V2}&limit=1`;
    const n = async (st) => (await ml(`${base}&status=${st}`).catch(() => null))?.paging?.total ?? null;
    const [candidatos, ativos, pendentes] = await Promise.all([n('candidate'), n('started'), n('pending')]);
    return { candidatos, ativos, pendentes };
  }

  async function infoItens(ids) {
    const lotes = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const out = {};
    await emLotes(lotes, 4, async (lote) => {
      try {
        const r = await ml(`/items?ids=${lote.join(',')}&attributes=id,title,thumbnail,permalink,price,`
          + 'available_quantity,status,category_id,listing_type_id,site_id,shipping');
        for (const x of r) if (x.code === 200) out[x.body.id] = x.body;
      } catch { /* título e foto são enfeite */ }
    });
    return out;
  }

  // ---------- lucro no preço da promoção ----------
  // Tarifa do ML por (categoria, tipo, preço): muda por faixa de preço (e tem parte fixa
  // abaixo de R$ 79). Guardada em memória: o mesmo preço volta muitas vezes.
  const tarifas = new Map();
  async function tarifaEm(it, preco) {
    const chave = `${it.category_id}|${it.listing_type_id}|${preco}`;
    if (!tarifas.has(chave)) {
      tarifas.set(chave, ml(`/sites/${it.site_id || 'MLB'}/listing_prices?price=${preco}`
        + `&listing_type_id=${it.listing_type_id}&category_id=${it.category_id}`)
        .then((r) => { const x = Array.isArray(r) ? r[0] : r;
          return { pct: x?.sale_fee_details?.percentage_fee ?? null, fixa: x?.sale_fee_details?.fixed_fee ?? 0 }; })
        .catch(() => { tarifas.delete(chave); return null; }));
    }
    return tarifas.get(chave);
  }
  // Frete por unidade (medido nas vendas; sem vendas, a estimativa do ML). 30 min de cache.
  const fretes = new Map();
  async function freteDe(conta, it) {
    const c = fretes.get(it.id);
    if (c && Date.now() - c.em < 30 * 60e3) return c.v;
    const f = await freteDoItem(conta, it, janela(60), 5).catch(() => null);
    const v = f ? { valor: f.por_unidade, fonte: f.fonte } : null;
    fretes.set(it.id, { v, em: Date.now() });
    return v;
  }
  const empresaDe = (conta) => { try { return JSON.parse(D.configLer(`empresa:${conta.ml_user_id}`) || '{}'); } catch { return {}; } };

  // O que entra na conta do lucro de um anúncio num preço: devolve os componentes (a tela
  // refaz a conta para outro preço digitado) e o lucro no preço pedido e no atual.
  async function lucroDe(conta, it, preco, meliPct, ctx) {
    const c = ctx.custos[it.id];
    const custo = c?.custo ?? null;
    const embalagem = (c?.outros ?? ctx.empresa.embalagem_padrao ?? 0) + (c?.extra || 0);   // embalagem + outro custo do anúncio
    const [tPromo, tAtual, frete] = await Promise.all([tarifaEm(it, preco), tarifaEm(it, it.price), freteDe(conta, it)]);
    const base = { custo, embalagem, frete: frete?.valor ?? null, impostoPct: ctx.impostoPct };
    return {
      id: it.id, preco, preco_atual: it.price, custo, embalagem, frete: frete?.valor ?? null, frete_fonte: frete?.fonte || null,
      imposto_pct: ctx.impostoPct, tarifa_pct: tPromo?.pct ?? null, tarifa_fixa: tPromo?.fixa ?? 0,
      tarifa_pct_atual: tAtual?.pct ?? null, tarifa_fixa_atual: tAtual?.fixa ?? 0, meli_pct: meliPct || 0,
      promo: lucroNoPreco({ ...base, preco, precoOriginal: it.price, meliPct, tarifa: tPromo }),
      atual: lucroNoPreco({ ...base, preco: it.price, precoOriginal: it.price, meliPct: 0, tarifa: tAtual }),
    };
  }

  // Lê o desconto dos pedidos da janela ainda não lidos e resolve oferta -> promoção -> nome.
  async function atribuir(conta, j) {
    const faltam = D.promoPedidosSemLeitura(conta.ml_user_id, j.de, j.ate);
    await emLotes(faltam, 4, async (orderId) => {
      let json = null;
      try { json = await mlPaciente(`/orders/${orderId}/discounts`, conta.ml_user_id); }
      catch (e) { if (e.status !== 404) return; }   // 404 = pedido sem desconto; outro erro: tenta na próxima
      D.promoPedidoGravar(conta.ml_user_id, orderId, linhasDoDesconto(json));
    });
    const ofertas = D.promoOfertasSemPromocao(conta.ml_user_id);
    await emLotes(ofertas, 4, async (oferta) => {
      try {
        const o = await mlPaciente(`/seller-promotions/offers/${encodeURIComponent(oferta)}?${V2}`, conta.ml_user_id);
        D.promoOfertaGravar(oferta, o.promotion_id || null, o.type || null);
      } catch (e) { if (e.status === 404) D.promoOfertaGravar(oferta, null, null); }
    });
    await emLotes(D.promoNomesFaltando(), 4, async ({ promocao_id: id, tipo }) => {
      try {
        const p = await mlPaciente(`/seller-promotions/promotions/${encodeURIComponent(id)}?promotion_type=${tipo}&${V2}`,
          conta.ml_user_id);
        D.promoNomeGravar({ ...p, id });
      } catch (e) { if (e.status === 404) D.promoNomeGravar({ id, type: tipo }); }
    });
    return faltam.length;
  }

  const DIAS_OK = [7, 15, 30, 60, 90];

  // Todas as promoções abertas, anúncio por anúncio: Map(item_id -> { id, titulo, foto,
  // preco, estoque, vendas_90, promocoes: [...] }). Até 50 páginas de 50 por promoção.
  let cachePorAnuncio = null;
  async function promocoesPorAnuncio(conta) {
    if (cachePorAnuncio?.conta === conta.ml_user_id && Date.now() - cachePorAnuncio.em < 10 * 60e3) return cachePorAnuncio.mapa;
    const promos = await promocoesDaConta(conta);
    const mapa = new Map();
    await emLotes(promos, 3, async (p) => {
      const base = `/seller-promotions/promotions/${encodeURIComponent(p.id)}/items?promotion_type=${p.type}&limit=50&${V2}`;
      let depois = null;
      for (let pag = 0; pag < 50; pag++) {
        const r = await mlPaciente(`${base}${depois ? `&searchAfter=${depois}` : ''}`, conta.ml_user_id).catch(() => null);
        for (const x of r?.results || []) {
          if (!mapa.has(x.id)) mapa.set(x.id, { id: x.id, promocoes: [] });
          mapa.get(x.id).promocoes.push({
            id: p.id, tipo: p.type, tipo_nome: tipoNome(p.type), nome: p.name || tipoNome(p.type), status: x.status,
            preco: x.price || null, preco_original: x.original_price ?? null, oferta_id: x.offer_id || x.ref_id || null,
            ml_pct: x.meli_percentage ?? null, vendedor_pct: x.seller_percentage ?? null,
            preco_min: x.min_discounted_price ?? null, preco_max: x.max_discounted_price ?? null,
            preco_sugerido: x.suggested_discounted_price ?? null,
            estoque_min: x.stock?.min ?? null, estoque_max: x.stock?.max ?? null,
            inicio: p.start_date || null, fim: p.finish_date || null, prazo: p.deadline_date || null,
            precisa_preco: !!TIPOS[p.type]?.preco, precisa_estoque: !!TIPOS[p.type]?.estoque, precisa_datas: false,
          });
        }
        depois = r?.paging?.searchAfter;
        if (!depois || !(r?.results || []).length) break;
      }
    });
    const ids = [...mapa.keys()];
    const info = await infoItens(ids);
    const ultimas = D.ultimasVendas(ids, 1);
    const desde = new Date(Date.now() - 90 * 864e5).toISOString();
    const qtd90 = Object.fromEntries(D.db.prepare(`SELECT item_id, SUM(quantidade) AS u FROM vendas
      WHERE ml_user_id=? AND data >= ? AND status IN ('paid','partially_refunded') GROUP BY item_id`)
      .all(conta.ml_user_id, desde).map((r) => [r.item_id, r.u]));
    for (const [id, a] of mapa) {
      const it = info[id];
      Object.assign(a, { titulo: it?.title || null, foto: it?.thumbnail || null, link: it?.permalink || null,
        preco: it?.price ?? null, estoque: it?.available_quantity ?? null, status: it?.status || null,
        vendas_90: qtd90[id] || 0, ultima_venda: ultimas[id]?.[0] || null });
      const ordem = { started: 0, pending: 1, candidate: 2 };
      a.promocoes.sort((x, y) => (ordem[x.status] ?? 3) - (ordem[y.status] ?? 3));
    }
    cachePorAnuncio = { conta: conta.ml_user_id, em: Date.now(), mapa,
      promocoes: promos.map((p) => ({ id: p.id, nome: p.name || tipoNome(p.type), tipo_nome: tipoNome(p.type) })) };
    return mapa;
  }

  const rotas = {
    // Promoções abertas para a conta, com quantos anúncios estão dentro e quantos podem entrar.
    'GET /api/promocoes': async () => {
      const conta = contaOuErro();
      const lista = await promocoesDaConta(conta);
      const contagens = await emLotes(lista, 4, contagem);
      for (const p of lista) if (p.name) D.promoNomeGravar(p);
      return {
        promocoes: lista.map((p, i) => ({
          id: p.id, tipo: p.type, tipo_nome: tipoNome(p.type), subtipo: p.sub_type || null,
          nome: p.name || tipoNome(p.type), status: p.status,
          inicio: p.start_date || null, fim: p.finish_date || null, prazo: p.deadline_date || null,
          meio_pagamento: p.payment_method || null,
          precisa_preco: !!TIPOS[p.type]?.preco,
          ...contagens[i],
        })),
      };
    },

    // Anúncios de uma promoção, filtrados por status. Paginação do ML é por searchAfter.
    // sem_venda=30|60|90: só os que não venderam nesse prazo. O ML não filtra por venda, então
    // aí a lista inteira da promoção é percorrida (até 40 páginas de 50) e vem sem paginação.
    'GET /api/promocoes/itens': async (url) => {
      const conta = contaOuErro();
      const q = url.searchParams;
      const id = exigePromo(q.get('promocao'));
      const tipo = exigeTipo(q.get('tipo'));
      const status = q.get('status');
      const semVenda = [30, 60, 90].includes(Number(q.get('sem_venda'))) ? Number(q.get('sem_venda')) : null;
      const p = new URLSearchParams({ promotion_type: tipo, limit: '50' });
      if (['candidate', 'started', 'pending'].includes(status)) p.set('status', status);
      const depois = q.get('depois');
      if (depois && /^[0-9a-f]{16,1024}$/.test(depois)) p.set('searchAfter', depois);
      const base = `/seller-promotions/promotions/${encodeURIComponent(id)}/items?`;
      let r = await ml(`${base}${p}&${V2}`);
      let brutos = r.results || [];
      let cortado = false;
      if (semVenda) {
        await sincronizarVendas(conta, 90);
        for (let pag = 1; r.paging?.searchAfter && (r.results || []).length; pag++) {
          if (pag >= 40) { cortado = true; break; }
          p.set('searchAfter', r.paging.searchAfter);
          r = await ml(`${base}${p}&${V2}`);
          brutos = brutos.concat(r.results || []);
        }
      }
      const vendas = D.ultimasVendas(brutos.map((x) => x.id), 3);
      const limiteData = semVenda ? new Date(Date.now() - semVenda * 864e5).toISOString() : null;
      const itens = semVenda
        ? brutos.filter((x) => !(vendas[x.id]?.[0]?.data >= limiteData))
        : brutos;
      const info = await infoItens(itens.map((x) => x.id));
      return {
        total: semVenda ? itens.length : (r.paging?.total ?? itens.length),
        depois: semVenda ? null : (r.paging?.searchAfter || null),
        sem_venda: semVenda, cortado, vendas_desde: D.vendasDesde(conta.ml_user_id),
        itens: itens.map((x) => ({
          ultimas_vendas: vendas[x.id] || [],
          id: x.id, status: x.status,
          titulo: info[x.id]?.title || null, foto: info[x.id]?.thumbnail || null,
          link: info[x.id]?.permalink || null, estoque_anuncio: info[x.id]?.available_quantity ?? null,
          preco: x.price || null, preco_original: x.original_price ?? info[x.id]?.price ?? null,
          oferta_id: x.offer_id || x.ref_id || null,
          ml_pct: x.meli_percentage ?? null, vendedor_pct: x.seller_percentage ?? null,
          preco_min: x.min_discounted_price ?? null, preco_max: x.max_discounted_price ?? null,
          preco_sugerido: x.suggested_discounted_price ?? null,
          estoque_min: x.stock?.min ?? null, estoque_max: x.stock?.max ?? null,
          inicio: x.start_date || null, fim: x.end_date || null,
        })),
      };
    },

    // Lucro de cada anúncio no preço da promoção (e no preço atual). A tela chama em lotes,
    // depois de mostrar a lista: são até 3 consultas ao ML por anúncio na primeira vez.
    'POST /api/promocoes/lucro': async (_u, body) => {
      const conta = contaOuErro();
      const pedidos = (Array.isArray(body?.itens) ? body.itens : []).slice(0, 60)
        .filter((x) => /^[A-Z]{3}\d+$/.test(x?.id || '') && Number(x.preco) > 0);
      if (!pedidos.length) return { itens: [] };
      const info = await infoItens([...new Set(pedidos.map((x) => x.id))]);
      const ctx = { custos: D.custosDe(Object.keys(info)), empresa: empresaDe(conta),
        impostoPct: D.impostoLer(conta.ml_user_id) || 0 };
      const itens = await emLotes(pedidos, 6, (x) => (info[x.id]
        ? lucroDe(conta, info[x.id], Math.round(Number(x.preco) * 100) / 100, Number(x.meli_pct) || 0, ctx)
          .then((r) => ({ ...r, chave: x.chave ?? null }))
        : { id: x.id, chave: x.chave ?? null, erro: 'anúncio não encontrado' }));
      return { itens };
    },

    // Promoções por anúncio: junta os anúncios de TODAS as promoções abertas e agrupa por
    // anúncio. O ML só lista por promoção, então a primeira abertura percorre todas (medido:
    // ~2.300 linhas nas 7 promoções da conta); fica 10 min em cache.
    'GET /api/promocoes/por-anuncio': async (url) => {
      const conta = contaOuErro();
      const q = url.searchParams;
      if (q.get('recarregar')) cachePorAnuncio = null;
      const mapa = await promocoesPorAnuncio(conta);
      let lista = [...mapa.values()];
      const filtro = q.get('filtro');
      if (filtro === 'participando') lista = lista.filter((a) => a.promocoes.some((p) => p.status === 'started' || p.status === 'pending'));
      if (filtro === 'podem_entrar') lista = lista.filter((a) => a.promocoes.some((p) => p.status === 'candidate'));
      if (filtro === 'fora') lista = lista.filter((a) => !a.promocoes.some((p) => p.status === 'started' || p.status === 'pending'));
      // Sem nenhuma campanha ativa: TODOS os anúncios ativos da conta (inclusive os que não
      // aparecem em lista nenhuma de promoção) menos os que participam ou estão programados.
      // sem_ativa: nenhuma campanha rodando AGORA (pode ter uma programada); sem_nenhuma: nem
      // rodando nem programada. Medido em 29/09/2026: quase todo anúncio ativo estava
      // programado (pending) na "10.10" — sem essa separação, "sem campanha" dava zero.
      if (filtro === 'sem_ativa' || filtro === 'sem_nenhuma') {
        const { ids } = await idsDaConta(conta, 'active', null);
        const conta_ = filtro === 'sem_ativa' ? ['started'] : ['started', 'pending'];
        const participa = (id) => (mapa.get(id)?.promocoes || []).some((p) => conta_.includes(p.status));
        const qtd90 = Object.fromEntries(D.db.prepare(`SELECT item_id, SUM(quantidade) AS u FROM vendas
          WHERE ml_user_id=? AND data >= ? AND status IN ('paid','partially_refunded') GROUP BY item_id`)
          .all(conta.ml_user_id, new Date(Date.now() - 90 * 864e5).toISOString()).map((r) => [r.item_id, r.u]));
        lista = ids.filter((id) => !participa(id))
          .map((id) => mapa.get(id) || { id, promocoes: [], vendas_90: qtd90[id] || 0, titulo: null });
        for (const a of lista) if (a.vendas_90 == null) a.vendas_90 = qtd90[a.id] || 0;
      }
      const promo = q.get('promocao');
      if (promo) lista = lista.filter((a) => a.promocoes.some((p) => p.id === promo));
      const busca = (q.get('q') || '').trim().toLowerCase();
      if (busca) lista = lista.filter((a) => a.id.toLowerCase().includes(busca) || (a.titulo || '').toLowerCase().includes(busca));
      lista.sort((a, b) => (b.vendas_90 - a.vendas_90) || (b.promocoes.length - a.promocoes.length));
      const porPagina = 20;
      const pagina = Math.max(0, Number(q.get('pagina')) || 0);
      const fatia = lista.slice(pagina * porPagina, (pagina + 1) * porPagina);
      // anúncio fora de qualquer lista de promoção ainda não tem título/foto: busca só os da página
      const semInfo = fatia.filter((a) => !a.titulo).map((a) => a.id);
      if (semInfo.length) {
        const info = await infoItens(semInfo);
        const ult = D.ultimasVendas(semInfo, 1);
        for (const a of fatia) {
          const it = info[a.id];
          if (it && !a.titulo) Object.assign(a, { titulo: it.title, foto: it.thumbnail, link: it.permalink, preco: it.price,
            estoque: it.available_quantity, status: it.status, ultima_venda: ult[a.id]?.[0] || null });
        }
      }
      return { total: lista.length, pagina, por_pagina: porPagina, gerado_em: cachePorAnuncio?.em || null,
        promocoes: cachePorAnuncio?.promocoes || [], itens: fatia };
    },

    // Cria uma campanha do vendedor. Os anúncios entram depois, pela lista da campanha
    // ("Podem entrar" + Aderir, com o preço/desconto de cada um).
    'POST /api/promocoes/campanha': async (_u, body) => {
      contaOuErro();
      const corpo = corpoCampanha(body || {});
      const r = await ml(`/seller-promotions/promotions?${V2}`, { method: 'POST', body: JSON.stringify(corpo) });
      cachePorAnuncio = null;
      return { id: r.id, nome: r.name, status: r.status, inicio: r.start_date, fim: r.finish_date, tipo: r.type };
    },

    // Quanto cada promoção vendeu na janela, comparado com as vendas sem promoção.
    'GET /api/promocoes/resultado': async (url) => {
      const conta = contaOuErro();
      const pedido = Number(url.searchParams.get('dias')) || 30;
      const dias = DIAS_OK.includes(pedido) ? pedido : 30;
      await sincronizarVendas(conta, dias);
      const j = janela(dias);
      const lidos = await atribuir(conta, j);
      const linhas = montarResultado(D.promoResultado(conta.ml_user_id, j.de, j.ate));
      // Mais vendidos de cada promoção (e das vendas sem promoção, na chave SEM). Grupo
      // sem id de promoção (desconto próprio antigo, oferta não identificada) fica sem lista.
      const top = {};
      for (const l of linhas.slice(0, 12)) {
        if (!l.promocao_id && l.tipo) continue;
        top[l.promocao_id || 'SEM'] = D.promoTopItens(conta.ml_user_id, l.promocao_id, j.de, j.ate, 5);
      }
      const info = await infoItens([...new Set(Object.values(top).flat().map((x) => x.item_id))]);
      for (const k of Object.keys(top)) {
        top[k] = top[k].map((x) => ({ ...x, titulo: info[x.item_id]?.title || null, foto: info[x.item_id]?.thumbnail || null }));
      }
      return { dias, de: j.primeiro, ate: j.ultimo, pedidos_lidos_agora: lidos, linhas, top };
    },
  };

  const rotasParam = [
    // Todas as promoções de um anúncio e o status dele em cada uma.
    { m: 'GET', re: /^\/api\/promocoes\/anuncio\/([A-Z]{3}\d+)$/, fn: async ([id]) => {
      contaOuErro();
      exigeItemId(id);
      const [lista, info] = await Promise.all([
        ml(`/seller-promotions/items/${id}?${V2}`),
        infoItens([id]),
      ]);
      const it = info[id] || {};
      return {
        item: { id, titulo: it.title || null, foto: it.thumbnail || null, link: it.permalink || null,
          preco: it.price ?? null, estoque: it.available_quantity ?? null, status: it.status || null,
          ultimas_vendas: D.ultimasVendas([id], 5)[id] || [] },
        promocoes: (Array.isArray(lista) ? lista : []).map((p) => ({
          id: p.id || null, tipo: p.type, tipo_nome: tipoNome(p.type), nome: p.name || tipoNome(p.type),
          status: p.status, preco: p.price || null, preco_original: p.original_price ?? it.price ?? null,
          oferta_id: p.ref_id || p.offer_id || null,
          ml_pct: p.meli_percentage ?? null, vendedor_pct: p.seller_percentage ?? null,
          preco_min: p.min_discounted_price ?? null, preco_max: p.max_discounted_price ?? null,
          preco_sugerido: p.suggested_discounted_price ?? null,
          estoque_min: p.stock?.min ?? null, estoque_max: p.stock?.max ?? null,
          inicio: p.start_date || null, fim: p.finish_date || null,
          precisa_preco: !!TIPOS[p.type]?.preco, precisa_estoque: !!TIPOS[p.type]?.estoque,
          precisa_datas: !!TIPOS[p.type]?.datas,
        })),
      };
    } },

    // Excluir uma campanha do vendedor (só SELLER_CAMPAIGN: as do ML não são do vendedor).
    { m: 'POST', re: /^\/api\/promocoes\/campanha\/(C-[A-Z]{3}\d+)\/excluir$/, fn: async ([id]) => {
      contaOuErro();
      await ml(`/seller-promotions/promotions/${id}?promotion_type=SELLER_CAMPAIGN&${V2}`, { method: 'DELETE' });
      cachePorAnuncio = null;
      return { ok: true, id };
    } },

    // Entrar numa promoção com um anúncio. Muda o preço de venda de verdade.
    { m: 'POST', re: /^\/api\/promocoes\/anuncio\/([A-Z]{3}\d+)\/aderir$/, fn: async ([id], body) => {
      contaOuErro();
      exigeItemId(id);
      const corpo = corpoAdesao(body || {});
      const r = await ml(`/seller-promotions/items/${id}?${V2}`, { method: 'POST', body: JSON.stringify(corpo) });
      cachePorAnuncio = null;
      return { ok: true, item_id: id, enviado: corpo, resposta: r };
    } },

    // Sair de uma promoção com um anúncio. O preço volta ao original.
    { m: 'POST', re: /^\/api\/promocoes\/anuncio\/([A-Z]{3}\d+)\/sair$/, fn: async ([id], body) => {
      contaOuErro();
      exigeItemId(id);
      const r = await ml(`/seller-promotions/items/${id}?${querySaida(body || {})}`, { method: 'DELETE' });
      cachePorAnuncio = null;
      return { ok: true, item_id: id, resposta: r };
    } },
  ];

  return { rotas, rotasParam };
}

module.exports = { criar, lucroNoPreco, corpoCampanha, corpoAdesao, querySaida, montarResultado, linhasDoDesconto, TIPOS, tipoNome };
