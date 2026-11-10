// Diagnósticos SÓ LEITURA da auditoria técnica (diagnosticos.js + estoque.js#baixasForaDaComposicao):
// a lógica de cada um, que só o administrador abre, que nada grava e que a Amazon sai só por SKU.
const assert = require('assert');
const fs = require('fs');
const E = require('./estoque.js');
const C = require('./custos.js');
const G = require('./diagnosticos.js');
const U = require('./usuarios.js');

// ---- 1. composição × estoque (caso real do AMG-755: a composição troca o 755 pelo 697)
const porSku = new Map([['GA-755', 755], ['GA-697', 697], ['DQ-407', 407], ['BP-408', 408]]);
porSku.numeros = new Set([755, 697, 407, 408]);
const venda = { ref: 'venda:shopee:PEDIDO1:1', sku: '755', qtd: 2, valida: true, origem: 'Shopee', data: '2026-10-20T12:00:00Z' };
const kit = { ref: 'venda:ml:9:MLB1:0', sku: 'AMG-407.408', qtd: 1, valida: true, origem: 'ML', data: '2026-10-21T12:00:00Z' };
C.usarComposicoes(new Map());
// sem composição: a baixa bate com o que já foi lançado -> nada a mostrar
assert.deepStrictEqual(E.baixasForaDaComposicao([venda, kit],
  new Map([['venda:shopee:PEDIDO1:1|755', -2], ['venda:ml:9:MLB1:0|407', -1], ['venda:ml:9:MLB1:0|408', -1]]), porSku), []);
C.usarComposicoes(new Map([['755', 'KIT-697']]));
// a composição mudou depois da baixa: o 755 ficou baixado e o 697 ainda vai ser (a próxima rodada baixaria em dobro)
let d = E.baixasForaDaComposicao([venda], new Map([['venda:shopee:PEDIDO1:1|755', -2]]), porSku);
assert.strictEqual(d.length, 1);
assert.deepStrictEqual(d[0].sobra, [{ numero: 755, unidades: 2 }]);
assert.deepStrictEqual(d[0].produtos_hoje, [697]);
assert.strictEqual(d[0].novo_falta_baixar, 1);
assert.strictEqual(d[0].novo_ja_baixado, 0);
assert.deepStrictEqual(d[0].por_loja, { shopee: 1 });
// a rodada já baixou o 697 também: baixa em dobro já feita
d = E.baixasForaDaComposicao([venda], new Map([['venda:shopee:PEDIDO1:1|755', -2], ['venda:shopee:PEDIDO1:1|697', -2]]), porSku);
assert.strictEqual(d[0].novo_ja_baixado, 1);
assert.strictEqual(d[0].novo_falta_baixar, 0);
// a saída é por SKU: a ref (com o pedido) não sai
assert.ok(!JSON.stringify(d).includes('PEDIDO1'), 'diagnóstico de composição não pode expor a ref/pedido');
// baixa já estornada (soma 0) não conta
assert.deepStrictEqual(E.baixasForaDaComposicao([venda], new Map([['venda:shopee:PEDIDO1:1|755', 0], ['venda:shopee:PEDIDO1:1|697', -2]]), porSku), []);
// cancelada com baixa ainda não estornada e composição que mudou: aparece (a baixa antiga é de outro produto)
d = E.baixasForaDaComposicao([{ ...venda, valida: false }], new Map([['venda:shopee:PEDIDO1:1|755', -2]]), porSku);
assert.strictEqual(d.length, 1);
C.usarComposicoes(new Map());
// cancelada que só falta estornar, SEM mudança de composição: não é problema de composição (a baixa normal estorna)
assert.deepStrictEqual(E.baixasForaDaComposicao([{ ...venda, valida: false }], new Map([['venda:shopee:PEDIDO1:1|755', -2]]), porSku), []);

// ---- 2. Amazon: frete e etiqueta por SKU, só agregado
const lancs = [
  { tipo: 'venda', pedido: 'AMZ-1', sku: 'AMG-853', quantidade: 1, canal: 'proprio', receita: 58.77, tarifa: 6.29, frete: 0, tarifa_fixa: 0 },
  { tipo: 'etiqueta', pedido: 'AMZ-1', sku: null, quantidade: 0, canal: 'proprio', receita: 0, tarifa: 0, frete: 24.5, tarifa_fixa: 0 },
  { tipo: 'venda', pedido: 'AMZ-2', sku: 'AMG-853', quantidade: 1, canal: 'proprio', receita: 60, tarifa: 5, frete: 0, tarifa_fixa: 0 },
  { tipo: 'venda', pedido: 'AMZ-3', sku: 'AMG-999', quantidade: 2, canal: 'proprio', receita: 40, tarifa: 4, frete: 0, tarifa_fixa: 0 },
  { tipo: 'etiqueta', pedido: 'AMZ-9', sku: null, quantidade: 0, canal: 'proprio', receita: 0, tarifa: 0, frete: 20, tarifa_fixa: 0 },
];
const pedidos = [{ pedido: 'AMZ-1', sku: 'AMG-853', status: 'Shipped' }, { pedido: 'AMZ-2', sku: 'AMG-853', status: 'Shipped' },
  { pedido: 'AMZ-4', sku: 'AMG-853', status: 'Shipped' }, { pedido: 'AMZ-5', sku: 'AMG-853', status: 'Canceled' }];
const az = G.amazonFretePorSku(lancs, pedidos);
const s853 = az.skus.find((x) => x.sku === 'AMG-853');
assert.strictEqual(s853.lancamentos_venda, 2);
assert.strictEqual(s853.com_etiqueta, 1);
assert.strictEqual(s853.sem_etiqueta_proprio, 1);
assert.strictEqual(s853.frete, 24.5);
assert.strictEqual(s853.media_proprio.frete_un, 12.25);   // a média que anúncios e calculadora usam
assert.strictEqual(s853.pedidos_copia, 3);                 // cancelado fora
assert.strictEqual(s853.pedidos_com_lancamento, 2);
assert.strictEqual(s853.suspeito, false);
assert.strictEqual(az.skus.find((x) => x.sku === 'AMG-999').suspeito, true);   // envio próprio sem nenhuma etiqueta
assert.strictEqual(az.resumo.etiquetas, 2);
assert.strictEqual(az.resumo.etiquetas_sem_venda_lancada, 1);
for (const p of ['AMZ-1', 'AMZ-2', 'AMZ-3', 'AMZ-4', 'AMZ-9']) assert.ok(!JSON.stringify(az).includes(p), `Amazon: o diagnóstico não pode expor o pedido ${p}`);
assert.strictEqual(G.amazonFretePorSku(lancs, pedidos, { sku: 'AMG-999' }).skus.length, 1);

// ---- 3. Ads do ML: anúncios × campanhas, linha repetida da paginação conta uma vez
const linhasAds = [
  { item_id: 'MLB1', ad_group_id: 1, campaign_id: 10, metrics: { cost: 100 } },
  { item_id: 'MLB1', ad_group_id: 1, campaign_id: 10, metrics: { cost: 100 } },   // repetida
  { item_id: 'MLB2', ad_group_id: 2, campaign_id: 10, metrics: { cost: 50 } },
  { item_id: 'MLB1', ad_group_id: 3, campaign_id: 20, metrics: { cost: 30 } },    // o mesmo anúncio em outra campanha
];
const ads = G.adsComparacao(linhasAds, [{ id: 10, nome: 'A', investimento: 140 }, { id: 30, nome: 'C', investimento: 5 }]);
const c10 = ads.campanhas.find((x) => x.campanha_id === '10');
assert.strictEqual(c10.anuncios_bruto, 250);
assert.strictEqual(c10.anuncios, 150);
assert.strictEqual(c10.repetidas, 1);
assert.strictEqual(c10.diferenca, 10);
assert.strictEqual(ads.campanhas.find((x) => x.campanha_id === '20').so_numa_fonte, 'anuncios');
assert.strictEqual(ads.campanhas.find((x) => x.campanha_id === '30').so_numa_fonte, 'campanhas');
assert.strictEqual(ads.totais.abc, 180);          // o mesmo número do ABC (painel.js#gastoAdsPorItem)
assert.strictEqual(ads.totais.campanhas, 145);
assert.strictEqual(ads.totais.itens_em_2_ou_mais_campanhas, 1);

// ---- 4. Magalu: tipos de lançamento das vendas com frete 0, sem dado do comprador
const pedMg = [
  { code: 'M1', data: '2026-11-01', status: 'delivered', frete_cliente: 0, entregue: '2026-11-03', itens: [{ sku: 'AMG-1', faturamento: 100 }] },
  { code: 'M2', data: '2026-11-02', status: 'delivered', frete_cliente: 0, entregue: null, itens: [{ sku: 'AMG-2', faturamento: 200 }] },
  { code: 'M3', data: '2026-11-02', status: 'cancelled', itens: [] },
  { code: 'M4', data: '2026-11-02', status: 'delivered', itens: [] },   // sem financeiro ainda: fora
];
const fin = new Map([
  ['M1', [{ tipo: 'CREDIT', cat: 'SALE', sub: null, valor: 100, status: 'ready', desc: 'Fulano de Tal' },
    { tipo: 'DEBIT', cat: 'COMMISSION', sub: 'X', valor: 16, status: 'ready', desc: '' }]],
  ['M2', [{ tipo: 'CREDIT', cat: 'SALE', sub: null, valor: 200, status: 'ready', desc: '' },
    { tipo: 'DEBIT', cat: 'SHIPPING_COST', sub: null, valor: 20, status: 'ready', desc: '' }]],
  ['M3', [{ tipo: 'CREDIT', cat: 'SALE', sub: null, valor: 50, status: 'ready', desc: '' }]],
]);
const mg = G.magaluFreteZero(pedMg, fin);
assert.deepStrictEqual(mg.resumo, { com_frete_zero: 1, com_frete: 1 });
assert.strictEqual(mg.frete_zero[0].pedido, 'M1');
assert.deepStrictEqual(mg.frete_zero[0].tipos, ['CREDIT:SALE', 'DEBIT:COMMISSION/X']);
assert.strictEqual(mg.frete_zero[0].tem_shipping, false);
assert.ok(!JSON.stringify(mg).includes('Fulano'), 'Magalu: a descrição do lançamento (texto livre) não sai');
assert.ok(mg.tipos_com_frete.some((t) => t.tipo === 'DEBIT:SHIPPING_COST'));

// ---- autorização: só o administrador; nenhum módulo alcança /api/diagnostico
const ROTAS = ['composicao-estoque', 'amazon-frete', 'ads-ml', 'magalu-frete'].map((r) => `/api/diagnostico/${r}`);
const todos = { admin: false, modulos: U.MODULOS.map((m) => m.id) };
for (const r of ROTAS) {
  assert.ok(U.permitido({ admin: true }, 'GET', r), `admin abre ${r}`);
  assert.ok(!U.permitido(todos, 'GET', r), `usuário com TODOS os módulos não abre ${r}`);
  assert.ok(!U.permitido(todos, 'POST', r), `POST em ${r} fechado`);
}
// as rotas registradas são exatamente essas, todas GET
const mod = G.criar({ D: {}, routes: {}, CTX: {}, adsDaJanela: null, estoque: () => null });
assert.deepStrictEqual(Object.keys(mod.rotas).sort(), ROTAS.map((r) => `GET ${r}`).sort());

// ---- só leitura: o código dos diagnósticos não grava nem chama escrita
const fonte = fs.readFileSync(__dirname + '/diagnosticos.js', 'utf8');
for (const proibido of [/Gravar\s*\(/, /\.run\s*\(/, /method:\s*'(POST|PUT|PATCH|DELETE)'/, /INSERT|UPDATE|DELETE FROM/, /estoqueMov/, /mudar(Estoque|Oferta|Preco)/]) {
  assert.ok(!proibido.test(fonte), `diagnosticos.js não pode ter ${proibido}`);
}
const est = fs.readFileSync(__dirname + '/estoque.js', 'utf8');
const corpo = est.slice(est.indexOf('function diagnosticoComposicao'), est.indexOf('const timer = setInterval'));
assert.ok(corpo.length > 100 && !/Gravar\s*\(|\.run\s*\(|baixar\s*\(/.test(corpo), 'diagnosticoComposicao não grava nem roda a baixa');
const func = est.slice(est.indexOf('function baixasForaDaComposicao'), est.indexOf('// Estoque de peças com defeito'));
assert.ok(func.length > 100 && !/D\.|Gravar|\.run\(/.test(func), 'baixasForaDaComposicao é pura');

// ---- fora do MCP
assert.ok(!/api\/diagnostico/.test(fs.readFileSync(__dirname + '/mcp.js', 'utf8')), 'diagnósticos não podem estar no MCP');

console.log('Diagnósticos (composição × estoque, Amazon por SKU, Ads ML, Magalu frete 0): ok');
