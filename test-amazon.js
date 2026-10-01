'use strict';
// node test-amazon.js — conexão com a Amazon: validação das credenciais, nada de dados
// pessoais de comprador, diagnóstico só com a forma das respostas e nenhuma ferramenta MCP
// para a Amazon (compromissos do cadastro de desenvolvedor). Nada aqui chama a Amazon.
const assert = require('node:assert');
const A = require('./amazon.js');

// ---------- credenciais digitadas na tela ----------
const ID = 'amzn1.application-oa2-client.0123456789abcdef0123456789abcdef';
const SEG = 'amzn1.oa2-cs.v1.' + 'a'.repeat(64);
const RT = 'Atzr|' + 'IwEBI'.repeat(30);
assert.deepStrictEqual(A.validarConfig({ client_id: ` ${ID} `, client_secret: ` ${SEG} `, refresh_token: RT }),
  { client_id: ID, client_secret: SEG, refresh_token: RT });
assert.deepStrictEqual(A.validarConfig({ client_id: ID }), { client_id: ID }, 'sem segredo/token: mantém os gravados');
assert.throws(() => A.validarConfig({ client_id: 'amzn1.sp.solution.14c40350-d2b3' }), /Client ID/, 'o App ID não é o Client ID');
assert.throws(() => A.validarConfig({ client_id: ID, client_secret: 'segredo' }), /Client Secret/);
assert.throws(() => A.validarConfig({ client_id: ID, refresh_token: 'Atzr|curto' }), /Refresh Token/);
assert.throws(() => A.validarConfig({ client_id: ID, refresh_token: 'Atzr|' + 'x'.repeat(50) + ' y' }), /Refresh Token/);

// ---------- dados pessoais do comprador nunca saem do módulo ----------
const pedido = { AmazonOrderId: '701-1', OrderStatus: 'Shipped', BuyerInfo: { BuyerEmail: 'x@y' },
  ShippingAddress: { City: 'São Paulo', PostalCode: '01000-000' }, OrderTotal: { CurrencyCode: 'BRL', Amount: '99.90' },
  Itens: [{ BuyerName: 'Fulano', ASIN: 'B0' }] };
const limpo = A.semPessoais(pedido);
assert.ok(!JSON.stringify(limpo).match(/Buyer|Shipping|São Paulo|Fulano|01000/), 'sem comprador nem endereço');
assert.strictEqual(limpo.OrderTotal.Amount, '99.90');
assert.strictEqual(limpo.Itens[0].ASIN, 'B0');

// ---------- forma: campos e tipos, sem valores (só o vocabulário da API aparece) ----------
const f = A.forma({ AmazonOrderId: '701-1', OrderStatus: 'Shipped', FulfillmentChannel: 'AFN', PurchaseDate: '2026-09-30T10:00:00Z',
  OrderTotal: { CurrencyCode: 'BRL', Amount: '99.90' }, NumberOfItemsShipped: 2, IsPrime: false,
  ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyCode: 'BRL', CurrencyAmount: -15 } }, { FeeType: 'FixedClosingFee' }] });
assert.deepStrictEqual(f, { AmazonOrderId: 'texto', OrderStatus: 'Shipped', FulfillmentChannel: 'AFN', PurchaseDate: 'data',
  OrderTotal: { CurrencyCode: 'BRL', Amount: 'número (texto)' }, NumberOfItemsShipped: 'número', IsPrime: false,
  ItemFeeList: { lista: 2, primeiro: { FeeType: 'Commission', FeeAmount: { CurrencyCode: 'BRL', CurrencyAmount: 'número' } } } });
assert.ok(!JSON.stringify(f).includes('701-1') && !JSON.stringify(f).includes('99.90'), 'nenhum valor da conta');
assert.deepStrictEqual(A.forma([]), { lista: 0 });

// ---------- vocabulário de toda a resposta (tipos de taxa) e listas com eventos ----------
const fin = { ShipmentEventList: [
  { AmazonOrderId: '701-1', ShipmentItemList: [{ ItemFeeList: [{ FeeType: 'Commission', FeeAmount: { CurrencyCode: 'BRL', CurrencyAmount: -9 } },
    { FeeType: 'FBAPerUnitFulfillmentFee' }] }] },
  { ShipmentItemList: [{ ItemFeeList: [{ FeeType: 'Commission' }], ItemChargeList: [{ ChargeType: 'Principal' }] }] }],
  RefundEventList: [], ServiceFeeEventList: [{ FeeList: [{ FeeType: 'Subscription' }] }] };
assert.deepStrictEqual(A.vocabulario(fin), { FeeType: { Commission: 2, FBAPerUnitFulfillmentFee: 1, Subscription: 1 }, ChargeType: { Principal: 1 } });
assert.deepStrictEqual(A.listasCheias(fin), { ShipmentEventList: 2, ServiceFeeEventList: 1 });
assert.deepStrictEqual(A.vocabulario([{ transactionType: 'Shipment', breakdowns: [{ breakdownType: 'AmazonFees' }] }]),
  { transactionType: { Shipment: 1 }, breakdownType: { AmazonFees: 1 } });

// ---------- lançamentos financeiros -> linhas de venda ----------
const BRL = (v) => ({ CurrencyCode: 'BRL', CurrencyAmount: v });
const lanc = A.lancamentosDe({
  ShipmentEventList: [
    { AmazonOrderId: '701-A', PostedDate: '2026-09-20T15:00:00Z', ShipmentItemList: [{ SellerSKU: 'KIT-407.408', OrderItemId: '11', QuantityShipped: 2,
      ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: BRL(200) }, { ChargeType: 'Tax', ChargeAmount: BRL(10) }, { ChargeType: 'ShippingCharge', ChargeAmount: BRL(0) }],
      ItemFeeList: [{ FeeType: 'Commission', FeeAmount: BRL(-30) }, { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: BRL(-12.5) }],
      PromotionList: [{ PromotionType: 'X', PromotionAmount: BRL(-20) }] }] },
    { AmazonOrderId: '701-B', PostedDate: '2026-09-21T15:00:00Z', ShipmentItemList: [{ SellerSKU: 'DQ-407', OrderItemId: '12', QuantityShipped: 1,
      ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: BRL(100) }],
      ItemFeeList: [{ FeeType: 'Commission', FeeAmount: BRL(-15) }, { FeeType: 'MFNPostageFee', FeeAmount: BRL(-18) }] }] }],
  RefundEventList: [{ AmazonOrderId: '701-B', PostedDate: '2026-09-25T15:00:00Z', ShipmentItemAdjustmentList: [{ SellerSKU: 'DQ-407', OrderAdjustmentItemId: '99', QuantityShipped: 1,
    ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: BRL(-100) }],
    ItemFeeAdjustmentList: [{ FeeType: 'Commission', FeeAmount: BRL(15) }, { FeeType: 'RefundCommission', FeeAmount: BRL(-3) }] }] }],
  AdjustmentEventList: [{ AdjustmentType: 'WAREHOUSE_DAMAGE', PostedDate: '2026-09-26T10:00:00Z', AdjustmentAmount: BRL(45) }],
});
assert.strictEqual(lanc.length, 4);
const [vA, vB, rB, aj] = lanc;
assert.deepStrictEqual({ tipo: vA.tipo, sku: vA.sku, q: vA.quantidade, canal: vA.canal, receita: vA.receita, tarifa: vA.tarifa, frete: vA.frete, imp: vA.imposto_cobrado, fixa: vA.tarifa_fixa },
  { tipo: 'venda', sku: 'KIT-407.408', q: 2, canal: 'FBA', receita: 180, tarifa: 42.5, frete: 0, imp: 10, fixa: 12.5 }, 'promoção desconta da receita; imposto cobrado fica à parte; FBA é a parte fixa');
assert.deepStrictEqual({ canal: vB.canal, tarifa: vB.tarifa, frete: vB.frete }, { canal: 'proprio', tarifa: 15, frete: 18 }, 'etiqueta do envio próprio é frete');
assert.deepStrictEqual({ tipo: rB.tipo, receita: rB.receita, tarifa: rB.tarifa }, { tipo: 'reembolso', receita: -100, tarifa: -12 }, 'comissão estornada menos a taxa de reembolso');
assert.deepStrictEqual({ tipo: aj.tipo, receita: aj.receita, sku: aj.sku }, { tipo: 'ajuste', receita: 45, sku: null });
assert.strictEqual(A.lancamentosDe(null).length, 0);
assert.strictEqual(new Set(lanc.map((l) => l.chave)).size, 4, 'cada lançamento tem chave própria');
assert.deepStrictEqual(A.lancamentosDe({ ShipmentEventList: [{ AmazonOrderId: '1', PostedDate: '2026-09-20T15:00:00Z', ShipmentItemList: [{ OrderItemId: '1', QuantityShipped: 1 }] }] })[0].chave,
  lanc.length && A.lancamentosDe({ ShipmentEventList: [{ AmazonOrderId: '1', PostedDate: '2026-09-20T15:00:00.000Z', ShipmentItemList: [{ OrderItemId: '1', QuantityShipped: 1 }] }] })[0].chave,
  'a mesma data escrita de outro jeito é o mesmo lançamento (não duplica)');

// ---------- lucro de cada lançamento ----------
const ctx = { embalagem_unit: 2, imposto_pct: 10 };
assert.deepStrictEqual(A.contaDoLancamento(vA, { ...ctx, custo_unit: 40 }),
  { faturamento: 180, tarifa: 42.5, frete: 0, produto: 80, embalagem: 0, imposto: 18, lucro: 39.5, margem: 39.5 / 180 },
  'FBA: a embalagem já foi no envio ao armazém (não soma de novo)');
assert.strictEqual(A.contaDoLancamento(vB, { ...ctx, custo_unit: 30 }).lucro, 100 - 15 - 18 - 30 - 2 - 10, 'envio próprio soma a embalagem');
assert.strictEqual(A.contaDoLancamento(vB, { ...ctx, custo_unit: null }).lucro, null, 'sem custo: sem lucro');
const cR = A.contaDoLancamento(rB, ctx);
assert.deepStrictEqual({ produto: cR.produto, lucro: cR.lucro }, { produto: 0, lucro: -100 + 12 + 10 }, 'reembolso: devolve a receita, estorna taxa e imposto; produto volta');
assert.strictEqual(A.contaDoLancamento(aj, ctx).lucro, 45, 'ajuste: tudo lucro, sem imposto');

// ---------- resumo no formato das contas ----------
const linhasC = [{ ...vA, ...A.contaDoLancamento(vA, { ...ctx, custo_unit: 40 }) }, { ...vB, ...A.contaDoLancamento(vB, { ...ctx, custo_unit: null }) },
  { ...rB, ...A.contaDoLancamento(rB, ctx) }, { ...aj, ...A.contaDoLancamento(aj, ctx) }];
const res = A.resumoAmazon(linhasC);
assert.strictEqual(res.pedidos, 2); assert.strictEqual(res.unidades, 3);
assert.strictEqual(res.faturamento, 180 + 100 - 100 + 45);
assert.strictEqual(res.reembolsos, -100); assert.strictEqual(res.ajustes, 45);
assert.strictEqual(res.lucro, Math.round((39.5 - 78 + 45) * 100) / 100, 'a venda sem custo fica fora do lucro');
assert.ok(res.cobertura > 0 && res.cobertura <= 1);

// ---------- pedidos (data da compra) ----------
const ped = A.pedidoDe({ AmazonOrderId: '702-1', PurchaseDate: '2026-09-30T12:00:00Z', OrderStatus: 'Shipped', FulfillmentChannel: 'AFN',
  OrderTotal: { CurrencyCode: 'BRL', Amount: '150.00' }, LastUpdateDate: '2026-09-30T13:00:00Z', BuyerInfo: { BuyerEmail: 'x' } });
assert.deepStrictEqual(ped, { pedido: '702-1', data: '2026-09-30T12:00:00.000Z', status: 'Shipped', canal: 'FBA', total: 150, atualizado: '2026-09-30T13:00:00Z' });
assert.strictEqual(A.pedidoDe({ AmazonOrderId: 'x', PurchaseDate: '2026-09-30T12:00:00Z', FulfillmentChannel: 'MFN' }).canal, 'proprio');
assert.strictEqual(A.pedidoDe({ AmazonOrderId: 'x', PurchaseDate: '2026-09-30T12:00:00Z' }).total, null, 'pendente: sem total');
assert.deepStrictEqual(A.itemDe({ OrderItemId: 55, SellerSKU: 'KIT-801.714', ASIN: 'B0X', QuantityOrdered: 2, ItemPrice: { Amount: '160.00' },
  ShippingPrice: { Amount: '10.00' }, PromotionDiscount: { Amount: '5.00' }, ShippingDiscount: { Amount: '10.00' } }),
  { item_id: '55', sku: 'KIT-801.714', asin: 'B0X', quantidade: 2, preco: 160, frete_cobrado: 10, desconto: 15 });

// janela: hoje desde 00h de Brasília; período = dias completos + hoje
const agoraT = Date.parse('2026-10-01T15:00:00Z');
assert.strictEqual(A.janelaVendas(1, () => ({}), agoraT).de, '2026-10-01T03:00:00.000Z');
assert.strictEqual(A.janelaVendas(30, () => ({ de: 'D' }), agoraT).de, 'D');

// taxas lançadas e médias para estimar
const tx = A.taxasDosLancamentos([
  { tipo: 'venda', pedido: 'P1', sku: 'S1', canal: 'FBA', quantidade: 1, receita: 100, tarifa: 20, frete: 0 },
  { tipo: 'venda', pedido: 'P2', sku: 'S1', canal: 'FBA', quantidade: 1, receita: 100, tarifa: 10, frete: 0 },
  { tipo: 'venda', pedido: 'P3', sku: 'S2', canal: 'proprio', quantidade: 2, receita: 200, tarifa: 30, frete: 20 },
  { tipo: 'reembolso', pedido: 'P3', sku: 'S2', canal: 'proprio', quantidade: 2, receita: -200, tarifa: -25, frete: 0 },
  { tipo: 'ajuste', pedido: null, sku: null, quantidade: 0, receita: 50, tarifa: 0, frete: 0 }]);
assert.deepStrictEqual(tx.mediaSku('S1'), { tarifa_pct: 0.15, fixa_un: 0, frete_un: 0 });
assert.deepStrictEqual(tx.mediaCanal('proprio'), { tarifa_pct: 0.15, fixa_un: 0, frete_un: 10 });
// tarifa do FBA é por unidade: não vira porcentagem do preço
const txF = A.taxasDosLancamentos([{ tipo: 'venda', pedido: 'F1', sku: 'SF', canal: 'FBA', quantidade: 2, receita: 200, tarifa: 50, tarifa_fixa: 20, frete: 0 }]);
assert.deepStrictEqual(txF.mediaSku('SF'), { tarifa_pct: 0.15, fixa_un: 10, frete_un: 0 });
assert.strictEqual(A.linhaDoPedido({ pedido: 'F9', sku: 'SF', canal: 'FBA', status: 'Unshipped', quantidade: 1, preco: 300, frete_cobrado: 0, desconto: 0 },
  { taxas: txF, custo_unit: 10, imposto_pct: 0 }).tarifa, 300 * 0.15 + 10, 'estimada = comissão % + FBA por unidade');
assert.strictEqual(tx.mediaSku('nenhum'), null);

const ctxP = { taxas: tx, custo_unit: 30, embalagem_unit: 2, imposto_pct: 10 };
// lançado: taxa real
const lP1 = A.linhaDoPedido({ pedido: 'P1', sku: 'S1', canal: 'FBA', status: 'Shipped', quantidade: 1, preco: 100, frete_cobrado: 0, desconto: 0 }, ctxP);
assert.deepStrictEqual({ fat: lP1.faturamento, tarifa: lP1.tarifa, lucro: lP1.lucro, est: lP1.estimado }, { fat: 100, tarifa: 20, lucro: 100 - 20 - 30 - 10, est: false });
// ainda não lançado: média do SKU, marcada como estimada
const lN = A.linhaDoPedido({ pedido: 'P9', sku: 'S1', canal: 'FBA', status: 'Unshipped', quantidade: 2, preco: 200, frete_cobrado: 0, desconto: 0 }, ctxP);
assert.deepStrictEqual({ tarifa: lN.tarifa, est: lN.estimado, produto: lN.produto }, { tarifa: 30, est: true, produto: 60 });
// SKU sem histórico: média do canal
assert.strictEqual(A.linhaDoPedido({ pedido: 'P8', sku: 'S7', canal: 'proprio', status: 'Unshipped', quantidade: 1, preco: 100, frete_cobrado: 0, desconto: 0 }, ctxP).frete, 10);
// reembolso total: faturamento zera, produto volta, taxa estornada
const lR = A.linhaDoPedido({ pedido: 'P3', sku: 'S2', canal: 'proprio', status: 'Shipped', quantidade: 2, preco: 200, frete_cobrado: 0, desconto: 0 }, ctxP);
assert.deepStrictEqual({ fat: lR.faturamento, prod: lR.produto, tarifa: lR.tarifa, dev: lR.devolvido, emb: lR.embalagem }, { fat: 0, prod: 0, tarifa: 5, dev: true, emb: 4 });
// cancelado: não entra no custo
const lC = A.linhaDoPedido({ pedido: 'P7', sku: 'S1', canal: 'FBA', status: 'Canceled', quantidade: 1, preco: null, frete_cobrado: 0, desconto: 0 }, ctxP);
assert.deepStrictEqual({ valida: lC.valida, fat: lC.faturamento, prod: lC.produto }, { valida: false, fat: 0, prod: 0 });
// sem custo: sem lucro
assert.deepStrictEqual(A.linhaDoPedido({ pedido: 'P1', sku: 'S1', canal: 'FBA', status: 'Shipped', quantidade: 1, preco: 100 }, { ...ctxP, custo_unit: null }).falta, ['custo']);

// ---------- concorrentes de um ASIN ----------
const of = A.ofertasDe({ ASIN: 'B0TESTE001', Summary: { TotalOfferCount: 3 }, Offers: [
  { SellerId: 'OUTRO1', ListingPrice: { Amount: 99.9 }, Shipping: { Amount: 0 }, IsFulfilledByAmazon: true, IsBuyBoxWinner: true,
    SellerFeedbackRating: { SellerPositiveFeedbackRating: 95, FeedbackCount: 1200 }, PrimeInformation: { IsPrime: true } },
  { SellerId: 'EU', ListingPrice: { Amount: 104.9 }, Shipping: { Amount: 0 }, IsFulfilledByAmazon: true, IsBuyBoxWinner: false },
  { SellerId: 'OUTRO2', ListingPrice: { Amount: 89.9 }, Shipping: { Amount: 15 }, IsFulfilledByAmazon: false, IsBuyBoxWinner: false }] }, 'EU');
assert.deepStrictEqual(of.ofertas.map((o) => o.total), [99.9, 104.9, 104.9], 'ordem pelo preço com frete');
assert.strictEqual(of.destaque.total, 99.9); assert.strictEqual(of.voce_destaque, false);
assert.strictEqual(of.menor_outro.total, 99.9, 'o nosso não conta como concorrente');
assert.strictEqual(of.ofertas.find((o) => o.voce).preco, 104.9);
assert.strictEqual(of.ofertas[0].vendedor_id, 'OUTRO1', 'o código do concorrente vai para o link da loja dele');
assert.strictEqual(of.ofertas.find((o) => o.voce).vendedor_id, null, 'o nosso não precisa de link');
assert.strictEqual(A.ofertasDe(null, 'EU').ofertas.length, 0);

// ---------- nenhuma ferramenta MCP chega à Amazon ----------
// (lido como texto: carregar o mcp.js abriria o banco real)
const fonteMcp = require('node:fs').readFileSync(require.resolve('./mcp.js'), 'utf8');
assert.ok(!/api\/amazon|amazon\.js/i.test(fonteMcp), 'nenhuma ferramenta do MCP aponta para a Amazon');

console.log('Amazon: credenciais, sem dados pessoais, forma sem valores e fora do MCP: ok');
