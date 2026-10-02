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

function criar({ D, daLoja }) {
  const exigeLoja = (url) => {
    const id = Number(url.searchParams.get('loja'));
    if (!Number.isInteger(id) || !D.shopeeLojaObter(id)) throw erro('Escolha uma loja da Shopee conectada.', 404);
    return id;
  };
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
        const lista = [];
        for (const d of descontos.sort((a, b) => b.start_time - a.start_time).slice(0, 60)) {
          let itens = [];
          try {
            for (let pag = 1; pag <= 10; pag++) {
              const r = resposta(await daLoja(shopId, '/api/v2/discount/get_discount', { discount_id: d.discount_id, page_no: pag, page_size: 100 }));
              itens = itens.concat(r.item_list || []);
              if (!r.more) break;
            }
          } catch {}
          const ids = [...new Set(itens.map((i) => Number(i.item_id)))];
          lista.push({ tipo: 'Desconto', id: String(d.discount_id), nome: d.discount_name || null, status: d.status || null,
            inicio: iso(d.start_time), fim: iso(d.end_time), itens: ids.length,
            exemplos: itens.slice(0, 3).map((i) => ({ nome: i.item_name || null, preco_original: i.item_original_price ?? i.model_list?.[0]?.model_original_price ?? null,
              preco_promo: i.item_promotion_price ?? i.model_list?.[0]?.model_promotion_price ?? null })),
            vendas: vendasDosItens(shopId, ids, iso(d.start_time), iso(d.end_time)) });
        }
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

module.exports = { criar, devolucaoDe, resumoDevolucoes, MOTIVOS };
