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

// ---------- frete pago à parte: o order.id não é pedido, o envio vem na referência ----------
const fr = F.pagamentoDe({ id: 3, operation_type: 'regular_payment', description: 'marketplace_shipment', order: { id: '9990001' },
  external_reference: '45000000001', status: 'approved', transaction_amount: 20 }, 55);
assert.deepStrictEqual({ o: fr.order_id, e: fr.envio_id, t: fr.tipo }, { o: null, e: 45000000001, t: 'venda' });
assert.strictEqual(p.envio_id, null);

// ---------- relatório de liberações ----------
const csv = '﻿DATE,SOURCE_ID,EXTERNAL_REFERENCE,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT\r\n'
  + '2026-09-01T00:00:00.000-03:00,,,initial_available_balance,,100.00,0.00\r\n'
  + '2026-09-02T10:00:00.000-03:00,1,2000001,release,payment,72.50,0.00\r\n'
  + '2026-09-03T10:00:00.000-03:00,777,,release,reserve_for_payout,0.00,150.00\r\n'
  + '2026-09-03T10:00:01.000-03:00,777,,release,reserve_for_payout,150.00,0.00\r\n'
  + '2026-09-03T10:00:02.000-03:00,777,,release,payout,0.00,150.00\r\n'
  + '2026-09-04T09:00:00.000-03:00,2,"cashback_1,2",release,shipping,10.00,0.00\r\n'
  + ',,,total,,32.50,0.00\r\n';
const rel = F.lerRelatorio(csv);
assert.deepStrictEqual({ i: rel.saldo_inicial, f: rel.saldo_final, n: rel.linhas.length }, { i: 100, f: 32.5, n: 5 });
assert.strictEqual(rel.linhas[0].data, '2026-09-02T13:00:00.000Z', 'data em UTC');
assert.strictEqual(rel.linhas[4].referencia, 'cashback_1,2', 'campo entre aspas');
assert.throws(() => F.lerRelatorio('A,B\n1,2'), /coluna DATE/);

// ---------- extrato: saldo após cada movimento e conferência dos saldos informados ----------
const mov = (data, tipo, credito, debito, ordem = 0) => ({ data, tipo, credito, debito, ordem });
const ex = F.extratoDe([
  mov('2026-09-02T13:00:00.000Z', 'payment', 72.5, 0), mov('2026-09-03T13:00:00.000Z', 'payout', 0, 150, 2),
  mov('2026-09-03T13:00:00.000Z', 'reserve_for_payout', 0, 150, 0), mov('2026-09-03T13:00:00.000Z', 'reserve_for_payout', 150, 0, 1),
  mov('2026-09-10T13:00:00.000Z', 'payment', 50, 0),
], [{ inicio: '2026-09-01T03:00:00.000Z', fim: '2026-09-09T02:59:59.000Z', saldo_inicial: 100, saldo_final: 22.5 },
  { inicio: '2026-09-09T03:00:00.000Z', fim: '2026-09-11T02:59:59.000Z', saldo_inicial: 22.5, saldo_final: 72.5 }]);
assert.deepStrictEqual(ex.movimentos.map((m) => m.saldo), [172.5, 22.5, 172.5, 22.5, 72.5], 'na ordem do relatório');
assert.deepStrictEqual({ s: ex.saldo_atual, ok: ex.confere.ok, n: ex.confere.conferidos }, { s: 72.5, ok: true, n: 2 });
assert.deepStrictEqual(ex.dias.find((d) => d.dia === '2026-09-03'), { dia: '2026-09-03', entradas: 150, saidas: 300, saques: 150, saldo: 22.5 });
const exRuim = F.extratoDe([mov('2026-09-02T13:00:00.000Z', 'payment', 10, 0)], [{ inicio: '2026-09-01T03:00:00.000Z', fim: 'x', saldo_inicial: 0, saldo_final: 11 }]);
assert.strictEqual(exRuim.confere.ok, false, 'saldo informado diferente do calculado');
assert.strictEqual(F.nomeTipo('payout'), 'Saque para o banco');

// ---------- conferência ----------
const pg = (o) => ({ ml_user_id: 55, tipo: 'venda', status: 'approved', bruto: 100, frete_cobrado: 0, frete: 0, liquido: 80, criado: '2026-09-20T12:00:00.000Z', ...o });
const vendas = [
  { order_id: 1, data: '2026-09-20T11:00:00.000Z', itens: 100, envio_id: 41 },
  { order_id: 2, data: '2026-09-20T11:00:00.000Z', itens: 100, envio_id: 42 },
  { order_id: 3, data: '2026-09-20T11:00:00.000Z', itens: 100, envio_id: 43 },
  { order_id: 4, data: '2026-09-21T11:00:00.000Z', itens: 50, envio_id: 44, status: 'paid' },     // sem pagamento
  { order_id: 6, data: '2026-09-21T11:00:00.000Z', itens: 70, envio_id: 46 },
];
const cf = F.conferenciaDe({
  pags: [
    pg({ id: 10, order_id: 1 }),                                   // igual
    pg({ id: 11, order_id: 2, bruto: 118, frete: 25 }),            // frete do comprador junto
    pg({ id: 12, order_id: 3, bruto: 130, frete: 5 }),             // diferença sem explicação
    pg({ id: 13, order_id: null, envio_id: 41, bruto: 20 }),       // frete à parte
    pg({ id: 14, order_id: 999 }),                                 // pedido fora do painel
    pg({ id: 15, tipo: 'outro', order_id: null, descricao: 'bonificaciones_flex', bruto: 5 }),
    pg({ id: 16, tipo: 'outro', order_id: null, descricao: 'Entrada de dinheiro correspondente a sua reclamação', bruto: 70 }),
    pg({ id: 17, tipo: 'outro', order_id: null, descricao: 'Entrada de dinheiro correspondente a sua reclamação', bruto: 33 }),
    pg({ id: 18, tipo: 'outro', order_id: null, descricao: 'algo novo', bruto: 9 }),
    pg({ id: 19, order_id: 888, status: 'cancelled' }),
    pg({ id: 21, order_id: 6, bruto: 70, frete_cobrado: 12.5 }),  // frete do comprador no shipping_amount
  ],
  vendas, vendasJanela: vendas, creditosLigados: { 16: { claim_id: 500, order_id: 6 } },
  notas: { 'pag:18': { order_id: 3, observacao: 'acerto do ML', conferido: 1 }, 'pag:12': { observacao: 'vi no ML', conferido: 1 } },
});
const sit = Object.fromEntries(cf.itens.map((i) => [i.chave, [i.situacao, i.venda?.order_id ?? null, i.venda?.por ?? null]]));
assert.deepStrictEqual(sit, {
  'pag:10': ['ok', 1, 'pedido'], 'pag:11': ['ok', 2, 'pedido'], 'pag:12': ['pendente', 3, 'pedido'], 'pag:13': ['ok', 1, 'envio'],
  'pag:14': ['pendente', null, null], 'pag:15': ['explicado', null, null], 'pag:16': ['ok', 6, 'reclamacao'],
  'pag:17': ['pendente', null, null], 'pag:18': ['ok', 3, 'manual'], 'pag:19': ['explicado', null, null], 'pag:21': ['ok', 6, 'pedido'], 'venda:4': ['pendente', 4, 'pedido'],
});
assert.match(cf.itens.find((i) => i.chave === 'pag:11').motivo, /R\$ 18,00 de frete pago pelo comprador/);
assert.match(cf.itens.find((i) => i.chave === 'pag:12').motivo, /diferença de R\$ 30,00/);
assert.deepStrictEqual({ ...cf.resumo }, { total: 12, ok: 6, explicado: 2, pendente: 4, conferido: 2, a_conferir: 3, ligados: 8 });

// ---------- crédito de reclamação ligado à devolução ----------
const devs = [{ claim_id: 500, order_id: 6, criada_em: '2026-09-01T00:00:00.000Z', valor_pedido: 70, reembolso_vendedor: 0, reembolso_ml: 0 },
  { claim_id: 501, order_id: 7, criada_em: '2026-09-01T00:00:00.000Z', valor_pedido: 200, reembolso_vendedor: 0, reembolso_ml: 0 }];
const lig = F.ligarCreditosReclamacao([pg({ id: 16, tipo: 'outro', descricao: 'Entrada de dinheiro correspondente a sua reclamação', bruto: 70 }),
  pg({ id: 17, tipo: 'outro', descricao: 'Reembolso de Compra Garantida por sua reclamação', bruto: 97.83 }),
  pg({ id: 20, tipo: 'outro', descricao: 'bonificaciones_flex', bruto: 70 })], devs, { 501: { valor: 97.83 } });
assert.deepStrictEqual(lig, { 16: { claim_id: 500, order_id: 6 }, 17: { claim_id: 501, order_id: 7 } }, 'pelo valor da venda e pelo crédito digitado');
const lig2 = F.ligarCreditosReclamacao([pg({ id: 30, tipo: 'outro', descricao: null, bruto: 97.83 }), pg({ id: 31, tipo: 'outro', descricao: null, bruto: 70 })], devs, { 501: { valor: 97.83 } });
assert.deepStrictEqual(lig2, { 30: { claim_id: 501, order_id: 7 } }, 'sem descrição: só pelo valor digitado, não pela regra de valor e data');
const cf2 = F.conferenciaDe({ pags: [pg({ id: 30, tipo: 'outro', order_id: null, descricao: null, bruto: 97.83 })], vendas, creditosLigados: lig2 });
assert.strictEqual(cf2.itens[0].situacao, 'ok');

console.log('Financeiro: tarifas, juros do parcelamento, líquido, a receber, liberado e retido: ok');
console.log('Financeiro: extrato (relatório, saldo e conferência dos saldos) e conferência pagamento × venda: ok');
