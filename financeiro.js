'use strict';
// Financeiro (tela public/financeiro.html): o dinheiro das vendas do Mercado Livre pelo Mercado
// Pago — a receber (com a data em que cada valor é liberado), o que já foi liberado, o extrato
// com saques e saldo, e a conferência de cada pagamento com a sua venda. Usa o MESMO token da
// conta do ML (sem cadastro novo).
//
// Medido em 02/10/2026 na conta real (/v1/payments/search, 30 dias): todo pagamento listado é
// recebido pela conta (collector_id = conta); "regular_payment" com order.id = venda do ML;
// "money_transfer" = outros créditos (ex.: bonificaciones_flex). Valores: transaction_amount
// (bruto), shipping_amount, transaction_amount_refunded, transaction_details.net_received_amount
// (líquido, o que cai na conta) e charges_details[] (fee: ml_sale_fee, mp_processing_fee,
// mp_financing_*, financing_*; shipping: shp_*; coupon), cada um com amounts.original/refunded.
// money_release_date / money_release_status (pending | released) dizem quando o dinheiro libera.
// O saldo da conta a API não dá (403): ele vem do relatório de liberações (extrato, abaixo).
//
// Conferência (medido nas duas contas, 120 dias):
//   - venda: order.id = pedido do ML. Bruto ≠ itens do pedido só quando o comprador pagou o
//     frete junto (20 de 20 casos: a diferença era o frete do envio) — no bruto ou no
//     shipping_amount (9 casos em 120 dias, quase todos de venda cancelada).
//   - frete pago à parte: description "marketplace_shipment", external_reference = nº do ENVIO;
//     o order.id dele não é pedido (/orders e /packs dão 404). 100 de 100 ligados pelo envio.
//   - money_transfer: "bonificaciones_flex" (bônus do Flex) e "…correspondente a sua
//     reclamação" trazem um código de 10 dígitos que não é pedido, envio, reclamação nem pack
//     (tudo 404). O de reclamação é ligado pelo valor e pela data (devolucoes.js#ligarCreditos);
//     o do Flex fica sem venda, explicado.
const { ligarCreditos } = require('./devolucoes.js');

const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
const diaLocal = (iso) => (iso ? new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10) : null);
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const brl = (v) => 'R$ ' + n(v).toFixed(2).replace('.', ',');

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
  const referencia = String(p.external_reference ?? '').slice(0, 40) || null;
  // frete pago à parte: o order.id não é pedido; o nº do envio vem no external_reference
  const freteAParte = p.description === 'marketplace_shipment';
  return { id: p.id, ml_user_id: mlUserId, order_id: p.order?.id && !freteAParte ? Number(p.order.id) : null, tipo: venda ? 'venda' : 'outro',
    descricao: (p.description || '').slice(0, 120) || null, criado: iso(p.date_created), aprovado: iso(p.date_approved),
    status: p.status || null, status_detalhe: p.status_detail || null, bruto: r2(n(p.transaction_amount)), frete_cobrado: r2(n(p.shipping_amount)),
    reembolsado: r2(n(p.transaction_amount_refunded)), liquido: p.transaction_details?.net_received_amount != null ? r2(n(p.transaction_details.net_received_amount)) : null,
    tarifa_ml: r2(tarifaMl), tarifa_mp: r2(tarifaMp), frete: r2(frete), cupom: r2(cupom),
    libera_em: iso(p.money_release_date), liberado: p.money_release_status || null, atualizado: iso(p.date_last_updated),
    referencia, envio_id: freteAParte && /^\d+$/.test(referencia || '') ? Number(referencia) : null };
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

// ---------- extrato (relatório de liberações) ----------
// Medido em 02/10/2026 (30 dias, 1.013 linhas): RECORD_TYPE initial_available_balance (saldo
// no início), release (cada movimento) e total (saldo no fim); saldo inicial + créditos −
// débitos = total. SOURCE_ID = id do pagamento (100% achados em mp_pagamentos, menos saques).
// Saque = reserve_for_payout (débito e depois crédito, se anulam) + payout (o débito real).
const TIPOS_EXTRATO = {
  payment: 'Venda liberada', shipping: 'Frete / bônus de envio', cashback: 'Crédito do Mercado Livre',
  mediation: 'Reclamação', mediation_cancel: 'Reclamação cancelada', reserve_for_dispute: 'Reserva por disputa',
  refund: 'Reembolso', reserve_for_refund: 'Reserva para reembolso', reserve_for_bpp_shipping_return: 'Reserva do frete de devolução',
  reserve_for_payout: 'Reserva para saque', payout: 'Saque para o banco', chargeback: 'Contestação (chargeback)',
  withdrawal: 'Saque', fee: 'Tarifa', tax: 'Imposto',
};
const nomeTipo = (t) => TIPOS_EXTRATO[t] || t || 'Movimento';

// CSV do relatório -> linhas. Aceita aspas (vírgula dentro de campo). Função pura: testada.
function lerRelatorio(csv) {
  const campos = (ln) => { const out = []; let cur = '', q = false;
    for (let i = 0; i < ln.length; i++) { const ch = ln[i];
      if (q) { if (ch === '"' && ln[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out; };
  const linhas = String(csv || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!linhas.length) throw new Error('Relatório vazio.');
  const cab = campos(linhas[0]).map((h) => h.trim().toUpperCase());
  const ix = (k) => cab.indexOf(k);
  for (const k of ['DATE', 'RECORD_TYPE', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT']) if (ix(k) < 0) throw new Error(`Relatório sem a coluna ${k}.`);
  let saldoInicial = null, saldoFinal = null;
  const movs = [];
  for (const ln of linhas.slice(1)) {
    const v = campos(ln);
    const val = (k) => (ix(k) >= 0 ? (v[ix(k)] ?? '').trim() : '');
    const cr = n(val('NET_CREDIT_AMOUNT')), db = n(val('NET_DEBIT_AMOUNT'));
    const rt = val('RECORD_TYPE');
    if (rt === 'initial_available_balance') { saldoInicial = r2(cr - db); continue; }
    if (rt === 'total') { saldoFinal = r2(cr - db); continue; }
    if (rt !== 'release') continue;
    movs.push({ data: iso(val('DATE')), source_id: val('SOURCE_ID') || null, referencia: val('EXTERNAL_REFERENCE') || null,
      tipo: val('DESCRIPTION') || rt, credito: r2(cr), debito: r2(db) });
  }
  return { saldo_inicial: saldoInicial ?? 0, saldo_final: saldoFinal, linhas: movs.filter((m) => m.data) };
}

// Movimentos guardados -> saldo após cada um, por dia e conferência dos saldos que o Mercado
// Pago informou. saldos = um por relatório importado (o mais antigo dá o ponto de partida).
// Função pura: testada.
function extratoDe(movs, saldos) {
  if (!saldos.length) return { movimentos: [], dias: [], confere: null, saldo_atual: null };
  const ord = [...saldos].sort((a, b) => a.inicio.localeCompare(b.inicio));
  let saldo = n(ord[0].saldo_inicial);
  const conferencias = [];
  let k = 1;
  const out = [];
  const porDia = new Map();
  for (const m of [...movs].filter((x) => x.data >= ord[0].inicio).sort((a, b) => a.data.localeCompare(b.data) || n(a.ordem) - n(b.ordem))) {
    while (k < ord.length && m.data >= ord[k].inicio) { conferencias.push({ inicio: ord[k].inicio, informado: ord[k].saldo_inicial, calculado: r2(saldo) }); k++; }
    saldo += n(m.credito) - n(m.debito);
    out.push({ ...m, saldo: r2(saldo) });
    const d = diaLocal(m.data);
    const x = porDia.get(d) || { dia: d, entradas: 0, saidas: 0, saques: 0, saldo: 0 };
    x.entradas += n(m.credito); x.saidas += n(m.debito); if (m.tipo === 'payout' || m.tipo === 'withdrawal') x.saques += n(m.debito);
    x.saldo = saldo; porDia.set(d, x);
  }
  while (k < ord.length) { conferencias.push({ inicio: ord[k].inicio, informado: ord[k].saldo_inicial, calculado: r2(saldo) }); k++; }
  const ult = ord.at(-1);
  if (ult.saldo_final != null) conferencias.push({ fim: ult.fim, informado: ult.saldo_final, calculado: r2(saldo) });
  const erradas = conferencias.filter((c) => Math.abs(n(c.informado) - c.calculado) >= 0.05);
  return { movimentos: out, dias: [...porDia.values()].map((d) => ({ ...d, entradas: r2(d.entradas), saidas: r2(d.saidas), saques: r2(d.saques), saldo: r2(d.saldo) })),
    confere: { ok: !erradas.length, conferidos: conferencias.length, erradas }, saldo_atual: r2(saldo) };
}

// ---------- conferência: cada pagamento com a sua venda ----------
// Valores que contam para o pedido: o que o comprador pagou (inclusive o que depois voltou).
const VALE = new Set(['approved', 'refunded', 'charged_back', 'in_mediation', 'partially_refunded', 'authorized']);

// pags = pagamentos da janela; todos = todos os pagamentos guardados (para somar o pedido e ver
// se a venda tem pagamento); vendas = pedidos do painel ({order_id, data, status, itens,
// envio_id, titulo}); notas = mp_conferencia por chave; creditosLigados = {id do pagamento:
// {claim_id, order_id}}. Função pura: testada.
function conferenciaDe({ pags, todos = pags, vendas, vendasJanela = [], notas = {}, creditosLigados = {}, cobertura = null }) {
  const porPedido = new Map(vendas.map((v) => [Number(v.order_id), v]));
  const porEnvio = new Map(vendas.filter((v) => v.envio_id).map((v) => [Number(v.envio_id), v]));
  const somaPedido = new Map(), fretePedido = new Map(), freteCobrado = new Map();
  const pedidosComPag = new Set(), enviosComPag = new Set();
  for (const p of todos) {
    if (p.order_id) {
      pedidosComPag.add(Number(p.order_id));
      if (VALE.has(p.status)) {
        somaPedido.set(p.order_id, n(somaPedido.get(p.order_id)) + n(p.bruto) + n(p.frete_cobrado));
        fretePedido.set(p.order_id, n(fretePedido.get(p.order_id)) + n(p.frete));
        freteCobrado.set(p.order_id, n(freteCobrado.get(p.order_id)) + n(p.frete_cobrado));
      }
    }
    if (p.envio_id) enviosComPag.add(Number(p.envio_id));
  }
  const vendaDe = (v, por) => (v ? { order_id: v.order_id, data: v.data, itens: v.itens, titulo: v.titulo || null, por } : null);
  const itens = [];
  for (const p of pags) {
    const chave = `pag:${p.id}`;
    const nota = notas[chave];
    let situacao = 'pendente', motivo = '', venda = null;
    const cancelado = p.status === 'cancelled' || p.status === 'rejected';
    if (nota?.order_id) {
      const v = porPedido.get(Number(nota.order_id));
      venda = vendaDe(v || { order_id: Number(nota.order_id) }, 'manual');
      situacao = 'ok'; motivo = v ? 'Ligado à mão.' : `Ligado à mão ao pedido ${nota.order_id} (ele não está nas vendas copiadas pelo painel).`;
    } else if (p.envio_id) {
      const v = porEnvio.get(Number(p.envio_id));
      venda = vendaDe(v, 'envio');
      if (v) { situacao = 'ok'; motivo = `Frete pago à parte pelo comprador (envio ${p.envio_id}).`; }
      else motivo = `Frete pago à parte do envio ${p.envio_id}, que não está nas vendas copiadas pelo painel.`;
    } else if (p.tipo === 'venda' && p.order_id) {
      const v = porPedido.get(Number(p.order_id));
      venda = vendaDe(v, 'pedido');
      if (cancelado) { situacao = 'explicado'; motivo = 'Pagamento cancelado ou recusado: nenhum dinheiro entrou.'; }
      else if (!v) motivo = `O pedido ${p.order_id} não está nas vendas copiadas pelo painel. Abra Pedidos no período da compra para o painel copiá-lo.`;
      else {
        const dif = r2(n(somaPedido.get(p.order_id)) - n(v.itens));
        if (Math.abs(dif) < 0.02) situacao = 'ok';
        // frete do comprador: dentro do bruto (cobrado de volta como frete do vendedor) ou à parte
        // no shipping_amount do mesmo pagamento
        else if (dif > 0 && (n(fretePedido.get(p.order_id)) >= dif - 0.02 || Math.abs(dif - n(freteCobrado.get(p.order_id))) < 0.02)) { situacao = 'ok'; motivo = `Inclui ${brl(dif)} de frete pago pelo comprador.`; }
        else motivo = `O comprador pagou ${brl(somaPedido.get(p.order_id))} e os itens da venda somam ${brl(v.itens)} (diferença de ${brl(dif)}).`;
      }
    } else if (/bonificaciones_flex/i.test(p.descricao || '')) {
      situacao = 'explicado'; motivo = 'Bônus do Mercado Envios Flex. O Mercado Pago não informa a qual envio ele se refere.';
    } else if (/reclama/i.test(p.descricao || '') || (creditosLigados[p.id] && !p.descricao)) {
      const c = creditosLigados[p.id];
      if (c) {
        venda = vendaDe(porPedido.get(Number(c.order_id)) || (c.order_id ? { order_id: c.order_id } : null), 'reclamacao');
        situacao = 'ok'; motivo = `Crédito do ML pela reclamação ${c.claim_id}, ligado pelo valor e pela data.`;
      } else motivo = 'Crédito do ML por reclamação: o Mercado Pago não informa a venda e o valor não bate com nenhuma devolução guardada. Se souber a venda, ligue à mão.';
    } else if (cancelado) {
      situacao = 'explicado'; motivo = 'Pagamento cancelado ou recusado: nenhum dinheiro entrou.';
    } else motivo = p.descricao ? `Crédito sem venda informada pelo Mercado Pago: "${p.descricao}".`
      : 'Crédito do Mercado Livre sem descrição e sem venda informada. Se for de uma devolução, digite o valor dele na tela Devoluções (crédito do ML) que ele é ligado sozinho — ou ligue à mão aqui.';
    itens.push({ chave, tipo: 'pagamento', pag_id: p.id, ml_user_id: p.ml_user_id, data: p.criado, descricao: p.descricao,
      status: p.status, valor: r2(n(p.bruto) + n(p.frete_cobrado)), liquido: p.liquido, situacao, motivo, venda,
      observacao: nota?.observacao || null, conferido: !!nota?.conferido });
  }
  // vendas da janela sem nenhum pagamento (nem pelo pedido, nem pelo envio)
  for (const v of vendasJanela) {
    if (pedidosComPag.has(Number(v.order_id)) || (v.envio_id && enviosComPag.has(Number(v.envio_id)))) continue;
    if (cobertura && (v.data < cobertura.de || v.data > cobertura.ate)) continue;
    const chave = `venda:${v.order_id}`;
    const nota = notas[chave];
    itens.push({ chave, tipo: 'venda', pag_id: null, ml_user_id: v.ml_user_id, data: v.data, descricao: null, status: v.status,
      valor: v.itens, liquido: null, situacao: 'pendente', venda: vendaDe(v, 'pedido'),
      motivo: 'Venda sem pagamento na cópia do Mercado Pago. Se ela foi paga, o pagamento pode ser de outra conta ou ainda não ter sido lido.',
      observacao: nota?.observacao || null, conferido: !!nota?.conferido });
  }
  itens.sort((a, b) => String(b.data).localeCompare(String(a.data)));
  const resumo = { total: itens.length, ok: 0, explicado: 0, pendente: 0, conferido: 0, a_conferir: 0, ligados: 0 };
  for (const i of itens) {
    resumo[i.situacao]++; if (i.conferido) resumo.conferido++; if (i.venda) resumo.ligados++;
    if (i.situacao === 'pendente' && !i.conferido) resumo.a_conferir++;
  }
  return { resumo, itens };
}

// Créditos de reclamação (money_transfer) -> reclamação/venda, pelo crédito digitado na
// devolução (valor exato) e depois pela regra das Devoluções (valor e data). Função pura.
// Crédito SEM descrição (medido: R$ 97,83 em 01/10/2026, o mesmo valor digitado na devolução)
// só é ligado pelo valor digitado, nunca pela regra de valor e data.
function ligarCreditosReclamacao(pags, devolucoes, manuais = {}) {
  const deReclamacao = (p) => /reclama/i.test(p.descricao || '');
  const creditos = pags.filter((p) => p.tipo === 'outro' && p.status === 'approved' && (deReclamacao(p) || !p.descricao))
    .map((p) => ({ id: p.id, valor: n(p.bruto), data: p.criado, reclamacao: deReclamacao(p) }));
  const out = {};
  const usados = new Set(), claimsUsados = new Set();
  const porClaim = new Map(devolucoes.map((d) => [d.claim_id, d]));
  for (const [claim, m] of Object.entries(manuais)) {
    const d = porClaim.get(Number(claim));
    const c = creditos.find((x) => !usados.has(x.id) && Math.abs(x.valor - n(m.valor)) < 0.01 && (!d || x.data >= d.criada_em));
    if (c) { usados.add(c.id); claimsUsados.add(Number(claim)); out[c.id] = { claim_id: Number(claim), order_id: d?.order_id || null }; }
  }
  const { porClaim: lig } = ligarCreditos(creditos.filter((c) => !usados.has(c.id) && c.reclamacao), devolucoes.filter((d) => !claimsUsados.has(d.claim_id)).map((d) => ({
    id: d.claim_id, criada_em: d.criada_em, valor_venda: d.valor_pedido, devolvido: n(d.reembolso_vendedor) + n(d.reembolso_ml),
    mensagem: (() => { try { return JSON.parse(d.detalhe_ml || 'null')?.titulo || ''; } catch { return ''; } })() })));
  for (const [claim, c] of Object.entries(lig)) out[c.id] = { claim_id: Number(claim), order_id: porClaim.get(Number(claim))?.order_id || null };
  return out;
}

function criar({ D, ml }) {
  const isoMp = (d) => new Date(d).toISOString().replace('Z', '-00:00');
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  async function token(mlUserId) {
    await ml('/users/me', {}, mlUserId).catch(() => null);     // renova o token, se for o caso
    const tok = D.contaObter(mlUserId)?.access_token;
    if (!tok) throw new Error('Conta sem acesso.');
    return tok;
  }
  async function mp(tok, caminho, { metodo = 'GET', corpo, texto = false } = {}) {
    const r = await fetch('https://api.mercadopago.com' + caminho, { method: metodo,
      headers: { Authorization: `Bearer ${tok}`, Accept: texto ? 'text/csv' : 'application/json', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok) throw Object.assign(new Error(j?.message || `Mercado Pago respondeu ${r.status}`), { status: r.status, codigo: j?.error });
    return texto ? t : j;
  }

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
      const tok = await token(mlUserId);
      const campo = ultima ? 'date_last_updated' : 'date_created';
      const de = ultima ? new Date(Date.parse(ultima) - 864e5) : new Date(Date.now() - 120 * 864e5);
      for (let offset = 0; offset < 10000; offset += 100) {
        const j = await mp(tok, `/v1/payments/search?sort=${campo}&criteria=asc&range=${campo}`
          + `&begin_date=${encodeURIComponent(isoMp(de))}&end_date=${encodeURIComponent(isoMp(Date.now()))}&limit=100&offset=${offset}`);
        const lista = (j.results || []).filter((x) => String(x.collector_id ?? x.collector?.id) === String(mlUserId) && x.status !== 'rejected');
        D.mpPagamentosGravar(lista.map((x) => pagamentoDe(x, mlUserId)));
        if ((j.results || []).length < 100 || offset + 100 >= (j.paging?.total ?? 0)) break;
      }
      D.configGravar(chave, inicio.toISOString());
    })().finally(() => lendo.delete(mlUserId));
    lendo.set(mlUserId, p);
    return p;
  }

  // ----- extrato: pede o relatório de liberações, espera ficar pronto (~2 min) e importa -----
  // Cada pedido gera um arquivo na conta do Mercado Pago (aparece em Relatórios). Automático no
  // máximo a cada 6 h; a 1ª vez cobre 90 dias; depois, do dia anterior ao último importado.
  // Conta sem a configuração do relatório (404 config_not_found_for_user): só cria quando o
  // vendedor clica em "Ativar" na tela (é uma configuração gravada na conta dele).
  const COLUNAS = ['DATE', 'SOURCE_ID', 'EXTERNAL_REFERENCE', 'RECORD_TYPE', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT',
    'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'FINANCING_FEE_AMOUNT', 'SHIPPING_FEE_AMOUNT', 'TAXES_AMOUNT', 'COUPON_AMOUNT', 'INSTALLMENTS',
    'PAYMENT_METHOD', 'SHIPPING_ID', 'SHIPMENT_MODE', 'ORDER_ID', 'PACK_ID'];
  const meiaNoite = (t) => { const d = new Date(t - 3 * 3600e3); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() + 3 * 3600e3); };
  const semMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const estadoExtrato = new Map();   // ml_user_id -> { situacao, erro, desde }

  async function extratoGerar(mlUserId, { forcar = false, ativar = false } = {}) {
    const atual = estadoExtrato.get(mlUserId);
    if (atual?.situacao === 'gerando') return atual;
    // sem configuração ou erro recente: a tela consulta de novo a cada 15 s — não recomeça
    if (!forcar && !ativar && (atual?.situacao === 'sem_config' || atual?.situacao === 'erro')
      && Date.now() - Date.parse(atual.desde) < 10 * 60e3) return atual;
    const saldos = D.mpExtratoSaldos(mlUserId);
    const ult = saldos.at(-1);
    if (!forcar && !ativar && ult && Date.now() - Date.parse(ult.importado) < 6 * 3600e3) return { situacao: 'pronto' };
    const est = { situacao: 'gerando', desde: new Date().toISOString(), erro: null };
    estadoExtrato.set(mlUserId, est);
    const tarefa = (async () => {
      const tok = await token(mlUserId);
      try { await mp(tok, '/v1/account/release_report/config'); }
      catch (e) {
        if (e.status !== 404) throw e;
        if (!ativar) { Object.assign(est, { situacao: 'sem_config', erro: null }); return; }
        await mp(tok, '/v1/account/release_report/config', { metodo: 'POST', corpo: { file_name_prefix: `release-${mlUserId}-`,
          show_placeholder_payout: false, include_withdrawal_at_end: false, scheduled: false, execute_after_withdrawal: false,
          columns: COLUNAS.map((key) => ({ key })), separator: ',', frequency: { hour: 0, type: 'daily', value: '' } } });
      }
      const fim = new Date(meiaNoite(Date.now()).getTime() + 864e5 - 1000);
      // pedido que ficou no meio (painel reiniciado): espera aquele mesmo arquivo
      let pedido = null;
      try { pedido = JSON.parse(D.configLer(`mp_extrato_pedido:${mlUserId}`) || 'null'); } catch {}
      if (!pedido || Date.now() - Date.parse(pedido.em) > 30 * 60e3) {
        const inicioBase = ult ? meiaNoite(Date.parse(ult.fim) - 864e5) : meiaNoite(Date.now() - 90 * 864e5);
        let feito = null, ultimoErro = null;
        // a 1ª vez tenta 90 dias; se o Mercado Pago recusar o tamanho, tenta menos
        for (const dias of ult ? [null] : [90, 60, 31]) {
          const inicio = dias ? meiaNoite(Date.now() - dias * 864e5) : inicioBase;
          try { await mp(tok, '/v1/account/release_report', { metodo: 'POST', corpo: { begin_date: semMs(inicio), end_date: semMs(fim) } }); feito = inicio; break; }
          catch (e) { ultimoErro = e; if (e.status !== 400) throw e; }
        }
        if (!feito) throw ultimoErro;
        pedido = { inicio: semMs(feito), fim: semMs(fim), em: new Date().toISOString() };
        D.configGravar(`mp_extrato_pedido:${mlUserId}`, JSON.stringify(pedido));
      }
      // espera o arquivo (medido: ~2 min); até 15 min
      for (let i = 0; i < 90; i++) {
        await espera(i === 0 ? 20000 : 10000);
        const lista = await mp(tok, '/v1/account/release_report/list');
        const arq = (Array.isArray(lista) ? lista : []).find((x) => x.file_name && Date.parse(x.begin_date) === Date.parse(pedido.inicio)
          && Math.abs(Date.parse(x.end_date) - Date.parse(pedido.fim)) < 2000);
        if (!arq) continue;
        const csv = await mp(tok, `/v1/account/release_report/${encodeURIComponent(arq.file_name)}`, { texto: true });
        const r = lerRelatorio(csv);
        D.mpExtratoImportar(mlUserId, { inicio: new Date(pedido.inicio).toISOString(), fim: new Date(pedido.fim).toISOString(),
          saldo_inicial: r.saldo_inicial, saldo_final: r.saldo_final ?? r2(r.saldo_inicial + r.linhas.reduce((a, m) => a + m.credito - m.debito, 0)), linhas: r.linhas });
        D.configGravar(`mp_extrato_pedido:${mlUserId}`, null);
        Object.assign(est, { situacao: 'pronto' });
        return;
      }
      throw new Error('O Mercado Pago não terminou o relatório em 15 minutos. Tente de novo mais tarde.');
    })().catch((e) => Object.assign(est, { situacao: 'erro', erro: e.message }));
    // a conta sem configuração responde em ~1 s: a tela já mostra "Ativar" na 1ª consulta
    await Promise.race([tarefa, espera(5000)]);
    return est;
  }

  const contasAlvo = (url) => {
    const contas = D.contasListar();
    const pedida = Number(url.searchParams.get('conta')) || null;
    const alvo = pedida ? contas.filter((c) => c.ml_user_id === pedida) : contas;
    if (!alvo.length) throw Object.assign(new Error('Nenhuma conta do Mercado Livre conectada.'), { status: 409 });
    return { contas, pedida, alvo, nomes: Object.fromEntries(contas.map((c) => [c.ml_user_id, c.nickname])) };
  };
  const linkPedido = (id) => (id ? `https://www.mercadolivre.com.br/vendas/${id}/detalhe` : null);
  const diasDe = (url, ok, padrao) => (ok.includes(Number(url.searchParams.get('dias'))) ? Number(url.searchParams.get('dias')) : padrao);

  const rotas = {
    // ?conta=ID (ou vazio = todas as contas do ML) &dias=7|15|30|60|90
    'GET /api/financeiro': async (url) => {
      const { contas, pedida, alvo, nomes } = contasAlvo(url);
      const dias = diasDe(url, [7, 15, 30, 60, 90], 30);
      const erros = [];
      for (const c of alvo) {
        try { await sincronizar(c.ml_user_id, url.searchParams.get('recarregar') === '1'); }
        catch (e) { erros.push(`${c.nickname}: ${e.message}`); }
      }
      const de = new Date(Date.now() - dias * 864e5).toISOString();
      const ate = new Date(Date.now() + 120 * 864e5).toISOString();
      const pags = alvo.flatMap((c) => D.mpPagamentos(c.ml_user_id, de, ate));
      return { dias, contas: contas.map((c) => ({ ml_user_id: c.ml_user_id, nickname: c.nickname })), conta: pedida, erros,
        ...financeiroDe(pags, { dias }),
        pagamentos: pags.filter((p) => p.status !== 'rejected').slice(0, 3000).map((p) => ({ ...p, conta_nome: nomes[p.ml_user_id] || null,
          link_pedido: linkPedido(p.order_id) })),
        lido_em: alvo.map((c) => D.configLer(`mp_lido_em:${c.ml_user_id}`)).filter(Boolean).sort()[0] || null };
    },

    // Extrato: movimentos do relatório de liberações com o saldo após cada um. Pede um relatório
    // novo em segundo plano quando o último tem mais de 6 h (a tela consulta de novo).
    'GET /api/financeiro/extrato': async (url) => {
      const { contas, pedida, alvo, nomes } = contasAlvo(url);
      const dias = diasDe(url, [7, 15, 30, 60, 90], 30);
      const de = new Date(Date.now() - dias * 864e5).toISOString();
      const situacoes = [];
      const movimentos = [];
      const porDia = new Map();
      let saldoAtual = 0, temSaldo = false;
      for (const c of alvo) {
        const est = await extratoGerar(c.ml_user_id).catch((e) => ({ situacao: 'erro', erro: e.message }));
        const saldos = D.mpExtratoSaldos(c.ml_user_id);
        const ex = extratoDe(D.mpExtrato(c.ml_user_id), saldos);
        const pags = new Map(D.mpPagamentosConta(c.ml_user_id).map((p) => [String(p.id), p]));
        if (ex.saldo_atual != null) { saldoAtual += ex.saldo_atual; temSaldo = true; }
        situacoes.push({ ml_user_id: c.ml_user_id, nickname: c.nickname, situacao: est.situacao, erro: est.erro || null, desde: est.desde || null,
          inicio: saldos[0]?.inicio || null, fim: saldos.at(-1)?.fim || null, importado: saldos.at(-1)?.importado || null,
          saldo: ex.saldo_atual, confere: ex.confere });
        for (const m of ex.movimentos) {
          if (m.data < de) continue;
          const p = m.source_id ? pags.get(String(m.source_id)) : null;
          movimentos.push({ data: m.data, tipo: m.tipo, nome: nomeTipo(m.tipo), credito: m.credito, debito: m.debito, saldo: m.saldo,
            source_id: m.source_id, ml_user_id: c.ml_user_id, conta_nome: nomes[c.ml_user_id],
            order_id: p?.order_id || null, envio_id: p?.envio_id || null, descricao: p?.descricao || null, link_pedido: linkPedido(p?.order_id) });
        }
        for (const d of ex.dias) {
          const x = porDia.get(d.dia) || { dia: d.dia, entradas: 0, saidas: 0, saques: 0, saldo: 0, contas: {} };
          x.entradas += d.entradas; x.saidas += d.saidas; x.saques += d.saques; x.contas[c.ml_user_id] = d.saldo;
          porDia.set(d.dia, x);
        }
      }
      // saldo do dia somando as contas: cada uma com o último saldo conhecido até aquele dia
      const ultimo = {};
      const diasLista = [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map((d) => {
        Object.assign(ultimo, d.contas);
        return { dia: d.dia, entradas: r2(d.entradas), saidas: r2(d.saidas), saques: r2(d.saques), saldo: r2(Object.values(ultimo).reduce((a, v) => a + v, 0)) };
      }).filter((d) => d.dia >= diaLocal(de));
      movimentos.sort((a, b) => b.data.localeCompare(a.data));
      const porTipo = {};
      for (const m of movimentos) {
        const t = porTipo[m.tipo] || (porTipo[m.tipo] = { tipo: m.tipo, nome: m.nome, credito: 0, debito: 0, qtd: 0 });
        t.credito += m.credito; t.debito += m.debito; t.qtd++;
      }
      return { dias, conta: pedida, contas: contas.map((c) => ({ ml_user_id: c.ml_user_id, nickname: c.nickname })), situacoes,
        saldo_atual: temSaldo ? r2(saldoAtual) : null,
        resumo: { entradas: r2(movimentos.reduce((a, m) => a + m.credito, 0)), saidas: r2(movimentos.reduce((a, m) => a + m.debito, 0)),
          saques: r2(movimentos.filter((m) => m.tipo === 'payout' || m.tipo === 'withdrawal').reduce((a, m) => a + m.debito, 0)),
          qtd_saques: movimentos.filter((m) => m.tipo === 'payout' || m.tipo === 'withdrawal').length,
          por_tipo: Object.values(porTipo).map((t) => ({ ...t, credito: r2(t.credito), debito: r2(t.debito), liquido: r2(t.credito - t.debito) }))
            .sort((a, b) => Math.abs(b.liquido) - Math.abs(a.liquido)) },
        por_dia: diasLista, movimentos: movimentos.slice(0, 5000) };
    },
    // body { conta, ativar } — pede um relatório agora; ativar=true cria a configuração do relatório
    'POST /api/financeiro/extrato/gerar': async (_url, body) => {
      const id = Number(body?.conta);
      const c = D.contasListar().find((x) => x.ml_user_id === id);
      if (!c) throw Object.assign(new Error('Conta não encontrada.'), { status: 404 });
      const est = await extratoGerar(id, { forcar: true, ativar: body?.ativar === true });
      return { situacao: est.situacao, erro: est.erro || null };
    },

    // Conferência: cada pagamento da janela com a sua venda (ou o motivo de não ter), mais as
    // vendas sem pagamento. ?conta= &dias=30|60|90|120
    'GET /api/financeiro/conferencia': async (url) => {
      const { contas, pedida, alvo, nomes } = contasAlvo(url);
      const dias = diasDe(url, [7, 15, 30, 60, 90, 120], 30);
      const de = new Date(Date.now() - dias * 864e5).toISOString();
      const erros = [];
      const notas = D.mpConferencias();
      const manuais = D.creditosManuais();
      const resumo = { total: 0, ok: 0, explicado: 0, pendente: 0, conferido: 0, a_conferir: 0, ligados: 0 };
      let itens = [];
      for (const c of alvo) {
        try { await sincronizar(c.ml_user_id); } catch (e) { erros.push(`${c.nickname}: ${e.message}`); }
        const todos = D.mpPagamentosConta(c.ml_user_id);
        const pags = todos.filter((p) => p.criado >= de);
        const lido = D.configLer(`mp_lido_em:${c.ml_user_id}`);
        const vendasJanela = D.mpVendasDesde(c.ml_user_id, de).map((v) => ({ ...v, ml_user_id: c.ml_user_id }));
        const desde = todos.length ? todos.at(-1).criado : de;
        // pedidos citados fora da janela (pagamento de venda antiga, ligação à mão, reclamação)
        const devol = D.devolucoesListar(c.ml_user_id, '2000-01-01', new Date().toISOString());
        const lig = ligarCreditosReclamacao(todos, devol, manuais);
        const citados = [...new Set([...pags.map((p) => p.order_id), ...Object.values(notas).map((x) => x.order_id), ...Object.values(lig).map((x) => x.order_id)]
          .filter(Boolean).map(Number))].filter((id) => !vendasJanela.some((v) => v.order_id === id));
        const porEnvio = pags.filter((p) => p.envio_id).map((p) => p.envio_id);
        const extra = [...D.mpVendasDosPedidos(citados),
          ...(porEnvio.length ? D.db.prepare(`SELECT order_id FROM vendas WHERE envio_id IN (${porEnvio.map(() => '?').join(',')})`).all(...porEnvio)
            .map((r) => r.order_id).filter((id) => !vendasJanela.some((v) => v.order_id === id) && !citados.includes(id))
            .reduce((a, id) => a.concat(D.mpVendasDosPedidos([id])), []) : [])];
        const r = conferenciaDe({ pags, todos, vendas: [...vendasJanela, ...extra], notas, creditosLigados: lig,
          vendasJanela: vendasJanela.filter((v) => v.status !== 'cancelled'),
          cobertura: { de: desde > de ? desde : de, ate: lido ? new Date(Date.parse(lido) - 10 * 60e3).toISOString() : new Date().toISOString() } });
        for (const k of Object.keys(resumo)) resumo[k] += r.resumo[k];
        itens = itens.concat(r.itens.map((i) => ({ ...i, conta_nome: nomes[i.ml_user_id] || null,
          venda: i.venda ? { ...i.venda, link: linkPedido(i.venda.order_id) } : null })));
      }
      itens.sort((a, b) => String(b.data).localeCompare(String(a.data)));
      return { dias, conta: pedida, contas: contas.map((c) => ({ ml_user_id: c.ml_user_id, nickname: c.nickname })), erros, resumo, itens };
    },
  };

  const rotasParam = [
    // Anotação da conferência: venda ligada à mão, observação e "conferido". Tudo vazio apaga.
    { m: 'PUT', re: /^\/api\/financeiro\/conferencia\/((?:pag|venda):\d+)$/, fn: async ([chave], body) => {
      const id = Number(chave.split(':')[1]);
      const dono = chave.startsWith('pag:')
        ? D.db.prepare('SELECT ml_user_id FROM mp_pagamentos WHERE id=?').get(id)?.ml_user_id
        : D.db.prepare('SELECT ml_user_id FROM vendas WHERE order_id=? LIMIT 1').get(id)?.ml_user_id;
      if (!dono) throw Object.assign(new Error('Pagamento ou venda não encontrado.'), { status: 404 });
      const txt = String(body?.order_id ?? '').replace(/\D/g, '');
      if (txt && (txt.length < 8 || txt.length > 20)) throw Object.assign(new Error('Número do pedido inválido.'), { status: 400 });
      const observacao = String(body?.observacao ?? '').trim().slice(0, 500) || null;
      D.mpConferenciaGravar(chave, dono, { order_id: txt ? Number(txt) : null, observacao, conferido: body?.conferido === true });
      return { ok: true };
    } },
  ];
  return { rotas, rotasParam, sincronizar };
}

module.exports = { criar, pagamentoDe, financeiroDe, lerRelatorio, extratoDe, conferenciaDe, ligarCreditosReclamacao, nomeTipo };
