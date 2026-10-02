'use strict';
// node test-reputacao.js — reputação (reputacao.js): categoria do problema e sugestão. Só funções
// puras: nada aqui chama o Mercado Livre.
const assert = require('node:assert');
const R = require('./reputacao.js');

// ---------- categoria: pelo código do motivo (reason.name) e, sem ele, pelo texto ----------
assert.strictEqual(R.categoriaDe('Chegou bem', 'broken_item'), 'defeito', 'o código vale mais que o texto');
assert.strictEqual(R.categoriaDe('', 'different_than_published'), 'diferente');
assert.strictEqual(R.categoriaDe('O comprador disse que o produto recebido não é igual ao do anúncio'), 'diferente');
assert.strictEqual(R.categoriaDe('O comprador disse que o produto não funciona'), 'defeito');
assert.strictEqual(R.categoriaDe('O comprador disse que se arrependeu da compra'), 'arrependimento');
assert.strictEqual(R.categoriaDe('Faltam peças no kit'), 'incompleto');
assert.strictEqual(R.categoriaDe('O pacote não chegou'), 'nao_recebeu');
assert.strictEqual(R.categoriaDe('xyz'), 'outro');

// ---------- sugestão ----------
const s1 = R.sugestaoDe({ categoria: 'diferente', afeta: true, aberta: true, acoes: ['open_dispute', 'send_message_to_complainant'], pedido: 123, produto: 'Ducha X' });
assert.match(s1.titulo, /Contestar/);
assert.match(s1.passos[0], /Responda ao comprador/, 'responder vem primeiro quando dá');
assert.ok(s1.passos.some((p) => /disputa/.test(p)), 'com open_dispute: sugere a disputa');
assert.match(s1.mensagem, /pedido 123/); assert.match(s1.mensagem, /"Ducha X"/);
const s2 = R.sugestaoDe({ categoria: 'defeito', afeta: true, aberta: false, acoes: [] });
assert.ok(s2.passos.some((p) => /já foi fechada/.test(p)), 'fechada: pedir revisão ao ML');
assert.ok(!s2.passos.some((p) => /disputa/.test(p)));
const s3 = R.sugestaoDe({ categoria: 'arrependimento', afeta: false, aberta: true, acoes: ['refund'] });
assert.match(s3.titulo, /Aceitar a devolução/);
for (const c of Object.keys(R.NOMES)) { const s = R.sugestaoDe({ categoria: c, afeta: true, aberta: true, acoes: [] }); assert.ok(s.titulo && s.passos.length && s.mensagem, c); }

console.log('Reputação: categoria do problema e sugestão de solução ou contestação: ok');
