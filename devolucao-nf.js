'use strict';
// Nota fiscal de DEVOLUÇÃO (entrada) pelo Bling, a partir da nota de venda de QUALQUER loja (pedido do dono 09/11/2026; botão
// "Nota de devolução" nas telas de devoluções: ML, Shopee, Amazon, Leroy e Magalu; módulo "Notas fiscais" dos usuários).
//   Nota de venda: ML = a do Faturador do ML (GET /users/{id}/invoices/orders/{pedido} -> XML em attributes.xml_location; o
//   Faturador NÃO emite devolução pela API — doc "Gestão e Consulta de Notas Fiscais" lida 09/11/2026, só consulta);
//   outras lojas = a nota do Bling com aquele número de pedido (GET /nfe?numeroLoja=), nas duas contas. Sem achar: o vendedor
//   cola a chave de acesso da venda (GET /nfe?chaveAcesso=).
//   Conta do Bling = a do MESMO CNPJ do emitente da venda (GET /empresas/me/dados-basicos): AMG na AMG, Primor na Primor.
//   Gerar = POST /nfe: tipo 0 (entrada), finalidade 4 (devolução), natureza escolhida (a de devolução do Bling dá CFOP e
//   impostos), contato = o destinatário da venda, documentoReferenciado (modelo 55 + chave) e, em cada item, a chave e o nº do
//   item de origem; itens com NCM, CEST, origem, unidade e o valor unitário líquido da venda ((vProd − vDesc) ÷ qCom), na
//   quantidade que voltou. Fica PENDENTE no Bling (pode conferir e apagar lá). Emitir = POST /nfe/{id}/enviar e relê ~25 s.
// Escrita só pelo clique, com confirmação; trava por pedido; uma devolução por pedido (estado devolucao_nf). A nota tem dado do
// comprador: a resposta à tela leva só o nome; nada guardado além de ids; nada no MCP.

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const CANAIS = ['ml', 'shopee', 'amazon', 'leroy', 'magalu'];
const NOME_CANAL = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', leroy: 'Leroy Merlin', magalu: 'Magalu' };
const SITUACAO = { 1: 'Pendente', 2: 'Cancelada', 3: 'Aguardando recibo', 4: 'Rejeitada', 5: 'Autorizada', 6: 'Emitida DANFE', 7: 'Registrada', 8: 'Aguardando protocolo', 9: 'Denegada', 10: 'Consulta situação', 11: 'Bloqueada' };
const soDig = (s) => String(s ?? '').replace(/\D/g, '');
const r2 = (v) => Math.round(Number(v) * 100) / 100;

// Os dados da nota de venda que a devolução usa, do XML autorizado. Função pura: testada.
function vendaDoXml(xml) {
  const des = (t) => String(t ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
  const bloco = (x, t) => (String(x || '').match(new RegExp(`<${t}[\\s>][\\s\\S]*?</${t}>`)) || [''])[0];
  const tag = (x, t) => { const m = String(x || '').match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? des(m[1]) : null; };
  const num = (x, t) => { const v = tag(x, t); return v == null ? null : Number(v); };
  const ide = bloco(xml, 'ide'), emit = bloco(xml, 'emit'), dest = bloco(xml, 'dest'), prot = bloco(xml, 'infProt');
  const chave = tag(prot, 'chNFe') || (String(xml).match(/Id="NFe(\d{44})"/) || [])[1] || null;
  if (!chave || !/^\d{44}$/.test(chave)) throw erro('O XML da venda não tem a chave de acesso.');
  if (!tag(prot, 'nProt')) throw erro('A nota de venda não está autorizada (sem protocolo no XML).');
  if (tag(ide, 'tpNF') !== '1') throw erro('A nota encontrada não é de saída (venda).');
  const end = bloco(dest, 'enderDest');
  const itens = [...String(xml).matchAll(/<det nItem="(\d+)"[^>]*>([\s\S]*?)<\/det>/g)].map((m) => {
    const pr = bloco(m[2], 'prod'), icms = bloco(m[2], 'ICMS');
    const q = num(pr, 'qCom') || 0, vProd = num(pr, 'vProd') || 0, vDesc = num(pr, 'vDesc') || 0;
    return { n: Number(m[1]), codigo: tag(pr, 'cProd'), descricao: tag(pr, 'xProd'), ncm: tag(pr, 'NCM'), cest: tag(pr, 'CEST'), cfop: tag(pr, 'CFOP'),
      unidade: tag(pr, 'uCom'), quantidade: q, valor: r2(vProd - vDesc), unitario: q ? Math.round(((vProd - vDesc) / q) * 10000) / 10000 : 0,
      gtin: /^\d{8,14}$/.test(tag(pr, 'cEAN') || '') ? tag(pr, 'cEAN') : null, origem: (icms.match(/<orig>(\d)<\/orig>/) || [])[1] ?? null };
  });
  if (!itens.length) throw erro('O XML da venda não tem itens.');
  return { chave, numero: tag(ide, 'nNF'), serie: tag(ide, 'serie'), emissao: String(tag(ide, 'dhEmi') || '').slice(0, 10),
    emitente_cnpj: soDig(tag(emit, 'CNPJ')),
    destinatario: { nome: tag(dest, 'xNome'), cnpj: soDig(tag(dest, 'CNPJ')) || null, cpf: soDig(tag(dest, 'CPF')) || null, ie: tag(dest, 'IE'),
      ind_ie: tag(dest, 'indIEDest'), email: tag(dest, 'email'),
      endereco: { endereco: tag(end, 'xLgr'), numero: tag(end, 'nro'), complemento: tag(end, 'xCpl'), bairro: tag(end, 'xBairro'),
        cep: soDig(tag(end, 'CEP')), municipio: tag(end, 'xMun'), uf: tag(end, 'UF') } },
    itens };
}

// Quantidades que voltam: [{ n, quantidade }] dentro do vendido (pelo menos um item). Função pura: testada.
function escolhidosValidos(venda, brutos) {
  const porN = new Map(venda.itens.map((i) => [i.n, i]));
  const out = [];
  for (const b of Array.isArray(brutos) ? brutos : []) {
    const it = porN.get(Number(b?.n)), q = Number(b?.quantidade);
    if (!it) throw erro('Item da nota de venda inválido.');
    if (!Number.isFinite(q) || q < 0) throw erro(`Quantidade inválida no item ${it.n}.`);
    if (q > it.quantidade + 1e-9) throw erro(`O item ${it.n} (${it.descricao}) foi vendido com ${it.quantidade}: não dá para devolver ${q}.`);
    if (q > 0) out.push({ it, quantidade: q });
  }
  if (!out.length) throw erro('Escolha pelo menos um item e a quantidade que voltou.');
  return out;
}

// Corpo do POST /nfe da devolução (Bling v3). agora = 'AAAA-MM-DD HH:MM:SS' em Brasília. Função pura: testada.
function corpoDevolucao(venda, escolhidos, naturezaId, agora, ref) {
  const d = venda.destinatario;
  const cont = d.ind_ie === '1' ? 1 : d.ind_ie === '2' ? 2 : 9;
  const dataBr = venda.emissao ? venda.emissao.split('-').reverse().join('/') : '';
  return {
    tipo: 0, finalidade: 4, dataOperacao: agora, naturezaOperacao: { id: Number(naturezaId) },
    contato: { nome: d.nome, tipoPessoa: d.cnpj ? 'J' : 'F', numeroDocumento: d.cnpj || d.cpf || '', ...(d.ie ? { ie: d.ie } : {}), contribuinte: cont,
      endereco: Object.fromEntries(Object.entries(d.endereco).filter(([, v]) => v)) },
    documentoReferenciado: { modelo: '55', chaveAcesso: venda.chave, numero: String(venda.numero || ''), serie: String(venda.serie || ''), data: venda.emissao },
    itens: escolhidos.map(({ it, quantidade }) => ({
      codigo: it.codigo || '', descricao: it.descricao, unidade: it.unidade || 'UN', quantidade, valor: it.unitario, tipo: 'P',
      classificacaoFiscal: it.ncm || '', ...(it.cest ? { cest: it.cest } : {}), ...(it.gtin ? { gtin: it.gtin } : {}),
      ...(it.origem != null ? { origem: Number(it.origem) } : {}),
      documentoReferenciado: { chaveAcesso: venda.chave, numeroItem: String(it.n) } })),
    observacoes: `Devolução de venda referente à NF-e nº ${venda.numero} série ${venda.serie} de ${dataBr}, chave ${venda.chave}.${ref ? ` ${ref}.` : ''}`,
  };
}

// Nota do Faturador do ML (GET /users/{id}/invoices/{id}) -> a devolução e os pedidos dela; null = não é devolução.
// Medido 09/11/2026: a devolução emitida no site do ML não aparece em /invoices/orders/{pedido} (só a venda) nem tem envio;
// chega pelo aviso "invoices" e traz o pedido em items[].external_order_id. Função pura: testada.
const TIPOS_DEV_ML = ['devolution', 'sale_return', 'credit_note'];
function devolucaoDaNotaMl(n) {
  const tipo = String(n?.fiscal_data?.transaction_type || '').toLowerCase();
  if (!TIPOS_DEV_ML.includes(tipo)) return null;
  const pedidos = [...new Set((n.items || []).map((i) => String(i.external_order_id ?? '')).filter((x) => /^\d{6,20}$/.test(x)))];
  return { origem: 'Mercado Livre', tipo, pedidos, numero: n.invoice_number ?? null, serie: n.invoice_series ?? null,
    status: String(n.status || '').toLowerCase() || null, emitida_em: n.issued_date || n.attributes?.authorization_date || null };
}

// Nota de ENTRADA do Bling -> a devolução e a chave da venda (documento referenciado ou a chave nas observações); null = não é
// devolução. Função pura: testada.
function devolucaoDaNotaBling(d) {
  if (Number(d?.tipo) !== 0 || Number(d?.finalidade) !== 4) return null;
  const refs = [d.documentoReferenciado, ...(Array.isArray(d.documentosReferenciados) ? d.documentosReferenciados : [])].map((x) => soDig(x?.chaveAcesso)).filter((x) => x.length === 44);
  const obs = String(d.observacoes || '');
  const chave = refs[0] || (obs.match(/\b(\d{44})\b/) || [])[1] || null;
  const pedidoObs = (obs.match(/Pedido (?:Mercado Livre|Shopee|Amazon|Leroy Merlin|Magalu) ([\w-]+(?:\.[\w-]+)*)/) || [])[1] || null;
  return { origem: 'Bling', chave_venda: chave, pedido_obs: pedidoObs, numero: d.numero ?? null, serie: d.serie ?? null,
    situacao: Number(d.situacao) || null, emitida_em: d.dataEmissao || null };
}

function criar({ D, ml, mlArquivo, bling }) {
  const contasBling = ['1', '2'];
  const cnpjs = {};
  async function cnpjDoBling(n) {
    if (cnpjs[n] && Date.now() - cnpjs[n].em < 6 * 3600e3) return cnpjs[n].v;
    const v = soDig((await bling(n, '/empresas/me/dados-basicos')).data?.cnpj);
    cnpjs[n] = { em: Date.now(), v };
    return v;
  }
  async function contaDoCnpj(cnpj) {
    for (const n of contasBling) { try { if (await cnpjDoBling(n) === cnpj) return n; } catch { /* conta não conectada */ } }
    throw erro(`Nenhuma conta do Bling conectada tem o CNPJ ${cnpj} da nota de venda.`, 409);
  }
  const xmlDoLink = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const x = await r.text();
    if (!r.ok || !/<(nfeProc|NFe)\b/.test(x.slice(0, 4000))) throw erro('O link do XML não devolveu a nota.', 502);
    return x;
  };

  // A nota de venda do pedido: { xml, origem, conta (Bling, se veio de lá) }
  async function vendaDe(canal, pedido, chave) {
    if (chave) {
      for (const n of contasBling) {
        let l;
        try { l = (await bling(n, `/nfe?pagina=1&limite=5&chaveAcesso=${chave}`)).data || []; } catch { continue; }
        for (const x of l) { const d = (await bling(n, `/nfe/${x.id}`)).data; if (d?.xml && [5, 6, 7].includes(Number(d.situacao))) return { xml: await xmlDoLink(d.xml), origem: 'Bling', conta: n }; }
      }
      throw erro('Não achei nota autorizada com essa chave em nenhuma conta do Bling.', 404);
    }
    if (canal === 'ml') {
      for (const c of D.contasListar()) {
        const u = String(c.ml_user_id);
        let n;
        try { n = await ml(`/users/${u}/invoices/orders/${pedido}`, {}, u); } catch (e) { if (e.status === 404 || e.status === 403) continue; throw e; }
        if (String(n?.status || '').toLowerCase() !== 'authorized') throw erro(`A nota de venda do pedido no Faturador do ML não está autorizada (${n?.status || '?'}).`, 409);
        const caminho = String(n.attributes?.xml_location || `/users/${u}/invoices/documents/xml/${n.id}/authorized`).replace(/^https?:\/\/[^/]+/, '');
        const buf = await mlArquivo(caminho, u);
        // a devolução pelo próprio Faturador só existe no site do ML (sistema interno do site, com a sessão do navegador; visto
        // 09/11/2026): o painel leva direto à tela dele já neste pedido e nota de venda
        const mlEmitir = n.id != null ? `https://vendedores.mercadolivre.com.br/invoices/order/${encodeURIComponent(pedido)}/devolution/${encodeURIComponent(n.id)}?source=ml` : null;
        return { xml: Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf), origem: 'Faturador do ML', ml_emitir: mlEmitir };
      }
      throw erro('Não achei a nota de venda deste pedido no Faturador do ML. Se ela saiu por outro sistema, cole a chave de acesso da venda.', 404);
    }
    for (const n of contasBling) {
      let l;
      try { l = (await bling(n, `/nfe?pagina=1&limite=10&tipo=1&numeroLoja=${encodeURIComponent(pedido)}`)).data || []; } catch { continue; }
      for (const x of l) {
        const d = (await bling(n, `/nfe/${x.id}`)).data;
        if (d?.xml && [5, 6, 7].includes(Number(d.situacao)) && Number(d.tipo) === 1) return { xml: await xmlDoLink(d.xml), origem: 'Bling', conta: n };
      }
    }
    throw erro(`Não achei no Bling nota de venda autorizada do pedido ${pedido}. Cole a chave de acesso da nota de venda.`, 404);
  }

  const geradas = () => { try { return JSON.parse(D.configLer('devolucao_nf') || '{}') || {}; } catch { return {}; } };
  const gravarGerada = (k, v) => {
    const g = geradas();
    if (v) g[k] = v; else delete g[k];
    const ks = Object.keys(g);
    for (const x of ks.slice(0, Math.max(0, ks.length - 1000))) delete g[x];
    D.configGravar('devolucao_nf', JSON.stringify(g));
  };
  // a devolução já gerada deste pedido, relida no Bling (apagada lá = esquece; cancelada = pode gerar outra)
  async function geradaDe(k) {
    const g = geradas()[k];
    if (!g) return null;
    let d;
    try { d = (await bling(g.conta, `/nfe/${g.id}`)).data; } catch (e) { if (e.status === 404) { gravarGerada(k, null); return null; } throw e; }
    if (!d) { gravarGerada(k, null); return null; }
    const sit = Number(d.situacao);
    return { conta: g.conta, id: g.id, numero: d.numero ?? g.numero ?? null, situacao: sit, situacao_nome: SITUACAO[sit] || String(sit), cancelada: sit === 2 };
  }

  function entrada(q) {
    const canal = String(q?.canal || '');
    if (!CANAIS.includes(canal)) throw erro('Loja inválida.');
    const pedido = String(q?.pedido ?? '').trim();
    if (!/^[\w.-]{3,40}$/.test(pedido)) throw erro('Número do pedido inválido.');
    const chave = soDig(q?.chave);
    if (chave && chave.length !== 44) throw erro('A chave de acesso tem 44 números.');
    return { canal, pedido, chave: chave || null, k: `${canal}:${pedido}` };
  }

  async function previa(q) {
    const e = entrada(q);
    const v = await vendaDe(e.canal, e.pedido, e.chave);
    const venda = vendaDoXml(v.xml);
    const conta = await contaDoCnpj(venda.emitente_cnpj);
    if (v.conta && v.conta !== conta) throw erro('A nota de venda está numa conta do Bling e o CNPJ dela é de outra: confira.', 409);
    const nat = ((await bling(conta, '/naturezas-operacoes?pagina=1&limite=100')).data || []).filter((z) => Number(z.situacao ?? 1) === 1)
      .map((z) => ({ id: z.id, descricao: z.descricao || '' }));
    const salva = D.configLer(`devolucao_natureza_${conta}`);
    const sugerida = nat.find((z) => String(z.id) === String(salva)) || nat.find((z) => /devolu/i.test(z.descricao)) || null;
    return { canal: e.canal, loja: NOME_CANAL[e.canal], pedido: e.pedido, conta_bling: conta, origem: v.origem, ml_emitir: v.ml_emitir || null,
      venda: { numero: venda.numero, serie: venda.serie, emissao: venda.emissao, chave: venda.chave, cliente: venda.destinatario.nome,
        itens: venda.itens.map(({ n, codigo, descricao, ncm, unidade, quantidade, unitario }) => ({ n, codigo, descricao, ncm, unidade, quantidade, unitario })) },
      naturezas: nat, natureza_sugerida: sugerida?.id ?? null, gerada: await geradaDe(e.k) };
  }

  const agoraBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  const travas = new Set();
  const comTrava = async (k, f) => {
    if (travas.has(k)) throw erro('Essa devolução já está sendo processada (outra aba ou outro clique): espere terminar.', 409);
    travas.add(k);
    try { return await f(); } finally { travas.delete(k); }
  };

  async function gerar(b) {
    const e = entrada(b);
    return comTrava(e.k, async () => {
      const ja = await geradaDe(e.k);
      if (ja && !ja.cancelada) throw erro(`A nota de devolução deste pedido já foi gerada no Bling (nº ${ja.numero || '?'}, ${ja.situacao_nome}).`, 409);
      const v = await vendaDe(e.canal, e.pedido, e.chave);
      const venda = vendaDoXml(v.xml);
      const conta = await contaDoCnpj(venda.emitente_cnpj);
      const natId = String(b?.natureza ?? '');
      if (!/^\d{1,20}$/.test(natId)) throw erro('Escolha a natureza de operação de devolução.');
      const nat = ((await bling(conta, '/naturezas-operacoes?pagina=1&limite=100')).data || []).find((z) => String(z.id) === natId);
      if (!nat) throw erro('Essa natureza de operação não existe nessa conta do Bling.');
      const escolhidos = escolhidosValidos(venda, b?.itens);
      const corpo = corpoDevolucao(venda, escolhidos, natId, agoraBr(), `Pedido ${NOME_CANAL[e.canal]} ${e.pedido}`);
      const r = await bling(conta, '/nfe', { metodo: 'POST', corpo });
      const id = r?.data?.id;
      if (!id) throw erro('O Bling não devolveu o id da nota criada: confira no Bling antes de tentar de novo.', 502);
      D.configGravar(`devolucao_natureza_${conta}`, natId);
      const d = (await bling(conta, `/nfe/${id}`)).data || {};
      feitasCache = null;
      gravarGerada(e.k, { conta, id: String(id), numero: d.numero ?? null, chave_venda: venda.chave, em: new Date().toISOString() });
      return { conta_bling: conta, id: String(id), numero: d.numero ?? null, situacao: Number(d.situacao) || 1, situacao_nome: SITUACAO[d.situacao] || 'Pendente',
        valor: d.valorNota ?? null };
    });
  }

  async function emitir(b) {
    const e = entrada(b);
    return comTrava(e.k, async () => {
      const g = geradas()[e.k];
      if (!g) throw erro('Gere a nota de devolução antes de emitir.', 409);
      const nota = (await bling(g.conta, `/nfe/${g.id}`)).data;
      if (!nota) throw erro('O Bling não achou a nota de devolução (foi apagada?). Gere de novo.', 404);
      if (Number(nota.tipo) !== 0 || Number(nota.finalidade) !== 4) throw erro('Essa nota do Bling não é uma devolução de entrada: nada foi enviado.', 409);
      if (Number(nota.situacao) !== 1) throw erro(`A nota de devolução não está pendente (${SITUACAO[nota.situacao] || nota.situacao}): nada foi enviado.`, 409);
      await bling(g.conta, `/nfe/${g.id}/enviar?enviarEmail=false`, { metodo: 'POST' });
      let d = nota;
      for (let i = 0; i < 8; i++) {
        await new Promise((ok) => setTimeout(ok, 3000));
        d = (await bling(g.conta, `/nfe/${g.id}`)).data || d;
        if (![1, 3, 8, 10].includes(Number(d.situacao))) break;
      }
      const sit = Number(d.situacao);
      return { conta_bling: g.conta, id: g.id, numero: d.numero ?? null, situacao: sit, situacao_nome: SITUACAO[sit] || String(sit),
        autorizada: [5, 6, 7].includes(sit), rejeitada: sit === 4 };
    });
  }

  // Diagnóstico só de leitura (administrador): como a API do ML liga a nota de devolução emitida no site ao pedido. Só a forma:
  // id, tipo, situação, número e as referências; nada do comprador.
  async function diagnosticoMl(q) {
    const pedido = String(q?.pedido || ''), inv = String(q?.invoice || '');
    if (!/^\d{6,20}$/.test(pedido) || (inv && !/^\d{3,20}$/.test(inv))) throw erro('pedido/invoice inválidos');
    const forma = (n) => (n ? { id: n.id, status: n.status, tipo: n.fiscal_data?.transaction_type, invoice_type: n.attributes?.invoice_type,
      envio: n.shipment?.id ?? null, logistica: n.shipment?.logistic_type ?? null, numero: n.invoice_number, serie: n.invoice_series, refs: n.attributes?.reference_invoices, ref: n.attributes?.reference_invoice,
      itens_ref: (n.items || []).map((i) => i.reference_item || null), pedidos_itens: (n.items || []).map((i) => i.external_order_id ?? null), pack: n.pack_id ?? null,
      chaves: Object.keys(n) } : null);
    const out = {};
    for (const c of D.contasListar()) {
      const u = String(c.ml_user_id);
      const tenta = async (nome, caminho) => {
        try { const r = await ml(caminho, {}, u); out[`${u} ${nome}`] = Array.isArray(r) ? r.map(forma) : r?.results ? { results: r.results.map(forma), paging: r.paging } : forma(r); }
        catch (e) { out[`${u} ${nome}`] = { erro: e.status || e.message }; }
      };
      await tenta('orders', `/users/${u}/invoices/orders/${pedido}`);
      if (inv) await tenta('invoice', `/users/${u}/invoices/${inv}`);
      const env = out[`${u} invoice`]?.envio;
      if (env) await tenta('shipments(envio da devolução)', `/users/${u}/invoices/shipments/${env}`);
      await tenta('orders?type=devolution', `/users/${u}/invoices/orders/${pedido}?transaction_type=devolution`);
      await tenta('orders/devolution', `/users/${u}/invoices/orders/${pedido}/devolution`);
      await tenta('orders/invoices', `/users/${u}/invoices/orders/${pedido}/invoices`);
    }
    return out;
  }

  // ---- devoluções que já têm nota (as telas de devoluções mostram o selo) ----
  const lerJson = (k) => { try { return JSON.parse(D.configLer(k) || '{}') || {}; } catch { return {}; } };
  const aparar = (o, max) => { const ks = Object.keys(o); for (const x of ks.slice(0, Math.max(0, ks.length - max))) delete o[x]; return o; };
  // ML: os avisos "invoices" (30 dias guardados) — cada nota lida uma vez; a devolução fica guardada por id
  async function devolucoesMl() {
    const lidas = lerJson('nfdev_ml_lidas');
    const avisos = D.db.prepare("SELECT DISTINCT resource, ml_user_id FROM notificacoes WHERE topic = 'invoices' ORDER BY id DESC LIMIT 2000").all();
    let novas = 0;
    for (const a of avisos) {
      const m = String(a.resource || '').match(/^\/users\/(\d+)\/invoices\/(\d+)$/);
      if (!m || m[2] in lidas || novas >= 150) continue;
      try { lidas[m[2]] = devolucaoDaNotaMl(await ml(`/users/${m[1]}/invoices/${m[2]}`, {}, m[1])); novas++; }
      catch (e) { if (e.status === 404 || e.status === 403) lidas[m[2]] = null; }
    }
    if (novas) D.configGravar('nfdev_ml_lidas', JSON.stringify(aparar(lidas, 5000)));
    return Object.values(lidas).filter(Boolean);
  }
  // Bling: notas de entrada dos últimos 90 dias nas duas contas; o pedido pela venda referenciada (GET /nfe?chaveAcesso=) ou
  // pelo "Pedido …" das observações (as geradas pelo painel). Pendente/aguardando é relida até sair do estado.
  async function devolucoesBling() {
    const lidas = lerJson('nfdev_bling_lidas');
    const desde = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    let mudou = false;
    for (const n of contasBling) {
      let lista = [];
      try { for (let p = 1; p <= 3; p++) { const d = (await bling(n, `/nfe?pagina=${p}&limite=100&tipo=0&dataEmissaoInicial=${desde}`)).data || []; lista.push(...d); if (d.length < 100) break; } }
      catch { continue; }
      for (const x of lista) {
        const k = `${n}:${x.id}`, ja = lidas[k];
        if (ja === null || (ja && [2, 4, 5, 6, 7, 9].includes(ja.situacao) && Number(x.situacao) === ja.situacao)) continue;
        try {
          const d = (await bling(n, `/nfe/${x.id}`)).data;
          const dev = devolucaoDaNotaBling(d);
          if (dev && !ja?.pedido) {
            let pedido = dev.pedido_obs;
            if (!pedido && dev.chave_venda) {
              for (const c of contasBling) {
                try { const v = ((await bling(c, `/nfe?pagina=1&limite=5&chaveAcesso=${dev.chave_venda}`)).data || [])[0];
                  if (v) { pedido = (await bling(c, `/nfe/${v.id}`)).data?.numeroPedidoLoja || null; break; } } catch { /* outra conta */ }
              }
            }
            dev.pedido = pedido ? String(pedido) : null;
          } else if (dev) dev.pedido = ja.pedido;
          lidas[k] = dev ? { ...dev, conta: n, id: String(x.id) } : null;
          mudou = true;
        } catch { /* tenta na próxima leitura */ }
      }
    }
    if (mudou) D.configGravar('nfdev_bling_lidas', JSON.stringify(aparar(lidas, 3000)));
    return Object.values(lidas).filter(Boolean);
  }
  let feitasCache = null;
  async function feitas(recarregar) {
    if (!recarregar && feitasCache && Date.now() - feitasCache.em < 5 * 60e3) return feitasCache.r;
    const pedidos = {}, erros = [];
    const por = (p, x) => { if (!p) return; (pedidos[p] = pedidos[p] || []).push(x); };
    try { for (const d of await devolucoesMl()) for (const p of d.pedidos) por(p, { origem: d.origem, numero: d.numero, serie: d.serie, autorizada: d.status === 'authorized', situacao: d.status, emitida_em: d.emitida_em }); }
    catch (e) { erros.push(`Mercado Livre: ${e.message}`); }
    try { for (const d of await devolucoesBling()) por(d.pedido, { origem: `Bling ${d.conta === '1' ? 'AMG' : 'Primor'}`, numero: d.numero, serie: d.serie,
      autorizada: [5, 6, 7].includes(d.situacao), situacao: SITUACAO[d.situacao] || String(d.situacao), emitida_em: d.emitida_em }); }
    catch (e) { erros.push(`Bling: ${e.message}`); }
    const r = { pedidos, erros, em: new Date().toISOString() };
    feitasCache = { em: Date.now(), r };
    return r;
  }

  const rotas = {
    // pedido -> notas de devolução já feitas (ML pelos avisos do Faturador; Bling pelas notas de entrada). Só leitura.
    'GET /api/devolucao-nf/feitas': async (url) => feitas(url.searchParams.get('recarregar') === '1'),
    'GET /api/devolucao-nf/diagnostico-ml': async (url) => diagnosticoMl(Object.fromEntries(url.searchParams)),
    // ?canal=&pedido=[&chave=] — a nota de venda (itens) e as naturezas da conta do Bling; só leitura
    'GET /api/devolucao-nf/previa': async (url) => previa(Object.fromEntries(url.searchParams)),
    // { canal, pedido, chave?, natureza, itens: [{ n, quantidade }] } — GERA a devolução PENDENTE no Bling (clique + confirmação)
    'POST /api/devolucao-nf/gerar': async (_u, body) => gerar(body),
    // { canal, pedido } — EMITE a devolução gerada pelo painel (clique + confirmação)
    'POST /api/devolucao-nf/emitir': async (_u, body) => emitir(body),
  };
  return { rotas };
}

module.exports = { criar, vendaDoXml, escolhidosValidos, corpoDevolucao, devolucaoDaNotaMl, devolucaoDaNotaBling };
