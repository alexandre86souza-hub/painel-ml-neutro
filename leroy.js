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
//
// Vendas e lucro (medido em 07/10/2026 com a loja real, 93 pedidos e 419 transações): cada linha
// do pedido traz preço (price), frete pago pelo cliente (shipping_price, que a Leroy REPASSA ao
// vendedor), comissão (total_commission + commission_vat; 18% do preço + frete na categoria de
// duchas) e os reembolsos (refunds: amount + shipping_amount, devolvendo commission_total_amount).
// Recebido = preço + frete − comissão − reembolso + comissão devolvida: bate com a soma das
// transações da linha (TL02) em 90 de 90 linhas. A entrega é do vendedor (J&T, Loggi, Jadlog,
// Correios): custo por pedido na tela Empresa da conta Leroy (`entrega_propria`).
// Repasse: a Leroy fecha um ciclo nos dias 10 e 25 (PAYMENT nas transações = AUTO_INVOICE nos
// documentos, summary.amount_transferred) e o vencimento (due_date) é o fechamento + 25 dias; no
// banco o valor chega em 2 créditos. Transação PENDING = pedido ainda não recebido pelo cliente;
// PAYABLE = entra no próximo fechamento.
const A = require('./amazon.js');   // forma(), vocabulario(), semPessoais(): os mesmos do diagnóstico da Amazon
const K = require('./canais.js');
const CC = require('./campanhas-canais.js');
const C = require('./custos.js');
const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
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
// Campos adicionais do pedido com nome, CPF, telefone e endereço (customer-*, shipping-address-*).
const ADICIONAL_PESSOAL = /^(customer|shipping-address|billing-address|billing)/i;
function semPessoais(v) {
  if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === 'object' && typeof x.code === 'string' && ADICIONAL_PESSOAL.test(x.code))).map(semPessoais);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!PESSOAIS.test(k)) o[k] = semPessoais(x);
    return A.semPessoais(o);
  }
  return v;
}

// Situações do pedido/linha que não são venda.
const INVALIDAS = new Set(['CANCELED', 'REFUSED']);

// Foto do produto: a Mirakl dá o caminho (/media/product/image/{uuid}) e a imagem é pública em
// {host}/mmp{caminho} (medido: abre sem chave). Só esse formato é aceito.
const FOTO = /^\/media\/product\/image\/[0-9a-f-]{36}$/i;
const fotoDe = (medias) => {
  const ok = (medias || []).filter((m) => FOTO.test(m?.media_url || ''));
  return (ok.find((m) => m.type === 'SMALL') || ok.find((m) => m.type === 'MEDIUM') || ok[0])?.media_url || null;
};

// Pedido do OR11 -> só o que o lucro e a lista usam: do comprador, SÓ nome e sobrenome (como o
// comprador_nome do ML); CPF, telefone e endereço nunca são gravados. Função pura: testada.
function pedidoDe(o) {
  const cliente = [o.customer?.firstname, o.customer?.lastname].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null;
  return {
    order_id: o.order_id, data: o.created_date || null, status: o.order_state || null, atualizado: o.last_updated_date || null, cliente,
    linhas: (o.order_lines || []).map((l) => {
      const refunds = (l.refunds || []).filter((x) => (x.state || x.refund_state) !== 'REFUSED');
      return {
        id: l.order_line_id, sku: (l.offer_sku || l.product_shop_sku || '').trim() || null, titulo: l.product_title || null,
        categoria: l.category_label || null, quantidade: n(l.quantity), estado: l.order_line_state || null, foto: fotoDe(l.product_medias),
        promocoes: (l.promotions || []).filter((x) => x && x.id != null).map((x) => ({ id: String(x.id),
          nome: x.configuration?.internal_description || x.description || x.internal_description || null, tipo: x.type || null,
          valor: r2(Math.abs(n(x.deduced_amount ?? x.apportioned_deduced_amount ?? x.total_deduced_amount))) })),
        preco: n(l.price), frete_cliente: n(l.shipping_price), comissao: r2(n(l.total_commission) + n(l.commission_vat)),
        reembolso: r2(refunds.reduce((s, x) => s + n(x.amount), 0)), reembolso_frete: r2(refunds.reduce((s, x) => s + n(x.shipping_amount), 0)),
        comissao_devolvida: r2(refunds.reduce((s, x) => s + n(x.commission_total_amount ?? x.commission_amount), 0)),
      };
    }),
  };
}

// Linhas de venda (formato de canais.js). Tarifa = comissão líquida + o que foi reembolsado ao
// cliente; frete = o que o vendedor pagou pela entrega do PEDIDO (digitado na tela Pedidos, ctx.fretes:
// Map pedido -> valor, contratado no Melhor Envio; sem ele, o custo médio da tela Empresa, marcado
// como estimado) rateado pelo preço − frete que o cliente pagou (a Leroy repassa). Assim
// faturamento − tarifa − frete = recebido − entrega. Reembolso total da linha = produto volta
// (custo 0). ctx.estados: Map linha -> situação das transações ('PAID' = já no repasse). Pura: testada.
function linhasDe(pedidos, ctx) {
  const out = [];
  for (const p of pedidos) {
    const validaPedido = !INVALIDAS.has(p.status);
    const fatPedido = p.linhas.reduce((s, l) => s + (INVALIDAS.has(l.estado) ? 0 : n(l.preco)), 0);
    const informado = ctx.fretes?.has(p.order_id) || false;
    const custoEntrega = informado ? n(ctx.fretes.get(p.order_id)) : ctx.entrega_propria ?? null;
    for (const l of p.linhas) {
      const valida = validaPedido && !INVALIDAS.has(l.estado);
      const q = n(l.quantidade), fat = n(l.preco);
      const parte = valida && fatPedido > 0 ? fat / fatPedido : 0;
      const devolvido = valida && fat > 0 && n(l.reembolso) >= fat - 0.01;
      const tarifa = valida ? n(l.comissao) - n(l.comissao_devolvida) + n(l.reembolso) + n(l.reembolso_frete) : 0;
      const frete = !valida ? 0 : custoEntrega == null ? null : custoEntrega * parte - n(l.frete_cliente);
      const cs = l.sku ? C.custoDoSku(C.skuNaData(ctx.trocas, l.sku, p.data), ctx.mapa) : { custo: null, componentes: [], faltando: [] };
      const produto = !valida || devolvido ? 0 : cs.custo == null ? null : cs.custo * q;
      const embalagem = valida ? (ctx.embalagem_pedido || 0) * parte : 0;   // uma caixa por pedido, rateada pelo valor
      const imposto = valida ? (ctx.imposto_pct || 0) / 100 * fat : 0;
      const falta = [];
      if (produto == null) falta.push('custo');
      if (valida && custoEntrega == null) falta.push('entrega');
      const lucro = !valida ? 0 : falta.length ? null : fat - tarifa - frete - produto - embalagem - imposto;
      const x = (v) => (v == null ? null : r2(v));
      const estadoRepasse = ctx.estados?.get(l.id) || null;
      out.push({ pedido: p.order_id, data: p.data, status: valida ? p.status : 'CANCELED', valida, sku: l.sku, item_id: l.sku || l.id,
        titulo: cs.componentes.map((c) => c.nome).filter(Boolean).join(' + ') || l.titulo || l.sku,
        foto: ctx.host && l.foto && FOTO.test(l.foto) ? `${ctx.host}/mmp${l.foto}` : null, comprador_nome: p.cliente || null,
        promocoes: l.promocoes || [],
        quantidade: q, preco_unit: q ? x(fat / q) : null, full: false, canal: 'leroy',
        componentes: cs.componentes.map((c) => ({ sku: c.sku || String(c.numero), custo: c.custo })), faltando: cs.faltando,
        custo_unit: cs.custo, embalagem_pedido: ctx.embalagem_pedido || 0,
        faturamento: x(fat), tarifa: x(tarifa), frete: x(frete), produto: x(produto), embalagem: x(embalagem), imposto: x(imposto),
        lucro: x(lucro), margem: lucro != null && fat > 0 && valida ? lucro / fat : null, falta: valida ? falta : [], estimado: false,
        devolvido, comissao: valida ? x(n(l.comissao) - n(l.comissao_devolvida)) : 0, reembolso: valida ? x(n(l.reembolso) + n(l.reembolso_frete)) : 0,
        frete_cliente: valida ? x(l.frete_cliente) : 0, custo_entrega: custoEntrega == null || !valida ? null : x(custoEntrega * parte),
        frete_pedido: informado ? x(custoEntrega) : null, frete_informado: informado, frete_estimado: valida && !informado && custoEntrega != null,
        recebido: valida ? x(fat + n(l.frete_cliente) - tarifa) : 0, recebido_final: estadoRepasse === 'PAID', repasse: estadoRepasse,
        link: ctx.host ? `${ctx.host}/mmp/shop/order/${encodeURIComponent(p.order_id)}` : null });
    }
  }
  return out;
}

// Oferta do OF21 -> o que a tela de campanhas usa. Preço cheio = o de origem (com desconto ativo
// o price continua o cheio; medido: 833 de 972 ofertas com discount, todas de um só preço).
// complexo = preço por canal ou por quantidade: o PRI01 apagaria esses preços, então o painel não
// mexe (o vendedor muda no portal). Função pura: testada.
function ofertaDe(o) {
  const ap = o.all_prices || [];
  const complexo = ap.length > 1 || ap.some((p) => p.channel_code || (p.volume_prices || []).length > 1) || (o.discount?.ranges || []).length > 1;
  const d = o.discount && o.discount.discount_price != null ? { preco: n(o.discount.discount_price), inicio: o.discount.start_date || null, fim: o.discount.end_date || null } : null;
  return { sku: o.shop_sku, oferta: o.offer_id ?? null, titulo: o.product_title || o.shop_sku, ativa: !!o.active, estoque: o.quantity ?? null,
    cheio: n(o.discount?.origin_price ?? ap[0]?.unit_origin_price ?? o.price), desconto: d, complexo };
}

// Transação do TL02 -> linha da tabela. Função pura: testada.
const transacaoDe = (t) => ({ id: t.id, data: t.date_created || null, tipo: t.type || null, estado: t.payment_state || null,
  valor: n(t.amount), pedido: t.entities?.order?.id || null, linha: t.entities?.order_line?.id || null, ciclo: t.seller_billing_cycle_id || null });
// Documento AUTO_INVOICE do IV01 -> ciclo de pagamento. Função pura: testada.
function cicloDe(d) {
  const s = d.summary || {};
  return { id: d.seller_billing_cycle_id || d.id, inicio: d.start_time || null, fim: d.end_time || d.issue_date || null, previsto: d.due_date || null,
    valor: n(s.amount_transferred), vendas: n(s.total_payable_orders_incl_tax),
    comissao: r2(n(s.total_commissions_incl_tax) + n(s.total_refund_commissions_incl_tax)),
    reembolsos: n(s.total_refund_orders_incl_tax), assinatura: n(s.total_subscription_incl_tax), estado: d.payment?.state || null };
}
// Situação de cada linha de pedido nas transações: PAID só quando todas as dela estão pagas.
function estadosDasLinhas(transacoes) {
  const m = new Map();
  for (const t of transacoes) {
    if (!t.linha) continue;
    const atual = m.get(t.linha);
    if (atual && atual !== 'PAID') continue;
    m.set(t.linha, t.estado === 'PAID' ? 'PAID' : t.estado);
  }
  return m;
}

// Próximo fechamento do ciclo (dias 10 e 25, 00h de Brasília). Função pura: testada.
function proximoFechamento(agora = Date.now()) {
  const d = new Date(agora - 3 * 3600e3);
  const a = d.getUTCFullYear(), dia = d.getUTCDate();
  let m = d.getUTCMonth(), alvo;
  if (dia < 10) alvo = 10; else if (dia < 25) alvo = 25; else { alvo = 10; m++; }
  return new Date(Date.UTC(a, m, alvo, 3)).toISOString();
}
const DIAS_ATE_VENCER = 25;   // medido em 9 ciclos (mai–set/2026): due_date = fim do ciclo + 25 dias

// Repasses: ciclos fechados (o que a Leroy transferiu e quando vence) e a previsão do que está em
// aberto — PAYABLE entra no próximo fechamento; PENDING espera o cliente receber. Pura: testada.
function repassesDe(transacoes, ciclos, agora = Date.now()) {
  const abertas = transacoes.filter((t) => t.estado !== 'PAID' && t.tipo !== 'PAYMENT');
  const soma = (ls) => r2(ls.reduce((s, t) => s + n(t.valor), 0));
  const pagavel = abertas.filter((t) => t.estado === 'PAYABLE'), pendente = abertas.filter((t) => t.estado === 'PENDING');
  const fechamento = proximoFechamento(agora);
  const pedidos = (ls) => new Set(ls.map((t) => t.pedido).filter(Boolean)).size;
  return {
    proximo: { fechamento, previsto: new Date(Date.parse(fechamento) + DIAS_ATE_VENCER * 864e5).toISOString(), valor: soma(pagavel), pedidos: pedidos(pagavel),
      cobrancas: soma(pagavel.filter((t) => !t.pedido)) },
    aguardando_entrega: { valor: soma(pendente), pedidos: pedidos(pendente) },
    ciclos: ciclos.map((c) => ({ ...c, outros: r2(n(c.valor) - n(c.vendas) - n(c.comissao) - n(c.reembolsos) - n(c.assinatura)),
      vencido: !!c.previsto && Date.parse(c.previsto) <= agora })),
  };
}

function criar({ D, janela }) {
  const config = () => ({ host: D.configLer('leroy_host') || null, api_key: D.configLer('leroy_api_key') || null,
    shop_id: D.configLer('leroy_shop_id') || null });

  // pessoais: só a leitura dos pedidos para a cópia (pedidoDe guarda apenas o nome); o resto sai sem.
  async function mk(c, caminho, params = {}, { pessoais = false } = {}) {
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
    return pessoais ? j : semPessoais(j);
  }
  // Envio de arquivo (PRI01). Sem repetição automática: importação repetida = preço mandado 2x.
  async function mkArquivo(c, caminho, nomeArquivo, conteudo) {
    const form = new FormData();
    form.append('file', new Blob([conteudo], { type: 'text/csv' }), nomeArquivo);
    const qs = c.shop_id ? `?shop_id=${encodeURIComponent(c.shop_id)}` : '';
    let r;
    try {
      r = await fetch(`${c.host}${caminho}${qs}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000),
        headers: { Authorization: c.api_key, Accept: 'application/json' } });
    } catch (e) { throw erro(`A Leroy (Mirakl) não respondeu (${e.message}).`, 502); }
    const j = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 403) throw erro('A Leroy recusou a chave de API para mudar preços.', 401);
    if (r.status === 429) throw erro('A Leroy aceita uma mudança de preços por minuto. Espere um pouco e tente de novo.', 429);
    if (!r.ok) throw erro(`Leroy: ${j?.message || `HTTP ${r.status}`}`, r.status >= 500 ? 502 : r.status);
    return j;
  }
  const exigir = () => {
    const c = config();
    if (!c.host || !c.api_key) throw erro('Informe o endereço do portal e a chave de API da Leroy primeiro.', 409);
    return c;
  };

  // Cópia local: pedidos (1ª leitura 152 dias; depois pelos atualizados), transações (desde a mais
  // antiga ainda não paga, no mínimo 40 dias) e ciclos. No máximo a cada 10 min.
  let lendo = null;
  function sincronizar(forcar = false) {
    const ultima = D.configLer('leroy_lido_em');
    if (!forcar && ultima && Date.now() - Date.parse(ultima) < 10 * 60e3) return Promise.resolve();
    if (lendo) return lendo;
    lendo = (async () => {
      const c = exigir();
      const inicio = new Date();
      const desde = (dias) => new Date(Date.now() - dias * 864e5).toISOString();
      const filtro = ultima ? { start_update_date: new Date(Date.parse(ultima) - 864e5).toISOString() } : { start_date: desde(152) };
      for (let off = 0; off < 20000; off += 100) {
        const r = await mk(c, '/api/orders', { ...filtro, max: 100, offset: off }, { pessoais: true });
        D.leroyPedidosGravar((r.orders || []).map(pedidoDe));
        if ((r.orders || []).length < 100) break;
      }
      const aberta = D.leroyMaisAntigaAberta();
      const de = ultima ? [aberta, desde(40)].filter(Boolean).sort()[0] : desde(160);
      let token = null;
      for (let pag = 0; pag < 500; pag++) {
        const r = await mk(c, '/api/sellerpayment/transactions_logs', { date_created_from: de, limit: 100, ...(token ? { page_token: token } : {}) });
        D.leroyTransacoesGravar((r.data || []).map(transacaoDe));
        token = r.next_page_token;
        if (!token) break;
      }
      for (let off = 0; off < 2000; off += 100) {
        const r = await mk(c, '/api/invoices', { start_date: ultima ? desde(60) : desde(160), max: 100, offset: off });
        D.leroyCiclosGravar((r.invoices || []).filter((d) => d.type === 'AUTO_INVOICE').map(cicloDe));
        if ((r.invoices || []).length < 100) break;
      }
      D.configGravar('leroy_lido_em', inicio.toISOString());
    })().finally(() => { lendo = null; });
    return lendo;
  }

  function empresa() {
    const propria = D.configLer('empresa:leroy');
    const reserva = D.contasListar()[0]?.ml_user_id;
    return C.lerEmpresa(propria || (reserva ? D.configLer(`empresa:${reserva}`) : null));
  }
  async function linhas(de, ate, opcoes = {}) {
    let erroLeitura = null;
    try { await sincronizar(opcoes.recarregar); } catch (e) { erroLeitura = e.message; }
    const e = empresa();
    const impostoPct = C.impostoTotal(e);
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const estados = estadosDasLinhas(D.leroyTransacoes(new Date(Date.parse(de) - 5 * 864e5).toISOString()));
    const ls = linhasDe(D.leroyPedidosPeriodo(de, ate), { mapa, trocas: D.skuTrocas('leroy'), imposto_pct: impostoPct, embalagem_pedido: e.embalagem_padrao || 0,
      entrega_propria: e.entrega_propria, fretes: D.leroyFretes(), estados, host: config().host });
    const semFrete = new Set(ls.filter((l) => l.valida && !l.frete_informado).map((l) => l.pedido)).size;
    return { linhas: ls, impostoPct, erroLeitura, semFrete, semEntrega: e.entrega_propria == null };
  }
  const diasDe = (url, ok, padrao = 30) => { const d = Number(url.searchParams.get('dias')); return ok.includes(d) ? d : padrao; };

  // Ofertas da loja (OF21, 100 por página), guardadas 10 min.
  let cacheOfertas = null;
  async function ofertas(recarregar = false) {
    if (!recarregar && cacheOfertas && Date.now() - cacheOfertas.em < 10 * 60e3) return cacheOfertas.lista;
    const c = exigir();
    const lista = [];
    for (let off = 0; off < 50000; off += 100) {
      const r = await mk(c, '/api/offers', { max: 100, offset: off });
      lista.push(...(r.offers || []).map(ofertaDe));
      if ((r.offers || []).length < 100) break;
    }
    cacheOfertas = { em: Date.now(), lista };
    return lista;
  }
  // PRI01: no máximo 1 por minuto (limite da Mirakl).
  async function importarPrecos(linhas) {
    const ultima = D.configLer('leroy_pri01_em');
    if (ultima && Date.now() - Date.parse(ultima) < 61e3) throw erro('A Leroy aceita uma mudança de preços por minuto. Espere um pouco e tente de novo.', 429);
    const c = exigir();
    D.configGravar('leroy_pri01_em', new Date().toISOString());
    const r = await mkArquivo(c, '/api/offers/pricing/imports', 'precos.csv', CC.csvPrecosMirakl(linhas));
    cacheOfertas = null;
    const id = r?.import_id ?? r?.importId ?? null;
    if (id != null) D.configGravar('leroy_pri01_ultima', String(id));
    return { import_id: id, ofertas: linhas.length };
  }
  async function ofertasEditaveis(skus) {
    const mapa = new Map((await ofertas(true)).map((o) => [o.sku, o]));
    for (const s of skus) {
      const o = mapa.get(s);
      if (!o) throw erro(`Oferta ${s} não encontrada na Leroy.`, 404);
      if (o.complexo) throw erro(`${s} tem preço por canal ou por quantidade: mude no portal da Leroy (o painel apagaria esses preços).`, 409);
    }
    return mapa;
  }

  const rotas = {
    // Pedidos / Vendas Hoje: o mesmo formato de custos.js#vendasDaConta.
    'GET /api/leroy/pedidos': async (url) => {
      const dias = diasDe(url, [1, 7, 15, 30, 60, 90]);
      const j = K.janelaVendas(dias, janela);
      const r = await linhas(j.de, j.ate, { recarregar: url.searchParams.get('recarregar') === '1' });
      return { dias, de: j.de, ate: j.ate, imposto_pct: r.impostoPct, erro_leitura: r.erroLeitura, sem_entrega: r.semEntrega, fretes_a_informar: r.semFrete,
        resumo: K.somaLinhas(r.linhas), sem_custo: K.semCusto(r.linhas), vendas: r.linhas };
    },
    'GET /api/leroy/performance': async (url) => {
      const dias = diasDe(url, [7, 15, 30, 60, 75]);
      const atual = K.intervalo(dias);
      const antes = K.intervalo(dias, Date.parse(atual.de) - 1 + 3 * 3600e3);
      const r = await linhas(antes.de, atual.ate);
      return K.performanceDe(r.linhas, dias, atual.de);
    },
    'GET /api/leroy/performance/logistica': async (url) => {
      const dias = diasDe(url, [7, 15, 30, 60, 75]);
      const j = K.intervalo(dias);
      const r = await linhas(j.de, j.ate);
      const s = K.somaLinhas(r.linhas);
      return { dias, de: j.de, ate: j.ate, envios_pendentes: 0, total: { pedidos: s.pedidos, faturamento: s.faturamento },
        canais: [{ canal: 'envios', nome: 'Entrega própria', pedidos: s.pedidos, unidades: s.unidades, faturamento: s.faturamento,
          ticket: s.pedidos ? r2(s.faturamento / s.pedidos) : null, participacao: s.faturamento > 0 ? 1 : 0 }] };
    },
    'GET /api/leroy/abc': async (url) => {
      const dias = diasDe(url, [15, 30, 60, 90, 150]);
      const j = janela(dias);
      const r = await linhas(j.de, j.ate);
      return K.abcDe(r.linhas, { dias, de: j.primeiro, ate: j.ultimo });
    },
    // "Todas as contas": hoje, período, por dia e produtos (somados no navegador, como a Shopee).
    'GET /api/leroy/vendas': async (url) => {
      const j = K.periodoDoPedido(url, [7, 15, 30, 60, 90], janela);
      const { dias } = j;
      const hojeDe = K.janelaVendas(1, janela).de;
      const r = await linhas(j.de, j.ate);
      const rh = j.ate <= hojeDe ? await linhas(hojeDe, new Date(Date.now() + 60e3).toISOString()) : null;
      return { nome: D.configLer('leroy_loja_nome') || 'Leroy Merlin', erro_leitura: r.erroLeitura,
        ...K.resumoGeral(r.linhas, { dias, de: j.de, ate: j.ate, hojeDe, conta: 'leroy', topPorSku: C.topPorSku, mes: j.mes, rotulo: j.rotulo, linhasHoje: rh?.linhas }) };
    },
    // Campanhas: descontos das ofertas (com o resultado) e as promoções que aparecem nas vendas.
    'GET /api/leroy/campanhas': async (url) => {
      const lista = await ofertas(url.searchParams.get('recarregar') === '1');
      const agora = Date.now();
      const r = await linhas(new Date(agora - 152 * 864e5).toISOString(), new Date(agora + 60e3).toISOString());
      const fotos = new Map(r.linhas.filter((l) => l.foto && l.sku).map((l) => [l.sku, l.foto]));
      const vendas90 = new Map();
      for (const l of r.linhas) if (l.valida && l.sku && l.data >= new Date(agora - 90 * 864e5).toISOString()) vendas90.set(l.sku, (vendas90.get(l.sku) || 0) + n(l.quantidade));
      let promocoesLoja = null;
      try {
        const p = await mk(exigir(), '/api/promotions', { max: 100 });
        promocoesLoja = (p.promotions || []).map((x) => ({ id: x.internal_id ?? x.id ?? null, nome: x.internal_description || x.public_descriptions?.[0]?.value || null,
          tipo: x.type || null, situacao: x.state || null, inicio: x.start_date || null, fim: x.end_date || null }));
      } catch { /* sem a lista: a tela mostra só o que veio nas vendas */ }
      return {
        canal: 'leroy', imposto_pct: r.impostoPct, erro_leitura: r.erroLeitura,
        anuncios: lista.map((o) => {
          const sit = o.desconto ? CC.situacao(o.desconto.inicio, o.desconto.fim, agora) : null;
          return { ...o, foto: fotos.get(o.sku) || null, vendas_90: vendas90.get(o.sku) || 0, situacao: sit,
            resultado: o.desconto && sit !== 'agendado' ? CC.resultadoDesconto(r.linhas, o.sku, o.desconto.inicio, o.desconto.fim, agora) : null };
        }),
        promocoes: CC.resultadoPromocoes(r.linhas), promocoes_loja: promocoesLoja,
        ultima_importacao: D.configLer('leroy_pri01_ultima'),
      };
    },
    // Cria (ou troca) o desconto: preço promocional com início e fim. Só pela tela, com confirmação.
    'POST /api/leroy/campanhas/desconto': async (_u, body) => {
      const skus = (Array.isArray(body?.itens) ? body.itens : []).map((i) => String(i?.sku ?? '').trim());
      const mapa = await ofertasEditaveis(skus);
      const v = CC.validarDesconto(body, new Map([...mapa].map(([k, o]) => [k, o.cheio])));
      return importarPrecos(v.itens.map((i) => ({ ...i, inicio: v.inicio, fim: v.fim })));
    },
    // Encerra o desconto (manda só o preço cheio).
    'POST /api/leroy/campanhas/encerrar': async (_u, body) => {
      const skus = [...new Set((Array.isArray(body?.skus) ? body.skus : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
      if (!skus.length || skus.length > 200) throw erro('Escolha de 1 a 200 ofertas.');
      const mapa = await ofertasEditaveis(skus);
      return importarPrecos(skus.map((s) => ({ sku: s, cheio: mapa.get(s).cheio, preco: null })));
    },
    // Situação da importação de preços (PRI02) e, com erro, o relatório (PRI03).
    'GET /api/leroy/campanhas/importacao': async (url) => {
      const id = String(url.searchParams.get('id') || D.configLer('leroy_pri01_ultima') || '').trim();
      if (!/^\d{1,15}$/.test(id)) throw erro('Importação não informada.');
      const c = exigir();
      const r = await mk(c, '/api/offers/pricing/imports', { import_id: id });
      const imp = (r.data || r.imports || [])[0];
      if (!imp) return { import_id: id, situacao: 'WAITING' };
      let erros = null;
      if (imp.has_error_report) {
        try {
          const qs = c.shop_id ? `?shop_id=${encodeURIComponent(c.shop_id)}` : '';
          const e = await fetch(`${c.host}/api/offers/pricing/imports/${id}/error_report${qs}`, { headers: { Authorization: c.api_key }, signal: AbortSignal.timeout(30000) });
          erros = (await e.text()).split(/\r?\n/).filter(Boolean).slice(0, 21).join('\n');
        } catch { /* sem relatório */ }
      }
      if (imp.status === 'COMPLETE') cacheOfertas = null;
      return { import_id: id, situacao: imp.status, ok: imp.offers_updated ?? imp.lines_in_success ?? null,
        com_erro: imp.offers_in_error ?? imp.lines_in_error ?? null, motivo: imp.reason_status || null, erros };
    },

    // Repasses: ciclos fechados e a previsão do que está em aberto.
    'GET /api/leroy/repasses': async () => {
      exigir();
      let erroLeitura = null;
      try { await sincronizar(); } catch (e) { erroLeitura = e.message; }
      return { erro_leitura: erroLeitura, ...repassesDe(D.leroyTransacoes(new Date(Date.now() - 200 * 864e5).toISOString()), D.leroyCiclos()) };
    },

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

    // Frete pago pelo pedido (Melhor Envio), digitado na tela Pedidos. Vazio = apaga (volta ao médio).
    'POST /api/leroy/frete': async (_u, body) => {
      const pedido = String(body?.pedido ?? '').trim();
      if (!pedido || !D.leroyPedidoExiste(pedido)) throw erro('Pedido da Leroy não encontrado.', 404);
      const bruto = body?.valor;
      let valor = null;
      if (bruto != null && String(bruto).trim() !== '') {
        valor = Number(String(bruto).replace(',', '.'));
        if (!Number.isFinite(valor) || valor < 0 || valor > 10000) throw erro('Frete: informe um valor entre R$ 0 e R$ 10.000.');
        valor = r2(valor);
      }
      D.leroyFreteGravar(pedido, valor);
      return { pedido, valor };
    },

    'POST /api/leroy/remover': async () => {
      for (const k of ['leroy_host', 'leroy_api_key', 'leroy_shop_id', 'leroy_loja_nome', 'leroy_conectada_em', 'leroy_lido_em']) D.configGravar(k, null);
      D.leroyApagarTudo();
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
  return { rotas, rotasParam: [], config, mk, sincronizar, ofertas };
}

module.exports = { criar, validarConfig, semPessoais, pedidoDe, ofertaDe, linhasDe, transacaoDe, cicloDe, estadosDasLinhas, proximoFechamento, repassesDe };
