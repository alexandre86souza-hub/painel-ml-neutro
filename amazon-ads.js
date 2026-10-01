'use strict';
// Amazon Ads API (anúncios patrocinados da Amazon): conexão da conta de anúncios. Primeiro
// passo — credenciais do perfil de segurança do Login with Amazon, autorização da conta,
// escolha do perfil (país) e um diagnóstico do que a API devolve, antes das telas de
// Campanhas e Histórico ADS da Amazon.
//
// Como funciona (documentação da Amazon Ads API; conferir no diagnóstico com a conta real):
//   - Perfil de segurança no developer.amazon.com (Login with Amazon): Client ID e Client
//     Secret, digitados na tela (o segredo fica cifrado). O endereço de retorno
//     ({url pública}/amazon-ads/callback) tem de estar em "Allowed Return URLs".
//   - Autorização: https://www.amazon.com/ap/oa?client_id&scope=advertising::campaign_management
//     &response_type=code&redirect_uri&state. O Brasil fica na região América do Norte.
//   - Código -> tokens em https://api.amazon.com/auth/o2/token. O refresh token não muda a
//     cada renovação; o access token vale 1 h.
//   - Chamadas: https://advertising-api.amazon.com com Authorization: Bearer,
//     Amazon-Advertising-API-ClientId e, por perfil, Amazon-Advertising-API-Scope.
//
// Os mesmos compromissos da SP-API: nada disto vai para o MCP (test-amazon.js reprova
// qualquer /api/amazon no mcp.js) e o diagnóstico mostra a forma das respostas, sem valores.
const { forma } = require('./amazon.js');

const LWA_TOKEN = 'https://api.amazon.com/auth/o2/token';
const AUTORIZAR = 'https://www.amazon.com/ap/oa';
const HOST = 'https://advertising-api.amazon.com';
const ESCOPO = 'advertising::campaign_management';
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Credenciais digitadas na tela. Segredo vazio = mantém o gravado. Função pura: testada.
function validarConfig(b) {
  const id = String(b?.client_id ?? '').trim();
  if (!/^amzn1\.application-oa2-client\.[0-9a-z]{16,64}$/i.test(id)) {
    throw erro('Client ID: copie o "ID do cliente" do perfil de segurança (começa com amzn1.application-oa2-client.).');
  }
  const out = { client_id: id };
  const seg = String(b?.client_secret ?? '').trim();
  if (seg) {
    if (!/^amzn1\.oa2-cs\.\S{16,200}$/.test(seg)) throw erro('Client Secret: copie o "Segredo do cliente" inteiro (começa com amzn1.oa2-cs.).');
    out.client_secret = seg;
  }
  return out;
}

// Endereço da tela de autorização. Função pura: testada.
const urlAutorizacao = ({ clientId, redirect, state }) =>
  `${AUTORIZAR}?${new URLSearchParams({ client_id: clientId, scope: ESCOPO, response_type: 'code', redirect_uri: redirect, state })}`;

// Perfis de anúncio -> o que a tela mostra; o do Brasil de vendedor vem primeiro. Função pura: testada.
function perfisDe(lista) {
  return (lista || []).map((p) => ({ id: String(p.profileId), pais: p.countryCode || null, moeda: p.currencyCode || null,
    tipo: p.accountInfo?.type || null, nome: p.accountInfo?.name || null, marketplace: p.accountInfo?.marketplaceStringId || null }))
    .sort((a, b) => Number(b.pais === 'BR') - Number(a.pais === 'BR') || Number(b.tipo === 'seller') - Number(a.tipo === 'seller'));
}

function criar({ D, urlPublica, novoEstadoOAuth, consumirEstadoOAuth, portaPainel, enviarHtml, redirecionar, pagina, esc }) {
  const config = () => ({
    client_id: D.configLer('amzads_client_id') || null,
    client_secret: D.configLer('amzads_client_secret') || null,
    refresh_token: D.configLer('amzads_refresh_token') || null,
    perfil: D.configLer('amzads_perfil') || null,
  });
  const retorno = () => { const base = urlPublica(); return base ? `${new URL(base).origin}/amazon-ads/callback` : null; };

  async function lwa(corpo) {
    let r;
    try {
      r = await fetch(LWA_TOKEN, { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(corpo) });
    } catch (e) { throw erro(`A Amazon (login LWA) não respondeu (${e.message}).`, 502); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) throw erro(`A Amazon recusou: ${j?.error_description || j?.error || `HTTP ${r.status}`}.`, 401);
    return j;
  }

  let acesso = null, pedindo = null;
  async function token() {
    if (acesso && Date.now() < acesso.expira - 60e3) return acesso.token;
    if (!pedindo) {
      const c = config();
      if (!c.client_id || !c.client_secret || !c.refresh_token) throw erro('Conecte a conta de anúncios da Amazon primeiro.', 409);
      pedindo = lwa({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret })
        .then((j) => { acesso = { token: j.access_token, expira: Date.now() + (Number(j.expires_in) || 3600) * 1000 }; return acesso.token; })
        .finally(() => { pedindo = null; });
    }
    return pedindo;
  }

  // Uma chamada à Ads API. perfil: o Amazon-Advertising-API-Scope (quase todas pedem).
  async function ads(caminho, { metodo = 'GET', corpo = null, perfil = config().perfil, tipo = 'application/json' } = {}) {
    for (let tentativa = 0; ; tentativa++) {
      let r;
      try {
        r = await fetch(HOST + caminho, { method: metodo, signal: AbortSignal.timeout(30000), body: corpo ? JSON.stringify(corpo) : undefined,
          headers: { Authorization: `Bearer ${await token()}`, 'Amazon-Advertising-API-ClientId': config().client_id,
            ...(perfil ? { 'Amazon-Advertising-API-Scope': String(perfil) } : {}),
            Accept: tipo, ...(corpo ? { 'Content-Type': tipo } : {}) } });
      } catch (e) { if (e.status) throw e; throw erro(`A Amazon Ads não respondeu (${e.message}).`, 502); }
      if (r.status === 429 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 2000 * (tentativa + 1))); continue; }
      if (r.status === 401) acesso = null;
      const j = await r.json().catch(() => null);
      if (!r.ok) throw erro(`Amazon Ads: ${j?.details || j?.message || j?.code || `HTTP ${r.status}`}`, r.status >= 500 ? 502 : r.status);
      return j;
    }
  }

  // De onde o painel foi aberto, para voltar ao mesmo lugar depois da autorização.
  const origemDe = (url) => {
    if (url?.origin === 'https://painel') return new URL(urlPublica()).origin;
    if (url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return url.origin;
    return `http://localhost:${portaPainel()}`;
  };

  const rotas = {
    'GET /api/amazon-ads/config': async () => {
      const c = config();
      return { client_id: c.client_id, tem_segredo: !!c.client_secret, conectada: !!c.refresh_token, perfil: c.perfil,
        conectada_em: D.configLer('amzads_conectada_em'), retorno: retorno() };
    },
    'PUT /api/amazon-ads/config': async (_u, body) => {
      const c = validarConfig(body);
      D.configGravar('amzads_client_id', c.client_id);
      if (c.client_secret) D.configGravar('amzads_client_secret', c.client_secret);
      if (!D.configLer('amzads_client_secret')) throw erro('Informe também o Client Secret.');
      acesso = null;
      return { client_id: c.client_id, tem_segredo: true };
    },
    // Começa a autorização: devolve o endereço da Amazon para a tela abrir.
    'POST /api/amazon-ads/conectar': async (url) => {
      const c = config();
      if (!c.client_id || !c.client_secret) throw erro('Salve o Client ID e o Client Secret primeiro.', 409);
      const volta = retorno();
      if (!volta) throw erro('O endereço público (túnel) está fora do ar: a Amazon não tem para onde voltar.', 409);
      return { url: urlAutorizacao({ clientId: c.client_id, redirect: volta, state: novoEstadoOAuth({ origem: origemDe(url), amazonAds: true }) }) };
    },
    'GET /api/amazon-ads/perfis': async () => perfisDe(await ads('/v2/profiles', { perfil: null })),
    'PUT /api/amazon-ads/perfil': async (_u, body) => {
      const id = String(body?.perfil || '').trim();
      const perfis = perfisDe(await ads('/v2/profiles', { perfil: null }));
      if (!perfis.some((p) => p.id === id)) throw erro('Perfil não encontrado nesta conta de anúncios.');
      D.configGravar('amzads_perfil', id);
      return { perfil: id };
    },
    'POST /api/amazon-ads/remover': async () => {
      for (const k of ['amzads_refresh_token', 'amzads_perfil', 'amzads_conectada_em']) D.configGravar(k, null);
      acesso = null;
      return { removida: true };
    },
    // Diagnóstico: perfis e campanhas de Produtos Patrocinados (lista v3). Quantidades e a
    // FORMA das respostas, sem valores.
    'GET /api/amazon-ads/diagnostico': async () => {
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const perfis = await passo(async () => perfisDe(await ads('/v2/profiles', { perfil: null })));
      const tipoSp = 'application/vnd.spCampaign.v3+json';
      const camp = config().perfil ? await passo(() => ads('/sp/campaigns/list', { metodo: 'POST', tipo: tipoSp,
        corpo: { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 } })) : { erro: 'Escolha o perfil primeiro.' };
      const lista = camp.campaigns || [];
      const conta = (campo) => lista.reduce((m, c) => { m[c[campo] || '?'] = (m[c[campo] || '?'] || 0) + 1; return m; }, {});
      return {
        perfis: perfis.erro ? { erro: perfis.erro } : perfis.map((p) => ({ pais: p.pais, tipo: p.tipo, moeda: p.moeda, escolhido: p.id === config().perfil })),
        campanhas: camp.erro ? { erro: camp.erro } : { quantidade: lista.length, tem_mais: !!camp.nextToken, situacoes: conta('state'), segmentacao: conta('targetingType') },
        forma: { campanha: lista[0] ? forma(lista[0]) : null },
      };
    },
  };

  // Retorno da autorização, pelo endereço público. Quem prova que o pedido nasceu no painel é
  // o state de uso único (15 min).
  async function callback(res, url) {
    const st = consumirEstadoOAuth(url.searchParams.get('state') || '');
    const voltar = st?.origem || `http://localhost:${portaPainel()}`;
    const falha = (titulo, detalhe, code = 400) => enviarHtml(res, pagina(titulo, `<h1>${esc(titulo)}</h1>
<pre>${esc(detalhe)}</pre><p><a href="${esc(voltar)}/amazon-ads.html">Voltar ao painel</a></p>`, code));
    if (!st?.amazonAds) return falha('Autorização expirada ou desconhecida', 'Este retorno não corresponde a um "Conectar" feito pelo painel nos últimos 15 minutos.\nVolte ao painel e clique em "Conectar conta de anúncios" de novo.');
    if (url.searchParams.get('error')) return falha('A Amazon não autorizou', `${url.searchParams.get('error')}: ${url.searchParams.get('error_description') || ''}`);
    const code = url.searchParams.get('code');
    if (!code) return falha('Retorno sem código', 'A Amazon não enviou o código de autorização.');
    try {
      const c = config();
      const t = await lwa({ grant_type: 'authorization_code', code, redirect_uri: retorno(), client_id: c.client_id, client_secret: c.client_secret });
      D.configGravar('amzads_refresh_token', t.refresh_token);
      D.configGravar('amzads_conectada_em', new Date().toISOString());
      acesso = { token: t.access_token, expira: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
      // perfil do Brasil escolhido sozinho, se houver um só
      try {
        const br = perfisDe(await ads('/v2/profiles', { perfil: null })).filter((p) => p.pais === 'BR');
        if (br.length === 1) D.configGravar('amzads_perfil', br[0].id);
      } catch { /* a tela deixa escolher */ }
      return redirecionar(res, `${voltar}/amazon-ads.html?conectado=1`);
    } catch (e) { return falha('A Amazon não entregou o acesso', e.message, 502); }
  }

  return { rotas, rotasParam: [], callback, ads };
}

module.exports = { criar, validarConfig, urlAutorizacao, perfisDe, ESCOPO };
