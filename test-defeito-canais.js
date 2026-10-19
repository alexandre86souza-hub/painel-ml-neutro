'use strict';
// node test-defeito-canais.js — peças com defeito nas devoluções da Shopee, Amazon, Leroy e Magalu (defeito-canais.js)
// e a volta ao estoque do que foi conferido (estoque.js#diferencas com as mesmas regras do ML). Só funções puras.
const assert = require('node:assert');
const F = require('./defeito-canais.js');
const E = require('./estoque.js');

const porNumero = new Map([
  [694, { numero: 694, sku: 'DH-694', nome: 'Ducha', custo: 100 }],
  [831, { numero: 831, sku: 'NI-831', nome: 'Niple', custo: 10 }],
]);
const item = { chave: 'shopee:1:R1:0', sku: 'AMG-694.831', quantidade: 4, data: '2026-10-17T12:00:00.000Z' };

// sem conferir: as peças do kit, nada de custo
const p0 = F.pecasDo(item, porNumero, undefined);
assert.deepStrictEqual(p0.componentes.map((c) => c.sku), ['DH-694', 'NI-831']);
assert.strictEqual(p0.conferida, false);
assert.strictEqual(p0.peca_defeito, 0);
// conferida: 1 das 4 duchas com defeito
const p1 = F.pecasDo(item, porNumero, { produtos: [0], qtds: { 0: 1 } });
assert.strictEqual(p1.conferida, true);
assert.deepStrictEqual(p1.qtds_defeito, { 0: 1 });
assert.strictEqual(p1.peca_defeito, 100);
// sem quantidade = todas as unidades devolvidas
assert.strictEqual(F.pecasDo(item, porNumero, { produtos: [0, 1], qtds: null }).peca_defeito, 440);
// conferida sem defeito
const p2 = F.pecasDo(item, porNumero, { produtos: [], qtds: null });
assert.strictEqual(p2.conferida, true); assert.strictEqual(p2.peca_defeito, 0);
// SKU sem produto da tabela
assert.strictEqual(F.pecasDo({ ...item, sku: 'SEM' }, porNumero).componentes.length, 0);

// validação do PUT
const ok = F.validar({ chave: 'magalu:LU-1:0', sku: 'AMG-694.831', quantidade: 2, data: '2026-10-18', produtos: [1, 1], qtds: { 1: 1, 0: 2 } });
assert.deepStrictEqual([ok.canal, ok.produtos, ok.qtds], ['magalu', [1], { 1: 1 }], 'quantidade só das peças marcadas');
assert.deepStrictEqual(F.validar({ chave: 'leroy:9-A:AMG-1', quantidade: 2, produtos: [0], qtds: { 0: 2 } }).qtds, {}, 'todas = sem quantidade');
assert.throws(() => F.validar({ chave: 'ml:1', quantidade: 1, produtos: [] }), /Devolução/);
assert.throws(() => F.validar({ chave: 'amazon:1:X', quantidade: 0, produtos: [] }), /Quantidade/);
assert.throws(() => F.validar({ chave: 'amazon:1:X', quantidade: 2, produtos: [0], qtds: { 0: 3 } }), /1 a 2/);
assert.throws(() => F.validar({ chave: 'amazon:1:X', quantidade: 2, produtos: ['a'] }), /posições/);

// estoque: conferida com 1 ducha com defeito -> voltam 3 duchas e 4 niples
const porSku = new Map([['DH-694', 694], ['NI-831', 831]]); porSku.numeros = new Set([694, 831]);
const linha = { ref: 'devolucao:shopee:1:R1:0', sku: 'AMG-694.831', qtd: 4, data: 'x', valida: true, sinal: 1, sem: [0], defeituosos: { 0: 1 }, tipo: 'devolucao', origem: 'Shopee' };
const d = E.diferencas([linha], new Map(), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd]).sort(), [[694, 3], [831, 4]]);
// mudou a marcação depois (2 com defeito): lança só a diferença
const d2 = E.diferencas([{ ...linha, defeituosos: { 0: 2 } }], new Map([['devolucao:shopee:1:R1:0|694', 3], ['devolucao:shopee:1:R1:0|831', 4]]), porSku);
assert.deepStrictEqual(d2.lancar.map((m) => [m.numero, m.qtd]), [[694, -1]]);

console.log('Peças com defeito nas devoluções da Shopee, Amazon, Leroy e Magalu e a volta ao estoque: ok');
// volta ao estoque sozinha só com a contagem feita e devolução a partir dela
assert.strictEqual(F.pecasDo(item, porNumero, undefined, '2026-10-16T15:00:00.000Z').estoque, 'volta');
assert.strictEqual(F.pecasDo({ ...item, data: '2026-10-07T12:00:00.000Z' }, porNumero, { produtos: [], atualizado_em: '2026-10-19T18:00:00.000Z' }, '2026-10-16T15:00:00.000Z').estoque, 'volta', 'devolução antiga conferida depois da contagem volta');
assert.strictEqual(F.pecasDo(item, porNumero, { produtos: [], atualizado_em: '2026-10-15T18:00:00.000Z' }, '2026-10-16T15:00:00.000Z').estoque, 'antes_contagem');
assert.strictEqual(F.pecasDo(item, porNumero, undefined, null).estoque, 'sem_contagem');

// estoque de peças com defeito: saída do estoque + devolução conferida com defeito + entrada direta − recolhidas
{
  const cat = { porSku, porNumero: new Map([[694, { numero: 694, sku: 'DH-694', nome: 'Ducha', custo: 100, fornecedor: 'BRUNO' }],
    [831, { numero: 831, sku: 'NI-831', nome: 'Niple', custo: 10, fornecedor: null }]]) };
  const r = E.defeitosDe({
    devolucoes: [linha, { ...linha, ref: 'devolucao:x', sem: null }, { ...linha, ref: 'devolucao:ml:9', sem: [...Array(50).keys()], defeituosos: null, qtd: 1 }],
    saidas: [{ numero: 831, qtd: -2, data: '2026-10-19', origem: 'ZEZE' }],
    manuais: [{ numero: 694, qtd: 1, data: '2026-10-19', tipo: 'entrada' }, { numero: 694, qtd: -2, data: '2026-10-20', tipo: 'recolhido' }],
  }, cat);
  // DH-694: 1 (devolução, 1 de 4) + 1 (ML, kit todo) + 1 (entrada) − 2 recolhidas = 1; NI-831: 1 (ML) + 2 (tirado do estoque) = 3
  assert.deepStrictEqual([...r.saldos].sort(), [[694, 1], [831, 3]]);
  assert.deepStrictEqual(r.grupos.map((g) => [g.fornecedor, g.pecas, g.valor]), [['BRUNO', 1, 100], ['ZEZE', 3, 30]], 'fornecedor do cadastro, senão o da saída');
}
