'use strict';
// node test-precos.js — calculadora de preço pela margem, GTIN e atacado. Só funções puras.
const assert = require('node:assert');
const P = require('./precos.js');

// ---------- calculadora ----------
// Números do anúncio MLB2735516721 (28/09/2026): custo 21,94, embalagem 1,50, frete 7,71,
// tarifa 11,5% (+ fixa 0), imposto 10%. Para 25% de margem: 31,15 / 0,535 = 58,22…
const base = { custo: 21.94, embalagem: 1.5, frete: 7.71, tarifaPct: 11.5, tarifaFixa: 0, impostoPct: 10 };
const p = P.precoPara({ ...base, margemPct: 25 });
assert.strictEqual(p, 58.22);
const q = P.quebra({ ...base, preco: p });
assert.ok(Math.abs(q.margem - 0.25) < 0.001, 'o preço calculado devolve a margem pedida');
assert.strictEqual(P.precoPara({ ...base, margemPct: 79 }), null, 'margem + tarifa + imposto ≥ 100%: sem preço');
// tarifa fixa (abaixo de R$ 79) entra no numerador
assert.strictEqual(P.precoPara({ custo: 10, tarifaPct: 12, tarifaFixa: 6.25, impostoPct: 0, margemPct: 20 }), 23.9, '16,25 / 0,68');

// ---------- GTIN ----------
assert.ok(P.gtinValido('7898688672304'), 'GTIN real de um anúncio da conta');
assert.ok(!P.gtinValido('7898688672305'), 'dígito verificador errado');
assert.ok(P.gtinValido('96385074'), 'EAN-8');
assert.ok(!P.gtinValido('12345'), 'tamanho inválido');
assert.ok(!P.gtinValido('78986886723a4'));

// ---------- atacado ----------
const f = P.faixasAtacado([
  { quantidade: '5', tipo: 'pct', valor: '4,5' },
  { quantidade: '2', tipo: 'preco', valor: '59.65' },   // de 60,87 -> 2%
  { quantidade: '', tipo: 'pct', valor: '' },           // linha vazia é ignorada
], 60.87);
assert.deepStrictEqual(f, [{ quantidade: 2, pct: 2 }, { quantidade: 5, pct: 4.5 }]);
assert.throws(() => P.faixasAtacado([{ quantidade: 2, tipo: 'pct', valor: 5 }, { quantidade: 4, tipo: 'pct', valor: 3 }], 100), /aumentar/);
assert.throws(() => P.faixasAtacado([{ quantidade: 1, tipo: 'pct', valor: 5 }], 100), /2 a 100/);
assert.throws(() => P.faixasAtacado([{ quantidade: 3, tipo: 'preco', valor: 120 }], 100), /menor que o preço/);
assert.throws(() => P.faixasAtacado(Array.from({ length: 6 }, (_, i) => ({ quantidade: i + 2, tipo: 'pct', valor: i + 1 })), 100), /5 faixas/);
assert.deepStrictEqual(P.faixasAtacado([], 100), [], 'sem faixas = remover o atacado');

assert.deepStrictEqual(P.corpoAtacado([{ quantidade: 2, pct: 2 }]), { price_per_quantity: [{
  type: 'discount_percentage', percentage: 2,
  conditions: { context_restrictions: ['channel_marketplace', 'user_type_business'], min_purchase_unit: 2, eligible: true },
}] });

// leitura de /items/{id}/prices com atacado antigo (valor fixo) — resposta real, resumida
const a = P.lerAtacado({ version: 67, prices: [
  { id: '45', type: 'standard', amount: 60.87, conditions: { context_restrictions: [] } },
  { id: '46', type: 'standard', amount: 60.56, conditions: { context_restrictions: ['channel_marketplace', 'user_type_business'], min_purchase_unit: 2 } },
  { id: '71', type: 'promotion', amount: 57.82, conditions: { context_restrictions: ['channel_marketplace'] } },
] });
assert.deepStrictEqual(a.base, { id: '45', preco: 60.87 });
assert.deepStrictEqual(a.fixas, [{ id: '46', quantidade: 2, preco: 60.56, pct: 0.51 }]);
assert.deepStrictEqual(a.pct, []);
assert.strictEqual(a.versao, 67);

console.log('preço pela margem, GTIN e atacado: ok');
