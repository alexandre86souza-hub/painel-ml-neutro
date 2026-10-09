'use strict';
// node test-comandas.js — comandas de separação: categorias, numeração, prazo e código de barras.
const assert = require('node:assert');
const K = require('./comandas.js');
const B = require('./public/codigo128.js');

// categorias pedidas pelo vendedor
assert.deepStrictEqual(K.categoriaDe('ml', 'self_service'), { categoria: 'Flex', envio: 'Flex' });
assert.strictEqual(K.categoriaDe('ml', 'xd_drop_off').categoria, 'Mercado Envios');
assert.strictEqual(K.categoriaDe('ml', 'cross_docking').categoria, 'Mercado Envios');
assert.strictEqual(K.categoriaDe('ml', 'fulfillment'), null, 'Full não entra');
assert.deepStrictEqual(K.categoriaDe('shopee', 'Entrega Direta'), { categoria: 'Flex', envio: 'Shopee Entrega Direta' });
assert.strictEqual(K.categoriaDe('shopee', 'Shopee Xpress').categoria, 'Shopee');
assert.deepStrictEqual(K.categoriaDe('magalu', 'VAPT mle-vapt'), { categoria: 'Flex', envio: 'Magalu VAPT' });
assert.strictEqual(K.categoriaDe('magalu', 'Agência Magalu direta').categoria, 'Magalu');
assert.strictEqual(K.categoriaDe('leroy').categoria, 'Melhor Envios');
assert.strictEqual(K.categoriaDe('amazon', 'AFN'), null, 'FBA não entra');
assert.deepStrictEqual(K.categoriaDe('amazon', 'easyship'), { categoria: 'Amazon', envio: 'Amazon DBA' });
assert.strictEqual(K.categoriaDe('amazon', '').envio, 'Amazon Envio Próprio');

// numeração por categoria no dia: continua do maior número de hoje; pelo prazo
const dia = '2026-10-07';
const n = K.numerar([
  { chave: 'a', categoria: 'Flex', prazo: '2026-10-07T20:00:00Z', pedido: '2' },
  { chave: 'b', categoria: 'Flex', prazo: '2026-10-07T15:00:00Z', pedido: '9' },
  { chave: 'c', categoria: 'Shopee', prazo: null, pedido: '1' }],
[{ categoria: 'Flex', dia, numero: 3 }, { categoria: 'Flex', dia: '2026-10-06', numero: 40 }], dia);
assert.deepStrictEqual(n.map((x) => [x.chave, x.categoria, x.numero]), [['b', 'Flex', 4], ['a', 'Flex', 5], ['c', 'Shopee', 1]]);

// não impressa de ontem entra na numeração de hoje; impressa ontem (ou de hoje) mantém
const fila = [{ chave: 'x', dia: '2026-10-06', impressa_em: null }, { chave: 'y', dia: '2026-10-06', impressa_em: '2026-10-06T18:00:00Z' },
  { chave: 'z', dia, impressa_em: null }];
assert.deepStrictEqual(K.atrasadasDaFila(fila, dia).map((c) => c.chave), ['x']);

// ML: entregue no ponto / coletado / no centro ainda é ready_to_ship, mas já saiu
assert.ok(K.jaSaiuMl('dropped_off') && K.jaSaiuMl('picked_up') && K.jaSaiuMl('in_hub'));
assert.ok(!K.jaSaiuMl('ready_to_print') && !K.jaSaiuMl('printed') && !K.jaSaiuMl(null));
// etapa nova depois de sair (in_packing_list) e qualquer outra: o histórico manda (envio real de 09/10/2026)
assert.ok(K.jaSaiuMl('in_packing_list'));
assert.ok(K.jaSaiuMl('etapa_nova', [{ substatus: 'ready_to_print' }, { substatus: 'dropped_off' }, { substatus: 'etapa_nova' }]));
assert.ok(!K.jaSaiuMl('printed', [{ substatus: 'invoice_pending' }, { substatus: 'ready_to_print' }, { substatus: 'printed' }]));

// prazo em relação a hoje (Brasília)
const ag = Date.parse('2026-10-07T15:00:00Z');
assert.strictEqual(K.situacaoPrazo('2026-10-06T20:00:00Z', ag), 'atrasado');
assert.strictEqual(K.situacaoPrazo('2026-10-08T02:59:59Z', ag), 'hoje', '23h59 de Brasília ainda é hoje');
assert.strictEqual(K.situacaoPrazo('2026-10-08T15:00:00Z', ag), 'amanhã');
assert.strictEqual(K.situacaoPrazo(null, ag), 'sem prazo');

// código de barras Code 128: 107 símbolos de 11 módulos (parada 13), barras pares e espaços ímpares
assert.strictEqual(B.PADROES.length, 107);
assert.strictEqual(new Set(B.PADROES).size, 107);
B.PADROES.forEach((p, i) => {
  assert.strictEqual([...p].reduce((a, d) => a + Number(d), 0), i === 106 ? 13 : 11, `símbolo ${i}`);
  if (i < 106) assert.strictEqual((Number(p[0]) + Number(p[2]) + Number(p[4])) % 2, 0, `paridade ${i}`);
});
// "PJJ": início B (104) + P(48) J(42) J(42) + verificador (104+48+84+126=362 % 103 = 53) + parada
assert.strictEqual(B.larguras('PJJ'), B.PADROES[104] + B.PADROES[48] + B.PADROES[42] + B.PADROES[42] + B.PADROES[53] + B.PADROES[106]);
assert.strictEqual(B.larguras(''), null);
assert.ok(B.codigo128Svg('2000018846143466').startsWith('<svg'));

// nada das comandas (tem nome de cliente) no MCP
const mcp = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mcp.js'), 'utf8');
assert.ok(!/\/api\/comandas/.test(mcp), 'comandas fora do MCP');

// etiquetas de envio: quando a loja libera, tipo térmico da Shopee, fora do MCP
const ET = require('./etiquetas.js');
assert.deepStrictEqual(ET.situacaoEtiqueta({ canal: 'ml', etapa: 'ready_to_print' }), { situacao: 'liberada' });
assert.deepStrictEqual(ET.situacaoEtiqueta({ canal: 'ml', etapa: 'printed' }), { situacao: 'liberada', impressa_no_canal: true });
assert.strictEqual(ET.situacaoEtiqueta({ canal: 'ml', etapa: 'invoice_pending' }).situacao, 'aguardando');
assert.strictEqual(ET.situacaoEtiqueta({ canal: 'shopee', etapa: 'PROCESSED' }).situacao, 'liberada');
assert.strictEqual(ET.situacaoEtiqueta({ canal: 'shopee', etapa: 'READY_TO_SHIP' }).situacao, 'aguardando');
assert.strictEqual(ET.situacaoEtiqueta({ canal: 'manual' }), null);
assert.strictEqual(ET.situacaoEtiqueta({ canal: 'amazon' }), null);
assert.strictEqual(ET.tipoShopee({ suggest_shipping_document_type: 'NORMAL_AIR_WAYBILL', selectable_shipping_document_type: ['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'] }), 'THERMAL_AIR_WAYBILL');
assert.strictEqual(ET.tipoShopee({ suggest_shipping_document_type: 'NORMAL_AIR_WAYBILL', selectable_shipping_document_type: ['NORMAL_AIR_WAYBILL'] }), 'NORMAL_AIR_WAYBILL');
{ const pdf = Buffer.from('%PDF-1.4 x');
  assert.strictEqual(ET.soPdf(pdf, 'X'), pdf);
  // zip com um PDF dentro (sem compressão)
  const nome = Buffer.from('etiqueta.pdf'), cab = Buffer.alloc(30);
  cab.writeUInt32LE(0x04034b50, 0); cab.writeUInt16LE(0, 8); cab.writeUInt32LE(pdf.length, 18); cab.writeUInt16LE(nome.length, 26);
  assert.strictEqual(ET.soPdf(Buffer.concat([cab, nome, pdf]), 'X').toString(), '%PDF-1.4 x');
  assert.throws(() => ET.soPdf(Buffer.from('{"error":"logistics.x","message":"pacote sem rastreio"}'), 'Shopee'), /Shopee: pacote sem rastreio/);
  assert.throws(() => ET.soPdf(Buffer.from('<html>oi</html>'), 'Shopee'), /página HTML/); }
assert.ok(!/\/api\/etiquetas/.test(mcp), 'etiquetas fora do MCP');
console.log('Comandas: categorias, numeração do dia, prazo, código de barras, etiquetas de envio e fora do MCP: ok');
