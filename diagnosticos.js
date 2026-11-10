// Diagnósticos SÓ LEITURA da Fase 2 da auditoria técnica (Central de Inteligência AMG, aprovados pelo dono em 10/11/2026).
// Rotas GET em /api/diagnostico/* — fora de todo módulo de usuário (usuarios.js#permitido), então só o ADMINISTRADOR abre.
// Nada aqui grava, lança estoque, muda preço ou chama escrita em loja. Fora do MCP (tem Amazon e Magalu).
//   - composicao-estoque: estoque.js#diagnosticoComposicao (baixa em produto que a composição de hoje não tem)
//   - amazon-frete: frete, etiqueta e médias por SKU — SÓ AGREGADO (nunca pedido, compromisso com a Amazon)
//   - ads-ml: gasto do Ads por campanha nas duas fontes (anúncios × campanhas) da conta escolhida
//   - magalu-frete: tipos de lançamento da análise financeira das vendas com frete 0 (sem dado de comprador)
const A = require('./amazon.js');
const M = require('./magalu.js');
const P = require('./painel.js');
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Amazon: por SKU, as vendas lançadas (com e sem etiqueta juntada), o frete, a média que anúncios e calculadora usam
// (mediaSku) e quantos pedidos da cópia de pedidos já têm lançamento. Só contagens e somas: nenhum pedido sai daqui.
// lancs: amazon_lancamentos; pedidos: [{ sku, canal, pedido, status }] (amazon_pedidos + itens). Função pura: testada.
function amazonFretePorSku(lancs, pedidos = [], { sku = null } = {}) {
  const comEt = A.comEtiquetas(lancs);
  const taxas = A.taxasDosLancamentos(lancs);
  const vendasPorPedido = new Set(lancs.filter((l) => l.tipo === 'venda' && l.pedido).map((l) => l.pedido));
  const etiquetas = lancs.filter((l) => l.tipo === 'etiqueta');
  const m = new Map();
  const base = (s) => ({ sku: s, lancamentos_venda: 0, unidades: 0, receita: 0, tarifa: 0, frete: 0, por_canal: {},
    com_etiqueta: 0, sem_etiqueta_proprio: 0, etiqueta_total: 0, pedidos_copia: 0, pedidos_com_lancamento: 0 });
  for (const l of comEt) {
    if (l.tipo !== 'venda' || (sku && l.sku !== sku)) continue;
    const x = m.get(l.sku || '') || base(l.sku || null);
    x.lancamentos_venda++; x.unidades += l.quantidade || 0; x.receita += l.receita || 0; x.tarifa += l.tarifa || 0; x.frete += l.frete || 0;
    x.por_canal[l.canal || '?'] = (x.por_canal[l.canal || '?'] || 0) + 1;
    if (l.etiqueta > 0) { x.com_etiqueta++; x.etiqueta_total += l.etiqueta; } else if (l.canal === 'proprio') x.sem_etiqueta_proprio++;
    m.set(l.sku || '', x);
  }
  for (const p of pedidos) {
    if (!p.sku || (sku && p.sku !== sku) || p.status === 'Canceled') continue;
    const x = m.get(p.sku) || base(p.sku);
    x.pedidos_copia++; if (vendasPorPedido.has(p.pedido)) x.pedidos_com_lancamento++;
    m.set(p.sku, x);
  }
  const media = (s, c) => { const v = taxas.mediaSku(s, c); return v ? { tarifa_pct: r2(v.tarifa_pct * 100), fixa_un: r2(v.fixa_un), frete_un: r2(v.frete_un) } : null; };
  const skus = [...m.values()].map((x) => ({ ...x, receita: r2(x.receita), tarifa: r2(x.tarifa), frete: r2(x.frete), etiqueta_total: r2(x.etiqueta_total),
    media_proprio: media(x.sku, 'proprio'), media_fba: media(x.sku, 'FBA'),
    suspeito: x.lancamentos_venda > 0 && x.por_canal.proprio > 0 && x.com_etiqueta === 0 }))
    .sort((a, b) => b.receita - a.receita);
  const pedidosComEtiqueta = new Set(etiquetas.map((e) => e.pedido).filter(Boolean));
  return {
    resumo: { skus: skus.length, skus_proprio_sem_nenhuma_etiqueta: skus.filter((x) => x.suspeito).length,
      etiquetas: etiquetas.length, etiquetas_sem_venda_lancada: [...pedidosComEtiqueta].filter((p) => !vendasPorPedido.has(p)).length,
      etiquetas_sem_pedido: etiquetas.filter((e) => !e.pedido).length,
      media_canal_proprio: (() => { const v = taxas.mediaCanal('proprio'); return v ? { tarifa_pct: r2(v.tarifa_pct * 100), frete_un: r2(v.frete_un) } : null; })() },
    skus,
  };
}

// Ads do ML: por campanha, a soma do custo nas linhas de anúncio (product_ads/ads/search, a fonte do ABC) — bruta e sem
// as linhas repetidas da paginação (a mesma chave de painel.js#gastoAdsPorItem) — contra o investimento da campanha
// (product_ads/campaigns/search, a fonte do Histórico ADS). Função pura: testada.
function adsComparacao(linhasAnuncios, campanhas) {
  const porCamp = new Map(), vistos = new Set(), itemCamps = new Map();
  for (const a of linhasAnuncios || []) {
    const c = String(a.campaign_id ?? '');
    const x = porCamp.get(c) || { linhas: 0, repetidas: 0, sem_item: 0, bruto: 0, sem_repeticao: 0, itens: new Set() };
    const custo = Number(a.metrics?.cost) || 0;
    x.linhas++; x.bruto += custo;
    if (!a.item_id) x.sem_item++;
    const k = `${a.item_id}|${a.ad_group_id ?? ''}|${a.campaign_id ?? ''}`;
    if (vistos.has(k)) x.repetidas++;
    else { vistos.add(k); if (a.item_id) { x.sem_repeticao += custo; x.itens.add(a.item_id); } }
    if (a.item_id) { const s = itemCamps.get(a.item_id) || new Set(); s.add(c); itemCamps.set(a.item_id, s); }
    porCamp.set(c, x);
  }
  const hist = new Map((campanhas || []).map((c) => [String(c.id), c]));
  const ids = new Set([...porCamp.keys(), ...hist.keys()]);
  const linhas = [...ids].map((id) => {
    const x = porCamp.get(id), h = hist.get(id);
    const anuncios = x ? r2(x.sem_repeticao) : 0, campanha = h ? r2(h.investimento) : null;
    return { campanha_id: id || null, nome: h?.nome || null, status: h?.status || null, linhas_anuncio: x?.linhas || 0, repetidas: x?.repetidas || 0,
      anuncios_bruto: x ? r2(x.bruto) : 0, anuncios: anuncios, campanha, diferenca: campanha == null ? null : r2(anuncios - campanha),
      itens: x ? x.itens.size : 0, so_numa_fonte: !x ? 'campanhas' : !h ? 'anuncios' : null };
  }).sort((a, b) => Math.abs(b.diferenca ?? b.anuncios) - Math.abs(a.diferenca ?? a.anuncios));
  const soma = (k) => r2(linhas.reduce((s, l) => s + (Number(l[k]) || 0), 0));
  const abc = r2(Object.values(P.gastoAdsPorItem(linhasAnuncios)).reduce((s, v) => s + v, 0));
  return { totais: { anuncios_bruto: soma('anuncios_bruto'), anuncios: soma('anuncios'), abc, campanhas: soma('campanha'),
    linhas_repetidas: soma('repetidas'), itens_em_2_ou_mais_campanhas: [...itemCamps.values()].filter((s) => s.size > 1).length }, campanhas: linhas };
}

// Magalu: vendas válidas COM análise financeira e frete 0 — os tipos de lançamento (categoria/subcategoria, sem descrição,
// que pode trazer texto livre) de cada uma, e o resumo dos tipos contra as vendas com frete > 0. Só o código do pedido da
// Magalu e o SKU: nada do comprador. pedidos: magalu_pedidos (pedidoDe); fin: Map code -> transações. Função pura: testada.
function magaluFreteZero(pedidos, fin) {
  const tipos = (ts) => [...new Set(ts.filter((t) => t.status !== 'not_applicable').map((t) => `${t.tipo}:${t.cat}${t.sub ? '/' + t.sub : ''}`))].sort();
  const zero = [], conta = { zero: new Map(), com_frete: new Map() };
  let comFrete = 0;
  for (const p of pedidos) {
    if (['cancelled', 'canceled'].includes(String(p.status).toLowerCase())) continue;
    const ts = fin.get(p.code);
    if (!ts) continue;
    const f = M.financeiroDo(ts);
    const lista = tipos(ts);
    const alvo = f.freteCusto > 0 ? conta.com_frete : conta.zero;
    for (const t of lista) alvo.set(t, (alvo.get(t) || 0) + 1);
    if (f.freteCusto > 0) { comFrete++; continue; }
    const fat = (p.itens || []).reduce((s, i) => s + (Number(i.faturamento) || 0), 0);
    zero.push({ pedido: p.code, data: p.data, status: p.status, skus: (p.itens || []).map((i) => i.sku).filter(Boolean), faturamento: r2(fat),
      frete_cliente: r2(p.frete_cliente), entregue: !!p.entregue, recebido: f.recebido, tipos: lista,
      tem_shipping: ts.some((t) => /SHIPPING/i.test(`${t.cat} ${t.sub}`)) });
  }
  const tabela = (m, total) => [...m].map(([tipo, n]) => ({ tipo, pedidos: n, pct: total ? r2(n / total * 100) : 0 })).sort((a, b) => b.pedidos - a.pedidos);
  return { resumo: { com_frete_zero: zero.length, com_frete: comFrete }, frete_zero: zero.sort((a, b) => String(b.data).localeCompare(String(a.data))),
    tipos_frete_zero: tabela(conta.zero, zero.length), tipos_com_frete: tabela(conta.com_frete, comFrete) };
}

// deps: D, routes, CTX, adsDaJanela(conta, de, ate), contaDoId(id), estoque() -> estoqueMod
function criar({ D, routes, CTX, adsDaJanela, estoque }) {
  const diasDe = (url, ok, padrao) => { const d = Number(url.searchParams.get('dias')); return ok.includes(d) ? d : padrao; };
  const rotas = {
    'GET /api/diagnostico/composicao-estoque': async () => estoque().diagnosticoComposicao(),

    'GET /api/diagnostico/amazon-frete': async (url) => {
      const dias = diasDe(url, [30, 60, 92], 92);
      const sku = (url.searchParams.get('sku') || '').trim() || null;
      if (sku && sku.length > 80) throw erro('SKU inválido.');
      const de = new Date(Date.now() - dias * 864e5).toISOString();
      const lancs = D.amazonLancPeriodo(de, '9999');
      const pedidos = D.db.prepare(`SELECT p.pedido, p.status, p.canal, i.sku FROM amazon_pedidos p JOIN amazon_itens i ON i.pedido = p.pedido
        WHERE p.data >= ?`).all(de);
      return { dias, de, sku, ...amazonFretePorSku(lancs, pedidos, { sku }),
        nota: 'Só agregado por SKU (nenhum pedido). suspeito = vende pelo envio próprio e nenhuma venda lançada tem etiqueta juntada: a média do SKU (anúncios, calculadora) fica com frete 0.' };
    },

    'GET /api/diagnostico/ads-ml': async (url) => {
      const id = Number(url.searchParams.get('conta'));
      const conta = D.contasListar().find((c) => c.ml_user_id === id);
      if (!conta) throw erro('Escolha uma conta do ML conectada (?conta=).');
      const dias = diasDe(url, [7, 15, 30, 60, 90], 30);
      return CTX.comConta(id, async () => {
        const h = await routes['GET /api/ads/historico'](new URL(`/api/ads/historico?dias=${dias}`, 'http://painel'));
        if (!h?.habilitado) return { conta: id, dias, habilitado: false, motivo: h?.motivo || null };
        // janela do ABC (painel.js#abc): os últimos dias até ontem em Brasília
        const ate = new Date(Date.now() - 3 * 3600e3 - 864e5).toISOString().slice(0, 10);
        const de = new Date(Date.parse(ate + 'T12:00:00Z') - (dias - 1) * 864e5).toISOString().slice(0, 10);
        const j = await adsDaJanela(D.contaObter(id), de, ate);
        if (!j?.linhas) return { conta: id, dias, habilitado: true, motivo: j?.motivo || 'sem linhas de anúncio' };
        const comp = adsComparacao(j.linhas, h.campanhas);
        return { conta: id, dias, janelas: { campanhas: { de: h.date_from, ate: h.date_to }, anuncios: { de: j.de, ate: j.ate } },
          historico_total: h.total?.investimento ?? null, ...comp,
          nota: 'anuncios = product_ads/ads/search (fonte do ABC), sem linhas repetidas; campanha = product_ads/campaigns/search (fonte do Histórico ADS). Datas diferentes nas duas janelas também mudam o total.' };
      });
    },

    'GET /api/diagnostico/magalu-frete': async (url) => {
      const dias = diasDe(url, [30, 60, 90], 30);
      const de = new Date(Date.now() - dias * 864e5).toISOString();
      const pedidos = D.magaluPedidosPeriodo(de, '9999');
      const fin = D.magaluFinanceiroDe(pedidos.map((p) => p.code));
      return { dias, de, ...magaluFreteZero(pedidos, fin), nota: 'Só código do pedido da Magalu, SKU e valores: nada do comprador.' };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, amazonFretePorSku, adsComparacao, magaluFreteZero };
