'use strict';
// node test-ads-gestao.js — gestão das campanhas do Mercado Ads (ads-gestao.js): o corpo enviado ao ML ao criar/editar,
// a lista de grupos de anúncio e o agrupamento das linhas do ads/search. Só funções puras: nada aqui chama o ML.
const assert = require('node:assert/strict');
const G = require('./ads-gestao.js');

// criar: tudo obrigatório, ROAS de 1x a 35x, vírgula vale, canal marketplace
assert.deepEqual(G.campanhaDoCorpo({ nome: ' Primor teste ', status: 'active', orcamento: '20,00', estrategia: 'PROFITABILITY', roas_alvo: '11,5' }, { nova: true }),
  { name: 'Primor teste', status: 'active', budget: 20, strategy: 'profitability', roas_target: 11.5, channel: 'marketplace' });
assert.throws(() => G.campanhaDoCorpo({ nome: 'x', status: 'active', orcamento: 20, estrategia: 'increase' }, { nova: true }), /ROAS/, 'nova sem ROAS');
assert.throws(() => G.campanhaDoCorpo({ nome: 'x', status: 'active', orcamento: 20, estrategia: 'increase', roas_alvo: 36 }, { nova: true }), /1x a 35x/);
assert.throws(() => G.campanhaDoCorpo({ nome: 'x', status: 'active', orcamento: 20, estrategia: 'increase', roas_alvo: 0.5 }, { nova: true }), /1x a 35x/);
assert.throws(() => G.campanhaDoCorpo({ nome: 'x', status: 'active', orcamento: 0, estrategia: 'increase', roas_alvo: 5 }, { nova: true }), /Orçamento/);
assert.throws(() => G.campanhaDoCorpo({ nome: '', status: 'active', orcamento: 10, estrategia: 'increase', roas_alvo: 5 }, { nova: true }), /Nome/);
assert.throws(() => G.campanhaDoCorpo({ nome: 'x', status: 'deleted', orcamento: 10, estrategia: 'increase', roas_alvo: 5 }, { nova: true }), /ativa ou pausada/);
assert.throws(() => G.campanhaDoCorpo({ nome: 'x', status: 'active', orcamento: 10, estrategia: 'acos', roas_alvo: 5 }, { nova: true }), /Estratégia/);
// editar: só o que veio
assert.deepEqual(G.campanhaDoCorpo({ roas_alvo: 14 }), { roas_target: 14 });
assert.deepEqual(G.campanhaDoCorpo({ status: 'paused', orcamento: '7.5' }), { status: 'paused', budget: 7.5 });
assert.throws(() => G.campanhaDoCorpo({}), /Nada para mudar/);

// grupos: inteiros, sem repetir, até 500
assert.deepEqual(G.gruposDoCorpo([2981333372, '2981333372', 2951726575]), [2981333372, 2951726575]);
assert.throws(() => G.gruposDoCorpo([]), /pelo menos um/);
assert.throws(() => G.gruposDoCorpo(['MLB123']), /inválido/);
assert.throws(() => G.gruposDoCorpo(Array.from({ length: 501 }, (_, i) => i + 1)), /500/);

// ads/search -> grupos: linha repetida da paginação conta uma vez; variações do mesmo grupo juntas; ROAS do grupo
{
  const l = (item, grupo, cost, total, extra = {}) => ({ item_id: item, ad_group_id: grupo, campaign_id: 7, title: 'Ducha ' + item, status: 'paused',
    metrics: { cost, total_amount: total, clicks: 1, prints: 10, units_quantity: 1 }, ...extra });
  const g = G.agruparAnuncios([l('MLB1', 100, 10, 50), l('MLB1', 100, 10, 50), l('MLB2', 100, 5, 0, { status: 'active', recommended: true }), l('MLB3', 200, 0, 0)]);
  assert.equal(g.length, 2);
  const a = g.find((x) => x.ad_group_id === 100);
  assert.deepEqual(a.itens.map((i) => i.item_id), ['MLB1', 'MLB2'], 'linha repetida não duplica o anúncio');
  assert.equal(a.investimento, 15, 'soma sem a linha repetida');
  assert.equal(a.receita, 50);
  assert.equal(a.roas, 50 / 15);
  assert.equal(a.status, 'active', 'um anúncio ativo deixa o grupo ativo');
  assert.equal(a.recomendado, true);
  assert.equal(g.find((x) => x.ad_group_id === 200).roas, null, 'sem gasto: ROAS vazio, não infinito');
}


// antes e depois: janelas em dia de Brasília (depois vai só até ontem) e a soma por grupo, com e sem Ads
{
  const hoje = Date.parse('2026-10-16T13:00:00Z');
  const j = G.janelasAntesDepois('2026-10-07', 14, hoje);
  assert.deepEqual(j, { antes: { de: '2026-09-23', ate: '2026-10-06', dias: 14 }, depois: { de: '2026-10-07', ate: '2026-10-15', dias: 9 } });
  assert.throws(() => G.janelasAntesDepois('2026-10-16', 14, hoje), /até ontem/);
  assert.throws(() => G.janelasAntesDepois('2026-07-20', 14, hoje), /90 dias/);
  assert.throws(() => G.janelasAntesDepois('2026-10-07', 10, hoje), /7, 14, 21 ou 30/);
  const ga = [{ ad_group_id: 1, titulo: 'Ducha', status: 'active', itens: [{ item_id: 'MLB1' }], investimento: 0, receita: 0, unidades: 0 }];
  const gd = [{ ad_group_id: 1, titulo: 'Ducha', status: 'active', itens: [{ item_id: 'MLB1' }, { item_id: 'MLB2' }], investimento: 135, receita: 526, unidades: 2 }];
  const venda = (dia, fat, lucro, item = 'MLB1') => ({ valida: true, item_id: item, data: dia + 'T15:00:00Z', quantidade: 1, faturamento: fat, lucro });
  const linhas = [venda('2026-10-01', 250, 87), venda('2026-10-08', 250, 87), venda('2026-10-09', 250, 87, 'MLB2'), venda('2026-10-10', 250, null, 'MLB9'),
    { ...venda('2026-10-11', 250, 87), valida: false }];
  const r = G.somarAntesDepois(ga, gd, linhas, j);
  assert.deepEqual([r.total.antes.unidades, r.total.depois.unidades, r.total.depois.faturamento, r.total.depois.lucro, r.total.depois.lucro_depois_ads], [1, 2, 500, 174, 39],
    'venda do outro item do grupo entra; item fora da campanha e cancelada não');
  assert.equal(r.total.depois.ads_inv, 135);
  assert.equal(r.grupos[0].itens.length, 2);
  assert.equal(r.sem_grandes, null, 'sem pedido grande, sem total ajustado');
}
// pedido grande: 7 braços de teto num pedido só (caso real de 23/09) — marcado e tirado do total ajustado
{
  const j = G.janelasAntesDepois('2026-10-01', 14, Date.parse('2026-10-16T13:00:00Z'));
  const g = [{ ad_group_id: 9, titulo: 'Braço de teto', status: 'active', itens: [{ item_id: 'MLB705658750' }], investimento: 2, receita: 0, unidades: 0 }];
  const l = (pedido, dia, q, fat, lucro) => ({ valida: true, pedido, item_id: 'MLB705658750', data: dia + 'T15:00:00Z', quantidade: q, faturamento: fat, lucro });
  const r = G.somarAntesDepois(g, g, [l(1, '2026-09-23', 7, 385.98, 125), l(2, '2026-09-25', 1, 58, 15), l(3, '2026-10-05', 1, 58, 15)], j);
  assert.deepEqual(r.grupos[0].antes.pedido_grande, { pedido: 1, unidades: 7, faturamento: 385.98 });
  assert.equal(r.grupos[0].depois.pedido_grande, null);
  assert.deepEqual([r.sem_grandes.antes.unidades, r.sem_grandes.antes.lucro, r.total.antes.unidades], [1, 15, 8]);
  assert.equal(r.pedidos_grandes.length, 1);
}

// leilão: lê a exposição e diz por que perde (verba x posição); ROAS de referência = 100 ÷ ACOS de referência
{
  const v = G.leilaoDe({ cost: 100, total_amount: 2000, impression_share: 0.55, lost_impression_share_by_budget: 0.35, lost_impression_share_by_ad_rank: 0.10, acos_benchmark: 8 });
  assert.deepEqual([v.aparece, v.perde_verba, v.acos, v.roas_referencia], [0.55, 0.35, 5, 12.5]);
  assert.match(v.leitura, /VERBA/);
  assert.match(G.leilaoDe({ impression_share: 0.4, lost_impression_share_by_budget: 0.05, lost_impression_share_by_ad_rank: 0.55 }).leitura, /POSIÇÃO/);
  assert.match(G.leilaoDe({ impression_share: 0.92, lost_impression_share_by_budget: 0.03, lost_impression_share_by_ad_rank: 0.05 }).leitura, /quase todas/);
  assert.equal(G.leilaoDe({}).aparece, null);
}

// anúncios que venderam pelo Ads: linha repetida conta uma vez; só quem vendeu; participação e variação contra o período anterior
{
  const l = (item, camp, total, un, cost) => ({ item_id: item, ad_group_id: 1, campaign_id: camp, title: 'Ducha ' + item,
    metrics: { total_amount: total, direct_amount: total / 2, units_quantity: un, clicks: 10, prints: 100, cost } });
  const r = G.vendasPorAnuncio([l('MLB1', 7, 300, 3, 30), l('MLB1', 7, 300, 3, 30), l('MLB2', 7, 100, 1, 50), l('MLB3', 8, 0, 0, 20)], [l('MLB1', 7, 150, 2, 20)], { 7: 'Portfólio 01' });
  assert.deepEqual(r.anuncios.map((a) => a.item_id), ['MLB1', 'MLB2'], 'sem venda fica de fora; maior venda primeiro');
  assert.deepEqual([r.anuncios[0].vendas, r.anuncios[0].unidades, r.anuncios[0].participacao, r.anuncios[0].variacao], [300, 3, 0.75, 1], 'repetida conta uma vez');
  assert.deepEqual(r.anuncios[0].campanhas, ['Portfólio 01']);
  assert.equal(r.anuncios[1].variacao, null, 'sem venda antes: sem variação');
  assert.deepEqual([r.total.anuncios, r.total.vendas, r.total.unidades, r.total.vendas_antes], [2, 400, 4, 150]);
  assert.deepEqual(G.janelaAnterior({ date_from: '2026-10-12', date_to: '2026-10-18' }), { date_from: '2026-10-05', date_to: '2026-10-11' });
  assert.deepEqual([r.anuncios[0].direta, r.anuncios[0].indireta, r.anuncios[0].un_direta], [150, 150, null], 'sem métrica de unidades por tipo: null');
  const u = G.vendasPorAnuncio([{ ...l('MLB9', 7, 100, 2, 10), metrics: { total_amount: 100, direct_amount: 60, units_quantity: 2, direct_units_quantity: 1, indirect_units_quantity: 1 } }]);
  assert.deepEqual([u.anuncios[0].indireta, u.anuncios[0].un_direta, u.anuncios[0].un_indireta], [40, 1, 1]);
  const hoje = Date.parse('2026-10-19T15:00:00Z');
  assert.deepEqual(G.janelaEscolhida({ dias: 7 }, hoje), { date_from: '2026-10-12', date_to: '2026-10-18', dias: 7, personalizado: false });
  assert.deepEqual(G.janelaEscolhida({ de: '2026-10-01', ate: '2026-10-10' }, hoje), { date_from: '2026-10-01', date_to: '2026-10-10', dias: 10, personalizado: true });
  assert.throws(() => G.janelaEscolhida({ de: '2026-10-10', ate: '2026-10-19' }, hoje), /até ontem/);
  assert.throws(() => G.janelaEscolhida({ de: '2026-07-01', ate: '2026-07-10' }, hoje), /90 dias/);
  assert.throws(() => G.janelaEscolhida({ de: '2026-10-10', ate: '2026-10-01' }, hoje), /depois da final/);
}

console.log('Ads (gestão): criar/editar campanha, ROAS 1x–35x, grupos de anúncio e agrupamento sem duplicar: ok');
