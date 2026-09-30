'use strict';
// Conversa com o DevCenter do Mercado Livre usando SÓ as credenciais do aplicativo
// (grant client_credentials), sem login de vendedor. Serve para duas coisas:
//   1. validar App ID + chave secreta no momento em que o aluno cola os dois;
//   2. ler as URLs que o ML REALMENTE tem gravadas e comparar com o túnel de agora.
// Medido em 18/09/2026: GET /applications/{id} devolve callback_urls[],
// notifications_callback_url, use_pkce e allow_flow; chave errada -> 400 invalid_client.
const API = 'https://api.mercadolibre.com';

const ERROS = {
  invalid_client: 'App ID ou chave secreta incorretos. Copie os dois de novo do DevCenter.',
  unauthorized_client: 'O aplicativo não permite o fluxo "Client Credentials". No DevCenter, em '
    + 'Fluxos OAuth, marque Authorization Code, Client Credentials e Refresh Token, e salve.',
};

async function tokenDoApp(clientId, clientSecret) {
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(ERROS[j.error] || j.message || j.error || `o ML respondeu ${r.status}`),
      { status: 400, codigo: j.error || String(r.status) });
  }
  return j.access_token;
}

async function lerApp(clientId, clientSecret) {
  const token = await tokenDoApp(clientId, clientSecret);
  const r = await fetch(`${API}/applications/${encodeURIComponent(clientId)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const a = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error(a.message || `não deu para ler o aplicativo (${r.status})`),
      { status: 502, codigo: a.error || String(r.status) });
  }
  const callbacks = Array.isArray(a.callback_urls) && a.callback_urls.length
    ? a.callback_urls : (a.callback_url ? [a.callback_url] : []);
  return {
    nome: a.name || null,
    callback_urls: callbacks,
    webhook: a.notifications_callback_url || null,
    topicos: Array.isArray(a.notifications_topics) ? a.notifications_topics : [],
    use_pkce: !!a.use_pkce,
    fluxos: Array.isArray(a.allow_flow) ? a.allow_flow : [],
    bloqueado: !!a.blocked,
  };
}

const semBarra = (u) => String(u || '').trim().replace(/\/+$/, '');

// Compara o túnel de agora com o cadastro no ML. Função pura: é o coração do aviso
// "a URL mudou" e tem teste próprio.
//   app        -> o que lerApp devolveu (null quando não deu para consultar o ML)
//   confirmada -> URL base que o aluno disse ter cadastrado (plano B sem consulta)
function situacao({ urlAtual, app, confirmada }) {
  if (!urlAtual) return { estado: 'sem_tunel' };
  const callback = `${urlAtual}/callback`;
  const webhook = `${urlAtual}/webhook`;
  const esperado = { callback, webhook };

  if (app) {
    // O ML compara a redirect_uri caractere a caractere: barra no fim já recusa.
    const callbackOk = app.callback_urls.includes(callback);
    const webhookOk = app.webhook === webhook;
    const dicas = [];
    if (!callbackOk && app.callback_urls.map(semBarra).includes(callback)) {
      dicas.push('A URI de redirect está cadastrada com uma barra "/" no final. Tire a barra.');
    }
    if (!webhookOk && semBarra(app.webhook) === webhook) {
      dicas.push('A URL de notificações está com uma barra "/" no final. Tire a barra.');
    }
    if (!app.fluxos.includes('authorization_code')) dicas.push('Marque "Authorization Code" em Fluxos OAuth.');
    if (!app.fluxos.includes('refresh_token')) {
      dicas.push('Marque "Refresh Token" em Fluxos OAuth — sem ele a conexão cai a cada 6 horas.');
    }
    // Endereço antigo do MESMO tipo de túnel = o aluno cadastrou certo, e a URL mudou depois.
    const antigo = app.callback_urls.find((u) => /\/callback$/.test(u) && u !== callback) || null;
    return {
      estado: callbackOk && webhookOk ? 'confere' : 'divergente',
      fonte: 'ml', esperado, callbackOk, webhookOk, dicas,
      cadastrado: { callback_urls: app.callback_urls, webhook: app.webhook },
      anterior: antigo ? antigo.replace(/\/callback$/, '') : null,
    };
  }

  if (confirmada) {
    return { estado: confirmada === urlAtual ? 'confere' : 'divergente', fonte: 'aluno', esperado,
      anterior: confirmada === urlAtual ? null : confirmada };
  }
  return { estado: 'nao_cadastrado', esperado };
}

module.exports = { tokenDoApp, lerApp, situacao };
