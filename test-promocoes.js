'use strict';
// node test-promocoes.js — promoções (entrar, sair, de qual promoção veio a venda) e o custo
// das devoluções. Só funções puras: nada aqui chama o Mercado Livre.
const assert = require('node:assert');
const P = require('./promocoes.js');
const { custoDa, dinheiroDoPagamento, ligarCreditos } = require('./devolucoes.js');

// ---------- entrar numa promoção: o corpo muda por tipo ----------
assert.deepStrictEqual(
  P.corpoAdesao({ tipo: 'DEAL', promocao_id: 'P-MLB18061082', preco: '57.819', preco_original: 60.87 }),
  { promotion_type: 'DEAL', promotion_id: 'P-MLB18061082', deal_price: 57.82 });
assert.deepStrictEqual(
  P.corpoAdesao({ tipo: 'SMART', promocao_id: 'P-MLB17937078', oferta_id: 'CANDIDATE-MLB971729316-77287056890' }),
  { promotion_type: 'SMART', promotion_id: 'P-MLB17937078', offer_id: 'CANDIDATE-MLB971729316-77287056890' });
assert.deepStrictEqual(
  P.corpoAdesao({ tipo: 'LIGHTNING', promocao_id: 'LGH-MLB1000', preco: 51.74, estoque: 5 }),
  { promotion_type: 'LIGHTNING', promotion_id: 'LGH-MLB1000', deal_price: 51.74, stock: 5 });
const pd = P.corpoAdesao({ tipo: 'PRICE_DISCOUNT', preco: 40, inicio: '2026-10-01T00:00:00-03:00', fim: '2026-10-10T23:59:00-03:00' });
assert.strictEqual(pd.promotion_id, undefined, 'desconto próprio não tem id de promoção');
assert.strictEqual(pd.start_date, '2026-10-01T03:00:00');
assert.strictEqual(pd.finish_date, '2026-10-11T02:59:00');

assert.throws(() => P.corpoAdesao({ tipo: 'DEAL', promocao_id: 'P-MLB1', preco: 70, preco_original: 60 }), /menor que o preço atual/);
assert.throws(() => P.corpoAdesao({ tipo: 'DEAL', promocao_id: 'P-MLB1' }), /preço promocional/);
assert.throws(() => P.corpoAdesao({ tipo: 'SMART', promocao_id: 'P-MLB1' }), /offer_id/);
assert.throws(() => P.corpoAdesao({ tipo: 'LIGHTNING', promocao_id: 'LGH-MLB1000', preco: 10 }), /unidades/);
assert.throws(() => P.corpoAdesao({ tipo: 'PRICE_DISCOUNT', preco: 10, inicio: '2026-10-10', fim: '2026-10-01' }), /fim depois/);
assert.throws(() => P.corpoAdesao({ tipo: 'DEAL', promocao_id: '../users/me', preco: 1 }), /promoção inválido/);
assert.throws(() => P.corpoAdesao({ tipo: 'deal;drop', promocao_id: 'P-MLB1' }), /tipo de promoção inválido/);


// desconto próprio em datas de calendário (tela "Criar promoção"): dia inteiro, até 14 dias, 5% a 80%
assert.deepStrictEqual(P.corpoAdesao({ tipo: 'PRICE_DISCOUNT', preco: 90, preco_original: 100, inicio: '2026-10-01', fim: '2026-10-14' }),
  { promotion_type: 'PRICE_DISCOUNT', deal_price: 90, start_date: '2026-10-01T00:00:00', finish_date: '2026-10-14T23:59:59' });
assert.throws(() => P.corpoAdesao({ tipo: 'PRICE_DISCOUNT', preco: 90, preco_original: 100, inicio: '2026-10-01', fim: '2026-10-15' }), /14 dias/);
assert.throws(() => P.corpoAdesao({ tipo: 'PRICE_DISCOUNT', preco: 97, preco_original: 100, inicio: '2026-10-01', fim: '2026-10-05' }), /entre 5% e 80%/);

// ---------- sair ----------
assert.strictEqual(P.querySaida({ tipo: 'DEAL', promocao_id: 'P-MLB18061082' }),
  'promotion_type=DEAL&promotion_id=P-MLB18061082&app_version=v2');
assert.strictEqual(P.querySaida({ tipo: 'SMART', promocao_id: 'P-MLB17937078', oferta_id: 'OFFER-MLB2735516721-13751826706' }),
  'promotion_type=SMART&promotion_id=P-MLB17937078&offer_id=OFFER-MLB2735516721-13751826706&app_version=v2');
assert.strictEqual(P.querySaida({ tipo: 'PRICE_DISCOUNT' }), 'promotion_type=PRICE_DISCOUNT&app_version=v2');
assert.throws(() => P.querySaida({ tipo: 'SMART', promocao_id: 'P-MLB1', oferta_id: 'x&promotion_type=DEAL' }), /offer_id inválido/);

// ---------- de qual promoção veio a venda (/orders/{id}/discounts real, 28/09/2026) ----------
assert.deepStrictEqual(P.linhasDoDesconto({ details: [{ type: 'discount',
  items: [{ element_id: 1, quantity: 2, id: 'MLB4649426984', amounts: { total: 22.94, seller: 14.48 } }],
  supplier: { offer_id: 'OFFER-MLB4649426984-13751825575', funding_mode: 'sale_fee' } }] }),
[{ item_id: 'MLB4649426984', oferta_id: 'OFFER-MLB4649426984-13751825575', financiamento: 'sale_fee',
  desconto_total: 22.94, desconto_vendedor: 14.48 }]);
// cupom: sem oferta e sem funding_mode
assert.deepStrictEqual(P.linhasDoDesconto({ details: [{ coupon: { id: 1 }, type: 'coupon',
  items: [{ id: 'MLB3942365539', amounts: { seller: 0, total: 0.33 } }], supplier: { campaign_id: 1 } }] }),
[{ item_id: 'MLB3942365539', oferta_id: null, financiamento: 'coupon', desconto_total: 0.33, desconto_vendedor: 0 }]);
// dois descontos na mesma linha: soma os valores, fica a oferta do maior
const dois = P.linhasDoDesconto({ details: [
  { type: 'coupon', items: [{ id: 'MLB1', amounts: { total: 1, seller: 0 } }], supplier: {} },
  { type: 'discount', items: [{ id: 'MLB1', amounts: { total: 9, seller: 5 } }], supplier: { offer_id: 'OFFER-MLB1-2', funding_mode: 'seller' } },
] });
assert.deepStrictEqual(dois, [{ item_id: 'MLB1', oferta_id: 'OFFER-MLB1-2', financiamento: 'seller', desconto_total: 10, desconto_vendedor: 5 }]);
assert.deepStrictEqual(P.linhasDoDesconto(null), [], 'pedido sem desconto (404) grava zero linhas');

// ---------- resultado ----------
const r = P.montarResultado([
  { promocao_id: 'P-1', tipo: 'SMART', nome: 'Impulsione', pedidos: 3, unidades: 4, faturamento: 300, desconto_total: 30, desconto_vendedor: 20 },
  { promocao_id: null, tipo: null, pedidos: 1, unidades: 1, faturamento: 100, desconto_total: 0, desconto_vendedor: 0 },
  { promocao_id: null, tipo: 'CUPOM', pedidos: 1, unidades: 1, faturamento: 0, desconto_total: 1, desconto_vendedor: 0 },
]);
assert.strictEqual(r[0].retorno, 15);
assert.strictEqual(r[0].desconto_ml, 10);
assert.strictEqual(r[0].participacao, 0.75);
assert.strictEqual(r[1].tipo_nome, 'Sem promoção');
assert.strictEqual(r[1].retorno, null, 'sem desconto do vendedor não tem retorno');
assert.strictEqual(r[2].tipo_nome, 'Cupom');

// ---------- lucro no preço da promoção ----------
// Venda real de 28/09/2026 (SMART, meli 1,1%): tarifa cheia no preço promocional 22,48; o ML
// cobrou 19,86. Com 1,1% de 231,22 = 2,54 de parte do ML, a conta dá 19,93 (diferença de 7
// centavos: o ML arredonda a parte dele sobre o valor exato do desconto).
const lp = P.lucroNoPreco({ preco: 214.05, precoOriginal: 231.22, meliPct: 1.1, tarifa: { pct: 10.5, fixa: 0 },
  custo: 93.97, embalagem: 0, frete: 27.05, impostoPct: 10 });
assert.strictEqual(lp.tarifa, 19.93);
assert.strictEqual(lp.parte_ml, 2.54);
assert.strictEqual(lp.lucro, 51.69);   // 214,05 − 19,93 − 21,41 − 27,05 − 93,97
assert.deepStrictEqual(P.lucroNoPreco({ preco: 100, tarifa: { pct: 12 }, custo: null, frete: 5 }).falta, ['custo']);
assert.strictEqual(P.lucroNoPreco({ preco: 100, tarifa: { pct: 12 }, custo: 10, frete: null }).lucro, null, 'sem frete não inventa lucro');

// ---------- filtro "desconto até X%" e "lucro mínimo Y%" (Promoções por anúncio) ----------
const cand = { status: 'candidate', preco: 90, preco_original: 100, margem: 0.2 };
assert.strictEqual(P.descontoDaPromo(cand, 100).toFixed(2), '0.10');
assert.strictEqual(P.descontoDaPromo({ preco_sugerido: 80 }, 100).toFixed(2), '0.20', 'sem preço do ML: o sugerido sobre o preço atual');
assert.strictEqual(P.descontoDaPromo({}, 100), null);
assert.strictEqual(P.promoNoFiltro(cand, 100, { descontoMax: 10 }), true, '10% cabe em "até 10%"');
assert.strictEqual(P.promoNoFiltro(cand, 100, { descontoMax: 9.5 }), false);
assert.strictEqual(P.promoNoFiltro(cand, 100, { lucroMin: 20 }), true);
assert.strictEqual(P.promoNoFiltro(cand, 100, { lucroMin: 25 }), false);
assert.strictEqual(P.promoNoFiltro({ ...cand, margem: null }, 100, { lucroMin: 5 }), false, 'sem lucro calculado não passa');
assert.strictEqual(P.promoNoFiltro({ ...cand, status: 'started' }, 100, { descontoMax: 50 }), false, 'só as disponíveis');
assert.strictEqual(P.promoNoFiltro({ status: 'candidate' }, 100, { descontoMax: 50 }), false, 'sem preço: desconto desconhecido');

// ---------- dinheiro da devolução (pagamento real do Mercado Pago, 24/09/2026, resumido) ----------
// O reembolso vem com source "bpp" mesmo no "não quero mais": sai da venda, não do ML.
const mpDevol = {
  refunds: [{ amount: 94.4, status: 'approved', source: { type: 'bpp' }, metadata: { coverage: { flow: 'return' } } }],
  charges_details: [
    { type: 'fee', name: 'financing_transfer', amounts: { original: 12.5, refunded: 12.5 }, accounts: { from: 'payer', to: 'collector' } },
    { type: 'fee', name: 'financing_fee', amounts: { original: 12.5, refunded: 12.5 }, accounts: { from: 'collector', to: 'mp' } },
    { type: 'shipping', name: 'shp_cross_docking', amounts: { original: 27.41, refunded: 27.41 }, accounts: { from: 'collector', to: '1745333938' } },
    { type: 'fee', name: 'mp_processing_fee', amounts: { original: 2.49, refunded: 2.49 }, accounts: { from: 'collector', to: 'mp' } },
    { type: 'fee', name: 'ml_sale_fee', amounts: { original: 7.91, refunded: 7.91 }, accounts: { from: 'collector', to: 'ml' } },
  ],
};
const dc = dinheiroDoPagamento(mpDevol);
assert.strictEqual(dc.reembolso_vendedor, 94.4, 'bpp é o caminho do reembolso: o dinheiro sai da sua venda');
assert.strictEqual(dc.reembolso_ml, 0);
assert.strictEqual(dc.frete_ida, 27.41);
assert.strictEqual(dc.frete_ida_estornado, 27.41);
assert.ok(Math.abs(dc.tarifas - 22.9) < 1e-9, 'financing_transfer (do comprador para o vendedor) não é tarifa');
const dv = dinheiroDoPagamento({ refunds: [{ amount: 100, status: 'approved', source: { type: 'collector' } },
  { amount: 5, status: 'rejected', source: { type: 'collector' } }] });
assert.strictEqual(dv.reembolso_vendedor, 100, 'reembolso recusado não conta');

// ---------- custo da devolução ----------
// Regra do dono (29/09/2026): no custo da devolução entra só a peça com defeito; produto que
// voltou bom volta ao estoque. Fretes e tarifas perdidos ficam numa linha própria.
// Voltou em boas condições, frete e tarifas estornados: custo 0, só o frete de volta em "fretes".
assert.deepStrictEqual(custoDa({ tarifa_devolucao: 38.9, reembolso_vendedor: 94.4, frete_ida: 27.41,
  frete_ida_estornado: 27.41, tarifas: 22.9, tarifas_estornadas: 22.9, status_devolucao: 'delivered' }),
{ frete_volta: 38.9, frete_ida_perdido: 0, tarifas_perdidas: 0, fretes: 38.9, defeito: false, produtos_defeito: null, qtds_defeito: null, peca_defeito: 0,
  nao_voltou: 0, perda_produto: 0, total: 0, credito_ml: 0, resultado: -38.9 });
// Frete de ida e tarifas NÃO estornados entram em "fretes"; os estornados não.
const pv = custoDa({ tarifa_devolucao: 10, reembolso_vendedor: 100, frete_ida: 20, frete_ida_estornado: 5,
  tarifas: 12, tarifas_estornadas: 12, status_devolucao: 'delivered' });
assert.deepStrictEqual([pv.frete_ida_perdido, pv.tarifas_perdidas, pv.fretes, pv.total], [15, 0, 25, 0]);
// Dinheiro devolvido e o produto não voltou: perde o custo do produto (ou o devolvido, sem custo).
assert.strictEqual(custoDa({ reembolso_vendedor: 100, status_devolucao: null, custo_produto: 40 }).nao_voltou, 40);
assert.strictEqual(custoDa({ reembolso_vendedor: 100, status_devolucao: null }).total, 100);
// Voltou avariado (revisão do ML sugere defeito): a peça entra no custo; o crédito do ML compensa.
const av = custoDa({ reembolso_vendedor: 160.72, status_devolucao: 'delivered', custo_produto: 70.21,
  revisao: JSON.stringify({ motivo: 'SRF2', resultado: 'success' }), credito_ml: 160.72 });
assert.deepStrictEqual([av.defeito, av.peca_defeito, av.total, av.resultado], [true, 70.21, 70.21, 90.51]);
// O vendedor manda: desmarcou o defeito (peça revendável) -> não soma, mesmo com a revisão dizendo avariado.
const des = custoDa({ reembolso_vendedor: 160.72, status_devolucao: 'delivered', custo_produto: 70.21,
  revisao: { motivo: 'SRF2', resultado: 'success' }, defeito: false });
assert.deepStrictEqual([des.defeito, des.total], [false, 0]);
// Marcou defeito num produto que o ML achou bom -> soma.
assert.strictEqual(custoDa({ status_devolucao: 'delivered', custo_produto: 30, defeito: true }).peca_defeito, 30);
// Dá para marcar defeito em qualquer reclamação (30/09/2026), mesmo com o produto ainda sem voltar.
assert.strictEqual(custoDa({ status_devolucao: 'label_generated', custo_produto: 30, defeito: true }).peca_defeito, 30);
// ...mas a SUGESTÃO do ML (revisão) só vale com o produto de volta.
assert.strictEqual(custoDa({ status_devolucao: 'label_generated', custo_produto: 30, revisao: { motivo: 'SRF2' } }).peca_defeito, 0);
// Reclamação sem devolução (comprador ficou com a peça e recebeu o dinheiro): sem marcação,
// perde o produto inteiro; marcando a peça do kit com defeito, vale só ela (não soma as duas).
const semVolta = { reembolso_vendedor: 100, status_devolucao: null, custo_produto: 60.5 };
assert.deepStrictEqual([custoDa(semVolta).nao_voltou, custoDa(semVolta).total], [60.5, 60.5]);
const semVoltaMarcada = custoDa({ ...semVolta, defeito: true, defeito_produtos: [1],
  componentes: [{ sku: 'DQ-407', custo: 40 }, { sku: 'BP-408', custo: 12.5 }, { sku: 'DD-795', custo: 8 }] });
assert.deepStrictEqual([semVoltaMarcada.peca_defeito, semVoltaMarcada.nao_voltou, semVoltaMarcada.total], [12.5, 0, 12.5]);
// desmarcou tudo numa que não voltou: o produto continua perdido (não voltou é fato)
assert.strictEqual(custoDa({ ...semVolta, defeito: false, defeito_produtos: [], componentes: [{ sku: 'A', custo: 40 }, { sku: 'B', custo: 20.5 }] }).total, 60.5);
// Quantas com defeito (09/10/2026): 2 BP-408 devolvidos (custo 25 = 2 × 12,50), só 1 quebrado.
assert.strictEqual(custoDa({ status_devolucao: 'delivered', quantidade: 2, custo_produto: 25, defeito: true, defeito_qtds: { '*': 1 } }).peca_defeito, 12.5);
assert.deepStrictEqual(custoDa({ status_devolucao: 'delivered', quantidade: 2, custo_produto: 25, defeito: true }).qtds_defeito, { '*': 2 });
{ const kq = custoDa({ status_devolucao: 'delivered', quantidade: 3, defeito: true, componentes: [{ sku: 'DQ-407', custo: 40 }, { sku: 'BP-408', custo: 12.5 }],
    defeito_produtos: [0, 1], defeito_qtds: { 1: 1 } });
  assert.deepStrictEqual([kq.peca_defeito, kq.qtds_defeito], [132.5, { 0: 3, 1: 1 }], 'kit: 3 DQ-407 + 1 BP-408'); }
// Kit (pedido do dono, 30/09/2026): o vendedor marca QUAIS produtos do anúncio estão com
// defeito e só eles somam; os outros voltam ao estoque.
const kit = [{ sku: 'DQ-407', custo: 40 }, { sku: 'BP-408', custo: 12.5 }, { sku: 'DD-795', custo: 8 }];
const k1 = custoDa({ status_devolucao: 'delivered', custo_produto: 60.5, defeito: true, componentes: kit, defeito_produtos: [1] });
assert.deepStrictEqual([k1.defeito, k1.peca_defeito, k1.total, k1.produtos_defeito], [true, 12.5, 12.5, [1]]);
// duas unidades devolvidas: cada peça marcada conta em dobro
assert.strictEqual(custoDa({ status_devolucao: 'delivered', quantidade: 2, defeito: true, componentes: kit, defeito_produtos: [0, 2] }).peca_defeito, 96);
// nenhuma marcada = kit inteiro voltou bom, mesmo com a revisão do ML dizendo avariado
const k0 = custoDa({ status_devolucao: 'delivered', custo_produto: 60.5, defeito: false, componentes: kit, defeito_produtos: [],
  revisao: { motivo: 'SRF2' } });
assert.deepStrictEqual([k0.defeito, k0.peca_defeito, k0.produtos_defeito], [false, 0, null]);
// sem marcação por produto (sugestão do ML ou marcação antiga): vale o anúncio inteiro
assert.strictEqual(custoDa({ status_devolucao: 'delivered', custo_produto: 60.5, defeito: true, componentes: kit }).peca_defeito, 60.5);
// posição que não existe no kit é ignorada
assert.strictEqual(custoDa({ status_devolucao: 'delivered', defeito: true, componentes: kit, defeito_produtos: [7] }).peca_defeito, 0);

// ---------- crédito do ML ligado à reclamação ----------
const recl = [
  { id: 1, criada_em: '2026-09-02T10:00:00.000Z', valor_venda: 160.72, devolvido: 160.72, mensagem: 'Liberamos parte do valor…' },
  { id: 2, criada_em: '2026-09-05T10:00:00.000Z', valor_venda: 99.59, devolvido: 99.59, mensagem: 'Devolução entregue' },
  { id: 3, criada_em: '2026-09-06T10:00:00.000Z', valor_venda: 215.58, devolvido: 215.58, mensagem: 'Liberamos parte do valor…' },
];
const lig = ligarCreditos([
  { id: 'a', valor: 160.72, data: '2026-09-14T17:00:58.000Z' },   // valor igual ao da venda 1
  { id: 'b', valor: 80, data: '2026-09-12T10:00:00.000Z' },       // parcial: não bate valor exato, fica sem dono
  { id: 'c', valor: 50, data: '2026-08-01T10:00:00.000Z' },       // antes de qualquer reclamação: sem dono
], recl);
assert.strictEqual(lig.porClaim[1].id, 'a');
assert.strictEqual(lig.porClaim[3], undefined, 'parcial não é atribuído por proximidade');
assert.strictEqual(lig.porClaim[2], undefined, 'devolução comum não recebe crédito');
assert.deepStrictEqual(lig.semDono.map((c) => c.id).sort(), ['b', 'c']);

console.log('promoções e devoluções: ok');
