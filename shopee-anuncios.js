'use strict';
// Anúncios da Shopee (tela public/shopee-anuncios.html, ?conta=shopee-{loja}): preço, estoque,
// vendas e a margem no preço atual, com troca de preço por valor ou pela margem desejada.
//
// Medido em 02/10/2026 na loja real: get_item_list (100 por página, por situação),
// get_item_base_info (50 por chamada; price_info[0].current_price/original_price,
// stock_info_v2.summary_info.total_available_stock, image.image_url_list) e, para quem tem
// variação (has_model), get_model_list (model[].price_info, model_sku, tier_index ->
// tier_variation[].option_list). get_item_extra_info dá sale (vendas do anúncio) e views.
// Preço muda em update_price com o original_price (o "preço" do vendedor). has_promotion vem
// true também para preço de ATACADO ("Whole Sale", medido: 95% dos anúncios da loja real, sem
// nenhuma promoção de desconto ativa) — "em promoção" na tela é só preço atual < original.
// Com desconto ativo o comprador continua vendo o preço da promoção até ela acabar.
const C = require('./custos.js');
const SV = require('./shopee-vendas.js');
const r2 = (v) => Math.round(v * 100) / 100;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Anúncio (base info) + modelos -> registros da tabela. Função pura: testada.
function registrosDe(item, modelos = null, tiers = []) {
  const img = item.image?.image_url_list?.[0] || null;
  const base = { item_id: item.item_id, nome: item.item_name || null, status: item.item_status || null, imagem: img };
  if (!item.has_model || !modelos) {
    const p = item.price_info?.[0] || {};
    return [{ ...base, model_id: 0, variacao: null, sku: (item.item_sku || '').trim() || null, preco: p.current_price ?? null,
      preco_original: p.original_price ?? null, promocao: !!item.has_promotion, estoque: item.stock_info_v2?.summary_info?.total_available_stock ?? null }];
  }
  return modelos.map((m) => {
    const p = m.price_info?.[0] || {};
    const nomeVar = (m.tier_index || []).map((ix, t) => tiers[t]?.option_list?.[ix]?.option).filter(Boolean).join(' / ') || m.model_name || null;
    return { ...base, model_id: m.model_id, variacao: nomeVar, sku: (m.model_sku || item.item_sku || '').trim() || null,
      preco: p.current_price ?? null, preco_original: p.original_price ?? null, promocao: !!m.has_promotion,
      estoque: m.stock_info_v2?.summary_info?.total_available_stock ?? null };
  });
}

// Taxa média da Shopee por SKU (tarifa + frete ÷ faturamento) nas vendas com repasse. Função pura: testada.
function taxasPorSku(linhas) {
  const m = new Map();
  for (const l of linhas) {
    if (!l.valida || l.estimado || !l.sku || !(l.faturamento > 0) || l.tarifa == null) continue;
    const x = m.get(l.sku) || { fat: 0, taxa: 0 };
    x.fat += l.faturamento; x.taxa += (l.tarifa || 0) + (l.frete || 0); m.set(l.sku, x);
  }
  return new Map([...m].map(([k, x]) => [k, x.taxa / x.fat]));
}

function criar({ D, daLoja }) {
  const exigeLoja = (v) => {
    const id = Number(v);
    if (!Number.isInteger(id) || !D.shopeeLojaObter(id)) throw erro('Escolha uma loja da Shopee conectada.', 404);
    return id;
  };

  // Leitura completa da loja, em segundo plano (1.660 anúncios ≈ 1 min).
  const lendo = new Map();
  function ler(shopId) {
    if (lendo.has(shopId)) return lendo.get(shopId);
    const p = (async () => {
      const inicio = new Date().toISOString();
      const ids = [];
      for (const status of ['NORMAL', 'UNLIST']) {
        for (let offset = 0, pag = 0; pag < 200; pag++) {
          const r = await daLoja(shopId, '/api/v2/product/get_item_list', { offset, page_size: 100, item_status: status });
          ids.push(...(r.response?.item || []).map((x) => x.item_id));
          if (!r.response?.has_next_page) break;
          offset = r.response.next_offset;
        }
      }
      for (let i = 0; i < ids.length; i += 50) {
        const lote = ids.slice(i, i + 50);
        const [b, x] = await Promise.all([
          daLoja(shopId, '/api/v2/product/get_item_base_info', { item_id_list: lote }),
          daLoja(shopId, '/api/v2/product/get_item_extra_info', { item_id_list: lote }).catch(() => null)]);
        const extra = new Map((x?.response?.item_list || []).map((e) => [e.item_id, e]));
        const linhas = [];
        for (const it of b.response?.item_list || []) {
          let regs;
          if (it.has_model) {
            const m = await daLoja(shopId, '/api/v2/product/get_model_list', { item_id: it.item_id }).catch(() => null);
            regs = registrosDe(it, m?.response?.model || null, m?.response?.tier_variation || []);
          } else regs = registrosDe(it);
          const e = extra.get(it.item_id);
          for (const r of regs) linhas.push({ ...r, vendas_total: e?.sale ?? null, visitas: e?.views ?? null });
        }
        D.shopeeAnunciosGravar(shopId, linhas);
      }
      D.shopeeAnunciosLimparAntes(shopId, inicio);
      D.configGravar(`shopee_anuncios_lido_em:${shopId}`, new Date().toISOString());
    })().finally(() => lendo.delete(shopId));
    lendo.set(shopId, p);
    return p;
  }

  function empresaDe(shopId) {
    const propria = D.configLer(`empresa:shopee-${shopId}`);
    const reserva = D.contasListar()[0]?.ml_user_id;
    return C.lerEmpresa(propria || (reserva ? D.configLer(`empresa:${reserva}`) : null));
  }

  const rotas = {
    // Lista da cópia local; a leitura (primeira vez, mais de 6 h ou "recarregar") roda em
    // segundo plano e a tela pede de novo enquanto `lendo`.
    'GET /api/shopee/anuncios': async (url) => {
      const shopId = exigeLoja(url.searchParams.get('loja'));
      const lidoEm = D.configLer(`shopee_anuncios_lido_em:${shopId}`);
      if (url.searchParams.get('recarregar') === '1' || !lidoEm || Date.now() - Date.parse(lidoEm) > 6 * 3600e3) ler(shopId).catch(() => null);
      const empresa = empresaDe(shopId);
      const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
      const ctx = { mapa, imposto_pct: 0, embalagem_unit: 0 };
      const rows90 = D.shopeeVendasPeriodo(shopId, new Date(Date.now() - 90 * 864e5).toISOString(), '9999');
      const linhas90 = SV.linhasDe(rows90, { ...ctx, proporcao: null });
      const taxas = taxasPorSku(linhas90);
      const media = SV.proporcaoDe(rows90);
      const desde30 = new Date(Date.now() - 30 * 864e5).toISOString();
      const v30 = new Map();
      for (const l of linhas90) if (l.valida && l.sku && l.data >= desde30) v30.set(l.sku, (v30.get(l.sku) || 0) + l.quantidade);
      const itens = D.shopeeAnuncios(shopId).map((a) => {
        const cs = a.sku ? C.custoDoSku(a.sku, mapa) : { custo: null, componentes: [] };
        return { item_id: a.item_id, model_id: a.model_id, sku: a.sku, nome_shopee: a.nome, variacao: a.variacao,
          titulo: cs.componentes.map((c) => c.nome).filter(Boolean).join(' + ') || a.nome, foto: a.imagem, status: a.status,
          preco: a.preco, preco_original: a.preco_original, estoque: a.estoque,
          promocao: a.preco != null && a.preco_original != null && a.preco < a.preco_original - 0.009,
          atacado_ou_campanha: !!a.promocao,
          vendas_total: a.vendas_total, visitas: a.visitas, vendas_30: (a.sku && v30.get(a.sku)) || 0,
          custo_unit: cs.custo, taxa_pct: (a.sku && taxas.get(a.sku)) ?? media, taxa_do_produto: !!(a.sku && taxas.has(a.sku)),
          embalagem_unit: empresa.embalagem_padrao || 0, link: `https://shopee.com.br/product/${shopId}/${a.item_id}` };
      }).sort((a, b) => (b.vendas_30 - a.vendas_30) || ((b.vendas_total || 0) - (a.vendas_total || 0)));
      return { loja: shopId, itens, imposto_pct: C.impostoTotal(empresa), lendo: lendo.has(shopId), lido_em: D.configLer(`shopee_anuncios_lido_em:${shopId}`) };
    },
    // Muda o preço na Shopee (escrita na conta: só pela tela, com confirmação).
    'POST /api/shopee/anuncios/preco': async (_u, body) => {
      const shopId = exigeLoja(body?.loja);
      const itemId = Number(body?.item_id), modelId = Number(body?.model_id) || 0;
      if (!Number.isInteger(itemId) || itemId <= 0) throw erro('Anúncio inválido.');
      const v = Number(String(body?.preco ?? '').replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0 || v > 1e6) throw erro('Preço inválido.');
      const preco = r2(v);
      await daLoja(shopId, '/api/v2/product/update_price', {}, { item_id: itemId,
        price_list: [modelId ? { model_id: modelId, original_price: preco } : { original_price: preco }] });
      // confere na Shopee e atualiza a cópia
      let atual = null;
      try {
        if (modelId) {
          const m = await daLoja(shopId, '/api/v2/product/get_model_list', { item_id: itemId });
          atual = (m.response?.model || []).find((x) => x.model_id === modelId)?.price_info?.[0] || null;
        } else {
          const b = await daLoja(shopId, '/api/v2/product/get_item_base_info', { item_id_list: [itemId] });
          atual = b.response?.item_list?.[0]?.price_info?.[0] || null;
        }
      } catch { /* a Shopee aceitou; a próxima leitura confirma */ }
      if (atual) D.shopeePrecoGravar(itemId, modelId, atual.current_price ?? preco, atual.original_price ?? preco);
      return { item_id: itemId, model_id: modelId, preco_original: atual?.original_price ?? preco, preco_atual: atual?.current_price ?? null,
        conferido: !!atual && Math.abs((atual.original_price ?? 0) - preco) < 0.01 };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, registrosDe, taxasPorSku };
