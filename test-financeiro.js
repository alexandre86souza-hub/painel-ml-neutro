'use strict';
// node test-financeiro.js — o dinheiro das vendas pelo Mercado Pago (financeiro.js). Só
// funções puras: nada aqui chama o Mercado Pago.
const assert = require('node:assert');
const F = require('./financeiro.js');

// ---------- pagamento -> registro ----------
const ch = (type, name, from, to, original, refunded = 0) => ({ type, name, accounts: { from, to }, amounts: { original, refunded } });
const p = F.pagamentoDe({ id: 1, operation_type: 'regular_payment', order: { id: '2000001' }, status: 'approved', date_created: '2026-09-30T10:00:00.000-04:00',
  transaction_amount: 100, shipping_amount: 0, transaction_amount_refunded: 0, transaction_details: { net_received_amount: 72.5 },
  money_release_date: '2026-10-10T10:00:00.000-04:00', money_release_status: 'pending', payer: { email: 'nao-guardar' },
  charges_details: [ch('fee', 'ml_sale_fee', 'collector', 'ml', 14), ch('fee', 'mp_processing_fee', 'collector', 'mp', 4.99),
    ch('fee', 'financing_fee', 'collector', 'mp', 6), ch('fee', 'financing_transfer', 'payer', 'collector', 6),
    ch('shipping', 'shp_cross_docking', 'collector', '999', 8.51), ch('coupon', 'coupon_code', 'ml', 'payer', 10)] }, 55);
assert.deepStrictEqual({ tipo: p.tipo, order: p.order_id, ml: p.tarifa_ml, mp: p.tarifa_mp, frete: p.frete, cupom: p.cupom, liq: p.liquido, lib: p.liberado },
  { tipo: 'venda', order: 2000001, ml: 14, mp: 4.99, frete: 8.51, cupom: 0, liq: 72.5, lib: 'pending' },
  'juros do comprador abatem a taxa de parcelamento; cupom pago pelo ML não conta');
assert.ok(Math.abs(p.bruto + p.frete_cobrado - p.tarifa_ml - p.tarifa_mp - p.frete - p.cupom - p.liquido) < 0.01, 'bruto − cobranças = líquido');
assert.ok(!JSON.stringify(p).includes('nao-guardar'), 'nada do comprador');
assert.strictEqual(F.pagamentoDe({ id: 2, operation_type: 'money_transfer', description: 'bonificaciones_flex', status: 'approved' }, 55).tipo, 'outro');

// ---------- a receber, liberado e retido ----------
const agora = Date.parse('2026-10-02T15:00:00Z');
const reg = (o) => ({ status: 'approved', tipo: 'venda', bruto: 100, frete_cobrado: 0, tarifa_ml: 10, tarifa_mp: 5, frete: 5, cupom: 0, criado: '2026-09-25T12:00:00.000Z', ...o });
const f = F.financeiroDe([
  reg({ liquido: 80, liberado: 'pending', libera_em: '2026-10-05T15:00:00.000Z' }),     // a receber em 3 dias
  reg({ liquido: 50, liberado: 'pending', libera_em: '2026-10-20T15:00:00.000Z' }),     // a receber depois de 7 dias
  reg({ liquido: 30, liberado: 'pending', libera_em: '2026-09-20T15:00:00.000Z' }),     // vencido e pendente = retido
  reg({ liquido: 70, liberado: 'released', libera_em: '2026-09-28T15:00:00.000Z' }),    // liberado
  reg({ tipo: 'outro', liquido: 20, liberado: 'released', libera_em: '2026-09-29T15:00:00.000Z', tarifa_ml: 0, tarifa_mp: 0, frete: 0 }),
  reg({ status: 'refunded', liquido: 0, bruto: 40 }),
], { agora, dias: 30 });
const t = f.totais;
assert.deepStrictEqual({ rec: t.a_receber, rec7: t.a_receber_7, ret: t.retido, lib: t.liberado, vendas: t.vendas_liberadas, outros: t.outros_liberados, reemb: t.reembolsado },
  { rec: 130, rec7: 80, ret: 30, lib: 90, vendas: 70, outros: 20, reemb: 40 });
assert.deepStrictEqual(f.a_receber_por_dia, [{ dia: '2026-10-05', valor: 80 }, { dia: '2026-10-20', valor: 50 }]);
assert.deepStrictEqual(f.liberado_por_dia.map((d) => d.dia), ['2026-09-28', '2026-09-29']);
assert.deepStrictEqual({ ml: t.tarifa_ml, mp: t.tarifa_mp, frete: t.frete }, { ml: 10, mp: 5, frete: 5 }, 'a quebra é só das vendas liberadas');

console.log('Financeiro: tarifas, juros do parcelamento, líquido, a receber, liberado e retido: ok');
