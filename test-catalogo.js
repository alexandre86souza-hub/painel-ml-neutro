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
    falta: ['Full', 'xyz abc'], motivos: ['item_not_opted_in'] });
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

console.log('Catálogo (disputa) e motivo da pausa: ok');
