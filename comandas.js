'use strict';
// Comandas de separação (tela public/comandas.html): todos os envios que ainda vão sair, de todas
// as contas, separados por categoria e numerados por categoria e dia ("Flex 1", "Mercado Envios 3").
// Cada comanda sai numa impressora térmica de 80 mm, com o número do pedido, o tipo de envio e o
// nome do cliente em letra grande (as câmeras da expedição filmam os pacotes).
//
// Categorias (pedido do vendedor):
//   Flex           = ML Flex (logistic_type self_service) + Shopee "Entrega Direta" + Magalu VAPT
//   Mercado Envios = ML coleta/ponto (xd_drop_off, drop_off, cross_docking…; Full fica fora)
//   Magalu         = Magalu sem VAPT
//   Melhor Envios  = Leroy Merlin (o vendedor contrata o frete no Melhor Envio)
//   Shopee         = Shopee sem "Entrega Direta"
//   Amazon         = Amazon com envio do vendedor (MFN: DBA/Envios Fáceis ou próprio); FBA fica fora
//   Venda direta   = comanda MANUAL, digitada na tela, para venda fora dos marketplaces (Josi, balcão, OLX…):
//                    tira os produtos do estoque na hora (estoque.js) e fica na tela até ser concluída
// Pendentes (medido em 07/10/2026): ML /orders/search?shipping.status=ready_to_ship (+ /shipments/{id}
// para o tipo e o destinatário, /shipments/{id}/sla para o prazo de despacho); Shopee READY_TO_SHIP e
// PROCESSED (ship_by_date, shipping_carrier, recipient_address.name); Magalu entregas ainda não
// despachadas (handling_time.limit_date, provider shipping_type VAPT); Leroy OR11 SHIPPING
// (shipping_deadline); horário da compra (comprado_em): ML date_created, Shopee create_time, Magalu purchased_at,
// Leroy created_date, Amazon PurchaseDate; Amazon getOrders Unshipped/PartiallyShipped com FulfillmentChannels=MFN (LatestShipDate,
// EasyShipShipmentStatus) + orderItems. Do cliente só o NOME vai para a comanda — na Amazon nem ele (sem RDT:
// compromisso com a Amazon de não ler dado pessoal; o nome está na etiqueta dela). Nada disto vai para o MCP.
const C = require('./custos.js');
const r2 = (v) => Math.round(v * 100) / 100;
const CATEGORIAS = ['Flex', 'Mercado Envios', 'Magalu', 'Melhor Envios', 'Shopee', 'Amazon', 'Venda direta'];
const diaLocal = (ms = Date.now()) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

// Categoria e o nome do tipo de envio impresso. null = não entra (ex.: Full). Função pura: testada.
function categoriaDe(canal, tipo) {
  const t = String(tipo || '');
  if (canal === 'ml') {
    if (t === 'fulfillment') return null;
    if (t === 'self_service') return { categoria: 'Flex', envio: 'Flex' };
    return { categoria: 'Mercado Envios', envio: 'Mercado Envios' };
  }
  if (canal === 'shopee') return /entrega direta/i.test(t) ? { categoria: 'Flex', envio: 'Shopee Entrega Direta' } : { categoria: 'Shopee', envio: t || 'Shopee' };
  if (canal === 'magalu') return /vapt/i.test(t) ? { categoria: 'Flex', envio: 'Magalu VAPT' } : { categoria: 'Magalu', envio: 'Magalu Entregas' };
  if (canal === 'leroy') return { categoria: 'Melhor Envios', envio: 'Melhor Envios' };
  if (canal === 'amazon') {
    if (t === 'AFN') return null;   // FBA: sai do armazém da Amazon
    return /easyship/i.test(t) ? { categoria: 'Amazon', envio: 'Amazon DBA' } : { categoria: 'Amazon', envio: 'Amazon Envio Próprio' };
  }
  return null;
}

// Numera os envios novos: próximo número da categoria NO DIA (Flex 1, Flex 2…), pelo prazo e, no
// empate, pela ordem do pedido. existentes: [{categoria, dia, numero}]. Função pura: testada.
function numerar(novos, existentes, dia) {
  const prox = new Map();
  for (const e of existentes) if (e.dia === dia) prox.set(e.categoria, Math.max(prox.get(e.categoria) || 0, e.numero));
  const ordem = [...novos].sort((a, b) => String(a.prazo || '9').localeCompare(String(b.prazo || '9')) || String(a.pedido).localeCompare(String(b.pedido)));
  return ordem.map((x) => { const n = (prox.get(x.categoria) || 0) + 1; prox.set(x.categoria, n); return { ...x, dia, numero: n }; });
}

// Na fila, não impressa e numerada num dia anterior: entra na numeração de hoje (o envio não saiu ontem
// e vai ser impresso hoje). A já impressa mantém o número que está no papel. Função pura: testada.
const atrasadasDaFila = (fila, dia) => fila.filter((c) => !c.impressa_em && c.dia < dia);

// O ML deixa o envio em ready_to_ship até a transportadora marcar "shipped": entregue no ponto (dropped_off),
// coletado (picked_up) ou já no centro (in_hub) = já saiu daqui, sai da fila. Medido em 08/10/2026. Função pura: testada.
const SAIU_ML = new Set(['dropped_off', 'picked_up', 'in_hub', 'in_transit', 'out_for_delivery']);
const jaSaiuMl = (substatus) => SAIU_ML.has(String(substatus || ''));

// Prazo -> situação para a tela. Função pura: testada.
function situacaoPrazo(prazo, agora = Date.now()) {
  if (!prazo) return 'sem prazo';
  const d = diaLocal(Date.parse(prazo)), hoje = diaLocal(agora);
  if (d < hoje) return 'atrasado';
  if (d === hoje) return 'hoje';
  return d === diaLocal(agora + 864e5) ? 'amanhã' : 'depois';
}

function criar({ D, ml, daLoja, leroy, magalu, amazon, estoque }) {
  const passo = async (nome, fn, erros) => { try { return await fn(); } catch (e) { erros.push(`${nome}: ${e.message}`); return []; } };
  const lotes = async (lista, n, fn) => { const out = []; for (let i = 0; i < lista.length; i += n) out.push(...await Promise.all(lista.slice(i, i + n).map(fn))); return out; };

  // ---- Mercado Livre (todas as contas conectadas)
  const cacheEnvio = new Map();   // envio -> { tipo, cliente, prazo, em }
  async function envioMl(id, contaId) {
    const c = cacheEnvio.get(id);
    if (c && Date.now() - c.em < 30 * 60e3) return c;
    const s = await ml(`/shipments/${id}`, {}, contaId);
    let prazo = null;
    try { prazo = (await ml(`/shipments/${id}/sla`, {}, contaId))?.expected_date || null; } catch { /* sem prazo */ }
    const x = { tipo: s.logistic_type || null, cliente: s.receiver_address?.receiver_name || null, status: s.status, sub: s.substatus || null, prazo, em: Date.now() };
    cacheEnvio.set(id, x);
    return x;
  }
  // pacote com vários pedidos: a compra mais antiga
  const compraMaisAntiga = (pedidos) => { const t = pedidos.map((p) => Date.parse(p.date_created)).filter(Number.isFinite); return t.length ? new Date(Math.min(...t)).toISOString() : null; };
  async function pendentesMl() {
    const out = [];
    for (const conta of D.contasListar()) {
      const pedidos = [];
      for (let off = 0; off < 1000; off += 50) {
        const r = await ml(`/orders/search?seller=${conta.ml_user_id}&shipping.status=ready_to_ship&sort=date_asc&limit=50&offset=${off}`, {}, conta.ml_user_id);
        pedidos.push(...(r.results || []));
        if ((r.results || []).length < 50) break;
      }
      const porEnvio = new Map();
      for (const p of pedidos) {
        const id = p.shipping?.id; if (!id) continue;
        const x = porEnvio.get(id) || { pedidos: [], itens: [] };
        x.pedidos.push(p);
        for (const i of p.order_items || []) x.itens.push({ qtd: i.quantity, sku: i.item?.seller_sku || i.item?.seller_custom_field || null, titulo: i.item?.title || null,
          variacao: (i.item?.variation_attributes || []).map((a) => a.value_name).filter(Boolean).join(' / ') || null });
        porEnvio.set(id, x);
      }
      const envios = await lotes([...porEnvio.keys()], 5, async (id) => ({ id, s: await envioMl(id, conta.ml_user_id).catch(() => null) }));
      for (const { id, s } of envios) {
        if (!s || jaSaiuMl(s.sub)) continue;
        const cat = categoriaDe('ml', s.tipo);
        if (!cat) continue;
        const x = porEnvio.get(id);
        const p0 = x.pedidos[0];
        out.push({ chave: `ml:${id}`, canal: 'ml', loja: conta.nickname, pedido: String(p0.pack_id || p0.id),
          pedidos: x.pedidos.map((p) => String(p.id)), ...cat, cliente: s.cliente, prazo: s.prazo, itens: x.itens, etapa: s.sub,
          comprado_em: compraMaisAntiga(x.pedidos) });
      }
    }
    return out;
  }

  // ---- Shopee (cada loja)
  async function pendentesShopee() {
    const out = [];
    const agora = Math.floor(Date.now() / 1000);
    for (const l of D.shopeeLojasListar()) {
      const sns = [];
      for (const st of ['READY_TO_SHIP', 'PROCESSED']) {
        for (let t = agora - 30 * 86400; t < agora; t += 15 * 86400) {
          let cursor = '';
          for (let pag = 0; pag < 20; pag++) {
            const r = await daLoja(l.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: t, time_to: Math.min(t + 15 * 86400 - 1, agora),
              page_size: 100, cursor, order_status: st });
            sns.push(...(r.response?.order_list || []).map((o) => o.order_sn));
            if (!r.response?.more) break;
            cursor = r.response.next_cursor;
          }
        }
      }
      for (let i = 0; i < sns.length; i += 50) {
        const d = await daLoja(l.shop_id, '/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50),
          response_optional_fields: ['item_list', 'shipping_carrier', 'recipient_address', 'ship_by_date'] });
        for (const o of d.response?.order_list || []) {
          const cat = categoriaDe('shopee', o.shipping_carrier);
          if (!cat) continue;
          out.push({ chave: `shopee:${o.order_sn}`, canal: 'shopee', loja: l.nome || `Shopee ${l.shop_id}`, pedido: o.order_sn,
            ...cat, cliente: o.recipient_address?.name || null, prazo: o.ship_by_date ? new Date(o.ship_by_date * 1000).toISOString() : null,
            comprado_em: o.create_time ? new Date(o.create_time * 1000).toISOString() : null,
            itens: (o.item_list || []).map((i) => ({ qtd: i.model_quantity_purchased, sku: (i.model_sku || i.item_sku || '').trim() || null,
              titulo: i.item_name || null, variacao: i.model_name || null })), etapa: o.order_status });
        }
      }
    }
    return out;
  }

  // ---- Magalu
  const DESPACHADO = /^(shipped|delivered|finished|cancel+ed|returned)$/i;
  async function pendentesMagalu() {
    if (!magalu?.config()?.refresh) return [];
    const out = [];
    for (let off = 0; off < 1000; off += 50) {
      const r = await magalu.mg('/seller/v1/orders', { _limit: 50, _offset: off, purchased_at__gte: new Date(Date.now() - 30 * 864e5).toISOString(),
        purchased_at__lte: new Date().toISOString() }, { pessoais: true });
      for (const p of r.results || []) {
        if (DESPACHADO.test(p.status || '')) continue;
        for (const d of p.deliveries || []) {
          if (DESPACHADO.test(d.status || '') || d.shipping?.shipped_at) continue;
          const tipo = [d.shipping?.provider?.extras?.shipping_type, d.shipping?.logistic_network?.id].filter(Boolean).join(' ');
          const cat = categoriaDe('magalu', tipo);
          out.push({ chave: `magalu:${p.code}:${d.code || d.id}`, canal: 'magalu', loja: D.configLer('magalu_loja_nome') || 'Magalu', pedido: String(p.code),
            ...cat, cliente: p.customer?.name || null, prazo: d.shipping?.handling_time?.limit_date || null,
            comprado_em: p.purchased_at || p.created_at || null,
            itens: (d.items || []).map((i) => ({ qtd: i.quantity, sku: i.info?.sku != null ? String(i.info.sku) : null, titulo: i.info?.description || null, variacao: null })),
            etapa: d.status || p.status });
        }
      }
      if ((r.results || []).length < 50) break;
    }
    return out;
  }

  // ---- Leroy Merlin
  async function pendentesLeroy() {
    const c = leroy?.config();
    if (!c?.host || !c?.api_key) return [];
    const r = await leroy.mk(c, '/api/orders', { order_state_codes: 'SHIPPING', max: 100 }, { pessoais: true });
    return (r.orders || []).map((o) => ({ chave: `leroy:${o.order_id}`, canal: 'leroy', loja: D.configLer('leroy_loja_nome') || 'Leroy Merlin',
      pedido: o.order_id, ...categoriaDe('leroy'), cliente: [o.customer?.firstname, o.customer?.lastname].filter(Boolean).join(' ') || null,
      prazo: o.shipping_deadline || null, comprado_em: o.created_date || null, itens: (o.order_lines || []).map((l) => ({ qtd: l.quantity, sku: l.offer_sku || null, titulo: l.product_title || null, variacao: null })),
      etapa: o.order_state }));
  }

  // ---- Amazon (só envio do vendedor; itens de um pedido não mudam: guardados na memória)
  const itensAmazon = new Map();
  async function pendentesAmazon() {
    if (!D.configLer('amazon_refresh_token') || !amazon?.sp) return [];
    const pedidos = [];
    let params = { MarketplaceIds: 'A2Q3Y263D00KWC', OrderStatuses: 'Unshipped,PartiallyShipped', FulfillmentChannels: 'MFN',
      CreatedAfter: new Date(Date.now() - 30 * 864e5).toISOString(), MaxResultsPerPage: 100 };
    for (let pag = 0; pag < 10; pag++) {
      const r = await amazon.sp('/orders/v0/orders', params);
      pedidos.push(...(r.payload?.Orders || []));
      if (!r.payload?.NextToken) break;
      params = { MarketplaceIds: 'A2Q3Y263D00KWC', NextToken: r.payload.NextToken };
    }
    const out = [];
    for (const o of pedidos) {
      const cat = categoriaDe('amazon', o.FulfillmentChannel === 'AFN' ? 'AFN' : (o.EasyShipShipmentStatus ? 'easyship' : ''));
      if (!cat) continue;
      const id = o.AmazonOrderId;
      if (!itensAmazon.has(id)) {
        try { itensAmazon.set(id, ((await amazon.sp(`/orders/v0/orders/${encodeURIComponent(id)}/orderItems`)).payload?.OrderItems || [])
          .map((i) => ({ qtd: Number(i.QuantityOrdered) || 0, sku: i.SellerSKU || null, titulo: i.Title || null, variacao: null }))); } catch { /* tenta na próxima */ }
      }
      out.push({ chave: `amazon:${id}`, canal: 'amazon', loja: D.configLer('amazon_vendedor') || 'Amazon', pedido: id, ...cat, cliente: null,
        prazo: o.LatestShipDate || null, comprado_em: o.PurchaseDate || null, itens: itensAmazon.get(id) || [], etapa: o.OrderStatus });
    }
    return out;
  }

  let cache = null;
  async function pendentes(recarregar) {
    if (!recarregar && cache && cache.dia === diaLocal() && Date.now() - cache.em < 3 * 60e3) return cache;
    const erros = [];
    const [a, b, c, d, e] = await Promise.all([passo('Mercado Livre', pendentesMl, erros), passo('Shopee', pendentesShopee, erros),
      passo('Magalu', pendentesMagalu, erros), passo('Leroy', pendentesLeroy, erros), passo('Amazon', pendentesAmazon, erros)]);
    const lista = [...a, ...b, ...c, ...d, ...e];
    // troca de produto no SKU (trocas-sku.js): o envio pendente já mostra o SKU novo, em todos os canais
    const trocas = Object.fromEntries(['ml', 'shopee', 'amazon', 'leroy', 'magalu'].map((k) => [k, D.skuTrocas(k)]));
    const vincMg = D.skuVinculos('magalu');   // Magalu: o "SKU do painel" digitado no lugar do código da Magalu
    for (const x of lista) x.itens = (x.itens || []).map((i) => (i.sku
      ? { ...i, sku: C.skuNaData(trocas[x.canal], x.canal === 'magalu' ? (vincMg.get(i.sku) || i.sku) : i.sku) } : i));
    // numeração: o envio novo ganha o próximo número da categoria no dia de hoje; o que já tinha, mantém —
    // menos o que ficou de um dia anterior sem imprimir, que entra junto na numeração de hoje (pelo prazo)
    const dia = diaLocal();
    const conhecidos = D.comandasDe(lista.map((x) => x.chave));
    const novos = lista.filter((x) => !conhecidos.has(x.chave));
    const atrasadas = atrasadasDaFila(D.comandasListar([...conhecidos, ...D.comandasManuaisAbertas()]), dia);
    if (novos.length || atrasadas.length) {
      const velhas = new Set(atrasadas.map((c) => c.chave));
      const numeradas = numerar([...atrasadas, ...novos], D.comandasDoDia(dia), dia);
      D.comandasRenumerar(numeradas.filter((x) => velhas.has(x.chave)));
      D.comandasCriar(numeradas.filter((x) => !velhas.has(x.chave)));
    }
    D.comandasAtualizar(lista);
    cache = { em: Date.now(), dia, erros, chaves: lista.map((x) => x.chave) };
    return cache;
  }

  const rotas = {
    'GET /api/comandas': async (url) => {
      const p = await pendentes(url.searchParams.get('recarregar') === '1');
      const agora = Date.now();
      const comandas = D.comandasListar([...p.chaves, ...D.comandasManuaisAbertas()]).map((c) => ({ ...c, situacao_prazo: situacaoPrazo(c.prazo, agora),
        unidades: c.itens.reduce((s, i) => s + (Number(i.qtd) || 0), 0) }))
        .sort((x, y) => CATEGORIAS.indexOf(x.categoria) - CATEGORIAS.indexOf(y.categoria) || x.dia.localeCompare(y.dia) || x.numero - y.numero);
      return { em: new Date(p.em).toISOString(), erros: p.erros, categorias: CATEGORIAS, comandas };
    },
    // Histórico: comandas impressas num dia (Brasília) ou pelo número da venda — inclusive as que já saíram.
    'GET /api/comandas/historico': async (url) => {
      const q = url.searchParams;
      const pedido = String(q.get('pedido') || '').trim();
      let lista;
      if (pedido) {
        if (!/^[\w.-]{3,40}$/.test(pedido)) throw Object.assign(new Error('Número da venda inválido.'), { status: 400 });
        lista = D.comandasDoPedido(pedido);
      } else {
        const de = /^\d{4}-\d{2}-\d{2}$/.test(q.get('de') || '') ? q.get('de') : diaLocal();
        const ate = /^\d{4}-\d{2}-\d{2}$/.test(q.get('ate') || '') ? q.get('ate') : de;
        const ini = new Date(`${de}T03:00:00.000Z`).toISOString(), fim = new Date(Date.parse(`${ate}T03:00:00.000Z`) + 864e5).toISOString();
        lista = D.comandasImpressasEntre(ini, fim);
      }
      const pend = new Set(cache?.chaves || []);
      return { comandas: lista.map((c) => ({ ...c, unidades: (c.itens || []).reduce((s, i) => s + (Number(i.qtd) || 0), 0),
        pendente: pend.has(c.chave) || (c.canal === 'manual' && !c.concluida_em) })) };
    },
    // Marca como impressas (a tela chama depois de mandar para a impressora) ou volta para "não impressa".
    'POST /api/comandas/impressas': async (_u, body) => {
      const chaves = (Array.isArray(body?.chaves) ? body.chaves : []).map(String).filter((c) => /^(ml|shopee|magalu|leroy|amazon|manual):[\w:.-]{1,80}$/.test(c));
      if (!chaves.length || chaves.length > 500) throw Object.assign(new Error('Escolha de 1 a 500 comandas.'), { status: 400 });
      D.comandasImpressas(chaves, body?.impressa !== false);
      return { ok: chaves.length };
    },
    'GET /api/comandas/catalogo': async () => ({ produtos: estoque.catalogo().lista.filter((p) => p.sku).map((p) => ({ sku: p.sku, nome: p.nome })) }),
    // Comanda manual: venda fora dos marketplaces. Itens pelo SKU do produto (DQ-407) ou do kit (KIT-407.408).
    'POST /api/comandas/manual': async (_u, b) => {
      const cliente = String(b?.cliente || '').trim().slice(0, 80);
      const loja = String(b?.loja || '').trim().slice(0, 40);
      if (!cliente) throw Object.assign(new Error('Informe o nome do cliente.'), { status: 400 });
      if (!loja) throw Object.assign(new Error('Informe por onde foi a venda (ex.: Josi, Balcão, OLX).'), { status: 400 });
      const itens = (Array.isArray(b?.itens) ? b.itens : []).filter((i) => String(i?.codigo || '').trim());
      const cat = estoque.catalogo();
      estoque.expandir(itens, cat);   // confere os produtos antes de criar
      const chave = `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const dia = diaLocal();
      const nome = (cod) => { const ns = require('./estoque.js').numerosDoCodigo(cod, cat.porSku);
        return ns.map((n) => cat.porNumero.get(n)?.nome).filter(Boolean).join(' + ') || null; };
      const x = { chave, canal: 'manual', loja, pedido: String(b?.pedido || '').trim().slice(0, 30) || `VD-${dia.slice(2).replace(/-/g, '')}`,
        categoria: 'Venda direta', envio: String(b?.envio || '').trim().slice(0, 40) || 'Retirada', cliente,
        prazo: /^\d{4}-\d{2}-\d{2}$/.test(b?.prazo || '') ? `${b.prazo}T21:00:00.000Z` : null, comprado_em: new Date().toISOString(),
        itens: itens.map((i) => ({ qtd: Math.round(Number(i.qtd)), sku: String(i.codigo).trim().toUpperCase(), titulo: nome(i.codigo), variacao: null })),
        etapa: String(b?.obs || '').trim().slice(0, 120) || null };
      const [numerada] = numerar([x], D.comandasDoDia(dia), dia);
      if (b?.baixar_estoque !== false) estoque.lancarVendaManual(`comanda:${chave}`, itens, `Venda direta · ${loja}`, `Comanda ${numerada.numero} · ${x.pedido}`);
      D.comandasCriar([numerada]);
      return { chave, numero: numerada.numero, dia };
    },
    'POST /api/comandas/manual/concluir': async (_u, b) => {
      const chave = String(b?.chave || '');
      if (!/^manual:[a-z0-9]+$/.test(chave)) throw Object.assign(new Error('Comanda inválida.'), { status: 400 });
      D.comandaConcluir(chave, b?.concluida !== false);
      return { ok: true };
    },
    // Cancelar devolve os produtos ao estoque.
    'POST /api/comandas/manual/cancelar': async (_u, b) => {
      const chave = String(b?.chave || '');
      if (!/^manual:[a-z0-9]+$/.test(chave)) throw Object.assign(new Error('Comanda inválida.'), { status: 400 });
      const [c] = D.comandasListar([chave]);
      if (!c) throw Object.assign(new Error('Comanda não encontrada.'), { status: 404 });
      estoque.estornarRef(`comanda:${chave}`, `Venda direta · ${c.loja}`);
      D.comandaApagar(chave);
      return { ok: true };
    },
  };
  // Resumo da fila para "Todas as contas" (Precisa de atenção): a não impressas e as com prazo vencido.
  async function resumoFila() {
    const p = await pendentes(false);
    const agora = Date.now();
    const fila = D.comandasListar([...p.chaves, ...D.comandasManuaisAbertas()]);
    return { fila: fila.length, nao_impressas: fila.filter((c) => !c.impressa_em).length,
      atrasadas: fila.filter((c) => situacaoPrazo(c.prazo, agora) === 'atrasado').length,
      hoje: fila.filter((c) => situacaoPrazo(c.prazo, agora) === 'hoje').length };
  }
  return { rotas, rotasParam: [], resumoFila };
}

module.exports = { criar, categoriaDe, numerar, atrasadasDaFila, jaSaiuMl, situacaoPrazo, CATEGORIAS };
