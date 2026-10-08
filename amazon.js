'use strict';
// Amazon Selling Partner API (SP-API): conexão da conta de vendedor. Primeiro passo da
// integração — credenciais do aplicativo, teste do acesso e um diagnóstico do que a Amazon
// devolve (pedidos, itens, taxas, estoque) antes de o painel calcular qualquer coisa.
//
// Como a Amazon funciona (documentação da SP-API; conferir no diagnóstico com a conta real):
//   - Aplicativo privado ("Desenvolvedor privado", status Rascunho), autorizado pela própria
//     conta no Seller Central (Autorizar aplicativo) — sem endereço de retorno nem túnel.
//   - Três códigos, digitados na tela Amazon (nunca no chat): Client ID e Client Secret (LWA)
//     e o Refresh Token da autorização. Secret e refresh ficam cifrados no SQLite.
//   - Access token: POST https://api.amazon.com/auth/o2/token (grant_type=refresh_token),
//     vale 1 h; o refresh token NÃO muda a cada renovação (diferente da Shopee).
//   - Chamadas: https://sellingpartnerapi-na.amazon.com com o header x-amz-access-token.
//     Brasil = região América do Norte, marketplace A2Q3Y263D00KWC. Sem assinatura AWS.
//
// Compromissos declarados à Amazon no cadastro de desenvolvedor (não afrouxe):
//   - Nenhum dado pessoal de comprador: o painel não pede token de dados restritos (RDT) e
//     tira endereço/comprador de qualquer resposta antes de devolver.
//   - Dados da Amazon não vão a terceiros: nenhuma ferramenta MCP aponta para /api/amazon
//     (test-amazon.js reprova) e o diagnóstico mostra a FORMA da resposta (campos e tipos),
//     não os valores — é a forma que se compartilha para construir as próximas telas.
const BR = 'A2Q3Y263D00KWC';
const HOST = 'https://sellingpartnerapi-na.amazon.com';
const LWA = 'https://api.amazon.com/auth/o2/token';
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Credenciais digitadas na tela. Segredo/refresh ausentes = mantém os gravados. Função pura: testada.
function validarConfig(b) {
  const out = {};
  const id = String(b?.client_id ?? '').trim();
  if (!/^amzn1\.application-oa2-client\.[0-9a-z]{16,64}$/i.test(id)) {
    throw erro('Client ID: copie o "Identificador do cliente" das credenciais LWA (começa com amzn1.application-oa2-client.).');
  }
  out.client_id = id;
  const seg = String(b?.client_secret ?? '').trim();
  if (seg) {
    if (!/^amzn1\.oa2-cs\.\S{16,200}$/.test(seg)) throw erro('Client Secret: copie o "Segredo do cliente" inteiro (começa com amzn1.oa2-cs.).');
    out.client_secret = seg;
  }
  const rt = String(b?.refresh_token ?? '').trim();
  if (rt) {
    if (!/^Atzr\|\S{40,2000}$/.test(rt)) throw erro('Refresh Token: copie o token inteiro gerado em "Autorizar aplicativo" (começa com Atzr|).');
    out.refresh_token = rt;
  }
  return out;
}

// Campos que podem identificar o comprador: nunca saem do módulo. Função pura: testada.
const PESSOAIS = /^(BuyerInfo|BuyerEmail|BuyerName|BuyerTaxInfo|BuyerCounty|ShippingAddress|DefaultShipFromLocationAddress|BillingAddress|BuyerTaxInformation|BuyerCompanyLegalName|PurchaseOrderNumber|AddressLine\d|Phone|Name|PostalCode|City)$/i;
function semPessoais(v) {
  if (Array.isArray(v)) return v.map(semPessoais);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!PESSOAIS.test(k)) o[k] = semPessoais(x);
    return o;
  }
  return v;
}

// Forma de uma resposta: os mesmos campos, com o tipo no lugar do valor. Campos que são listas
// fixas da própria API (situação, canal, tipo de taxa, moeda) mostram o valor, porque é ele que
// diz como somar. Listas mostram o primeiro item e quantos tinham. Função pura: testada.
const VOCABULARIO = /^(OrderStatus|FulfillmentChannel|SalesChannel|OrderType|ShipmentServiceLevelCategory|ShipServiceLevel|PaymentMethod|PaymentMethodDetails|CurrencyCode|ChargeType|FeeType|TransactionType|PromotionType|condition|ConditionId|ConditionSubtypeId|granularityType|IsBusinessOrder|IsPrime|IsReplacementOrder|IsPremiumOrder|IsGlobalExpressEnabled|IsISPU|IsAccessPointOrder|IsSoldByAB|countryCode|name|id|defaultCurrencyCode|defaultLanguageCode|domainName|isParticipating|hasSuspendedListings|MarketplaceId|transactionType|transactionStatus|breakdownType|relatedIdentifierName|contextType|currencyCode|itemRelatedIdentifierName|AdjustmentType|Program)$/;
function forma(v, chave = '') {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? { lista: v.length, primeiro: forma(v[0], chave) } : { lista: 0 };
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = forma(x, k);
    return o;
  }
  if (VOCABULARIO.test(chave)) return v;
  if (typeof v === 'number') return 'número';
  if (typeof v === 'boolean') return 'sim/não';
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return 'data';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'número (texto)';
  return 'texto';
}

// Valores de vocabulário que aparecem em TODA a resposta (não só no primeiro item), com
// quantas vezes: é o que diz quais tipos de taxa a conta tem. Função pura: testada.
function vocabulario(v, acc = {}, chave = '') {
  if (Array.isArray(v)) { for (const x of v) vocabulario(x, acc, chave); return acc; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) vocabulario(x, acc, k); return acc; }
  if (v != null && VOCABULARIO.test(chave) && !/^(id|name|MarketplaceId|CurrencyCode|currencyCode)$/.test(chave)) {
    const m = (acc[chave] ||= {});
    m[String(v)] = (m[String(v)] || 0) + 1;
  }
  return acc;
}

// Listas de eventos financeiros que vieram com algo: { ShipmentEventList: 12, ... }. Função pura: testada.
const nomes = (voc) => Object.fromEntries(Object.entries(voc).map(([k, m]) => [k, Object.keys(m).sort()]));
const listasCheias = (fe) => Object.fromEntries(Object.entries(fe || {}).filter(([, x]) => Array.isArray(x) && x.length).map(([k, x]) => [k, x.length]));

// ---------- vendas e lucro ----------
// Os lançamentos financeiros viram linhas por item de pedido. Medido em 01/10/2026 na conta
// real (diagnóstico, últimos 30 dias): ShipmentEventList, RefundEventList, ServiceFeeEventList
// e AdjustmentEventList; ChargeType Principal, ShippingCharge, GiftWrap e os *Tax; FeeType
// Commission, FBAPerUnitFulfillmentFee, MFNPostageFee, ShippingChargeback, ShippingHB etc.
// A etiqueta do envio próprio (MFNPostageFee) NÃO vem no item: vem na ServiceFeeEventList, sem
// data — ver servicosDe. Medido em 06/10/2026: 204 etiquetas, R$ 4.412 em 92 dias.
const FEE_FRETE = /^(MFNPostageFee|ShippingChargeback|ShippingHB)$/;
// Tarifas por unidade (não acompanham o preço): as do FBA e as taxas fixas de fechamento.
const FEE_FIXA = /^FBA|ClosingFee$/;
const valor = (m) => Number(m?.CurrencyAmount ?? m?.currencyAmount ?? m?.Amount ?? 0) || 0;
const dataIso = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const r2 = (v) => Math.round(v * 100) / 100;
const CC = require('./campanhas-canais.js');
const { janelaDoMes } = require('./canais.js');

// Função pura: testada.
// Pedido com 2+ unidades do mesmo item (FBA): a Amazon manda uma linha por unidade, com o MESMO
// OrderItemId e a mesma data (a comissão de todas vem só na primeira). A 2ª em diante ganha
// "|2", "|3" na chave — antes uma gravava por cima da outra (medido: 51 unidades em 92 dias).
function lancamentosDe(fe) {
  const out = [], vistas = new Map();
  const item = (tipo, ev, it, cargas, taxas, promos) => {
    let receita = 0, imposto = 0, tarifa = 0, frete = 0, fixa = 0, fba = false;
    for (const c of cargas || []) { const v = valor(c.ChargeAmount); if (/Tax$/i.test(c.ChargeType || '')) imposto += v; else receita += v; }
    const promocoes = [];
    for (const p of promos || []) {
      receita += valor(p.PromotionAmount);
      // PromotionId = nome da promoção criada no Seller Central (ex.: "Desconto percentual 2026/07/31 …");
      // medido em 07/10/2026: parte vem sem id (fica "sem identificação" no resultado)
      if (valor(p.PromotionAmount)) promocoes.push({ id: p.PromotionId || null, tipo: p.PromotionType || null, valor: r2(-valor(p.PromotionAmount)) });
    }
    for (const f of taxas || []) {
      const v = -valor(f.FeeAmount);   // a Amazon manda taxa negativa; aqui custo é positivo
      if (/^FBA/.test(f.FeeType || '')) fba = true;
      if (FEE_FRETE.test(f.FeeType || '')) frete += v; else { tarifa += v; if (FEE_FIXA.test(f.FeeType || '')) fixa += v; }
    }
    const data = dataIso(ev.PostedDate);
    if (!data) return;
    const idItem = it.OrderItemId || it.OrderAdjustmentItemId || it.SellerSKU || '';
    const base = `${tipo}|${ev.AmazonOrderId || ''}|${idItem}|${data}`;
    const n = (vistas.get(base) || 0) + 1;
    vistas.set(base, n);
    out.push({ chave: n > 1 ? `${base}|${n}` : base, tipo, pedido: ev.AmazonOrderId || null,
      sku: it.SellerSKU || null, quantidade: Number(it.QuantityShipped) || 0, data, canal: fba ? 'FBA' : 'proprio',
      receita: r2(receita), tarifa: r2(tarifa), frete: r2(frete), imposto_cobrado: r2(imposto), tarifa_fixa: r2(fixa),
      ...(promocoes.length ? { promocoes } : {}) });
  };
  for (const ev of fe?.ShipmentEventList || []) {
    for (const it of ev.ShipmentItemList || []) item('venda', ev, it, it.ItemChargeList, it.ItemFeeList, it.PromotionList);
  }
  for (const ev of fe?.RefundEventList || []) {
    for (const it of ev.ShipmentItemAdjustmentList || []) {
      item('reembolso', ev, it, it.ItemChargeAdjustmentList, it.ItemFeeAdjustmentList, it.PromotionAdjustmentList);
    }
  }
  // Ajustes (reembolso de avaria no armazém etc.): entram como receita da conta, sem produto.
  for (const ev of fe?.AdjustmentEventList || []) {
    const data = dataIso(ev.PostedDate);
    if (!data) continue;
    out.push({ chave: `ajuste|${ev.AdjustmentType || ''}|${data}|${valor(ev.AdjustmentAmount)}`, tipo: 'ajuste', pedido: null,
      sku: null, quantidade: 0, data, canal: null, receita: r2(valor(ev.AdjustmentAmount)), tarifa: 0, frete: 0, imposto_cobrado: 0, tarifa_fixa: 0 });
  }
  return out;
}

// Cobranças avulsas, pela API de transações (Finances 2024-06-19), que tem data e um id por
// cobrança (a v0 manda a ServiceFeeEventList sem data). Medido em 06/10/2026 na conta real:
// MfnPostageFee = etiqueta do envio próprio comprada na Amazon, com o ORDER_ID (já com o estorno
// de frete); FBAStorageBilling, FBAPostInboundTransportation (envio ao armazém), FBARemoval e
// Subscription (mensalidade) = custos da conta, sem pedido de venda. Função pura: testada.
function servicosDe(transacoes) {
  const out = [];
  for (const t of transacoes || []) {
    if (t?.transactionType !== 'ServiceFee' || !t.transactionId) continue;
    const data = dataIso(t.postedDate);
    if (!data) continue;
    const desc = String(t.description || '');
    const custo = r2(-valor(t.totalAmount));
    const etiqueta = /^MfnPostage/i.test(desc);
    const pedido = (t.relatedIdentifiers || []).find((r) => r.relatedIdentifierName === 'ORDER_ID')?.relatedIdentifierValue || null;
    out.push({ chave: `servico|${t.transactionId}`, tipo: etiqueta ? 'etiqueta' : 'servico', pedido: etiqueta ? pedido : null,
      sku: null, quantidade: 0, data, canal: etiqueta ? 'proprio' : /^FBA/i.test(desc) ? 'FBA' : null, receita: 0,
      tarifa: etiqueta ? 0 : custo, frete: etiqueta ? custo : 0, imposto_cobrado: 0, tarifa_fixa: 0, descricao: desc || null });
  }
  return out;
}

// A etiqueta entra no frete das vendas do MESMO pedido (rateada pelo faturamento; sem faturamento,
// em partes iguais). Sem a venda na lista (lançada fora da janela) fica como linha própria.
// Função pura: testada.
function comEtiquetas(lancs) {
  const vendas = new Map();
  for (const l of lancs) if (l.tipo === 'venda' && l.pedido) { if (!vendas.has(l.pedido)) vendas.set(l.pedido, []); vendas.get(l.pedido).push(l); }
  const extra = new Map(), out = [];
  for (const l of lancs) {
    const vs = l.tipo === 'etiqueta' ? vendas.get(l.pedido) : null;
    if (!vs) { out.push(l); continue; }
    const base = vs.reduce((a, v) => a + Math.max(0, v.receita), 0);
    for (const v of vs) extra.set(v, (extra.get(v) || 0) + l.frete * (base > 0 ? Math.max(0, v.receita) / base : 1 / vs.length));
  }
  return out.map((l) => (extra.has(l) ? { ...l, frete: r2(l.frete + extra.get(l)), etiqueta: r2(extra.get(l)) } : l));
}

// Lucro de cada lançamento: o mesmo cálculo das contas do Mercado Livre (custo pelo SKU,
// embalagem padrão da empresa no envio próprio, impostos da empresa sobre o faturamento).
// Reembolso devolve a receita e as taxas estornadas; o produto volta para o estoque (sem
// custo). Ajuste não tem produto nem imposto. Etiqueta solta e cobrança da conta ('servico':
// armazenagem, envio ao armazém, mensalidade) são só custo. Função pura: testada.
function contaDoLancamento(l, ctx) {
  const venda = l.tipo === 'venda';
  const produto = venda ? (ctx.custo_unit == null ? null : ctx.custo_unit * l.quantidade) : 0;
  const embalagem = venda && l.canal === 'proprio' ? (ctx.embalagem_unit || 0) * l.quantidade : 0;
  const imposto = l.tipo === 'ajuste' ? 0 : (ctx.imposto_pct || 0) / 100 * l.receita;
  const lucro = produto == null ? null : l.receita - l.tarifa - l.frete - produto - embalagem - imposto;
  const x = (v) => (v == null ? null : r2(v));
  return { faturamento: x(l.receita), tarifa: x(l.tarifa), frete: x(l.frete), produto: x(produto), embalagem: x(embalagem),
    imposto: x(imposto), lucro: x(lucro), margem: lucro != null && l.receita > 0 ? lucro / l.receita : null };
}

// Resumo no mesmo formato das contas do Mercado Livre (tela "Todas as contas"). Pedidos e
// unidades contam só as vendas. Função pura: testada.
function resumoAmazon(linhas) {
  const t = { pedidos: new Set(), unidades: 0, faturamento: 0, tarifa: 0, frete: 0, produto: 0, embalagem: 0, imposto: 0,
    lucro: 0, com_lucro_fat: 0, reembolsos: 0, ajustes: 0, servicos: 0 };
  for (const l of linhas) {
    if (l.tipo === 'venda') { if (l.pedido) t.pedidos.add(l.pedido); t.unidades += l.quantidade; }
    if (l.tipo === 'reembolso') t.reembolsos += l.faturamento;
    if (l.tipo === 'ajuste') t.ajustes += l.faturamento;
    if (l.tipo === 'servico') t.servicos += l.tarifa || 0;
    for (const k of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto']) t[k] += l[k] || 0;
    if (l.lucro != null) { t.lucro += l.lucro; t.com_lucro_fat += l.faturamento; }
  }
  return { pedidos: t.pedidos.size, unidades: t.unidades, faturamento: r2(t.faturamento), tarifa: r2(t.tarifa), frete: r2(t.frete),
    produto: r2(t.produto), embalagem: r2(t.embalagem), imposto: r2(t.imposto), lucro: r2(t.lucro),
    margem: t.com_lucro_fat > 0 ? t.lucro / t.com_lucro_fat : null,
    cobertura: t.faturamento > 0 ? Math.min(1, t.com_lucro_fat / t.faturamento) : null,
    reembolsos: r2(t.reembolsos), ajustes: r2(t.ajustes), servicos: r2(t.servicos), cancelados: 0 };
}

// ---------- pedidos (data da compra) com as taxas do financeiro ----------
// Pedidos e Vendas Hoje contam pela data da COMPRA, como no Mercado Livre. As taxas reais só
// existem depois que a Amazon lança o pedido no financeiro (no envio); até lá vale a média
// daquele SKU (ou do canal), marcada como estimada.
const num = (m) => (m?.Amount == null ? null : Number(m.Amount) || 0);

// Pedido da Orders API -> linha da tabela. Função pura: testada.
const pedidoDe = (o) => ({ pedido: o.AmazonOrderId, data: dataIso(o.PurchaseDate), status: o.OrderStatus || null,
  canal: o.FulfillmentChannel === 'AFN' ? 'FBA' : 'proprio', total: num(o.OrderTotal), atualizado: o.LastUpdateDate || null });
// Item do pedido -> linha. Preço é o total da linha (todas as unidades). Função pura: testada.
const itemDe = (i) => ({ item_id: String(i.OrderItemId), sku: i.SellerSKU || null, asin: i.ASIN || null,
  quantidade: Number(i.QuantityOrdered) || 0, preco: num(i.ItemPrice), frete_cobrado: num(i.ShippingPrice) || 0,
  desconto: r2((num(i.PromotionDiscount) || 0) + (num(i.ShippingDiscount) || 0)) });

// Mesma janela das vendas do Mercado Livre (custos.js#vendasDaConta): hoje = desde 00h de
// Brasília; período = os dias completos da janela mais hoje até agora.
function janelaVendas(dias, janela, agora = Date.now()) {
  if (dias === 1) return { de: new Date(Date.parse(new Date(agora - 3 * 3600e3).toISOString().slice(0, 10) + 'T03:00:00Z')).toISOString(),
    ate: new Date(agora + 60e3).toISOString() };
  return { ...janela(dias), ate: new Date(agora + 60e3).toISOString() };
}

// Taxas lançadas, por pedido+SKU, e as médias para estimar o que ainda não foi lançado. O frete
// já traz a etiqueta do envio próprio (comEtiquetas). armazem_un = armazenagem + envio ao
// armazém + remoção do FBA (cobranças da conta) ÷ unidades vendidas pelo FBA na janela.
// mediaSku(sku, canal): a do SKU naquele envio; sem venda nele, a do SKU. Função pura: testada.
function taxasDosLancamentos(lancs) {
  const porPedido = new Map(), sku = new Map(), canal = new Map();
  let armazem = 0, unFba = 0;
  const soma = (m, k, l) => { const x = m.get(k) || { receita: 0, tarifa: 0, fixa: 0, frete: 0, unidades: 0, unidades_fba: 0 };
    x.receita += l.receita; x.tarifa += l.tarifa; x.fixa += l.tarifa_fixa || 0; x.frete += l.frete; x.unidades += l.quantidade;
    if (l.canal === 'FBA') x.unidades_fba += l.quantidade;
    m.set(k, x); };
  for (const l of comEtiquetas(lancs)) {
    if (l.tipo === 'servico') { if (l.canal === 'FBA') armazem += l.tarifa; continue; }
    if (l.tipo === 'ajuste' || l.tipo === 'etiqueta' || !l.pedido) continue;
    const k = `${l.pedido}|${l.sku || ''}`;
    const x = porPedido.get(k) || { tarifa: 0, frete: 0, reembolso: 0, tarifa_reembolso: 0, lancado: false };
    if (l.tipo === 'venda') {
      x.tarifa += l.tarifa; x.frete += l.frete; x.lancado = true;
      soma(sku, l.sku, l); soma(sku, `${l.sku}|${l.canal}`, l); soma(canal, l.canal, l);
      if (l.canal === 'FBA') unFba += l.quantidade;
    } else { x.reembolso += l.receita; x.tarifa_reembolso += l.tarifa; }
    porPedido.set(k, x);
  }
  const armazemUn = unFba ? armazem / unFba : 0;
  const media = (x) => (x && x.receita > 0 ? { tarifa_pct: (x.tarifa - x.fixa) / x.receita, fixa_un: x.unidades ? x.fixa / x.unidades : 0,
    frete_un: x.unidades ? x.frete / x.unidades : 0, armazem_un: x.unidades ? armazemUn * x.unidades_fba / x.unidades : 0 } : null);
  return { porPedido, armazemUn,
    mediaSku: (s, c) => media((c && sku.get(`${s}|${c}`)) || sku.get(s)), mediaCanal: (c) => media(canal.get(c)) };
}

// Uma linha de venda no formato da tela Pedidos (custos.js#vendasDaConta). Pedido "Pending": a
// Amazon só informa o preço depois de confirmar o pagamento (medido em 06/10/2026: 15 de 16
// pendentes sem ItemPrice) — vale o último preço por unidade do mesmo SKU (ctx.preco_unit_sku),
// marcado como estimado. Função pura: testada.
function linhaDoPedido(v, ctx) {
  const valida = v.status !== 'Canceled';
  const q = v.quantidade || 0;
  const precoEstimado = v.preco == null && valida && ctx.preco_unit_sku != null;
  const fat = v.preco == null ? (precoEstimado ? ctx.preco_unit_sku * q : 0) : v.preco + (v.frete_cobrado || 0) - (v.desconto || 0);
  const t = ctx.taxas.porPedido.get(`${v.pedido}|${v.sku || ''}`);
  let tarifa, frete, estimado = precoEstimado;
  if (t?.lancado) { tarifa = t.tarifa; frete = t.frete; }
  else {
    const m = ctx.taxas.mediaSku(v.sku, v.canal) || ctx.taxas.mediaCanal(v.canal);
    tarifa = m ? m.tarifa_pct * fat + (m.fixa_un || 0) * q : null; frete = m ? m.frete_un * q : null; estimado = true;
  }
  // FBA: a parte da unidade na armazenagem e no envio ao armazém (cobranças da conta, rateadas).
  if (frete != null && valida && v.canal === 'FBA') frete += (ctx.taxas.armazemUn || 0) * q;
  const reembolso = t?.reembolso || 0;
  const devolvido = reembolso < 0 && -reembolso >= 0.99 * fat;   // reembolso total: o produto volta
  const faturamento = fat + reembolso;
  if (tarifa != null) tarifa += t?.tarifa_reembolso || 0;
  const produto = !valida || devolvido ? 0 : ctx.custo_unit == null ? null : ctx.custo_unit * q;
  const embalagem = valida && v.canal === 'proprio' ? (ctx.embalagem_unit || 0) * q : 0;
  const imposto = (ctx.imposto_pct || 0) / 100 * faturamento;
  const falta = [];
  if (produto == null) falta.push('custo');
  if (tarifa == null) falta.push('tarifa');
  const lucro = falta.length ? null : faturamento - tarifa - frete - produto - embalagem - imposto;
  const x = (n) => (n == null ? null : r2(n));
  return { faturamento: x(faturamento), tarifa: x(tarifa), frete: x(frete), produto: x(produto), embalagem: x(embalagem),
    imposto: x(imposto), lucro: x(lucro), margem: lucro != null && faturamento > 0 ? lucro / faturamento : null,
    falta, estimado, preco_estimado: precoEstimado, reembolso: x(reembolso), valida, devolvido, preco_unit: q ? x(fat / q) : null };
}

// Ofertas de um ASIN (resposta do getItemOffers) -> o que a tela mostra, da mais barata
// (preço + frete) para a mais cara. Função pura: testada.
function ofertasDe(p, eu) {
  const ofertas = (p?.Offers || []).map((o) => {
    const preco = num(o.ListingPrice) ?? 0, frete = num(o.Shipping) ?? 0;
    const voce = !!eu && o.SellerId === eu;
    return { vendedor_id: voce ? null : o.SellerId || null, preco: r2(preco), frete: r2(frete), total: r2(preco + frete), fba: !!o.IsFulfilledByAmazon,
      prime: !!o.PrimeInformation?.IsPrime, destaque: !!o.IsBuyBoxWinner, voce,
      avaliacao_pct: o.SellerFeedbackRating?.SellerPositiveFeedbackRating ?? null, avaliacoes: o.SellerFeedbackRating?.FeedbackCount ?? null,
      envio_horas: o.ShippingTime?.maximumHours ?? null };
  }).sort((a, b) => a.total - b.total);
  const outros = ofertas.filter((o) => !o.voce);
  return { asin: p?.ASIN || null, total_ofertas: p?.Summary?.TotalOfferCount ?? ofertas.length, ofertas,
    destaque: ofertas.find((o) => o.destaque) || null, voce_destaque: ofertas.some((o) => o.voce && o.destaque),
    menor_outro: outros[0] || null, em: new Date().toISOString() };
}

function criar({ D, janela }) {
  const C = require('./custos.js');
  const config = () => ({
    client_id: D.configLer('amazon_lwa_client_id') || null,
    client_secret: D.configLer('amazon_lwa_client_secret') || null,
    refresh_token: D.configLer('amazon_refresh_token') || null,
  });

  // Access token em memória (1 h). Uma renovação de cada vez.
  let acesso = null;      // { token, expira }
  let pedindo = null;
  async function pedirToken(c) {
    let r;
    try {
      r = await fetch(LWA, { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token,
          client_id: c.client_id, client_secret: c.client_secret }) });
    } catch (e) { throw erro(`A Amazon (login LWA) não respondeu (${e.message}).`, 502); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) {
      const motivo = j?.error_description || j?.error || `HTTP ${r.status}`;
      throw erro(`A Amazon recusou as credenciais: ${motivo}. Confira o Client ID, o Client Secret e o Refresh Token.`, 401);
    }
    return { token: j.access_token, expira: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  }
  async function token() {
    if (acesso && Date.now() < acesso.expira - 60e3) return acesso.token;
    if (!pedindo) {
      const c = config();
      if (!c.client_id || !c.client_secret || !c.refresh_token) {
        throw erro('Informe o Client ID, o Client Secret e o Refresh Token do aplicativo da Amazon primeiro.', 409);
      }
      pedindo = pedirToken(c).then((a) => { acesso = a; return a.token; }).finally(() => { pedindo = null; });
    }
    return pedindo;
  }

  // Uma chamada à SP-API (só leitura por enquanto). 429 = limite de chamadas: espera e tenta de novo.
  // Escrita (PATCH/PUT/POST) na conta: só a troca de preço da tela Anúncios usa.
  const spEscrever = (metodo, caminho, params, corpo) => sp(caminho, params, { metodo, corpo });
  async function sp(caminho, params = {}, { metodo = 'GET', corpo = null } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    const url = `${HOST}${caminho}${qs.size ? '?' + qs : ''}`;
    for (let tentativa = 0; ; tentativa++) {
      let r;
      try {
        r = await fetch(url, { method: metodo, signal: AbortSignal.timeout(30000), body: corpo ? JSON.stringify(corpo) : undefined,
          headers: { 'x-amz-access-token': await token(), 'Accept': 'application/json', 'User-Agent': 'PainelVendedor/1.0 (Language=Node.js)',
            ...(corpo ? { 'Content-Type': 'application/json' } : {}) } });
      } catch (e) { if (e.status) throw e; throw erro(`A Amazon não respondeu (${e.message}).`, 502); }
      if (r.status === 429 && tentativa < 3) { await new Promise((ok) => setTimeout(ok, 2000 * (tentativa + 1))); continue; }
      if (r.status === 403) acesso = null;   // token pode ter sido revogado: o próximo pede outro
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        const e = j?.errors?.[0];
        throw erro(`Amazon: ${e ? `${e.message || e.code} (${e.code})` : `HTTP ${r.status}`}`, r.status >= 500 ? 502 : r.status);
      }
      return semPessoais(j);
    }
  }

  const rotas = {
    'GET /api/amazon/config': async () => {
      const c = config();
      return { client_id: c.client_id, tem_segredo: !!c.client_secret, tem_refresh: !!c.refresh_token,
        conectada_em: D.configLer('amazon_conectada_em'), vendedor: D.configLer('amazon_vendedor') };
    },

    // Grava só depois de a Amazon aceitar: credencial errada nem chega ao banco.
    'PUT /api/amazon/config': async (_u, body) => {
      const novo = validarConfig(body);
      const atual = config();
      const c = { client_id: novo.client_id, client_secret: novo.client_secret || atual.client_secret,
        refresh_token: novo.refresh_token || atual.refresh_token };
      if (!c.client_secret) throw erro('Informe também o Client Secret.');
      if (!c.refresh_token) throw erro('Informe também o Refresh Token (Seller Central → Desenvolver aplicativos → Autorizar).');
      acesso = await pedirToken(c);
      D.configGravar('amazon_lwa_client_id', c.client_id);
      D.configGravar('amazon_lwa_client_secret', c.client_secret);
      D.configGravar('amazon_refresh_token', c.refresh_token);
      D.configGravar('amazon_conectada_em', new Date().toISOString());
      // nome da conta: enfeite — se falhar, segue conectada
      try {
        const p = await sp('/sellers/v1/marketplaceParticipations');
        const br = (p.payload || []).find((x) => x.marketplace?.id === BR);
        D.configGravar('amazon_vendedor', br?.storeName || (br ? 'Amazon Brasil' : null));
      } catch { /* segue */ }
      return { conectada: true };
    },

    'POST /api/amazon/remover': async () => {
      for (const k of ['amazon_lwa_client_id', 'amazon_lwa_client_secret', 'amazon_refresh_token', 'amazon_conectada_em', 'amazon_vendedor', 'amazon_lanc_lido_em']) D.configGravar(k, null);
      D.amazonLancApagar();
      acesso = null;
      return { removida: true };
    },

    // Diagnóstico: o que a Amazon devolve para a conta — participação nos marketplaces, os
    // pedidos dos últimos dias, os itens e as taxas de um pedido e o estoque FBA. Só leitura.
    // Números (quantos pedidos, por situação) e a FORMA de cada resposta; sem valores.
    'GET /api/amazon/diagnostico': async (url) => {
      const dias = Math.min(30, Math.max(1, Number(url.searchParams.get('dias')) || 7));
      const passo = async (fn) => { try { return await fn(); } catch (e) { return { erro: e.message }; } };
      const contas = await passo(() => sp('/sellers/v1/marketplaceParticipations'));
      const lista = await passo(() => sp('/orders/v0/orders', { MarketplaceIds: BR, MaxResultsPerPage: 100,
        CreatedAfter: new Date(Date.now() - dias * 86400e3).toISOString() }));
      const pedidos = lista.payload?.Orders || [];
      const id = pedidos.find((p) => p.OrderStatus === 'Shipped')?.AmazonOrderId || pedidos[0]?.AmazonOrderId || null;
      const itens = id ? await passo(() => sp(`/orders/v0/orders/${encodeURIComponent(id)}/orderItems`)) : null;
      const taxas = id ? await passo(() => sp(`/finances/v0/orders/${encodeURIComponent(id)}/financialEvents`)) : null;
      const estoque = await passo(() => sp('/fba/inventory/v1/summaries', { granularityType: 'Marketplace',
        granularityId: BR, marketplaceIds: BR, details: 'true' }));
      // Taxas: as duas APIs financeiras da Amazon, nos últimos 30 dias (o pedido só ganha
      // taxa quando a Amazon fecha a parte financeira dele, dias depois do envio).
      const desde = new Date(Date.now() - 30 * 86400e3).toISOString();
      const eventos = await passo(() => sp('/finances/v0/financialEvents', { PostedAfter: desde, MaxResultsPerPage: 100 }));
      const fe = eventos.payload?.FinancialEvents;
      const transacoes = await passo(() => sp('/finances/2024-06-19/transactions', { postedAfter: desde, marketplaceId: BR }));
      const tr = transacoes.payload?.transactions || [];
      const conta = (contas.payload || []).find((x) => x.marketplace?.id === BR);
      const contar = (lst, campo) => lst.reduce((m, p) => { m[p[campo] || '?'] = (m[p[campo] || '?'] || 0) + 1; return m; }, {});
      return {
        dias,
        conta: contas.erro ? { erro: contas.erro } : { brasil: !!conta, ativa: !!conta?.participation?.isParticipating,
          anuncios_suspensos: !!conta?.participation?.hasSuspendedListings },
        pedidos_no_periodo: lista.erro ? null : pedidos.length, tem_mais: !!lista.payload?.NextToken, erro_pedidos: lista.erro || null,
        situacoes: contar(pedidos, 'OrderStatus'), canais: contar(pedidos, 'FulfillmentChannel'),
        itens: itens?.erro ? { erro: itens.erro } : itens ? 'lidos' : null,
        taxas: taxas?.erro ? { erro: taxas.erro } : taxas ? 'lidas' : null,
        estoque_fba: estoque.erro ? { erro: estoque.erro } : { produtos: estoque.payload?.inventorySummaries?.length || 0 },
        financeiro_30d: {
          eventos: eventos.erro ? { erro: eventos.erro } : { listas: listasCheias(fe), tem_mais: !!eventos.payload?.NextToken, tipos: vocabulario(fe) },
          transacoes: transacoes.erro ? { erro: transacoes.erro } : { quantidade: tr.length, tem_mais: !!transacoes.payload?.nextToken, tipos: vocabulario(tr) },
        },
        forma: { pedido: forma(pedidos[0]), itens: itens && !itens.erro ? forma(itens.payload) : null,
          taxas: taxas && !taxas.erro ? forma(taxas.payload) : null,
          estoque: !estoque.erro ? forma(estoque.payload?.inventorySummaries?.[0]) : null,
          evento_de_envio_30d: fe?.ShipmentEventList?.length ? forma(fe.ShipmentEventList[0]) : null,
          transacao_30d: tr.length ? forma(tr.find((x) => /shipment|order/i.test(x.transactionType || '')) || tr[0]) : null,
          // nomes dos tipos (comissão, tarifa FBA...), sem quantidades
          tipos_eventos_30d: eventos.erro ? null : nomes(vocabulario(fe)),
          tipos_transacoes_30d: transacoes.erro ? null : nomes(vocabulario(tr)),
          listas_com_eventos_30d: eventos.erro ? null : Object.keys(listasCheias(fe)) },
      };
    },
  };

  // ---------- vendas e lucro: cópia local dos lançamentos ----------
  // A cada consulta (no máximo a cada 10 min) lê o que a Amazon lançou desde a última leitura,
  // com 3 dias de folga; a primeira leitura traz 92 dias. Uma leitura de cada vez.
  // Cobranças avulsas (etiqueta, armazenagem, mensalidade) vêm da API de transações, com a sua
  // própria marca de leitura: uma falha nela não atrasa as vendas.
  let lendo = null;
  function sincronizar(forcar = false) {
    // promoções das vendas (coluna promocoes): a 1ª leitura com este código relê os 92 dias. Marca
    // própria, não a migração do banco: um painel antigo aberto releria sem gravar as promoções.
    const comPromocoes = D.configLer('amazon_lanc_promocoes') === '1';
    const ultima = comPromocoes ? D.configLer('amazon_lanc_lido_em') : null;
    const ultimaServ = D.configLer('amazon_serv_lido_em');
    const vencida = (u) => forcar || !u || Date.now() - Date.parse(u) >= 10 * 60e3;
    if (!vencida(ultima) && !vencida(ultimaServ)) return Promise.resolve(0);
    if (lendo) return lendo;
    lendo = (async () => {
      let total = 0;
      if (vencida(ultima)) total += await lerLancamentos(ultima);
      if (vencida(ultimaServ)) total += await lerServicos(ultimaServ);
      return total;
    })().finally(() => { lendo = null; });
    return lendo;
  }
  async function lerServicos(ultima) {
    const inicio = new Date();
    const desde = ultima ? new Date(Date.parse(ultima) - 3 * 86400e3) : new Date(Date.now() - 92 * 86400e3);
    const base = { postedAfter: desde.toISOString(), marketplaceId: BR };
    let params = base, total = 0;
    for (let pagina = 0; pagina < 200; pagina++) {
      const r = await sp('/finances/2024-06-19/transactions', params);
      total += D.amazonLancGravar(servicosDe(r.payload?.transactions));
      const prox = r.payload?.nextToken;
      if (!prox) break;
      params = { ...base, nextToken: prox };
      await new Promise((ok) => setTimeout(ok, 2100));   // limite da Amazon: 0,5 chamada/s
    }
    D.configGravar('amazon_serv_lido_em', inicio.toISOString());
    return total;
  }
  async function lerLancamentos(ultima) {
    const inicio = new Date();
    const desde = ultima ? new Date(Date.parse(ultima) - 3 * 86400e3) : new Date(Date.now() - 92 * 86400e3);
    let params = { PostedAfter: desde.toISOString(), MaxResultsPerPage: 100 }, total = 0;
    for (let pagina = 0; pagina < 200; pagina++) {
      const r = await sp('/finances/v0/financialEvents', params);
      total += D.amazonLancGravar(lancamentosDe(r.payload?.FinancialEvents));
      const prox = r.payload?.NextToken;
      if (!prox) break;
      params = { NextToken: prox };
      await new Promise((ok) => setTimeout(ok, 2100));   // limite da Amazon: 0,5 chamada/s
    }
    D.configGravar('amazon_lanc_lido_em', inicio.toISOString());
    D.configGravar('amazon_lanc_promocoes', '1');
    return total;
  }

  // Fotos: o lançamento financeiro não traz ASIN. Para cada SKU sem foto, o item de um pedido
  // dele dá o ASIN (Orders API) e o catálogo dá a foto principal (Catalog Items API). Roda em
  // segundo plano, um SKU de cada vez, e a foto aparece na próxima vez que a tela abrir.
  let buscandoFotos = false;
  async function buscarFotos(pedidoPorSku) {
    if (buscandoFotos) return;
    buscandoFotos = true;
    try {
      const fotos = D.amazonFotos();
      const semana = 7 * 86400e3;
      for (const [sku, pedido] of pedidoPorSku) {
        const f = fotos.get(sku);
        if (f?.foto || (f && Date.now() - Date.parse(f.lido_em) < semana)) continue;
        let asin = f?.asin || null, foto = null;
        try {
          if (!asin) {
            const it = await sp(`/orders/v0/orders/${encodeURIComponent(pedido)}/orderItems`);
            asin = (it.payload?.OrderItems || []).find((x) => x.SellerSKU === sku)?.ASIN || null;
            await new Promise((ok) => setTimeout(ok, 2100));   // Orders: 0,5 chamada/s
          }
          if (asin) {
            const cat = await sp(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { marketplaceIds: BR, includedData: 'images' });
            const imgs = (cat.images || []).flatMap((g) => g.images || []).filter((i) => i.variant === 'MAIN');
            foto = (imgs.filter((i) => i.width >= 200).sort((a, b) => a.width - b.width)[0] || imgs[0])?.link || null;
            await new Promise((ok) => setTimeout(ok, 600));    // Catalog: 2 chamadas/s
          }
        } catch { /* tenta de novo daqui a uma semana */ }
        D.amazonFotoGravar(sku, asin, foto);
      }
    } finally { buscandoFotos = false; }
  }

  // Empresa (impostos e embalagem padrão) da Amazon: a dela, salva na tela Empresa e custos
  // com a Amazon escolhida no topo. Antes disso, a de uma conta do ML (amazon_empresa_conta).
  function empresaAmazon() {
    const proprio = D.configLer('empresa:amazon');
    const id = Number(D.configLer('amazon_empresa_conta')) || D.contasListar()[0]?.ml_user_id || null;
    return { propria: !!proprio, empresa: C.lerEmpresa(proprio || (id ? D.configLer(`empresa:${id}`) : null)) };
  }

  async function vendasAmazon(dias, opcoes = {}) {
    const c = config();
    if (!c.client_id || !c.refresh_token) return null;
    let erroLeitura = null;
    try { await sincronizar(opcoes.recarregar); } catch (e) { erroLeitura = e.message; }
    // dias: número (últimos N dias) ou o mês do calendário (canais.js#janelaDoMes)
    const per = typeof dias === 'object' ? dias : null;
    if (per) dias = per.dias;
    const j = per || janelaVendas(dias, janela);
    const { propria, empresa } = empresaAmazon();
    const impostoPct = C.impostoTotal(empresa);
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const semCusto = new Map();
    const fotos = D.amazonFotos();
    const trocas = D.skuTrocas('amazon');   // troca de produto feita no painel (vale a partir da data)
    const linhas = comEtiquetas(D.amazonLancPeriodo(j.de, j.ate)).map((l) => {
      const cs = l.sku ? C.custoDoSku(C.skuNaData(trocas, l.sku, l.data), mapa) : { custo: null, componentes: [], faltando: [] };
      const conta_ = contaDoLancamento(l, { custo_unit: cs.custo, embalagem_unit: empresa.embalagem_padrao || 0, imposto_pct: impostoPct });
      if (l.tipo === 'venda' && cs.custo == null) {
        const s = semCusto.get(l.sku || '—') || { sku: l.sku, faltando: cs.faltando, vendas: 0 };
        s.vendas++; semCusto.set(l.sku || '—', s);
      }
      const nome = cs.componentes.map((x) => x.nome).filter(Boolean).join(' + ') || null;
      return { ...l, titulo: nome, foto: (l.sku && fotos.get(l.sku)?.foto) || null, ...conta_ };
    });
    const pedidoPorSku = new Map();
    for (const l of linhas) if (l.tipo === 'venda' && l.sku && l.pedido && !l.foto) pedidoPorSku.set(l.sku, l.pedido);
    if (pedidoPorSku.size) buscarFotos(pedidoPorSku).catch(() => null);
    const hojeDe = janelaVendas(1, janela).de;
    // mês passado não inclui hoje: as vendas de hoje lidas à parte
    const linhasHoje = j.ate <= hojeDe ? comEtiquetas(D.amazonLancPeriodo(hojeDe, new Date(Date.now() + 60e3).toISOString())).map((l) =>
      ({ ...l, ...contaDoLancamento(l, { custo_unit: l.sku ? C.custoDoSku(C.skuNaData(trocas, l.sku, l.data), mapa).custo : null, embalagem_unit: empresa.embalagem_padrao || 0, imposto_pct: impostoPct }) }))
      : linhas.filter((l) => l.data >= hojeDe);
    const porDia = new Map();
    for (const l of linhas) {
      const dia = new Date(Date.parse(l.data) - 3 * 3600e3).toISOString().slice(0, 10);
      const d = porDia.get(dia) || { dia, faturamento: 0, pedidos: new Set() };
      d.faturamento += l.faturamento || 0; if (l.tipo === 'venda' && l.pedido) d.pedidos.add(l.pedido);
      porDia.set(dia, d);
    }
    return {
      dias, de: j.de, ate: j.ate, mes: per?.mes || null, rotulo: per?.rotulo || null, lido_em: D.configLer('amazon_lanc_lido_em'), erro_leitura: erroLeitura,
      imposto_pct: impostoPct, embalagem_padrao: empresa.embalagem_padrao || 0, empresa_propria: propria,
      resumo: resumoAmazon(linhas), hoje: resumoAmazon(linhasHoje),
      por_dia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map((d) => ({ dia: d.dia, faturamento: r2(d.faturamento), pedidos: d.pedidos.size })),
      sem_custo: [...semCusto.values()].sort((a, b) => b.vendas - a.vendas),
      produtos: C.topPorSku(linhas.filter((l) => l.tipo === 'venda').map((l) => ({ ...l, conta: 'amazon' })), 100),
      lancamentos: opcoes.lancamentos ? linhas : undefined,
    };
  }

  // ---------- pedidos: cópia local ----------
  // Lista de pedidos: a cada 10 min no máximo, o que mudou desde a última leitura (1 dia de
  // folga); a primeira traz 152 dias (a ABC vai até 150). A Orders API deixa ~20 chamadas seguidas e depois 1 por
  // minuto: 100 pedidos por página dá folga. Itens: 1 chamada por pedido (0,5/s), em
  // segundo plano, os mais novos primeiro; a tela mostra quantos faltam.
  let lendoPedidos = null, lendoItens = false;
  function sincronizarPedidos(forcar = false) {
    const ultima = D.configLer('amazon_ped_lido_em');
    if (!forcar && ultima && Date.now() - Date.parse(ultima) < 10 * 60e3) return Promise.resolve(0);
    if (lendoPedidos) return lendoPedidos;
    lendoPedidos = (async () => {
      const inicio = new Date();
      let params = ultima ? { LastUpdatedAfter: new Date(Date.parse(ultima) - 86400e3).toISOString() }
        : { CreatedAfter: new Date(Date.now() - 152 * 86400e3).toISOString() };   // a ABC vai até 150 dias
      params = { MarketplaceIds: BR, MaxResultsPerPage: 100, ...params };
      let total = 0;
      for (let pagina = 0; pagina < 60; pagina++) {
        const r = await sp('/orders/v0/orders', params);
        total += D.amazonPedidosGravar((r.payload?.Orders || []).map(pedidoDe).filter((p) => p.pedido && p.data));
        const prox = r.payload?.NextToken;
        if (!prox) break;
        params = { MarketplaceIds: BR, NextToken: prox };
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      D.configGravar('amazon_ped_lido_em', inicio.toISOString());
      return total;
    })().finally(() => { lendoPedidos = null; });
    return lendoPedidos;
  }
  async function lerItens() {
    if (lendoItens) return;
    lendoItens = true;
    try {
      for (const pedido of D.amazonPedidosSemItens(1000)) {
        try {
          const r = await sp(`/orders/v0/orders/${encodeURIComponent(pedido)}/orderItems`);
          D.amazonItensGravar(pedido, (r.payload?.OrderItems || []).map(itemDe));
        } catch (e) { if (e.status === 429 || e.status >= 500) break; }   // limite ou instabilidade: tenta na próxima abertura
        await new Promise((ok) => setTimeout(ok, 2100));
      }
    } finally { lendoItens = false; }
  }

  // Monta as linhas de venda de uma janela, com custos, taxas e fotos.
  async function linhasDePedidos(de, ate, opcoes = {}) {
    let erroLeitura = null;
    try { await sincronizarPedidos(opcoes.recarregar); } catch (e) { erroLeitura = e.message; }
    sincronizar().catch(() => null);          // financeiro: taxas reais
    lerItens().catch(() => null);
    const { empresa } = empresaAmazon();
    const impostoPct = C.impostoTotal(empresa);
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const fotos = D.amazonFotos();
    const taxas = taxasDosLancamentos(D.amazonLancPeriodo(new Date(Date.parse(de) - 92 * 86400e3).toISOString(), '9999'));
    const precoSku = D.amazonUltimoPrecoPorSku();
    const trocas = D.skuTrocas('amazon');
    const linhas = D.amazonVendasPeriodo(de, ate).map((v) => {
      const cs = v.sku ? C.custoDoSku(C.skuNaData(trocas, v.sku, v.data), mapa) : { custo: null, componentes: [], faltando: [] };
      const emb = empresa.embalagem_padrao || 0;
      const conta_ = linhaDoPedido(v, { taxas, custo_unit: cs.custo, embalagem_unit: emb, imposto_pct: impostoPct,
        preco_unit_sku: precoSku.get(`${v.sku}|${v.canal}`) ?? precoSku.get(v.sku) ?? null });
      return { pedido: v.pedido, data: v.data, status: v.status, item_id: v.sku || v.pedido, sku: v.sku, asin: v.asin,
        quantidade: v.quantidade || 0, itens_lidos: !!v.itens_lidos, canal: v.canal, full: v.canal === 'FBA',
        titulo: cs.componentes.map((x) => x.nome).filter(Boolean).join(' + ') || v.sku || null,
        foto: (v.sku && fotos.get(v.sku)?.foto) || null, faltando: cs.faltando,
        componentes: cs.componentes.map((c) => ({ sku: c.sku || String(c.numero), custo: c.custo })),
        custo_unit: cs.custo, embalagem_unit: v.canal === 'proprio' ? emb : 0, ...conta_,
        link: `https://sellercentral.amazon.com.br/orders-v3/order/${encodeURIComponent(v.pedido)}` };
    });
    // fotos que faltam: o ASIN já veio no item do pedido
    const semFoto = new Map(D.amazonItensSemFoto().map((x) => [x.sku, x.asin]));
    if (semFoto.size) buscarFotosPorAsin(semFoto).catch(() => null);
    return { linhas, impostoPct, erroLeitura, pendentes: D.amazonPedidosSemItens(100000).length };
  }
  async function buscarFotosPorAsin(skuAsin) {
    if (buscandoFotos) return;
    buscandoFotos = true;
    try {
      for (const [sku, asin] of skuAsin) {
        let foto = null;
        try {
          const cat = await sp(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { marketplaceIds: BR, includedData: 'images' });
          const imgs = (cat.images || []).flatMap((g) => g.images || []).filter((i) => i.variant === 'MAIN');
          foto = (imgs.filter((i) => i.width >= 200).sort((a, b) => a.width - b.width)[0] || imgs[0])?.link || null;
        } catch { /* tenta de novo daqui a uma semana */ }
        D.amazonFotoGravar(sku, asin, foto);
        await new Promise((ok) => setTimeout(ok, 600));
      }
    } finally { buscandoFotos = false; }
  }

  const somaLinhas = (ls) => {
    const validas = ls.filter((l) => l.valida);
    const t = { pedidos: new Set(validas.map((l) => l.pedido)).size, unidades: 0, faturamento: 0, tarifa: 0, frete: 0, produto: 0,
      embalagem: 0, imposto: 0, lucro: 0, com_lucro: 0, cancelados: ls.filter((l) => !l.valida).length };
    for (const l of validas) {
      t.unidades += l.quantidade;
      for (const k of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto']) t[k] += l[k] || 0;
      if (l.lucro != null) { t.lucro += l.lucro; t.com_lucro += l.faturamento; }
    }
    for (const k of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto', 'lucro']) t[k] = r2(t[k]);
    t.margem = t.com_lucro > 0 ? t.lucro / t.com_lucro : null;
    t.cobertura = t.faturamento > 0 ? Math.min(1, t.com_lucro / t.faturamento) : null;
    delete t.com_lucro;
    return t;
  };

  // Tela Pedidos / Vendas Hoje: o mesmo formato de custos.js#vendasDaConta.
  async function pedidosAmazon(dias, opcoes = {}) {
    const j = janelaVendas(dias, janela);
    const { linhas, impostoPct, erroLeitura, pendentes } = await linhasDePedidos(j.de, j.ate, opcoes);
    const semCusto = new Map();
    for (const l of linhas) {
      if (!l.valida || l.custo_unit != null || !l.sku) continue;
      const s = semCusto.get(l.sku) || { item_id: l.sku, titulo: l.titulo, sku: l.sku, faltando: l.faltando, vendas: 0 };
      s.vendas++; semCusto.set(l.sku, s);
    }
    return { dias, de: j.de, ate: j.ate, imposto_pct: impostoPct, itens_pendentes: pendentes, erro_leitura: erroLeitura,
      estimadas: linhas.filter((l) => l.valida && l.estimado).length,
      resumo: somaLinhas(linhas), sem_custo: [...semCusto.values()].sort((a, b) => b.vendas - a.vendas), vendas: linhas };
  }

  // Tela Performance: período contra o anterior, como painel.js#performance (sem visitas:
  // a Amazon só dá sessões por relatório).
  const intervalo = (dias, fimMs = Date.now()) => {
    const hojeLocal = new Date(fimMs - 3 * 3600e3).toISOString().slice(0, 10);
    const fim = new Date(Date.parse(hojeLocal + 'T03:00:00Z') + 864e5);
    return { de: new Date(fim.getTime() - dias * 864e5).toISOString(), ate: fim.toISOString() };
  };
  const diaLocal = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
  async function performanceAmazon(dias) {
    const atual = intervalo(dias);
    const antes = intervalo(dias, Date.parse(atual.de) - 1 + 3 * 3600e3);
    const { linhas } = await linhasDePedidos(antes.de, atual.ate);
    const la = linhas.filter((l) => l.data >= atual.de), lb = linhas.filter((l) => l.data < atual.de);
    const tot = (ls) => { const s = somaLinhas(ls);
      return { faturamento: s.faturamento, pedidos: s.pedidos, unidades: s.unidades, tarifas: s.tarifa,
        ticket: s.pedidos ? s.faturamento / s.pedidos : 0, visitas: null, conversao: null, cancelados: new Set(ls.filter((l) => !l.valida).map((l) => l.pedido)).size }; };
    const porSku = (ls) => { const m = new Map(); for (const l of ls) { if (!l.valida || !l.sku) continue;
      const x = m.get(l.sku) || { fat: 0, un: 0, titulo: l.titulo, foto: l.foto }; x.fat += l.faturamento; x.un += l.quantidade; m.set(l.sku, x); } return m; };
    const pa = porSku(la), pb = porSku(lb);
    const mov = [...new Set([...pa.keys(), ...pb.keys()])].map((id) => ({ id, atual: r2(pa.get(id)?.fat || 0), antes: r2(pb.get(id)?.fat || 0),
      unidades: pa.get(id)?.un || 0, unidades_antes: pb.get(id)?.un || 0, titulo: (pa.get(id) || pb.get(id)).titulo, foto: (pa.get(id) || pb.get(id)).foto }))
      .map((x) => ({ ...x, delta: r2(x.atual - x.antes) }));
    const porDia = (ls) => { const m = {}; for (const l of ls) { if (!l.valida) continue; const d = diaLocal(l.data);
      const x = m[d] || (m[d] = { faturamento: 0, pedidos: new Set() }); x.faturamento += l.faturamento; x.pedidos.add(l.pedido); } return m; };
    const da = porDia(la), db = porDia(lb);
    const A = require('./public/analise.js');
    const serie = A.diasDaJanela(dias).map((dia, i) => {
      const diaAntes = new Date(Date.parse(dia) - dias * 864e5).toISOString().slice(0, 10);
      return { dia, faturamento: r2(da[dia]?.faturamento || 0), pedidos: da[dia]?.pedidos.size || 0, anterior: r2(db[diaAntes]?.faturamento || 0) };
    });
    return { dias, atual: tot(la), anterior: tot(lb), serie,
      sobe: mov.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10),
      cai: mov.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10) };
  }

  // Performance por envio: FBA (a Amazon envia) e envio próprio.
  async function logisticaAmazon(dias) {
    const j = intervalo(dias);
    const { linhas, pendentes } = await linhasDePedidos(j.de, j.ate);
    const NOMES = { fba: 'FBA (a Amazon envia)', proprio: 'Envio próprio' };
    const m = { fba: { pedidos: new Set(), unidades: 0, faturamento: 0 }, proprio: { pedidos: new Set(), unidades: 0, faturamento: 0 } };
    for (const l of linhas) { if (!l.valida) continue; const x = m[l.canal === 'FBA' ? 'fba' : 'proprio'];
      x.pedidos.add(l.pedido); x.unidades += l.quantidade; x.faturamento += l.faturamento; }
    const total = m.fba.faturamento + m.proprio.faturamento;
    const canais = Object.entries(m).map(([k, x]) => ({ canal: k, nome: NOMES[k], pedidos: x.pedidos.size, unidades: x.unidades,
      faturamento: r2(x.faturamento), ticket: x.pedidos.size ? r2(x.faturamento / x.pedidos.size) : null, participacao: total > 0 ? x.faturamento / total : 0 }));
    return { dias, de: j.de, ate: j.ate, canais, envios_pendentes: pendentes,
      total: { pedidos: canais.reduce((s, c) => s + c.pedidos, 0), faturamento: r2(total) } };
  }

  // Análise ABC por SKU (o "anúncio" da Amazon), como painel.js#abc. Sem venda: produtos com
  // estoque no FBA que não venderam no período.
  async function abcAmazon(dias) {
    const j = janela(dias);
    const { linhas } = await linhasDePedidos(j.de, j.ate);
    const A = require('./public/analise.js');
    const m = new Map();
    for (const l of linhas) {
      if (!l.valida || !l.sku) continue;
      const x = m.get(l.sku) || { id: l.sku, titulo: l.titulo, foto: l.foto, faturamento: 0, unidades: 0, pedidos: new Set(), lucro: 0, sem_lucro: false, falta: new Set() };
      x.faturamento += l.faturamento; x.unidades += l.quantidade; x.pedidos.add(l.pedido);
      if (l.lucro == null) { x.sem_lucro = true; for (const f of l.falta) x.falta.add(f); } else x.lucro += l.lucro;
      m.set(l.sku, x);
    }
    const itens = [...m.values()];
    const curva = A.curvaABC(Object.fromEntries(itens.map((x) => [x.id, x.faturamento])));
    const total = itens.reduce((s, x) => s + x.faturamento, 0);
    let acum = 0;
    const ls = itens.filter((x) => curva[x.id]).sort((a, b) => curva[a.id].ranking - curva[b.id].ranking).map((x) => {
      acum += x.faturamento;
      const lucro = x.sem_lucro ? null : r2(x.lucro);
      return { id: x.id, classe: curva[x.id].classe, ranking: curva[x.id].ranking, faturamento: r2(x.faturamento),
        participacao: curva[x.id].participacao, acumulado: total ? acum / total : 0, unidades: x.unidades, pedidos: x.pedidos.size,
        lucro, margem: lucro != null && x.faturamento > 0 ? lucro / x.faturamento : null, falta: [...x.falta],
        titulo: x.titulo, foto: x.foto, estoque: null, status: 'active' };
    });
    // estoque FBA: quantidade de cada SKU e quem tem estoque sem ter vendido
    let semVenda = [], ativos = 0;
    try {
      const est = [];
      let params = { granularityType: 'Marketplace', granularityId: BR, marketplaceIds: BR, details: 'true' };
      for (let p = 0; p < 20; p++) {
        const r = await sp('/fba/inventory/v1/summaries', params);
        est.push(...(r.payload?.inventorySummaries || []));
        const prox = r.pagination?.nextToken;
        if (!prox) break;
        params = { ...params, nextToken: prox };
        await new Promise((ok) => setTimeout(ok, 600));
      }
      const porSku = new Map(est.map((e) => [e.sellerSku, e]));
      for (const l of ls) l.estoque = porSku.get(l.id)?.inventoryDetails?.fulfillableQuantity ?? null;
      const fotos = D.amazonFotos();
      const comEstoque = est.filter((e) => (e.inventoryDetails?.fulfillableQuantity || 0) > 0);
      ativos = comEstoque.length;
      const venderam = new Set(ls.map((l) => l.id));
      const ultimas = new Map();
      for (const v of D.amazonVendasPeriodo('2000', '9999')) if (v.sku && v.status !== 'Canceled' && !ultimas.has(v.sku)) ultimas.set(v.sku, v.data);
      semVenda = comEstoque.filter((e) => !venderam.has(e.sellerSku)).map((e) => ({ id: e.sellerSku, titulo: e.productName || e.sellerSku,
        foto: fotos.get(e.sellerSku)?.foto || null, link: e.asin ? `https://www.amazon.com.br/dp/${e.asin}` : null, preco: null,
        estoque: e.inventoryDetails?.fulfillableQuantity ?? null, vendidos_total: ultimas.has(e.sellerSku) ? 1 : 0, criado_em: null,
        ultima_venda: ultimas.get(e.sellerSku) || null }))
        .sort((a, b) => String(b.ultima_venda).localeCompare(String(a.ultima_venda)));
    } catch { /* sem estoque FBA: a curva sai igual */ }
    const classes = ['A', 'B', 'C'].map((k) => {
      const x = ls.filter((l) => l.classe === k);
      const f = x.reduce((s, l) => s + l.faturamento, 0);
      return { classe: k, anuncios: x.length, faturamento: r2(f), participacao: total ? f / total : 0,
        lucro: r2(x.reduce((s, l) => s + (l.lucro || 0), 0)), sem_lucro: x.filter((l) => l.lucro == null).length };
    });
    return { dias, de: j.primeiro, ate: j.ultimo, total: r2(total), classes, linhas: ls,
      sem_venda: { total: semVenda.length, ativos, ja_venderam: semVenda.filter((x) => x.vendidos_total > 0).length,
        nunca: semVenda.filter((x) => !x.vendidos_total).length, itens: semVenda } };
  }

  // Estoque do FBA, todas as páginas (o "Full" da Amazon).
  async function estoqueFba() {
    const est = [];
    let params = { granularityType: 'Marketplace', granularityId: BR, marketplaceIds: BR, details: 'true' };
    for (let p = 0; p < 50; p++) {
      const r = await sp('/fba/inventory/v1/summaries', params);
      est.push(...(r.payload?.inventorySummaries || []));
      const prox = r.pagination?.nextToken;
      if (!prox) break;
      params = { ...params, nextToken: prox };
      await new Promise((ok) => setTimeout(ok, 600));
    }
    return est;
  }

  // Tela Full com a Amazon: o mesmo formato de painel.js#full, por SKU. "No depósito" vira
  // "a caminho do FBA" (enviado, sendo recebido ou em preparo).
  let cacheFullAmz = null;
  async function fullAmazon(recarregar) {
    if (!recarregar && cacheFullAmz && Date.now() - cacheFullAmz.em < 10 * 60e3) return cacheFullAmz.dados;
    try { await sincronizarPedidos(); } catch { /* segue com o que já tem */ }
    lerItens().catch(() => null);
    const est = await estoqueFba();
    const desde = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const vendas = (d) => {
      const m = new Map();
      for (const r of D.amazonUnidadesPorSku(desde(d))) {
        const x = m.get(r.sku) || { fba: 0, proprio: 0, fat_fba: 0, ped_fba: 0, fat: 0, ped: 0 };
        if (r.canal === 'FBA') { x.fba += r.u; x.fat_fba += r.f; x.ped_fba += r.p; } else x.proprio += r.u;
        x.fat += r.f; x.ped += r.p;
        m.set(r.sku, x);
      }
      return m;
    };
    const v30 = vendas(30), v60 = vendas(60), v90 = vendas(90);
    const fotos = D.amazonFotos();
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const trocasFba = D.skuTrocas('amazon');
    const nomeSku = (sku) => C.custoDoSku(C.skuNaData(trocasFba, sku), mapa).componentes.map((x) => x.nome).filter(Boolean).join(' + ') || null;
    const semFoto = new Map();
    const itens = est.filter((e) => e.sellerSku).map((e) => {
      const d = e.inventoryDetails || {};
      const caminho = (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0);
      const disp = d.fulfillableQuantity ?? e.totalQuantity ?? 0;
      const s = e.sellerSku;
      if (!fotos.get(s)?.foto && e.asin) semFoto.set(s, e.asin);
      const media = (v30.get(s)?.fba || 0) / 30;
      return { id: s, titulo: nomeSku(s) || e.productName || s, foto: fotos.get(s)?.foto || null,
        link: e.asin ? `https://www.amazon.com.br/dp/${e.asin}` : null, preco: null, status: 'active',
        estoque_full: disp, estoque_deposito: caminho,
        reservado: d.reservedQuantity?.totalReservedQuantity || 0, avariado: d.unfulfillableQuantity?.totalUnfulfillableQuantity || 0,
        vendas_full_30: v30.get(s)?.fba || 0, vendas_full_60: v60.get(s)?.fba || 0, vendas_full_90: v90.get(s)?.fba || 0,
        vendas_deposito_30: v30.get(s)?.proprio || 0, faturamento_full_30: r2(v30.get(s)?.fat_fba || 0),
        media_dia: media, dias_estoque: media > 0 ? Math.floor(disp / media) : null };
    }).sort((a, b) => (b.vendas_full_30 - a.vendas_full_30) || (b.estoque_full - a.estoque_full));
    if (semFoto.size) buscarFotosPorAsin(semFoto).catch(() => null);
    const t = [...v30.values()].reduce((s, x) => ({ u: s.u + x.fba, f: s.f + x.fat_fba, p: s.p + x.ped_fba, tf: s.tf + x.fat }), { u: 0, f: 0, p: 0, tf: 0 });
    const dados = {
      amazon: true, itens, total_anuncios: itens.length, dias_base_media: 30, primeira_venda_full: null,
      com_estoque: itens.filter((i) => i.estoque_full > 0).length,
      unidades_full: itens.reduce((s, i) => s + (i.estoque_full || 0), 0),
      unidades_caminho: itens.reduce((s, i) => s + (i.estoque_deposito || 0), 0),
      acabando: itens.filter((i) => i.dias_estoque != null && i.dias_estoque < 15).length,
      itens_pendentes: D.amazonPedidosSemItens(100000).length,
      vendas_30: { full_unidades: t.u, full_faturamento: r2(t.f), full_pedidos: t.p, total_faturamento: r2(t.tf), participacao: t.tf ? t.f / t.tf : 0 },
      em: new Date().toISOString(),
    };
    cacheFullAmz = { em: Date.now(), dados };
    return dados;
  }

  // ---------- anúncios (Listings API) e troca de preço ----------
  // A Listings API pede o ID do vendedor. Ele vem em toda transação financeira
  // (sellingPartnerMetadata.sellingPartnerId, visto no diagnóstico de 01/10/2026); fica guardado.
  async function idVendedor() {
    const guardado = D.configLer('amazon_seller_id');
    if (guardado) return guardado;
    const r = await sp('/finances/2024-06-19/transactions', { postedAfter: new Date(Date.now() - 60 * 86400e3).toISOString(), marketplaceId: BR });
    const id = (r.payload?.transactions || []).map((t) => t.sellingPartnerMetadata?.sellingPartnerId).find(Boolean);
    if (!id) throw erro('Não consegui descobrir o ID de vendedor da Amazon (nenhuma transação nos últimos 60 dias).', 502);
    D.configGravar('amazon_seller_id', id);
    return id;
  }

  // Anúncios da conta (searchListingsItems): preço da oferta ao consumidor, estoque, situação,
  // vendas de 30 dias e o que é preciso para a tela estimar a margem num preço novo.
  let cacheAnuncios = null;
  async function anunciosAmazon(recarregar) {
    if (!recarregar && cacheAnuncios && Date.now() - cacheAnuncios.em < 10 * 60e3) return cacheAnuncios.dados;
    const vendedor = await idVendedor();
    const lista = [];
    let params = { marketplaceIds: BR, includedData: 'summaries,offers,fulfillmentAvailability,attributes', pageSize: 20 };
    for (let p = 0; p < 200; p++) {
      const r = await sp(`/listings/2021-08-01/items/${encodeURIComponent(vendedor)}`, params);
      lista.push(...(r.items || []));
      const prox = r.pagination?.nextToken;
      if (!prox) break;
      params = { ...params, pageToken: prox };
      await new Promise((ok) => setTimeout(ok, 250));
    }
    const { empresa } = empresaAmazon();
    const impostoPct = C.impostoTotal(empresa);
    const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const taxas = taxasDosLancamentos(D.amazonLancPeriodo(new Date(Date.now() - 92 * 86400e3).toISOString(), '9999'));
    const v30 = new Map();
    for (const r of D.amazonUnidadesPorSku(new Date(Date.now() - 30 * 864e5).toISOString())) {
      const x = v30.get(r.sku) || { u: 0, f: 0 }; x.u += r.u; x.f += r.f; v30.set(r.sku, x);
    }
    const fotos = D.amazonFotos();
    const trocasAnuncios = D.skuTrocas('amazon');
    const itens = lista.map((it) => {
      const s = (it.summaries || []).find((x) => x.marketplaceId === BR) || it.summaries?.[0] || {};
      const oferta = (it.offers || []).find((o) => o.marketplaceId === BR && (o.offerType || 'B2C') === 'B2C') || it.offers?.[0];
      const disp = (it.fulfillmentAvailability || []);
      const fba = disp.some((d) => d.fulfillmentChannelCode && d.fulfillmentChannelCode !== 'DEFAULT');
      const estoque = disp.reduce((a, d) => a + (Number(d.quantity) || 0), 0);
      const skuPainel = C.skuNaData(trocasAnuncios, it.sku);
      const cs = C.custoDoSku(skuPainel, mapa);
      const po = (it.attributes?.purchasable_offer || []).find((o) => o.marketplace_id === BR && (!o.audience || o.audience === 'ALL'));
      const dp = po?.discounted_price?.[0]?.schedule?.[0];
      const desconto = dp?.value_with_tax != null ? { preco: Number(dp.value_with_tax), inicio: dp.start_at || null, fim: dp.end_at || null } : null;
      const cheio = po?.our_price?.[0]?.schedule?.[0]?.value_with_tax != null ? Number(po.our_price[0].schedule[0].value_with_tax) : null;
      const m = taxas.mediaSku(it.sku, fba ? 'FBA' : 'proprio') || taxas.mediaCanal(fba ? 'FBA' : 'proprio');
      return { sku: it.sku, sku_painel: skuPainel !== it.sku ? skuPainel : null, asin: s.asin || null, titulo: cs.componentes.map((x) => x.nome).filter(Boolean).join(' + ') || s.itemName || it.sku,
        nome_amazon: s.itemName || null, foto: s.mainImage?.link || fotos.get(it.sku)?.foto || null, status: s.status || [],
        tipo_produto: s.productType || null, preco: oferta?.price?.amount != null ? Number(oferta.price.amount) : null, cheio, desconto,
        estoque: disp.length ? estoque : null, canal: fba ? 'FBA' : 'proprio',
        vendas_30: v30.get(it.sku)?.u || 0, faturamento_30: r2(v30.get(it.sku)?.f || 0),
        custo_unit: cs.custo, tarifa_pct: m?.tarifa_pct ?? null, fixa_un: m?.fixa_un ?? null, frete_un: m?.frete_un ?? null, armazem_un: m?.armazem_un ?? 0,
        embalagem_unit: fba ? 0 : (empresa.embalagem_padrao || 0), link: s.asin ? `https://www.amazon.com.br/dp/${s.asin}` : null };
    }).sort((a, b) => (b.vendas_30 - a.vendas_30) || String(a.titulo).localeCompare(String(b.titulo)));
    const dados = { itens, imposto_pct: impostoPct, em: new Date().toISOString() };
    cacheAnuncios = { em: Date.now(), dados };
    return dados;
  }

  // Troca o preço de venda (our_price) de um SKU. Lê o purchasable_offer atual e muda só o
  // preço da oferta para o consumidor (sem audience ou "ALL"): preço mínimo/máximo e a
  // oferta para empresas continuam como estão. A Amazon aceita e aplica em alguns minutos.
  async function trocarPreco(sku, preco) {
    const v = Number(String(preco).replace(',', '.'));
    if (!Number.isFinite(v) || v <= 0 || v > 100000) throw erro('Preço inválido.');
    const novo = Math.round(v * 100) / 100;
    const r = await mudarOferta(sku, (o) => ({ ...o, our_price: [{ schedule: [{ value_with_tax: novo }] }] }),
      { marketplace_id: BR, currency: 'BRL', our_price: [{ schedule: [{ value_with_tax: novo }] }] });
    return { sku, preco: novo, ...r };
  }
  // Muda a oferta ao consumidor de um SKU (lida na hora): mudar(oferta) devolve a nova; sem oferta
  // ao consumidor, usa `nova` (ou recusa, se null). Mínimo/máximo e a oferta B2B ficam como estão.
  async function mudarOferta(sku, mudar, nova = null) {
    const vendedor = await idVendedor();
    const caminho = `/listings/2021-08-01/items/${encodeURIComponent(vendedor)}/${encodeURIComponent(sku)}`;
    const atual = await sp(caminho, { marketplaceIds: BR, includedData: 'summaries,attributes' });
    const tipo = (atual.summaries || []).find((x) => x.marketplaceId === BR)?.productType || atual.summaries?.[0]?.productType;
    if (!tipo) throw erro('A Amazon não informou o tipo de produto deste SKU.', 502);
    const ofertas = atual.attributes?.purchasable_offer || [];
    const ehConsumidor = (o) => !o.audience || o.audience === 'ALL';
    let mudou = false;
    const valor = ofertas.map((o) => {
      if (o.marketplace_id !== BR || !ehConsumidor(o) || mudou) return o;
      mudou = true;
      return mudar(o);
    });
    if (!mudou) { if (!nova) throw erro(`${sku}: a Amazon não tem oferta ao consumidor para este SKU.`, 409); valor.push(nova); }
    const r = await spEscrever('PATCH', caminho, { marketplaceIds: BR }, {
      productType: tipo, patches: [{ op: 'replace', path: '/attributes/purchasable_offer', value: valor }] });
    cacheAnuncios = null;
    const problemas = (r.issues || []).filter((i) => i.severity === 'ERROR');
    if (r.status !== 'ACCEPTED' || problemas.length) {
      throw erro('A Amazon recusou: ' + ((problemas[0] || r.issues?.[0])?.message || r.status || 'sem detalhe'), 422);
    }
    return { status: r.status, envio: r.submissionId || null, avisos: (r.issues || []).map((i) => i.message).slice(0, 5) };
  }

  // Concorrentes de um ASIN (Product Pricing API, getItemOffers): até 20 ofertas novas, com
  // preço, frete, FBA, oferta em destaque (Buy Box) e avaliação. A Amazon não dá o nome do
  // vendedor, só o código; o nosso é reconhecido pelo ID do vendedor. Cache de 10 min (a
  // Amazon deixa 1 consulta a cada 2 s).
  const cacheOfertas = new Map();
  async function concorrentes(asin) {
    const c = cacheOfertas.get(asin);
    if (c && Date.now() - c.em < 10 * 60e3) return c.dados;
    const eu = await idVendedor().catch(() => null);
    const r = await sp(`/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`, { MarketplaceId: BR, ItemCondition: 'New' });
    const dados = ofertasDe(r.payload, eu);
    D.amazonConcGravar(asin, dados);
    // Venda de cada concorrente a Amazon não informa. O que ela dá é o ranking de mais vendidos
    // do produto (todos os vendedores juntos): quanto menor o número, mais vende.
    try {
      const cat = await sp(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { marketplaceIds: BR, includedData: 'salesRanks' });
      const sr = (cat.salesRanks || []).find((s) => s.marketplaceId === BR) || cat.salesRanks?.[0] || {};
      dados.ranking = [...(sr.displayGroupRanks || []), ...(sr.classificationRanks || [])]
        .map((x) => ({ titulo: x.title || null, posicao: x.rank ?? null })).filter((x) => x.posicao != null);
    } catch { dados.ranking = []; }
    cacheOfertas.set(asin, { em: Date.now(), dados });
    return dados;
  }

  // Concorrência de todos os anúncios, em segundo plano: getItemOffersBatch, 20 ASINs por
  // chamada e 1 chamada a cada 10 s (limite da Amazon). Relê o que tem mais de 6 h.
  let varrendo = false;
  async function varrerConcorrencia(asins) {
    if (varrendo) return;
    varrendo = true;
    try {
      const eu = await idVendedor().catch(() => null);
      for (let i = 0; i < asins.length; i += 20) {
        const lote = asins.slice(i, i + 20);
        try {
          const r = await sp('/batches/products/pricing/v0/itemOffers', {}, { metodo: 'POST', corpo: { requests: lote.map((a) => ({
            uri: `/products/pricing/v0/items/${a}/offers`, method: 'GET', MarketplaceId: BR, ItemCondition: 'New' })) } });
          (r.responses || []).forEach((x, k) => {
            const p = x.body?.payload;
            const asin = p?.ASIN || x.request?.Asin || lote[k];
            if (p && (x.status?.statusCode ?? 200) < 300) D.amazonConcGravar(asin, ofertasDe(p, eu));
          });
        } catch (e) { if (e.status === 429) await new Promise((ok) => setTimeout(ok, 30000)); }
        await new Promise((ok) => setTimeout(ok, 10500));
      }
    } finally { varrendo = false; }
  }
  const concDesatualizada = (c) => !c || Date.now() - Date.parse(c.lido_em) > 6 * 3600e3;

  Object.assign(rotas, {
    'GET /api/amazon/concorrentes': async (url) => {
      const asin = String(url.searchParams.get('asin') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) throw erro('ASIN inválido.');
      const d = await concorrentes(asin);
      const nomes = D.amazonVendedoresNomes();
      const comNome = (o) => (o ? { ...o, vendedor_nome: nomes.get(o.vendedor_id) || null,
        loja: o.vendedor_id ? `https://www.amazon.com.br/sp?seller=${encodeURIComponent(o.vendedor_id)}` : null } : o);
      return { ...d, ofertas: d.ofertas.map(comNome), destaque: comNome(d.destaque), menor_outro: comNome(d.menor_outro) };
    },
    // Nome de um vendedor concorrente, digitado na tela (vazio apaga).
    'PUT /api/amazon/vendedores': async (_u, body) => {
      const id = String(body?.id || '').trim();
      if (!/^[A-Z0-9]{8,20}$/.test(id)) throw erro('Código de vendedor inválido.');
      const nome = String(body?.nome || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      D.amazonVendedorNomear(id, nome || null);
      return { id, nome: nome || null };
    },
    // A concorrência de cada anúncio vem da cópia local; o que falta ou passou de 6 h é lido
    // em segundo plano (a tela mostra quantos faltam e pede de novo).
    'GET /api/amazon/anuncios': async (url) => {
      const d = await anunciosAmazon(!!url.searchParams.get('recarregar'));
      const conc = D.amazonConcorrencia();
      const faltam = [...new Set(d.itens.map((i) => i.asin).filter((a) => a && concDesatualizada(conc.get(a))))];
      if (faltam.length) varrerConcorrencia(faltam).catch(() => null);
      return { ...d, conc_pendentes: faltam.length, itens: d.itens.map((i) => {
        const c = i.asin ? conc.get(i.asin) : null;
        return { ...i, conc: c ? { outros: c.outros, menor_outro: c.menor_outro, destaque: c.destaque, voce_destaque: !!c.voce_destaque } : null };
      }) };
    },
    // Campanhas (tela campanhas-canais.html?conta=amazon): o preço promocional de cada anúncio
    // (discounted_price, com início e fim) com o resultado, e as promoções que apareceram nas vendas
    // (PromotionList do financeiro) com o resultado de cada uma. Nunca pelo MCP.
    'GET /api/amazon/campanhas': async (url) => {
      const d = await anunciosAmazon(url.searchParams.get('recarregar') === '1');
      const agora = Date.now();
      const de = new Date(agora - 152 * 864e5).toISOString();
      const r = await linhasDePedidos(de, new Date(agora + 60e3).toISOString());
      const promos = new Map();
      for (const l of D.amazonLancPeriodo(new Date(agora - 200 * 864e5).toISOString(), '9999')) {
        if (l.tipo !== 'venda' || !l.promocoes || !l.pedido) continue;
        const k = `${l.pedido}|${l.sku}`;
        promos.set(k, [...(promos.get(k) || []), ...JSON.parse(l.promocoes).map((p) => ({ ...p, nome: p.id || 'Promoção sem identificação' }))]);
      }
      const linhas = r.linhas.map((l) => ({ ...l, valida: l.valida ?? !['Canceled', 'cancelled'].includes(l.status), promocoes: promos.get(`${l.pedido}|${l.sku}`) || [] }));
      return {
        canal: 'amazon', imposto_pct: r.impostoPct, erro_leitura: r.erroLeitura,
        anuncios: d.itens.map((i) => {
          const sit = i.desconto ? CC.situacao(i.desconto.inicio, i.desconto.fim, agora) : null;
          return { sku: i.sku, titulo: i.titulo, foto: i.foto, ativa: (i.status || []).includes('BUYABLE'), estoque: i.estoque,
            cheio: i.cheio ?? i.preco, desconto: i.desconto, complexo: false, vendas_90: null, vendas_30: i.vendas_30, situacao: sit, canal: i.canal,
            resultado: i.desconto && sit !== 'agendado' ? CC.resultadoDesconto(linhas, i.sku, i.desconto.inicio, i.desconto.fim, agora) : null };
        }),
        promocoes: CC.resultadoPromocoes(linhas), promocoes_loja: null,
      };
    },
    // Preço promocional com início e fim nos SKUs escolhidos (um PATCH por SKU).
    'POST /api/amazon/campanhas/desconto': async (_u, body) => {
      const d = await anunciosAmazon(true);
      const v = CC.validarDesconto(body, new Map(d.itens.filter((i) => (i.cheio ?? i.preco) != null).map((i) => [i.sku, i.cheio ?? i.preco])));
      const resultados = [];
      for (const it of v.itens) {
        const sched = { start_at: v.inicio, end_at: v.fim, value_with_tax: it.preco };
        try {
          const r = await mudarOferta(it.sku, (o) => ({ ...o, discounted_price: [{ schedule: [sched] }] }));
          resultados.push({ sku: it.sku, ok: true, ...r });
        } catch (e) { resultados.push({ sku: it.sku, ok: false, erro: e.message }); }
        await new Promise((ok) => setTimeout(ok, 250));
      }
      cacheAnuncios = null;
      return { resultados, ok: resultados.filter((x) => x.ok).length, com_erro: resultados.filter((x) => !x.ok).length };
    },
    // Tira o preço promocional (o preço cheio continua).
    'POST /api/amazon/campanhas/encerrar': async (_u, body) => {
      const skus = [...new Set((Array.isArray(body?.skus) ? body.skus : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
      if (!skus.length || skus.length > 200) throw erro('Escolha de 1 a 200 anúncios.');
      const resultados = [];
      for (const sku of skus) {
        try {
          const r = await mudarOferta(sku, (o) => { const { discounted_price, ...resto } = o; return resto; });
          resultados.push({ sku, ok: true, ...r });
        } catch (e) { resultados.push({ sku, ok: false, erro: e.message }); }
        await new Promise((ok) => setTimeout(ok, 250));
      }
      cacheAnuncios = null;
      return { resultados, ok: resultados.filter((x) => x.ok).length, com_erro: resultados.filter((x) => !x.ok).length };
    },
    // Muda o preço na Amazon (escrita na conta: só pela tela, com confirmação; nunca pelo MCP).
    'POST /api/amazon/anuncios/preco': async (_u, body) => {
      const sku = String(body?.sku ?? '').trim();
      if (!sku || sku.length > 60) throw erro('Informe o SKU.');
      return trocarPreco(sku, body?.preco);
    },
  });

  Object.assign(rotas, {
    'GET /api/amazon/full': async (url) => fullAmazon(!!url.searchParams.get('recarregar')),
  });

  Object.assign(rotas, {
    // Pedidos / Vendas Hoje, Performance e ABC da Amazon: mesmas respostas das telas do ML.
    // Nunca expostas ao MCP.
    'GET /api/amazon/pedidos': async (url) => {
      const d = Number(url.searchParams.get('dias'));
      return pedidosAmazon([1, 7, 15, 30, 60, 90].includes(d) ? d : 30, { recarregar: url.searchParams.get('recarregar') === '1' });
    },
    'GET /api/amazon/performance': async (url) => performanceAmazon([7, 15, 30, 60, 75].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30),
    'GET /api/amazon/performance/logistica': async (url) => logisticaAmazon([7, 15, 30, 60, 75].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30),
    'GET /api/amazon/abc': async (url) => abcAmazon([15, 30, 60, 90, 150].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30),
  });

  Object.assign(rotas, {
    // Vendas e lucro do período (tela Amazon e a linha da Amazon em "Todas as contas").
    // Nunca exposta ao MCP: dados da Amazon não vão a terceiros.
    'GET /api/amazon/vendas': async (url) => {
      const mes = url.searchParams.get('mes');
      const dias = mes === 'atual' || mes === 'anterior' ? janelaDoMes(mes) : Math.min(90, Math.max(1, Number(url.searchParams.get('dias')) || 30));
      const r = await vendasAmazon(dias, { recarregar: url.searchParams.get('recarregar') === '1',
        lancamentos: url.searchParams.get('lancamentos') === '1' });
      return r || { conectada: false };
    },
  });

  return { rotas, rotasParam: [], sp, idVendedor, sincronizar, sincronizarPedidos, lerItens, anuncios: anunciosAmazon };
}

module.exports = { criar, validarConfig, semPessoais, forma, vocabulario, listasCheias, lancamentosDe, servicosDe, comEtiquetas, contaDoLancamento, resumoAmazon,
  pedidoDe, itemDe, janelaVendas, taxasDosLancamentos, linhaDoPedido, ofertasDe, BR, HOST };
