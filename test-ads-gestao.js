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

console.log('Ads (gestão): criar/editar campanha, ROAS 1x–35x, grupos de anúncio e agrupamento sem duplicar: ok');
