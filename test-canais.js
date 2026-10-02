'use strict';
// node test-canais.js — contas de outros marketplaces nas telas (canais.js) e as vendas da
// Shopee (shopee-vendas.js). Só funções puras: nada aqui chama a Shopee.
const assert = require('node:assert');
const K = require('./canais.js');
const SV = require('./shopee-vendas.js');

// ---------- Shopee: detalhe do pedido ----------
const d = SV.detalheDe({ order_sn: 'SN1', create_time: 1790000000, order_status: 'COMPLETED', update_time: 1790000500,
  buyer_username: 'nao-guardar', item_list: [{ item_id: 9, model_id: 1, item_name: 'Ducha', model_name: 'Cromada', item_sku: 'KIT-X',
    model_sku: ' KIT-407.408 ', model_quantity_purchased: 2, model_discounted_price: 50, model_original_price: 60, image_info: { image_url: 'https://img' } }] });
assert.deepStrictEqual(d.pedido, { order_sn: 'SN1', data: new Date(1790000000e3).toISOString(), status: 'COMPLETED', atualizado: 1790000500, transportadora: null });
assert.deepStrictEqual(d.itens[0], { sku: 'KIT-407.408', item_id: 9, model_id: 1, nome: 'Ducha — Cromada', quantidade: 2, preco_unit: 50, imagem: 'https://img' });
assert.ok(!JSON.stringify(d).includes('nao-guardar'), 'nada do comprador');

// ---------- Shopee: repasse ----------
const rep = SV.repasseDe({ order_income: { escrow_amount: 70, commission_fee: 14, service_fee: 6, seller_transaction_fee: 2,
  actual_shipping_fee: 20, buyer_paid_shipping_fee: 12, shopee_shipping_rebate: 0, voucher_from_seller: 0, seller_return_refund: 0 } }, 'COMPLETED');
assert.deepStrictEqual(rep, { final: true, recebido: 70, comissao: 14, servico: 6, transacao: 2, frete_vendedor: 8, cupom_vendedor: 0, devolucao: 0, frete_shopee: 12, taxa_item: null });
assert.strictEqual(SV.repasseDe({ order_income: { escrow_amount: 10 } }, 'SHIPPED').final, false, 'antes de concluído: provisório');

// ---------- Shopee: linhas de venda ----------
const mapa = new Map([[407, { numero: 407, sku: 'DQ-407', nome: 'Ducha', custo: 10 }], [408, { numero: 408, sku: 'BR-408', nome: 'Braço', custo: 5 }]]);
const base = { order_sn: 'SN1', data: '2026-09-30T12:00:00.000Z', status: 'COMPLETED', escrow_final: 1, recebido: 70, frete_vendedor: 8, devolucao: 0 };
const ctx = { mapa, imposto_pct: 10, embalagem_unit: 1, proporcao: 0.25 };
const [l1] = SV.linhasDe([{ ...base, linha: 0, sku: 'KIT-407.408', quantidade: 2, preco_unit: 50, nome: 'Kit' }], ctx);
assert.deepStrictEqual({ fat: l1.faturamento, tarifa: l1.tarifa, frete: l1.frete, produto: l1.produto, emb: l1.embalagem, imp: l1.imposto, lucro: l1.lucro, est: l1.estimado },
  { fat: 100, tarifa: 30, frete: 0, produto: 30, emb: 2, imp: 10, lucro: 28, est: false }, 'lucro = recebido − produto − embalagem − imposto');
assert.strictEqual(l1.lucro, 70 - 30 - 2 - 10);
// dois itens: o que a Shopee tirou é rateado pelo valor
const dois = SV.linhasDe([{ ...base, linha: 0, sku: 'DQ-407', quantidade: 1, preco_unit: 75 }, { ...base, linha: 1, sku: 'BR-408', quantidade: 1, preco_unit: 25 }], ctx);
assert.deepStrictEqual(dois.map((l) => l.tarifa + l.frete), [22.5, 7.5]);
// sem repasse ainda: proporção média, estimada
const [sem] = SV.linhasDe([{ ...base, recebido: null, escrow_final: 0, linha: 0, sku: 'DQ-407', quantidade: 1, preco_unit: 100 }], ctx);
assert.deepStrictEqual({ tarifa: sem.tarifa, est: sem.estimado }, { tarifa: 25, est: true });
// cancelado: fora da conta
const [canc] = SV.linhasDe([{ ...base, status: 'CANCELLED', linha: 0, sku: 'DQ-407', quantidade: 1, preco_unit: 100 }], ctx);
assert.deepStrictEqual({ valida: canc.valida, produto: canc.produto, lucro: canc.lucro }, { valida: false, produto: 0, lucro: 0 });
// sem custo: sem lucro
assert.deepStrictEqual(SV.linhasDe([{ ...base, linha: 0, sku: 'XX-999', quantidade: 1, preco_unit: 100 }], ctx)[0].falta, ['custo']);
// Entrega Direta: a Shopee repassa o frete; o vendedor paga a empresa de entrega
const ed = { ...base, transportadora: 'Entrega Direta', frete_shopee: 7.89, recebido: 77.89, linha: 0, sku: 'KIT-407.408', quantidade: 2, preco_unit: 50 };
const [e1] = SV.linhasDe([ed], { ...ctx, entrega_propria: 8 });
assert.deepStrictEqual({ tarifa: e1.tarifa, frete: e1.frete, lucro: e1.lucro, propria: e1.entrega_propria, fs: e1.frete_shopee, ce: e1.custo_entrega },
  { tarifa: 30, frete: 0.11, lucro: 27.89, propria: true, fs: 7.89, ce: 8 }, 'lucro = recebido − entrega − custos');
const [e2] = SV.linhasDe([ed], ctx);
assert.deepStrictEqual({ falta: e2.falta, lucro: e2.lucro }, { falta: ['entrega'], lucro: null }, 'sem o custo da entrega: lucro pendente');
const [e3] = SV.linhasDe([{ ...ed, recebido: null, escrow_final: 0 }], { ...ctx, entrega_propria: 8, frete_medio: { 'Entrega Direta': 7.5 } });
assert.deepStrictEqual({ tarifa: e3.tarifa, frete: e3.frete, est: e3.estimado }, { tarifa: 25, frete: 0.5, est: true }, 'sem repasse: frete médio da transportadora');
assert.deepStrictEqual(SV.freteMedioDe([{ ...ed }, { ...ed, order_sn: 'SN9', frete_shopee: 8.11 }, { ...ed, order_sn: 'SN8', escrow_final: 0, frete_shopee: 99 }]), { 'Entrega Direta': 8 });
// taxa por item (Shopee): a regra da taxa de serviço que passa de 3% do preço
assert.strictEqual(SV.taxaPorItemDe({ order_discounted_price: 53.64, net_service_fee_info_list: [{ rule_id: 1000074, fee_amount: 0.75 }, { rule_id: 1000075, fee_amount: 4.06 }] }), 4.06);
assert.strictEqual(SV.taxaPorItemDe({ order_discounted_price: 686.44, net_service_fee_info_list: [{ fee_amount: 13.73 }, { fee_amount: 80 }] }), 80);
assert.strictEqual(SV.taxaPorItemDe({ order_discounted_price: 10 }), null);
const [tf] = SV.linhasDe([{ ...base, taxa_item: 4.5, linha: 0, sku: 'DQ-407', quantidade: 1, preco_unit: 100 }], ctx);
assert.strictEqual(tf.taxa_fixa, 4.5);
assert.strictEqual(K.somaLinhas([tf]).taxa_fixa, 4.5);
// proporção média: só pedidos com repasse final e sem devolução
assert.strictEqual(SV.proporcaoDe([{ ...base, linha: 0, quantidade: 2, preco_unit: 50 }, { ...base, order_sn: 'SN2', escrow_final: 0, linha: 0, quantidade: 1, preco_unit: 100 }]), 0.3);

// ---------- Shopee: devoluções (nada do comprador) ----------
const SC = require('./shopee-campanhas.js');
const dv = SC.devolucaoDe({ return_sn: 123, order_sn: 'SN1', create_time: 1790000000, reason: 'CHANGE_MIND', status: 'ACCEPTED', refund_amount: 27.37,
  amount_before_discount: 38.84, needs_logistics: true, user: { username: 'nao-guardar', email: 'x@y' }, buyer_videos: ['v'],
  item: [{ name: 'Ducha', variation_sku: 'KIT-853', amount: 2, item_price: 50.96, images: ['https://img'] }] });
assert.ok(!JSON.stringify(dv).includes('nao-guardar') && !JSON.stringify(dv).includes('x@y'), 'nada do comprador');
assert.deepStrictEqual({ m: dv.motivo_nome, s: dv.situacao, r: dv.reembolso, sku: dv.itens[0].sku, q: dv.itens[0].quantidade }, { m: 'Mudou de ideia', s: 'Aceita (reembolsada)', r: 27.37, sku: 'KIT-853', q: 2 });
const rs = SC.resumoDevolucoes([dv, { ...dv, status: 'CANCELLED', reembolso: 10 }, { ...dv, motivo_nome: 'Não recebeu', reembolso: 5 }]);
assert.deepStrictEqual({ t: rs.total, a: rs.aceitas, c: rs.canceladas, r: rs.reembolsado, m: rs.por_motivo[0].motivo }, { t: 3, a: 2, c: 1, r: 32.37, m: 'Mudou de ideia' });

// ---------- canais: resumo, performance e ABC ----------
const ls = [
  { pedido: 'A', data: '2026-09-20T15:00:00.000Z', valida: true, sku: 'S1', quantidade: 1, faturamento: 100, tarifa: 20, frete: 0, produto: 30, embalagem: 0, imposto: 10, lucro: 40 },
  { pedido: 'B', data: '2026-09-21T15:00:00.000Z', valida: true, sku: 'S2', quantidade: 2, faturamento: 50, tarifa: 10, frete: 0, produto: null, embalagem: 0, imposto: 5, lucro: null },
  { pedido: 'C', data: '2026-09-22T15:00:00.000Z', valida: false, sku: 'S1', quantidade: 1, faturamento: 0, lucro: 0 }];
const s = K.somaLinhas(ls);
assert.deepStrictEqual({ p: s.pedidos, u: s.unidades, f: s.faturamento, l: s.lucro, c: s.cancelados }, { p: 2, u: 3, f: 150, l: 40, c: 1 });
assert.strictEqual(s.margem, 0.4, 'margem só sobre o que tem custo');
const abc = K.abcDe(ls, { dias: 30 });
assert.deepStrictEqual(abc.linhas.map((l) => [l.id, l.classe]), [['S1', 'A'], ['S2', 'A']], 'S2 começa em 67% do acumulado: ainda A');
assert.strictEqual(abc.linhas[1].lucro, null);
const perf = K.performanceDe(ls, 7, '2026-09-21T03:00:00.000Z');
assert.strictEqual(perf.atual.pedidos, 1); assert.strictEqual(perf.anterior.pedidos, 1);
assert.strictEqual(K.janelaVendas(1, () => ({}), Date.parse('2026-10-02T15:00:00Z')).de, '2026-10-02T03:00:00.000Z');

// ---------- Shopee: anúncios ----------
const SA = require('./shopee-anuncios.js');
const semVar = SA.registrosDe({ item_id: 5, item_name: 'Ducha', item_status: 'NORMAL', item_sku: ' KIT-801.714 ', has_model: false, has_promotion: true,
  price_info: [{ current_price: 90, original_price: 100 }], stock_info_v2: { summary_info: { total_available_stock: 7 } }, image: { image_url_list: ['https://a', 'https://b'] } });
assert.deepStrictEqual(semVar, [{ item_id: 5, nome: 'Ducha', status: 'NORMAL', imagem: 'https://a', model_id: 0, variacao: null, sku: 'KIT-801.714',
  preco: 90, preco_original: 100, promocao: true, estoque: 7 }]);
const comVar = SA.registrosDe({ item_id: 6, item_name: 'Kit', has_model: true, item_sku: 'BASE' },
  [{ model_id: 61, tier_index: [1], model_sku: 'KIT-1', price_info: [{ current_price: 50, original_price: 50 }], stock_info_v2: { summary_info: { total_available_stock: 3 } } },
   { model_id: 62, tier_index: [0], model_sku: '', price_info: [{ current_price: 40, original_price: 45 }] }],
  [{ name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'G' }] }]);
assert.deepStrictEqual(comVar.map((r) => [r.model_id, r.variacao, r.sku, r.preco]), [[61, 'G', 'KIT-1', 50], [62, 'P', 'BASE', 40]], 'variação sem SKU usa o do anúncio');
const tx = SA.taxasPorSku([{ valida: true, sku: 'A', faturamento: 100, tarifa: 20, frete: 5 }, { valida: true, sku: 'A', faturamento: 100, tarifa: 25, frete: 0 },
  { valida: true, sku: 'A', faturamento: 100, tarifa: 90, estimado: true }, { valida: false, sku: 'A', faturamento: 0, tarifa: 0 }]);
assert.strictEqual(tx.get('A'), 0.25, 'média só das vendas com repasse');

// ---------- Shopee: Ads ----------
const ads = require('./shopee-ads.js').adsDe([
  { date: '02-10-2026', expense: 10, impression: 1000, clicks: 20, broad_order: 2, broad_item_sold: 3, broad_gmv: 80, direct_order: 1, direct_gmv: 50 },
  { date: '01-10-2026', expense: 0, impression: 0, clicks: 0, broad_order: 0, broad_gmv: 0 }]);
assert.deepStrictEqual(ads.dias.map((d) => d.dia), ['2026-10-01', '2026-10-02'], 'data da Shopee (dd-mm-aaaa) vira ISO, em ordem');
assert.deepStrictEqual({ g: ads.total.gasto, v: ads.total.vendas, roas: ads.total.roas, acos: ads.total.acos, ctr: ads.total.ctr, cpc: ads.total.cpc },
  { g: 10, v: 80, roas: 8, acos: 0.125, ctr: 0.02, cpc: 0.5 });
assert.strictEqual(require('./shopee-ads.js').adsDe([]).total.roas, null, 'sem gasto: sem ROAS');

console.log('Canais e Shopee: pedidos, repasse, lucro exato, rateio, estimativa, resumo, performance e ABC: ok');
