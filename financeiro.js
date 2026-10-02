'use strict';
// Financeiro (tela public/financeiro.html): o dinheiro das vendas do Mercado Livre pelo Mercado
// Pago — a receber (com a data em que cada valor é liberado), o que já foi liberado e cada
// pagamento ligado ao seu pedido. Usa o MESMO token da conta do ML (sem cadastro novo).
//
// Medido em 02/10/2026 na conta real (/v1/payments/search, 30 dias): todo pagamento listado é
// recebido pela conta (collector_id = conta); "regular_payment" com order.id = venda do ML;
// "money_transfer" = outros créditos (ex.: bonificaciones_flex). Valores: transaction_amount
// (bruto), shipping_amount, transaction_amount_refunded, transaction_details.net_received_amount
// (líquido, o que cai na conta) e charges_details[] (fee: ml_sale_fee, mp_processing_fee,
// mp_financing_*, financing_*; shipping: shp_*; coupon), cada um com amounts.original/refunded.
// money_release_date / money_release_status (pending | released) dizem quando o dinheiro libera.
// O saldo da conta a API não dá (403); o extrato com saques vem do relatório de liberações.
const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
const diaLocal = (iso) => (iso ? new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10) : null);
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// Pagamento do Mercado Pago -> registro da tabela. Só entram as cobranças pagas pelo vendedor
// (accounts.from = collector). Função pura: testada.
function pagamentoDe(p, mlUserId) {
  let tarifaMl = 0, tarifaMp = 0, frete = 0, cupom = 0;
  for (const c of p.charges_details || []) {
    const v = n(c.amounts?.original) - n(c.amounts?.refunded);
    // juros do parcelamento pagos pelo comprador (financing_transfer, payer -> collector): entram
    // para o vendedor e abatem a taxa de financiamento que o Mercado Pago cobra dele
    if (c.accounts?.to === 'collector' && c.accounts?.from !== 'collector') { tarifaMp -= v; continue; }
    if (c.accounts?.from && c.accounts.from !== 'collector') continue;
    if (c.type === 'shipping') frete += v;
    else if (c.type === 'coupon') cupom += v;
    else if (/^ml_/.test(c.name || '')) tarifaMl += v;
    else tarifaMp += v;
  }
  const venda = p.operation_type === 'regular_payment' && !!p.order?.id;
  return { id: p.id, ml_user_id: mlUserId, order_id: p.order?.id ? Number(p.order.id) : null, tipo: venda ? 'venda' : 'outro',
    descricao: (p.description || '').slice(0, 120) || null, criado: iso(p.date_created), aprovado: iso(p.date_approved),
    status: p.status || null, status_detalhe: p.status_detail || null, bruto: r2(n(p.transaction_amount)), frete_cobrado: r2(n(p.shipping_amount)),
    reembolsado: r2(n(p.transaction_amount_refunded)), liquido: p.transaction_details?.net_received_amount != null ? r2(n(p.transaction_details.net_received_amount)) : null,
    tarifa_ml: r2(tarifaMl), tarifa_mp: r2(tarifaMp), frete: r2(frete), cupom: r2(cupom),
    libera_em: iso(p.money_release_date), liberado: p.money_release_status || null, atualizado: iso(p.date_last_updated) };
}

// O que conta como dinheiro a receber/liberado: aprovado (o reembolsado total não entra).
const conta = (p) => p.status === 'approved' && n(p.liquido) > 0;

// Painel da tela: a receber por dia, liberado por dia, retido e os totais. Função pura: testada.
function financeiroDe(pags, { agora = Date.now(), dias = 30 } = {}) {
  const hoje = diaLocal(new Date(agora).toISOString());
  const limite = new Date(agora - dias * 864e5).toISOString();
  const aReceber = new Map(), liberado = new Map();
  const t = { a_receber: 0, a_receber_7: 0, retido: 0, liberado: 0, vendas_liberadas: 0, outros_liberados: 0,
    tarifa_ml: 0, tarifa_mp: 0, frete: 0, cupom: 0, bruto: 0, reembolsado: 0, qtd_a_receber: 0, qtd_retido: 0 };
  const em7 = diaLocal(new Date(agora + 7 * 864e5).toISOString());
  for (const p of pags) {
    if (!conta(p)) { if (p.status === 'refunded' && p.criado >= limite) t.reembolsado += n(p.bruto); continue; }
    const dia = diaLocal(p.libera_em);
    if (p.liberado === 'pending') {
      // liberação já vencida e ainda pendente = dinheiro retido (reclamação, contestação…)
      if (dia && dia < hoje) { t.retido += n(p.liquido); t.qtd_retido++; continue; }
      t.a_receber += n(p.liquido); t.qtd_a_receber++;
      if (dia && dia <= em7) t.a_receber_7 += n(p.liquido);
      if (dia) aReceber.set(dia, (aReceber.get(dia) || 0) + n(p.liquido));
    } else if (p.liberado === 'released' && p.libera_em >= limite) {
      t.liberado += n(p.liquido);
      if (p.tipo === 'venda') {
        t.vendas_liberadas += n(p.liquido); t.bruto += n(p.bruto) + n(p.frete_cobrado);
        t.tarifa_ml += n(p.tarifa_ml); t.tarifa_mp += n(p.tarifa_mp); t.frete += n(p.frete); t.cupom += n(p.cupom);
      } else t.outros_liberados += n(p.liquido);
      if (dia) liberado.set(dia, (liberado.get(dia) || 0) + n(p.liquido));
    }
  }
  for (const k of Object.keys(t)) if (!k.startsWith('qtd_')) t[k] = r2(t[k]);
  const serie = (m) => [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([dia, v]) => ({ dia, valor: r2(v) }));
  return { totais: t, a_receber_por_dia: serie(aReceber), liberado_por_dia: serie(liberado) };
}

function criar({ D, ml }) {
  const isoMp = (d) => new Date(d).toISOString().replace('Z', '-00:00');

  // Cópia local dos pagamentos de uma conta: 1ª leitura = 120 dias pela criação; depois, o que
  // mudou (date_last_updated) desde a última leitura, com 1 dia de folga. No máximo a cada 10 min.
  const lendo = new Map();
  function sincronizar(mlUserId, forcar = false) {
    const chave = `mp_lido_em:${mlUserId}`;
    const ultima = D.configLer(chave);
    if (!forcar && ultima && Date.now() - Date.parse(ultima) < 10 * 60e3) return Promise.resolve();
    if (lendo.has(mlUserId)) return lendo.get(mlUserId);
    const p = (async () => {
      const inicio = new Date();
      await ml('/users/me', {}, mlUserId).catch(() => null);     // renova o token, se for o caso
      const tok = D.contaObter(mlUserId)?.access_token;
      if (!tok) throw new Error('Conta sem acesso.');
      const campo = ultima ? 'date_last_updated' : 'date_created';
      const de = ultima ? new Date(Date.parse(ultima) - 864e5) : new Date(Date.now() - 120 * 864e5);
      for (let offset = 0; offset < 10000; offset += 100) {
        const u = `https://api.mercadopago.com/v1/payments/search?sort=${campo}&criteria=asc&range=${campo}`
          + `&begin_date=${encodeURIComponent(isoMp(de))}&end_date=${encodeURIComponent(isoMp(Date.now()))}&limit=100&offset=${offset}`;
        const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`Mercado Pago respondeu ${r.status}`);
        const j = await r.json();
        const lista = (j.results || []).filter((x) => String(x.collector_id ?? x.collector?.id) === String(mlUserId) && x.status !== 'rejected');
        D.mpPagamentosGravar(lista.map((x) => pagamentoDe(x, mlUserId)));
        if ((j.results || []).length < 100 || offset + 100 >= (j.paging?.total ?? 0)) break;
      }
      D.configGravar(chave, inicio.toISOString());
    })().finally(() => lendo.delete(mlUserId));
    lendo.set(mlUserId, p);
    return p;
  }

  const rotas = {
    // ?conta=ID (ou vazio = todas as contas do ML) &dias=7|15|30|60|90
    'GET /api/financeiro': async (url) => {
      const contas = D.contasListar();
      const pedida = Number(url.searchParams.get('conta')) || null;
      const alvo = pedida ? contas.filter((c) => c.ml_user_id === pedida) : contas;
      if (!alvo.length) throw Object.assign(new Error('Nenhuma conta do Mercado Livre conectada.'), { status: 409 });
      const dias = [7, 15, 30, 60, 90].includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : 30;
      const erros = [];
      for (const c of alvo) {
        try { await sincronizar(c.ml_user_id, url.searchParams.get('recarregar') === '1'); }
        catch (e) { erros.push(`${c.nickname}: ${e.message}`); }
      }
      const de = new Date(Date.now() - dias * 864e5).toISOString();
      const ate = new Date(Date.now() + 120 * 864e5).toISOString();
      const pags = alvo.flatMap((c) => D.mpPagamentos(c.ml_user_id, de, ate));
      const nomes = Object.fromEntries(contas.map((c) => [c.ml_user_id, c.nickname]));
      return { dias, contas: contas.map((c) => ({ ml_user_id: c.ml_user_id, nickname: c.nickname })), conta: pedida, erros,
        ...financeiroDe(pags, { dias }),
        pagamentos: pags.filter((p) => p.status !== 'rejected').slice(0, 3000).map((p) => ({ ...p, conta_nome: nomes[p.ml_user_id] || null,
          link_pedido: p.order_id ? `https://www.mercadolivre.com.br/vendas/${p.order_id}/detalhe` : null })),
        lido_em: alvo.map((c) => D.configLer(`mp_lido_em:${c.ml_user_id}`)).filter(Boolean).sort()[0] || null };
    },
  };
  return { rotas, rotasParam: [], sincronizar };
}

module.exports = { criar, pagamentoDe, financeiroDe };
