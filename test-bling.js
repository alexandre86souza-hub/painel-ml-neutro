'use strict';
// Bling (bling.js): funções puras da conexão e o compromisso de nada do Bling no MCP.
const assert = require('assert');
const fs = require('fs');
const B = require('./bling.js');

// credenciais
assert.throws(() => B.validarConfig({ client_id: 'x' }), /Client ID/);
const c = B.validarConfig({ client_id: ' a1b2c3d4e5f6a7b8c9d0 ', nome: ' AMG ', lojas: 'Shopee AMG' });
assert.deepStrictEqual(c, { client_id: 'a1b2c3d4e5f6a7b8c9d0', nome: 'AMG', lojas: 'Shopee AMG' }, 'segredo vazio = mantém o gravado');
assert.throws(() => B.validarConfig({ client_id: 'a1b2c3d4e5f6a7b8c9d0', client_secret: 'com espaço no meio' }), /Client Secret/);
assert.strictEqual(B.validarConfig({ client_id: 'a1b2c3d4e5f6a7b8c9d0', client_secret: 'f'.repeat(60) }).client_secret, 'f'.repeat(60));

// conta
assert.strictEqual(B.contaValida(2), '2');
assert.throws(() => B.contaValida('3'), /inválida/);

// autorização
const u = new URL(B.urlAutorizacao({ clientId: 'abc123', state: 'xyz' }));
assert.strictEqual(u.origin + u.pathname, 'https://www.bling.com.br/Api/v3/oauth/authorize');
assert.strictEqual(u.searchParams.get('response_type'), 'code');
assert.strictEqual(u.searchParams.get('client_id'), 'abc123');
assert.strictEqual(u.searchParams.get('state'), 'xyz');

// itens: só o que é do produto
const it = B.itensDoProduto([{ codigo: 'AMg-769.790', descricao: 'Ducha', classificacaoFiscal: '8481.80.19', unidade: 'UN', quantidade: 1, valor: 10, produto: { id: 0 }, contato: { nome: 'x' } },
  { codigo: '', descricao: 'Chuveirinho', quantidade: 2, produto: { id: 55 } }]);
assert.deepStrictEqual(it[0], { codigo: 'AMg-769.790', descricao: 'Ducha', ncm: '8481.80.19', unidade: 'UN', quantidade: 1, produto_vinculado: false });
assert.strictEqual(it[1].produto_vinculado, true);
assert.ok(!('contato' in it[0]) && !('valor' in it[0]));

// nota fiscal tem dado do comprador: nada do Bling no MCP
assert.ok(!/\/api\/bling/.test(fs.readFileSync('./mcp.js', 'utf8')), 'mcp.js não pode apontar para /api/bling');

console.log('test-bling: ok');
