'use strict';
// node test-mensagens.js — central de mensagens (mensagens.js): só funções puras, nada chama
// o Mercado Livre nem a Shopee.
const assert = require('node:assert');
const M = require('./mensagens.js');

// datas de todos os formatos
assert.strictEqual(M.dataDe('2026-10-05T13:01:53.466-04:00'), '2026-10-05T17:01:53.466Z');
assert.strictEqual(M.dataDe(1790000000), new Date(1790000000e3).toISOString(), 'segundos');
assert.strictEqual(M.dataDe(1790000000123), new Date(1790000000123).toISOString(), 'milissegundos');
assert.strictEqual(M.dataDe('1727086113355991607'), new Date(1727086113355).toISOString(), 'nanossegundos (Shopee)');
assert.strictEqual(M.dataDe(null), null);

// reclamação do ML (formas medidas em 06/10/2026)
const conta = 111111111;
const claim = (acoes, vendedor = conta) => ({ players: [{ role: 'complainant', user_id: 1, available_actions: [] },
  { role: 'respondent', user_id: vendedor, available_actions: acoes.map((action) => ({ action })) }] });
const msg = (sender_role, d) => ({ sender_role, message: 'x', message_date: d });
assert.deepStrictEqual(M.destinosDe(claim(['send_message_to_complainant', 'refund'])), ['complainant']);
assert.deepStrictEqual(M.destinosDe(claim(['send_message_to_mediator'])), ['mediator']);
assert.strictEqual(M.reclamacaoPendente(claim(['send_message_to_complainant']), [msg('complainant', '2026-10-05')], conta), true, 'comprador falou por último');
assert.strictEqual(M.reclamacaoPendente(claim(['send_message_to_complainant']),
  [msg('complainant', '2026-10-05'), msg('respondent', '2026-10-06')], conta), false, 'vendedor já respondeu');
assert.strictEqual(M.reclamacaoPendente(claim(['send_message_to_complainant']), [msg('respondent', '2026-10-06'), msg('mediator', '2026-10-07')], conta), true, 'ML escreveu depois');
assert.strictEqual(M.reclamacaoPendente(claim(['send_message_to_mediator']), [], conta, { action_responsible: 'complainant' }), false, 'a vez é do comprador');
assert.strictEqual(M.reclamacaoPendente(claim(['send_message_to_mediator']), [], conta, { action_responsible: 'respondent' }), true, 'a vez é do vendedor');
assert.strictEqual(M.reclamacaoPendente(claim(['refund']), [msg('complainant', '2026-10-05')], conta), false, 'sem poder mandar mensagem');
assert.strictEqual(M.reclamacaoPendente(claim(['send_message_to_complainant'], 999), [msg('complainant', '2026-10-05')], conta), false, 'a conta é a compradora');

// chat da Shopee: o comprador (to_id) falou por último
assert.strictEqual(M.chatPendente({ to_id: 508472477, latest_message_from_id: 508472477 }), true);
assert.strictEqual(M.chatPendente({ to_id: 508472477, latest_message_from_id: 445639669 }), false);
assert.strictEqual(M.textoShopee('text', { text: 'Oi' }), 'Oi');
assert.strictEqual(M.textoShopee('item', { item_id: 1 }), '[produto]');

// modelos: variáveis e limites de cada canal
assert.strictEqual(M.preencher('Olá {comprador}, sobre o {produto} do pedido {pedido}.', { comprador: 'ana', produto: 'Ducha' }),
  'Olá ana, sobre o Ducha do pedido {pedido}.', 'variável sem valor fica para o vendedor editar');
assert.strictEqual(M.textoValido('  ok  ', 'pergunta'), 'ok');
assert.throws(() => M.textoValido('   ', 'chat'), /Escreva/);
assert.throws(() => M.textoValido('x'.repeat(351), 'mensagem'), /350/);
assert.strictEqual(M.textoValido('x'.repeat(350), 'mensagem').length, 350);

console.log('Central de mensagens: pendências do ML e da Shopee, datas, modelos e limites: ok');
