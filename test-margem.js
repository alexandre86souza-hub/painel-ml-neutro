const assert = require('assert');
const M = require('./margem.js');

const v = (pedido, item_id, fat, partes, lucro, extra = {}) => ({ pedido, item_id, sku: 'KIT-' + item_id, titulo: 'Ducha ' + item_id, data: '2026-11-02T12:00:00Z',
  quantidade: 1, faturamento: fat, ...partes, lucro, valida: true, ...extra });
const loja = { loja: 'Shopee · Loja', conta: 'shopee-1', linhas: [
  v('1', 'A', 100, { tarifa: 20, frete: 10, produto: 40, embalagem: 2, imposto: 8 }, 20),   // 20%: fica fora
  v('2', 'B', 100, { tarifa: 20, frete: 35, produto: 40, embalagem: 2, imposto: 8 }, -5),   // frete alto: prejuízo
  v('3', 'C', 100, { tarifa: 20, frete: 10, produto: 55, embalagem: 2, imposto: 8 }, 5),    // custo alto
  v('4', 'C', 100, { tarifa: 20, frete: 10, produto: 55, embalagem: 2, imposto: 8 }, 5),
  v('5', 'D', 100, { tarifa: 20, frete: 10, produto: 40, embalagem: 2, imposto: 8 }, null), // sem custo: fora
  v('6', 'E', 100, { tarifa: 20, frete: 10, produto: 40, embalagem: 2, imposto: 8 }, -50, { valida: false }) ] };
const r = M.margemBaixaDe([loja], { minimo: 0.1 });
assert.deepStrictEqual(r.map((x) => x.item_id), ['B', 'C'], 'prejuízo primeiro; acima do mínimo, sem custo e cancelada ficam fora');
assert.strictEqual(r[0].motivo_parte, 'frete');
assert.match(r[0].motivo, /^frete 35% das vendas \(a loja: 16%\)$/);
assert.deepStrictEqual([r[1].pedidos, r[1].faturamento, r[1].lucro, r[1].margem, r[1].motivo_parte], [2, 200, 10, 0.05, 'produto']);
// custos todos na média da loja: o problema é o preço
const igual = M.margemBaixaDe([{ loja: 'L', conta: 'x', linhas: [v('1', 'Z', 100, { tarifa: 20, frete: 10, produto: 60, embalagem: 2, imposto: 8 }, 0)] }], { minimo: 0.1 });
assert.strictEqual(igual[0].motivo_parte, 'preco');

console.log('Alerta de margem: agrupa por anúncio, motivo provável e ordem: ok');
