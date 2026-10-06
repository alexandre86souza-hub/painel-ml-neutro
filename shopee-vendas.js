'use strict';
// Vendas e lucro da Shopee (uma loja por vez: ?loja={shop_id}). Medido em 02/10/2026 com a loja
// real (diagnóstico): get_order_list só traz o número (e a situação com
// response_optional_fields=order_status); get_order_detail traz item_list (item_sku/model_sku,
// model_quantity_purchased, model_discounted_price = preço unitário pago) e create_time;
// get_escrow_detail traz order_income.escrow_amount = o que o vendedor recebe, já sem comissão,
// taxas, frete e cupons — por isso o lucro da Shopee é exato, não estimado.
//
// Telas: Pedidos/Vendas Hoje, Performance e ABC com ?conta=shopee-{shop_id} chamam
// /api/shopee/pedidos|performance|abc (mesmo formato das rotas do ML, montado em canais.js).
const K = require('./canais.js');
const C = require('./custos.js');
const r2 = (v) => Math.round(v * 100) / 100;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const INVALIDAS = new Set(['CANCELLED', 'IN_CANCEL', 'UNPAID']);
const n = (v) => Number(v) || 0;

// Pedido do get_order_detail -> data, situação e itens. Função pura: testada.
function detalheDe(o) {
  return {
    pedido: { order_sn: o.order_sn, data: o.create_time ? new Date(o.create_time * 1000).toISOString() : null,
      status: o.order_status || null, atualizado: o.update_time || null, transportadora: o.shipping_carrier || null },
    itens: (o.item_list || []).map((i) => ({ sku: (i.model_sku || i.item_sku || '').trim() || null, item_id: i.item_id ?? null,
      model_id: i.model_id ?? null, nome: [i.item_name, i.model_name].filter(Boolean).join(' — ') || null,
      quantidade: n(i.model_quantity_purchased), preco_unit: i.model_discounted_price ?? i.model_original_price ?? null,
      imagem: i.image_info?.image_url || null })),
  };
}

// Repasse (get_escrow_detail) -> o que interessa ao lucro. Função pura: testada.
function repasseDe(e, status) {
  const oi = e?.order_income || {};
  return {
    final: status === 'COMPLETED',
    recebido: oi.escrow_amount ?? null,
    comissao: n(oi.commission_fee), servico: n(oi.service_fee),
    transacao: n(oi.seller_transaction_fee) + n(oi.credit_card_transaction_fee),
    // frete que ficou com o vendedor: o cobrado menos o que o comprador pagou e o subsídio da Shopee
    frete_vendedor: Math.max(0, n(oi.actual_shipping_fee) - n(oi.buyer_paid_shipping_fee) - n(oi.shopee_shipping_rebate)),
    cupom_vendedor: n(oi.voucher_from_seller), devolucao: n(oi.seller_return_refund),
    // frete que a Shopee REPASSA ao vendedor dentro do escrow_amount (medido em 100 pedidos de
    // 02/10/2026: repasse = preço − cupom − comissão − serviço − transação − proteção de envio +
    // final_shipping_fee + buyer_paid_shipping_fee). "Entrega Direta": a Shopee paga o frete ao
    // vendedor, que paga a empresa de entrega; Shopee Xpress: a soma dá ~0.
    frete_shopee: n(oi.final_shipping_fee) + n(oi.buyer_paid_shipping_fee),
  };
}

// Taxa fixa por unidade vendida (dentro da taxa de serviço). Medido em 562 pedidos de mai–set/2026:
// taxa de serviço = transação × preço + taxa fixa por unidade, pela faixa do preço da unidade:
// R$ 4,00 até R$ 79,99 (R$ 4,50 desde 01/10), R$ 16 de 80 a 99,99, R$ 20 de 100 a 199,99, R$ 26
// de 200 em diante. A transação era 2% e é 1,4% desde 01/10/2026 (data da compra, horário de
// Brasília). A net_service_fee_info_list NÃO serve: em metade dos pedidos ela põe parte da taxa
// fixa na regra de porcentagem (ex.: R$ 16,57 + 3,43 em vez de 20). Função pura: testada.
const TRANSACAO = [['2026-10-01', 0.014], ['', 0.02]];   // [a partir do dia (Brasília), %], mais nova primeiro
function taxaFixaDe(servico, faturamento, data) {
  if (servico == null || !(faturamento > 0) || !data) return null;
  const dia = new Date(Date.parse(data) - 3 * 3600e3).toISOString().slice(0, 10);
  const pct = TRANSACAO.find(([desde]) => dia >= desde)[1];
  return Math.max(0, r2(n(servico) - pct * faturamento));
}

// Pedido entregue pelo próprio vendedor (ele paga a empresa de entrega: custo na tela Empresa).
const entregaPropria = (transportadora) => /entrega direta/i.test(transportadora || '');

// Frete médio que a Shopee repassou por pedido, por transportadora (repasses finais): estima o
// frete dos pedidos ainda sem repasse. Função pura: testada.
function freteMedioDe(rows) {
  const soma = new Map();
  const vistos = new Set();
  for (const r of rows) {
    if (vistos.has(r.order_sn) || !r.escrow_final || r.frete_shopee == null || INVALIDAS.has(r.status)) continue;
    vistos.add(r.order_sn);
    const k = r.transportadora || '';
    const s = soma.get(k) || { v: 0, n: 0 };
    s.v += n(r.frete_shopee); s.n++; soma.set(k, s);
  }
  return Object.fromEntries([...soma].map(([k, s]) => [k, s.v / s.n]));
}

// Linhas de venda de uma janela, no formato de canais.js. Com repasse: o que a Shopee tirou do
// pedido (faturamento − recebido) + o frete que ela repassou = tarifa; frete = custo da entrega
// própria (Entrega Direta) − frete repassado pela Shopee. Lucro = recebido − entrega − custos
// (exato). Sem repasse ainda: a proporção média da loja e o frete médio da transportadora
// (marcado como estimado). Função pura: testada.
function linhasDe(rows, ctx) {
  const porPedido = new Map();
  for (const r of rows) { const a = porPedido.get(r.order_sn) || []; a.push(r); porPedido.set(r.order_sn, a); }
  const out = [];
  for (const [sn, itens] of porPedido) {
    const p = itens[0];
    const valida = !INVALIDAS.has(p.status);
    const fatPedido = itens.reduce((s, i) => s + n(i.preco_unit) * n(i.quantidade), 0);
    const temRepasse = p.recebido != null;
    const propria = entregaPropria(p.transportadora);
    const custoEntrega = propria ? (ctx.entrega_propria ?? null) : 0;
    const devolvido = temRepasse && n(p.recebido) <= 0 && n(p.devolucao) > 0;
    let tarifaPedido = null, freteShopee = null, estimado = false;
    if (temRepasse) { freteShopee = p.frete_shopee != null ? n(p.frete_shopee) : 0; tarifaPedido = fatPedido - n(p.recebido) + freteShopee; }
    else if (ctx.proporcao != null) { tarifaPedido = fatPedido * ctx.proporcao; freteShopee = n(ctx.frete_medio?.[p.transportadora || '']); estimado = true; }
    // pedido devolvido: a entrega aconteceu (custo continua), o repasse diz o resto
    const fretePedido = freteShopee == null || custoEntrega == null ? null : custoEntrega - freteShopee;
    const taxaFixa = temRepasse && valida ? taxaFixaDe(p.servico, fatPedido, p.data) : null;
    for (const i of itens) {
      const q = n(i.quantidade);
      const fat = n(i.preco_unit) * q;
      const parte = fatPedido > 0 ? fat / fatPedido : 0;
      const tarifa = tarifaPedido == null ? null : tarifaPedido * parte;
      const frete = !valida ? 0 : fretePedido == null ? null : fretePedido * parte;
      const cs = i.sku ? C.custoDoSku(i.sku, ctx.mapa) : { custo: null, componentes: [], faltando: [] };
      const produto = !valida || devolvido ? 0 : cs.custo == null ? null : cs.custo * q;
      const embalagem = valida ? (ctx.embalagem_pedido || 0) * parte : 0;   // uma caixa por pedido, rateada pelo valor
      const imposto = valida ? (ctx.imposto_pct || 0) / 100 * fat : 0;
      const falta = [];
      if (produto == null) falta.push('custo');
      if (tarifa == null) falta.push('tarifa');
      if (valida && custoEntrega == null) falta.push('entrega');
      const lucro = !valida ? 0 : falta.length ? null : fat - tarifa - frete - produto - embalagem - imposto;
      const x = (v) => (v == null ? null : r2(v));
      out.push({ pedido: sn, data: p.data, status: p.status, valida, sku: i.sku, item_id: i.sku || String(i.item_id || sn),
        titulo: cs.componentes.map((c) => c.nome).filter(Boolean).join(' + ') || i.nome || i.sku, foto: i.imagem || null,
        quantidade: q, preco_unit: x(i.preco_unit), full: false, canal: 'shopee',
        componentes: cs.componentes.map((c) => ({ sku: c.sku || String(c.numero), custo: c.custo })), faltando: cs.faltando,
        custo_unit: cs.custo, embalagem_pedido: ctx.embalagem_pedido || 0,
        faturamento: x(fat), tarifa: x(tarifa), frete: x(frete), produto: x(produto), embalagem: x(embalagem), imposto: x(imposto),
        lucro: x(lucro), margem: lucro != null && fat > 0 && valida ? lucro / fat : null, falta: valida ? falta : [], estimado,
        devolvido, recebido_final: !!p.escrow_final, transportadora: p.transportadora || null, entrega_propria: propria,
        frete_shopee: freteShopee == null ? null : x(freteShopee * parte), custo_entrega: custoEntrega == null ? null : x(custoEntrega * parte),
        taxa_fixa: taxaFixa == null ? null : x(taxaFixa * parte),
        link: `https://seller.shopee.com.br/portal/sale/order?search=${encodeURIComponent(sn)}` });
    }
  }
  return out;
}

// Proporção média que a Shopee tira do faturamento (pedidos com repasse final). Função pura: testada.
function proporcaoDe(rows) {
  let fat = 0, tirado = 0;
  const vistos = new Set();
  const porPedido = new Map();
  for (const r of rows) { const a = porPedido.get(r.order_sn) || []; a.push(r); porPedido.set(r.order_sn, a); }
  for (const [sn, itens] of porPedido) {
    const p = itens[0];
    if (!p.escrow_final || p.recebido == null || vistos.has(sn) || INVALIDAS.has(p.status)) continue;
    vistos.add(sn);
    const f = itens.reduce((s, i) => s + n(i.preco_unit) * n(i.quantidade), 0);
    if (f <= 0 || n(p.devolucao) > 0) continue;
    fat += f; tirado += f - n(p.recebido) + n(p.frete_shopee);   // só a tarifa: o frete repassado não conta
  }
  return fat > 0 ? tirado / fat : null;
}

function criar({ D, daLoja, janela }) {
  const agoraS = () => Math.floor(Date.now() / 1000);
  const exigeLoja = (url) => {
    const id = Number(url.searchParams.get('loja'));
    if (!Number.isInteger(id) || !D.shopeeLojaObter(id)) throw erro('Escolha uma loja da Shopee conectada.', 404);
    return id;
  };

  // Lista (janelas de 15 dias, limite da Shopee), detalhe (50 por chamada) e repasse.
  const lendo = new Map();
  function sincronizar(shopId, forcar = false) {
    const chave = `shopee_lido_em:${shopId}`;
    const ultima = D.configLer(chave);
    if (!forcar && ultima && Date.now() - Date.parse(ultima) < 10 * 60e3) return Promise.resolve();
    if (lendo.has(shopId)) return lendo.get(shopId);
    const p = (async () => {
      const inicio = new Date();
      const campo = ultima ? 'update_time' : 'create_time';
      let de = ultima ? Math.floor(Date.parse(ultima) / 1000) - 86400 : agoraS() - 152 * 86400;
      const fim = agoraS();
      while (de < fim) {
        const ate = Math.min(fim, de + 15 * 86400 - 60);
        let cursor = '';
        for (let pag = 0; pag < 100; pag++) {
          const r = await daLoja(shopId, '/api/v2/order/get_order_list', { time_range_field: campo, time_from: de, time_to: ate,
            page_size: 100, cursor, response_optional_fields: 'order_status' });
          D.shopeePedidosGravar(shopId, (r.response?.order_list || []).map((o) => ({ order_sn: o.order_sn, status: o.order_status })));
          if (!r.response?.more) break;
          cursor = r.response.next_cursor;
        }
        de = ate;
      }
      for (let lote = D.shopeeSemDetalhe(shopId, 50), voltas = 0; lote.length && voltas < 100; lote = D.shopeeSemDetalhe(shopId, 50), voltas++) {
        const r = await daLoja(shopId, '/api/v2/order/get_order_detail', { order_sn_list: lote,
          response_optional_fields: ['item_list', 'total_amount', 'pay_time', 'actual_shipping_fee', 'shipping_carrier'] });
        const vieram = new Set();
        for (const o of r.response?.order_list || []) { const d = detalheDe(o); if (d.pedido.data) { D.shopeeDetalheGravar(d.pedido, d.itens); vieram.add(o.order_sn); } }
        if (!vieram.size) break;   // a Shopee não devolveu nada deste lote: tenta na próxima leitura
      }
      await lerRepasses(shopId);
      D.configGravar(chave, inicio.toISOString());
    })().finally(() => lendo.delete(shopId));
    lendo.set(shopId, p);
    return p;
  }
  // Repasse: um pedido por chamada (get_escrow_detail), até 200 por leitura.
  async function lerRepasses(shopId) {
    const status = new Map();
    for (const sn of D.shopeeSemEscrow(shopId, 200)) {
      try {
        const r = await daLoja(shopId, '/api/v2/payment/get_escrow_detail', { order_sn: sn });
        if (!status.size) for (const x of D.db.prepare('SELECT order_sn, status FROM shopee_pedidos WHERE shop_id=?').all(shopId)) status.set(x.order_sn, x.status);
        D.shopeeEscrowGravar(sn, repasseDe(r.response, status.get(sn)));
      } catch { /* sem repasse ainda: tenta na próxima */ }
    }
  }

  function empresaDe(shopId) {
    const propria = D.configLer(`empresa:shopee-${shopId}`);
    const reserva = D.contasListar()[0]?.ml_user_id;
    return C.lerEmpresa(propria || (reserva ? D.configLer(`empresa:${reserva}`) : null));
  }
  async function linhas(shopId, de, ate, opcoes = {}) {
    let erroLeitura = null;
    try { await sincronizar(shopId, opcoes.recarregar); } catch (e) { erroLeitura = e.message; }
    const empresa = empresaDe(shopId);
    const impostoPct = C.impostoTotal(empresa);
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const base90 = D.shopeeVendasPeriodo(shopId, new Date(Date.now() - 90 * 864e5).toISOString(), '9999');
    const proporcao = proporcaoDe(base90);
    const ls = linhasDe(D.shopeeVendasPeriodo(shopId, de, ate), { mapa, imposto_pct: impostoPct, embalagem_pedido: empresa.embalagem_padrao || 0, proporcao,
      entrega_propria: empresa.entrega_propria, frete_medio: freteMedioDe(base90) });
    return { linhas: ls, impostoPct, erroLeitura, pendentes: D.shopeePendentes(shopId) };
  }

  const diasDe = (url, ok, padrao = 30) => { const d = Number(url.searchParams.get('dias')); return ok.includes(d) ? d : padrao; };
  const rotas = {
    // Pedidos / Vendas Hoje: o mesmo formato de custos.js#vendasDaConta.
    'GET /api/shopee/pedidos': async (url) => {
      const shopId = exigeLoja(url);
      const dias = diasDe(url, [1, 7, 15, 30, 60, 90]);
      const j = K.janelaVendas(dias, janela);
      const r = await linhas(shopId, j.de, j.ate, { recarregar: url.searchParams.get('recarregar') === '1' });
      return { dias, de: j.de, ate: j.ate, imposto_pct: r.impostoPct, erro_leitura: r.erroLeitura,
        itens_pendentes: r.pendentes?.detalhe || 0, repasses_pendentes: r.pendentes?.repasse || 0,
        estimadas: r.linhas.filter((l) => l.valida && l.estimado).length,
        resumo: K.somaLinhas(r.linhas), sem_custo: K.semCusto(r.linhas), vendas: r.linhas };
    },
    'GET /api/shopee/performance': async (url) => {
      const shopId = exigeLoja(url);
      const dias = diasDe(url, [7, 15, 30, 60, 75]);
      const atual = K.intervalo(dias);
      const antes = K.intervalo(dias, Date.parse(atual.de) - 1 + 3 * 3600e3);
      const r = await linhas(shopId, antes.de, atual.ate);
      return K.performanceDe(r.linhas, dias, atual.de);
    },
    // Um canal só (a Shopee não separa como Full/Flex): a tela mostra o total de envios.
    'GET /api/shopee/performance/logistica': async (url) => {
      const shopId = exigeLoja(url);
      const dias = diasDe(url, [7, 15, 30, 60, 75]);
      const j = K.intervalo(dias);
      const r = await linhas(shopId, j.de, j.ate);
      const s = K.somaLinhas(r.linhas);
      return { dias, de: j.de, ate: j.ate, envios_pendentes: 0, total: { pedidos: s.pedidos, faturamento: s.faturamento },
        canais: [{ canal: 'envios', nome: 'Envios da Shopee', pedidos: s.pedidos, unidades: s.unidades, faturamento: s.faturamento,
          ticket: s.pedidos ? r2(s.faturamento / s.pedidos) : null, participacao: s.faturamento > 0 ? 1 : 0 }] };
    },
    'GET /api/shopee/abc': async (url) => {
      const shopId = exigeLoja(url);
      const dias = diasDe(url, [15, 30, 60, 90, 150]);
      const j = janela(dias);
      const r = await linhas(shopId, j.de, j.ate);
      return K.abcDe(r.linhas, { dias, de: j.primeiro, ate: j.ultimo });
    },
    // "Todas as contas": hoje, período, por dia e produtos (somados no navegador, como a Amazon).
    'GET /api/shopee/vendas': async (url) => {
      const shopId = exigeLoja(url);
      const dias = diasDe(url, [7, 15, 30, 60, 90]);
      const j = K.janelaVendas(dias, janela);
      const r = await linhas(shopId, j.de, j.ate);
      const loja = D.shopeeLojasListar().find((l) => l.shop_id === shopId);
      return { loja: shopId, nome: loja?.nome || `Shopee ${shopId}`, erro_leitura: r.erroLeitura,
        ...K.resumoGeral(r.linhas, { dias, de: j.de, ate: j.ate, hojeDe: K.janelaVendas(1, janela).de, conta: `shopee-${shopId}`, topPorSku: C.topPorSku }) };
    },
  };
  return { rotas, rotasParam: [], sincronizar };
}

module.exports = { criar, taxaFixaDe, detalheDe, repasseDe, linhasDe, proporcaoDe, freteMedioDe, entregaPropria };
