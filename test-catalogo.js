'use strict';
// Disputa do catálogo do ML (catalogo.js) e o motivo da pausa do anúncio (painel.js#motivoDaPausa).
const assert = require('node:assert');
const C = require('./catalogo.js');
const { motivoDaPausa } = require('./painel.js');
const E = require('./email.js');

{
  const l = C.leitura({ status: 'competing', current_price: 120, price_to_win: 109.9, competitors_sharing_first_place: 0, visit_share: 'minimum',
    winner: { item_id: 'MLB9', price: 109.9 }, boosts: [{ id: 'free_shipping', status: 'boosted' }, { id: 'fulfillment', status: 'opportunity' }, { id: 'xyz_abc', status: 'opportunity' }],
    reason: ['item_not_opted_in'] });
  assert.deepStrictEqual(l, { situacao: 'competing', preco: 120, preco_ganhar: 109.9, vencedor_preco: 109.9, dividem: 0, visitas: 'minimum',
    falta: ['Full', 'xyz abc'], motivos: ['item_not_opted_in'], produto: null });
  assert.strictEqual(C.leitura({}).situacao, null, 'resposta vazia não quebra');
}
assert.strictEqual(C.veredito(0.15, 15), 'vale');
assert.strictEqual(C.veredito(0.149, 15), 'nao_compensa');
assert.strictEqual(C.veredito(null, 15), null);
{
  const t = C.textoDoAviso({ preco: 100, preco_ganhar: 90, lucro_ganhar: 18, margem_ganhar: 0.2, veredito: 'vale', falta: ['Full'] }, 15);
  assert.match(t, /para ganhar: R\$\s?90,00 \(−10%\)/);
  assert.match(t, /vale baixar \(margem ≥ 15%\)/);
  assert.match(t, /o ganhador tem: Full/);
  assert.match(C.textoDoAviso({ preco: 100, preco_ganhar: null }, 15), /o preço sozinho não ganha/);
  assert.match(C.textoDoAviso({ preco: 100, preco_ganhar: 95, lucro_erro: 'sem custo' }, 15), /sem custo/);
}
{
  const cs = C.concorrentesDe({ results: [
    { item_id: 'MLB2', seller_id: 9, price: 130, shipping: { free_shipping: true } },
    { item_id: 'MLB1', seller_id: 7, price: 124, shipping: { logistic_type: 'fulfillment', free_shipping: true } },
    { item_id: 'MLB3', seller_id: 102366556, price: 128.6, shipping: {} },
  ] }, '102366556');
  assert.deepStrictEqual(cs.map((c) => c.item_id), ['MLB1', 'MLB2'], 'sem o próprio anúncio, do mais barato');
  assert.ok(cs[0].full && cs[1].frete_gratis && !cs[1].full);
  assert.match(C.textoConcorrentes(cs), /^R\$\s?124,00 Full · R\$\s?130,00 frete grátis$/);
  assert.match(C.textoDoAviso({ preco: 128.6, preco_ganhar: 124, concorrentes: cs }, 15), /concorrentes: R\$\s?124,00 Full/);
  assert.match(C.textoConcorrentes([{ preco: 129.73, frete_gratis: true, nossa: 'PRIMOR METAIS' }]), /\(sua conta PRIMOR METAIS\) — a disputa é só com a sua outra conta$/);
}
{
  const agora = { A: { situacao: 'competing' }, B: { situacao: 'competing' }, D: { situacao: 'winning' }, N: { situacao: 'competing' } };
  assert.deepStrictEqual(C.quemPassouAPerder(null, agora), [], '1ª leitura só vira a base');
  assert.deepStrictEqual(C.quemPassouAPerder({ A: { situacao: 'winning' }, B: { situacao: 'competing' }, D: { situacao: 'competing' } }, agora), ['A', 'N'],
    'avisa quem passou a perder e o anúncio novo já perdendo; quem continua perdendo não repete');
}

assert.deepStrictEqual(motivoDaPausa({ status: 'paused', sub_status: ['out_of_stock'] }), { pelo_ml: false, titulo: 'sem estoque', detalhe: '' });
assert.strictEqual(motivoDaPausa({ status: 'paused', sub_status: [] }).pelo_ml, false, 'pausado pelo vendedor fica só no sino');
assert.strictEqual(motivoDaPausa({ status: 'under_review', sub_status: [] }).pelo_ml, true);
{
  const m = motivoDaPausa({ status: 'paused', sub_status: ['out_of_stock', 'waiting_for_patch'] });
  assert.ok(m.pelo_ml && m.detalhe === 'aguardando correção', 'moderação junto com sem estoque vale como pausa do ML');
}
assert.ok(E.TIPOS_EMAIL.has('pausa_ml') && !E.TIPOS_EMAIL.has('pausa') && !E.TIPOS_EMAIL.has('catalogo'),
  'pausa do ML vai por e-mail; pausa comum e catálogo ficam no sino (catálogo também no relatório)');

// ofertas do catálogo para a tela: todas (a nossa marcada), mais barata primeiro, nome do vendedor e quem tem o botão
{ const o = C.ofertasDe({ results: [
    { item_id: 'MLB2', seller_id: 9, price: 35.24, shipping: { free_shipping: true }, listing_type_id: 'gold_special' },
    { item_id: 'MLB1', seller_id: 7, price: 33.79, shipping: { logistic_type: 'fulfillment' }, official_store_id: 3 },
    { item_id: 'MLB3', seller_id: 8, price: null } ] },
  { meuItem: 'MLB2', ganhador: 'MLB1', nomes: new Map([['7', { nome: 'LOJAX', medalha: 'gold' }]]), nossas: new Map([['9', 'LOJAB']]) });
  assert.deepStrictEqual(o.map((x) => x.item_id), ['MLB1', 'MLB2'], 'sem preço fica fora; mais barato primeiro');
  assert.strictEqual(o[0].nome, 'LOJAX'); assert.strictEqual(o[0].ganhador, true); assert.strictEqual(o[0].full, true); assert.strictEqual(o[0].loja_oficial, true);
  assert.strictEqual(o[1].eu, true); assert.strictEqual(o[1].nossa, 'LOJAB'); assert.strictEqual(o[1].frete_gratis, true); }

{ const N = require('./novidades.js');
  assert.deepStrictEqual(N.novosDe(null, ['A', 'B']), { novos: [], vistos: ['A', 'B'] }, '1ª leitura só vira a base');
  assert.deepStrictEqual(N.novosDe(['A', 'B'], ['C', 'A']).novos, ['C'], 'só o que não foi visto avisa');
  assert.deepStrictEqual(N.novosDe(['A', 'B'], ['A']).vistos, ['A', 'B'], 'quem saiu da lista continua visto (não avisa de novo)');
  assert.match(N.textoCampanhaMl({ type: 'DEAL', start_date: '2026-11-10T03:00:00Z', finish_date: '2026-11-12T02:59:00Z', deadline_date: '2026-11-08T03:00:00Z' }),
    /Campanha do Mercado Livre · 10\/11 a 11\/11 · entrar até 08\/11/);
  assert.ok(E.TIPOS_EMAIL.has('campanha') && E.TIPOS_EMAIL.has('anuncio_novo'), 'campanha e anúncio novo vão no e-mail'); }
console.log('Catálogo (disputa) e motivo da pausa: ok');
