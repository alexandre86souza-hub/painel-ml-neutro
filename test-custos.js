'use strict';
// node test-custos.js — custo pelo SKU (componentes), tabela colada da planilha, empresa e
// a conta de uma venda. Só funções puras: nada aqui chama o Mercado Livre.
const assert = require('node:assert');
const C = require('./custos.js');

// ---------- SKU do anúncio -> componentes ----------
assert.deepStrictEqual(C.componentes('KIT-407.408'), [407, 408]);
assert.deepStrictEqual(C.componentes('KIT-830.079.816.781.671.678'), [830, 79, 816, 781, 671, 678]);
assert.deepStrictEqual(C.componentes('KIT-795.713.739.802.698.'), [795, 713, 739, 802, 698], 'ponto no fim não vira componente');
assert.deepStrictEqual(C.componentes('DQ-407'), [407], 'SKU de um produto só');
assert.deepStrictEqual(C.componentes('KIT-407.407'), [407, 407], 'kit com duas peças iguais conta duas vezes');
assert.deepStrictEqual(C.componentes(''), []);
assert.deepStrictEqual(C.componentes('KIT-795-615-746-698'), [795, 615, 746, 698], 'Amazon: hífen separa os produtos');
assert.deepStrictEqual(C.componentes('KIT-801.714'), [801, 714]);
assert.strictEqual(C.trocarComponente('KIT-795-615-746', 795, 854), 'KIT-854-615-746');
assert.deepStrictEqual(C.componentes('MLB3526851685'), [], 'SKU que é o código do anúncio não tem componentes');

// ---------- tabela colada ----------
const { produtos, ignorados } = C.lerCatalogo([
  'Base\tSKU\tCusto\tProduto\tEstoque Minimo\tClassificação do Produto\tSituação\tReferencia de Compra\tFornecedor',
  '1\tDL-001\t R$ -   \tPRODUTO NÃO UTILIZADO\t0\tNão Utilizado\tDescontinuado\t0\t0',
  '85\t*-085\t\t\t0\tNão Utilizado\t\t\t',
  '407\tDQ-407\t R$ 23,31 \tDUCHA QUADRADO 201 20CM\t1200\tDucha Inox 20cm\t\tPD-S206S8\tBRUNO',
  '408\tBP-408\t R$ 34,10 \tBRAÇO QUADRADO 37 CM\t1000\tBraço\tAtivo\tLJG-6\tBRUNO',
  '999\tXX-999\t R$ 1.234,56 \tCARO\t0\t\t\t\t',
].join('\n'));
assert.strictEqual(produtos.length, 4);
assert.deepStrictEqual(ignorados, ['*-085']);
assert.strictEqual(produtos[0].custo, null, '"R$ -" é sem custo, não zero');
assert.deepStrictEqual(produtos[1], { numero: 407, sku: 'DQ-407', nome: 'DUCHA QUADRADO 201 20CM', custo: 23.31,
  situacao: null, fornecedor: 'BRUNO' });
assert.strictEqual(produtos[3].custo, 1234.56);
assert.throws(() => C.lerCatalogo('Produto;Preço\nx;1'), /SKU/);
// separado por ponto e vírgula também
assert.strictEqual(C.lerCatalogo('SKU;Custo\nDQ-407;23,31').produtos[0].custo, 23.31);

// ---------- custo do SKU ----------
const mapa = new Map(produtos.map((p) => [p.numero, p]));
const k = C.custoDoSku('KIT-407.408', mapa);
assert.strictEqual(k.custo, 57.41, 'exemplo do usuário: DQ-407 + BP-408');
assert.deepStrictEqual(k.faltando, []);
const f = C.custoDoSku('KIT-407.001.555', mapa);
assert.strictEqual(f.custo, null, 'componente sem custo deixa o anúncio sem custo (não soma parcial)');
assert.deepStrictEqual(f.faltando, ['DL-001', '555']);
assert.strictEqual(C.custoDoSku('', mapa).motivo, 'sem_sku');

// ---------- SKUs de anúncio com variações ----------
assert.deepStrictEqual(C.skusDoAnuncio({ seller_custom_field: null,
  attributes: [{ id: 'SELLER_SKU', value_name: 'KIT-407.408' }],
  variations: [{ id: 1, attributes: [{ id: 'SELLER_SKU', value_name: 'KIT-407' }],
    attribute_combinations: [{ value_name: 'Preto' }] }, { id: 2, attribute_combinations: [] }] }),
{ base: 'KIT-407.408', variacoes: [{ id: 1, sku: 'KIT-407', nome: 'Preto' }, { id: 2, sku: null, nome: null }] });

// ---------- empresa ----------
const e = C.validarEmpresa({ razao_social: ' Loja Exemplo ', regime: 'Simples Nacional',
  impostos: [{ nome: 'Simples', pct: '8,5' }, { nome: 'DIFAL', pct: 1.2 }, { nome: '', pct: '' }], embalagem_padrao: '1,50' });
assert.strictEqual(e.razao_social, 'Loja Exemplo');
assert.strictEqual(C.impostoTotal(e), 9.7);
assert.strictEqual(e.embalagem_padrao, 1.5);
assert.throws(() => C.validarEmpresa({ impostos: [{ nome: 'X', pct: 120 }] }), /Percentual inválido/);
assert.throws(() => C.validarEmpresa({ impostos: [{ nome: '', pct: 5 }] }), /nome/);

// ---------- conta de uma venda ----------
// 2 un. a R$ 100, tarifa R$ 12/un., envio de R$ 30 dividido com outra linha de R$ 100
const v = C.contaDaLinha({ quantidade: 2, preco_unit: 100, tarifa_unit: 12, frete_envio: 30, total_envio: 300 },
  { custo_unit: 40, embalagem_unit: 1.5, imposto_pct: 10 });
assert.deepStrictEqual(v, { faturamento: 200, tarifa: 24, frete: 20, produto: 80, embalagem: 3, imposto: 20,
  lucro: 53, margem: 0.265, falta: [] });
const sem = C.contaDaLinha({ quantidade: 1, preco_unit: 50, tarifa_unit: 5, frete_envio: null, total_envio: 50 },
  { custo_unit: null, embalagem_unit: 0, imposto_pct: 0 });
assert.strictEqual(sem.lucro, null, 'sem custo não inventa lucro');
assert.deepStrictEqual(sem.falta, ['custo', 'frete']);

// ---------- trocar um produto dentro do SKU (mudou o fornecedor: DD-795 virou DD-854) ----------
assert.strictEqual(C.trocarComponente('KIT-795.713.739.802.698.', 795, 854), 'KIT-854.713.739.802.698.', 'o ponto do fim fica');
assert.strictEqual(C.trocarComponente('KIT-407.795', 795, 854), 'KIT-407.854');
assert.strictEqual(C.trocarComponente('KIT-795', 795, 854), 'KIT-854');
assert.strictEqual(C.trocarComponente('KIT-795.795', 795, 854), 'KIT-854.854', 'kit com duas peças iguais');
assert.strictEqual(C.trocarComponente('KIT-1795.079', 795, 854), 'KIT-1795.079', '795 não casa com 1795');
assert.strictEqual(C.trocarComponente('KIT-830.079.816', 79, 5), 'KIT-830.005.816', 'número curto ganha os zeros');
assert.strictEqual(C.trocarComponente('DD-795', 795, 854), 'DD-854');
assert.deepStrictEqual(C.componentes(C.trocarComponente('KIT-795.713', 795, 854)), [854, 713]);

// ---------- dashboard de todas as contas: soma de hoje e dos 30 dias ----------
const soma = C.somarContas([
  { hoje: { pedidos: 3, unidades: 4, faturamento: 300, lucro: 60, cobertura: 1 },
    periodo: { pedidos: 100, unidades: 120, faturamento: 10000, lucro: 2500, cobertura: 1, tarifa: 1200 } },
  { hoje: { pedidos: 1, unidades: 1, faturamento: 100, lucro: 0, cobertura: 0 },
    periodo: { pedidos: 50, unidades: 50, faturamento: 5000, lucro: 500, cobertura: 0.5, tarifa: 600 } },
]);
assert.deepStrictEqual([soma.contas, soma.hoje.pedidos, soma.hoje.faturamento, soma.periodo.pedidos, soma.periodo.faturamento, soma.periodo.tarifa],
  [2, 4, 400, 150, 15000, 1800]);
assert.strictEqual(soma.periodo.lucro, 3000);
assert.strictEqual(soma.periodo.margem, 3000 / 12500, 'margem sobre o faturamento que tem custo (10000 + metade de 5000)');
assert.strictEqual(soma.hoje.margem, 60 / 300, 'a venda sem custo não puxa a margem para baixo');
assert.strictEqual(C.somarContas([]).periodo.margem, null);
// o mesmo SKU vendido em duas contas vira uma linha, com a parte de cada conta
const top = C.topPorSku([
  { conta: 1, sku: 'KIT-407.408', item_id: 'MLB1', titulo: 'Kit ducha', quantidade: 2, faturamento: 200, lucro: 50 },
  { conta: 2, sku: 'KIT-407.408', item_id: 'MLB9', titulo: 'Kit ducha outra conta', quantidade: 1, faturamento: 110, lucro: 30 },
  { conta: 1, sku: 'KIT-500', item_id: 'MLB2', titulo: 'Bucha', quantidade: 5, faturamento: 50, lucro: null },
  { conta: 2, sku: '', item_id: 'MLB3', titulo: 'Sem SKU', quantidade: 1, faturamento: 20, lucro: 5 },
]);
assert.deepStrictEqual(top.map((p) => [p.sku, p.unidades, p.faturamento, p.lucro]),
  [['KIT-407.408', 3, 310, 80], ['KIT-500', 5, 50, null], [null, 1, 20, 5]]);
assert.deepStrictEqual(top[0].por_conta, { 1: { unidades: 2, faturamento: 200 }, 2: { unidades: 1, faturamento: 110 } });
assert.strictEqual(top[1].margem, null, 'venda sem custo: lucro e margem ficam sem valor, não zero');
// contas que escrevem o SKU de jeitos diferentes: o que junta são os números dos produtos
const misto = C.topPorSku([
  { conta: 1, sku: 'KIT-769.790.816', quantidade: 2, faturamento: 500, lucro: 100 },
  { conta: 2, sku: '769.790.816.', quantidade: 1, faturamento: 240, lucro: 60 },
  { conta: 2, sku: '816.769.790', quantidade: 1, faturamento: 10, lucro: 1 },
]);
assert.strictEqual(misto.length, 1, 'mesmo kit, três jeitos de escrever');
assert.deepStrictEqual([misto[0].unidades, misto[0].faturamento, misto[0].skus], [4, 750, ['KIT-769.790.816', '769.790.816.', '816.769.790']]);
assert.strictEqual(C.topPorSku(top.map((p, i) => ({ conta: 1, sku: 's' + i, faturamento: i })), 2).length, 2);

// Flex do ML: frete = entrega paga pelo vendedor − bônus Flex (creditado ou médio do caso)
assert.deepStrictEqual(C.freteFlex({ custoMl: 9.89, bonus: 1.1, entrega: 12 }), { frete: 10.9, bonus: 1.1, estimado: false });
assert.deepStrictEqual(C.freteFlex({ custoMl: 0, bonus: null, entrega: 12, medias: { com_custo: 1.1, sem_custo: 10.5 } }), { frete: 1.5, bonus: 10.5, estimado: true });
assert.deepStrictEqual(C.freteFlex({ custoMl: 9.89, bonus: null, entrega: 12 }), { frete: 12, bonus: null, estimado: true });
assert.deepStrictEqual([C.lerEmpresa('{}').entrega_flex, C.validarEmpresa({ entrega_flex: '12,00' }).entrega_flex, C.validarEmpresa({}).entrega_flex], [null, 12, null]);
assert.throws(() => C.validarEmpresa({ entrega_flex: '-1' }), /Flex inválido/);
// troca de produto no SKU feita no painel (Amazon, Leroy, Magalu): vale a partir da data, em cadeia
{
  const tr = new Map([['DD-795', [{ sku_novo: 'DD-854', desde: '2026-10-08T18:00:00Z' }]], ['DD-854', [{ sku_novo: 'DD-900', desde: '2026-11-01T00:00:00Z' }]]]);
  assert.strictEqual(C.skuNaData(tr, 'DD-795', '2026-10-01T00:00:00Z'), 'DD-795', 'venda anterior: produto antigo');
  assert.strictEqual(C.skuNaData(tr, 'DD-795', '2026-10-09T00:00:00Z'), 'DD-854');
  assert.strictEqual(C.skuNaData(tr, 'DD-795', '2026-11-02T00:00:00Z'), 'DD-900', 'trocas em cadeia');
  assert.strictEqual(C.skuNaData(new Map(), 'KIT-1.2'), 'KIT-1.2');
}

console.log('custos, tabela de produtos, empresa, vendas, troca de SKU e soma das contas: ok');
