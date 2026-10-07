'use strict';
// node test-campanhas-canais.js — campanhas da Amazon e da Leroy: funções puras.
const assert = require('node:assert');
const CC = require('./campanhas-canais.js');
const L = require('./leroy.js');
const AG = Date.parse('2026-10-07T12:00:00Z');

// situação pelas datas
assert.strictEqual(CC.situacao('2026-10-01T03:00:00Z', '2026-10-10T03:00:00Z', AG), 'ativo');
assert.strictEqual(CC.situacao('2026-10-08T03:00:00Z', '2026-10-10T03:00:00Z', AG), 'agendado');
assert.strictEqual(CC.situacao('2026-06-19T03:00:00Z', '2026-07-21T03:00:00Z', AG), 'encerrado');
assert.strictEqual(CC.situacao('2026-10-01T03:00:00Z', null, AG), 'ativo', 'sem fim: vale até ser tirado');

// resultado do desconto: período dele contra os mesmos dias antes
const v = (data, sku, q, fat, lucro, valida = true) => ({ pedido: data + sku, data, sku, quantidade: q, faturamento: fat, lucro, valida });
const linhas = [v('2026-07-01T10:00:00Z', 'A', 1, 100, 20), v('2026-07-05T10:00:00Z', 'A', 2, 180, null), v('2026-06-10T10:00:00Z', 'A', 1, 110, 25),
  v('2026-07-02T10:00:00Z', 'B', 1, 50, 5), v('2026-07-03T10:00:00Z', 'A', 9, 999, 1, false)];
const r = CC.resultadoDesconto(linhas, 'A', '2026-06-19T03:00:00Z', '2026-07-21T03:00:00Z', AG);
assert.strictEqual(r.dias, 32);
assert.deepStrictEqual(r.durante, { pedidos: 2, unidades: 3, faturamento: 280, lucro: 20, sem_lucro: 1 });
assert.deepStrictEqual(r.antes, { pedidos: 1, unidades: 1, faturamento: 110, lucro: 25, sem_lucro: 0 });
assert.strictEqual(CC.resultadoDesconto(linhas, 'A', '2026-10-08T03:00:00Z', null, AG), null, 'agendado: sem resultado');

// resultado por promoção (a sem id fica junta)
const pr = CC.resultadoPromocoes([
  { ...v('2026-08-04T10:00:00Z', 'A', 1, 90, 10), promocoes: [{ id: 'Desconto percentual 2026/07/31', valor: 5 }] },
  { ...v('2026-08-20T10:00:00Z', 'B', 2, 80, null), promocoes: [{ id: 'Desconto percentual 2026/07/31', valor: 4 }] },
  { ...v('2026-09-01T10:00:00Z', 'A', 1, 95, 12), promocoes: [{ id: null, valor: 3 }] },
  { ...v('2026-09-02T10:00:00Z', 'A', 1, 95, 12) }]);
assert.strictEqual(pr.length, 2);
const p1 = pr.find((p) => p.id);
assert.deepStrictEqual([p1.pedidos, p1.unidades, p1.faturamento, p1.desconto, p1.lucro, p1.sem_lucro], [2, 3, 170, 9, 10, 1]);
assert.strictEqual(p1.primeira, '2026-08-04T10:00:00Z');
assert.strictEqual(pr.find((p) => !p.id).faturamento, 95);

// validação do desconto digitado
const precos = new Map([['A', 100], ['B', 50]]);
const ok = CC.validarDesconto({ itens: [{ sku: 'A', preco: '89,90' }], inicio: '2026-10-08', fim: '2026-10-15' }, precos, AG);
assert.deepStrictEqual(ok, { itens: [{ sku: 'A', preco: 89.9, cheio: 100 }], inicio: '2026-10-08T03:00:00.000Z', fim: '2026-10-16T02:59:00.000Z' });
assert.throws(() => CC.validarDesconto({ itens: [{ sku: 'A', preco: 100 }], inicio: '2026-10-08', fim: '2026-10-15' }, precos, AG), /menor que o preço cheio/);
assert.throws(() => CC.validarDesconto({ itens: [{ sku: 'X', preco: 1 }], inicio: '2026-10-08', fim: '2026-10-15' }, precos, AG), /não encontrado/);
assert.throws(() => CC.validarDesconto({ itens: [{ sku: 'A', preco: 1 }], inicio: '2026-10-08', fim: '2026-10-01' }, precos, AG), /depois da de início/);
assert.throws(() => CC.validarDesconto({ itens: [{ sku: 'A', preco: 1 }], inicio: '2026-09-01', fim: '2026-09-05' }, precos, AG), /já passou/);
assert.throws(() => CC.validarDesconto({ itens: [], inicio: '2026-10-08', fim: '2026-10-15' }, precos, AG), /ao menos um/);

// CSV do PRI01: preço cheio sempre; sem desconto = encerra
assert.strictEqual(CC.csvPrecosMirakl([{ sku: 'SKU-1', cheio: 100, preco: 89.9, inicio: '2026-10-08T03:00:00.000Z', fim: '2026-10-16T02:59:00.000Z' },
  { sku: 'SKU-"2"', cheio: 50, preco: null }]),
'"offer-sku";"price";"discount-price";"discount-start-date";"discount-end-date"\n'
+ '"SKU-1";"100.00";"89.90";"2026-10-08T03:00:00.000Z";"2026-10-16T02:59:00.000Z"\n'
+ '"SKU-""2""";"50.00";;;\n');

// oferta da Leroy: preço cheio, desconto e "complexo" (preço por canal/quantidade: o painel não mexe)
const of = L.ofertaDe({ shop_sku: 'SKU-747', offer_id: 1, active: true, quantity: 8, price: 19.42,
  discount: { discount_price: 18.45, origin_price: 19.42, start_date: '2026-06-19T03:00:00Z', end_date: '2026-07-21T03:00:00Z', ranges: [{ price: 18.45, quantity_threshold: 1 }] },
  all_prices: [{ channel_code: null, volume_prices: [{ quantity_threshold: 1 }] }] });
assert.deepStrictEqual([of.cheio, of.desconto.preco, of.complexo], [19.42, 18.45, false]);
assert.strictEqual(L.ofertaDe({ shop_sku: 'X', price: 10, all_prices: [{ channel_code: 'LMBR' }] }).complexo, true);
assert.strictEqual(L.ofertaDe({ shop_sku: 'X', price: 10, discount: { discount_price: null } }).desconto, null);

// promoções da linha do pedido da Leroy
const ped = L.pedidoDe({ order_id: '1', order_lines: [{ order_line_id: '1-1', price: 90, quantity: 1,
  promotions: [{ id: 77, deduced_amount: 10, configuration: { internal_description: 'Black Friday' } }] }] });
assert.deepStrictEqual(ped.linhas[0].promocoes, [{ id: '77', nome: 'Black Friday', tipo: null, valor: 10 }]);

// nada de campanhas no MCP
const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp.js'), 'utf8');
assert.ok(!/campanhas-canais|\/api\/(amazon|leroy)\/campanhas/.test(mcp), 'campanhas da Amazon e da Leroy fora do MCP');

console.log('Campanhas da Amazon e da Leroy: situação, resultado do desconto e das promoções, validação, preço da Mirakl e fora do MCP: ok');
