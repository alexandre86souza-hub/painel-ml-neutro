'use strict';
// node test-calculadora.js — calculadora reversa (calculadora.js): só funções puras.
const assert = require('node:assert');
const K = require('./calculadora.js');

// Shopee: faixas medidas (comissão + transação; taxa fixa por unidade; Devolução Fácil por pedido)
assert.deepStrictEqual(K.tarifaShopee(49.9), { pct: 20, fixa_un: 4.5, pedido: 0.49, valor: 14.97 });
assert.strictEqual(K.tarifaShopee(79.99).pct, 20);
assert.deepStrictEqual([K.tarifaShopee(80).fixa_un, K.tarifaShopee(99.99).fixa_un, K.tarifaShopee(100).fixa_un, K.tarifaShopee(199.99).fixa_un, K.tarifaShopee(200).fixa_un],
  [16, 16, 20, 20, 26]);
assert.strictEqual(K.tarifaShopee(171.61).valor, 44.52, 'a venda real das duchas: 14% de 171,61 + 20 + 0,49');

// conta reversa: custo máximo = preço − despesas − margem
const c = K.contaReversa({ preco: 100, margemPct: 20, tarifa: 14, frete: 10, impostoPct: 10, embalagem: 1.5, outros: 2.5 });
assert.deepStrictEqual({ imp: c.imposto, desp: c.despesas, lucro: c.lucro_desejado, max: c.custo_maximo, sobra: c.sobra_sem_lucro },
  { imp: 10, desp: 38, lucro: 20, max: 42, sobra: 62 });
const comCusto = K.contaReversa({ preco: 100, margemPct: 20, tarifa: 14, frete: 10, impostoPct: 10, embalagem: 1.5, outros: 2.5, custoAtual: 30 });
assert.deepStrictEqual({ l: comCusto.lucro_atual, m: comCusto.margem_atual, f: comCusto.folga }, { l: 32, m: 0.32, f: 12 });
assert.strictEqual(K.contaReversa({ preco: 50, margemPct: 50, tarifa: 20, frete: 10 }).custo_maximo, -5, 'margem impossível: custo máximo negativo');

// tarifa do ML digitada (%)
assert.deepStrictEqual(['11,5', '16.5', 11.5, ' 0 ', '', null, 'abc', -1, 61].map(K.pctValido), [11.5, 16.5, 11.5, 0, null, null, null, null, null]);

// frete digitado (R$): digitado › padrão salvo › calculado
assert.deepStrictEqual(['12,50', 8, '0', '', null, 'x', -1].map(K.freteValido), [12.5, 8, 0, null, null, null, null]);
const cf = { id: 'shopee:1', frete: 0, frete_fonte: 'Shopee paga' };
assert.deepStrictEqual([K.comFrete(cf, null, null), K.comFrete(cf, null, 8), K.comFrete(cf, 12, 8)].map((x) => [x.frete, x.frete_origem, x.frete_calculado]),
  [[0, 'calculado', 0], [8, 'padrao', 0], [12, 'editado', 0]]);
assert.match(K.comFrete(cf, 12, null).frete_fonte, /digitado neste cálculo · calculado pelo painel: R\$ 0,00 \(Shopee paga\)/);

console.log('Calculadora reversa: faixas da Shopee, conta reversa, custo atual, tarifa e frete digitados: ok');
