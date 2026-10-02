'use strict';
// Ads da Shopee (tela public/shopee-ads.html, ?conta=shopee-{loja}): saldo e o desempenho
// diário de todos os anúncios pagos da loja (get_all_cpc_ads_daily_performance: impression,
// clicks, broad_order, broad_gmv, expense, broad_roas…). Medido em 02/10/2026 na loja real: a
// API responde, mas a loja não tinha campanha nem gasto — o detalhe por campanha
// (get_product_level_campaign_id_list / _setting_info) fica para quando houver dados reais.
const r2 = (v) => Math.round(v * 100) / 100;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const dataShopee = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;

// Dias da API -> série e totais. "broad" = venda atribuída ao anúncio (o mesmo produto ou
// outro da loja); "direct" = só o produto anunciado. Função pura: testada.
function adsDe(lista) {
  const dias = (lista || []).map((x) => {
    const [d, m, a] = String(x.date || '').split('-');
    return { dia: a && m && d ? `${a}-${m}-${d}` : x.date, gasto: r2(Number(x.expense) || 0), impressoes: Number(x.impression) || 0,
      cliques: Number(x.clicks) || 0, pedidos: Number(x.broad_order) || 0, unidades: Number(x.broad_item_sold) || 0,
      vendas: r2(Number(x.broad_gmv) || 0), pedidos_diretos: Number(x.direct_order) || 0, vendas_diretas: r2(Number(x.direct_gmv) || 0) };
  }).sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
  const s = (k) => dias.reduce((t, x) => t + x[k], 0);
  const gasto = r2(s('gasto')), vendas = r2(s('vendas')), cliques = s('cliques'), impressoes = s('impressoes');
  return { dias, total: { gasto, vendas, cliques, impressoes, pedidos: s('pedidos'), unidades: s('unidades'),
    vendas_diretas: r2(s('vendas_diretas')), roas: gasto > 0 ? vendas / gasto : null, acos: vendas > 0 ? gasto / vendas : null,
    ctr: impressoes > 0 ? cliques / impressoes : null, cpc: cliques > 0 ? gasto / cliques : null } };
}

function criar({ D, daLoja }) {
  const rotas = {
    'GET /api/shopee/ads': async (url) => {
      const shopId = Number(url.searchParams.get('loja'));
      if (!Number.isInteger(shopId) || !D.shopeeLojaObter(shopId)) throw erro('Escolha uma loja da Shopee conectada.', 404);
      const dias = [7, 15, 30].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30;
      const fim = new Date(Date.now() - 3 * 3600e3);                      // hoje em Brasília
      const ini = new Date(fim.getTime() - (dias - 1) * 864e5);
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const [saldo, perf, camp] = await Promise.all([
        passo(() => daLoja(shopId, '/api/v2/ads/get_total_balance', {})),
        passo(() => daLoja(shopId, '/api/v2/ads/get_all_cpc_ads_daily_performance', { start_date: dataShopee(ini), end_date: dataShopee(fim) })),
        passo(() => daLoja(shopId, '/api/v2/ads/get_product_level_campaign_id_list', { offset: 0, limit: 100, ad_type: 'all' })),
      ]);
      if (perf.erro) throw erro(`Shopee Ads: ${perf.erro}`, 502);
      return { loja: shopId, dias, saldo: saldo.erro ? null : saldo.response?.total_balance ?? null,
        campanhas: camp.erro ? null : (camp.response?.campaign_list || []).length, ...adsDe(perf.response) };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, adsDe };
