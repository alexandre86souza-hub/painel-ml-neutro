// Alerta de margem (pedido do dono, 03/11/2026): os anúncios que VENDERAM com margem abaixo do mínimo, em todas as lojas,
// com o motivo provável. As linhas são as vendas de cada loja no formato comum (custos.js#vendasDaConta e canais.js:
// faturamento, tarifa, frete, produto, embalagem, imposto, lucro). Só leitura; corrigir o preço é nas telas de anúncios.
const r2 = (v) => Math.round(v * 100) / 100;
const PARTES = [['tarifa', 'tarifa do marketplace'], ['frete', 'frete'], ['produto', 'custo do produto'], ['embalagem', 'embalagem/outros'], ['imposto', 'imposto']];

// Por anúncio de cada loja: vendas válidas COM lucro calculado; margem = lucro ÷ faturamento. Abaixo do mínimo entra, com
// o peso de cada custo no faturamento contra o da loja inteira: a parte que mais passou da média da loja é o motivo
// provável (ex.: frete 31% contra 14% da loja). Prejuízo vem antes; depois o que mais perdeu em R$. Função pura: testada.
function margemBaixaDe(grupos, { minimo = 0.1 } = {}) {
  const itens = [];
  for (const g of grupos) {
    const ls = (g.linhas || []).filter((l) => l.valida && l.lucro != null && (l.faturamento || 0) > 0);
    const totLoja = { faturamento: 0 };
    for (const [k] of PARTES) totLoja[k] = 0;
    const porItem = new Map();
    for (const l of ls) {
      totLoja.faturamento += l.faturamento;
      for (const [k] of PARTES) totLoja[k] += l[k] || 0;
      const id = l.item_id || l.sku;
      const x = porItem.get(id) || { loja: g.loja, conta: g.conta, item_id: id, sku: l.sku || null, titulo: l.titulo || null, foto: l.foto || null,
        pedidos: new Set(), unidades: 0, faturamento: 0, lucro: 0, partes: Object.fromEntries(PARTES.map(([k]) => [k, 0])), ultima: l.data };
      x.pedidos.add(l.pedido); x.unidades += l.quantidade || 0; x.faturamento += l.faturamento; x.lucro += l.lucro;
      for (const [k] of PARTES) x.partes[k] += l[k] || 0;
      if (l.data > x.ultima) x.ultima = l.data;
      x.titulo ||= l.titulo || null; x.foto ||= l.foto || null;
      porItem.set(id, x);
    }
    const pesoLoja = Object.fromEntries(PARTES.map(([k]) => [k, totLoja.faturamento ? totLoja[k] / totLoja.faturamento : 0]));
    for (const x of porItem.values()) {
      const margem = x.lucro / x.faturamento;
      if (margem >= minimo) continue;
      const peso = Object.fromEntries(PARTES.map(([k]) => [k, x.partes[k] / x.faturamento]));
      const [k, nome] = PARTES.map((p) => [...p, peso[p[0]] - pesoLoja[p[0]]]).sort((a, b) => b[2] - a[2])[0];
      const pp = (v) => `${(v * 100).toFixed(0)}%`;
      itens.push({ ...x, pedidos: x.pedidos.size, faturamento: r2(x.faturamento), lucro: r2(x.lucro), margem,
        partes: Object.fromEntries(PARTES.map(([p]) => [p, r2(x.partes[p])])), peso, peso_loja: pesoLoja,
        motivo: peso[k] - pesoLoja[k] > 0.02 ? `${nome} ${pp(peso[k])} das vendas (a loja: ${pp(pesoLoja[k])})` : 'preço baixo para os custos (nenhum custo fora da média da loja)',
        motivo_parte: peso[k] - pesoLoja[k] > 0.02 ? k : 'preco', prejuizo: x.lucro < 0 });
    }
  }
  return itens.sort((a, b) => (b.prejuizo - a.prejuizo) || (a.lucro - minimo * a.faturamento) - (b.lucro - minimo * b.faturamento));
}

module.exports = { margemBaixaDe, PARTES };
