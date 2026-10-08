'use strict';
// Trocar um produto no SKU dos anúncios dos OUTROS canais (o do Mercado Livre fica em custos.js), bloco
// "Trocar um produto no SKU" da tela Produtos. Mudou o fornecedor e o DD-795 virou DD-854:
//   - Shopee (cada loja): troca DE VERDADE no anúncio (update_item / update_model), como no ML.
//   - Amazon, Leroy e Magalu: o marketplace não deixa renomear o SKU (é a chave da oferta). A troca fica no
//     PAINEL (tabela sku_trocas) e vale A PARTIR de agora para custo, lucro, estoque e comandas; as vendas
//     anteriores continuam com o produto antigo (foi ele que saiu do estoque).
// Escrita só pelo clique na tela, com confirmação. Nada no MCP (dados da Amazon).
const C = require('./custos.js');

const NOMES = { shopee: 'Shopee', amazon: 'Amazon', leroy: 'Leroy Merlin', magalu: 'Magalu' };

function criar({ D, shopee, amazon, leroy, magalu, quem }) {
  const erro = (m, status = 400) => Object.assign(new Error(m), { status });
  const numeroDoProduto = (txt) => {
    const m = /(\d+)\s*$/.exec(String(txt ?? '').trim());
    if (!m) throw erro('Produto inválido: use o SKU (ex.: DD-854) ou o número (854).');
    return Number(m[1]);
  };
  const tem = (sku, n) => !!sku && C.componentes(sku).includes(n);

  // Anúncios de cada canal com o produto no SKU (o SKU que vale HOJE, já com as trocas anteriores).
  async function buscar(numero) {
    const canais = [], erros = [];
    // Shopee: cópia local dos anúncios de cada loja (relida a cada 6 h)
    for (const l of D.shopeeLojasListar()) {
      const porItem = new Map();
      for (const a of D.shopeeAnuncios(l.shop_id)) {
        if (!tem(a.sku, numero)) continue;
        const x = porItem.get(a.item_id) || { id: String(a.item_id), titulo: a.nome, foto: a.imagem, status: a.status,
          link: `https://shopee.com.br/product/${l.shop_id}/${a.item_id}`, skus: [] };
        x.skus.push({ ref: String(a.model_id || 0), variacao: a.variacao || null, sku: a.sku });
        porItem.set(a.item_id, x);
      }
      canais.push({ canal: 'shopee', loja: l.shop_id, nome: `${l.nome || 'Loja ' + l.shop_id} · Shopee`, modo: 'anuncio', anuncios: [...porItem.values()] });
    }
    // Amazon: Listings API (a mesma lista da tela de anúncios)
    if (D.configLer('amazon_refresh_token')) {
      try {
        const tr = D.skuTrocas('amazon');
        const d = await amazon.anuncios(false);
        const lista = d.itens.map((i) => ({ ...i, efetivo: C.skuNaData(tr, i.sku) })).filter((i) => tem(i.efetivo, numero));
        canais.push({ canal: 'amazon', loja: null, nome: `${D.configLer('amazon_vendedor') || 'Amazon'} · Amazon`, modo: 'painel',
          anuncios: lista.map((i) => ({ id: i.sku, titulo: i.titulo, foto: i.foto, status: (i.status || []).join(', ') || null, link: i.link,
            skus: [{ ref: i.sku, variacao: i.canal === 'FBA' ? 'FBA' : null, sku: i.efetivo, sku_anuncio: i.sku }] })) });
      } catch (e) { erros.push(`Amazon: ${e.message}`); }
    }
    // Leroy: ofertas da loja (OF21)
    if (leroy.config()?.api_key) {
      try {
        const tr = D.skuTrocas('leroy');
        const lista = (await leroy.ofertas(false)).map((o) => ({ ...o, efetivo: C.skuNaData(tr, o.sku) })).filter((o) => tem(o.efetivo, numero));
        canais.push({ canal: 'leroy', loja: null, nome: `${D.configLer('leroy_loja_nome') || 'Leroy Merlin'} · Leroy Merlin`, modo: 'painel',
          anuncios: lista.map((o) => ({ id: o.sku, titulo: o.titulo, foto: null, status: o.ativa ? 'ativa' : 'inativa', link: null,
            skus: [{ ref: o.sku, variacao: null, sku: o.efetivo, sku_anuncio: o.sku }] })) });
      } catch (e) { erros.push(`Leroy: ${e.message}`); }
    }
    // Magalu: cópia local dos anúncios, com o "SKU do painel" digitado
    if (magalu.config()?.refresh) {
      const vinc = D.skuVinculos('magalu'), tr = D.skuTrocas('magalu');
      const lista = D.magaluAnuncios().map((a) => ({ ...a, efetivo: C.skuNaData(tr, vinc.get(a.sku) || a.sku) })).filter((a) => tem(a.efetivo, numero));
      canais.push({ canal: 'magalu', loja: null, nome: `${D.configLer('magalu_loja_nome') || 'Magalu'} · Magalu`, modo: 'painel',
        anuncios: lista.map((a) => ({ id: a.sku, titulo: a.titulo, foto: null, status: a.status, link: a.url,
          skus: [{ ref: a.sku, variacao: null, sku: a.efetivo, sku_anuncio: a.sku }] })) });
    }
    return { canais: canais.filter((c) => c.anuncios.length), erros };
  }

  // Shopee: troca no anúncio (o item sem variação muda o item_sku; com variação, o model_sku de cada uma).
  async function trocarShopee(loja, itemId, refs, de, para) {
    const linhas = D.shopeeAnuncios(loja).filter((a) => a.item_id === itemId && (!refs?.length || refs.includes(String(a.model_id || 0))) && tem(a.sku, de));
    if (!linhas.length) return { ok: false, erro: 'o SKU deste anúncio não tem mais esse produto (releia os anúncios da Shopee)' };
    const trocas = linhas.map((a) => ({ model_id: a.model_id || 0, antes: a.sku, depois: C.trocarComponente(a.sku, de, para) }));
    const modelos = trocas.filter((t) => t.model_id);
    if (modelos.length) await shopee.daLoja(loja, '/api/v2/product/update_model', {}, { item_id: itemId, model: modelos.map((t) => ({ model_id: t.model_id, model_sku: t.depois })) });
    const base = trocas.find((t) => !t.model_id);
    if (base) await shopee.daLoja(loja, '/api/v2/product/update_item', {}, { item_id: itemId, item_sku: base.depois });
    const agora = new Date().toISOString();
    for (const t of trocas) { D.shopeeSkuGravar(itemId, t.model_id, t.depois); D.skuTrocaGravar('shopee', t.antes, t.depois, agora, quem()); }
    return { ok: true, trocas: trocas.map(({ antes, depois }) => ({ antes, depois })) };
  }

  const rotasParam = [
    { m: 'GET', re: /^\/api\/produtos\/(\d+)\/anuncios-canais$/, fn: async ([n]) => {
      const numero = Number(n);
      return { produto: D.catalogoListar().find((p) => p.numero === numero) || { numero }, ...(await buscar(numero)) };
    } },
    { m: 'POST', re: /^\/api\/produtos\/(\d+)\/trocar-sku-canais$/, fn: async ([n], body) => {
      const de = Number(n);
      const para = numeroDoProduto(body?.novo);
      if (para === de) throw erro('O produto novo é igual ao atual.');
      const itens = Array.isArray(body?.itens) ? body.itens : [];
      if (!itens.length) throw erro('Escolha pelo menos um anúncio.');
      if (itens.length > 300) throw erro('No máximo 300 anúncios por vez.');
      const agora = new Date().toISOString();
      const trocas = { amazon: D.skuTrocas('amazon'), leroy: D.skuTrocas('leroy'), magalu: D.skuTrocas('magalu') };
      const vinc = D.skuVinculos('magalu');
      const resultado = [];
      for (const it of itens) {
        const canal = String(it?.canal || ''), id = String(it?.id || '');
        try {
          if (canal === 'shopee') {
            const loja = Number(it.loja), itemId = Number(id);
            if (!D.shopeeLojasListar().some((l) => l.shop_id === loja) || !Number.isInteger(itemId)) throw erro('Anúncio da Shopee inválido.');
            resultado.push({ canal, loja, id, ...(await trocarShopee(loja, itemId, Array.isArray(it.refs) ? it.refs.map(String) : null, de, para)) });
          } else if (['amazon', 'leroy', 'magalu'].includes(canal)) {
            if (!id || id.length > 80) throw erro('SKU inválido.');
            // o SKU que vale hoje (com o "SKU do painel" da Magalu e as trocas anteriores) ganha a troca a partir de agora
            const atual = C.skuNaData(trocas[canal], canal === 'magalu' ? (vinc.get(id) || id) : id);
            if (!tem(atual, de)) throw erro('o SKU deste anúncio não tem mais esse produto');
            const novo = C.trocarComponente(atual, de, para);
            D.skuTrocaGravar(canal, atual, novo, agora, quem());
            resultado.push({ canal, id, ok: true, trocas: [{ antes: atual, depois: novo }], no_painel: true });
          } else throw erro('Canal inválido.');
        } catch (e) { resultado.push({ canal, id, ok: false, erro: e.message }); }
      }
      return { de, para, novo_na_tabela: D.catalogoListar().some((p) => p.numero === para),
        alterados: resultado.filter((r) => r.ok).length, falhas: resultado.filter((r) => !r.ok), resultado };
    } },
  ];
  return { rotas: {}, rotasParam };
}

module.exports = { criar, NOMES };
