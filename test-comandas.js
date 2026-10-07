'use strict';
// node test-comandas.js — comandas de separação: categorias, numeração, prazo e código de barras.
const assert = require('node:assert');
const K = require('./comandas.js');
const B = require('./public/codigo128.js');

// categorias pedidas pelo vendedor
assert.deepStrictEqual(K.categoriaDe('ml', 'self_service'), { categoria: 'Flex', envio: 'Flex' });
assert.strictEqual(K.categoriaDe('ml', 'xd_drop_off').categoria, 'Mercado Envios');
assert.strictEqual(K.categoriaDe('ml', 'cross_docking').categoria, 'Mercado Envios');
assert.strictEqual(K.categoriaDe('ml', 'fulfillment'), null, 'Full não entra');
assert.deepStrictEqual(K.categoriaDe('shopee', 'Entrega Direta'), { categoria: 'Flex', envio: 'Shopee Entrega Direta' });
assert.strictEqual(K.categoriaDe('shopee', 'Shopee Xpress').categoria, 'Shopee');
assert.deepStrictEqual(K.categoriaDe('magalu', 'VAPT mle-vapt'), { categoria: 'Flex', envio: 'Magalu VAPT' });
assert.strictEqual(K.categoriaDe('magalu', 'Agência Magalu direta').categoria, 'Magalu');
assert.strictEqual(K.categoriaDe('leroy').categoria, 'Melhor Envios');
assert.strictEqual(K.categoriaDe('amazon', 'AFN'), null, 'FBA não entra');
assert.deepStrictEqual(K.categoriaDe('amazon', 'easyship'), { categoria: 'Amazon', envio: 'Amazon DBA' });
assert.strictEqual(K.categoriaDe('amazon', '').envio, 'Amazon Envio Próprio');

// numeração por categoria no dia: continua do maior número de hoje; pelo prazo
const dia = '2026-10-07';
const n = K.numerar([
  { chave: 'a', categoria: 'Flex', prazo: '2026-10-07T20:00:00Z', pedido: '2' },
  { chave: 'b', categoria: 'Flex', prazo: '2026-10-07T15:00:00Z', pedido: '9' },
  { chave: 'c', categoria: 'Shopee', prazo: null, pedido: '1' }],
[{ categoria: 'Flex', dia, numero: 3 }, { categoria: 'Flex', dia: '2026-10-06', numero: 40 }], dia);
assert.deepStrictEqual(n.map((x) => [x.chave, x.categoria, x.numero]), [['b', 'Flex', 4], ['a', 'Flex', 5], ['c', 'Shopee', 1]]);

// prazo em relação a hoje (Brasília)
const ag = Date.parse('2026-10-07T15:00:00Z');
assert.strictEqual(K.situacaoPrazo('2026-10-06T20:00:00Z', ag), 'atrasado');
assert.strictEqual(K.situacaoPrazo('2026-10-08T02:59:59Z', ag), 'hoje', '23h59 de Brasília ainda é hoje');
assert.strictEqual(K.situacaoPrazo('2026-10-08T15:00:00Z', ag), 'amanhã');
assert.strictEqual(K.situacaoPrazo(null, ag), 'sem prazo');

// código de barras Code 128: 107 símbolos de 11 módulos (parada 13), barras pares e espaços ímpares
assert.strictEqual(B.PADROES.length, 107);
assert.strictEqual(new Set(B.PADROES).size, 107);
B.PADROES.forEach((p, i) => {
  assert.strictEqual([...p].reduce((a, d) => a + Number(d), 0), i === 106 ? 13 : 11, `símbolo ${i}`);
  if (i < 106) assert.strictEqual((Number(p[0]) + Number(p[2]) + Number(p[4])) % 2, 0, `paridade ${i}`);
});
// "PJJ": início B (104) + P(48) J(42) J(42) + verificador (104+48+84+126=362 % 103 = 53) + parada
assert.strictEqual(B.larguras('PJJ'), B.PADROES[104] + B.PADROES[48] + B.PADROES[42] + B.PADROES[42] + B.PADROES[53] + B.PADROES[106]);
assert.strictEqual(B.larguras(''), null);
assert.ok(B.codigo128Svg('2000018846143466').startsWith('<svg'));

// nada das comandas (tem nome de cliente) no MCP
const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp.js'), 'utf8');
assert.ok(!/\/api\/comandas/.test(mcp), 'comandas fora do MCP');

console.log('Comandas: categorias, numeração do dia, prazo, código de barras e fora do MCP: ok');
