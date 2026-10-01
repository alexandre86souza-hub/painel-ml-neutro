'use strict';
// Política de acesso ao painel: senha forte com validade de 365 dias e verificação em duas
// etapas (código de 6 dígitos de um aplicativo autenticador — Google Authenticator,
// Microsoft Authenticator…). Exigência da Amazon para liberar a SP-API (30/09/2026): senha
// com 12+ caracteres e caractere especial, MFA, expiração de 365 dias e rotação anual.
//
// TOTP é o RFC 6238 (HMAC-SHA1, passos de 30 s, 6 dígitos), o que todo aplicativo
// autenticador entende. Só funções puras aqui: testadas em test-seguranca.js.
const crypto = require('node:crypto');

const SENHA_MIN = 12;
const VALIDADE_SENHA_DIAS = 365;
const POLITICA = `Mínimo de ${SENHA_MIN} caracteres, com letra, número e caractere especial (ex.: ! @ # $ % - _ .). Vale por ${VALIDADE_SENHA_DIAS} dias.`;

// Motivo da recusa, ou null se a senha atende a política.
function problemaSenha(senha) {
  const s = String(senha || '');
  if (s.length < SENHA_MIN) return `A senha precisa de ao menos ${SENHA_MIN} caracteres.`;
  if (!/\p{L}/u.test(s)) return 'A senha precisa ter pelo menos uma letra.';
  if (!/\d/.test(s)) return 'A senha precisa ter pelo menos um número.';
  if (!/[^\p{L}\d]/u.test(s)) return 'A senha precisa ter pelo menos um caractere especial (ex.: ! @ # $ % - _ .).';
  return null;
}

// Senha vencida? `definidaEm` é ISO; sem data (senha antiga) conta como vencida.
function senhaVencida(definidaEm, agoraMs = Date.now()) {
  const t = Date.parse(definidaEm || '');
  return !Number.isFinite(t) || agoraMs - t > VALIDADE_SENHA_DIAS * 864e5;
}

// ---------- base32 (RFC 4648), o formato das chaves dos autenticadores ----------
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, valor = 0, out = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += ALFABETO[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}
function deBase32(txt) {
  const s = String(txt || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, valor = 0; const out = [];
  for (const c of s) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error('chave base32 inválida');
    valor = (valor << 5) | i; bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const novoSegredo = () => base32(crypto.randomBytes(20));   // 160 bits, o recomendado pelo RFC 4226
// A chave em grupos de 4, para digitar no celular sem errar.
const segredoLegivel = (s) => String(s).match(/.{1,4}/g).join(' ');

// Código de um passo de 30 s. digitos=8 só para o vetor de teste do RFC.
function codigoTotp(segredoB32, passo, digitos = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', deBase32(segredoB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digitos).padStart(digitos, '0');
}
const passoDe = (ms) => Math.floor(ms / 30000);

// Confere o código digitado aceitando um passo antes e um depois (relógio do celular
// adiantado ou atrasado até 30 s). Comparação em tempo constante.
function codigoConfere(segredoB32, codigo, agoraMs = Date.now()) {
  const c = String(codigo || '').replace(/\s/g, '');
  if (!segredoB32 || !/^\d{6}$/.test(c)) return false;
  const p = passoDe(agoraMs);
  let ok = false;
  for (const d of [-1, 0, 1]) ok = crypto.timingSafeEqual(Buffer.from(codigoTotp(segredoB32, p + d)), Buffer.from(c)) || ok;
  return ok;
}

// Endereço que os aplicativos autenticadores entendem (para quem preferir colar o link).
const otpauth = (segredoB32, conta, emissor = 'Painel') =>
  `otpauth://totp/${encodeURIComponent(`${emissor}:${conta}`)}?secret=${segredoB32}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { SENHA_MIN, VALIDADE_SENHA_DIAS, POLITICA, problemaSenha, senhaVencida, base32, deBase32,
  novoSegredo, segredoLegivel, codigoTotp, codigoConfere, passoDe, otpauth };
