'use strict';
// Notas fiscais do Mercado Livre pelo Faturador do ML (tela public/ml-notas.html, menu Expedição; só o administrador;
// pedido do dono 09/11/2026). O vendedor emitia a nota de cada venda do Mercado Envios no site do ML; aqui é igual, pelo
// painel: os produtos ficam com a configuração fiscal que já está no ML (nada é ajustado aqui).
//   Lista = envios da fila das comandas (comandas.js#fila, as duas contas) com substatus invoice_pending (o ML segura a
//           etiqueta até a nota). Full o ML emite sozinho e não está na fila.
//   Emitir = POST /users/{id}/invoices/orders { orders: [ids do pacote] } (doc "Emitindo Nota Fiscal pelo Mercado
//           Livre", lida 09/11/2026: pedido de carrinho vai com TODAS as vendas numa nota só). Antes, relê o envio (tem de
//           estar invoice_pending) e a nota do pedido (GET /users/{id}/invoices/orders/{order}: já tem = não emite de novo).
//           Resposta com status; sem "authorized" relê GET /users/{id}/invoices/{id} por ~25 s. Erro = { message,
//           error_code } e o texto de GET /users/invoices/errors/MLB/{code}.
// Escrita só pelo clique, com confirmação; uma emissão por vez em cada envio (trava). A nota tem dado do comprador: a
// resposta ao navegador leva só número, série, chave e situação; nada guardado; nada no MCP.

const erro = (msg, status) => Object.assign(new Error(msg), { status });
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Situação de uma nota do Faturador. Função pura: testada.
function situacaoNota(n) {
  const st = String(n?.status || n?.transaction_status || '').toLowerCase();
  const base = { id: n?.id ?? null, numero: n?.invoice_number ?? null, serie: n?.invoice_series ?? null,
    chave: n?.attributes?.invoice_key || null, status: st || null };
  if (st === 'authorized') return { ...base, situacao: 'autorizada' };
  if (/reject|error|denied|fail|cancel/.test(st)) {
    const motivos = (Array.isArray(n?.errors) ? n.errors : []).map((e) => e?.description || e?.code).filter(Boolean);
    return { ...base, situacao: /cancel/.test(st) ? 'cancelada' : 'rejeitada',
      motivo: motivos.join(' · ') || n?.attributes?.status_description || null };
  }
  return { ...base, situacao: 'processando' };
}

// Os ids de venda que vão na nota de um envio (pacote = todas). Função pura: testada.
function pedidosDoEnvio(c) {
  const ids = (Array.isArray(c?.pedidos) && c.pedidos.length ? c.pedidos : [c?.pedido]).map(String).filter((x) => /^\d{6,20}$/.test(x));
  return [...new Set(ids)].map(Number);
}

function criar({ D, ml, comandas }) {
  const contaDe = () => new Map(D.contasListar().map((c) => [c.nickname, String(c.ml_user_id)]));

  async function pendentes(recarregar) {
    const f = await comandas.fila(recarregar);
    const conta = contaDe();
    const envios = [];
    for (const c of f.comandas) {
      if (c.canal !== 'ml' || c.etapa !== 'invoice_pending' || !conta.has(c.loja)) continue;
      envios.push({ chave: c.chave, envio: c.chave.slice(3), conta: conta.get(c.loja), loja: c.loja, pedido: c.pedido,
        pedidos: pedidosDoEnvio(c).map(String), cliente: c.cliente, categoria: c.categoria, numero: c.numero, dia: c.dia,
        prazo: c.prazo, situacao_prazo: c.situacao_prazo, comprado_em: c.comprado_em || null,
        itens: (c.itens || []).map((i) => ({ qtd: i.qtd, sku: i.sku, titulo: i.titulo, variacao: i.variacao, foto: i.foto })) });
    }
    return { em: f.em, erros: f.erros, envios };
  }

  // texto do erro do Faturador: a mensagem e, pelo código, o texto da lista de erros do ML
  async function textoDoErro(e, contaId) {
    const cod = e?.body?.error_code ?? e?.body?.cause?.[0]?.code;
    let txt = e?.body?.message || e.message || 'falhou';
    if (cod != null && /^\w{1,10}$/.test(String(cod))) {
      try {
        const d = await ml(`/users/invoices/errors/MLB/${cod}`, {}, contaId);
        if (d?.display_message && !txt.includes(d.display_message)) txt = `${d.display_message} (${txt})`;
      } catch { /* sem o texto: fica a mensagem */ }
    }
    return `${txt}${cod != null ? ` [código ${cod}]` : ''}`;
  }

  // nota que o pedido já tem no Faturador (null = nenhuma)
  async function notaDoPedido(contaId, orderId) {
    try { return await ml(`/users/${contaId}/invoices/orders/${orderId}`, {}, contaId); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }

  const travas = new Set();
  async function emitir(chave) {
    const k = String(chave || '');
    if (!/^ml:\d{6,20}$/.test(k)) throw erro('Envio inválido.', 400);
    if (travas.has(k)) throw erro('Esse envio já está sendo emitido (outra aba ou outro clique): espere terminar e clique em Atualizar.', 409);
    travas.add(k);
    try {
      const { envios } = await pendentes(false);
      const c = envios.find((x) => x.chave === k);
      if (!c) throw erro('Esse envio não está mais aguardando nota (já emitida, já saiu ou foi cancelado). Clique em Atualizar.', 409);
      // confere na hora: o envio ainda espera a nota e nenhum pedido dele já tem nota no Faturador
      const s = await ml(`/shipments/${c.envio}`, {}, c.conta);
      if (s?.status !== 'ready_to_ship' || s?.substatus !== 'invoice_pending') {
        throw erro(`O ML diz que o envio não espera mais a nota (situação ${s?.status || '?'} / ${s?.substatus || '?'}). Clique em Atualizar.`, 409);
      }
      const ids = pedidosDoEnvio(c);
      if (!ids.length) throw erro('Envio sem número de venda.', 400);
      for (const id of ids) {
        const ja = await notaDoPedido(c.conta, id);
        const sj = ja && situacaoNota(ja);
        if (sj && ['autorizada', 'processando'].includes(sj.situacao)) {
          return { ...sj, ja_tinha: true, pedidos: ids.map(String), cliente: c.cliente };
        }
      }
      let n;
      try { n = await ml(`/users/${c.conta}/invoices/orders`, { method: 'POST', body: JSON.stringify({ orders: ids }) }, c.conta); }
      catch (e) { throw erro(`O Faturador do ML recusou: ${await textoDoErro(e, c.conta)}`, e.status && e.status < 500 ? 422 : 502); }
      let r = situacaoNota(n);
      // a nota pode voltar ainda em processamento: relê por ~25 s
      for (let i = 0; i < 6 && r.situacao === 'processando'; i++) {
        await espera(i < 2 ? 2500 : 5000);
        try {
          const x = r.id != null ? await ml(`/users/${c.conta}/invoices/${r.id}`, {}, c.conta) : await notaDoPedido(c.conta, ids[0]);
          if (x) r = situacaoNota(x);
        } catch { /* leitura falhou: tenta de novo */ }
      }
      comandas.esquecerEnvio?.(c.envio);   // a fila relê o envio: com a nota, a etiqueta é liberada
      return { ...r, pedidos: ids.map(String), cliente: c.cliente };
    } finally { travas.delete(k); }
  }

  const rotas = {
    'GET /api/ml-notas/pendentes': async (url) => pendentes(url.searchParams.get('recarregar') === '1'),
    // { chave: "ml:{envio}" } — emite a nota do envio pelo Faturador do ML (clique + confirmação na tela)
    'POST /api/ml-notas/emitir': async (_u, body) => emitir(body?.chave),
  };
  return { rotas };
}

module.exports = { criar, situacaoNota, pedidosDoEnvio };
