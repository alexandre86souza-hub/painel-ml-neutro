const assert = require('assert');
const G = require('./gestao.js');
const { repassesAmazonDe } = require('./amazon.js');
const { comprasDe } = require('./estoque.js');

const agora = Date.parse('2026-11-03T15:00:00Z');

// ---- caixa: Shopee pela situação do pedido ----
{
  const precoDe = (_p, i) => i.preco_unit;
  const row = (sn, status, recebido, extra = {}) => ({ order_sn: sn, status, recebido, transportadora: 'Shopee Xpress', atualizado: agora / 1000 - 86400,
    quantidade: 1, preco_unit: 100, ...extra });
  const t = G.caixaShopeeDe([row('A', 'SHIPPED', 80), row('B', 'TO_CONFIRM_RECEIVE', null), row('C', 'COMPLETED', 70), row('D', 'TO_RETURN', 60),
    row('E', 'CANCELLED', 90), row('F', 'COMPLETED', 50, { atualizado: agora / 1000 - 40 * 86400 })],
  { proporcao: 0.25, frete_medio: { 'Shopee Xpress': 5 }, precoDe, agora });
  assert.deepStrictEqual([t.a_receber, t.qtd_a_receber, t.estimados, t.retido, t.liberado_30], [160, 2, 1, 60, 70],
    'Shopee: a receber = enviado + estimado (100 × 0,75 + 5); TO_RETURN retido; concluído há 40 dias fora dos 30');
}
// ---- caixa: Magalu pela entrega (a análise financeira não diz se já foi pago) ----
{
  const tx = (tipo, valor, status, data = '2026-10-30T10:00:00Z') => ({ tipo, cat: 'SALE', sub: null, valor, status, data });
  const peds = [{ code: '1', status: 'finished', entregue: '2026-10-20T10:00:00Z', itens: [{ faturamento: 100 }] },
    { code: '2', status: 'shipped', entregue: null, itens: [{ faturamento: 80 }] },
    { code: '3', status: 'new', entregue: null, comissao: 15, itens: [{ faturamento: 50 }] },
    { code: '4', status: 'cancelled', itens: [{ faturamento: 999 }] },
    { code: '5', status: 'finished', entregue: '2026-08-01T10:00:00Z', itens: [{ faturamento: 70 }] }];
  const fin = new Map([['1', [tx('CREDIT', 100, 'ready'), tx('DEBIT', 20, 'ready')]], ['2', [tx('CREDIT', 80, 'ready'), tx('DEBIT', 15, 'awaiting_payment'),
    { tipo: 'DEBIT', cat: 'PROMOTION', sub: 'ABSOLUTE_DISCOUNT', valor: 10, status: 'ready' }]]]);
  const t = G.caixaMagaluDe(peds, fin, agora);
  assert.deepStrictEqual([t.a_receber, t.qtd_a_receber, t.estimados, t.entregue_30, t.qtd_entregue_30], [100, 2, 1, 80, 1],
    'Magalu: não entregue = a receber (65 + 50 − 15); entregue em 30 dias à parte; entregue em agosto e cancelado fora; desconto absoluto fora');
  assert.deepStrictEqual(Object.fromEntries(Object.entries(t.status).map(([k, v]) => [k, [v.n, v.valor]])), { ready: [3, 160], awaiting_payment: [1, -15] });
  assert.strictEqual(G.proximaSegunda(agora), '2026-11-09', 'terça 03/11 -> segunda 09/11');
  assert.strictEqual(G.proximaSegunda(Date.parse('2026-11-09T12:00:00Z')), '2026-11-09', 'segunda é o próprio dia');
}
// ---- caixa: Amazon pelos grupos financeiros ----
{
  const g = (id, status, transf, v, inicio, pago) => ({ FinancialEventGroupId: id, ProcessingStatus: status, FundTransferStatus: transf,
    OriginalTotal: { CurrencyAmount: v }, FinancialEventGroupStart: inicio, FundTransferDate: pago });
  const r = repassesAmazonDe([g('1', 'Open', null, 500, '2026-10-28T00:00:00Z'), g('2', 'Closed', 'Processing', 300, '2026-10-14T00:00:00Z'),
    g('3', 'Closed', 'Succeeded', 400, '2026-09-30T00:00:00Z', '2026-10-16T00:00:00Z'), g('4', 'Closed', 'Succeeded', 200, '2026-08-01T00:00:00Z', '2026-08-20T00:00:00Z')], agora);
  assert.deepStrictEqual([r.acumulando, r.a_caminho_valor, r.pago_30, r.proximo], [500, 300, 400, '2026-11-11T00:00:00.000Z']);
}
{
  const r = G.caixaLeroyDe({ proximo: { previsto: '2026-12-05T03:00:00.000Z', valor: 593.16 }, aguardando_entrega: { valor: 1749.67 },
    ciclos: [{ previsto: '2026-11-19T03:00:00Z', valor: 808.06 }, { previsto: '2026-11-04T03:00:00Z', valor: 1266.83 }, { previsto: '2026-10-20T03:00:00Z', valor: 1560.36 },
      { previsto: '2026-09-19T03:00:00Z', valor: 2917.82 }] }, agora);
  assert.deepStrictEqual([r.a_receber, r.proximos_7, r.liberado_30, r.proximo], [4417.72, 1266.83, 1560.36, { data: '2026-11-04', valor: 1266.83 }],
    'Leroy: ciclos fechados ainda não vencidos + o aberto + aguardando entrega; o de 20/10 caiu nos 30 dias');
}
assert.deepStrictEqual(G.totaisCaixa([{ a_receber: 10, proximos_7: null, retido: 1, liberado_30: 5 }, { a_receber: 2.5, proximos_7: 2, retido: 0, liberado_30: 0 }]),
  { a_receber: 12.5, proximos_7: 2, retido: 1, liberado_30: 5 });

// ---- DRE ----
const j = G.janelaMes('2026-10');
assert.deepStrictEqual(j, { mes: '2026-10', de: '2026-10-01T03:00:00.000Z', ate: '2026-11-01T03:00:00.000Z' });
assert.strictEqual(G.janelaMes('2026-13'), null);
{
  const l = (data, fat, extra = {}) => ({ pedido: data + fat, data, valida: true, faturamento: fat, tarifa: fat * 0.2, frete: 10, produto: fat * 0.4,
    embalagem: 1, imposto: fat * 0.1, lucro: 1, ...extra });
  const s = G.somaDoMes([l('2026-10-05T12:00:00Z', 100), l('2026-10-31T23:00:00Z', 200, { lucro: null }), l('2026-11-01T04:00:00Z', 999),
    l('2026-10-10T12:00:00Z', 500, { valida: false })], j);
  assert.deepStrictEqual([s.faturamento, s.tarifa, s.produto, s.pedidos, s.sem_custo, s.faturamento_sem_custo], [300, 60, 120, 2, 1, 200],
    '31/10 23h UTC ainda é outubro; 01/11 04h UTC (01h de Brasília) já é novembro; cancelada fora');
}
{
  const loja = (conta, cnpj, fat, ads, dev) => ({ loja: conta, conta, cnpj, faturamento: fat, tarifa: fat * 0.2, frete: fat * 0.1, produto: fat * 0.4,
    embalagem: 0, imposto: fat * 0.08, ads, devolucoes: dev });
  const custos = G.custosDoMes({ fixos: [{ nome: 'Aluguel', valor: 1000, cnpj: '1' }, { nome: 'Contador', valor: 600, cnpj: '' }],
    meses: { '2026-10': [{ nome: 'Conserto', valor: 200, cnpj: '2' }], '2026-09': [{ nome: 'x', valor: 9 }] } }, '2026-10');
  assert.strictEqual(custos.length, 3);
  const r = G.dreDe({ lojas: [loja('ml:1', '1', 10000, 500, 100), loja('amazon', '2', 5000, null, 50)],
    cnpjs: [{ id: '1', nome: 'Loja A', efetiva: 0.06 }, { id: '2', nome: 'Loja B', efetiva: null }], custos });
  const [a, b] = r.lojas;
  assert.deepStrictEqual([a.imposto, a.imposto_fonte, a.mc, a.resultado], [600, 'simples', 2400, 1800], 'Simples do CNPJ no lugar do imposto das vendas');
  assert.deepStrictEqual([b.imposto, b.imposto_fonte, b.mc, b.resultado], [400, 'empresa', 1100, 1050], 'sem alíquota: o imposto das vendas');
  const [c1, c2] = r.cnpjs;
  assert.deepStrictEqual([c1.custos_fixos, c1.resultado_final], [1400, 400], 'aluguel + 2/3 do contador (rateio pelo faturamento)');
  assert.deepStrictEqual([c2.custos_fixos, c2.resultado_final], [400, 650], 'conserto + 1/3 do contador');
  assert.deepStrictEqual([r.total.custos_fixos, r.total.resultado_final], [1800, 1050]);
  assert.strictEqual(r.total.equilibrio, 9473.68, 'faturamento que paga os fixos com a margem depois de Ads e devoluções (2850/15000)');
}
assert.deepStrictEqual(G.validarCustos({ fixos: [{ nome: ' Aluguel ', valor: '1500,5' }, { nome: '', valor: '' }], meses: { '2026-10': [{ nome: 'Extra', valor: 10, cnpj: '2' }], lixo: [{ nome: 'x', valor: 1 }] } }),
  { fixos: [{ nome: 'Aluguel', valor: 1500.5, cnpj: '' }], meses: { '2026-10': [{ nome: 'Extra', valor: 10, cnpj: '2' }] } });
assert.throws(() => G.validarCustos({ fixos: [{ nome: 'X', valor: -1 }] }), /entre R\$ 0/);
assert.throws(() => G.validarCustos({ fixos: [{ valor: 5 }] }), /nome/);

// ---- placar ----
{
  const l = (pedido, fat, lucro, promocoes = []) => ({ pedido, valida: true, faturamento: fat, lucro, promocoes });
  const linhas = [l('1', 100, 10, [{ id: 'P1', valor: 15 }]), l('2', 300, 90), l('3', 100, 20, [{ id: 'P1', valor: 5 }])];
  const res = require('./campanhas-canais.js').resultadoPromocoes(linhas.map((x) => ({ ...x, data: '2026-10-10', quantidade: 1 })));
  const p = G.placarPromocoesDe(linhas, res);
  assert.deepStrictEqual([p.faturamento, p.participacao, p.pedidos, p.desconto, p.margem_com, p.margem_sem], [200, 0.4, 2, 20, 0.15, 0.3]);
  assert.strictEqual(p.top[0].nome, 'P1');
  const ml = G.placarPromocoesMl([{ tipo: null, faturamento: 600, pedidos: 6 }, { tipo: 'DEAL', tipo_nome: 'Oferta do dia', nome: '11.11', faturamento: 400, pedidos: 4, desconto_vendedor: 40, desconto_ml: 10, retorno: 10 }]);
  assert.deepStrictEqual([ml.faturamento, ml.participacao, ml.pedidos, ml.desconto, ml.desconto_ml, ml.top[0].nome], [400, 0.4, 4, 40, 10, '11.11']);
  const ds = [{ id: '7', nome: 'Desconto 11.11', inicio: '2026-10-01T00:00:00Z', fim: '2026-11-12T00:00:00Z', orig: { '10:1': 120, '10:*': 120, '10:2': 90, '20:0': 50, '20:*': 50 } }];
  const sl = (pedido, item, model, preco, q, extra = {}) => ({ pedido, valida: true, data: '2026-10-20T12:00:00Z', shopee_item: item, shopee_model: model, preco_unit: preco,
    quantidade: q, faturamento: preco * q, lucro: preco * q * 0.2, cupom: null, ...extra });
  const s = G.placarShopeeDe([sl('A', 10, 1, 100, 2), sl('B', 10, 2, 90, 1), sl('C', 20, 0, 40, 1, { data: '2026-09-20T12:00:00Z' }), sl('D', 30, 0, 60, 1, { cupom: 5 })], ds);
  assert.deepStrictEqual([s.faturamento, s.pedidos, s.desconto, s.top.map((x) => x.nome)], [260, 2, 45, ['Desconto 11.11', 'Cupom da loja']],
    'Shopee: 2 × (120 − 100) no desconto; variação no preço original e venda fora do período não contam; cupom da loja conta');
  const ads = G.placarAdsDe({ gasto: 100, vendas: 800 }, { faturamento: 2000, lucro: 500 });
  assert.deepStrictEqual([ads.roas, ads.acos, ads.tacos, ads.lucro_pos_ads, ads.margem_pos_ads], [8, 0.125, 0.05, 400, 0.2]);
  assert.strictEqual(G.placarAdsDe(null, {}), null);
}

// ---- compras e capital parado ----
{
  const p = (numero, extra) => ({ numero, sku: `KIT-${numero}`, nome: `P${numero}`, fornecedor: 'Forn A', situacao: 'Ativo', saldo: 10, custo_medio: 5, media: 2,
    dias: 150, sugestao: 0, prazo: 1, status: 'Regular', ultima_saida: '2026-11-01T12:00:00Z', ...extra });
  const r = comprasDe([p(1, { saldo: 100, media: 4, ultima_saida: '2026-07-01T12:00:00Z' }), p(2, { saldo: 20, ultima_saida: null }), p(3, { sugestao: 8, saldo: 0 }),
    p(4, { sugestao: 3, fornecedor: 'Forn B', custo_medio: null }), p(5, { sugestao: 9, situacao: 'Descontinuado' })], { agora });
  assert.deepStrictEqual([r.resumo.parado_60.produtos, r.resumo.parado_60.valor, r.resumo.parado_90.produtos, r.resumo.parado_90.valor], [2, 600, 2, 600],
    'sem saída desde julho e nunca saiu (sem início): parados');
  const ri = comprasDe([p(1, { saldo: 100, media: 4, ultima_saida: '2026-07-01T12:00:00Z' }), p(2, { saldo: 20, ultima_saida: null })], { agora, inicio: '2026-10-16T15:00:00Z' });
  assert.deepStrictEqual([ri.resumo.parado_60.produtos, ri.resumo.sem_saida_desde_inicio.produtos, ri.resumo.sem_saida_desde_inicio.dias, ri.parados.length], [1, 1, 18, 2],
    'estoque começou há 18 dias: quem nunca saiu fica em "sem saída desde o início", não em 60+');
  assert.deepStrictEqual([r.resumo.excesso.produtos, r.excesso[0].excesso_un, r.excesso[0].excesso_valor], [2, 76, 380], '100 − 6 meses × 4 = 76 a mais (e o P2: 20 contra 12)');
  assert.deepStrictEqual(r.fornecedores.map((f) => [f.fornecedor, f.unidades, f.valor, f.sem_custo]), [['Forn A', 8, 40, 0], ['Forn B', 3, 0, 1]],
    'pedido por fornecedor = sugestão × custo; descontinuado não entra');
  assert.strictEqual(r.resumo.valor_estoque, 650);
}

{
  const E = require('./estoque.js');
  const seis = '2026-05-03T15:00:00.000Z';
  assert.strictEqual(E.mesesDaBase(seis, '2026-04-01T00:00:00Z', '2026-10-16T15:00:00Z', agora), 6, 'com histórico de 6 meses: 6');
  assert.strictEqual(Math.round(E.mesesDaBase(seis, '2026-10-17T10:00:00Z', '2026-10-16T15:00:00Z', agora) * 100) / 100, 0.59, 'só desde a contagem de 16/10: ~18 dias');
  assert.strictEqual(E.mesesDaBase(seis, null, null, agora), 6);
  assert.strictEqual(E.reposicao({ ativo: true, saldo: 0, saidas6m: 30, prazo: 1, meses: 0.5 }).media, 60, '30 saídas em meio mês = 60 por mês');
}
console.log('Gestão (caixa a receber, DRE do mês, placar de promoções e Ads, compras e capital parado): ok');
