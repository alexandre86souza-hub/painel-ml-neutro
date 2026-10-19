'use strict';
// Peças com defeito nas devoluções da Shopee, Amazon, Leroy e Magalu: a MESMA marcação da tela Devoluções do ML
// (pedido do dono, 19/10/2026). Cada item devolvido mostra os produtos do SKU (kit aberto pela tabela Produtos, com as
// composições e as trocas do painel); o vendedor marca QUAIS peças voltaram com defeito e, com 2+ unidades, quantas.
// - Custo: só as peças marcadas somam (custo do produto × unidades com defeito) no custo da devolução.
// - Estoque (estoque.js#linhasDeDevolucao): o item CONFERIDO (marcado, mesmo sem defeito) volta ao estoque sem as peças
//   com defeito — só devolução com data a partir da 1ª contagem (antes dela o produto já estava na prateleira contada
//   ou entra à mão na tela Estoque). Sem conferir = não volta (a loja não diz quando o produto chegou).
// - FBA da Amazon volta ao armazém da Amazon: a tela não mostra a marcação. Nada disto vai ao MCP.
const C = require('./custos.js');

const r2 = (v) => Math.round(v * 100) / 100;
const erro = (m) => Object.assign(new Error(m), { status: 400 });
const CHAVE = /^(shopee|amazon|leroy|magalu):[A-Za-z0-9_.:|-]{1,200}$/;

// Item devolvido -> o que a tela mostra para marcar e o custo das peças marcadas. marca = linha de
// devolucao_defeito_canal (ou undefined). Função pura: testada.
function pecasDo({ chave, sku, quantidade, data }, porNumero, marca) {
  const cs = C.custoDoSku(sku, porNumero, data || null);
  const comps = cs.componentes.map((c) => ({ sku: c.sku || String(c.numero).padStart(3, '0'), nome: c.nome || null, custo: c.custo }));
  const q = Math.max(1, Math.round(Number(quantidade) || 1));
  const marcadas = marca ? [...new Set(marca.produtos || [])].filter((i) => comps[i]) : [];
  const qtdDe = (i) => { const v = marca?.qtds?.[i]; return v == null ? q : Math.max(0, Math.min(q, Math.round(Number(v)) || 0)); };
  const qtds = Object.fromEntries(marcadas.map((i) => [i, qtdDe(i)]));
  return { chave, sku: sku || null, quantidade: q, data: data || null, componentes: comps,
    conferida: !!marca, produtos_defeito: marcadas, qtds_defeito: qtds,
    peca_defeito: r2(marcadas.reduce((s, i) => s + (Number(comps[i].custo) || 0) * qtds[i], 0)),
    sem_custo: marcadas.some((i) => comps[i].custo == null) };
}

// Corpo do PUT -> linha para gravar (ou erro). Função pura: testada.
function validar(b) {
  const chave = String(b?.chave || '');
  if (!CHAVE.test(chave)) throw erro('Devolução não informada.');
  const quantidade = Number(b.quantidade);
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 999) throw erro('Quantidade devolvida: um número inteiro de 1 a 999.');
  if (!Array.isArray(b.produtos) || b.produtos.some((i) => !Number.isInteger(i) || i < 0 || i > 49)) throw erro('Informe produtos como a lista das posições das peças com defeito.');
  const produtos = [...new Set(b.produtos)].sort((x, y) => x - y);
  const qtds = {};
  for (const [k, v] of Object.entries(b.qtds || {})) {
    const i = Number(k), n = Number(v);
    if (!produtos.includes(i)) continue;
    if (!Number.isInteger(n) || n < 1 || n > quantidade) throw erro(`Quantidade com defeito: um número inteiro de 1 a ${quantidade}.`);
    if (n < quantidade) qtds[i] = n;   // todas = sem quantidade (como no ML)
  }
  const sku = b.sku == null ? null : String(b.sku).slice(0, 120);
  const data = b.data && !Number.isNaN(Date.parse(b.data)) ? new Date(b.data).toISOString() : null;
  const origem = b.origem == null ? null : String(b.origem).slice(0, 80);
  return { chave, canal: chave.split(':')[0], sku, quantidade, data_dev: data, origem, produtos, qtds };
}

function criar({ D }) {
  const marcas = () => new Map(D.defeitosCanalListar().map((m) => [m.chave, m]));
  // itens: [{ chave, sku (do painel), quantidade, data }] -> com as peças e a marcação
  function pecas(itens) {
    const porNumero = new Map(D.catalogoListar().map((p) => [p.numero, p]));
    const m = marcas();
    return itens.map((i) => pecasDo(i, porNumero, m.get(i.chave)));
  }
  // A resposta das rotas de devoluções de cada loja ganha as peças de cada item (d.pecas) e o custo das peças com defeito
  // (Amazon, Leroy e Magalu: somado em d.custo e no resumo; Shopee: resumo.pecas_defeito). Não muda o objeto do cache.
  function comPecas(canal, r, url) {
    if (!r || !Array.isArray(r.devolucoes)) return r;
    const tr = canal === 'shopee' ? null : D.skuTrocas(canal);
    const vinc = canal === 'magalu' ? D.skuVinculos('magalu') : null;
    const doPainel = (sku, data) => { const s = (vinc && sku && vinc.get(sku)) || sku; return tr ? C.skuNaData(tr, s, data || undefined) : s; };
    const loja = url.searchParams.get('loja');
    const itensDe = (d) => {
      if (canal === 'shopee') return d.status === 'CANCELLED' ? [] : (d.itens || []).map((i, k) => ({ chave: `shopee:${loja}:${d.devolucao}:${k}`, sku: i.sku, quantidade: i.quantidade, data: d.data }));
      if (canal === 'amazon' && d.canal === 'FBA') return [];
      if (canal === 'magalu') return (d.itens || []).map((i, k) => ({ chave: `magalu:${d.pedido}:${k}`, sku: doPainel(i.sku, d.data_venda), quantidade: i.quantidade, data: d.data || d.data_venda }));
      return [{ chave: `${canal}:${d.pedido}:${d.sku || 'sem-sku'}`, sku: doPainel(d.sku, d.data_venda || d.data), quantidade: d.quantidade, data: d.data || d.data_venda }];
    };
    const todos = r.devolucoes.map(itensDe);
    const ps = pecas(todos.flat().map((i) => ({ ...i, chave: i.chave.replace(/[^A-Za-z0-9_.:|-]/g, '-') })));
    let k = 0, total = 0;
    const porSku = new Map();
    const devolucoes = r.devolucoes.map((d, i) => {
      const meus = ps.slice(k, k += todos[i].length);
      const soma = r2(meus.reduce((s, p) => s + p.peca_defeito, 0));
      total += soma;
      if (soma && canal !== 'shopee') porSku.set(d.sku || d.titulo || d.pedido, r2((porSku.get(d.sku || d.titulo || d.pedido) || 0) + soma));
      return { ...d, pecas: meus, pecas_defeito: soma, ...(canal !== 'shopee' && d.custo != null ? { custo: r2(d.custo + soma) } : {}) };
    });
    const resumo = { ...r.resumo, pecas_defeito: r2(total), conferir: ps.filter((p) => !p.conferida).length,
      ...(canal !== 'shopee' && r.resumo?.custo != null ? { custo: r2(r.resumo.custo + total) } : {}) };
    const por_produto = Array.isArray(r.por_produto) ? r.por_produto.map((m) => {
      const s = porSku.get(m.sku || m.titulo); return s ? { ...m, custo: r2(m.custo + s) } : m; }) : r.por_produto;
    return { ...r, resumo, por_produto, devolucoes };
  }
  function envolver(routes) {
    for (const canal of ['shopee', 'amazon', 'leroy', 'magalu']) {
      const k = `GET /api/${canal}/devolucoes`, fn = routes[k];
      if (fn) routes[k] = async (url, ...resto) => comPecas(canal, await fn(url, ...resto), url);
    }
  }
  const rotas = {
    // Marca as peças com defeito de um item devolvido ([] = conferido, voltou tudo bom). Escrita só pela tela.
    'PUT /api/devolucoes/canais/defeito': async (_u, b) => {
      const m = validar(b);
      D.defeitoCanalGravar(m);
      return { ok: true, chave: m.chave, produtos: m.produtos, qtds: m.qtds };
    },
  };
  return { pecas, comPecas, envolver, rotas };
}

module.exports = { criar, pecasDo, validar };
