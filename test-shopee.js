'use strict';
// node test-shopee.js — conexão com a Shopee: assinatura das chamadas, endereço de
// autorização e validação das credenciais. Só funções puras: nada aqui chama a Shopee.
const assert = require('node:assert');
const crypto = require('node:crypto');
const S = require('./shopee.js');

// ---------- sign: HMAC-SHA256(partner_key, base) em hexadecimal ----------
const chave = 'chave-de-teste-0123456789abcdef';
const hmac = (base) => crypto.createHmac('sha256', chave).update(base).digest('hex');
// chamada pública: partner_id + caminho + timestamp
assert.strictEqual(S.assinar(chave, '2001234', '/api/v2/auth/token/get', 1790000000), hmac('2001234/api/v2/auth/token/get1790000000'));
// chamada da loja: a mesma base + access_token + shop_id, nessa ordem
assert.strictEqual(S.assinar(chave, '2001234', '/api/v2/order/get_order_list', 1790000000, 'tok', 555),
  hmac('2001234/api/v2/order/get_order_list1790000000tok555'));
assert.match(S.assinar(chave, 1, '/x', 1), /^[0-9a-f]{64}$/);
assert.notStrictEqual(S.assinar(chave, '2001234', '/a', 1), S.assinar(chave + 'x', '2001234', '/a', 1), 'a chave muda o sign');

// ---------- endereço de autorização ----------
const u = new URL(S.urlAutorizacao({ host: S.AMBIENTES.producao.host, partnerId: '2001234', partnerKey: chave,
  redirect: 'https://exemplo.trycloudflare.com/shopee/callback/abc', ts: 1790000000 }));
assert.strictEqual(u.origin + u.pathname, 'https://openplatform.shopee.com.br/api/v2/shop/auth_partner');
assert.strictEqual(u.searchParams.get('partner_id'), '2001234');
assert.strictEqual(u.searchParams.get('timestamp'), '1790000000');
assert.strictEqual(u.searchParams.get('redirect'), 'https://exemplo.trycloudflare.com/shopee/callback/abc');
assert.strictEqual(u.searchParams.get('sign'), hmac('2001234/api/v2/shop/auth_partner1790000000'), 'o redirect não entra no sign');
assert.ok(!u.href.includes(chave), 'a chave nunca vai no endereço');

// ---------- credenciais digitadas na tela ----------
assert.deepStrictEqual(S.validarConfig({ partner_id: ' 2001234 ', partner_key: ' ' + chave + ' ', ambiente: 'teste' }),
  { partner_id: '2001234', partner_key: chave, ambiente: 'teste' });
assert.deepStrictEqual(S.validarConfig({ partner_id: '2001234' }), { partner_id: '2001234', ambiente: 'producao' },
  'sem chave no corpo: mantém a gravada; ambiente padrão é produção');
assert.throws(() => S.validarConfig({ partner_id: 'abc' }), /Partner ID/);
assert.throws(() => S.validarConfig({ partner_id: '2001234', partner_key: 'curta' }), /Partner Key/);
assert.throws(() => S.validarConfig({ partner_id: '2001234', ambiente: 'outro' }), /Ambiente/);

console.log('Shopee: assinatura, autorização e credenciais: ok');
