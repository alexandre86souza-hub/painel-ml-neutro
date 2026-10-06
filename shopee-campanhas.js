'use strict';
// Campanhas (promoções da loja) e devoluções da Shopee, por loja (?loja={shop_id}). Telas
// public/shopee-campanhas.html e public/shopee-devolucoes.html; o menu troca Campanhas e
// Devoluções por elas quando a conta escolhida é a Shopee.
//
// Medido em 02/10/2026 com a loja real:
//   - discount/get_discount_list (discount_status all): 30 descontos (discount_id, nome, início,
//     fim, status, source); get_discount traz os itens. voucher/get_voucher_list: nenhum.
//     shop_flash_sale/get_shop_flash_sale_list type 3: 5 ofertas relâmpago (itens, cliques).
//     Campanhas da PRÓPRIA Shopee (ex.: 10.10) não têm lista na API.
//   - returns/get_return_list: janelas de até 15 dias; 31 devoluções em 150 dias, com reason
//     (CHANGE_MIND, NOT_RECEIPT, WRONG_ITEM, ITEM_NOT_FIT, FUNCTIONAL_DMG…), status,
//     refund_amount, item[] e order_sn. O campo "user" (comprador) NÃO sai daqui.
const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

const MOTIVOS = { CHANGE_MIND: 'Mudou de ideia', NOT_RECEIPT: 'Não recebeu', WRONG_ITEM: 'Item errado', ITEM_NOT_FIT: 'Não serviu',
  FUNCTIONAL_DMG: 'Com defeito', PHYSICAL_DMG: 'Danificado', ITEM_DAMAGED: 'Danificado', ITEM_MISSING: 'Faltando item',
  DIFFERENT_DESCRIPTION: 'Diferente da descrição', EXPIRED: 'Vencido', DESCRIPTION_DIFFERENT: 'Diferente da descrição',
  INCOMPLETE: 'Incompleto', COUNTERFEIT: 'Falsificado', USED: 'Usado', NONE: 'Sem motivo' };
const SITUACOES = { REQUESTED: 'Pedida', ACCEPTED: 'Aceita (reembolsada)', CANCELLED: 'Cancelada', JUDGING: 'Em análise da Shopee',
  CLOSED: 'Encerrada', PROCESSING: 'Em andamento', SELLER_DISPUTE: 'Em disputa' };

// Devolução da API -> linha da tela (sem nada do comprador). Função pura: testada.
function devolucaoDe(d) {
  return { devolucao: String(d.return_sn), pedido: d.order_sn || null, data: d.create_time ? new Date(d.create_time * 1000).toISOString() : null,
    atualizada: d.update_time ? new Date(d.update_time * 1000).toISOString() : null,
    motivo: d.reason || null, motivo_nome: MOTIVOS[d.reason] || d.reason || 'Outro', texto: (d.text_reason || '').slice(0, 300) || null,
    status: d.status || null, situacao: SITUACOES[d.status] || d.status || '—',
    reembolso: d.refund_amount != null ? r2(n(d.refund_amount)) : null, valor_original: d.amount_before_discount != null ? r2(n(d.amount_before_discount)) : null,
    precisa_devolver: !!d.needs_logistics, prazo_vendedor: d.return_seller_due_date ? new Date(d.return_seller_due_date * 1000).toISOString() : null,
    negociacao: d.negotiation_status || null, prova_vendedor: d.seller_proof_status || null,
    itens: (d.item || []).map((i) => ({ nome: i.name || null, sku: i.variation_sku || i.item_sku || null, quantidade: n(i.amount), preco: i.item_price != null ? n(i.item_price) : null,
      imagem: Array.isArray(i.images) ? i.images[0] || null : null })),
    link: `https://seller.shopee.com.br/portal/sale/returnrefundcancel?search=${encodeURIComponent(d.return_sn)}` };
}

// Resumo por motivo e situação. Função pura: testada.
function resumoDevolucoes(ls) {
  const aceitas = ls.filter((d) => d.status === 'ACCEPTED');
  const porMotivo = {};
  for (const d of ls) {
    const m = porMotivo[d.motivo_nome] || (porMotivo[d.motivo_nome] = { motivo: d.motivo_nome, qtd: 0, reembolso: 0 });
    m.qtd++; if (d.status === 'ACCEPTED') m.reembolso += n(d.reembolso);
  }
  return { total: ls.length, aceitas: aceitas.length, canceladas: ls.filter((d) => d.status === 'CANCELLED').length,
    abertas: ls.filter((d) => !['ACCEPTED', 'CANCELLED', 'CLOSED'].includes(d.status)).length,
    reembolsado: r2(aceitas.reduce((a, d) => a + n(d.reembolso), 0)),
    por_motivo: Object.values(porMotivo).map((m) => ({ ...m, reembolso: r2(m.reembolso) })).sort((a, b) => b.qtd - a.qtd) };
}

// ---------- criar campanhas (escrita na loja: só pela tela, com confirmação) ----------
// Regras da Shopee (Open Platform v2; conferir com a loja real na primeira criação):
//   discount/add_discount: início ≥ 1 h a partir de agora, fim ≥ 1 h depois do início, menos de
//   180 dias; add_discount_item: item_list[{item_id, purchase_limit, item_promotion_price |
//   model_list[{model_id, model_promotion_price}]}], devolve error_list por item.
//   shop_flash_sale: get_time_slot_id -> create_shop_flash_sale(timeslot_id) ->
//   add_shop_flash_sale_items (até 50 itens; item_input_promo_price/item_stock ou models[]).
//   voucher/add_voucher: voucher_type 1 = loja toda, 2 = produtos (item_id_list); reward_type
//   1 = valor fixo (discount_amount), 2 = porcentagem (percentage, max_price).
const seg = (iso) => Math.floor(Date.parse(iso) / 1000);
function periodoValido(inicio, fim, { maxDias, agora = Date.now() }) {
  const a = seg(inicio), b = seg(fim);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw erro('Informe o início e o fim.');
  if (a < agora / 1000 + 3600) throw erro('A Shopee pede início pelo menos 1 hora a partir de agora.');
  if (b < a + 3600) throw erro('O fim precisa ser pelo menos 1 hora depois do início.');
  if (b - a >= maxDias * 86400) throw erro(`A Shopee aceita no máximo ${maxDias} dias.`);
  return { start_time: a, end_time: b };
}
const nomeValido = (nome, max = 100) => {
  const s = String(nome || '').trim();
  if (s.length < 1 || s.length > max) throw erro(`Dê um nome à campanha (até ${max} caracteres).`);
  return s;
};
// Anúncios escolhidos ({item_id, model_id, preco, estoque?, limite?}) -> por anúncio. Função pura: testada.
function agruparItens(sel) {
  const m = new Map();
  for (const x of Array.isArray(sel) ? sel : []) {
    const item = Number(x.item_id), model = Number(x.model_id) || 0, preco = r2(Number(x.preco));
    if (!Number.isInteger(item) || item <= 0 || !(preco > 0)) throw erro('Há anúncio sem preço promocional válido.');
    const g = m.get(item) || { item_id: item, limite: Math.max(0, Math.floor(Number(x.limite) || 0)), modelos: [] };
    g.modelos.push({ model_id: model, preco, estoque: Math.max(0, Math.floor(Number(x.estoque) || 0)) });
    m.set(item, g);
  }
  if (!m.size) throw erro('Escolha pelo menos um anúncio.');
  return [...m.values()];
}
// Corpo do add_discount_item. Função pura: testada.
const itensDesconto = (grupos) => grupos.map((g) => (g.modelos.length === 1 && !g.modelos[0].model_id
  ? { item_id: g.item_id, purchase_limit: g.limite, item_promotion_price: g.modelos[0].preco }
  : { item_id: g.item_id, purchase_limit: g.limite, model_list: g.modelos.map((m) => ({ model_id: m.model_id, model_promotion_price: m.preco })) }));
// Corpo do add_shop_flash_sale_items. Função pura: testada.
function itensRelampago(grupos) {
  if (grupos.length > 50) throw erro('A oferta relâmpago aceita no máximo 50 anúncios.');
  return grupos.map((g) => {
    for (const m of g.modelos) if (!(m.estoque > 0)) throw erro('Informe o estoque da oferta de cada anúncio.');
    return g.modelos.length === 1 && !g.modelos[0].model_id
      ? { item_id: g.item_id, purchase_limit: g.limite, item_input_promo_price: g.modelos[0].preco, item_stock: g.modelos[0].estoque }
      : { item_id: g.item_id, purchase_limit: g.limite, models: g.modelos.map((m) => ({ model_id: m.model_id, input_promo_price: m.preco, stock: m.estoque })) };
  });
}
// Corpo do add_voucher. Função pura: testada.
function corpoCupom(b, agora = Date.now()) {
  const codigo = String(b.codigo || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,5}$/.test(codigo)) throw erro('Código do cupom: de 1 a 5 letras ou números (a Shopee junta o prefixo da loja).');
  const corpo = { voucher_name: nomeValido(b.nome), voucher_code: codigo, ...periodoValido(b.inicio, b.fim, { maxDias: 90, agora }) };
  const produtos = b.tipo === 'produtos';
  corpo.voucher_type = produtos ? 2 : 1;
  if (produtos) {
    const ids = [...new Set((b.itens || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
    if (!ids.length) throw erro('Escolha os anúncios do cupom de produtos.');
    if (ids.length > 100) throw erro('O cupom de produtos aceita até 100 anúncios.');
    corpo.item_id_list = ids;
  }
  const valor = Number(String(b.valor ?? '').replace(',', '.'));
  if (b.desconto === 'pct') {
    if (!Number.isInteger(valor) || valor < 1 || valor > 90) throw erro('Desconto em %: um número inteiro de 1 a 90.');
    corpo.reward_type = 2; corpo.percentage = valor;
    const teto = Number(String(b.maximo ?? '').replace(',', '.'));
    if (teto > 0) corpo.max_price = r2(teto);
  } else {
    if (!(valor > 0)) throw erro('Informe o valor do desconto.');
    corpo.reward_type = 1; corpo.discount_amount = r2(valor);
  }
  const minimo = Number(String(b.minimo ?? '0').replace(',', '.')) || 0;
  if (minimo < 0) throw erro('Compra mínima inválida.');
  if (corpo.reward_type === 1 && minimo > 0 && corpo.discount_amount >= minimo) throw erro('O desconto precisa ser menor que a compra mínima.');
  corpo.min_basket_price = r2(minimo);
  const qtd = Math.floor(Number(b.quantidade));
  if (!(qtd >= 1 && qtd <= 200000)) throw erro('Quantidade de cupons: de 1 a 200.000.');
  corpo.usage_quantity = qtd;
  corpo.display_channel_list = [1];
  return corpo;
}

// ---------- métricas de uma campanha (cópia local dos pedidos da Shopee) ----------
// Linhas de venda (shopee-vendas.js#linhasDe) -> resumo e anúncios que mais venderam. Função pura: testada.
function metricasDe(linhas, filtro) {
  const ls = linhas.filter((l) => l.valida && filtro(l));
  const pedidos = new Set(ls.map((l) => l.pedido));
  const s = { pedidos: pedidos.size, unidades: 0, faturamento: 0, lucro: 0, com_lucro: 0, cupom: 0 };
  const porAnuncio = new Map();
  for (const l of ls) {
    s.unidades += l.quantidade; s.faturamento += l.faturamento || 0; s.cupom += l.cupom || 0;
    if (l.lucro != null) { s.lucro += l.lucro; s.com_lucro += l.faturamento || 0; }
    const k = l.shopee_item || l.sku;
    const a = porAnuncio.get(k) || { shopee_item: l.shopee_item ?? null, sku: l.sku, titulo: l.titulo, foto: l.foto, pedidos: new Set(), unidades: 0, faturamento: 0, lucro: 0, sem_lucro: false };
    a.pedidos.add(l.pedido); a.unidades += l.quantidade; a.faturamento += l.faturamento || 0;
    if (l.lucro == null) a.sem_lucro = true; else a.lucro += l.lucro;
    porAnuncio.set(k, a);
  }
  const anuncios = [...porAnuncio.values()].map((a) => ({ ...a, pedidos: a.pedidos.size, faturamento: r2(a.faturamento),
    lucro: a.sem_lucro ? null : r2(a.lucro), margem: a.sem_lucro || !a.faturamento ? null : a.lucro / a.faturamento }))
    .sort((a, b) => b.faturamento - a.faturamento);
  return { resumo: { pedidos: s.pedidos, unidades: s.unidades, faturamento: r2(s.faturamento), lucro: r2(s.lucro),
    margem: s.com_lucro ? s.lucro / s.com_lucro : null, cupom: r2(s.cupom) }, anuncios };
}

function criar({ D, daLoja, vendas }) {
  const lojaDe = (v) => {
    const id = Number(v);
    if (!Number.isInteger(id) || !D.shopeeLojaObter(id)) throw erro('Escolha uma loja da Shopee conectada.', 404);
    return id;
  };
  const exigeLoja = (url) => lojaDe(url.searchParams.get('loja'));
  const resposta = (r) => { if (r?.error) throw erro(`Shopee: ${r.message || r.error}`, 502); return r?.response || {}; };
  const cache = new Map();
  const guardado = async (chave, min, fn) => {
    const c = cache.get(chave);
    if (c && Date.now() - c.em < min * 60e3) return c.v;
    const v = await fn(); cache.set(chave, { em: Date.now(), v }); return v;
  };

  // vendas dos itens de uma promoção no período dela (cópia local dos pedidos da Shopee)
  const vendasDosItens = (shopId, itens, de, ate) => {
    if (!itens.length) return { pedidos: 0, unidades: 0, faturamento: 0 };
    const r = D.db.prepare(`SELECT COUNT(DISTINCT p.order_sn) AS pedidos, COALESCE(SUM(i.quantidade),0) AS unidades, COALESCE(SUM(i.quantidade * i.preco_unit),0) AS fat
      FROM shopee_pedidos p JOIN shopee_itens i ON i.order_sn = p.order_sn WHERE p.shop_id=? AND p.data >= ? AND p.data < ?
      AND p.status NOT IN ('CANCELLED','IN_CANCEL','UNPAID') AND i.item_id IN (${itens.map(() => '?').join(',')})`).get(shopId, de, ate, ...itens);
    return { pedidos: r.pedidos, unidades: r.unidades, faturamento: r2(r.fat) };
  };
  const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);

  const rotas = {
    'GET /api/shopee/campanhas': async (url) => {
      const shopId = exigeLoja(url);
      return guardado(`camp:${shopId}`, url.searchParams.get('recarregar') ? 0 : 30, async () => {
        // descontos da loja (todas as situações) e os itens de cada um
        const descontos = [];
        for (let pag = 1; pag <= 10; pag++) {
          const r = resposta(await daLoja(shopId, '/api/v2/discount/get_discount_list', { discount_status: 'all', page_no: pag, page_size: 100 }));
          descontos.push(...(r.discount_list || []));
          if (!r.more) break;
        }
        // Itens só dos descontos em andamento, agendados ou encerrados há até 60 dias, 4 por vez
        // (medido em 06/10/2026: 30 descontos com até 4 páginas cada, um por um, levavam 67 s).
        const recente = Date.now() / 1000 - 60 * 86400;
        const escolhidos = descontos.sort((a, b) => b.start_time - a.start_time).slice(0, 60);
        const lista = new Array(escolhidos.length);
        let prox = 0;
        const trabalhar = async () => {
          for (let k = prox++; k < escolhidos.length; k = prox++) {
            const d = escolhidos[k];
            let itens = null;
            if (!d.end_time || d.end_time >= recente) {
              itens = [];
              try {
                for (let pag = 1; pag <= 10; pag++) {
                  const r = resposta(await daLoja(shopId, '/api/v2/discount/get_discount', { discount_id: d.discount_id, page_no: pag, page_size: 100 }));
                  itens = itens.concat(r.item_list || []);
                  if (!r.more) break;
                }
              } catch {}
            }
            const ids = itens ? [...new Set(itens.map((i) => Number(i.item_id)))] : null;
            lista[k] = { tipo: 'Desconto', id: String(d.discount_id), nome: d.discount_name || null, status: d.status || null,
              inicio: iso(d.start_time), fim: iso(d.end_time), itens: ids ? ids.length : null,
              exemplos: (itens || []).slice(0, 3).map((i) => ({ nome: i.item_name || null, preco_original: i.item_original_price ?? i.model_list?.[0]?.model_original_price ?? null,
                preco_promo: i.item_promotion_price ?? i.model_list?.[0]?.model_promotion_price ?? null })),
              vendas: ids ? vendasDosItens(shopId, ids, iso(d.start_time), iso(d.end_time)) : null };
          }
        };
        await Promise.all([trabalhar(), trabalhar(), trabalhar(), trabalhar()]);
        // ofertas relâmpago da loja (1 = em andamento, 2 = agendadas, 3 = encerradas)
        for (const type of [1, 2, 3]) {
          try {
            const r = resposta(await daLoja(shopId, '/api/v2/shop_flash_sale/get_shop_flash_sale_list', { type, offset: 0, limit: 50 }));
            for (const f of r.flash_sale_list || []) {
              lista.push({ tipo: 'Oferta relâmpago', id: String(f.flash_sale_id), nome: null, status: ['', 'em andamento', 'agendada', 'encerrada'][type],
                inicio: iso(f.start_time), fim: iso(f.end_time), itens: f.item_count ?? null, itens_ativos: f.enabled_item_count ?? null, cliques: f.click_count ?? null });
            }
          } catch {}
        }
        // cupons da loja
        try {
          const r = resposta(await daLoja(shopId, '/api/v2/voucher/get_voucher_list', { status: 'all', page_no: 1, page_size: 100 }));
          for (const v of r.voucher_list || []) {
            lista.push({ tipo: 'Cupom', id: String(v.voucher_id), nome: v.voucher_name || v.voucher_code || null, status: null,
              inicio: iso(v.start_time), fim: iso(v.end_time), usados: v.current_usage ?? null, limite: v.usage_quantity ?? null });
          }
        } catch {}
        const agora = new Date().toISOString();
        for (const c of lista) c.situacao = c.inicio > agora ? 'agendada' : c.fim && c.fim < agora ? 'encerrada' : 'em andamento';
        lista.sort((a, b) => (a.situacao === 'em andamento' ? -1 : 0) - (b.situacao === 'em andamento' ? -1 : 0) || String(b.inicio).localeCompare(String(a.inicio)));
        return { loja: shopId, campanhas: lista, em_andamento: lista.filter((c) => c.situacao === 'em andamento').length,
          nota: 'Campanhas da própria Shopee (como 10.10 e 11.11) não aparecem na API: a inscrição nelas é no Seller Centre.' };
      });
    },

    // Resultado de uma campanha: vendas dos itens dela no período, contra o mesmo número de
    // dias logo antes (até 30), e os anúncios que mais venderam.
    'GET /api/shopee/campanhas/metricas': async (url) => {
      const shopId = exigeLoja(url);
      const tipo = url.searchParams.get('tipo'), id = url.searchParams.get('id') || '';
      if (!/^\d{1,20}$/.test(id)) throw erro('Campanha inválida.');
      let de, ate, ids = null, extra = {};
      if (tipo === 'desconto') {
        let itens = [], d = null;
        for (let pag = 1; pag <= 30; pag++) {
          d = resposta(await daLoja(shopId, '/api/v2/discount/get_discount', { discount_id: id, page_no: pag, page_size: 100 }));
          itens = itens.concat(d.item_list || []);
          if (!d.more) break;
        }
        de = iso(d.start_time); ate = iso(d.end_time); ids = itens.map((i) => Number(i.item_id));
        extra = { nome: d.discount_name || null };
      } else if (tipo === 'relampago') {
        const f = resposta(await daLoja(shopId, '/api/v2/shop_flash_sale/get_shop_flash_sale', { flash_sale_id: id }));
        de = iso(f.start_time); ate = iso(f.end_time); ids = [];
        for (let offset = 0; offset < 1000; offset += 100) {
          const r = resposta(await daLoja(shopId, '/api/v2/shop_flash_sale/get_shop_flash_sale_items', { flash_sale_id: id, offset, limit: 100 }));
          const lote = r.item_info || r.items || [];
          ids.push(...lote.map((i) => Number(i.item_id)));
          if (lote.length < 100) break;
        }
        extra = { cliques: f.click_count ?? null, itens_ativos: f.enabled_item_count ?? null };
      } else if (tipo === 'cupom') {
        const v = resposta(await daLoja(shopId, '/api/v2/voucher/get_voucher', { voucher_id: id }));
        de = iso(v.start_time); ate = iso(v.end_time);
        if (v.voucher_type === 2) ids = (v.item_id_list || []).map(Number);
        extra = { nome: v.voucher_name || null, codigo: v.voucher_code || null, usados: v.current_usage ?? null, limite: v.usage_quantity ?? null };
      } else throw erro('Tipo de campanha inválido.');
      if (!de || !ate) throw erro('A Shopee não devolveu o período da campanha.', 502);
      const fimReal = ate < new Date().toISOString() ? ate : new Date().toISOString();
      const dur = Math.max(864e5, Math.min(30 * 864e5, Date.parse(fimReal) - Date.parse(de)));
      const antesDe = new Date(Date.parse(de) - dur).toISOString();
      const linhas = await vendas(shopId, antesDe, fimReal);
      const conj = ids ? new Set(ids) : null;
      const doItem = (l) => !conj || conj.has(Number(l.shopee_item));
      const noPeriodo = (l) => l.data >= de && l.data < fimReal;
      const filtro = tipo === 'cupom' ? (l) => noPeriodo(l) && (l.cupom || 0) > 0 && doItem(l) : (l) => noPeriodo(l) && doItem(l);
      const m = metricasDe(linhas, filtro);
      const antes = metricasDe(linhas, (l) => l.data >= antesDe && l.data < de && doItem(l)).resumo;
      return { loja: shopId, tipo, id, inicio: de, fim: ate, itens: ids ? new Set(ids).size : null, ...extra,
        dias: r2(dur / 864e5), ...m, anuncios: m.anuncios.slice(0, 20), antes };
    },

    // Horários disponíveis para oferta relâmpago da loja (próximos 7 dias).
    'GET /api/shopee/campanhas/horarios': async (url) => {
      const shopId = exigeLoja(url);
      const agora = Math.floor(Date.now() / 1000);
      const r = await daLoja(shopId, '/api/v2/shop_flash_sale/get_time_slot_id', { start_time: agora + 60, end_time: agora + 7 * 86400 });
      const lista = Array.isArray(r.response) ? r.response : r.response?.time_slot_list || [];
      return { horarios: lista.map((t) => ({ id: String(t.timeslot_id), inicio: iso(t.start_time), fim: iso(t.end_time) })) };
    },

    'POST /api/shopee/campanhas/desconto': async (_u, b) => {
      const shopId = lojaDe(b?.loja);
      const corpo = { discount_name: nomeValido(b?.nome), ...periodoValido(b?.inicio, b?.fim, { maxDias: 180 }) };
      const lista = itensDesconto(agruparItens(b?.itens));
      const d = resposta(await daLoja(shopId, '/api/v2/discount/add_discount', {}, corpo));
      const discountId = d.discount_id;
      const recusados = [];
      for (let i = 0; i < lista.length; i += 50) {
        try {
          const r = resposta(await daLoja(shopId, '/api/v2/discount/add_discount_item', {}, { discount_id: discountId, item_list: lista.slice(i, i + 50) }));
          for (const e of r.error_list || []) recusados.push({ item_id: e.item_id, model_id: e.model_id || 0, motivo: e.fail_message || e.fail_error || 'recusado' });
        } catch (e) { for (const x of lista.slice(i, i + 50)) recusados.push({ item_id: x.item_id, model_id: 0, motivo: e.message }); }
      }
      const recusadosItens = new Set(recusados.map((x) => x.item_id));
      const aceitos = lista.filter((x) => !recusadosItens.has(x.item_id)).length;
      let apagada = false;
      if (!aceitos) { try { await daLoja(shopId, '/api/v2/discount/delete_discount', {}, { discount_id: discountId }); apagada = true; } catch {} }
      cache.delete(`camp:${shopId}`);
      return { id: String(discountId), aceitos, recusados, apagada };
    },

    'POST /api/shopee/campanhas/relampago': async (_u, b) => {
      const shopId = lojaDe(b?.loja);
      const slot = String(b?.horario || '');
      if (!/^\d{1,20}$/.test(slot)) throw erro('Escolha o horário da oferta relâmpago.');
      const lista = itensRelampago(agruparItens(b?.itens));
      const f = resposta(await daLoja(shopId, '/api/v2/shop_flash_sale/create_shop_flash_sale', {}, { timeslot_id: Number(slot) }));
      const flashId = f.flash_sale_id;
      const r = resposta(await daLoja(shopId, '/api/v2/shop_flash_sale/add_shop_flash_sale_items', {}, { flash_sale_id: flashId, items: lista }));
      const recusados = (r.failed_items || []).map((e) => ({ item_id: e.item_id, model_id: e.model_id || 0, motivo: e.err_msg || e.unqualified_reason || 'recusado' }));
      const recusadosItens = new Set(recusados.map((x) => x.item_id));
      const aceitos = lista.filter((x) => !recusadosItens.has(x.item_id)).length;
      let apagada = false;
      if (!aceitos) { try { await daLoja(shopId, '/api/v2/shop_flash_sale/delete_shop_flash_sale', {}, { flash_sale_id: flashId }); apagada = true; } catch {} }
      cache.delete(`camp:${shopId}`);
      return { id: String(flashId), aceitos, recusados, apagada };
    },

    'POST /api/shopee/campanhas/cupom': async (_u, b) => {
      const shopId = lojaDe(b?.loja);
      const v = resposta(await daLoja(shopId, '/api/v2/voucher/add_voucher', {}, corpoCupom(b || {})));
      cache.delete(`camp:${shopId}`);
      return { id: String(v.voucher_id) };
    },

    'GET /api/shopee/devolucoes': async (url) => {
      const shopId = exigeLoja(url);
      const dias = [30, 60, 90, 150].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 90;
      return guardado(`dev:${shopId}:${dias}`, url.searchParams.get('recarregar') ? 0 : 10, async () => {
        const agora = Math.floor(Date.now() / 1000);
        const todas = new Map();
        for (let fim = agora; fim > agora - dias * 86400; fim -= 15 * 86400) {
          for (let pag = 0; pag < 20; pag++) {
            const r = resposta(await daLoja(shopId, '/api/v2/returns/get_return_list', { page_no: pag, page_size: 50,
              create_time_from: Math.max(agora - dias * 86400, fim - 15 * 86400 + 1), create_time_to: fim }));
            for (const d of r.return || []) todas.set(String(d.return_sn), devolucaoDe(d));
            if (!r.more) break;
          }
        }
        const lista = [...todas.values()].sort((a, b) => String(b.data).localeCompare(String(a.data)));
        return { loja: shopId, dias, resumo: resumoDevolucoes(lista), devolucoes: lista };
      });
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, devolucaoDe, resumoDevolucoes, MOTIVOS, periodoValido, agruparItens, itensDesconto, itensRelampago, corpoCupom, metricasDe };
