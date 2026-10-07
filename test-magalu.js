'use strict';
// node test-magalu.js — Magalu: só funções puras e a regra de fora do MCP.
const assert = require('node:assert');
const M = require('./magalu.js');

// credenciais do IDM: letras, números, _ e -; segredo vazio mantém o gravado
assert.deepStrictEqual(M.validarConfig({ client_id: ' wn1p2_ABCDEFGHIJKLMNOPQRSTUV-xyz ', client_secret: 'abcdefghijKLMNOPQRST_-123' }),
  { client_id: 'wn1p2_ABCDEFGHIJKLMNOPQRSTUV-xyz', client_secret: 'abcdefghijKLMNOPQRST_-123' });
assert.strictEqual(M.validarConfig({ client_id: 'wn1p2_ABCDEFGHIJKLMNOPQRSTUV' }).client_secret, undefined);
assert.throws(() => M.validarConfig({ client_id: 'curto' }), /Client ID/);
assert.throws(() => M.validarConfig({ client_id: 'wn1p2_ABCDEFGHIJKLMNOPQRSTUV', client_secret: 'tem espaço no meio do segredo' }), /Client Secret/);

// autorização: login do ID Magalu escolhendo a LOJA, com os escopos e o retorno em localhost
const u = new URL(M.urlAutorizacao({ clientId: 'abc', redirect: 'http://localhost:3100/magalu/callback', state: 'f'.repeat(32) }));
assert.strictEqual(u.origin + u.pathname, 'https://id.magalu.com/login');
assert.strictEqual(u.searchParams.get('choose_tenants'), 'true');
assert.strictEqual(u.searchParams.get('response_type'), 'code');
assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://localhost:3100/magalu/callback');
assert.ok(u.searchParams.get('scope').split(' ').includes('open:order-financial-report-seller:read'));

// dado do comprador nunca sai do módulo
assert.deepStrictEqual(M.semPessoais({ code: 'LU-1', status: 'new', customer: { name: 'X', document: '1' },
  deliveries: [{ shipping: { recipient: { name: 'Y' }, address: { street: 'Z' } }, items: [{ sku: 'A', price: 10 }] }] }),
{ code: 'LU-1', status: 'new', deliveries: [{ shipping: {}, items: [{ sku: 'A', price: 10 }] }] });

// pedido e financeiro (medidos com a loja real): recebido = créditos − débitos, sem o débito do
// "preço promocional" (ABSOLUTE_DISCOUNT) nem as linhas not_applicable
const din = (v) => ({ currency: 'BRL', normalizer: 100, total: Math.round(v * 100) });
const ped = M.pedidoDe({ code: 1533570108608276, purchased_at: '2026-05-04T01:31:28Z', status: 'finished',
  amounts: { ...din(520.74), freight: din(4.9), commission: din(92.56) },
  customer: { name: 'X' },
  deliveries: [{ shipping: { delivered_at: '2026-05-04T23:29:01Z' }, items: [{ quantity: 2, unit_price: { normalizer: 100, value: 29990 },
    amounts: { ...din(520.74), freight: din(4.9), discount: din(83.96), commission: din(82.56) }, info: { sku: 'SEM-CUSTO', description: 'Ducha', images: [{ url: 'https://a-static.mlcdn.com.br/x.jpeg' }] } }] }] });
assert.strictEqual(ped.code, '1533570108608276');
assert.strictEqual(ped.itens[0].faturamento, 515.84, 'faturamento = total do item − frete do cliente');
assert.ok(!JSON.stringify(ped).includes('"X"'), 'sem o comprador');
const t = (type, category, subcategory, v, status = 'ready', description = '') => ({ type, category, subcategory, value: Math.round(v * 100), normalizer: 100, status, description });
const ts = M.transacoesDe({ transactions: [t('CREDIT', 'SALE', 'PRODUCT', 599.8), t('DEBIT', 'SHIPPING_COST', 'FREIGHT', 4.9), t('DEBIT', 'DISCOUNT', 'PRODUCT', 83.96),
  t('DEBIT', 'FEES', 'PLATFORM', 10), t('DEBIT', 'FEES', 'PAYMENT_PROCESSING', 11.16), t('DEBIT', 'COMMISSION', 'SERVICE', 17.85), t('DEBIT', 'COMMISSION', 'TECHNOLOGY', 53.55),
  t('CREDIT', 'PROMOTION', 'PERCENTAGE_DISCOUNT', 41.98, 'awaiting_payment', 'ACELERE SUAS VENDAS - 7% + 7% PIX COPARTICIPADO'),
  t('DEBIT', 'PROMOTION', 'ABSOLUTE_DISCOUNT', 315, 'awaiting_payment', 'PREÇO PROMOCIONAL'), t('DEBIT', 'PROMOTION', 'ABSOLUTE_DISCOUNT', 18.59, 'not_applicable', 'Promoção Junho'),
  t('INFORMATIVE', 'TAXES', 'ICMS', 37.85)] });
const fin = M.financeiroDo(ts);
assert.strictEqual(fin.recebido, 460.36);
assert.strictEqual(fin.freteCusto, 4.9);
assert.deepStrictEqual(fin.promocoes.map((p) => [p.nome, p.magalu, p.vendedor]), [['ACELERE SUAS VENDAS - 7% + 7% PIX COPARTICIPADO', 41.98, 0], ['PREÇO PROMOCIONAL', 0, 315]]);
const ls = M.linhasDe([ped], { mapa: new Map(), financeiro: new Map([[ped.code, ts]]), embalagem_pedido: 2, imposto_pct: 10 });
assert.deepStrictEqual([ls[0].faturamento, ls[0].tarifa, ls[0].frete, ls[0].recebido, ls[0].estimado], [515.84, 50.58, 4.9, 460.36, false]);
assert.deepStrictEqual(ls[0].falta, ['custo']);
// sem o financeiro: a comissão do pedido (comissão + tarifa fixa + MDR), marcada como estimada
const est = M.linhasDe([ped], { mapa: new Map(), financeiro: new Map() })[0];
assert.deepStrictEqual([est.tarifa, est.frete, est.estimado], [92.56, 0, true]);
// SKU do painel digitado para o código da Magalu: o custo vem dele
const cat = new Map([[630, { numero: 630, sku: 'KIT-630', nome: 'Gatilho', custo: 12.5 }]]);
const comVinc = M.linhasDe([{ ...ped, itens: [{ ...ped.itens[0], sku: '15850067167' }] }], { mapa: cat, financeiro: new Map(), vinculos: new Map([['15850067167', 'KIT-630']]) })[0];
assert.deepStrictEqual([comVinc.sku, comVinc.sku_magalu, comVinc.custo_unit, comVinc.produto], ['KIT-630', '15850067167', 12.5, 25]);

// cancelado: não é venda
assert.strictEqual(M.linhasDe([{ ...ped, status: 'cancelled' }], { mapa: new Map() })[0].valida, false);

// dados da Magalu não vão para o MCP
const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp.js'), 'utf8');
assert.ok(!/\/api\/magalu/.test(mcp), 'nenhuma ferramenta MCP aponta para /api/magalu');

console.log('Magalu: credenciais, autorização da loja, sem dados de comprador, recebido pelo financeiro e fora do MCP: ok');
