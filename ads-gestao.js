'use strict';
// Gestão das campanhas do Mercado Ads (Product Ads) na tela Publicidade (Ads): criar e editar campanha, ver os anúncios de
// cada campanha, colocar (ou mover de outra campanha), pausar, reativar e tirar anúncio. Escrita SÓ pelo clique da tela,
// com confirmação; nada no MCP.
//
// Documentação oficial do Product Ads (atualizada em 03/07/2026): o anúncio entra na campanha pelo GRUPO DE ANÚNCIO
// (ad_group_id). Variações e anúncios da mesma família (User Products) ou do mesmo produto de catálogo formam UM grupo,
// e mexer no grupo mexe em todos eles.
//   criar campanha   POST   /advertising/{site}/advertisers/{adv}/product_ads/campaigns
//                           { name, status, budget, strategy, channel, roas_target } (todos obrigatórios; ROAS de 1x a 35x)
//   editar campanha  PUT    /advertising/{site}/product_ads/campaigns/{id}       (só o que muda)
//   colocar/mover/pausar   PUT /advertising/{site}/advertisers/{adv}/product_ads/ad_groups   { ad_groups, status, campaign_id }
//   tirar da campanha      DELETE /advertising/{site}/product_ads/campaigns/{id}/ad_groups   { ad_groups }
// A documentação escreve /marketplace/advertising/…; a conta real responde a leitura em /advertising/… (medido em
// 15/10/2026, ads/search e ad_groups/search). Escrita: tenta /advertising e, com 404, /marketplace/advertising.
// `budget` = média diária do orçamento MENSAL (o ML pode gastar até o dobro num dia com a sobra de dias anteriores).

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const r2 = (v) => Math.round(v * 100) / 100;
const numero = (v) => (v === '' || v == null ? NaN : Number(String(v).replace(',', '.')));
const ESTRATEGIAS = ['profitability', 'increase', 'visibility'];
const METRICAS = 'clicks,prints,cost,total_amount,direct_amount,indirect_amount,units_quantity';

// Corpo da tela -> campanha do ML. Nova: tudo obrigatório; edição: só o que veio. Função pura: testada.
function campanhaDoCorpo(b = {}, { nova = false } = {}) {
  const out = {};
  if (nova || b.nome != null) {
    const nome = String(b.nome ?? '').trim();
    if (!nome || nome.length > 100) throw erro('Nome da campanha: de 1 a 100 caracteres.');
    out.name = nome;
  }
  if (nova || b.status != null) {
    if (!['active', 'paused'].includes(b.status)) throw erro('Situação da campanha: ativa ou pausada.');
    out.status = b.status;
  }
  if (nova || b.orcamento != null) {
    const v = numero(b.orcamento);
    if (!(v > 0) || v > 100000) throw erro('Orçamento diário inválido (em reais, maior que zero).');
    out.budget = r2(v);
  }
  if (nova || b.estrategia != null) {
    const s = String(b.estrategia ?? '').toLowerCase();
    if (!ESTRATEGIAS.includes(s)) throw erro('Estratégia: rentabilidade, crescimento ou visibilidade.');
    out.strategy = s;
  }
  if (nova || b.roas_alvo != null) {
    const v = numero(b.roas_alvo);
    if (!(v >= 1 && v <= 35)) throw erro('ROAS objetivo: de 1x a 35x.');
    out.roas_target = r2(v);
  }
  if (nova) out.channel = 'marketplace';
  if (!Object.keys(out).length) throw erro('Nada para mudar na campanha.');
  return out;
}

// Lista de grupos de anúncio vinda da tela: números inteiros, sem repetir, até 500. Função pura: testada.
function gruposDoCorpo(lista) {
  const ids = [...new Set((Array.isArray(lista) ? lista : []).map(Number))];
  if (!ids.length) throw erro('Escolha pelo menos um anúncio.');
  if (ids.length > 500) throw erro('No máximo 500 anúncios por vez.');
  if (ids.some((x) => !Number.isSafeInteger(x) || x <= 0)) throw erro('Anúncio inválido na lista.');
  return ids;
}

// Linhas do ads/search -> grupos de anúncio com os anúncios de cada um e os números somados. A paginação do ads/search
// repete linhas (medido: 502 linhas para 461 anúncios): uma vez por item + grupo. Função pura: testada.
function agruparAnuncios(linhas) {
  const grupos = new Map(), vistos = new Set();
  for (const a of linhas || []) {
    const g = a.ad_group_id ?? `item:${a.item_id}`;
    const chave = `${a.item_id}|${g}|${a.campaign_id ?? ''}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const x = grupos.get(g) || { ad_group_id: a.ad_group_id ?? null, campanha_id: a.campaign_id || null, status: a.status || null,
      titulo: a.family_name || a.title || null, foto: a.thumbnail || null, recomendado: false, itens: [],
      investimento: 0, receita: 0, cliques: 0, impressoes: 0, unidades: 0 };
    x.itens.push({ item_id: a.item_id, titulo: a.title || null, preco: a.price ?? null, status: a.status || null, link: a.permalink || null,
      catalogo: !!a.catalog_listing });
    if (a.status === 'active') x.status = 'active';   // um anúncio ativo deixa o grupo ativo
    x.recomendado ||= !!a.recommended;
    const m = a.metrics || {};
    x.investimento += Number(m.cost) || 0;
    x.receita += Number(m.total_amount) || (Number(m.direct_amount) || 0) + (Number(m.indirect_amount) || 0);
    x.cliques += Number(m.clicks) || 0; x.impressoes += Number(m.prints) || 0; x.unidades += Number(m.units_quantity) || 0;
    grupos.set(g, x);
  }
  return [...grupos.values()].map((x) => ({ ...x, investimento: r2(x.investimento), receita: r2(x.receita),
    roas: x.investimento > 0 ? x.receita / x.investimento : null }));
}

// Anúncios que venderam PELO ADS (tela Histórico ADS): linhas do ads/search do período e do período anterior -> por
// anúncio a venda atribuída ao Ads (total_amount = direta + indireta), unidades, cliques, investimento e a participação
// no total do Ads; só os que venderam no período. Linha repetida da paginação conta uma vez. Função pura: testada.
function vendasPorAnuncio(atual, antes = [], nomes = {}) {
  const somar = (linhas) => {
    const m = new Map(), vistos = new Set();
    for (const a of linhas || []) {
      const k = `${a.item_id}|${a.ad_group_id ?? ''}|${a.campaign_id ?? ''}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      const met = a.metrics || {};
      const x = m.get(a.item_id) || { item_id: a.item_id, titulo: a.title || a.family_name || null, foto: a.thumbnail || null, preco: a.price ?? null,
        link: a.permalink || null, status: a.status || null, catalogo: !!a.catalog_listing, campanhas: new Set(),
        vendas: 0, direta: 0, unidades: 0, cliques: 0, impressoes: 0, investimento: 0 };
      x.vendas += Number(met.total_amount) || (Number(met.direct_amount) || 0) + (Number(met.indirect_amount) || 0);
      x.direta += Number(met.direct_amount) || 0;
      x.unidades += Number(met.units_quantity) || 0;
      x.cliques += Number(met.clicks) || 0; x.impressoes += Number(met.prints) || 0; x.investimento += Number(met.cost) || 0;
      if (a.campaign_id) x.campanhas.add(a.campaign_id);
      m.set(a.item_id, x);
    }
    return m;
  };
  const ma = somar(atual), mb = somar(antes);
  const venderam = [...ma.values()].filter((x) => x.vendas > 0 || x.unidades > 0);
  const total = venderam.reduce((s, x) => s + x.vendas, 0);
  const totalAntes = [...mb.values()].reduce((s, x) => s + x.vendas, 0);
  const anuncios = venderam.map((x) => {
    const b = mb.get(x.item_id);
    return { ...x, campanhas: [...x.campanhas].map((id) => nomes[id] || String(id)), vendas: r2(x.vendas), direta: r2(x.direta), investimento: r2(x.investimento),
      roas: x.investimento > 0 ? x.vendas / x.investimento : null, participacao: total > 0 ? x.vendas / total : 0,
      antes: b ? { vendas: r2(b.vendas), unidades: b.unidades } : { vendas: 0, unidades: 0 },
      variacao: b && b.vendas > 0 ? x.vendas / b.vendas - 1 : null };
  }).sort((a, b) => b.vendas - a.vendas || b.unidades - a.unidades);
  return { anuncios, total: { anuncios: anuncios.length, vendas: r2(total), unidades: anuncios.reduce((s, x) => s + x.unidades, 0),
    investimento: r2(anuncios.reduce((s, x) => s + x.investimento, 0)), vendas_antes: r2(totalAntes),
    variacao: totalAntes > 0 ? total / totalAntes - 1 : null } };
}
// Período de mesmo tamanho logo antes de { date_from, date_to } (AAAA-MM-DD). Função pura: testada.
function janelaAnterior({ date_from, date_to }) {
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  const de = Date.parse(date_from + 'T12:00:00Z'), ate = Date.parse(date_to + 'T12:00:00Z');
  const n = Math.round((ate - de) / 864e5) + 1;
  return { date_from: d(de - n * 864e5), date_to: d(de - 864e5) };
}

// Antes e depois (tela Publicidade, campanha escolhida): N dias antes da data e N dias a partir dela (até ontem, o último dia
// que o ML fechou). Devolve as janelas em dia de Brasília. Função pura: testada.
function janelasAntesDepois(data, dias, hojeMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) throw erro('Escolha a data (AAAA-MM-DD).');
  if (![7, 14, 21, 30].includes(Number(dias))) throw erro('Período: 7, 14, 21 ou 30 dias.');
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  const base = Date.parse(data + 'T12:00:00Z');
  const ontem = d(hojeMs - 3 * 3600e3 - 864e5);
  if (data > ontem) throw erro('A data precisa ser até ontem (o Mercado Livre fecha o dia anterior às 10h).');
  if (base - dias * 864e5 < hojeMs - 89 * 864e5) throw erro('O Mercado Ads guarda só 90 dias: escolha uma data mais recente ou um período menor.');
  const antes = { de: d(base - dias * 864e5), ate: d(base - 864e5) };
  const fimDepois = d(base + (dias - 1) * 864e5);
  const depois = { de: data, ate: fimDepois < ontem ? fimDepois : ontem };
  depois.dias = Math.round((Date.parse(depois.ate) - Date.parse(depois.de)) / 864e5) + 1;
  antes.dias = Number(dias);
  return { antes, depois };
}
// Junta, por grupo de anúncio, o Ads de cada janela (agruparAnuncios) e as vendas do produto (linhas de vendasDaConta,
// com data, item_id, quantidade, faturamento, lucro). A venda total conta TODAS as vendas dos anúncios do grupo, com e sem
// Ads. Função pura: testada.
function somarAntesDepois(gruposAntes, gruposDepois, linhas, jan) {
  const diaBR = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
  const vazio = () => ({ unidades: 0, faturamento: 0, lucro: 0, sem_lucro: false, ads_inv: 0, ads_rec: 0, ads_un: 0, pedidos: new Map() });
  const grupos = new Map();
  const pegar = (g) => {
    const k = String(g.ad_group_id ?? g.itens?.[0]?.item_id);
    if (!grupos.has(k)) grupos.set(k, { ad_group_id: g.ad_group_id, titulo: g.titulo, status: g.status, itens: new Set(), antes: vazio(), depois: vazio() });
    const x = grupos.get(k);
    for (const i of g.itens || []) x.itens.add(i.item_id);
    return x;
  };
  for (const [lado, lista] of [['antes', gruposAntes], ['depois', gruposDepois]]) {
    for (const g of lista || []) { const x = pegar(g); x[lado].ads_inv += g.investimento || 0; x[lado].ads_rec += g.receita || 0; x[lado].ads_un += g.unidades || 0; }
  }
  const doItem = new Map();
  for (const x of grupos.values()) for (const i of x.itens) doItem.set(i, x);
  for (const l of linhas || []) {
    if (!l.valida) continue;
    const x = doItem.get(l.item_id); if (!x) continue;
    const dia = diaBR(l.data);
    const lado = dia >= jan.antes.de && dia <= jan.antes.ate ? 'antes' : dia >= jan.depois.de && dia <= jan.depois.ate ? 'depois' : null;
    if (!lado) continue;
    const a = x[lado];
    a.unidades += l.quantidade || 0; a.faturamento += l.faturamento || 0;
    if (l.lucro == null) a.sem_lucro = true; else a.lucro += l.lucro;
    const p = a.pedidos.get(l.pedido) || { pedido: l.pedido, unidades: 0, faturamento: 0, lucro: 0 };
    p.unidades += l.quantidade || 0; p.faturamento += l.faturamento || 0; p.lucro += l.lucro || 0;
    a.pedidos.set(l.pedido, p);
  }
  // Pedido grande: UM pedido com 3+ unidades e mais da metade das unidades do período (medido 16/10/2026: 7 braços de teto
  // num pedido só fizeram o Portfólio 01 parecer cair 35 -> 29 un). Ele distorce a comparação; o total sem ele vem junto.
  const grandeDe = (a) => { let m = null; for (const p of a.pedidos.values()) if (!m || p.unidades > m.unidades) m = p;
    return m && m.unidades >= 3 && m.unidades > a.unidades / 2 ? m : null; };
  const fim = (a, dias, grande = grandeDe(a)) => ({ unidades: a.unidades, faturamento: r2(a.faturamento), lucro: a.sem_lucro ? null : r2(a.lucro),
    pedido_grande: grande ? { pedido: grande.pedido, unidades: grande.unidades, faturamento: r2(grande.faturamento) } : null,
    ads_inv: r2(a.ads_inv), ads_rec: r2(a.ads_rec), ads_un: a.ads_un, lucro_depois_ads: a.sem_lucro ? null : r2(a.lucro - a.ads_inv),
    por_dia: { unidades: a.unidades / dias, faturamento: r2(a.faturamento / dias) } });
  const lista = [...grupos.values()].map((x) => ({ ad_group_id: x.ad_group_id, titulo: x.titulo, status: x.status, itens: [...x.itens],
    antes: fim(x.antes, jan.antes.dias), depois: fim(x.depois, jan.depois.dias) }))
    .filter((x) => x.antes.unidades || x.depois.unidades || x.antes.ads_inv || x.depois.ads_inv)
    .sort((a, b) => (b.depois.faturamento + b.antes.faturamento) - (a.depois.faturamento + a.antes.faturamento));
  // total da campanha; sem_grandes = o mesmo tirando os pedidos grandes de cada anúncio
  const total = (lado, dias, tirar) => { const t = vazio(); for (const x of grupos.values()) { const a = x[lado], g = tirar ? grandeDe(a) : null;
    for (const k of ['unidades', 'faturamento', 'lucro', 'ads_inv', 'ads_rec', 'ads_un']) t[k] += a[k];
    if (g) { t.unidades -= g.unidades; t.faturamento -= g.faturamento; t.lucro -= g.lucro; }
    t.sem_lucro ||= a.sem_lucro; } return fim(t, dias, null); };
  const grandes = lista.flatMap((x) => ['antes', 'depois'].filter((l) => x[l].pedido_grande).map((l) => ({ lado: l, titulo: x.titulo, ...x[l].pedido_grande })));
  return { total: { antes: total('antes', jan.antes.dias), depois: total('depois', jan.depois.dias) },
    sem_grandes: grandes.length ? { antes: total('antes', jan.antes.dias, true), depois: total('depois', jan.depois.dias, true) } : null,
    pedidos_grandes: grandes, grupos: lista };
}

// Leilão de uma campanha (detalhe da campanha com as métricas de exposição, só lá existem — referência medida em 25/07/2026):
// aparece = impression_share; perde por verba / por posição (somam 1 com o aparece); acos_benchmark = ACOS de quem vai bem
// na mesma disputa. Leitura em palavras para o vendedor (não é ação: o Ads da AMG é da agência). Função pura: testada.
function leilaoDe(m = {}) {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const aparece = num(m.impression_share), verba = num(m.lost_impression_share_by_budget), posicao = num(m.lost_impression_share_by_ad_rank);
  const inv = num(m.cost) || 0, rec = num(m.total_amount) || 0;
  const acos = rec > 0 ? inv / rec * 100 : null;
  const bench = num(m.acos_benchmark);
  let leitura = null;
  if (aparece == null) leitura = 'sem dado de leilão no período';
  else if (verba != null && verba >= 0.15 && verba >= (posicao || 0)) leitura = 'perde exposição por VERBA: o orçamento acaba antes do dia';
  else if (posicao != null && posicao >= 0.15) leitura = 'perde exposição por POSIÇÃO: lance baixo para o ROAS pedido ou anúncio menos competitivo';
  else leitura = 'aparece em quase todas as buscas que pode';
  return { aparece, perde_verba: verba, perde_posicao: posicao, topo: num(m.top_impression_share), acos: acos == null ? null : r2(acos),
    acos_referencia: bench, roas_referencia: bench > 0 ? r2(100 / bench) : null, investimento: r2(inv), receita: r2(rec), leitura };
}

function criar({ ml, contaOuErro, anunciante, siteAtivo, janelaAds, D, vendasDaConta, aposEscrever = () => {} }) {
  const V2 = { 'api-version': '2' };
  const ler = (caminho) => ml(caminho, { headers: V2 });
  // escrita: /advertising/… e, se o ML disser que o caminho não existe, /marketplace/advertising/…
  async function escrever(caminho, metodo, corpo) {
    const opts = { method: metodo, headers: V2, body: JSON.stringify(corpo) };
    try { return await ml('/advertising' + caminho, opts); }
    catch (e) { if (e.status !== 404) throw e; return ml('/marketplace/advertising' + caminho, opts); }
  }
  async function exigeAnunciante() {
    contaOuErro();
    const adv = await anunciante();
    if (!adv) throw erro('Esta conta não tem anunciante no Mercado Ads (ative a publicidade no Mercado Livre).', 409);
    return adv;
  }
  const site = () => siteAtivo();
  const idCampanha = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw erro('Campanha inválida.'); return n; };

  // ads/search paginado (50 por página; teto alto: a conta tem ~2.000 linhas).
  // dias: número (os últimos N dias até ontem) ou { date_from, date_to } (AAAA-MM-DD)
  async function anunciosAds(adv, filtros = {}, dias = 30, teto = 60) {
    const { date_from, date_to } = typeof dias === 'object' ? dias : janelaAds(dias);
    const tudo = [];
    for (let p = 0; p < teto; p++) {
      const qs = new URLSearchParams({ ...filtros, date_from, date_to, metrics: METRICAS, limit: '50', offset: String(p * 50) });
      const r = await ler(`/advertising/${site()}/advertisers/${adv.advertiser_id}/product_ads/ads/search?${qs}`);
      const lote = r.results || [];
      tudo.push(...lote);
      if (lote.length < 50) break;
    }
    return tudo;
  }
  async function campanhas(adv) {
    const out = [];
    for (let p = 0; p < 20; p++) {
      const r = await ler(`/advertising/${site()}/advertisers/${adv.advertiser_id}/product_ads/campaigns/search?limit=50&offset=${p * 50}`);
      out.push(...(r.results || []));
      if ((r.results || []).length < 50) break;
    }
    return out;
  }
  // Os anúncios de UMA campanha (o filtro é conferido: linha de outra campanha fica de fora).
  async function anunciosDaCampanha(adv, id, dias = 30) {
    const linhas = (await anunciosAds(adv, { 'filters[campaign_id]': String(id) }, dias)).filter((a) => Number(a.campaign_id) === id);
    return agruparAnuncios(linhas);
  }

  // Todos os anúncios do anunciante (para escolher quais colocar): guardado 10 min por conta.
  let cacheTodos = null, cacheLeilao = null;
  const cacheVendas = new Map();   // anúncios que venderam pelo Ads: conta|dias|campanha -> 10 min
  async function todosAnuncios(adv, recarregar) {
    const conta = contaOuErro().ml_user_id;
    if (!recarregar && cacheTodos?.conta === conta && Date.now() - cacheTodos.em < 10 * 60e3) return cacheTodos.dados;
    const [linhas, camps] = await Promise.all([anunciosAds(adv, {}, 30), campanhas(adv)]);
    const nomes = Object.fromEntries(camps.map((c) => [c.id, c.name]));
    const dados = agruparAnuncios(linhas).map((g) => ({ ...g, campanha: g.campanha_id ? nomes[g.campanha_id] || String(g.campanha_id) : null }));
    cacheTodos = { conta, em: Date.now(), dados };
    return dados;
  }

  function registrar(id, nome, campo, grupos, rotulos) {
    try {
      const conta = contaOuErro().ml_user_id;
      const txt = `${grupos.length} anúncio(s)` + (rotulos?.length ? ': ' + rotulos.slice(0, 5).join('; ') + (rotulos.length > 5 ? '…' : '') : '');
      D.adsMudancaGravar(conta, { campanha_id: id, campanha: nome || null, campo, de: null, para: txt.slice(0, 300) });
    } catch { /* o registro não pode derrubar a escrita que já aconteceu */ }
  }
  const depois = () => { cacheTodos = null; aposEscrever(); };

  const rotas = {
    // Diagnóstico (só leitura, sem valores de dinheiro): os caminhos e filtros respondem nesta conta?
    // Leilão das campanhas (30 dias): uma chamada por campanha ativa, guardada 30 min por conta.
    'GET /api/ads/campanhas/leilao': async (url) => {
      const adv = await exigeAnunciante();
      const conta = contaOuErro().ml_user_id;
      if (cacheLeilao?.conta === conta && Date.now() - cacheLeilao.em < 30 * 60e3 && url?.searchParams.get('recarregar') !== '1') return cacheLeilao.dados;
      const { date_from, date_to } = janelaAds(30);
      const metrics = 'cost,total_amount,impression_share,top_impression_share,lost_impression_share_by_budget,lost_impression_share_by_ad_rank,acos_benchmark';
      const camps = (await campanhas(adv)).filter((c) => c.status === 'active');
      const lista = [];
      for (let i = 0; i < camps.length; i += 4) {
        lista.push(...await Promise.all(camps.slice(i, i + 4).map(async (c) => {
          try {
            const r = await ler(`/advertising/${site()}/product_ads/campaigns/${c.id}?${new URLSearchParams({ date_from, date_to, metrics })}`);
            return { id: c.id, nome: c.name, roas_alvo: c.roas_target ?? null, orcamento: c.budget ?? null, ...leilaoDe(r.metrics || r) };
          } catch (e) { return { id: c.id, nome: c.name, erro: e.message }; }
        })));
      }
      const dados = { date_from, date_to, campanhas: lista.sort((a, b) => (b.investimento || 0) - (a.investimento || 0)) };
      cacheLeilao = { conta, em: Date.now(), dados };
      return dados;
    },

    // Anúncios que venderam pelo ADS no período (e o período anterior, para a variação). ?dias=7|15|30|60|90&campanha=
    'GET /api/ads/anuncios-vendas': async (url) => {
      const adv = await exigeAnunciante();
      const conta = contaOuErro().ml_user_id;
      const dias = [7, 15, 30, 60, 90].includes(Number(url?.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30;
      const campanha = /^\d+$/.test(url?.searchParams.get('campanha') || '') ? Number(url.searchParams.get('campanha')) : null;
      const chave = `${conta}|${dias}|${campanha || ''}`;
      const g = cacheVendas.get(chave);
      if (g && Date.now() - g.em < 10 * 60e3 && url?.searchParams.get('recarregar') !== '1') return g.dados;
      const jan = janelaAds(dias), ant = janelaAnterior(jan);
      const filtro = campanha ? { 'filters[campaign_id]': String(campanha) } : {};
      const so = (ls) => (campanha ? ls.filter((a) => Number(a.campaign_id) === campanha) : ls);
      // o ML guarda 90 dias: no período de 90 o anterior não existe
      const [la, lb, camps] = await Promise.all([anunciosAds(adv, filtro, jan),
        dias < 90 ? anunciosAds(adv, filtro, ant).catch(() => null) : Promise.resolve(null), campanhas(adv)]);
      const nomes = Object.fromEntries(camps.map((c) => [c.id, c.name]));
      const r = vendasPorAnuncio(so(la), lb ? so(lb) : [], nomes);
      const dados = { dias, campanha, date_from: jan.date_from, date_to: jan.date_to, anterior: lb ? ant : null,
        total: lb ? r.total : { ...r.total, vendas_antes: null, variacao: null },
        anuncios: lb ? r.anuncios : r.anuncios.map((x) => ({ ...x, antes: null, variacao: null })),
        nota: 'Vendas atribuídas ao ADS pelo Mercado Livre: direta (comprou o anúncio clicado) + indireta (comprou outro anúncio seu depois do clique). O ML fecha o dia anterior às 10h.' };
      cacheVendas.set(chave, { em: Date.now(), dados });
      return dados;
    },

    'GET /api/ads/gestao/diagnostico': async () => {
      const adv = await exigeAnunciante();
      const camps = await campanhas(adv);
      const alvo = camps.find((c) => c.status === 'active') || camps[0];
      const out = { anunciante: !!adv, campanhas: camps.length };
      const teste = async (nome, fn) => { try { out[nome] = await fn(); } catch (e) { out[nome] = { erro: e.message, status: e.status || null }; } };
      if (alvo) {
        await teste('ads_por_campanha', async () => {
          const r = await ler(`/advertising/${site()}/advertisers/${adv.advertiser_id}/product_ads/ads/search?filters[campaign_id]=${alvo.id}&limit=50`);
          const ls = r.results || [];
          return { total: r.paging?.total ?? null, linhas: ls.length, so_da_campanha: ls.every((a) => Number(a.campaign_id) === Number(alvo.id)),
            com_ad_group: ls.filter((a) => a.ad_group_id).length, campos: Object.keys(ls[0] || {}).sort() };
        });
      }
      await teste('ad_groups', async () => {
        const r = await ler(`/advertising/${site()}/advertisers/${adv.advertiser_id}/product_ads/ad_groups/search?limit=5`);
        return { total: r.paging?.total ?? null, tipos: [...new Set((r.results || []).map((g) => g.ad_group_type))], campos: Object.keys(r.results?.[0] || {}).sort() };
      });
      return out;
    },

    // Todos os anúncios do Ads (para colocar numa campanha): busca por título ou MLB; mostra a campanha atual de cada um.
    'GET /api/ads/gestao/anuncios': async (url) => {
      const adv = await exigeAnunciante();
      const lista = await todosAnuncios(adv, url.searchParams.get('recarregar') === '1');
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const fora = url.searchParams.get('fora');   // campanha que está sendo montada: os dela saem da lista
      const filtrados = lista.filter((g) => (!fora || String(g.campanha_id) !== fora)
        && (!q || String(g.titulo || '').toLowerCase().includes(q) || g.itens.some((i) => String(i.item_id).toLowerCase() === q || String(i.titulo || '').toLowerCase().includes(q))));
      if (url.searchParams.get('sem_campanha') === '1') filtrados.splice(0, filtrados.length, ...filtrados.filter((g) => !g.campanha_id));
      filtrados.sort((a, b) => (b.recomendado - a.recomendado) || (b.receita - a.receita) || String(a.titulo).localeCompare(String(b.titulo)));
      return { total: filtrados.length, anuncios: filtrados.slice(0, 300) };
    },

    // Criar campanha.
    'POST /api/ads/campanhas': async (_u, body) => {
      const adv = await exigeAnunciante();
      const corpo = campanhaDoCorpo(body, { nova: true });
      const c = await escrever(`/${site()}/advertisers/${adv.advertiser_id}/product_ads/campaigns`, 'POST', corpo);
      depois();
      return { campanha: { id: c?.id ?? null, nome: c?.name ?? corpo.name, status: c?.status ?? corpo.status, orcamento: c?.budget ?? corpo.budget,
        roas_alvo: c?.roas_target ?? corpo.roas_target, estrategia: c?.strategy ?? corpo.strategy } };
    },
  };

  const rotasParam = [
    // Antes e depois de uma data (a de uma mudança): venda total dos anúncios da campanha (com e sem Ads), lucro, e o Ads.
    { m: 'GET', re: /^\/api\/ads\/campanhas\/(\d+)\/antes-depois$/, fn: async ([id], _b, url) => {
      const adv = await exigeAnunciante();
      const conta = contaOuErro();
      const campanha = idCampanha(id);
      const jan = janelasAntesDepois(url?.searchParams.get('data'), Number(url?.searchParams.get('dias') || 14));
      const filtro = { 'filters[campaign_id]': String(campanha) };
      const so = (ls) => ls.filter((a) => Number(a.campaign_id) === campanha);
      const [la, ld] = await Promise.all([
        anunciosAds(adv, filtro, { date_from: jan.antes.de, date_to: jan.antes.ate }),
        anunciosAds(adv, filtro, { date_from: jan.depois.de, date_to: jan.depois.ate })]);
      const de = new Date(`${jan.antes.de}T03:00:00.000Z`).toISOString();
      const ate = new Date(Date.parse(`${jan.depois.ate}T03:00:00.000Z`) + 864e5).toISOString();
      const v = await vendasDaConta(conta, { dias: Math.ceil((Date.parse(ate) - Date.parse(de)) / 864e5), de, ate }, { titulos: false });
      return { campanha_id: campanha, janelas: jan, ...somarAntesDepois(agruparAnuncios(so(la)), agruparAnuncios(so(ld)), v.vendas, jan) };
    } },

    // Os anúncios de uma campanha, com os números dos últimos `dias`.
    { m: 'GET', re: /^\/api\/ads\/campanhas\/(\d+)\/anuncios$/, fn: async ([id], _b, url) => {
      const adv = await exigeAnunciante();
      const dias = [7, 15, 30, 60, 90].includes(Number(url?.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30;
      const grupos = await anunciosDaCampanha(adv, idCampanha(id), dias);
      grupos.sort((a, b) => (b.investimento - a.investimento) || String(a.titulo).localeCompare(String(b.titulo)));
      return { campanha_id: Number(id), dias, total: grupos.length, anuncios: grupos };
    } },

    // Editar campanha: nome, situação, orçamento, estratégia e ROAS objetivo (só o que mudou).
    { m: 'PUT', re: /^\/api\/ads\/campanhas\/(\d+)$/, fn: async ([id], body) => {
      await exigeAnunciante();
      const corpo = campanhaDoCorpo(body, { nova: false });
      const c = await escrever(`/${site()}/product_ads/campaigns/${idCampanha(id)}`, 'PUT', corpo);
      depois();
      return { campanha: { id: Number(id), nome: c?.name ?? null, status: c?.status ?? null, orcamento: c?.budget ?? null,
        roas_alvo: c?.roas_target ?? null, estrategia: c?.strategy ?? null }, enviado: corpo };
    } },

    // Colocar na campanha (ou mover de outra), pausar ou reativar: { ad_groups:[…], status: active|paused }.
    // Confere relendo a campanha: diz quais grupos ficaram como pedido.
    { m: 'POST', re: /^\/api\/ads\/campanhas\/(\d+)\/anuncios$/, fn: async ([id], body) => {
      const adv = await exigeAnunciante();
      const campanha = idCampanha(id);
      const grupos = gruposDoCorpo(body?.ad_groups);
      const status = body?.status === 'paused' ? 'paused' : 'active';
      for (let i = 0; i < grupos.length; i += 100) {
        await escrever(`/${site()}/advertisers/${adv.advertiser_id}/product_ads/ad_groups`, 'PUT',
          { ad_groups: grupos.slice(i, i + 100), status, campaign_id: campanha });
      }
      depois();
      const agora = await anunciosDaCampanha(adv, campanha, 7).catch(() => null);
      const ok = agora ? grupos.filter((g) => agora.some((x) => Number(x.ad_group_id) === g && (status === 'paused' ? x.status !== 'active' : x.status === 'active'))) : null;
      registrar(campanha, body?.campanha_nome, status === 'paused' ? 'anuncios_pausados' : body?.mover ? 'anuncios_movidos' : 'anuncios_entraram',
        grupos, Array.isArray(body?.titulos) ? body.titulos.map(String) : null);
      return { campanha_id: campanha, status, pedidos: grupos.length, confirmados: ok ? ok.length : null,
        pendentes: ok ? grupos.filter((g) => !ok.includes(g)) : null,
        aviso: ok && ok.length < grupos.length ? 'O Mercado Livre aceitou, mas parte ainda não aparece na campanha: ele pode levar alguns minutos.' : null };
    } },

    // Tirar da campanha: { ad_groups:[…] }. O anúncio fica fora de qualquer campanha (sem gasto).
    { m: 'POST', re: /^\/api\/ads\/campanhas\/(\d+)\/remover$/, fn: async ([id], body) => {
      const adv = await exigeAnunciante();
      const campanha = idCampanha(id);
      const grupos = gruposDoCorpo(body?.ad_groups);
      for (let i = 0; i < grupos.length; i += 100) {
        await escrever(`/${site()}/product_ads/campaigns/${campanha}/ad_groups`, 'DELETE', { ad_groups: grupos.slice(i, i + 100) });
      }
      depois();
      const agora = await anunciosDaCampanha(adv, campanha, 7).catch(() => null);
      const ainda = agora ? grupos.filter((g) => agora.some((x) => Number(x.ad_group_id) === g && x.status === 'active')) : null;
      registrar(campanha, body?.campanha_nome, 'anuncios_sairam', grupos, Array.isArray(body?.titulos) ? body.titulos.map(String) : null);
      return { campanha_id: campanha, pedidos: grupos.length, ainda_na_campanha: ainda,
        aviso: ainda?.length ? 'O Mercado Livre aceitou, mas parte ainda aparece ativa na campanha: ele pode levar alguns minutos.' : null };
    } },
  ];

  return { rotas, rotasParam };
}

module.exports = { criar, leilaoDe, campanhaDoCorpo, gruposDoCorpo, agruparAnuncios, janelasAntesDepois, somarAntesDepois, vendasPorAnuncio, janelaAnterior };
