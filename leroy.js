'use strict';
// Leroy Merlin (marketplace na plataforma Mirakl): conexão da loja. Primeiro passo da
// integração — endereço do portal, chave de API, teste do acesso e um diagnóstico do que a
// Mirakl devolve (loja, pedidos, documentos contábeis, transações de repasse) antes de o
// painel calcular qualquer coisa. Mesmo caminho da Shopee e da Amazon: vendas e lucro
// são construídos a partir do diagnóstico com a loja real, não da documentação.
//
// Como a Mirakl funciona (documentação da API do vendedor; conferir no diagnóstico):
//   - Endereço = o do portal do lojista (https://<algo>.mirakl.net); a API mora no mesmo host.
//   - Chave de API = de um USUÁRIO da loja (Configurações pessoais → Chave de API), mandada
//     no header Authorization, sem "Bearer". Gerar outra chave invalida a anterior DAQUELE
//     usuário: o painel usa um usuário próprio, para não derrubar outro sistema (ex.: Bling).
//   - Chamadas: A01 /api/account (loja), OR11 /api/orders (pedidos), IV01 /api/invoices
//     (documentos contábeis = repasses), TL02 /api/sellerpayment/transactions_logs (transações).
//   - Escrita: nenhuma por enquanto. Dado pessoal do comprador nunca sai do módulo.
const A = require('./amazon.js');   // forma(), vocabulario(), semPessoais(): os mesmos do diagnóstico da Amazon
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Endereço e chave digitados na tela. Chave ausente = mantém a gravada. Função pura: testada.
function validarConfig(b) {
  const out = {};
  let host = String(b?.host ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(host)) host = `https://${host}`;
  let u;
  try { u = new URL(host); } catch { throw erro('Endereço do portal: copie da barra do navegador, ex.: https://leroymerlin…mirakl.net'); }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.mirakl\.net$/i.test(u.hostname)) throw erro('O endereço do portal da Leroy termina em .mirakl.net (copie da barra do navegador, só até o primeiro "/").');
  out.host = `https://${u.hostname.toLowerCase()}`;
  const k = String(b?.api_key ?? '').trim();
  if (k) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) throw erro('Chave de API: copie a chave inteira (formato 8-4-4-4-12 letras e números).');
    out.api_key = k;
  }
  const loja = String(b?.shop_id ?? '').trim();
  if (loja && !/^\d{1,12}$/.test(loja)) throw erro('ID da loja: só números (aparece no portal, ex.: ID 11338).');
  out.shop_id = loja || null;
  return out;
}

// Campos pessoais do comprador na Mirakl (além dos da Amazon): nunca saem do módulo.
const PESSOAIS = /^(customer|billing_address|shipping_address|customer_notification_email|firstname|lastname|email|phone|phone_secondary|street_1|street_2|zip_code|civility|customer_debited_date)$/i;
function semPessoais(v) {
  if (Array.isArray(v)) return v.map(semPessoais);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!PESSOAIS.test(k)) o[k] = semPessoais(x);
    return A.semPessoais(o);
  }
  return v;
}

function criar({ D }) {
  const config = () => ({ host: D.configLer('leroy_host') || null, api_key: D.configLer('leroy_api_key') || null,
    shop_id: D.configLer('leroy_shop_id') || null });

  async function mk(c, caminho, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    if (c.shop_id && !qs.has('shop_id')) qs.set('shop_id', c.shop_id);
    let r;
    for (let tentativa = 0; ; tentativa++) {
      try {
        r = await fetch(`${c.host}${caminho}${qs.size ? '?' + qs : ''}`, { signal: AbortSignal.timeout(30000),
          headers: { Authorization: c.api_key, Accept: 'application/json' } });
      } catch (e) { throw erro(`A Leroy (Mirakl) não respondeu (${e.message}).`, 502); }
      if (r.status === 429 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 3000 * (tentativa + 1))); continue; }
      break;
    }
    const j = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) throw erro('A Leroy recusou a chave de API. Confira se copiou a chave do usuário do painel inteira.', 401);
    if (!r.ok) throw erro(`Leroy: ${j?.message || `HTTP ${r.status}`}`, r.status >= 500 ? 502 : r.status);
    return semPessoais(j);
  }
  const exigir = () => {
    const c = config();
    if (!c.host || !c.api_key) throw erro('Informe o endereço do portal e a chave de API da Leroy primeiro.', 409);
    return c;
  };

  const rotas = {
    'GET /api/leroy/config': async () => {
      const c = config();
      return { host: c.host, tem_chave: !!c.api_key, shop_id: c.shop_id, conectada_em: D.configLer('leroy_conectada_em'),
        loja: D.configLer('leroy_loja_nome') };
    },

    // Grava só depois de a Mirakl aceitar: chave errada nem chega ao banco.
    'PUT /api/leroy/config': async (_u, body) => {
      const novo = validarConfig(body);
      const atual = config();
      const c = { host: novo.host, api_key: novo.api_key || atual.api_key, shop_id: novo.shop_id };
      if (!c.api_key) throw erro('Informe a chave de API do usuário do painel na Leroy.');
      const conta = await mk(c, '/api/account');
      D.configGravar('leroy_host', c.host);
      D.configGravar('leroy_api_key', c.api_key);
      D.configGravar('leroy_shop_id', c.shop_id || (conta?.shop_id != null ? String(conta.shop_id) : null));
      D.configGravar('leroy_loja_nome', conta?.shop_name || null);
      D.configGravar('leroy_conectada_em', new Date().toISOString());
      return { conectada: true, loja: conta?.shop_name || null, shop_id: conta?.shop_id ?? null };
    },

    'POST /api/leroy/remover': async () => {
      for (const k of ['leroy_host', 'leroy_api_key', 'leroy_shop_id', 'leroy_loja_nome', 'leroy_conectada_em']) D.configGravar(k, null);
      return { removida: true };
    },

    // Diagnóstico: o que a Mirakl devolve para a loja — conta, pedidos dos últimos dias,
    // documentos contábeis (repasses) e transações. Só leitura. Números e a FORMA de cada
    // resposta (campos e tipos; valores só dos campos de vocabulário, como situação e tipo).
    'GET /api/leroy/diagnostico': async (url) => {
      const c = exigir();
      const dias = Math.min(90, Math.max(1, Number(url.searchParams.get('dias')) || 30));
      const desde = new Date(Date.now() - dias * 86400e3).toISOString();
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const conta = await passo(() => mk(c, '/api/account'));
      const pedidos = await passo(() => mk(c, '/api/orders', { start_date: desde, max: 100 }));
      const docs = await passo(() => mk(c, '/api/invoices', { start_date: desde, max: 100 }));
      const trans = await passo(() => mk(c, '/api/sellerpayment/transactions_logs', { date_created_from: desde, limit: 100 }));
      const lista = pedidos.orders || [];
      const contar = (lst, campo) => lst.reduce((m, p) => { const v = p?.[campo] ?? '?'; m[v] = (m[v] || 0) + 1; return m; }, {});
      const tl = trans.data || trans.transactions || [];
      return {
        dias,
        loja: conta.erro ? { erro: conta.erro } : { nome: conta.shop_name || null, id: conta.shop_id ?? null, situacao: conta.shop_state || null },
        pedidos: pedidos.erro ? { erro: pedidos.erro } : { no_periodo: pedidos.total_count ?? lista.length, situacoes: contar(lista, 'order_state') },
        documentos: docs.erro ? { erro: docs.erro } : { quantidade: docs.total_count ?? (docs.invoices || []).length, tipos: contar(docs.invoices || [], 'type') },
        transacoes: trans.erro ? { erro: trans.erro } : { quantidade: tl.length, tipos: contar(tl, 'type'), situacoes: contar(tl, 'payment_state') },
        forma: {
          pedido: pedidos.erro ? null : A.forma(lista[0]),
          documento: docs.erro ? null : A.forma((docs.invoices || [])[0]),
          transacao: trans.erro ? null : A.forma(tl[0]),
          transacoes_resposta: trans.erro ? null : A.forma({ ...trans, data: undefined, transactions: undefined }),
        },
      };
    },
  };
  return { rotas, rotasParam: [], config, mk };
}

module.exports = { criar, validarConfig, semPessoais };
