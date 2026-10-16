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
}

console.log('Ads (gestão): criar/editar campanha, ROAS 1x–35x, grupos de anúncio e agrupamento sem duplicar: ok');
