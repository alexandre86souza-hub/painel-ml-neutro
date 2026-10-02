'use strict';
// Contas de outros marketplaces (Shopee hoje; Magalu e Leroy depois) nas telas do painel.
// Cada canal entrega LINHAS DE VENDA no mesmo formato (uma por item de pedido) e este módulo
// monta as respostas das telas Pedidos/Vendas Hoje, Performance, ABC e o resumo de "Todas as
// contas" — o mesmo formato das rotas do Mercado Livre (custos.js#vendasDaConta,
// painel.js#performance e #abc). Funções puras: testadas em test-canais.js.
//
// Linha de venda: { pedido, data (ISO, data da compra), status, valida, sku, item_id, titulo,
//   foto, quantidade, faturamento, tarifa, frete, produto, embalagem, imposto, lucro, margem,
//   falta, estimado, custo_unit, componentes, faltando, link }
const A = require('./public/analise.js');
const r2 = (v) => Math.round(v * 100) / 100;

// Mesma janela das vendas do ML: hoje = desde 00h de Brasília; período = dias completos + hoje.
function janelaVendas(dias, janela, agora = Date.now()) {
  if (dias === 1) return { de: new Date(Date.parse(new Date(agora - 3 * 3600e3).toISOString().slice(0, 10) + 'T03:00:00Z')).toISOString(),
    ate: new Date(agora + 60e3).toISOString() };
  return { ...janela(dias), ate: new Date(agora + 60e3).toISOString() };
}
// Período terminando amanhã 00h de Brasília (inclui hoje), como painel.js#performance.
function intervalo(dias, fimMs = Date.now()) {
  const hojeLocal = new Date(fimMs - 3 * 3600e3).toISOString().slice(0, 10);
  const fim = new Date(Date.parse(hojeLocal + 'T03:00:00Z') + 864e5);
  return { de: new Date(fim.getTime() - dias * 864e5).toISOString(), ate: fim.toISOString() };
}
const diaLocal = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);

// Resumo no formato das contas (cartões de Pedidos e de "Todas as contas").
function somaLinhas(ls) {
  const validas = ls.filter((l) => l.valida);
  const t = { pedidos: new Set(validas.map((l) => l.pedido)).size, unidades: 0, faturamento: 0, tarifa: 0, frete: 0, produto: 0,
    embalagem: 0, imposto: 0, lucro: 0, com_lucro: 0, cancelados: ls.filter((l) => !l.valida).length };
  for (const l of validas) {
    t.unidades += l.quantidade || 0;
    for (const k of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto']) t[k] += l[k] || 0;
    if (l.lucro != null) { t.lucro += l.lucro; t.com_lucro += l.faturamento || 0; }
  }
  for (const k of ['faturamento', 'tarifa', 'frete', 'produto', 'embalagem', 'imposto', 'lucro']) t[k] = r2(t[k]);
  t.margem = t.com_lucro > 0 ? t.lucro / t.com_lucro : null;
  t.cobertura = t.faturamento > 0 ? Math.min(1, t.com_lucro / t.faturamento) : null;
  delete t.com_lucro;
  return t;
}

// SKUs vendidos sem custo (alerta da tela Pedidos).
function semCusto(ls) {
  const m = new Map();
  for (const l of ls) {
    if (!l.valida || l.custo_unit != null || !l.sku) continue;
    const s = m.get(l.sku) || { item_id: l.sku, titulo: l.titulo, sku: l.sku, faltando: l.faltando || [], vendas: 0 };
    s.vendas++; m.set(l.sku, s);
  }
  return [...m.values()].sort((a, b) => b.vendas - a.vendas);
}

// Tela Performance: período atual contra o anterior (sem visitas: os canais não dão).
function performanceDe(linhas, dias, deAtual) {
  const la = linhas.filter((l) => l.data >= deAtual), lb = linhas.filter((l) => l.data < deAtual);
  const tot = (ls) => { const s = somaLinhas(ls);
    return { faturamento: s.faturamento, pedidos: s.pedidos, unidades: s.unidades, tarifas: s.tarifa,
      ticket: s.pedidos ? s.faturamento / s.pedidos : 0, visitas: null, conversao: null,
      cancelados: new Set(ls.filter((l) => !l.valida).map((l) => l.pedido)).size }; };
  const porSku = (ls) => { const m = new Map(); for (const l of ls) { if (!l.valida || !l.sku) continue;
    const x = m.get(l.sku) || { fat: 0, un: 0, titulo: l.titulo, foto: l.foto }; x.fat += l.faturamento || 0; x.un += l.quantidade || 0; m.set(l.sku, x); } return m; };
  const pa = porSku(la), pb = porSku(lb);
  const mov = [...new Set([...pa.keys(), ...pb.keys()])].map((id) => {
    const x = pa.get(id) || pb.get(id);
    return { id, atual: r2(pa.get(id)?.fat || 0), antes: r2(pb.get(id)?.fat || 0), unidades: pa.get(id)?.un || 0,
      unidades_antes: pb.get(id)?.un || 0, titulo: x.titulo, foto: x.foto };
  }).map((x) => ({ ...x, delta: r2(x.atual - x.antes) }));
  const porDia = (ls) => { const m = {}; for (const l of ls) { if (!l.valida) continue; const d = diaLocal(l.data);
    const x = m[d] || (m[d] = { faturamento: 0, pedidos: new Set() }); x.faturamento += l.faturamento || 0; x.pedidos.add(l.pedido); } return m; };
  const da = porDia(la), db = porDia(lb);
  const serie = A.diasDaJanela(dias).map((dia) => {
    const antes = new Date(Date.parse(dia) - dias * 864e5).toISOString().slice(0, 10);
    return { dia, faturamento: r2(da[dia]?.faturamento || 0), pedidos: da[dia]?.pedidos.size || 0, anterior: r2(db[antes]?.faturamento || 0) };
  });
  return { dias, atual: tot(la), anterior: tot(lb), serie,
    sobe: mov.filter((x) => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10),
    cai: mov.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 10) };
}

// Tela ABC por SKU. semVenda: itens com estoque que não venderam (o canal passa, se souber).
function abcDe(linhas, { dias, de, ate, semVenda = [], ativos = 0 } = {}) {
  const m = new Map();
  for (const l of linhas) {
    if (!l.valida || !l.sku) continue;
    const x = m.get(l.sku) || { id: l.sku, titulo: l.titulo, foto: l.foto, faturamento: 0, unidades: 0, pedidos: new Set(), lucro: 0, sem_lucro: false, falta: new Set() };
    x.faturamento += l.faturamento || 0; x.unidades += l.quantidade || 0; x.pedidos.add(l.pedido);
    if (l.lucro == null) { x.sem_lucro = true; for (const f of l.falta || []) x.falta.add(f); } else x.lucro += l.lucro;
    m.set(l.sku, x);
  }
  const itens = [...m.values()];
  const curva = A.curvaABC(Object.fromEntries(itens.map((x) => [x.id, x.faturamento])));
  const total = itens.reduce((s, x) => s + x.faturamento, 0);
  let acum = 0;
  const ls = itens.filter((x) => curva[x.id]).sort((a, b) => curva[a.id].ranking - curva[b.id].ranking).map((x) => {
    acum += x.faturamento;
    const lucro = x.sem_lucro ? null : r2(x.lucro);
    return { id: x.id, classe: curva[x.id].classe, ranking: curva[x.id].ranking, faturamento: r2(x.faturamento),
      participacao: curva[x.id].participacao, acumulado: total ? acum / total : 0, unidades: x.unidades, pedidos: x.pedidos.size,
      lucro, margem: lucro != null && x.faturamento > 0 ? lucro / x.faturamento : null, falta: [...x.falta],
      titulo: x.titulo, foto: x.foto, estoque: null, status: 'active' };
  });
  const classes = ['A', 'B', 'C'].map((k) => {
    const x = ls.filter((l) => l.classe === k);
    const f = x.reduce((s, l) => s + l.faturamento, 0);
    return { classe: k, anuncios: x.length, faturamento: r2(f), participacao: total ? f / total : 0,
      lucro: r2(x.reduce((s, l) => s + (l.lucro || 0), 0)), sem_lucro: x.filter((l) => l.lucro == null).length };
  });
  return { dias, de, ate, total: r2(total), classes, linhas: ls,
    sem_venda: { total: semVenda.length, ativos, ja_venderam: semVenda.filter((x) => x.vendidos_total > 0).length,
      nunca: semVenda.filter((x) => !x.vendidos_total).length, itens: semVenda } };
}

// Resumo para "Todas as contas" (o mesmo formato de amazon.js#vendasAmazon): hoje, período,
// faturamento por dia e os produtos (topPorSku junta com as outras contas pelo número do SKU).
function resumoGeral(linhas, { dias, de, ate, hojeDe, conta, topPorSku }) {
  const porDia = new Map();
  for (const l of linhas) {
    if (!l.valida) continue;
    const dia = diaLocal(l.data);
    const d = porDia.get(dia) || { dia, faturamento: 0, pedidos: new Set() };
    d.faturamento += l.faturamento || 0; d.pedidos.add(l.pedido); porDia.set(dia, d);
  }
  return {
    dias, de, ate, resumo: somaLinhas(linhas), hoje: somaLinhas(linhas.filter((l) => l.data >= hojeDe)),
    por_dia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)).map((d) => ({ dia: d.dia, faturamento: r2(d.faturamento), pedidos: d.pedidos.size })),
    sem_custo: semCusto(linhas),
    produtos: topPorSku(linhas.filter((l) => l.valida).map((l) => ({ ...l, conta })), 100),
  };
}

module.exports = { janelaVendas, intervalo, diaLocal, somaLinhas, semCusto, performanceDe, abcDe, resumoGeral };
