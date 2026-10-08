'use strict';
// Devoluções e reclamações (API /post-purchase) com o dinheiro de cada uma, separado por
// quem pagou o quê.
//
// Medido em 28/09/2026 numa conta real:
//   - /post-purchase/v1/claims/search recusa busca sem filtro; aceita type=returns|mediations,
//     sort=date_created:desc e range=date_created:after:<ISO>.
//   - O REEMBOLSO AO COMPRADOR SAI DA VENDA DO VENDEDOR: no pagamento do Mercado Pago
//     (api.mercadopago.com/v1/payments/{id}, mesmo token) todo reembolso vinha com
//     refunds[].source.type "bpp", inclusive o "não quero mais" — e o dinheiro da venda, retido,
//     era liberado no mesmo segundo do reembolso. "bpp" é o caminho, não quem pagou.
//   - QUANDO O ML COMPENSA (produto voltou avariado e a revisão foi a favor), ele deposita um
//     crédito à parte: money_transfer "Entrada de dinheiro correspondente a sua reclamação"
//     (ou "Reembolso de Compra Garantida por sua reclamação") em /v1/payments/search. Não traz o
//     id da reclamação: é ligado pelo valor e pela data (creditosDoML). 25 em 90 dias na conta;
//     o de 14/09 (R$ 160,72) era o valor cheio da venda da reclamação 5570598790.
//   - O mesmo pagamento traz charges_details: frete de ida (type shipping) e tarifas (type
//     fee) com original e refunded — o que o ML estornou ao vendedor. Numa devolução de
//     24/09 o frete de ida de R$ 27,41 voltou inteiro: contar o frete de ida como perdido
//     (o que este arquivo fazia antes) superestimava o custo.
//   - Frete de volta cobrado = /post-purchase/v1/claims/{id}/charges/return-cost. O
//     receiver.cost do envio de volta é o valor CHEIO da etiqueta (fica só como informação).
//   - Produto que volta avariado: o vendedor abre uma revisão; /post-purchase/v1/returns/{id}/
//     reviews dá seller_reason (SRF2 = "O produto chegou avariado") e seller_status
//     ("success" = a favor do vendedor). /post-purchase/v1/claims/{id}/detail traz o texto do
//     ML, ex.: "Liberamos parte do valor do produto que devolveram para você … creditar o
//     valor correspondente no Mercado Pago em 14 de setembro".

const { custoDoSku, skusDoAnuncio } = require('./custos.js');

const TIPOS = { returns: 'Devolução', mediations: 'Reclamação' };
const DIAS_OK = [7, 15, 30, 60, 90, 180];

const STATUS_DEVOLUCAO = {
  pending: 'Aguardando envio', label_generated: 'Etiqueta gerada', ready_to_ship: 'Pronta para envio',
  shipped: 'A caminho', delivered: 'Entregue ao vendedor', not_delivered: 'Não entregue',
  cancelled: 'Cancelada', expired: 'Expirada', closed: 'Encerrada', failed: 'Falhou',
  to_be_reviewed: 'Em revisão', in_review: 'Em revisão',
};
const RESOLUCAO = {
  item_returned: 'Produto devolvido', payment_refunded: 'Dinheiro devolvido ao comprador',
  no_bpp: 'Sem cobertura (a favor do vendedor)', coverage_decision: 'Decisão do ML',
  partial_refunded: 'Reembolso parcial', buyer_claim_opened: 'Comprador abriu reclamação',
  item_changed: 'Produto trocado', expired: 'Expirou', warehouse_decision: 'Decisão do Full',
  already_shipped: 'Já tinha sido enviado', respondent_timeout: 'Vendedor não respondeu a tempo',
  opened_claim_by_mistake: 'Aberta por engano', seller_explained_functions: 'Vendedor explicou o uso',
  product_delivered: 'Produto entregue', found_missing_parts: 'Peças encontradas',
};
// Motivos da revisão aberta pelo vendedor (/post-purchase/v1/returns/reasons, medido).
const REVISAO = {
  SRF2: 'O produto chegou avariado', SRF3: 'A devolução está incompleta',
  SRF4: 'O produto devolvido é diferente do enviado', SRF5: 'O produto não está no pacote',
  SRF6: 'Outro defeito no produto', SRF7: 'A devolução ainda não chegou',
};
const PRODUTO_RUIM = new Set(['SRF2', 'SRF3', 'SRF4', 'SRF5', 'SRF6']);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const soma = (a) => a.reduce((s, x) => s + num(x), 0);
const cent = (v) => Math.round(v * 100) / 100;

// Dinheiro de um pagamento do Mercado Pago: quanto voltou ao comprador (sai da venda), frete
// de ida e tarifas (original e estornado). reembolso_ml fica 0: a compensação do ML é um
// crédito separado (creditosDoML). Função pura: testada em test-promocoes.js.
function dinheiroDoPagamento(p) {
  const out = { reembolso_ml: 0, reembolso_vendedor: 0, frete_ida: 0, frete_ida_estornado: 0,
    tarifas: 0, tarifas_estornadas: 0 };
  for (const r of p?.refunds || []) {
    if (r.status && r.status !== 'approved') continue;
    out.reembolso_vendedor += num(r.amount);
  }
  for (const c of p?.charges_details || []) {
    if (c.accounts?.from !== 'collector') continue;   // financing_transfer (payer>collector) é receita
    if (c.type === 'shipping') { out.frete_ida += num(c.amounts?.original); out.frete_ida_estornado += num(c.amounts?.refunded); }
    if (c.type === 'fee') { out.tarifas += num(c.amounts?.original); out.tarifas_estornadas += num(c.amounts?.refunded); }
  }
  return out;
}

// Custo da reclamação para o vendedor, por origem, e o resultado depois do crédito do ML.
// Função pura: testada.
//   - frete de volta: o que o ML cobrou pela etiqueta de devolução;
//   - venda desfeita (dinheiro devolvido ao comprador): o frete de ida e as tarifas que o ML
//     NÃO estornou viram custo; os estornados não;
//   - produto perdido: não voltou (e o dinheiro foi devolvido), ou voltou avariado/incompleto
//     (revisão SRF2..SRF6) — perde o custo do produto (tabela Produtos); sem custo cadastrado,
//     no caso de não voltar, conta o valor devolvido;
//   - crédito do ML: o que o ML depositou por essa reclamação; resultado = crédito − custo.
// Produto que voltou está com defeito (não pode voltar à venda)? Vale a marcação do vendedor;
// sem marcação, a sugestão vem da revisão do ML (avariado, incompleto, diferente…).
function comDefeito(d) {
  if (d.defeito === true || d.defeito === false) return d.defeito;
  let rev = null;
  try { rev = typeof d.revisao === 'string' ? JSON.parse(d.revisao) : d.revisao; } catch {}
  return !!(rev && PRODUTO_RUIM.has(rev.motivo));
}

// Custo da reclamação para o vendedor. Pedido do dono (29/09/2026): no custo da devolução
// entra SÓ o custo da peça com defeito (não volta à venda); produto que voltou em bom estado
// volta ao estoque e não soma. Fretes e tarifas perdidos ficam numa linha própria (é dinheiro
// que saiu, mas não é "peça perdida"). Produto que nem voltou conta como perdido.
function custoDa(d) {
  const voltou = ['delivered', 'shipped', 'closed'].includes(d.status_devolucao);
  const devolvido = num(d.reembolso_vendedor) + num(d.reembolso_ml);
  const freteVolta = num(d.tarifa_devolucao);
  const freteIdaPerdido = devolvido > 0 ? Math.max(0, num(d.frete_ida) - num(d.frete_ida_estornado)) : 0;
  const tarifasPerdidas = devolvido > 0 ? Math.max(0, num(d.tarifas) - num(d.tarifas_estornadas)) : 0;
  // Kit: o vendedor marca QUAIS produtos do anúncio estão com defeito (posições em
  // d.componentes); só eles somam, vezes a quantidade devolvida. Sem essa marcação (anúncio
  // de um produto só, marcação antiga ou sugestão do ML), vale o custo do anúncio inteiro.
  const comps = Array.isArray(d.componentes) ? d.componentes : [];
  const porProduto = Array.isArray(d.defeito_produtos) && comps.length > 0;
  const marcados = porProduto ? [...new Set(d.defeito_produtos)].filter((i) => comps[i]) : [];
  // Pedido do dono (30/09/2026): dá para marcar defeito em QUALQUER reclamação, não só nas
  // que o produto já voltou (ex.: o comprador ficou com a peça e recebeu o dinheiro). A
  // marcação do vendedor vale sempre; a sugestão da revisão do ML, só com o produto de volta.
  const marcou = d.defeito === true || d.defeito === false;
  const defeito = marcou ? (porProduto ? marcados.length > 0 : d.defeito) : voltou && comDefeito(d);
  const pecaDefeito = !defeito ? 0
    : porProduto ? marcados.reduce((s, i) => s + num(comps[i].custo), 0) * (d.quantidade || 1)
      : num(d.custo_produto);
  // Não voltou e o dinheiro foi devolvido: perde o produto inteiro — a não ser que o vendedor
  // tenha marcado as peças com defeito (aí vale o que ele marcou, sem somar duas vezes).
  const naoVoltou = devolvido > 0 && !voltou && !defeito ? (d.custo_produto != null ? num(d.custo_produto) : devolvido) : 0;
  const fretes = freteVolta + freteIdaPerdido + tarifasPerdidas;
  const total = pecaDefeito + naoVoltou;
  const credito = num(d.credito_ml);
  return { frete_volta: cent(freteVolta), frete_ida_perdido: cent(freteIdaPerdido),
    tarifas_perdidas: cent(tarifasPerdidas), fretes: cent(fretes),
    defeito, produtos_defeito: defeito && porProduto ? marcados : null,
    peca_defeito: cent(pecaDefeito), nao_voltou: cent(naoVoltou),
    perda_produto: cent(pecaDefeito + naoVoltou), total: cent(total),
    credito_ml: cent(credito), resultado: cent(credito - total - fretes) };
}

// Liga os créditos do ML ("Entrada de dinheiro correspondente a sua reclamação") às
// reclamações. O crédito não traz o id da reclamação: vale o valor igual ao da venda (ou ao
// devolvido) depois da abertura; senão, a reclamação que o ML disse ter "liberado" o valor,
// aberta antes e mais perto da data. Função pura: testada.
// Só VALOR EXATO (venda ou devolvido) e crédito depois da abertura. Medido com os dados reais:
// o crédito de "Liberamos o valor…" nem sempre é o preço da venda (R$ 41,85 numa venda de
// R$ 140,45), então ligar parciais por proximidade de data atribuía errado. O que não bate
// fica "sem reclamação identificada": entra no total (exato), mas não vai para a linha errada.
function ligarCreditos(creditos, reclamacoes) {
  const usados = new Set();
  const porClaim = {};
  const semDono = [];
  const libera = (r) => /liberamos/i.test(r.mensagem || '');
  for (const c of [...creditos].sort((a, b) => a.data.localeCompare(b.data))) {
    const igual = (v) => v != null && Math.abs(v - c.valor) < 0.01;
    const alvo = reclamacoes.filter((r) => !usados.has(r.id) && r.criada_em <= c.data
        && (igual(r.valor_venda) || igual(r.devolvido)))
      .sort((a, b) => (libera(b) - libera(a)) || b.criada_em.localeCompare(a.criada_em))[0];
    if (alvo) { usados.add(alvo.id); porClaim[alvo.id] = c; } else semDono.push(c);
  }
  return { porClaim, semDono };
}

function criar({ ml, mlPaciente, emLotes, contaOuErro, D }) {
  const isoML = (d) => new Date(d).toISOString().replace('Z', '-00:00');

  async function buscar(conta, tipo, desde) {
    const base = `/post-purchase/v1/claims/search?type=${tipo}&sort=date_created:desc`
      + `&range=date_created:after:${encodeURIComponent(isoML(desde))}&limit=50`;
    const p1 = await mlPaciente(`${base}&offset=0`, conta.ml_user_id);
    const total = Math.min(p1.paging?.total ?? 0, 1000);
    const offsets = [];
    for (let off = 50; off < total; off += 50) offsets.push(off);
    const resto = await emLotes(offsets, 3, (off) => mlPaciente(`${base}&offset=${off}`, conta.ml_user_id));
    return [p1, ...resto].flatMap((p) => p.data || []).filter((c) => ehVendedor(c, conta.ml_user_id));
  }

  // A busca de reclamações traz também as que a conta abriu COMO COMPRADORA (medido em
  // 28/09/2026: o vendedor reclamou de uma lava-autos e de formas de silicone compradas de outros
  // vendedores, e elas entravam como devoluções dela). Só vale a reclamação em que a conta
  // é a parte reclamada (respondent: seller/sender).
  const ehVendedor = (c, contaId) => (c.players || [])
    .some((p) => p.role === 'respondent' && Number(p.user_id) === Number(contaId));

  // Lê as reclamações da conta desde "de" e grava as que mudaram (a tela e a baixa do estoque usam).
  async function atualizar(conta, de) {
    const claims = (await Promise.all(Object.keys(TIPOS).map((t) => buscar(conta, t, de)))).flat();
    // reclamação de envio gravada antes de o pedido ser buscado pelo envio: detalha de novo
    const semPedido = new Set(D.db.prepare('SELECT claim_id FROM devolucoes WHERE ml_user_id=? AND order_id IS NULL')
      .all(conta.ml_user_id).map((r) => r.claim_id));
    const mudaram = claims.filter((c) => D.devolucaoAtualizadaEm(c.id) !== c.last_updated
      || (c.resource === 'shipment' && semPedido.has(c.id)));
    await emLotes(mudaram, 2, async (c) => D.devolucaoGravar(await detalhar(conta, c)));
    claims.detalhadas = mudaram.length;   // quantas foram lidas de novo agora (a tela mostra)
    return claims;
  }

  const motivos = new Map();
  async function motivo(id) {
    if (!id) return null;
    if (motivos.has(id)) return motivos.get(id);
    const guardado = D.configLer(`motivo_claim:${id}`);
    if (guardado) { motivos.set(id, guardado); return guardado; }
    const r = await ml(`/post-purchase/v1/claims/reasons/${encodeURIComponent(id)}`).catch(() => null);
    const txt = r?.detail || r?.name || null;
    if (txt) { D.configGravar(`motivo_claim:${id}`, txt); motivos.set(id, txt); }
    return txt;
  }

  // Leitura no Mercado Pago com o mesmo token da conta (renovado pelo ml() logo antes).
  async function mp(caminho, contaId) {
    const conta = D.contaObter(contaId);
    const r = await fetch('https://api.mercadopago.com' + caminho, {
      headers: { Authorization: `Bearer ${conta.access_token}`, Accept: 'application/json' },
    });
    if (!r.ok) throw Object.assign(new Error(`Mercado Pago respondeu ${r.status}`), { status: r.status });
    return r.json();
  }

  const custoEnvio = async (envio, papel, contaId) => {
    if (!envio) return null;
    const c = await mlPaciente(`/shipments/${envio}/costs`, contaId).catch(() => null);
    if (!c) return null;
    if (papel === 'receiver') return Number.isFinite(c.receiver?.cost) ? c.receiver.cost : null;
    const s = (c.senders || []).find((x) => Number(x.user_id) === Number(contaId));
    return s && Number.isFinite(s.cost) ? s.cost : null;
  };

  // Completa uma reclamação com pedido, dinheiro (quem pagou o quê), revisão e notas.
  // ~10 chamadas; só roda quando a reclamação mudou.
  async function detalhar(conta, c) {
    const contaId = conta.ml_user_id;
    const vendedor = (c.players || []).find((p) => Number(p.user_id) === Number(contaId));
    const base = {
      claim_id: c.id, ml_user_id: contaId, tipo: c.type, status: c.status, etapa: c.stage,
      motivo_id: c.reason_id, criada_em: new Date(c.date_created).toISOString(),
      atualizada_em: c.last_updated, resolucao: c.resolution?.reason || null,
      beneficiado: (c.resolution?.benefited || []).join(',') || null,
      cobertura_ml: c.resolution ? (c.resolution.applied_coverage ? 1 : 0) : null,
      acoes: JSON.stringify((vendedor?.available_actions || []).map((a) => ({ acao: a.action, prazo: a.due_date,
        obrigatoria: !!a.mandatory }))),
      nf_venda: JSON.stringify({ encontrada: false }), nf_devolucao: JSON.stringify({ encontrada: false }),
      reembolso_ml: 0, reembolso_vendedor: 0,
    };
    // Reclamação de envio ("Não recebi o pacote"): o recurso é o envio; o pedido vem dele.
    let orderId = c.resource === 'order' ? c.resource_id : null;
    if (c.resource === 'shipment') {
      const envio = await mlPaciente(`/shipments/${c.resource_id}`, contaId).catch(() => null);
      orderId = envio?.order_id || null;
      base.status_devolucao = null;
      if (!envio) base.atualizada_em = null;
    }
    if (!orderId) return base;
    base.order_id = orderId;

    const [pedido, devol, tarifa, detalhe] = await Promise.all([
      mlPaciente(`/orders/${orderId}`, contaId).catch(() => null),
      c.type === 'returns' || c.stage === 'dispute'
        ? mlPaciente(`/post-purchase/v2/claims/${c.id}/returns`, contaId).catch(() => null) : null,
      mlPaciente(`/post-purchase/v1/claims/${c.id}/charges/return-cost`, contaId).catch(() => null),
      mlPaciente(`/post-purchase/v1/claims/${c.id}/detail`, contaId).catch(() => null),
    ]);
    const oi = pedido?.order_items?.[0];
    base.item_id = devol?.orders?.[0]?.item_id || oi?.item?.id || null;
    base.quantidade = num(devol?.orders?.[0]?.return_quantity) || oi?.quantity || null;
    base.valor_pedido = pedido?.total_amount ?? null;
    base.reembolsado = pedido ? soma((pedido.payments || []).map((p) => p.transaction_amount_refunded)) : null;
    base.tarifa_devolucao = tarifa?.amount ?? null;
    base.status_devolucao = devol?.status || null;
    base.status_dinheiro = devol?.status_money || null;
    base.detalhe_ml = detalhe?.title ? JSON.stringify({ titulo: detalhe.title, descricao: detalhe.description || null }) : null;

    // custo do produto (pelo SKU, tela Produtos) — para o caso de voltar avariado sem cobertura
    const cp = base.item_id ? D.custosDe([base.item_id])[base.item_id]?.custo : null;
    base.custo_produto = cp != null ? cent(cp * (base.quantidade || 1)) : null;

    const envioVolta = (devol?.shipments || []).find((s) => s.type === 'return')?.shipment_id;
    const [ida, volta, nfVenda, nfVolta, revisoes, pagamentos] = await Promise.all([
      custoEnvio(pedido?.shipping?.id, 'sender', contaId),
      custoEnvio(envioVolta, 'receiver', contaId),
      notaFiscal(`/users/${contaId}/invoices/orders/${orderId}`, contaId),
      envioVolta ? notaFiscal(`/users/${contaId}/invoices/shipments/${envioVolta}`, contaId) : { encontrada: false },
      devol?.id && (devol.related_entities || []).includes('reviews')
        ? mlPaciente(`/post-purchase/v1/returns/${devol.id}/reviews`, contaId).catch(() => null) : null,
      Promise.all((pedido?.payments || []).map((p) => mp(`/v1/payments/${p.id}`, contaId).catch(() => null))),
    ]);
    base.frete_volta = volta;
    base.nf_venda = JSON.stringify(nfVenda);
    base.nf_devolucao = JSON.stringify(nfVolta);

    const rr = revisoes?.reviews?.[0]?.resource_reviews?.[0];
    base.revisao = rr ? JSON.stringify({ motivo: rr.seller_reason || null, resultado: rr.seller_status || null,
      etapa: rr.stage || null, condicao: rr.product_condition || null }) : null;

    // Dinheiro pelo Mercado Pago; sem ele, fica o que o pedido do ML diz (reembolso sem origem).
    const mps = pagamentos.filter(Boolean);
    if (mps.length) {
      const d = mps.map(dinheiroDoPagamento).reduce((a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]])));
      Object.assign(base, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, cent(v)])));
      if (!d.frete_ida && ida != null) base.frete_ida = ida;   // envio sem charge no MP
      base.fonte_dinheiro = 'mercadopago';
    } else {
      base.frete_ida = ida;
      base.reembolso_vendedor = num(base.reembolsado);
      base.fonte_dinheiro = 'pedido';
    }
    // Falha passageira não pode ficar guardada: sem atualizada_em, detalha de novo depois.
    if (!pedido || (c.type === 'returns' && !devol) || ((pedido?.payments || []).length && !mps.length)) base.atualizada_em = null;
    return base;
  }

  // Nota do Faturador do ML (GET /users/{id}/invoices/orders|shipments/{id}). 404 = o ML
  // não tem nota ali: emitida por outro sistema, ou (na devolução) ainda não emitida.
  // Medido em 28/09/2026: nas devoluções da conta (envio xd_drop_off, não Full) o envio de
  // volta não tinha nota nenhuma no ML — a de devolução, quando existe, sai do ERP do vendedor.
  async function notaFiscal(caminho, contaId) {
    try {
      const n = await mlPaciente(caminho, contaId);
      return {
        encontrada: true, numero: n.invoice_number ?? null, serie: n.invoice_series ?? null,
        chave: n.attributes?.invoice_key || null, status: n.status || null,
        tipo: n.fiscal_data?.transaction_type || null,
        descricao: n.fiscal_data?.transaction_type_description || null,
        emitida_em: n.issued_date || n.attributes?.authorization_date || null,
        cancelada_em: n.attributes?.cancellation_date || null,
        danfe: n.attributes?.danfe_location || null,
      };
    } catch (e) {
      return { encontrada: false, erro: e.status === 404 ? null : (e.message || 'falhou') };
    }
  }

  async function infoItens(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      try {
        const r = await ml(`/items?ids=${lote.join(',')}&attributes=id,title,thumbnail,permalink,seller_custom_field,attributes,variations`);
        for (const x of r) if (x.code === 200) out[x.body.id] = x.body;
      } catch { /* enfeite */ }
    }
    return out;
  }

  // Produtos que formam o anúncio devolvido: pelo SKU da unidade vendida (guardado na venda);
  // sem ele, pelo SKU atual do anúncio (só quando todas as variações têm o mesmo).
  function componentesDa(l, skusVenda, item, mapa) {
    let sku = skusVenda[`${l.order_id}|${l.item_id}`] || null;
    if (!sku && item) {
      const { base, variacoes } = skusDoAnuncio(item);
      const unicos = [...new Set(variacoes.length ? variacoes.map((v) => v.sku || base) : [base])].filter(Boolean);
      if (unicos.length === 1) sku = unicos[0];
    }
    const c = custoDoSku(sku, mapa);
    return { sku, componentes: c.componentes.map((p) => ({ sku: p.sku || String(p.numero).padStart(3, '0'),
      nome: p.nome, custo: p.custo })) };
  }

  const json = (t) => { try { return JSON.parse(t || 'null'); } catch { return null; } };

  // Créditos do ML por reclamação no Mercado Pago (money_transfer). Medido: ~425
  // money_transfer em 90 dias (a maioria bonificação do Flex); os de reclamação têm
  // "reclamação" na descrição. Cache de 10 min: a tela abre e troca de período seguido.
  let cacheCreditos = null;
  async function creditosDoML(conta, de) {
    const chave = `${conta.ml_user_id}|${de.toISOString().slice(0, 10)}`;
    if (cacheCreditos?.chave === chave && Date.now() - cacheCreditos.em < 10 * 60e3) return cacheCreditos.lista;
    await ml('/users/me');   // renova o token antes de ir ao Mercado Pago
    const base = '/v1/payments/search?sort=date_created&criteria=desc&range=date_created'
      + `&begin_date=${encodeURIComponent(isoML(de))}&end_date=${encodeURIComponent(isoML(new Date(Date.now() + 864e5)))}`
      + '&operation_type=money_transfer&limit=100';
    const lista = [];
    for (let off = 0; off < 3000; off += 100) {
      const r = await mp(`${base}&offset=${off}`, conta.ml_user_id);
      for (const p of r.results || []) {
        if (p.status === 'approved' && Number(p.collector_id) === Number(conta.ml_user_id) && /reclama/i.test(p.description || '')) {
          lista.push({ id: p.id, valor: num(p.transaction_amount), data: new Date(p.date_created).toISOString(),
            descricao: p.description });
        }
      }
      if ((r.results || []).length < 100) break;
    }
    cacheCreditos = { chave, em: Date.now(), lista };
    return lista;
  }

  const rotas = {
    'GET /api/devolucoes': async (url) => {
      const conta = contaOuErro();
      const pedido = Number(url.searchParams.get('dias')) || 30;
      const dias = DIAS_OK.includes(pedido) ? pedido : 30;
      const ate = new Date();
      const de = new Date(ate.getTime() - dias * 864e5);

      const claims = await atualizar(conta, de);

      // Só as reclamações em que a conta é a vendedora; as de compra gravadas antes saem.
      const validas = new Set(claims.map((c) => c.id));
      const linhasTodas = D.devolucoesListar(conta.ml_user_id, de.toISOString(), ate.toISOString());
      const fora = linhasTodas.filter((l) => !validas.has(l.claim_id)).map((l) => l.claim_id);
      if (fora.length) D.db.prepare(`DELETE FROM devolucoes WHERE claim_id IN (${fora.map(() => '?').join(',')})`).run(...fora);
      const linhas = linhasTodas.filter((l) => validas.has(l.claim_id));
      const ids = [...new Set(linhas.map((l) => l.item_id).filter(Boolean))];
      const [info, nomesMotivo] = await Promise.all([
        infoItens(ids),
        Promise.all([...new Set(linhas.map((l) => l.motivo_id))].map(async (m) => [m, await motivo(m)])),
      ]);
      const motivoTxt = Object.fromEntries(nomesMotivo);
      const vendas = D.vendasUnidadesPorItem(conta.ml_user_id, ids, de.toISOString(), ate.toISOString());

      // Créditos do ML: ligados às reclamações pelo valor e pela data.
      let creditos = [], ligacao = { porClaim: {}, semDono: [] }, erroCreditos = null;
      try {
        creditos = await creditosDoML(conta, de);
        // candidatas: todas as reclamações guardadas (o crédito pode ser de uma aberta antes da janela)
        const todas = D.devolucoesListar(conta.ml_user_id, '2000-01-01', ate.toISOString());
        ligacao = ligarCreditos(creditos, todas.map((l) => ({
          id: l.claim_id, criada_em: l.criada_em, valor_venda: l.valor_pedido,
          devolvido: num(l.reembolso_vendedor) + num(l.reembolso_ml),
          mensagem: json(l.detalhe_ml)?.titulo || '', a_favor_revisao: json(l.revisao)?.resultado === 'success',
        })));
      } catch (e) { erroCreditos = e.message; }

      const defeitos = D.defeitosDe();
      const manuais = D.creditosManuais();   // crédito do ML digitado pelo vendedor (vale no lugar do ligado)
      const defeitosProdutos = D.defeitoProdutosDe();
      const skusVenda = D.skusDosPedidos([...new Set(linhas.map((l) => l.order_id).filter(Boolean))]);
      const pedidosDev = [...new Set(linhas.map((l) => l.order_id).filter(Boolean))];
      const clientes = D.compradoresDosPedidos(pedidosDev);
      // Cliente que ainda não está na cópia das vendas (pedido antigo): lê o pedido (até 60 por
      // abertura) e guarda; a busca da tela acha pelo apelido ou pelo nome.
      const semCliente = pedidosDev.filter((id) => !clientes[id]?.apelido && !clientes[id]?.nome).slice(0, 60);
      await emLotes(semCliente, 3, async (id) => {
        const o = await ml(`/orders/${id}`, {}, conta.ml_user_id).catch(() => null);
        if (!o) return;
        const c = { id: o.buyer?.id ?? null, apelido: o.buyer?.nickname || '', nome: [o.buyer?.first_name, o.buyer?.last_name].filter(Boolean).join(' ') };
        D.compradorGravarPedido(id, c);
        clientes[id] = { apelido: c.apelido || null, nome: c.nome || null };
      });
      const mapa = new Map(D.catalogoListar().map((p) => [p.numero, p]));
      const itens = linhas.map((l) => {
        const auto = ligacao.porClaim[l.claim_id] || null;
        const manual = manuais[l.claim_id] || null;
        const cred = manual ? { valor: manual.valor, data: manual.gravado_em, descricao: 'informado por você', manual: true,
          automatico: auto ? auto.valor : null } : auto;
        const marcado = defeitos[l.claim_id];
        const kit = componentesDa(l, skusVenda, info[l.item_id], mapa);
        const custo = custoDa({ ...l, credito_ml: cred?.valor || 0, defeito: marcado,
          componentes: kit.componentes, defeito_produtos: marcado == null ? null : defeitosProdutos[l.claim_id] });
        let acoes = [];
        try { acoes = JSON.parse(l.acoes || '[]'); } catch {}
        const rev = json(l.revisao);
        return {
          credito_ml: cred ? { valor: cred.valor, data: cred.data, descricao: cred.descricao, manual: !!cred.manual, automatico: cred.automatico ?? null } : null,
          id: l.claim_id, tipo: l.tipo, tipo_nome: TIPOS[l.tipo] || l.tipo, status: l.status,
          aberta: l.status === 'opened', etapa: l.etapa,
          motivo: motivoTxt[l.motivo_id] || l.motivo_id,
          pedido: l.order_id, item_id: l.item_id, quantidade: l.quantidade,
          sku: kit.sku || null, comprador: clientes[l.order_id]?.apelido || null, comprador_nome: clientes[l.order_id]?.nome || null,
          titulo: info[l.item_id]?.title || null, foto: info[l.item_id]?.thumbnail || null,
          criada_em: l.criada_em,
          resolucao: l.resolucao ? (RESOLUCAO[l.resolucao] || l.resolucao) : null,
          a_favor_do_vendedor: (l.beneficiado || '').includes('respondent'),
          cobertura_ml: l.cobertura_ml === 1,
          status_devolucao: l.status_devolucao ? (STATUS_DEVOLUCAO[l.status_devolucao] || l.status_devolucao) : null,
          // dinheiro, cada valor com a sua origem
          valor_venda: l.valor_pedido,
          devolvido_comprador: num(l.reembolso_ml) + num(l.reembolso_vendedor) || num(l.reembolsado),
          frete_ida: l.frete_ida, frete_ida_estornado: l.frete_ida_estornado,
          tarifas: l.tarifas, tarifas_estornadas: l.tarifas_estornadas,
          frete_volta_cobrado: l.tarifa_devolucao, frete_volta_cheio: l.frete_volta,
          custo_produto: l.custo_produto,
          // os produtos do kit, para marcar quais voltaram com defeito
          sku: kit.sku, componentes: kit.componentes,
          fonte_dinheiro: l.fonte_dinheiro || null,
          custo,
          revisao: rev ? { motivo: REVISAO[rev.motivo] || rev.motivo, a_favor: rev.resultado === 'success',
            resultado: rev.resultado } : null,
          mensagem_ml: json(l.detalhe_ml),
          acoes_pendentes: acoes.filter((a) => a.acao !== 'recontact'),
          // defeito: marcado pelo vendedor, ou sugerido pela revisão do ML (produto avariado…)
          defeito_marcado: marcado ?? null, defeito_sugerido: comDefeito({ revisao: l.revisao }),
          nf_venda: json(l.nf_venda),
          link: `https://www.mercadolivre.com.br/vendas/${l.order_id}/detalhe`,
        };
      });

      // Por anúncio: quantas reclamações, quanto custaram e a taxa sobre as vendas da janela.
      const porItem = new Map();
      for (const x of itens) {
        if (!x.item_id) continue;
        const a = porItem.get(x.item_id) || { item_id: x.item_id, titulo: x.titulo, foto: x.foto,
          devolucoes: 0, reclamacoes: 0, custo: 0, devolvido: 0, credito_ml: 0 };
        if (x.tipo === 'returns') a.devolucoes++; else a.reclamacoes++;
        a.custo += x.custo.total + x.custo.fretes;
        a.devolvido += x.devolvido_comprador;
        a.credito_ml += x.custo.credito_ml;
        porItem.set(x.item_id, a);
      }
      const anuncios = [...porItem.values()].map((a) => {
        const v = vendas[a.item_id];
        return { ...a, custo: cent(a.custo), credito_ml: cent(a.credito_ml), resultado: cent(a.credito_ml - a.custo),
          vendas: v?.pedidos ?? null,
          taxa: v?.pedidos ? (a.devolucoes + a.reclamacoes) / v.pedidos : null };
      }).sort((a, b) => b.custo - a.custo || (b.devolucoes + b.reclamacoes) - (a.devolucoes + a.reclamacoes));

      const porMotivo = {};
      for (const x of itens) porMotivo[x.motivo || '—'] = (porMotivo[x.motivo || '—'] || 0) + 1;

      const s = (f) => cent(soma(itens.map(f)));
      // Crédito digitado: entra no total; se a reclamação já tinha um crédito ligado, ele sai.
      const ajusteManual = soma(itens.filter((x) => x.credito_ml?.manual).map((x) => x.credito_ml.valor - num(x.credito_ml.automatico)));
      return {
        dias, de: de.toISOString(), ate: ate.toISOString(), detalhadas_agora: claims.detalhadas ?? 0,
        resumo: {
          total: itens.length,
          devolucoes: itens.filter((x) => x.tipo === 'returns').length,
          reclamacoes: itens.filter((x) => x.tipo === 'mediations').length,
          abertas: itens.filter((x) => x.aberta).length,
          com_acao: itens.filter((x) => x.aberta && x.acoes_pendentes.length).length,
          com_credito_ml: itens.filter((x) => x.credito_ml).length,
          avariados: itens.filter((x) => x.revisao && x.revisao.motivo && x.revisao.motivo !== REVISAO.SRF7).length,
          // produto já voltou e o ML não tem nota de devolução: lembrete para emitir no ERP
          valor_vendas: s((x) => x.valor_venda),
          devolvido_comprador: s((x) => x.devolvido_comprador),
          frete_volta_cobrado: s((x) => x.custo.frete_volta),
          frete_volta_cheio: s((x) => x.frete_volta_cheio),
          frete_ida_perdido: s((x) => x.custo.frete_ida_perdido),
          tarifas_perdidas: s((x) => x.custo.tarifas_perdidas),
          estornado_a_voce: s((x) => (x.devolvido_comprador > 0 ? num(x.frete_ida_estornado) + num(x.tarifas_estornadas) : 0)),
          perda_produto: s((x) => x.custo.perda_produto),
          pecas_defeito: s((x) => x.custo.peca_defeito),
          qtd_defeito: itens.filter((x) => x.custo.defeito).length,
          nao_voltou: s((x) => x.custo.nao_voltou),
          fretes: s((x) => x.custo.fretes),
          voltaram_bons: itens.filter((x) => [STATUS_DEVOLUCAO.delivered, STATUS_DEVOLUCAO.shipped, STATUS_DEVOLUCAO.closed].includes(x.status_devolucao) && !x.custo.defeito).length,
          custo_total: s((x) => x.custo.total),
          // crédito do ML: todos os do período (o total é exato) e quanto deles foi ligado
          // + o que o vendedor digitou (no lugar do ligado na mesma reclamação, sem contar duas vezes)
          credito_ml: cent(soma(creditos.map((c) => c.valor)) + ajusteManual),
          credito_ml_ligado: s((x) => x.custo.credito_ml),
          resultado: cent(soma(creditos.map((c) => c.valor)) + ajusteManual - soma(itens.map((x) => x.custo.total + x.custo.fretes))),
        },
        creditos_sem_reclamacao: ligacao.semDono,
        // todos os créditos do período, com a reclamação quando o valor bateu exato
        creditos: [...creditos].sort((a, b) => b.data.localeCompare(a.data)).map((c) => {
          const dono = Object.entries(ligacao.porClaim).find(([, v]) => v.id === c.id)?.[0] || null;
          const it = dono ? itens.find((x) => String(x.id) === String(dono)) : null;
          return { ...c, reclamacao: dono ? Number(dono) : null, titulo: it?.titulo || null, pedido: it?.pedido || null };
        }),
        erro_creditos: erroCreditos,
        motivos: Object.entries(porMotivo).map(([m, n]) => ({ motivo: m, n })).sort((a, b) => b.n - a.n),
        anuncios,
        itens,
      };
    },
  };

  const rotasParam = [
    // Crédito do ML de uma reclamação, digitado pelo vendedor (ex.: R$ 97,83 pelo produto com
    // defeito). Vazio apaga e volta a valer o crédito ligado sozinho, se houver.
    { m: 'PUT', re: /^\/api\/devolucoes\/(\d+)\/credito$/, fn: async ([id], body) => {
      contaOuErro();
      const txt = String(body?.valor ?? '').trim();
      let valor = null;
      if (txt) {
        valor = Number(txt.includes(',') ? txt.replace(/\./g, '').replace(',', '.') : txt);
        if (!Number.isFinite(valor) || valor < 0 || valor > 1e6) throw Object.assign(new Error('Crédito inválido: use o valor em reais, ex.: 97,83.'), { status: 400 });
        valor = Math.round(valor * 100) / 100;
      }
      D.creditoManualGravar(Number(id), valor);
      return { claim_id: Number(id), credito: valor };
    } },
    // Marca (ou desmarca) o produto devolvido como com defeito: só a peça com defeito entra no custo.
    { m: 'PUT', re: /^\/api\/devolucoes\/(\d+)\/defeito$/, fn: async ([id], body) => {
      contaOuErro();
      // Em kit, `produtos` diz QUAIS peças estão com defeito (posições na lista de componentes
      // da reclamação); lista vazia = nenhuma.
      let produtos = null;
      if (body?.produtos != null) {
        if (!Array.isArray(body.produtos) || body.produtos.length > 40
          || body.produtos.some((i) => !Number.isInteger(i) || i < 0 || i > 40)) {
          throw Object.assign(new Error('Informe produtos como a lista das posições das peças com defeito.'), { status: 400 });
        }
        produtos = [...new Set(body.produtos)].sort((a, b) => a - b);
      }
      const defeito = produtos ? produtos.length > 0 : body?.defeito;
      if (typeof defeito !== 'boolean') throw Object.assign(new Error('Informe defeito: true ou false.'), { status: 400 });
      D.defeitoGravar(Number(id), defeito, produtos);
      return { claim_id: Number(id), defeito, produtos };
    } },
  ];

  return { rotas, rotasParam, atualizarDevolucoes: atualizar };
}

module.exports = { criar, custoDa, comDefeito, dinheiroDoPagamento, ligarCreditos, TIPOS, REVISAO };
