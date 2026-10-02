'use strict';
// node test-publicar.js — publicar na Shopee e na Amazon copiando do ML (publicar-canais.js). Só
// funções puras: nada aqui chama Shopee, Amazon ou ML.
const assert = require('node:assert');
const P = require('./publicar-canais.js');

// ---------- anúncio do ML -> dados para copiar ----------
const it = { id: 'MLB1', title: 'Ducha X', price: 228.42, available_quantity: 7, condition: 'new', seller_custom_field: null,
  attributes: [{ id: 'SELLER_SKU', value_name: 'KIT-770.791' }, { id: 'GTIN', value_name: '7890000000017' }, { id: 'BRAND', value_name: 'Minha Marca' }],
  pictures: [{ secure_url: 'https://http2.mlstatic.com/a.jpg' }, { url: 'http://http2.mlstatic.com/b.jpg' }], shipping: { dimensions: '24x21x6,570' }, variations: [] };
const o = P.origemDe(it, 'Descrição longa do produto');
assert.deepStrictEqual({ sku: o.sku, gtin: o.gtin, fotos: o.fotos, peso: o.peso_kg, dims: [o.comprimento, o.largura, o.altura] },
  { sku: 'KIT-770.791', gtin: '7890000000017', fotos: ['https://http2.mlstatic.com/a.jpg', 'https://http2.mlstatic.com/b.jpg'], peso: 0.57, dims: [24, 21, 6] });
assert.strictEqual(P.origemDe({ ...it, shipping: {} }, '').peso_kg, null, 'sem medidas no ML');

// ---------- corpo da Shopee: limites conferidos ----------
const f = { titulo: 'Ducha X', descricao: 'Descrição longa do produto', preco: '228,42', estoque: 7, sku: 'KIT-770.791', categoria: 101137,
  peso_kg: 0.57, comprimento: 24, largura: 21, altura: 6, canais: ['90022', '91003'], marca_id: 1234567, marca_nome: 'Minha Marca', gtin: '789-868', condicao: 'new',
  atributos: [{ attribute_id: 100037, value_id: 35 }, { attribute_id: 1, valor: 'Inox' }, { attribute_id: 2 }] };
const c = P.corpoShopee(f, ['img1', 'img2']);
assert.deepStrictEqual({ preco: c.original_price, estoque: c.seller_stock, canais: c.logistic_info.map((l) => l.logistic_id), marca: c.brand.brand_id, gtin: c.gtin_code, cond: c.condition, attrs: c.attribute_list.length, img: c.image.image_id_list },
  { preco: 228.42, estoque: [{ stock: 7 }], canais: [90022, 91003], marca: 1234567, gtin: '789868', cond: 'NEW', attrs: 2, img: ['img1', 'img2'] });
assert.deepStrictEqual(c.attribute_list[1].attribute_value_list, [{ value_id: 0, original_value_name: 'Inox' }], 'atributo de texto livre');
assert.throws(() => P.corpoShopee({ ...f, titulo: 'x'.repeat(121) }, ['i']), /2 a 120/);
assert.throws(() => P.corpoShopee({ ...f, descricao: 'curta' }, ['i']), /10 a 5.000/);
assert.throws(() => P.corpoShopee({ ...f, peso_kg: '' }, ['i']), /peso/);
assert.throws(() => P.corpoShopee({ ...f, altura: 0 }, ['i']), /medidas/);
assert.throws(() => P.corpoShopee({ ...f, canais: [] }, ['i']), /forma de envio/);
assert.throws(() => P.corpoShopee(f, []), /1 a 9 fotos/);
assert.throws(() => P.corpoShopee(f, Array(10).fill('i')), /1 a 9 fotos/);

// ---------- corpo da Amazon: oferta em produto do catálogo ----------
const a = P.corpoAmazon({ asin: 'B0ABCDEFGH', tipo: 'SHOWERHEAD', preco: '99,9', estoque: 3 });
assert.deepStrictEqual({ req: a.requirements, tipo: a.productType, asin: a.attributes.merchant_suggested_asin[0].value,
  preco: a.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, qtd: a.attributes.fulfillment_availability[0].quantity },
  { req: 'LISTING_OFFER_ONLY', tipo: 'SHOWERHEAD', asin: 'B0ABCDEFGH', preco: 99.9, qtd: 3 });
assert.throws(() => P.corpoAmazon({ asin: 'X', tipo: 'T', preco: 1 }), /ASIN/);
assert.throws(() => P.corpoAmazon({ asin: 'B0ABCDEFGH', tipo: 'T', preco: 0 }), /Preço/);

console.log('Publicar na Shopee e na Amazon: origem do ML, limites da Shopee e oferta da Amazon: ok');
