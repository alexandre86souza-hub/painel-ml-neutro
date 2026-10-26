'use strict';
// Metas e faturamento por CNPJ + Simples Nacional (metas.js): funções puras.
const assert = require('node:assert');
const M = require('./metas.js');

// Simples Nacional, Anexo I: faixa e alíquota efetiva = (RBT12 × nominal − dedução) ÷ RBT12
{
  const s = M.simples(1053690.38);
  assert.strictEqual(s.faixa, 4, 'R$ 1,05 mi = 4ª faixa (720 mil a 1,8 mi)');
  assert.strictEqual(s.nominal, 0.107);
  assert.strictEqual(s.efetiva.toFixed(4), '0.0856', 'efetiva ~8,56% (a planilha usava 8,8%)');
  assert.strictEqual(s.falta_proxima, 746309.62, 'quanto falta para a 5ª faixa');
  assert.strictEqual(M.simples(0).efetiva, 0.04, 'sem receita: 1ª faixa');
  assert.strictEqual(M.simples(180000).faixa, 1, 'o teto ainda é da faixa');
  assert.strictEqual(M.simples(180000.01).faixa, 2);
  assert.strictEqual(M.simples(3700000).sublimite_icms, true, 'acima de 3,6 mi o ICMS sai do DAS');
  assert.strictEqual(M.simples(4800000.01).acima_teto, true, 'acima de 4,8 mi sai do Simples');
  assert.strictEqual(M.simples(500000, 'II').nominal, 0.10, 'Anexo II (indústria) tem outra tabela');
}

// Mês: projeção pela média dos dias passados, ritmo necessário = saldo ÷ dias que faltam
{
  const porDia = { '2026-10-01': 6000, '2026-10-02': 8000, '2026-10-10': 4000 };
  const m = M.mesResumo({ ano: 2026, mes: 10, meta: 230000, porDia }, '2026-10-10');
  assert.deepStrictEqual({ r: m.realizado, p: m.projecao, d: m.dias_passados, falta: m.saldo }, { r: 18000, p: 55800, d: 10, falta: 212000 });
  assert.strictEqual(m.ritmo_necessario, r2(212000 / 21));
  assert.strictEqual(m.alerta, 'FORA DO RITMO');
  assert.strictEqual(m.dias[9].acumulado, 18000);
  assert.strictEqual(m.dias[30].planejado, 230000, 'planejado acumulado fecha na meta');
  const fechado = M.mesResumo({ ano: 2026, mes: 8, meta: 230000, porDia: { '2026-08-05': 240000 } }, '2026-10-10');
  assert.deepStrictEqual({ p: fechado.projecao, a: fechado.alerta }, { p: 240000, a: 'META ATINGIDA' }, 'mês fechado: projeção = realizado');
  assert.strictEqual(M.mesResumo({ ano: 2026, mes: 9, meta: 230000, porDia: { '2026-09-01': 1000 } }, '2026-10-10').alerta, 'ABAIXO DA META');
  assert.strictEqual(M.mesResumo({ ano: 2026, mes: 11, meta: null, porDia: {} }, '2026-10-10').alerta, null, 'sem meta, sem alerta');
}
function r2(v) { return Math.round(v * 100) / 100; }

console.log('Metas e faturamento: Simples Nacional (faixa e alíquota efetiva) e ritmo do mês: ok');
