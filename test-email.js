'use strict';
// E-mail do painel (email.js): a mensagem MIME e os tipos de aviso que vão por e-mail.
const assert = require('node:assert');
const E = require('./email.js');

{
  const m = E.mensagemMime({ de: 'painel@exemplo.com', para: ['a@x.com', 'b@y.com'], assunto: 'Como foi 26/10: R$ 7.000,00', html: '<p>Olá</p>', texto: 'Olá' },
    new Date('2026-10-27T10:30:00Z'), 'abc');
  assert.match(m, /^From: Painel <painel@exemplo\.com>\r\nTo: a@x\.com, b@y\.com\r\n/);
  assert.match(m, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/, 'assunto com acento vai codificado');
  assert.strictEqual(Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(m)[1], 'base64').toString('utf8'), 'Como foi 26/10: R$ 7.000,00');
  assert.match(m, /Content-Type: multipart\/alternative; boundary="=_painel_abc"/);
  assert.ok(m.includes(Buffer.from('<p>Olá</p>').toString('base64')), 'HTML em base64');
  assert.ok(!/^\.[^.]/m.test(m), 'nenhuma linha começa com um ponto sozinho (fim do DATA)');
}
assert.ok(E.TIPOS_EMAIL.has('seguranca') && E.TIPOS_EMAIL.has('estoque_envio') && !E.TIPOS_EMAIL.has('venda'), 'venda nova fica só no sino');

console.log('E-mail: mensagem MIME e tipos de aviso: ok');
