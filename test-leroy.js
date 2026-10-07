'use strict';
// node test-leroy.js — Leroy Merlin (Mirakl): só funções puras e a regra de fora do MCP.
const assert = require('node:assert');
const L = require('./leroy.js');

// endereço do portal: só *.mirakl.net, normalizado; chave no formato da Mirakl; ID só números
assert.deepStrictEqual(L.validarConfig({ host: 'leroymerlin-prod.mirakl.net/mmp/shop/home', api_key: '01234567-89ab-cdef-0123-456789abcdef', shop_id: ' 11338 ' }),
  { host: 'https://leroymerlin-prod.mirakl.net', api_key: '01234567-89ab-cdef-0123-456789abcdef', shop_id: '11338' });
assert.strictEqual(L.validarConfig({ host: 'https://x.mirakl.net/' }).api_key, undefined, 'chave em branco: mantém a gravada');
assert.throws(() => L.validarConfig({ host: 'https://exemplo.com' }), /mirakl\.net/);
assert.throws(() => L.validarConfig({ host: 'https://x.mirakl.net.evil.com' }), /mirakl\.net/);
assert.throws(() => L.validarConfig({ host: 'https://x.mirakl.net', api_key: 'abc' }), /Chave de API/);
assert.throws(() => L.validarConfig({ host: 'https://x.mirakl.net', shop_id: '11a' }), /ID da loja/);

// dados do comprador nunca saem do módulo
const p = L.semPessoais({ order_id: 'A-1', order_state: 'SHIPPED', customer: { firstname: 'X', email: 'y' },
  order_lines: [{ price: 10, shipping_address: { street_1: 'z' } }] });
assert.deepStrictEqual(p, { order_id: 'A-1', order_state: 'SHIPPED', order_lines: [{ price: 10 }] });

// campos adicionais com nome, CPF, telefone e endereço também saem
assert.deepStrictEqual(L.semPessoais({ order_additional_fields: [{ code: 'customer-firstname', value: 'X' }, { code: 'shipping-address-zip-code', value: '1' },
  { code: 'invoice-number', value: '012196' }] }), { order_additional_fields: [{ code: 'invoice-number', value: '012196' }] });

// pedido -> linhas: recebido = preço + frete − comissão − reembolso + comissão devolvida (bate com as transações)
const pedido = L.pedidoDe({ order_id: '1-A', created_date: '2026-06-01T12:00:00Z', order_state: 'RECEIVED',
  order_additional_fields: [{ code: 'customer-firstname', value: 'X' }],
  order_lines: [
    { order_line_id: '1-A-1', offer_sku: 'SEM-CUSTO', product_title: 'Ducha', quantity: 1, order_line_state: 'REFUNDED', price: 121.54, shipping_price: 41.99,
      total_commission: 29.44, commission_vat: 0, refunds: [{ amount: 121.54, shipping_amount: 41.99, commission_total_amount: 29.44, state: 'REFUNDED' }] },
    { order_line_id: '1-A-2', offer_sku: 'SEM-CUSTO', quantity: 2, order_line_state: 'RECEIVED', price: 125.3, shipping_price: 41.99, total_commission: 30.11,
      refunds: [{ amount: 70.3, shipping_amount: 41.99, commission_total_amount: 20.21, state: 'REFUNDED' }] }] });
assert.ok(!JSON.stringify(pedido).includes('customer'), 'pedido gravado sem dado do comprador');
// do comprador só o nome; CPF, telefone e endereço não; foto só do caminho de imagem da Mirakl
const comCliente = L.pedidoDe({ order_id: '3-A', customer: { firstname: 'Ana', lastname: 'Souza', customer_id: '123.456.789-00',
  shipping_address: { street_1: 'Rua X', phone: '119999' } }, order_lines: [{ order_line_id: '3-A-1', price: 10, quantity: 1,
  product_medias: [{ type: 'LARGE', media_url: '/media/product/image/17d54e9e-6442-44bd-b09d-c61a1ceb0315' },
    { type: 'SMALL', media_url: '/media/product/image/1c521c93-80da-4114-899d-eeb31de2e49d' }] }] });
assert.strictEqual(comCliente.cliente, 'Ana Souza');
assert.ok(!/123\.456|Rua X|119999/.test(JSON.stringify(comCliente)), 'sem CPF, endereço e telefone');
const lc = L.linhasDe([comCliente], { mapa: new Map(), host: 'https://x.mirakl.net' })[0];
assert.strictEqual(lc.foto, 'https://x.mirakl.net/mmp/media/product/image/1c521c93-80da-4114-899d-eeb31de2e49d');
assert.strictEqual(lc.comprador_nome, 'Ana Souza');
assert.strictEqual(L.pedidoDe({ order_id: '4', order_lines: [{ product_medias: [{ type: 'SMALL', media_url: 'https://evil.com/x.jpg' }] }] }).linhas[0].foto, null);
const ls = L.linhasDe([pedido], { mapa: new Map(), entrega_propria: 30, embalagem_pedido: 4, imposto_pct: 10,
  estados: L.estadosDasLinhas([{ linha: '1-A-1', estado: 'PAID' }, { linha: '1-A-2', estado: 'PAID' }, { linha: '1-A-2', estado: 'PAYABLE' }]) });
assert.strictEqual(ls[0].recebido, 0, 'reembolso total: nada recebido');
assert.strictEqual(ls[0].devolvido, true);
assert.strictEqual(ls[0].produto, 0, 'produto voltou');
assert.strictEqual(ls[1].recebido, 45.1);   // 125,30 + 41,99 − 30,11 − 70,30 − 41,99 + 20,21
assert.strictEqual(ls[1].devolvido, false);
assert.strictEqual(ls[0].recebido_final, true);
assert.strictEqual(ls[1].recebido_final, false, 'uma transação ainda a pagar');
assert.deepStrictEqual(ls[1].falta, ['custo']);
assert.strictEqual(ls[1].lucro, null);
// entrega: uma por pedido, rateada pelo preço; frete = entrega − frete pago pelo cliente
assert.strictEqual(ls[0].custo_entrega + ls[1].custo_entrega, 30);
assert.strictEqual(ls[1].frete, Math.round((30 * 125.3 / (121.54 + 125.3) - 41.99) * 100) / 100);
// sem custo de entrega na tela Empresa: lucro pendente
assert.ok(L.linhasDe([pedido], { mapa: new Map(), estados: new Map() })[1].falta.includes('entrega'));
// frete digitado no pedido (Melhor Envio) vale sobre o custo médio da tela Empresa
const comFrete = L.linhasDe([pedido], { mapa: new Map(), entrega_propria: 30, fretes: new Map([['1-A', 20]]) });
assert.strictEqual(comFrete[0].custo_entrega + comFrete[1].custo_entrega, 20);
assert.strictEqual(comFrete[1].frete_informado, true);
assert.strictEqual(comFrete[1].frete_estimado, false);
assert.strictEqual(comFrete[1].frete_pedido, 20);
assert.strictEqual(ls[1].frete_estimado, true, 'sem frete digitado: custo médio, estimado');

// pedido cancelado: não é venda
const canc = L.linhasDe([L.pedidoDe({ order_id: '2-A', order_state: 'CANCELED', order_lines: [{ order_line_id: '2-A-1', order_line_state: 'CANCELED', price: 0, quantity: 1 }] })], { mapa: new Map() });
assert.strictEqual(canc[0].valida, false);
assert.strictEqual(canc[0].lucro, 0);

// ciclos: fecham nos dias 10 e 25 (00h de Brasília)
assert.strictEqual(L.proximoFechamento(Date.parse('2026-10-07T12:00:00Z')), '2026-10-10T03:00:00.000Z');
assert.strictEqual(L.proximoFechamento(Date.parse('2026-10-25T02:00:00Z')), '2026-10-25T03:00:00.000Z', '24/10 23h em Brasília');
assert.strictEqual(L.proximoFechamento(Date.parse('2026-12-26T12:00:00Z')), '2027-01-10T03:00:00.000Z');
const ciclo = L.cicloDe({ type: 'AUTO_INVOICE', seller_billing_cycle_id: 'c1', start_time: '2026-05-10T03:06:25Z', end_time: '2026-05-25T03:05:56Z',
  due_date: '2026-06-19T03:00:00Z', payment: { state: 'PAID' }, summary: { amount_transferred: 1736.94, total_payable_orders_incl_tax: 2527.98,
    total_commissions_incl_tax: -455.03, total_refund_commissions_incl_tax: 73.76, total_refund_orders_incl_tax: -409.77, total_subscription_incl_tax: 0 } });
const rep = L.repassesDe([
  { tipo: 'ORDER_AMOUNT', estado: 'PAYABLE', valor: 100, pedido: 'P1' }, { tipo: 'COMMISSION_FEE', estado: 'PAYABLE', valor: -18, pedido: 'P1' },
  { tipo: 'SUBSCRIPTION_FEE', estado: 'PAYABLE', valor: -49, pedido: null }, { tipo: 'ORDER_AMOUNT', estado: 'PENDING', valor: 50, pedido: 'P2' },
  { tipo: 'PAYMENT', estado: 'PAID', valor: -1736.94 }], [ciclo], Date.parse('2026-10-07T12:00:00Z'));
assert.deepStrictEqual(rep.proximo, { fechamento: '2026-10-10T03:00:00.000Z', previsto: '2026-11-04T03:00:00.000Z', valor: 33, pedidos: 1, cobrancas: -49 });
assert.deepStrictEqual(rep.aguardando_entrega, { valor: 50, pedidos: 1 });
assert.strictEqual(rep.ciclos[0].outros, 0, 'vendas − comissão − reembolsos − assinatura = transferido');
assert.strictEqual(rep.ciclos[0].vencido, true);

// dados da Leroy não vão para o MCP (mesma regra da Amazon)
const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp.js'), 'utf8');
assert.ok(!/\/api\/leroy/.test(mcp), 'nenhuma ferramenta MCP aponta para /api/leroy');

console.log('Leroy Merlin: endereço, chave, ID da loja, sem dados de comprador, lucro por linha, repasses e fora do MCP: ok');
