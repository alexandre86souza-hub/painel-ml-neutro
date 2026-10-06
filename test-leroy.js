'use strict';
// node test-leroy.js — Leroy Merlin (Mirakl): só funções puras e a regra de fora do MCP.
const assert = require('node:assert');
const L = require('./leroy.js');

// endereço do portal: só *.mirakl.net, normalizado; chave no formato da Mirakl; ID só números
assert.deepStrictEqual(L.validarConfig({ host: 'leroymerlin-prod.mirakl.net/mmp/shop/home', api_key: '01234567-89ab-cdef-0123-456789abcdef', shop_id: ' 11338 ' }),
  { host: 'https://leroymerlin-prod.mirakl.net', api_key: '01234567-89ab-cdef-0123-456789abcdef', shop_id: '11338' });
assert.strictEqual(L.validarConfig({ host: 'https://x.mirakl.net/' }).api_key, undefined, 'chave em branco: mantém a gravada');
assert.throws(() => L.validarConfig({ host: 'https://exemplo.com' }), /mirakl\.net/);
assert.throws(() => L.validarConfig({ host: 'https://x.mirakl.net.evil.com' }), /mirakl\.net/);
assert.throws(() => L.validarConfig({ host: 'https://x.mirakl.net', api_key: 'abc' }), /Chave de API/);
assert.throws(() => L.validarConfig({ host: 'https://x.mirakl.net', shop_id: '11a' }), /ID da loja/);

// dados do comprador nunca saem do módulo
const p = L.semPessoais({ order_id: 'A-1', order_state: 'SHIPPED', customer: { firstname: 'X', email: 'y' },
  order_lines: [{ price: 10, shipping_address: { street_1: 'z' } }] });
assert.deepStrictEqual(p, { order_id: 'A-1', order_state: 'SHIPPED', order_lines: [{ price: 10 }] });

// dados da Leroy não vão para o MCP (mesma regra da Amazon)
const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp.js'), 'utf8');
assert.ok(!/\/api\/leroy/.test(mcp), 'nenhuma ferramenta MCP aponta para /api/leroy');

console.log('Leroy Merlin: endereço, chave, ID da loja, sem dados de comprador e fora do MCP: ok');
