'use strict';
// Bling (ERP das notas fiscais): conexão das DUAS contas do vendedor (pedido do dono, 05/11/2026). Conta 1 = notas da
// Shopee AMG; conta 2 = Amazon, Leroy, Shopee Primor e Magalu (o nome e as lojas de cada uma são digitados na tela).
// Objetivo: emitir pelo painel a nota do pedido que a integração do Bling importou, com o nome CURTO do produto,
// SEM código e com o NCM do produto — hoje o vendedor abre nota por nota no Bling para isso. Esta primeira etapa só
// CONECTA e faz o diagnóstico (leitura): o que a API v3 devolve nos pedidos e nas notas da conta real.
//
// API v3 do Bling (developer.bling.com.br; conferir no diagnóstico):
//   - Aplicativo criado pelo vendedor na Central de Extensões (Área do integrador): Client ID e Client Secret, digitados
//     na tela (segredo cifrado). O "Link de redirecionamento" do aplicativo = {url pública}/bling/callback.
//   - Autorização: https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id&state.
//   - Token: POST /oauth/token com Authorization: Basic base64(id:segredo), formulário grant_type=authorization_code&code
//     (ou refresh_token). Access token ~6 h; o refresh MUDA a cada renovação: grava o novo na hora.
//   - Limite: 3 requisições por segundo por conta.
// Nota fiscal tem dado do comprador (nome, CPF, endereço): o diagnóstico mostra só a FORMA das respostas e, dos itens,
// só o que é do produto (descrição, código, NCM). Nada do Bling no MCP (test-bling.js reprova).
const { forma } = require('./amazon.js');

const API = 'https://api.bling.com.br/Api/v3';
const TOKEN = [`${API}/oauth/token`, 'https://www.bling.com.br/Api/v3/oauth/token'];
const AUTORIZAR = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const CONTAS = ['1', '2'];
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const chave = (n, k) => `bling_${n}_${k}`;

function contaValida(n) {
  const c = String(n ?? '');
  if (!CONTAS.includes(c)) throw erro('Conta do Bling inválida (1 ou 2).');
  return c;
}

// Credenciais e nome digitados na tela. Segredo vazio = mantém o gravado. Função pura: testada.
function validarConfig(b) {
  const id = String(b?.client_id ?? '').trim();
  if (!/^[0-9a-z]{16,128}$/i.test(id)) throw erro('Client ID: copie o "Client Id" do aplicativo no Bling (letras e números, sem espaços).');
  const out = { client_id: id, nome: String(b?.nome ?? '').trim().slice(0, 60) || null, lojas: String(b?.lojas ?? '').trim().slice(0, 200) || null };
  const seg = String(b?.client_secret ?? '').trim();
  if (seg) {
    if (!/^[0-9a-z]{16,200}$/i.test(seg)) throw erro('Client Secret: copie o "Client Secret" inteiro do aplicativo no Bling.');
    out.client_secret = seg;
  }
  return out;
}

// Endereço da autorização. Função pura: testada.
const urlAutorizacao = ({ clientId, state }) => `${AUTORIZAR}?${new URLSearchParams({ response_type: 'code', client_id: clientId, state })}`;

// Itens de pedido/nota -> só o que é do produto (sem nada do comprador). Função pura: testada.
const itensDoProduto = (itens) => (itens || []).map((i) => ({
  codigo: i.codigo ?? null, descricao: i.descricao ?? null, ncm: i.classificacaoFiscal ?? i.ncm ?? null,
  unidade: i.unidade ?? null, quantidade: i.quantidade ?? null, produto_vinculado: !!(i.produto?.id && Number(i.produto.id) > 0) }));

// Conta quantos de cada valor. Função pura.
const contar = (lista, f) => lista.reduce((m, x) => { const k = String(f(x) ?? '—'); m[k] = (m[k] || 0) + 1; return m; }, {});

function criar({ D, urlPublica, novoEstadoOAuth, consumirEstadoOAuth, portaPainel, enviarHtml, redirecionar, pagina, esc }) {
  const config = (n) => ({
    client_id: D.configLer(chave(n, 'client_id')) || null,
    client_secret: D.configLer(chave(n, 'client_secret')) || null,
    refresh_token: D.configLer(chave(n, 'refresh_token')) || null,
    nome: D.configLer(chave(n, 'nome')) || null,
    lojas: D.configLer(chave(n, 'lojas')) || null,
    conectada_em: D.configLer(chave(n, 'conectada_em')) || null,
  });
  const retorno = () => { const base = urlPublica(); return base ? `${new URL(base).origin}/bling/callback` : null; };

  async function pedirToken(n, corpo) {
    const c = config(n);
    const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
    let ultimo = null;
    for (const url of TOKEN) {
      let r;
      try {
        r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000), body: new URLSearchParams(corpo),
          headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: '1.0' } });
      } catch (e) { ultimo = erro(`O Bling não respondeu (${e.message}).`, 502); continue; }
      if (r.status === 404) { ultimo = erro('O Bling não achou o endereço do token.', 502); continue; }
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.access_token) throw erro(`O Bling recusou: ${j?.error?.description || j?.error?.message || j?.error_description || j?.error || `HTTP ${r.status}`}.`, 401);
      return j;
    }
    throw ultimo;
  }

  const acesso = {}, pedindo = {};
  // o refresh do Bling é de uso único: grava o novo antes de qualquer outra coisa
  const guardar = (n, j) => {
    if (j.refresh_token) D.configGravar(chave(n, 'refresh_token'), j.refresh_token);
    acesso[n] = { token: j.access_token, expira: Date.now() + (Number(j.expires_in) || 21600) * 1000 };
    return acesso[n].token;
  };
  async function token(n) {
    if (acesso[n] && Date.now() < acesso[n].expira - 120e3) return acesso[n].token;
    if (!pedindo[n]) {
      const c = config(n);
      if (!c.client_id || !c.client_secret || !c.refresh_token) throw erro(`Conecte a conta ${n} do Bling primeiro.`, 409);
      pedindo[n] = pedirToken(n, { grant_type: 'refresh_token', refresh_token: c.refresh_token })
        .then((j) => guardar(n, j)).finally(() => { pedindo[n] = null; });
    }
    return pedindo[n];
  }

  // Fila por conta: no máximo 3 por segundo (limite do Bling).
  const ultimas = {};
  async function vez(n) {
    const agora = Date.now(), l = (ultimas[n] || []).filter((t) => agora - t < 1000);
    if (l.length >= 3) await new Promise((ok) => setTimeout(ok, 1000 - (agora - l[0]) + 20));
    ultimas[n] = [...l, Date.now()].slice(-3);
  }

  // Uma chamada à API v3 da conta n. Escrita só por quem a chamar com metodo != GET (nesta etapa, ninguém).
  async function bling(n, caminho, { metodo = 'GET', corpo = null } = {}) {
    for (let tentativa = 0; ; tentativa++) {
      await vez(n);
      let r;
      try {
        r = await fetch(API + caminho, { method: metodo, signal: AbortSignal.timeout(30000), body: corpo ? JSON.stringify(corpo) : undefined,
          headers: { Authorization: `Bearer ${await token(n)}`, Accept: 'application/json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) } });
      } catch (e) { if (e.status) throw e; throw erro(`O Bling não respondeu (${e.message}).`, 502); }
      if (r.status === 429 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 1500 * (tentativa + 1))); continue; }
      if (r.status === 401) acesso[n] = null;
      if (r.status === 204) return null;
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const e = j?.error || {};
        const campos = (e.fields || []).map((f) => f.msg || f.element).filter(Boolean).join('; ');
        throw erro(`Bling: ${e.description || e.message || `HTTP ${r.status}`}${campos ? ` (${campos})` : ''}`, r.status >= 500 ? 502 : r.status);
      }
      return j;
    }
  }

  const origemDe = (url) => {
    if (url?.origin === 'https://painel') return new URL(urlPublica()).origin;
    if (url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return url.origin;
    return `http://localhost:${portaPainel()}`;
  };
  const publica = (n) => { const c = config(n); return { conta: n, client_id: c.client_id, tem_segredo: !!c.client_secret, conectada: !!c.refresh_token,
    nome: c.nome, lojas: c.lojas, conectada_em: c.conectada_em }; };

  const rotas = {
    'GET /api/bling/config': async () => ({ retorno: retorno(), contas: CONTAS.map(publica) }),
    // { conta, client_id, client_secret?, nome?, lojas? }
    'PUT /api/bling/config': async (_u, body) => {
      const n = contaValida(body?.conta), c = validarConfig(body);
      D.configGravar(chave(n, 'client_id'), c.client_id);
      D.configGravar(chave(n, 'nome'), c.nome);
      D.configGravar(chave(n, 'lojas'), c.lojas);
      if (c.client_secret) D.configGravar(chave(n, 'client_secret'), c.client_secret);
      if (!D.configLer(chave(n, 'client_secret'))) throw erro('Informe também o Client Secret.');
      acesso[n] = null;
      return publica(n);
    },
    'POST /api/bling/conectar': async (url, body) => {
      const n = contaValida(body?.conta), c = config(n);
      if (!c.client_id || !c.client_secret) throw erro('Salve o Client ID e o Client Secret desta conta primeiro.', 409);
      if (!retorno()) throw erro('O endereço público do painel está fora do ar: o Bling não tem para onde voltar.', 409);
      return { url: urlAutorizacao({ clientId: c.client_id, state: novoEstadoOAuth({ origem: origemDe(url), bling: n }) }) };
    },
    'POST /api/bling/remover': async (_u, body) => {
      const n = contaValida(body?.conta);
      for (const k of ['refresh_token', 'conectada_em']) D.configGravar(chave(n, k), null);
      acesso[n] = null;
      return { removida: true };
    },
    // Diagnóstico (só leitura): pedidos de venda e notas de saída recentes. Mostra a FORMA, as situações e lojas
    // (ids), e dos itens só o que é do produto: descrição, código, NCM e se está ligado a um produto do Bling.
    'GET /api/bling/diagnostico': async (url) => {
      const n = contaValida(url.searchParams.get('conta'));
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const pedidos = await passo(() => bling(n, '/pedidos/vendas?pagina=1&limite=20'));
      const notas = await passo(() => bling(n, '/nfe?pagina=1&limite=20&tipo=1'));
      const listaP = pedidos.data || [], listaN = notas.data || [];
      const detP = [], detN = [];
      for (const p of listaP.slice(0, 5)) { const d = await passo(() => bling(n, `/pedidos/vendas/${p.id}`)); if (d.data) detP.push(d.data); }
      for (const x of listaN.slice(0, 8)) { const d = await passo(() => bling(n, `/nfe/${x.id}`)); if (d.data) detN.push(d.data); }
      const naturezas = await passo(() => bling(n, '/naturezas-operacoes?pagina=1&limite=50'));
      return {
        conta: publica(n),
        pedidos: pedidos.erro ? { erro: pedidos.erro } : { quantidade: listaP.length, situacoes: contar(listaP, (p) => p.situacao?.id), lojas: contar(listaP, (p) => p.loja?.id) },
        notas: notas.erro ? { erro: notas.erro } : { quantidade: listaN.length, situacoes: contar(listaN, (x) => x.situacao), lojas: contar(listaN, (x) => x.loja?.id) },
        // o que interessa para a emissão: o pedido chega sem produto ligado? a nota leva código e NCM?
        itens_pedidos: detP.map((p) => ({ tem_nota: !!(p.notaFiscal?.id), loja: p.loja?.id ?? null, itens: itensDoProduto(p.itens) })),
        itens_notas: detN.map((x) => ({ situacao: x.situacao ?? null, loja: x.loja?.id ?? null, natureza: x.naturezaOperacao?.id ?? null, itens: itensDoProduto(x.itens) })),
        naturezas: naturezas.erro ? { erro: naturezas.erro } : (naturezas.data || []).map((z) => ({ id: z.id, descricao: z.descricao ?? null, situacao: z.situacao ?? null, padrao: z.padrao ?? null })),
        forma: { pedido_lista: listaP[0] ? forma(listaP[0]) : null, pedido: detP[0] ? forma(detP[0]) : null,
          nota_lista: listaN[0] ? forma(listaN[0]) : null, nota: detN[0] ? forma(detN[0]) : null },
      };
    },
  };

  // Retorno da autorização, pelo endereço público. O state de uso único (15 min) diz qual conta e prova que nasceu no painel.
  async function callback(res, url) {
    const st = consumirEstadoOAuth(url.searchParams.get('state') || '');
    const voltar = st?.origem || `http://localhost:${portaPainel()}`;
    const falha = (titulo, detalhe, code = 400) => enviarHtml(res, pagina(titulo, `<h1>${esc(titulo)}</h1>
<pre>${esc(detalhe)}</pre><p><a href="${esc(voltar)}/bling.html">Voltar ao painel</a></p>`, code));
    if (!st?.bling || !CONTAS.includes(st.bling)) return falha('Autorização expirada ou desconhecida', 'Este retorno não corresponde a um "Conectar" feito pelo painel nos últimos 15 minutos.\nVolte ao painel e clique em "Conectar" de novo.');
    if (url.searchParams.get('error')) return falha('O Bling não autorizou', `${url.searchParams.get('error')}: ${url.searchParams.get('error_description') || ''}`);
    const code = url.searchParams.get('code');
    if (!code) return falha('Retorno sem código', 'O Bling não enviou o código de autorização.');
    const n = st.bling;
    try {
      const j = await pedirToken(n, { grant_type: 'authorization_code', code });
      guardar(n, j);
      D.configGravar(chave(n, 'conectada_em'), new Date().toISOString());
      return redirecionar(res, `${voltar}/bling.html?conectado=${n}`);
    } catch (e) { return falha('O Bling não entregou o acesso', e.message, 502); }
  }

  return { rotas, rotasParam: [], callback, bling };
}

module.exports = { criar, validarConfig, urlAutorizacao, itensDoProduto, contaValida, CONTAS };
