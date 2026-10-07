'use strict';
// Magalu (Magazine Luiza): conexão da loja. Primeiro passo da integração — credenciais do
// aplicativo, autorização da loja e um diagnóstico do que a API devolve (pedidos, análise
// financeira e promoções) antes de o painel calcular qualquer coisa. Mesmo caminho da Shopee,
// da Amazon e da Leroy: vendas, lucro e repasses são construídos a partir do diagnóstico com
// a loja real, não da documentação.
//
// Como funciona (developers.magalu.com, conferido em 07/10/2026):
//   - Aplicativo criado pelo vendedor no IDM (ID Magalu CLI, `idm client create`): Client ID e
//     Client Secret digitados na tela (o segredo fica cifrado). Escopos pedidos na criação
//     (--scopes-default) e o retorno FIXO no próprio computador: http://localhost:{porta}/magalu/callback
//     (a Magalu aceita localhost — o próprio IDM volta em localhost:8095). Assim a troca do túnel
//     não quebra a autorização.
//   - Autorização: https://id.magalu.com/login?client_id&redirect_uri&scope&response_type=code
//     &choose_tenants=true (escolhe a LOJA, pessoa jurídica) &state. Código vale 10 min, uso único.
//   - Tokens: POST https://id.magalu.com/oauth/token (JSON na troca do código; formulário na
//     renovação). Access token de até 2 h; o refresh pode vir novo a cada renovação: grava sempre.
//   - Chamadas: https://api.magalu.com/seller/v1/... com Authorization: Bearer.
//     Pedidos /orders, análise financeira /financial-analysis/orders (janela de 15 dias, valores
//     inteiros ÷ normalizer), promoções disponíveis /promotions.
// Nada da Magalu no MCP (test-magalu.js reprova); dado do comprador nunca sai do módulo.
//
// Vendas e lucro (medido em 07/10/2026 com a loja real, 79 pedidos e 65 análises financeiras):
//   - Pedido: amounts.total = venda − desconto + frete pago pelo cliente; amounts.commission =
//     comissão + tarifa fixa + intermediação (MDR) — bate com a soma do financeiro.
//   - Análise financeira: SALE (crédito, preço cheio), DISCOUNT/PRODUCT, COMMISSION SERVICE e
//     TECHNOLOGY, FEES PLATFORM (tarifa fixa) e PAYMENT_PROCESSING (MDR), SHIPPING_COST/FREIGHT
//     (frete cobrado; o cliente pagou o mesmo), SHIPPING_SHARE (coparticipação no frete da Magalu
//     Entregas), PROMOTION (par débito do vendedor / crédito "Reembolso" da Magalu), REFUND.
//     Recebido = créditos − débitos, SEM os débitos de ABSOLUTE_DISCOUNT ("preço promocional": já
//     está no preço — regra da documentação) e sem as linhas not_applicable/INFORMATIVE.
//   - O financeiro não diz em qual depósito o pedido foi pago (depósitos semanais, às segundas).
const A = require('./amazon.js');   // forma(), semPessoais()
const K = require('./canais.js');
const C = require('./custos.js');
const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
const dinheiro = (a) => (a == null ? 0 : n(a.total ?? a.value ?? a.amount) / (n(a.normalizer) || 100));
const ID = 'https://id.magalu.com';
const API = 'https://api.magalu.com';
const ESCOPOS = ['open:order-order-seller:read', 'open:order-financial-report-seller:read', 'open:order-invoice-seller:read',
  'open:order-delivery-seller:read', 'open:portfolio-skus-seller:read', 'open:portfolio-prices-seller:read',
  'open:portfolio-prices-seller:write', 'open:portfolio-stocks-seller:read', 'open:promotion-promotions-seller:read',
  'open:promotion-promotions-seller:write', 'open:promotion-skus-seller:read', 'open:promotion-skus-seller:write',
  'open:promotion-subscriptions-seller:read', 'open:promotion-subscriptions-seller:write', 'open:promotion-subscriptions-seller:delete',
  'open:tickets-seller:read', 'open:ticket-returns-seller:read', 'services:questions-seller:read', 'services:conversations-seller:read'];
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Credenciais digitadas na tela. Segredo vazio = mantém o gravado. Função pura: testada.
function validarConfig(b) {
  const id = String(b?.client_id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) throw erro('Client ID: copie o "Client ID" que o IDM mostrou ao criar o aplicativo (letras, números, _ e -).');
  const out = { client_id: id };
  const seg = String(b?.client_secret ?? '').trim();
  if (seg) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(seg)) throw erro('Client Secret: copie o "Client Secret" inteiro que o IDM mostrou.');
    out.client_secret = seg;
  }
  return out;
}

// Endereço de autorização (tela de login e consentimento do ID Magalu). Função pura: testada.
function urlAutorizacao({ clientId, redirect, state }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, scope: ESCOPOS.join(' '),
    response_type: 'code', choose_tenants: 'true', state });
  return `${ID}/login?${q}`;
}

// Campos com dado do comprador (nome, documento, contato, endereço): nunca saem do módulo.
const PESSOAIS = /^(customer|buyer|recipient|receiver|shipping_address|billing_address|address|addresses|document|documents|cpf|cnpj|email|phone|phones|telephone|name_on_card|first_name|last_name|full_name|zipcode|zip_code|street|number|complement|neighborhood|reference)$/i;
function semPessoais(v) {
  if (Array.isArray(v)) return v.map(semPessoais);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!PESSOAIS.test(k)) o[k] = semPessoais(x);
    return A.semPessoais(o);
  }
  return v;
}

// Pedido da API -> só o que o lucro usa (nada do comprador). Função pura: testada.
function pedidoDe(p) {
  const itens = [];
  for (const d of p.deliveries || []) {
    for (const i of d.items || []) {
      const q = n(i.quantity);
      const total = dinheiro(i.amounts), frete = dinheiro(i.amounts?.freight);
      itens.push({ sku: String(i.info?.sku ?? '').trim() || null, titulo: i.info?.description || null, quantidade: q,
        unit: dinheiro(i.unit_price), faturamento: r2(total - frete), frete_cliente: r2(frete), desconto: dinheiro(i.amounts?.discount),
        comissao: dinheiro(i.amounts?.commission), foto: i.info?.images?.[0]?.url || null });
    }
  }
  const d0 = (p.deliveries || [])[0];
  return { code: String(p.code), data: p.purchased_at || p.created_at || null, status: p.status || null, atualizado: p.updated_at || null,
    entregue: d0?.shipping?.delivered_at || null, frete_cliente: dinheiro(p.amounts?.freight), comissao: dinheiro(p.amounts?.commission), itens };
}
// Transações da análise financeira -> forma enxuta (sem identificadores de pagamento). Pura: testada.
const transacoesDe = (f) => (f.transactions || []).filter((t) => t.type === 'CREDIT' || t.type === 'DEBIT').map((t) => ({
  tipo: t.type, cat: t.category || null, sub: t.subcategory || null, valor: r2(n(t.value) / (n(t.normalizer) || 100)),
  status: t.status || null, desc: String(t.description || '').slice(0, 120), sku: t.entity?.extras?.sku != null ? String(t.entity.extras.sku) : null,
  data: t.transaction_at || null }));
const conta = (t) => t.status !== 'not_applicable' && !(t.tipo === 'DEBIT' && t.sub === 'ABSOLUTE_DISCOUNT');
const sinal = (t) => (t.tipo === 'CREDIT' ? 1 : -1) * t.valor;
const ehFrete = (t) => t.cat === 'SHIPPING_COST' || t.cat === 'SHIPPING_SHARE';
// O que o pedido rende pelo financeiro: recebido, custo do frete e promoções (desconto do vendedor
// e o que a Magalu reembolsou). Função pura: testada.
function financeiroDo(ts) {
  const v = ts.filter(conta);
  const recebido = r2(v.reduce((a, t) => a + sinal(t), 0));
  const freteCusto = r2(-v.filter(ehFrete).reduce((a, t) => a + sinal(t), 0));
  const promos = new Map();
  // promoções: o débito do preço promocional entra aqui (é o desconto dado), mas não no recebido
  for (const t of ts.filter((t) => t.cat === 'PROMOTION' && t.status !== 'not_applicable')) {
    const nome = t.desc.replace(/^(Reembolso ref\.:\s*|Estorno ref\.:\s*)+/i, '').trim() || t.sub;
    const x = promos.get(nome) || { id: nome, nome, tipo: t.sub, magalu: 0, vendedor: 0 };
    if (t.tipo === 'CREDIT') x.magalu += t.valor; else x.vendedor += t.valor;
    promos.set(nome, x);
  }
  return { recebido, freteCusto, promocoes: [...promos.values()].map((p) => ({ ...p, magalu: r2(p.magalu), vendedor: r2(p.vendedor) })) };
}

const INVALIDAS = new Set(['cancelled', 'canceled']);
// Linhas de venda (formato de canais.js). Com o financeiro: recebido exato; tarifa = faturamento −
// frete pago − recebido (comissões, tarifa fixa, MDR, parte do vendedor nas promoções); frete = o
// frete debitado (o que o cliente pagou de frete fica com a Magalu: medido, a SALE não o inclui). Sem ele: a comissão do pedido (estimado).
// Rateio pelo faturamento dos itens. Embalagem: uma por pedido. Função pura: testada.
function linhasDe(pedidos, ctx) {
  const out = [];
  for (const p of pedidos) {
    const valida = !INVALIDAS.has(String(p.status).toLowerCase());
    const ts = ctx.financeiro?.get(p.code);
    const fin = ts ? financeiroDo(ts) : null;
    const fatPedido = p.itens.reduce((a, i) => a + n(i.faturamento), 0);
    let tarifaPedido, fretePedido;
    if (fin) { tarifaPedido = fatPedido - fin.freteCusto - fin.recebido; fretePedido = fin.freteCusto; }
    else { tarifaPedido = n(p.comissao); fretePedido = 0; }
    for (const i of p.itens) {
      const q = n(i.quantidade), fat = n(i.faturamento);
      const parte = fatPedido > 0 ? fat / fatPedido : 1 / p.itens.length;
      const tarifa = valida ? tarifaPedido * parte : 0;
      const frete = valida ? fretePedido * parte : 0;
      const skuPainel = (i.sku && ctx.vinculos?.get(i.sku)) || i.sku;   // SKU digitado pelo vendedor (anúncio com outro código)
      const cs = skuPainel ? C.custoDoSku(skuPainel, ctx.mapa) : { custo: null, componentes: [], faltando: [] };
      const produto = !valida ? 0 : cs.custo == null ? null : cs.custo * q;
      const embalagem = valida ? (ctx.embalagem_pedido || 0) * parte : 0;
      const imposto = valida ? (ctx.imposto_pct || 0) / 100 * fat : 0;
      const falta = produto == null ? ['custo'] : [];
      const lucro = !valida ? 0 : falta.length ? null : fat - tarifa - frete - produto - embalagem - imposto;
      const x = (v) => (v == null ? null : r2(v));
      out.push({ pedido: p.code, data: p.data, status: p.status, valida, sku: skuPainel, sku_magalu: i.sku, item_id: skuPainel || p.code,
        titulo: cs.componentes.map((c) => c.nome).filter(Boolean).join(' + ') || i.titulo || i.sku, foto: i.foto,
        quantidade: q, preco_unit: q ? x(fat / q) : null, full: false, canal: 'magalu',
        componentes: cs.componentes.map((c) => ({ sku: c.sku || String(c.numero), custo: c.custo })), faltando: cs.faltando,
        custo_unit: cs.custo, embalagem_pedido: ctx.embalagem_pedido || 0,
        faturamento: x(fat), tarifa: x(tarifa), frete: x(frete), produto: x(produto), embalagem: x(embalagem), imposto: x(imposto),
        lucro: x(lucro), margem: lucro != null && fat > 0 && valida ? lucro / fat : null, falta: valida ? falta : [], estimado: valida && !fin,
        recebido: valida && fin ? x(fin.recebido * parte) : null, entregue: p.entregue,
        promocoes: fin ? fin.promocoes.map((pr) => ({ id: pr.id, nome: pr.nome, tipo: pr.tipo, valor: r2((pr.vendedor + pr.magalu) * parte), magalu: r2(pr.magalu * parte) })) : [],
        link: `https://sellercenter.magalu.com/pedidos/${encodeURIComponent(p.code)}` });
    }
  }
  return out;
}

function criar({ D, janela, novoEstadoOAuth, consumirEstadoOAuth, portaPainel, enviarHtml, redirecionar, pagina, esc }) {
  const config = () => ({ client_id: D.configLer('magalu_client_id') || null, client_secret: D.configLer('magalu_client_secret') || null,
    refresh: D.configLer('magalu_refresh_token') || null });
  // retorno no próprio computador: o mesmo host que abriu o painel (localhost ou 127.0.0.1)
  const retornoDe = (url) => {
    const host = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? url.hostname : 'localhost';
    return `http://${host}:${portaPainel()}/magalu/callback`;
  };

  async function token(corpo, comoJson) {
    let r;
    try {
      r = await fetch(`${ID}/oauth/token`, { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': comoJson ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: comoJson ? JSON.stringify(corpo) : new URLSearchParams(corpo).toString() });
    } catch (e) { throw erro(`O ID Magalu não respondeu (${e.message}).`, 502); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) throw erro(`ID Magalu: ${j?.error_description || j?.error || j?.message || `HTTP ${r.status}`}`, r.status === 400 || r.status === 401 ? 401 : 502);
    return j;
  }
  let acesso = null;   // { token, expira }
  async function tokenAcesso(forcar = false) {
    if (!forcar && acesso && acesso.expira - Date.now() > 60e3) return acesso.token;
    const c = config();
    if (!c.client_id || !c.client_secret || !c.refresh) throw erro('Conecte a loja da Magalu primeiro.', 409);
    const t = await token({ grant_type: 'refresh_token', client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh }, false);
    if (t.refresh_token) D.configGravar('magalu_refresh_token', t.refresh_token);
    acesso = { token: t.access_token, expira: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    return acesso.token;
  }

  // GET na API do vendedor. 401 = renova o token uma vez; 429 = espera e tenta de novo.
  async function mg(caminho, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    let r, renovou = false;
    for (let tentativa = 0; ; tentativa++) {
      const tk = await tokenAcesso(renovou);
      try {
        r = await fetch(`${API}${caminho}${qs.size ? '?' + qs : ''}`, { signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${tk}`, Accept: 'application/json' } });
      } catch (e) { throw erro(`A Magalu não respondeu (${e.message}).`, 502); }
      if (r.status === 401 && !renovou) { renovou = true; continue; }
      if (r.status === 429 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 3000 * (tentativa + 1))); continue; }
      break;
    }
    const j = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) throw erro(`A Magalu recusou o acesso (${r.status}${j?.message ? ': ' + j.message : ''}). Confira se a loja autorizou todas as permissões.`, 401);
    if (!r.ok) throw erro(`Magalu: ${j?.message || j?.detail?.[0]?.msg || j?.error || `HTTP ${r.status}`}`, r.status >= 500 ? 502 : r.status);
    return semPessoais(j);
  }

  // Cópia local: pedidos e análise financeira (1ª leitura 152 dias, em janelas de 15 dias pela data
  // da compra; depois pelos atualizados desde a última leitura − 1 dia). No máximo a cada 10 min.
  let lendo = null;
  function sincronizar(forcar = false) {
    const ultima = D.configLer('magalu_lido_em');
    if (!forcar && ultima && Date.now() - Date.parse(ultima) < 10 * 60e3) return Promise.resolve();
    if (lendo) return lendo;
    lendo = (async () => {
      const inicio = new Date();
      const campo = ultima ? 'updated_at' : 'purchased_at';
      const desde = ultima ? Date.parse(ultima) - 864e5 : Date.now() - 152 * 864e5;
      for (let t = desde; t < Date.now(); t += 15 * 864e5) {
        const filtro = { [`${campo}__gte`]: new Date(t).toISOString(), [`${campo}__lte`]: new Date(Math.min(t + 15 * 864e5 - 1000, Date.now())).toISOString() };
        for (let off = 0; off < 5000; off += 50) {
          const r = await mg('/seller/v1/orders', { ...filtro, _limit: 50, _offset: off });
          D.magaluPedidosGravar((r.results || []).map(pedidoDe).filter((p) => p.code && p.data));
          if ((r.results || []).length < 50) break;
        }
        for (let off = 0; off < 5000; off += 50) {
          const r = await mg('/seller/v1/financial-analysis/orders', { ...filtro, _limit: 50, _offset: off });
          D.magaluFinanceiroGravar((r.results || []).filter((f) => f.extras?.order_code).map((f) => ({ code: String(f.extras.order_code), atualizado: f.updated_at || null, transacoes: transacoesDe(f) })));
          if ((r.results || []).length < 50) break;
        }
      }
      D.configGravar('magalu_lido_em', inicio.toISOString());
    })().finally(() => { lendo = null; });
    return lendo;
  }
  function empresa() {
    const propria = D.configLer('empresa:magalu');
    const reserva = D.contasListar()[0]?.ml_user_id;
    return C.lerEmpresa(propria || (reserva ? D.configLer(`empresa:${reserva}`) : null));
  }
  async function linhas(de, ate, opcoes = {}) {
    let erroLeitura = null;
    try { await sincronizar(opcoes.recarregar); } catch (e) { erroLeitura = e.message; }
    const e = empresa();
    const impostoPct = C.impostoTotal(e);
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const peds = D.magaluPedidosPeriodo(de, ate);
    const ls = linhasDe(peds, { mapa, imposto_pct: impostoPct, embalagem_pedido: e.embalagem_padrao || 0, financeiro: D.magaluFinanceiroDe(peds.map((p) => p.code)),
      vinculos: D.skuVinculos('magalu') });
    return { linhas: ls, impostoPct, erroLeitura };
  }
  const diasDe = (url, ok, padrao = 30) => { const d = Number(url.searchParams.get('dias')); return ok.includes(d) ? d : padrao; };

  // Anúncios: lista de SKUs (100 por página) e, um SKU por chamada, preço e estoque — em segundo
  // plano, 3 por vez, publicados primeiro; relidos a cada 6 h. A tela pede de novo enquanto `lendo`.
  let lendoAnuncios = null, progresso = null;
  function lerAnuncios(forcar = false) {
    if (lendoAnuncios) return lendoAnuncios;
    const lidoEm = D.configLer('magalu_anuncios_lido_em');
    const listar = forcar || !lidoEm || Date.now() - Date.parse(lidoEm) > 6 * 3600e3;
    lendoAnuncios = (async () => {
      if (listar) {
        const visto = new Date().toISOString();
        let total = 0;
        for (let off = 0; off < 20000; off += 100) {
          const r = await mg('/seller/v1/portfolios/skus', { _limit: 100, _offset: off });
          const l = r.results || [];
          D.magaluAnunciosGravar(l.filter((x) => x.sku).map((x) => ({ sku: String(x.sku), titulo: x.title || null, status: x.status || null,
            ativo: !!x.active, url: (x.url_marketplace || []).find((u) => u.url)?.url || null })), visto);
          total += l.length;
          if (l.length < 100) break;
        }
        if (total) D.magaluAnunciosLimparAntes(visto);
        D.configGravar('magalu_anuncios_lido_em', visto);
      }
      for (let lote = D.magaluSemPreco(30), voltas = 0; lote.length && voltas < 200; lote = D.magaluSemPreco(30), voltas++) {
        progresso = { faltam: D.magaluSemPreco(100000).length };
        await Promise.all(lote.map(async (sku) => {
          let preco = null, lista = null, estoque = null;
          try {
            const p = (await mg(`/seller/v1/portfolios/prices/${encodeURIComponent(sku)}`)).results?.[0];
            if (p) { preco = n(p.price) / (n(p.normalizer) || 100); lista = n(p.list_price) / (n(p.normalizer) || 100); }
          } catch { /* sem preço */ }
          try {
            const e = (await mg(`/seller/v1/portfolios/stocks/${encodeURIComponent(sku)}`)).results || [];
            estoque = e.filter((x) => !x.type || x.type === 'AVAILABLE').reduce((a, x) => a + n(x.quantity), 0);
          } catch { /* sem estoque */ }
          D.magaluPrecoGravar(sku, preco, lista, estoque);
        }));
      }
      progresso = null;
    })().finally(() => { lendoAnuncios = null; });
    return lendoAnuncios;
  }

  const rotas = {
    // Anúncios da Magalu (tela magalu-anuncios.html): SKU, preço, estoque, situação, vendas de 30 dias,
    // custo (pelo SKU ou pelo SKU do painel digitado) e a taxa média do SKU no financeiro.
    'GET /api/magalu/anuncios': async (url) => {
      lerAnuncios(url.searchParams.get('recarregar') === '1').catch(() => null);
      const e = empresa();
      const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
      const vinc = D.skuVinculos('magalu');
      const r = await linhas(new Date(Date.now() - 90 * 864e5).toISOString(), new Date(Date.now() + 60e3).toISOString());
      const porSku = new Map(); let fatT = 0, tarT = 0;
      const desde30 = new Date(Date.now() - 30 * 864e5).toISOString();
      for (const l of r.linhas) {
        if (!l.valida || !l.sku_magalu) continue;
        const x = porSku.get(l.sku_magalu) || { fat: 0, tar: 0, v30: 0, foto: null, final: 0 };
        if (!l.estimado) { x.fat += l.faturamento; x.tar += n(l.tarifa) + n(l.frete); fatT += l.faturamento; tarT += n(l.tarifa) + n(l.frete); }
        if (l.data >= desde30) x.v30 += l.quantidade;
        x.foto = x.foto || l.foto;
        porSku.set(l.sku_magalu, x);
      }
      const media = fatT > 0 ? tarT / fatT : null;
      const itens = D.magaluAnuncios().map((a) => {
        const skuPainel = vinc.get(a.sku) || null;
        const cs = C.custoDoSku(skuPainel || a.sku, mapa);
        const x = porSku.get(a.sku);
        return { sku: a.sku, sku_painel: skuPainel, titulo: a.titulo, status: a.status, ativo: !!a.ativo, preco: a.preco, preco_lista: a.preco_lista,
          estoque: a.estoque, preco_lido: !!a.lido_preco, custo_unit: cs.custo, componentes: cs.componentes.map((c) => ({ sku: c.sku || String(c.numero), nome: c.nome, custo: c.custo })),
          faltando: cs.faltando, vendas_30: x?.v30 || 0, taxa_pct: x && x.fat > 0 ? x.tar / x.fat : media, taxa_do_produto: !!(x && x.fat > 0),
          foto: x?.foto || null, link: a.url };
      }).sort((a, b) => (b.vendas_30 - a.vendas_30) || (a.status === 'PUBLISHED' ? -1 : 1) - (b.status === 'PUBLISHED' ? -1 : 1) || String(a.titulo).localeCompare(String(b.titulo)));
      return { itens, imposto_pct: C.impostoTotal(e), embalagem_pedido: e.embalagem_padrao || 0, lendo: !!lendoAnuncios, faltam: progresso?.faltam ?? null,
        lido_em: D.configLer('magalu_anuncios_lido_em') };
    },
    // SKU do painel para um anúncio da Magalu que usa outro código. Vazio = apaga o vínculo.
    'PUT /api/magalu/sku-vinculo': async (_u, body) => {
      const sku = String(body?.sku ?? '').trim();
      if (!sku || sku.length > 80) throw erro('Informe o SKU da Magalu.');
      const painel = String(body?.sku_painel ?? '').trim();
      if (painel.length > 120) throw erro('SKU do painel muito longo.');
      if (painel) {
        const cs = C.custoDoSku(painel, new Map(D.catalogoListar().map((p) => [p.numero, p])));
        if (!cs.componentes.length) throw erro(`O SKU "${painel}" não tem números de produto (ex.: KIT-630 ou KIT-795.615.748.698).`);
        D.skuVinculoGravar('magalu', sku, painel);
        return { sku, sku_painel: painel, custo_unit: cs.custo, faltando: cs.faltando };
      }
      D.skuVinculoGravar('magalu', sku, null);
      return { sku, sku_painel: null };
    },

    'GET /api/magalu/pedidos': async (url) => {
      const dias = diasDe(url, [1, 7, 15, 30, 60, 90]);
      const j = K.janelaVendas(dias, janela);
      const r = await linhas(j.de, j.ate, { recarregar: url.searchParams.get('recarregar') === '1' });
      return { dias, de: j.de, ate: j.ate, imposto_pct: r.impostoPct, erro_leitura: r.erroLeitura,
        estimadas: r.linhas.filter((l) => l.valida && l.estimado).length, resumo: K.somaLinhas(r.linhas), sem_custo: K.semCusto(r.linhas), vendas: r.linhas };
    },
    'GET /api/magalu/performance': async (url) => {
      const dias = diasDe(url, [7, 15, 30, 60, 75]);
      const atual = K.intervalo(dias);
      const antes = K.intervalo(dias, Date.parse(atual.de) - 1 + 3 * 3600e3);
      const r = await linhas(antes.de, atual.ate);
      return K.performanceDe(r.linhas, dias, atual.de);
    },
    'GET /api/magalu/performance/logistica': async (url) => {
      const dias = diasDe(url, [7, 15, 30, 60, 75]);
      const j = K.intervalo(dias);
      const r = await linhas(j.de, j.ate);
      const s = K.somaLinhas(r.linhas);
      return { dias, de: j.de, ate: j.ate, envios_pendentes: 0, total: { pedidos: s.pedidos, faturamento: s.faturamento },
        canais: [{ canal: 'envios', nome: 'Magalu Entregas', pedidos: s.pedidos, unidades: s.unidades, faturamento: s.faturamento,
          ticket: s.pedidos ? r2(s.faturamento / s.pedidos) : null, participacao: s.faturamento > 0 ? 1 : 0 }] };
    },
    'GET /api/magalu/abc': async (url) => {
      const dias = diasDe(url, [15, 30, 60, 90, 150]);
      const j = janela(dias);
      const r = await linhas(j.de, j.ate);
      return K.abcDe(r.linhas, { dias, de: j.primeiro, ate: j.ultimo });
    },
    'GET /api/magalu/vendas': async (url) => {
      const dias = diasDe(url, [7, 15, 30, 60, 90]);
      const j = K.janelaVendas(dias, janela);
      const r = await linhas(j.de, j.ate);
      return { nome: D.configLer('magalu_loja_nome') || 'Magalu', erro_leitura: r.erroLeitura,
        ...K.resumoGeral(r.linhas, { dias, de: j.de, ate: j.ate, hojeDe: K.janelaVendas(1, janela).de, conta: 'magalu', topPorSku: C.topPorSku }) };
    },
    // Campanhas (tela campanhas-canais.html?conta=magalu): promoções disponíveis para entrar e o
    // resultado das promoções que apareceram nas vendas (pelo financeiro). Só leitura por enquanto.
    'GET /api/magalu/campanhas': async () => {
      const agora = Date.now();
      const r = await linhas(new Date(agora - 152 * 864e5).toISOString(), new Date(agora + 60e3).toISOString());
      let disponiveis = null;
      try {
        const p = await mg('/seller/v1/promotions', { _limit: 50 });
        disponiveis = (p.results || []).map((x) => ({ id: x.id ?? null, nome: x.name || x.title || x.description || null, tipo: x.type || null,
          situacao: x.status || null, inicio: x.start_at || x.starts_at || x.start_date || null, fim: x.end_at || x.ends_at || x.end_date || null }));
      } catch { /* a tela mostra só o resultado */ }
      return { canal: 'magalu', imposto_pct: r.impostoPct, erro_leitura: r.erroLeitura, anuncios: [],
        promocoes: require('./campanhas-canais.js').resultadoPromocoes(r.linhas), promocoes_loja: disponiveis };
    },

    'GET /api/magalu/config': async (url) => {
      const c = config();
      return { client_id: c.client_id, tem_segredo: !!c.client_secret, conectada_em: D.configLer('magalu_conectada_em'),
        loja: D.configLer('magalu_loja_nome'), retorno: retornoDe(url), escopos: ESCOPOS,
        escopos_faltando: (D.configLer('magalu_escopos_faltando') || '').split(' ').filter(Boolean) };
    },
    'PUT /api/magalu/config': async (_u, body) => {
      const novo = validarConfig(body);
      const atual = config();
      if (!novo.client_secret && !atual.client_secret) throw erro('Informe o Client Secret.');
      if (atual.client_id && atual.client_id !== novo.client_id) {   // outro aplicativo: a autorização antiga não vale
        for (const k of ['magalu_refresh_token', 'magalu_conectada_em', 'magalu_loja_nome']) D.configGravar(k, null);
        acesso = null;
      }
      D.configGravar('magalu_client_id', novo.client_id);
      if (novo.client_secret) D.configGravar('magalu_client_secret', novo.client_secret);
      return { ok: true };
    },
    // Só pelo próprio computador: o retorno da Magalu é em localhost.
    'POST /api/magalu/conectar': async (url) => {
      if (url?.origin === 'https://painel') throw erro('Conecte a Magalu pelo computador onde o painel está instalado (o retorno da autorização é em localhost).', 409);
      const c = config();
      if (!c.client_id || !c.client_secret) throw erro('Salve o Client ID e o Client Secret primeiro.', 409);
      const redirect = retornoDe(url);
      return { url: urlAutorizacao({ clientId: c.client_id, redirect, state: novoEstadoOAuth({ magalu: true, redirect }) }) };
    },
    'POST /api/magalu/remover': async () => {
      for (const k of ['magalu_refresh_token', 'magalu_conectada_em', 'magalu_loja_nome', 'magalu_lido_em']) D.configGravar(k, null);
      D.magaluApagarTudo();
      acesso = null;
      return { removida: true };
    },
    // Diagnóstico: o que a Magalu devolve — pedidos, análise financeira e promoções disponíveis.
    // Só leitura. Números e a FORMA de cada resposta (campos e tipos), sem dado de comprador.
    'GET /api/magalu/diagnostico': async (url) => {
      const dias = Math.min(15, Math.max(1, Number(url.searchParams.get('dias')) || 15));
      const ate = new Date(), de = new Date(Date.now() - dias * 864e5);
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const pedidos = await passo(() => mg('/seller/v1/orders', { _limit: 50, _offset: 0, purchased_at__gte: de.toISOString(), purchased_at__lte: ate.toISOString() }));
      const fin = await passo(() => mg('/seller/v1/financial-analysis/orders', { purchased_at__gte: de.toISOString(), purchased_at__lte: ate.toISOString(), _limit: 50 }));
      const promos = await passo(() => mg('/seller/v1/promotions', { _limit: 50 }));
      const lista = (r) => r?.results || r?.data || r?.items || (Array.isArray(r) ? r : []);
      const contar = (lst, campo) => lst.reduce((m, p) => { const v = p?.[campo] ?? '?'; m[v] = (m[v] || 0) + 1; return m; }, {});
      const lp = lista(pedidos), lf = lista(fin), lpr = lista(promos);
      return {
        dias,
        pedidos: pedidos.erro ? { erro: pedidos.erro } : { quantidade: pedidos.meta?.page?.count ?? pedidos.meta?.total ?? lp.length, situacoes: contar(lp, 'status') },
        financeiro: fin.erro ? { erro: fin.erro } : { quantidade: fin.meta?.page?.count ?? fin.meta?.total ?? lf.length },
        promocoes: promos.erro ? { erro: promos.erro } : { quantidade: promos.meta?.page?.count ?? promos.meta?.total ?? lpr.length, situacoes: contar(lpr, 'status') },
        forma: {
          pedidos_resposta: pedidos.erro ? null : A.forma({ ...pedidos, results: undefined, data: undefined, items: undefined }),
          pedido: pedidos.erro ? null : A.forma(lp[0]),
          financeiro: fin.erro ? null : A.forma(lf[0]),
          promocao: promos.erro ? null : A.forma(lpr[0]),
        },
      };
    },
  };

  // Retorno da autorização (localhost, com a sessão do painel): troca o código pelos tokens.
  async function callback(res, url) {
    const st = consumirEstadoOAuth(url.searchParams.get('state') || '');
    const falha = (titulo, detalhe, code = 400) => enviarHtml(res, pagina(titulo, `<h1>${esc(titulo)}</h1>
<pre>${esc(detalhe)}</pre><p><a href="/magalu.html">Voltar ao painel</a></p>`, code));
    if (!st?.magalu) return falha('Autorização expirada ou desconhecida', 'Este retorno não corresponde a um "Conectar" feito pelo painel nos últimos 15 minutos.\nVolte ao painel e clique em "Conectar loja da Magalu" de novo.');
    if (url.searchParams.get('error')) return falha('A Magalu não autorizou', `${url.searchParams.get('error')}: ${url.searchParams.get('error_description') || ''}`);
    const code = url.searchParams.get('code');
    if (!code) return falha('Retorno sem código', 'A Magalu não enviou o código de autorização.');
    try {
      const c = config();
      const t = await token({ grant_type: 'authorization_code', client_id: c.client_id, client_secret: c.client_secret, redirect_uri: st.redirect, code }, true);
      if (!t.refresh_token) return falha('A Magalu não entregou o acesso', 'Veio o token de acesso, mas não o de renovação. Tente conectar de novo.', 502);
      D.configGravar('magalu_refresh_token', t.refresh_token);
      D.configGravar('magalu_conectada_em', new Date().toISOString());
      acesso = { token: t.access_token, expira: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
      const faltam = ESCOPOS.filter((s) => !String(t.scope || '').split(/\s+/).includes(s));
      D.configGravar('magalu_escopos_faltando', faltam.length && t.scope ? faltam.join(' ') : null);
      return redirecionar(res, '/magalu.html?conectado=1');
    } catch (e) { return falha('A Magalu não entregou o acesso', e.message, 502); }
  }

  return { rotas, rotasParam: [], callback, mg, config, sincronizar };
}

module.exports = { criar, validarConfig, urlAutorizacao, semPessoais, ESCOPOS, pedidoDe, transacoesDe, financeiroDo, linhasDe };
