'use strict';
// Campanhas da Amazon e da Leroy (tela public/campanhas-canais.html?conta=amazon|leroy). Duas coisas:
//   1) Descontos nos anúncios: o preço promocional com início e fim que o vendedor põe em cada
//      oferta (Amazon: purchasable_offer.discounted_price; Leroy: discount da oferta, OF21/PRI01).
//      A tela lista, mostra o resultado (vendas e lucro no período do desconto contra os mesmos
//      dias antes) e cria/encerra — escrita só pelo clique, com confirmação; nada no MCP.
//   2) Promoções: as que aparecem nas vendas (Amazon: PromotionList do financeiro, com o id da
//      promoção; Leroy: promotions da linha do pedido) com o resultado de cada uma. As promoções
//      que a Amazon oferece para participar (cupons, ofertas relâmpago, Prime) não têm API: a tela
//      leva ao Seller Central. Na Leroy, PR01 (/api/promotions) lista as da loja.
// Funções puras: testadas em test-campanhas-canais.js.
const r2 = (v) => Math.round(v * 100) / 100;
const n = (v) => Number(v) || 0;
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Situação de um desconto pelas datas (sem data de fim = vale até ser tirado).
function situacao(inicio, fim, agora = Date.now()) {
  const i = inicio ? Date.parse(inicio) : null, f = fim ? Date.parse(fim) : null;
  if (f != null && f <= agora) return 'encerrado';
  if (i != null && i > agora) return 'agendado';
  return 'ativo';
}

// Soma das linhas de venda (formato de canais.js) de um SKU numa janela.
function somaSku(linhas, sku, de, ate) {
  const t = { pedidos: new Set(), unidades: 0, faturamento: 0, lucro: 0, sem_lucro: 0 };
  for (const l of linhas) {
    if (!l.valida || l.sku !== sku || l.data < de || l.data >= ate) continue;
    t.pedidos.add(l.pedido); t.unidades += n(l.quantidade); t.faturamento += n(l.faturamento);
    if (l.lucro == null) t.sem_lucro++; else t.lucro += l.lucro;
  }
  return { pedidos: t.pedidos.size, unidades: t.unidades, faturamento: r2(t.faturamento), lucro: r2(t.lucro), sem_lucro: t.sem_lucro };
}

// Resultado de um desconto: o período dele (até agora, se ainda vale) contra os mesmos dias antes.
function resultadoDesconto(linhas, sku, inicio, fim, agora = Date.now()) {
  if (!inicio) return null;
  const de = new Date(Date.parse(inicio)).toISOString();
  const ateMs = Math.min(fim ? Date.parse(fim) : agora, agora);
  if (!(ateMs > Date.parse(de))) return null;
  const ate = new Date(ateMs).toISOString();
  const antesDe = new Date(Date.parse(de) - (ateMs - Date.parse(de))).toISOString();
  const dias = Math.max(1, Math.round((ateMs - Date.parse(de)) / 864e5));
  return { dias, durante: somaSku(linhas, sku, de, ate), antes: somaSku(linhas, sku, antesDe, de) };
}

// Resultado por promoção: as linhas de venda que trazem a promoção (l.promocoes = [{id, nome, valor}]).
// valor = desconto dado ao cliente naquela linha (positivo). Promoção sem id (a Amazon às vezes não
// manda) fica junta numa só, "sem identificação".
function resultadoPromocoes(linhas) {
  const m = new Map();
  for (const l of linhas) {
    if (!l.valida) continue;
    for (const p of l.promocoes || []) {
      const id = p.id || '';
      const x = m.get(id) || { id: id || null, nome: p.nome || p.id || null, tipo: p.tipo || null, pedidos: new Set(), unidades: 0,
        faturamento: 0, desconto: 0, lucro: 0, sem_lucro: 0, primeira: l.data, ultima: l.data, skus: new Map() };
      x.pedidos.add(l.pedido); x.unidades += n(l.quantidade); x.faturamento += n(l.faturamento); x.desconto += n(p.valor);
      if (l.lucro == null) x.sem_lucro++; else x.lucro += l.lucro;
      if (l.data < x.primeira) x.primeira = l.data;
      if (l.data > x.ultima) x.ultima = l.data;
      if (l.sku) { const s = x.skus.get(l.sku) || { sku: l.sku, titulo: l.titulo, unidades: 0, faturamento: 0 }; s.unidades += n(l.quantidade); s.faturamento += n(l.faturamento); x.skus.set(l.sku, s); }
      m.set(id, x);
    }
  }
  return [...m.values()].map((x) => ({ ...x, pedidos: x.pedidos.size, faturamento: r2(x.faturamento), desconto: r2(x.desconto), lucro: r2(x.lucro),
    skus: [...x.skus.values()].map((s) => ({ ...s, faturamento: r2(s.faturamento) })).sort((a, b) => b.faturamento - a.faturamento).slice(0, 10) }))
    .sort((a, b) => b.ultima.localeCompare(a.ultima));
}

// Pedido de desconto digitado na tela: itens [{sku, preco}] (preço promocional por unidade),
// início e fim (AAAA-MM-DD, horário de Brasília: início 00h, fim 23h59). precoAtual: Map sku -> preço
// cheio. Recusa desconto que não seja menor que o preço cheio. Função pura: testada.
function validarDesconto(body, precoAtual, agora = Date.now()) {
  const itens = Array.isArray(body?.itens) ? body.itens : [];
  if (!itens.length) throw erro('Escolha ao menos um anúncio.');
  if (itens.length > 200) throw erro('No máximo 200 anúncios por vez.');
  const dia = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const ini = dia(body?.inicio), fimD = dia(body?.fim);
  if (!ini || !fimD) throw erro('Informe a data de início e a de fim.');
  const inicio = new Date(Date.parse(ini + 'T03:00:00Z'));
  const fim = new Date(Date.parse(fimD + 'T03:00:00Z') + 864e5 - 60e3);   // 23h59 de Brasília
  if (!(fim > inicio)) throw erro('A data de fim precisa ser depois da de início.');
  if (fim.getTime() <= agora) throw erro('A data de fim já passou.');
  if (fim - inicio > 366 * 864e5) throw erro('Desconto de no máximo 1 ano.');
  const out = [];
  for (const it of itens) {
    const sku = String(it?.sku ?? '').trim();
    if (!sku || sku.length > 80) throw erro('SKU inválido.');
    if (!precoAtual.has(sku)) throw erro(`Anúncio ${sku} não encontrado.`, 404);
    const cheio = n(precoAtual.get(sku));
    const preco = r2(Number(String(it?.preco ?? '').replace(',', '.')));
    if (!(preco > 0)) throw erro(`Preço promocional inválido em ${sku}.`);
    if (!(preco < cheio)) throw erro(`${sku}: o preço promocional (${preco.toFixed(2)}) precisa ser menor que o preço cheio (${cheio.toFixed(2)}).`);
    out.push({ sku, preco, cheio });
  }
  return { itens: out, inicio: inicio.toISOString(), fim: fim.toISOString() };
}

// CSV do PRI01 da Mirakl (só preços; o estoque não é tocado). Modo "apaga e substitui" dos PREÇOS
// da oferta: manda o preço cheio junto, e sem desconto = encerra. Função pura: testada.
function csvPrecosMirakl(linhas) {
  const q = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const cab = ['offer-sku', 'price', 'discount-price', 'discount-start-date', 'discount-end-date'].map(q).join(';');
  return [cab, ...linhas.map((l) => [l.sku, n(l.cheio).toFixed(2), l.preco != null ? n(l.preco).toFixed(2) : null,
    l.preco != null ? l.inicio : null, l.preco != null ? l.fim : null].map(q).join(';'))].join('\n') + '\n';
}

module.exports = { situacao, somaSku, resultadoDesconto, resultadoPromocoes, validarDesconto, csvPrecosMirakl };
