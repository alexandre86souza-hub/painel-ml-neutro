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
assert.deepStrictEqual(rep, { final: true, recebido: 70, comissao: 14, servico: 6, transacao: 2, frete_vendedor: 8, cupom_vendedor: 0, devolucao: 0, frete_shopee: 12 });
assert.strictEqual(SV.repasseDe({ order_income: { escrow_amount: 10 } }, 'SHIPPED').final, false, 'antes de concluído: provisório');

// ---------- Shopee: linhas de venda ----------
const mapa = new Map([[407, { numero: 407, sku: 'DQ-407', nome: 'Ducha', custo: 10 }], [408, { numero: 408, sku: 'BR-408', nome: 'Braço', custo: 5 }]]);
const base = { order_sn: 'SN1', data: '2026-09-30T12:00:00.000Z', status: 'COMPLETED', escrow_final: 1, recebido: 70, frete_vendedor: 8, devolucao: 0 };
const ctx = { mapa, imposto_pct: 10, embalagem_pedido: 1, proporcao: 0.25 };
const [l1] = SV.linhasDe([{ ...base, linha: 0, sku: 'KIT-407.408', quantidade: 2, preco_unit: 50, nome: 'Kit' }], ctx);
assert.deepStrictEqual({ fat: l1.faturamento, tarifa: l1.tarifa, frete: l1.frete, produto: l1.produto, emb: l1.embalagem, imp: l1.imposto, lucro: l1.lucro, est: l1.estimado },
  { fat: 100, tarifa: 30, frete: 0, produto: 30, emb: 1, imp: 10, lucro: 29, est: false }, 'lucro = recebido − produto − embalagem − imposto');
assert.strictEqual(l1.lucro, 70 - 30 - 1 - 10, 'embalagem: uma por pedido, não por unidade');
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
  { tarifa: 30, frete: 0.11, lucro: 28.89, propria: true, fs: 7.89, ce: 8 }, 'lucro = recebido − entrega − custos');
const [e2] = SV.linhasDe([ed], ctx);
assert.deepStrictEqual({ falta: e2.falta, lucro: e2.lucro }, { falta: ['entrega'], lucro: null }, 'sem o custo da entrega: lucro pendente');
const [e3] = SV.linhasDe([{ ...ed, recebido: null, escrow_final: 0 }], { ...ctx, entrega_propria: 8, frete_medio: { 'Entrega Direta': 7.5 } });
assert.deepStrictEqual({ tarifa: e3.tarifa, frete: e3.frete, est: e3.estimado }, { tarifa: 25, frete: 0.5, est: true }, 'sem repasse: frete médio da transportadora');
assert.deepStrictEqual(SV.freteMedioDe([{ ...ed }, { ...ed, order_sn: 'SN9', frete_shopee: 8.11 }, { ...ed, order_sn: 'SN8', escrow_final: 0, frete_shopee: 99 }]), { 'Entrega Direta': 8 });
// taxa fixa (Shopee) = taxa de serviço − transação (2%; 1,4% desde 01/10/2026 em Brasília). Pedidos reais:
assert.strictEqual(SV.taxaFixaDe(93.73, 686.44, '2026-09-30T10:47:31.000Z'), 80, '4 unidades de R$ 171,61: 4 × R$ 20');
assert.strictEqual(SV.taxaFixaDe(22.09, 104.54, '2026-05-18T12:00:00.000Z'), 20, 'a lista da Shopee dizia 14,86');
assert.strictEqual(SV.taxaFixaDe(23.33, 166.71, '2026-10-01T01:12:17.000Z'), 20, '30/09 22h em Brasília: ainda 2%');
assert.strictEqual(SV.taxaFixaDe(5.31, 58.18, '2026-10-01T18:37:51.000Z'), 4.5, '01/10: 1,4% e R$ 4,50');
assert.strictEqual(SV.taxaFixaDe(29.33, 237.94, '2026-10-04T12:00:00.000Z'), 26);
assert.strictEqual(SV.taxaFixaDe(null, 100, '2026-10-04T12:00:00.000Z'), null);
assert.strictEqual(SV.taxaFixaDe(0, 100, '2026-10-04T12:00:00.000Z'), 0, 'reembolsado: sem taxa');
const [tf] = SV.linhasDe([{ ...base, servico: 22, linha: 0, sku: 'DQ-407', quantidade: 1, preco_unit: 100 }], ctx);
assert.strictEqual(tf.taxa_fixa, 20);
assert.strictEqual(K.somaLinhas([tf]).taxa_fixa, 20);
// proporção média: só pedidos com repasse final e sem devolução
assert.strictEqual(SV.proporcaoDe([{ ...base, linha: 0, quantidade: 2, preco_unit: 50 }, { ...base, order_sn: 'SN2', escrow_final: 0, linha: 0, quantidade: 1, preco_unit: 100 }]), 0.3);

// ---------- Shopee: criar campanhas (só os corpos; nada chama a Shopee) ----------
const SCx = require('./shopee-campanhas.js');
const agoraT = Date.parse('2026-10-06T12:00:00Z');
const daqui = (h) => new Date(agoraT + h * 3600e3).toISOString();
assert.deepStrictEqual(SCx.periodoValido(daqui(2), daqui(26), { maxDias: 180, agora: agoraT }), { start_time: agoraT / 1000 + 7200, end_time: agoraT / 1000 + 26 * 3600 });
assert.throws(() => SCx.periodoValido(daqui(0.5), daqui(26), { maxDias: 180, agora: agoraT }), /1 hora a partir de agora/);
assert.throws(() => SCx.periodoValido(daqui(2), daqui(2.5), { maxDias: 180, agora: agoraT }), /1 hora depois/);
assert.throws(() => SCx.periodoValido(daqui(2), daqui(2 + 24 * 181), { maxDias: 180, agora: agoraT }), /180 dias/);
const grupos = SCx.agruparItens([{ item_id: 1, preco: 10.004, limite: 2 }, { item_id: 2, model_id: 21, preco: 20 }, { item_id: 2, model_id: 22, preco: 25 }]);
assert.deepStrictEqual(SCx.itensDesconto(grupos), [
  { item_id: 1, purchase_limit: 2, item_promotion_price: 10 },
  { item_id: 2, purchase_limit: 0, model_list: [{ model_id: 21, model_promotion_price: 20 }, { model_id: 22, model_promotion_price: 25 }] }]);
assert.throws(() => SCx.agruparItens([{ item_id: 1, preco: 0 }]), /preço promocional/);
assert.throws(() => SCx.agruparItens([]), /pelo menos um/);
assert.throws(() => SCx.itensRelampago(grupos), /estoque/);
assert.deepStrictEqual(SCx.itensRelampago(SCx.agruparItens([{ item_id: 1, preco: 9, estoque: 5, limite: 1 }])),
  [{ item_id: 1, purchase_limit: 1, item_input_promo_price: 9, item_stock: 5 }]);
const cup = SCx.corpoCupom({ nome: 'Volta', codigo: 'kit10', inicio: daqui(2), fim: daqui(48), desconto: 'pct', valor: '10', maximo: '30', minimo: '100', quantidade: 50 }, agoraT);
assert.deepStrictEqual({ c: cup.voucher_code, t: cup.voucher_type, r: cup.reward_type, p: cup.percentage, m: cup.max_price, b: cup.min_basket_price, q: cup.usage_quantity, ch: cup.display_channel_list },
  { c: 'KIT10', t: 1, r: 2, p: 10, m: 30, b: 100, q: 50, ch: [1] });
const cupP = SCx.corpoCupom({ nome: 'X', codigo: 'A1', inicio: daqui(2), fim: daqui(48), tipo: 'produtos', itens: [5, '5', 6], desconto: 'valor', valor: '15', minimo: '50', quantidade: 10 }, agoraT);
assert.deepStrictEqual({ t: cupP.voucher_type, i: cupP.item_id_list, r: cupP.reward_type, d: cupP.discount_amount }, { t: 2, i: [5, 6], r: 1, d: 15 });
assert.throws(() => SCx.corpoCupom({ nome: 'X', codigo: 'LONGO1', inicio: daqui(2), fim: daqui(48), valor: 5, quantidade: 1 }, agoraT), /1 a 5/);
assert.throws(() => SCx.corpoCupom({ nome: 'X', codigo: 'A', inicio: daqui(2), fim: daqui(48), valor: 60, minimo: 50, quantidade: 1 }, agoraT), /menor que a compra mínima/);
// métricas: só as linhas da campanha, por anúncio
const lm = [
  { valida: true, pedido: 'P1', shopee_item: 7, sku: 'S7', titulo: 'A', quantidade: 2, faturamento: 100, lucro: 20, data: '2026-09-02', cupom: 0 },
  { valida: true, pedido: 'P2', shopee_item: 8, sku: 'S8', titulo: 'B', quantidade: 1, faturamento: 300, lucro: null, data: '2026-09-03', cupom: 5 },
  { valida: true, pedido: 'P3', shopee_item: 7, sku: 'S7', titulo: 'A', quantidade: 1, faturamento: 50, lucro: 10, data: '2026-09-04', cupom: 0 },
  { valida: false, pedido: 'P4', shopee_item: 7, sku: 'S7', quantidade: 9, faturamento: 999, lucro: 0, data: '2026-09-04' }];
const mt = SCx.metricasDe(lm, () => true);
assert.deepStrictEqual(mt.resumo, { pedidos: 3, unidades: 4, faturamento: 450, lucro: 30, margem: 0.2, cupom: 5 });
assert.deepStrictEqual(mt.anuncios.map((a) => [a.sku, a.pedidos, a.faturamento, a.lucro]), [['S8', 1, 300, null], ['S7', 2, 150, 30]]);

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

// mês do calendário (Brasília): este mês até agora, mês passado inteiro; virada de ano
{
  const ag = Date.parse('2026-10-08T15:00:00Z');
  const at = K.janelaDoMes('atual', ag), an = K.janelaDoMes('anterior', ag);
  assert.deepStrictEqual([at.de, at.dias, at.rotulo], ['2026-10-01T03:00:00.000Z', 8, 'outubro/2026']);
  assert.deepStrictEqual([an.de, an.ate, an.dias, an.rotulo], ['2026-09-01T03:00:00.000Z', '2026-10-01T03:00:00.000Z', 30, 'setembro/2026']);
  const jan = K.janelaDoMes('anterior', Date.parse('2027-01-01T02:00:00Z'));   // 31/12 23h de Brasília: ainda dezembro
  assert.strictEqual(jan.rotulo, 'novembro/2026');
  assert.strictEqual(K.janelaDoMes('anterior', Date.parse('2027-01-01T04:00:00Z')).rotulo, 'dezembro/2026');
  const u = new URL('http://x/?mes=anterior');
  assert.strictEqual(K.periodoDoPedido(u, [30], () => ({}), 30, ag).rotulo, 'setembro/2026');
  assert.strictEqual(K.periodoDoPedido(new URL('http://x/?dias=7'), [7, 30], (d) => ({ de: 'x', dias: d }), 30, ag).dias, 7);
}

console.log('Canais e Shopee: pedidos, repasse, lucro exato, rateio, estimativa, resumo, performance e ABC: ok');
