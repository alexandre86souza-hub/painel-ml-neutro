'use strict';
// node test-painel.js — regras das telas de acompanhamento: qualidade do anúncio, dias de
// estoque no Full, venda que saiu do Full e campanha do vendedor. Só funções puras.
const assert = require('node:assert');
const P = require('./painel.js');
const { corpoCampanha } = require('./promocoes.js');

// ---------- venda do Full: node_id do armazém do ML (medido em 29/09/2026) ----------
assert.strictEqual(P.ehFull('BRSP04'), true);
assert.strictEqual(P.ehFull('BRSP02'), true);
assert.strictEqual(P.ehFull('BRP1234567891'), false, 'depósito do vendedor');
assert.strictEqual(P.ehFull(''), false);
assert.strictEqual(P.ehFull(null), false);

// ---------- dias de estoque no Full ----------
assert.deepStrictEqual(P.cobertura(44, 6, 5), { media_dia: 1.2, dias: 36 });
assert.deepStrictEqual(P.cobertura(10, 0, 30), { media_dia: 0, dias: null }, 'sem venda: não inventa prazo');

// ---------- qualidade (/item/{id}/performance real, resumido) ----------
const q = P.lerQualidade({ score: 79, level: 'good', buckets: [{ title: 'Dados do produto', variables: [
  { key: 'UP_TECHNICAL_SPECIFICATIONS_MAIN', status: 'COMPLETED', title: 'Corrija as características' },
  { key: 'UP_SHORTS', status: 'PENDING', title: 'Crie um vídeo para não perder vendas',
    rules: [{ wordings: { title: 'Os vídeos devem ter até um minuto' } }] },
  { key: 'UP_PICTURES', status: 'PENDING', title: 'Melhore as fotos para ter mais visitas' },
] }] });
assert.strictEqual(q.score, 79);
assert.strictEqual(q.pendentes.length, 2, 'só os pendentes');
assert.strictEqual(q.pendentes[0].cadastro, false, 'vídeo é objetivo, não cadastro incompleto');
assert.strictEqual(q.pendentes[1].cadastro, true, 'fotos = cadastro incompleto');
assert.strictEqual(q.pendentes[0].dica, 'Os vídeos devem ter até um minuto');

// ---------- campanha do vendedor ----------
const hoje = new Date('2026-09-29T12:00:00Z');
assert.deepStrictEqual(corpoCampanha({ nome: ' Semana Ofertas ', inicio: '2026-09-29', fim: '2026-10-12' }, hoje), {
  promotion_type: 'SELLER_CAMPAIGN', name: 'Semana Ofertas', sub_type: 'FLEXIBLE_PERCENTAGE',
  start_date: '2026-09-29T00:00:00', finish_date: '2026-10-12T00:00:00' });
assert.throws(() => corpoCampanha({ nome: 'X', inicio: '2026-09-29', fim: '2026-09-30' }, hoje), /nome/);
assert.throws(() => corpoCampanha({ nome: 'Semana', inicio: '2026-09-28', fim: '2026-09-30' }, hoje), /antes de hoje/);
assert.throws(() => corpoCampanha({ nome: 'Semana', inicio: '2026-09-29', fim: '2026-10-13' }, hoje), /14 dias/);
assert.throws(() => corpoCampanha({ nome: 'Semana', inicio: '2026-10-05', fim: '2026-10-01' }, hoje), /depois do início/);

// ---------- canal de envio: Full, Flex e Mercado Envios (medido em 30/09/2026) ----------
assert.strictEqual(P.canalDe('BRSP04', null), 'full', 'saiu do armazém do ML: nem precisa do envio');
assert.strictEqual(P.canalDe('BRP1234567891', 'self_service'), 'flex');
assert.strictEqual(P.canalDe('BRP1234567891', 'cross_docking'), 'envios');
assert.strictEqual(P.canalDe('BRP1234567891', 'xd_drop_off'), 'envios');
assert.strictEqual(P.canalDe('', 'fulfillment'), 'full');
assert.strictEqual(P.canalDe('BRP1234567891', null), 'pendente', 'envio ainda não consultado não vira Mercado Envios');
assert.strictEqual(P.canalDe('BRP1234567891', 'default'), 'outros');
const canais = P.porCanal([
  { order_id: 1, origem: 'BRSP04', tipo: null, quantidade: 2, faturamento: 100 },
  { order_id: 1, origem: 'BRSP04', tipo: null, quantidade: 1, faturamento: 50 },     // mesmo pedido, outro item
  { order_id: 2, origem: 'BRP1', tipo: 'self_service', quantidade: 1, faturamento: 200 },
  { order_id: 3, origem: 'BRP1', tipo: 'cross_docking', quantidade: 3, faturamento: 150 },
]);
assert.deepStrictEqual(canais.map((c) => [c.canal, c.pedidos, c.unidades, c.faturamento]),
  [['full', 1, 3, 150], ['flex', 1, 1, 200], ['envios', 1, 3, 150]]);
assert.strictEqual(canais[1].participacao, 0.4);
assert.strictEqual(canais[0].ticket, 150);
// sem venda num canal, ele aparece zerado (a tela sempre mostra os três)
assert.deepStrictEqual(P.porCanal([]).map((c) => [c.canal, c.pedidos, c.faturamento]), [['full', 0, 0], ['flex', 0, 0], ['envios', 0, 0]]);

// tema escuro: o CSS gerado das cores de cada tela está em dia com os <style> das telas
{
  const G = require('./tema-escuro-gerar.js');
  assert.strictEqual(require('node:fs').readFileSync(G.SAIDA, 'utf8'), G.gerar(), 'rode: node tema-escuro-gerar.js');
  assert.strictEqual(G.escura('#fff', 'fundo'), 'rgba(14,24,44,.72)');
  assert.strictEqual(G.escura('#1a1a1a', 'texto'), 'var(--ink)');
  assert.strictEqual(G.escura('#2563eb', 'fundo'), null, 'cor forte (botão) fica');
  assert.ok(/^hsla\(/.test(G.escura('#dcfce7', 'fundo')), 'chip verde-claro vira verde translúcido');
}

console.log('Full, qualidade dos anúncios, campanha do vendedor e canais de envio: ok');
