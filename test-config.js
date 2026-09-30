'use strict';
// node test-config.js — a regra que decide o aviso "a URL mudou", sem rede.
const assert = require('node:assert');
const { situacao } = require('./app-ml.js');

const NOVA = 'https://nova-url.trycloudflare.com';
const VELHA = 'https://velha-url.trycloudflare.com';
const app = (callbacks, webhook, fluxos = ['authorization_code', 'client_credentials', 'refresh_token']) =>
  ({ callback_urls: callbacks, webhook, fluxos, use_pkce: false });

// sem túnel não há o que comparar
assert.strictEqual(situacao({ urlAtual: null, app: null }).estado, 'sem_tunel');

// cadastro certinho no ML
let s = situacao({ urlAtual: NOVA, app: app([`${NOVA}/callback`], `${NOVA}/webhook`) });
assert.strictEqual(s.estado, 'confere');
assert.strictEqual(s.fonte, 'ml');
assert.deepStrictEqual(s.dicas, []);
assert.deepStrictEqual(s.esperado, { callback: `${NOVA}/callback`, webhook: `${NOVA}/webhook` });

// o túnel reiniciou e trocou de endereço: é o caso que motivou o aviso
s = situacao({ urlAtual: NOVA, app: app([`${VELHA}/callback`], `${VELHA}/webhook`) });
assert.strictEqual(s.estado, 'divergente');
assert.strictEqual(s.callbackOk, false);
assert.strictEqual(s.webhookOk, false);
assert.strictEqual(s.anterior, VELHA, 'mostra de onde veio, para o aluno achar no DevCenter');

// o ML aceita várias redirect URIs: a nova junto da velha já basta para o login
s = situacao({ urlAtual: NOVA, app: app([`${VELHA}/callback`, `${NOVA}/callback`], `${NOVA}/webhook`) });
assert.strictEqual(s.estado, 'confere');

// atualizou só a redirect e esqueceu a notificação: login funciona, webhook não
s = situacao({ urlAtual: NOVA, app: app([`${NOVA}/callback`], `${VELHA}/webhook`) });
assert.strictEqual(s.estado, 'divergente');
assert.strictEqual(s.callbackOk, true);
assert.strictEqual(s.webhookOk, false);

// barra no final: o ML compara caractere a caractere, então é erro — mas com dica certeira
s = situacao({ urlAtual: NOVA, app: app([`${NOVA}/callback/`], `${NOVA}/webhook/`) });
assert.strictEqual(s.estado, 'divergente');
assert.strictEqual(s.dicas.length, 2);
assert.ok(s.dicas.every((d) => /barra/.test(d)));

// fluxo faltando no app vira dica, não bloqueio
s = situacao({ urlAtual: NOVA, app: app([`${NOVA}/callback`], `${NOVA}/webhook`, ['authorization_code']) });
assert.strictEqual(s.estado, 'confere');
assert.ok(s.dicas.some((d) => /Refresh Token/.test(d)));

// sem conseguir ler o ML: vale o que o aluno confirmou
s = situacao({ urlAtual: NOVA, app: null, confirmada: NOVA });
assert.deepStrictEqual([s.estado, s.fonte, s.anterior], ['confere', 'aluno', null]);
s = situacao({ urlAtual: NOVA, app: null, confirmada: VELHA });
assert.deepStrictEqual([s.estado, s.fonte, s.anterior], ['divergente', 'aluno', VELHA]);
assert.strictEqual(situacao({ urlAtual: NOVA, app: null, confirmada: null }).estado, 'nao_cadastrado');

console.log('OK — situação da URL: confere, mudou, barra no fim, fluxos e plano B sem o ML');
