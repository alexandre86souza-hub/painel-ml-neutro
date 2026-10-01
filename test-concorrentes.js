'use strict';
// node test-concorrentes.js — concorrentes no Mercado Livre: termo de busca, faixa de vendidos
// e quem é "da casa". Só funções puras: nada aqui chama o ML.
const assert = require('node:assert');
const C = require('./concorrentes.js');

// termo: primeiras palavras do título, sem código de modelo e sem conectivos
assert.strictEqual(C.termoDoTitulo('Ducha Chuveiro Flatt Cromado Articulado Com Niple De Teto Prateado'), 'ducha chuveiro flatt cromado articulado');
assert.strictEqual(C.termoDoTitulo('Kit KIT-765.714 Ducha Redonda c/ Braço'), 'kit ducha redonda braço');
assert.strictEqual(C.termoDoTitulo(''), '');

// faixa de vendidos ao longo das buscas
const m = (v, d) => ({ vendidos: v, medido_em: `2026-09-${d}T12:00:00Z` });
assert.deepStrictEqual(C.historicoFaixa([m(100, 10), m(100, 15), m(500, 20), m(500, 25)]),
  { faixa: 500, desde: '2026-09-20T12:00:00Z', anterior: 100, primeira_medida: '2026-09-10T12:00:00Z' }, 'subiu de 100 para 500 em 20/09');
assert.deepStrictEqual(C.historicoFaixa([m(25, 10), m(25, 12)]),
  { faixa: 25, desde: '2026-09-10T12:00:00Z', anterior: null, primeira_medida: '2026-09-10T12:00:00Z' }, 'sempre na mesma faixa');
assert.strictEqual(C.historicoFaixa([m(null, 10), m(100, 12)]).faixa, 100, 'medida sem número não conta');
assert.strictEqual(C.historicoFaixa([]).faixa, null);

// anúncios das contas conectadas não são concorrentes
assert.strictEqual(C.ehDaCasa('LOJA EXEMPLO', ['LOJA EXEMPLO', 'OUTRA LOJA']), true);
assert.strictEqual(C.ehDaCasa('Por Outra Loja', ['LOJA EXEMPLO', 'OUTRA LOJA']), true, 'acento, espaço e "Por" não atrapalham');
assert.strictEqual(C.ehDaCasa('Loja do Zé', ['LOJA EXEMPLO']), false);
assert.strictEqual(C.ehDaCasa(null, ['LOJA EXEMPLO']), false);
assert.strictEqual(C.ehDaCasa('AB', ['AB']), false, 'nome curto demais não decide');

console.log('Concorrentes do Mercado Livre: termo, faixa de vendidos e anúncios da casa: ok');
