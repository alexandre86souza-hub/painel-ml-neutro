'use strict';
// Publicar na Shopee e na Amazon COPIANDO um anúncio do Mercado Livre (tela
// public/publicar-canais.html; o menu Publicar abre ela quando a conta escolhida é Shopee ou
// Amazon). A escrita só acontece no clique do vendedor na tela.
//
// Medido em 02/10/2026 (só leitura):
//   Shopee: product/category_recommend acerta a categoria pelo título ("Chuveiro, Chuveirinhos e
//   Bidês"); get_attribute_tree (14 atributos, nenhum obrigatório nessa categoria); marca
//   obrigatória (get_brand_list.is_mandatory) — a da loja vem dos anúncios dela (brand_id);
//   get_item_limit: título até 120, até 9 fotos, descrição 10–5000; logistics/get_channel_list:
//   canais ativos da loja. Foto: media_space/upload_image (shopee.js#subirImagem). Criar:
//   product/add_item.
//   Amazon: catalog/2022-04-01/items por EAN acha o ASIN e o productType; listings/restrictions
//   diz se a conta pode vender; PUT listings/items com requirements LISTING_OFFER_ONLY e
//   mode=VALIDATION_PREVIEW confere sem criar (status VALID). Produto fora do catálogo exige
//   criar o produto no Seller Central (muitos atributos por tipo): fora deste fluxo.
//   CUIDADO: PUT num SKU que já existe SOBRESCREVE aquele anúncio — o SKU repetido é recusado.
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const n = (v) => Number(v) || 0;
const BR = 'A2Q3Y263D00KWC';
const FOTO_OK = /^https:\/\/([a-z0-9-]+\.)*mlstatic\.com\//i;   // só baixa foto do próprio ML (sem SSRF)

// Anúncio do ML -> dados para copiar. Função pura: testada.
function origemDe(it, descricao) {
  const at = (k) => it.attributes?.find((a) => a.id === k)?.value_name || null;
  // ML: shipping.dimensions = "24x21x6,570" (cm e gramas), quando o anúncio tem
  const dm = /^(\d+(?:[.,]\d+)?)x(\d+(?:[.,]\d+)?)x(\d+(?:[.,]\d+)?),(\d+)$/.exec(it.shipping?.dimensions || '');
  const num = (s) => Number(String(s).replace(',', '.'));
  return {
    mlb: it.id, titulo: it.title, preco: it.price, estoque: it.available_quantity ?? 0, condicao: it.condition || 'new',
    sku: it.seller_custom_field || at('SELLER_SKU'), gtin: at('GTIN'), marca: at('BRAND'), modelo: at('MODEL'),
    descricao: descricao || '', link: it.permalink || null, variacoes: (it.variations || []).length,
    fotos: (it.pictures || []).map((p) => (p.secure_url || p.url || '').replace(/^http:/, 'https:')).filter(Boolean),
    peso_kg: dm ? Number(dm[4]) / 1000 : null, comprimento: dm ? num(dm[1]) : null, largura: dm ? num(dm[2]) : null, altura: dm ? num(dm[3]) : null,
  };
}

// Corpo do add_item da Shopee a partir do formulário (valida os limites). Função pura: testada.
function corpoShopee(f, imagens) {
  const titulo = String(f.titulo || '').trim();
  const desc = String(f.descricao || '').trim();
  if (titulo.length < 2 || titulo.length > 120) throw erro('O título da Shopee precisa ter de 2 a 120 caracteres.');
  if (desc.length < 10 || desc.length > 5000) throw erro('A descrição da Shopee precisa ter de 10 a 5.000 caracteres.');
  const preco = n(String(f.preco).replace(',', '.'));
  if (!(preco >= 1 && preco <= 100000)) throw erro('Preço inválido para a Shopee.');
  const estoque = Math.trunc(n(f.estoque));
  if (estoque < 0) throw erro('Estoque inválido.');
  const peso = n(String(f.peso_kg).replace(',', '.'));
  if (!(peso > 0 && peso <= 300)) throw erro('Informe o peso da embalagem (kg).');
  const dims = ['comprimento', 'largura', 'altura'].map((k) => Math.round(n(String(f[k]).replace(',', '.'))));
  if (dims.some((d) => !(d >= 1 && d <= 300))) throw erro('Informe as medidas da embalagem (cm).');
  if (!Number.isInteger(Number(f.categoria))) throw erro('Escolha a categoria da Shopee.');
  if (!imagens.length || imagens.length > 9) throw erro('Escolha de 1 a 9 fotos.');
  const canais = (f.canais || []).map(Number).filter(Number.isInteger);
  if (!canais.length) throw erro('Escolha pelo menos uma forma de envio.');
  const corpo = {
    item_name: titulo, description: desc, original_price: preco, item_sku: String(f.sku || '').trim().slice(0, 100) || undefined,
    category_id: Number(f.categoria), weight: peso,
    dimension: { package_length: dims[0], package_width: dims[1], package_height: dims[2] },
    image: { image_id_list: imagens }, seller_stock: [{ stock: estoque }], condition: f.condicao === 'used' ? 'USED' : 'NEW',
    logistic_info: canais.map((id) => ({ logistic_id: id, enabled: true })),
    brand: { brand_id: Number(f.marca_id) || 0, original_brand_name: String(f.marca_nome || 'NoBrand') },
    attribute_list: (f.atributos || []).filter((a) => a && a.attribute_id && (a.value_id || a.valor)).map((a) => ({ attribute_id: Number(a.attribute_id),
      attribute_value_list: [a.value_id ? { value_id: Number(a.value_id) } : { value_id: 0, original_value_name: String(a.valor) }] })),
  };
  if (f.gtin) corpo.gtin_code = String(f.gtin).replace(/\D/g, '');
  return corpo;
}

// Corpo da oferta na Amazon (produto que já existe no catálogo). Função pura: testada.
function corpoAmazon(f) {
  const preco = n(String(f.preco).replace(',', '.'));
  if (!(preco > 0)) throw erro('Preço inválido para a Amazon.');
  const estoque = Math.trunc(n(f.estoque));
  if (!/^B[0-9A-Z]{9}$/.test(String(f.asin || ''))) throw erro('Escolha o produto do catálogo da Amazon (ASIN).');
  if (!f.tipo) throw erro('Tipo de produto da Amazon ausente.');
  return { productType: String(f.tipo), requirements: 'LISTING_OFFER_ONLY', attributes: {
    condition_type: [{ value: 'new_new', marketplace_id: BR }],
    merchant_suggested_asin: [{ value: String(f.asin), marketplace_id: BR }],
    purchasable_offer: [{ currency: 'BRL', marketplace_id: BR, our_price: [{ schedule: [{ value_with_tax: Math.round(preco * 100) / 100 }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: Math.max(0, estoque) }],
  } };
}

function criar({ D, ml, contaOuErro, shopee, amazon }) {
  const cache = new Map();
  const guardado = async (k, min, fn) => { const c = cache.get(k); if (c && Date.now() - c.em < min * 60e3) return c.v; const v = await fn(); cache.set(k, { em: Date.now(), v }); return v; };
  const exigeLoja = (v) => { const id = Number(v); if (!Number.isInteger(id) || !D.shopeeLojaObter(id)) throw erro('Escolha uma loja da Shopee conectada.', 404); return id; };
  const resp = (r) => r?.response || {};

  async function origem(mlb) {
    const conta = contaOuErro();
    if (!/^MLB\d+$/.test(String(mlb || ''))) throw erro('Informe o código do anúncio do ML (MLB…).');
    const it = await ml(`/items/${mlb}`, {}, conta.ml_user_id);
    if (Number(it.seller_id) !== Number(conta.ml_user_id)) throw erro('Esse anúncio não é da conta do ML escolhida.', 403);
    const d = await ml(`/items/${mlb}/description`, {}, conta.ml_user_id).catch(() => null);
    return origemDe(it, d?.plain_text || '');
  }
  const categorias = (shopId) => guardado(`cats:${shopId}`, 24 * 60, async () => {
    const r = resp(await shopee.daLoja(shopId, '/api/v2/product/get_category', { language: 'pt-br' }));
    return new Map((r.category_list || []).map((c) => [c.category_id, { nome: c.display_category_name || c.original_category_name, pai: c.parent_category_id, folha: !c.has_children }]));
  });
  const caminhoCat = (mapa, id) => { const out = []; let c = mapa.get(id); let g = 0; while (c && g++ < 8) { out.unshift(c.nome); c = mapa.get(c.pai); } return out.join(' › '); };

  const rotas = {
    // anúncios do ML para escolher: MLB, SKU ou parte do título
    'GET /api/publicar/anuncios-ml': async (url) => {
      const conta = contaOuErro();
      const q = String(url.searchParams.get('q') || '').trim();
      if (q.length < 2) return { anuncios: [] };
      let ids = [];
      const mlb = /MLB\d+/i.exec(q);
      if (mlb) ids = [mlb[0].toUpperCase()];
      else {
        const buscar = (campo) => ml(`/users/${conta.ml_user_id}/items/search?${campo}=${encodeURIComponent(q)}&status=active&limit=20`, {}, conta.ml_user_id)
          .then((r) => r.results || []).catch(() => []);
        // SKU: o ML só acha o SKU exato; sem resultado, tenta pelo texto
        if (/\d/.test(q) && !/\s/.test(q)) ids = await buscar('seller_sku');
        if (!ids.length) ids = await buscar('q');
      }
      if (!ids.length) return { anuncios: [] };
      const r = await ml(`/items?ids=${ids.slice(0, 20).join(',')}&attributes=id,title,price,thumbnail,status,available_quantity,seller_custom_field`, {}, conta.ml_user_id);
      return { anuncios: (r || []).filter((x) => x.code === 200).map((x) => ({ mlb: x.body.id, titulo: x.body.title, preco: x.body.price, foto: x.body.thumbnail,
        status: x.body.status, estoque: x.body.available_quantity, sku: x.body.seller_custom_field || null })) };
    },
    'GET /api/publicar/origem': async (url) => origem(url.searchParams.get('mlb')),

    // ---------- Shopee ----------
    'GET /api/shopee/publicar/preparar': async (url) => {
      const shopId = exigeLoja(url.searchParams.get('loja'));
      const o = await origem(url.searchParams.get('mlb'));
      const mapa = await categorias(shopId);
      const rec = resp(await shopee.daLoja(shopId, '/api/v2/product/category_recommend', { item_name: o.titulo }).catch(() => null));
      const sugeridas = (rec.category_id || []).map((id) => ({ id, nome: caminhoCat(mapa, id) || String(id) }));
      // marca e medidas: dos anúncios da própria loja (a marca da loja já cadastrada na Shopee)
      const amostra = D.db.prepare('SELECT DISTINCT item_id FROM shopee_anuncios WHERE shop_id=? LIMIT 20').all(shopId).map((r) => r.item_id);
      const base = amostra.length ? resp(await shopee.daLoja(shopId, '/api/v2/product/get_item_base_info', { item_id_list: amostra.join(',') }).catch(() => null)).item_list || [] : [];
      const contaMarcas = new Map();
      for (const b of base) if (b.brand?.brand_id) { const k = b.brand.brand_id; const x = contaMarcas.get(k) || { id: k, nome: b.brand.original_brand_name, n: 0 }; x.n++; contaMarcas.set(k, x); }
      const marcas = [...contaMarcas.values()].sort((a, b) => b.n - a.n).map(({ id, nome }) => ({ id, nome }));
      const canais = (resp(await shopee.daLoja(shopId, '/api/v2/logistics/get_channel_list', {})).logistics_channel_list || [])
        .filter((c) => c.enabled).map((c) => ({ id: c.logistics_channel_id, nome: c.logistics_channel_name }));
      // anúncio da loja com o mesmo SKU (para não duplicar sem querer)
      const mesmoSku = o.sku ? D.db.prepare('SELECT item_id, nome, sku FROM shopee_anuncios WHERE shop_id=? AND sku=? LIMIT 3').all(shopId, o.sku) : [];
      // peso e medidas: sem eles no ML, sugere os do anúncio da loja com o mesmo SKU
      if (o.peso_kg == null && mesmoSku.length) {
        const b = resp(await shopee.daLoja(shopId, '/api/v2/product/get_item_base_info', { item_id_list: String(mesmoSku[0].item_id) }).catch(() => null)).item_list?.[0];
        if (b?.weight) Object.assign(o, { peso_kg: Number(b.weight), comprimento: b.dimension?.package_length ?? null, largura: b.dimension?.package_width ?? null,
          altura: b.dimension?.package_height ?? null, medidas_de: `anúncio ${mesmoSku[0].item_id} da loja` });
      }
      return { origem: o, categorias: sugeridas, marcas, canais, mesmo_sku: mesmoSku,
        limites: { titulo: 120, fotos: 9, descricao: 5000 } };
    },
    'GET /api/shopee/publicar/atributos': async (url) => {
      const shopId = exigeLoja(url.searchParams.get('loja'));
      const cat = Number(url.searchParams.get('categoria'));
      if (!Number.isInteger(cat)) throw erro('Categoria inválida.');
      const mapa = await categorias(shopId);
      const t = resp(await shopee.daLoja(shopId, '/api/v2/product/get_attribute_tree', { category_id_list: String(cat), language: 'pt-br' }));
      const nome = (x) => x.multi_lang?.find((m) => /pt/i.test(m.language))?.value || x.display_attribute_name || x.name;
      const atributos = (t.list?.[0]?.attribute_tree || []).map((a) => ({ id: a.attribute_id, nome: nome(a), obrigatorio: !!a.mandatory,
        livre: !(a.attribute_value_list || []).length, opcoes: (a.attribute_value_list || []).map((v) => ({ id: v.value_id, nome: nome(v) })) }));
      const b = resp(await shopee.daLoja(shopId, '/api/v2/product/get_brand_list', { category_id: cat, status: 1, offset: 0, page_size: 1, language: 'pt-br' }).catch(() => null));
      return { categoria: { id: cat, nome: caminhoCat(mapa, cat), folha: mapa.get(cat)?.folha ?? null }, atributos, marca_obrigatoria: !!b.is_mandatory };
    },
    'POST /api/shopee/publicar': async (_url, f) => {
      const shopId = exigeLoja(f?.loja);
      const fotos = (f?.fotos || []).slice(0, 9);
      if (fotos.some((u) => !FOTO_OK.test(u))) throw erro('Só dá para usar as fotos do anúncio do Mercado Livre.');
      corpoShopee(f, ['validar']);   // confere tudo antes de subir as fotos
      const imagens = [];
      for (const u of fotos) {
        const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw erro(`Não consegui baixar uma foto do ML (${r.status}).`, 502);
        const tipo = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
        imagens.push(await shopee.subirImagem(Buffer.from(await r.arrayBuffer()), /png/.test(tipo) ? 'image/png' : 'image/jpeg'));
      }
      const r = resp(await shopee.daLoja(shopId, '/api/v2/product/add_item', {}, corpoShopee(f, imagens)));
      if (!r.item_id) throw erro('A Shopee não devolveu o anúncio criado.', 502);
      return { ok: true, item_id: r.item_id, link: `https://seller.shopee.com.br/portal/product/${r.item_id}` };
    },

    // ---------- Amazon (oferta em produto que já existe no catálogo) ----------
    'GET /api/amazon/publicar/preparar': async (url) => {
      const o = await origem(url.searchParams.get('mlb'));
      const ean = String(url.searchParams.get('ean') || o.gtin || '').replace(/\D/g, '');
      if (!ean) return { origem: o, ean: null, candidatos: [], aviso: 'O anúncio do ML não tem código de barras (EAN/GTIN). Informe o EAN para achar o produto no catálogo da Amazon.' };
      const seller = await amazon.idVendedor();
      const r = await amazon.sp('/catalog/2022-04-01/items', { identifiers: ean, identifiersType: 'EAN', marketplaceIds: BR, includedData: 'summaries,productTypes,images' });
      const candidatos = [];
      for (const x of (r.items || []).slice(0, 5)) {
        const s = x.summaries?.[0] || {};
        let restricoes = [], ja = false;
        try { const rs = await amazon.sp('/listings/2021-08-01/restrictions', { asin: x.asin, sellerId: seller, marketplaceIds: BR, conditionType: 'new_new' });
          restricoes = (rs.restrictions || []).flatMap((z) => (z.reasons || []).map((m) => m.message || m.reasonCode)); } catch {}
        try { const l = await amazon.sp(`/listings/2021-08-01/items/${seller}`, { marketplaceIds: BR, identifiers: x.asin, identifiersType: 'ASIN', includedData: 'summaries' });
          ja = (l.items || []).length > 0; } catch {}
        candidatos.push({ asin: x.asin, titulo: s.itemName || null, marca: s.brand || null, tipo: x.productTypes?.[0]?.productType || null,
          foto: x.images?.[0]?.images?.find((i) => i.variant === 'MAIN')?.link || x.images?.[0]?.images?.[0]?.link || null,
          restricoes, ja_anunciado: ja, link: `https://www.amazon.com.br/dp/${x.asin}` });
      }
      return { origem: o, ean, candidatos,
        aviso: candidatos.length ? null : 'Esse EAN não está no catálogo da Amazon Brasil. Produto novo no catálogo é criado no Seller Central (pede muitos atributos por tipo de produto).' };
    },
    // body: { asin, tipo, sku, preco, estoque, previa } — previa=true só confere (VALIDATION_PREVIEW)
    'POST /api/amazon/publicar': async (_url, f) => {
      const sku = String(f?.sku || '').trim();
      if (!sku || sku.length > 40) throw erro('Informe o SKU do anúncio na Amazon (até 40 caracteres).');
      const corpo = corpoAmazon(f || {});
      const seller = await amazon.idVendedor();
      // SKU que já existe: o PUT sobrescreveria aquele anúncio
      const existe = await amazon.sp(`/listings/2021-08-01/items/${seller}/${encodeURIComponent(sku)}`, { marketplaceIds: BR, includedData: 'summaries' }).then(() => true).catch((e) => (e.status === 404 ? false : Promise.reject(e)));
      if (existe) throw erro(`O SKU ${sku} já é de outro anúncio seu na Amazon. Use outro SKU (publicar com ele substituiria aquele anúncio).`, 409);
      const r = await amazon.sp(`/listings/2021-08-01/items/${seller}/${encodeURIComponent(sku)}`,
        { marketplaceIds: BR, includedData: 'issues', ...(f.previa ? { mode: 'VALIDATION_PREVIEW' } : {}) }, { metodo: 'PUT', corpo });
      return { ok: r.status !== 'INVALID', previa: !!f.previa, status: r.status, sku,
        problemas: (r.issues || []).map((i) => ({ gravidade: i.severity, codigo: i.code, mensagem: i.message })) };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, origemDe, corpoShopee, corpoAmazon };
