'use strict';
// Shopee Open Platform (API v2): conexão da loja. Primeiro passo da integração — credenciais
// do aplicativo, autorização da loja, tokens e um diagnóstico que mostra o que a Shopee
// devolve de verdade (pedidos, itens, repasse) antes de o painel calcular qualquer coisa.
//
// Como a Shopee funciona (documentação da API v2; conferir no diagnóstico com a loja real):
//   - Aplicativo = partner_id + partner_key (digitados na tela Shopee, nunca no chat; a
//     chave fica cifrada no SQLite, como a chave secreta do Mercado Livre).
//   - Toda chamada leva sign = HMAC-SHA256(partner_key, base) em hexadecimal. Base das
//     chamadas públicas (autorizar, trocar código por token): partner_id + caminho +
//     timestamp. Base das chamadas da loja: a mesma + access_token + shop_id.
//   - Autorizar: {host}/api/v2/shop/auth_partner?partner_id&timestamp&sign&redirect. A
//     Shopee volta para `redirect` com ?code=…&shop_id=…; o domínio do redirect tem de
//     estar cadastrado no aplicativo.
//   - access_token vale ~4 h; refresh_token vale 30 dias e é de USO ÚNICO: cada renovação
//     devolve outro, que tem de ser gravado na hora (perdeu, a loja precisa autorizar de novo).
//   - Erro vem com HTTP 200 e o campo "error" preenchido.
const crypto = require('node:crypto');

const AMBIENTES = {
  producao: { nome: 'Produção (lojas do Brasil)', host: 'https://openplatform.shopee.com.br' },
  teste: { nome: 'Teste (sandbox)', host: 'https://openplatform.sandbox.test-stable.shopee.sg' },
};
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// sign de uma chamada. Função pura: testada.
function assinar(partnerKey, partnerId, caminho, ts, accessToken = '', shopId = '') {
  return crypto.createHmac('sha256', String(partnerKey)).update(`${partnerId}${caminho}${ts}${accessToken}${shopId}`).digest('hex');
}

// Endereço da tela de autorização da Shopee. Função pura: testada.
function urlAutorizacao({ host, partnerId, partnerKey, redirect, ts }) {
  const caminho = '/api/v2/shop/auth_partner';
  const qs = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(ts),
    sign: assinar(partnerKey, partnerId, caminho, ts), redirect });
  return `${host}${caminho}?${qs}`;
}

// Credenciais digitadas na tela. partner_key ausente = mantém a gravada. Função pura: testada.
function validarConfig(b) {
  const out = {};
  const id = String(b?.partner_id ?? '').trim();
  if (!/^\d{4,12}$/.test(id)) throw erro('Partner ID: só os números do aplicativo (ex.: 2001234).');
  out.partner_id = id;
  if (b?.partner_key != null && String(b.partner_key).trim() !== '') {
    const k = String(b.partner_key).trim();
    if (k.length < 16 || k.length > 200 || /\s/.test(k)) throw erro('Partner Key inválida: copie a chave inteira do aplicativo, sem espaços.');
    out.partner_key = k;
  }
  const amb = b?.ambiente || 'producao';
  if (!AMBIENTES[amb]) throw erro('Ambiente: producao ou teste.');
  out.ambiente = amb;
  return out;
}

function criar({ D, urlPublica, novoEstadoOAuth, consumirEstadoOAuth, portaPainel, enviarHtml, redirecionar, pagina, esc }) {
  const config = () => ({
    partner_id: D.configLer('shopee_partner_id') || null,
    partner_key: D.configLer('shopee_partner_key') || null,
    ambiente: AMBIENTES[D.configLer('shopee_ambiente')] ? D.configLer('shopee_ambiente') : 'producao',
  });
  const exigeConfig = () => {
    const c = config();
    if (!c.partner_id || !c.partner_key) throw erro('Informe o Partner ID e a Partner Key do aplicativo da Shopee primeiro.', 409);
    return { ...c, host: AMBIENTES[c.ambiente].host };
  };
  const agoraS = () => Math.floor(Date.now() / 1000);

  // Uma chamada à Shopee. Erro da Shopee (HTTP 200 com "error") vira exceção com a mensagem dela.
  async function pedir(url, opts = {}) {
    let r;
    try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw erro(`A Shopee não respondeu (${e.message}).`, 502); }
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!j) throw erro(`A Shopee respondeu ${r.status} sem JSON.`, 502);
    if (j.error) throw Object.assign(erro(`Shopee: ${j.message || j.error} (${j.error})`, r.status >= 400 ? r.status : 502), { shopee: j.error });
    return j;
  }

  // Chamadas públicas (sem loja): trocar o código por token e renovar o token.
  async function publica(caminho, corpo) {
    const c = exigeConfig();
    const ts = agoraS();
    const qs = new URLSearchParams({ partner_id: c.partner_id, timestamp: String(ts), sign: assinar(c.partner_key, c.partner_id, caminho, ts) });
    return pedir(`${c.host}${caminho}?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...corpo, partner_id: Number(c.partner_id) }) });
  }

  // Renovação: o refresh_token é de uso único, então só uma renovação por loja de cada vez
  // e o token novo é gravado antes de qualquer outra coisa.
  const renovando = new Map();
  function renovar(loja) {
    if (renovando.has(loja.shop_id)) return renovando.get(loja.shop_id);
    const p = (async () => {
      const t = await publica('/api/v2/auth/access_token/get', { refresh_token: loja.refresh_token, shop_id: Number(loja.shop_id) });
      D.shopeeTokensGravar(loja.shop_id, t);
      return D.shopeeLojaObter(loja.shop_id);
    })().finally(() => renovando.delete(loja.shop_id));
    renovando.set(loja.shop_id, p);
    return p;
  }

  // Chamada da loja (GET com parâmetros, ou POST com corpo). Token vencido renova e repete uma vez.
  async function daLoja(shopId, caminho, params = {}, corpo = null) {
    const c = exigeConfig();
    let loja = D.shopeeLojaObter(shopId);
    if (!loja) throw erro('Loja da Shopee não conectada.', 404);
    if (Date.now() > loja.expira_em - 60e3) loja = await renovar(loja);
    const chamar = (l) => {
      const ts = agoraS();
      const qs = new URLSearchParams({ partner_id: c.partner_id, timestamp: String(ts), access_token: l.access_token,
        shop_id: String(l.shop_id), sign: assinar(c.partner_key, c.partner_id, caminho, ts, l.access_token, l.shop_id) });
      for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
      return pedir(`${c.host}${caminho}?${qs}`, corpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) } : {});
    };
    try { return await chamar(loja); }
    catch (e) {
      if (!/auth|access_token/i.test(e.shopee || '')) throw e;
      return chamar(await renovar(loja));
    }
  }

  // De onde o painel foi aberto, para voltar ao mesmo lugar depois da autorização.
  const origemDe = (url) => {
    if (url?.origin === 'https://painel') return new URL(urlPublica()).origin;                 // painel online (túnel)
    if (url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return url.origin;
    return `http://localhost:${portaPainel()}`;
  };

  const rotas = {
    'GET /api/shopee/config': async () => {
      const c = config();
      const base = urlPublica();
      return { partner_id: c.partner_id, tem_chave: !!c.partner_key, ambiente: c.ambiente,
        ambientes: Object.entries(AMBIENTES).map(([id, a]) => ({ id, nome: a.nome })),
        // o que cadastrar no aplicativo da Shopee (campo de domínio de redirecionamento)
        dominio_redirect: base ? new URL(base).origin : null,
        lojas: D.shopeeLojasListar() };
    },

    'PUT /api/shopee/config': async (_u, body) => {
      const c = validarConfig(body);
      D.configGravar('shopee_partner_id', c.partner_id);
      if (c.partner_key) D.configGravar('shopee_partner_key', c.partner_key);
      D.configGravar('shopee_ambiente', c.ambiente);
      if (!D.configLer('shopee_partner_key')) throw erro('Informe também a Partner Key.');
      return { partner_id: c.partner_id, tem_chave: true, ambiente: c.ambiente };
    },

    // Começa a autorização: devolve o endereço da Shopee para a tela abrir. O retorno chega
    // pelo endereço público (túnel) em /shopee/callback/{state}.
    'POST /api/shopee/conectar': async (url) => {
      const c = exigeConfig();
      const base = urlPublica();
      if (!base) throw erro('O endereço público (túnel) está fora do ar: a Shopee não tem para onde voltar.', 409);
      const state = novoEstadoOAuth({ origem: origemDe(url), shopee: true });
      return { url: urlAutorizacao({ host: c.host, partnerId: c.partner_id, partnerKey: c.partner_key,
        redirect: `${base}/shopee/callback/${state}`, ts: agoraS() }) };
    },

    // Diagnóstico: o que a Shopee devolve para esta loja — dados da loja, os pedidos dos
    // últimos dias, o detalhe do mais recente e o repasse (taxas e frete) dele. Só leitura.
    // Não pede endereço nem dados do comprador.
    'GET /api/shopee/diagnostico': async (url) => {
      const shopId = Number(url.searchParams.get('loja'));
      if (!Number.isInteger(shopId)) throw erro('Informe a loja.');
      const dias = Math.min(15, Math.max(1, Number(url.searchParams.get('dias')) || 7));   // a Shopee aceita até 15 dias por consulta
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const loja = await passo(() => daLoja(shopId, '/api/v2/shop/get_shop_info'));
      const lista = await passo(() => daLoja(shopId, '/api/v2/order/get_order_list', {
        time_range_field: 'create_time', time_from: agoraS() - dias * 86400, time_to: agoraS(), page_size: 50 }));
      const pedidos = lista.response?.order_list || [];
      const sn = pedidos.at(-1)?.order_sn || null;
      const detalhe = sn ? await passo(() => daLoja(shopId, '/api/v2/order/get_order_detail', { order_sn_list: sn,
        response_optional_fields: ['item_list', 'total_amount', 'pay_time', 'actual_shipping_fee', 'estimated_shipping_fee',
          'actual_shipping_fee_confirmed', 'shipping_carrier', 'payment_method', 'fulfillment_flag', 'cancel_reason'] })) : null;
      const repasse = sn ? await passo(() => daLoja(shopId, '/api/v2/payment/get_escrow_detail', { order_sn: sn })) : null;
      return { loja, dias, pedidos_no_periodo: pedidos.length, tem_mais: !!lista.response?.more,
        situacoes: pedidos.reduce((m, p) => { m[p.order_status || '?'] = (m[p.order_status || '?'] || 0) + 1; return m; }, {}),
        erro_pedidos: lista.erro || null, pedido_exemplo: sn, detalhe, repasse };
    },
  };

  const rotasParam = [
    { m: 'POST', re: /^\/api\/shopee\/lojas\/(\d+)\/remover$/, fn: async ([id]) => {
      D.shopeeLojaRemover(Number(id));
      return { removida: Number(id) };
    } },
  ];

  // Retorno da autorização, pelo endereço público. Não vê a sessão do painel: quem prova que
  // o pedido nasceu aqui é o state de uso único (15 min) que vai no caminho.
  async function callback(res, url) {
    const st = consumirEstadoOAuth(url.pathname.split('/').pop() || '');
    const voltar = st?.origem || `http://localhost:${portaPainel()}`;
    const falha = (titulo, detalhe, code = 400) => enviarHtml(res, pagina(titulo, `<h1>${esc(titulo)}</h1>
<pre>${esc(detalhe)}</pre><p><a href="${esc(voltar)}/shopee.html">Voltar ao painel</a></p>`, code));
    if (!st?.shopee) {
      return falha('Autorização expirada ou desconhecida', 'Este retorno não corresponde a um "Conectar loja" feito pelo painel '
        + 'nos últimos 15 minutos (ou o painel foi reiniciado no meio).\nVolte ao painel e clique em "Conectar loja" de novo.');
    }
    const code = url.searchParams.get('code');
    const shopId = Number(url.searchParams.get('shop_id'));
    if (!code || !Number.isInteger(shopId) || shopId <= 0) {
      return falha('Retorno sem código ou sem loja', 'A Shopee não enviou "code" e "shop_id". Se você autorizou uma conta principal '
        + '(várias lojas), me avise: esse caso ainda não é atendido.\n\nParâmetros recebidos: ' + [...url.searchParams.keys()].join(', '));
    }
    try {
      const t = await publica('/api/v2/auth/token/get', { code, shop_id: shopId });
      D.shopeeLojaSalvar(shopId, t);
      // nome da loja: enfeite — se falhar, a loja fica conectada com o número
      try {
        const info = await daLoja(shopId, '/api/v2/shop/get_shop_info');
        D.shopeeLojaNomear(shopId, info.shop_name || null, info.region || null);
      } catch { /* segue sem nome */ }
      return redirecionar(res, `${voltar}/shopee.html?conectado=${shopId}`);
    } catch (e) { return falha('A Shopee não entregou o acesso', e.message, 502); }
  }

  return { rotas, rotasParam, callback, daLoja };
}

module.exports = { criar, assinar, urlAutorizacao, validarConfig, AMBIENTES };
