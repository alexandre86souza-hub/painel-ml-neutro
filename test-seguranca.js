'use strict';
// node test-seguranca.js — política de senha e verificação em duas etapas (TOTP, RFC 6238).
// Só funções puras.
const assert = require('node:assert');
const S = require('./seguranca.js');

// ---------- senha: 12+ caracteres, letra, número e caractere especial ----------
assert.strictEqual(S.problemaSenha('Loja-Metais-2026'), null);
assert.strictEqual(S.problemaSenha('Árvore#12345'), null, 'letra acentuada conta como letra');
assert.match(S.problemaSenha('Curta-1'), /12 caracteres/);
assert.match(S.problemaSenha('senhasemnumero!'), /número/);
assert.match(S.problemaSenha('SenhaSemEspecial1'), /especial/);
assert.match(S.problemaSenha('123456789012!'), /letra/);
assert.match(S.problemaSenha(''), /12 caracteres/);

// ---------- validade de 365 dias ----------
const agora = Date.parse('2026-09-30T12:00:00Z');
assert.strictEqual(S.senhaVencida('2026-01-10T00:00:00Z', agora), false);
assert.strictEqual(S.senhaVencida('2025-09-29T00:00:00Z', agora), true, 'mais de 365 dias');
assert.strictEqual(S.senhaVencida(null, agora), true, 'senha sem data (antiga) conta como vencida');

// ---------- base32 ----------
assert.strictEqual(S.base32(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
assert.strictEqual(S.deBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString(), '12345678901234567890');
assert.throws(() => S.deBase32('1!'), /base32/);
assert.match(S.novoSegredo(), /^[A-Z2-7]{32}$/);
assert.strictEqual(S.segredoLegivel('ABCDEFGHIJ'), 'ABCD EFGH IJ');

// ---------- TOTP: vetores do RFC 6238 (SHA-1, segredo "12345678901234567890") ----------
const seg = S.base32(Buffer.from('12345678901234567890'));
assert.strictEqual(S.codigoTotp(seg, S.passoDe(59e3), 8), '94287082');
assert.strictEqual(S.codigoTotp(seg, S.passoDe(1111111109e3), 8), '07081804');
assert.strictEqual(S.codigoTotp(seg, S.passoDe(2000000000e3), 8), '69279037');
assert.strictEqual(S.codigoTotp(seg, S.passoDe(59e3)), '287082', '6 dígitos = os 6 finais');

// confere: o passo atual, um antes e um depois (relógio do celular fora por até 30 s)
const t = 1111111109e3;
const cod = S.codigoTotp(seg, S.passoDe(t));
assert.strictEqual(S.codigoConfere(seg, cod, t), true);
assert.strictEqual(S.codigoConfere(seg, cod, t + 30e3), true, 'celular 30 s atrasado');
assert.strictEqual(S.codigoConfere(seg, cod, t - 30e3), true, 'celular 30 s adiantado');
assert.strictEqual(S.codigoConfere(seg, cod, t + 90e3), false, 'código velho não vale');
assert.strictEqual(S.codigoConfere(seg, ' ' + cod.slice(0, 3) + ' ' + cod.slice(3), t), true, 'espaços são ignorados');
assert.strictEqual(S.codigoConfere(seg, '12345', t), false);
assert.strictEqual(S.codigoConfere(seg, 'abcdef', t), false);
assert.strictEqual(S.codigoConfere(null, cod, t), false);

assert.match(S.otpauth(seg, 'Loja Exemplo', 'Painel'), /^otpauth:\/\/totp\/Painel%3ALoja%20Exemplo\?secret=GEZD/);

console.log('Segurança: política de senha, validade e verificação em duas etapas: ok');
