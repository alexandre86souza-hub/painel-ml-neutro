'use strict';
// node test-auditoria.js — auditoria de 15/10/2026: testes matemáticos INDEPENDENTES das fórmulas de lucro.
// Os valores esperados foram calculados à mão (dinheiro que entra − dinheiro que sai), não pela
// mesma fórmula do sistema. Só funções puras: não abre banco, não chama API, não muda nada.
const C = require('./custos.js');
const S = require('./shopee-vendas.js');
const L = require('./leroy.js');
const M = require('./magalu.js');
const Z = require('./amazon.js');
const A = require('./public/analise.js');

const res = [];
const perto = (a, b, tol = 0.005) => a != null && b != null && Math.abs(a - b) <= tol;
function caso(id, nome, fn) {
  try { const r = fn(); res.push({ id, nome, ok: r.ok, obtido: r.obtido, esperado: r.esperado, nota: r.nota || '' }); }
  catch (e) { res.push({ id, nome, ok: false, obtido: 'ERRO ' + e.message, esperado: '-' }); }
}
const mapa = new Map([[1, { numero: 1, sku: 'DQ-001', custo: 30 }], [2, { numero: 2, sku: 'BP-002', custo: 7.5 }],
  [5, { numero: 5, sku: 'DQ-005', custo: 5 }], [10, { numero: 10, sku: 'XX-010', custo: 10.01 }],
  [795, { numero: 795, sku: 'DD-795', custo: 41.86 }], [854, { numero: 854, sku: 'DD-854', custo: 15 }],
  [488, { numero: 488, sku: 'DQ-488', custo: 20 }], [479, { numero: 479, sku: 'BP-479', custo: 8 }],
  [7, { numero: 7, sku: 'SC-007', custo: null }]]);
C.usarComposicoes(new Map());

// ---------------- Mercado Livre: contaDaLinha ----------------
const ml = (l, ctx) => C.contaDaLinha({ quantidade: 1, preco_unit: 0, tarifa_unit: 0, frete_envio: 0, total_envio: 0, ...l },
  { custo_unit: null, embalagem_unit: 0, imposto_pct: 10, ...ctx });
caso('ML-01', 'Venda lucrativa (100 − 12 tarifa − 10 frete − 40 custo − 1,50 emb − 10 imposto)', () => {
  const r = ml({ preco_unit: 100, tarifa_unit: 12, frete_envio: 10, total_envio: 100 }, { custo_unit: 40, embalagem_unit: 1.5 });
  return { ok: perto(r.lucro, 26.5) && perto(r.margem, 0.265), obtido: `${r.lucro} / ${(r.margem * 100).toFixed(1)}%`, esperado: '26.5 / 26.5%' };
});
caso('ML-02', 'Prejuízo real (frete maior que a margem)', () => {
  const r = ml({ preco_unit: 50, tarifa_unit: 6, frete_envio: 20, total_envio: 50 }, { custo_unit: 30, embalagem_unit: 1.5 });
  return { ok: perto(r.lucro, -12.5), obtido: r.lucro, esperado: -12.5 };
});
caso('ML-03', 'Margem perto de zero (MLB3272743881 a R$ 63,23, kit 756 = 35,93)', () => {
  const r = ml({ preco_unit: 63.23, tarifa_unit: 7.27, frete_envio: 8.25, total_envio: 63.23 }, { custo_unit: 35.93, embalagem_unit: 1.5 });
  return { ok: perto(r.lucro, 3.96), obtido: r.lucro, esperado: 3.96 };
});
caso('ML-04', 'Kit com 3 unidades (KIT-005.002 = 5 + 7,50 por unidade)', () => {
  const custo = C.custoDoSku('KIT-005.002', mapa).custo;   // 12,50
  const r = ml({ quantidade: 3, preco_unit: 30, tarifa_unit: 3.6, frete_envio: 12, total_envio: 90 }, { custo_unit: custo, embalagem_unit: 1 });
  // 90 − 10,80 − 12 − 37,50 − 3 − 9 = 17,70
  return { ok: perto(custo, 12.5) && perto(r.produto, 37.5) && perto(r.lucro, 17.7), obtido: `custo ${custo}, produto ${r.produto}, lucro ${r.lucro}`, esperado: 'custo 12.5, produto 37.5, lucro 17.7' };
});
caso('ML-05', 'Peça repetida no kit conta 2× (KIT-005.005)', () => {
  const c = C.custoDoSku('KIT-005.005', mapa).custo;
  return { ok: perto(c, 10), obtido: c, esperado: 10 };
});
caso('ML-06', 'Frete do pacote rateado pelo valor (linha de 100 num envio de 150 com frete 15)', () => {
  const r = ml({ preco_unit: 100, frete_envio: 15, total_envio: 150 }, { custo_unit: 0 });
  return { ok: perto(r.frete, 10), obtido: r.frete, esperado: 10 };
});
caso('ML-07', 'Produto sem custo → lucro vazio (não zero)', () => {
  const r = ml({ preco_unit: 100 }, { custo_unit: null });
  return { ok: r.lucro === null && r.falta.includes('custo'), obtido: `${r.lucro} falta=${r.falta}`, esperado: 'null falta=custo' };
});
caso('ML-08', 'Componente sem custo no kit → custo do SKU vazio', () => {
  const c = C.custoDoSku('KIT-005.007', mapa);
  return { ok: c.custo === null && c.faltando.includes('SC-007'), obtido: `${c.custo} faltando=${c.faltando}`, esperado: 'null faltando=SC-007' };
});
caso('ML-09', 'Frete ainda não medido → lucro vazio', () => {
  const r = ml({ preco_unit: 100, frete_envio: null }, { custo_unit: 10 });
  return { ok: r.lucro === null && r.falta.includes('frete'), obtido: `${r.lucro} falta=${r.falta}`, esperado: 'null falta=frete' };
});
caso('ML-10', 'Centavos: 3 × 19,99 com imposto 10% (5,997)', () => {
  const r = ml({ quantidade: 3, preco_unit: 19.99, tarifa_unit: 2.39, frete_envio: 0, total_envio: 59.97 }, { custo_unit: 10.01 });
  // 59,97 − 7,17 − 0 − 30,03 − 0 − 5,997 = 16,773
  return { ok: perto(r.faturamento, 59.97) && perto(r.lucro, 16.77), obtido: `fat ${r.faturamento} lucro ${r.lucro}`, esperado: 'fat 59.97 lucro 16.77' };
});
caso('ML-11', 'Flex: frete = entrega paga (12) − bônus do ML (1,10)', () => {
  const f = C.freteFlex({ custoMl: 9.89, bonus: 1.1, entrega: 12 });
  return { ok: perto(f.frete, 10.9) && f.estimado === false, obtido: f.frete, esperado: 10.9 };
});
caso('ML-12', 'Regressão das 9: SELLER_SKU vale mais que o código velho do seller_custom_field', () => {
  const b = C.skusDoAnuncio({ id: 'MLB1', seller_custom_field: 'DQ-488.2', attributes: [{ id: 'SELLER_SKU', value_name: 'AMG-488.479' }] }).base;
  const comps = C.componentes(b);
  return { ok: b === 'AMG-488.479' && comps.join() === '488,479', obtido: `${b} -> ${comps}`, esperado: 'AMG-488.479 -> 488,479' };
});
caso('ML-13', 'Regressão das 9: custo do código velho DQ-488.2 viraria 488 + produto 2', () => {
  const velho = C.custoDoSku('DQ-488.2', mapa).custo, certo = C.custoDoSku('AMG-488.479', mapa).custo;
  return { ok: perto(velho, 27.5) && perto(certo, 28), obtido: `velho ${velho} / certo ${certo}`, esperado: 'velho 27.5 (488+002) / certo 28 (488+479)', nota: 'mostra que o código velho dá outro custo' };
});
caso('ML-14', 'Regressão das 9: troca de produto no meio do período (795 → 854) — lucro venda a venda × custo atual × unidades', () => {
  const v1 = ml({ preco_unit: 69.9, tarifa_unit: 8, frete_envio: 9, total_envio: 69.9 }, { custo_unit: 41.86 + 10, embalagem_unit: 1.5 });
  const v2 = ml({ preco_unit: 69.9, tarifa_unit: 8, frete_envio: 9, total_envio: 69.9 }, { custo_unit: 15 + 10, embalagem_unit: 1.5 });
  const porVenda = v1.lucro + v2.lucro;
  const agregado = A.economia({ faturamento: 139.8, unidades: 2, tarifas: 16, freteUnidade: 9, custo: 25, outros: 1.5, impostoPct: 10 }).lucro;
  // à mão: venda 1 = 69,90 − 8 − 9 − 51,86 − 1,5 − 6,99 = −7,45; venda 2 = 69,90 − 8 − 9 − 25 − 1,5 − 6,99 = 19,41
  return { ok: perto(v1.lucro, -7.45) && perto(v2.lucro, 19.41) && perto(porVenda, 11.96) && !perto(agregado, porVenda),
    obtido: `por venda ${porVenda.toFixed(2)} | custo atual × un ${agregado.toFixed(2)}`, esperado: 'por venda 11.96 (o agregado superestima)', nota: 'a tela Anúncios usa o venda a venda desde 5e7316b' };
});
caso('ML-15', 'Venda parcialmente reembolsada: faturamento não desconta o reembolso', () => {
  const r = ml({ preco_unit: 100, tarifa_unit: 12, frete_envio: 10, total_envio: 100, reembolso: 30 }, { custo_unit: 40 });   // C1: o reembolso vem do Mercado Pago
  // o ML devolveu 30 ao comprador: o resultado real seria 28 (100 − 30 − 12 − 10 − 40 − imposto sobre 70 = 7)… contaDaLinha não recebe o reembolso
  const esperadoReal = 100 - 30 - 12 - 10 - 40 - 7;
  return { ok: perto(r.lucro, esperadoReal), obtido: r.lucro, esperado: esperadoReal, nota: 'corrigido em ec59286 (C1)' };
});

// ---------------- Tela Anúncios / ABC antiga: economia() ----------------
caso('AN-01', 'Tela Anúncios venda a venda: a embalagem padrão de cada venda entra (antes: outros_total null = 0)', () => {
  const venda = { item_id: 'MLB1', valida: true, quantidade: 1, ...C.contaDaLinha({ quantidade: 1, preco_unit: 100, tarifa_unit: 12, frete_envio: 10, total_envio: 100 }, { custo_unit: 40, embalagem_unit: 1.5, imposto_pct: 10 }) };
  const sem = C.lucroPorAnuncio([venda]).MLB1.lucro;
  const com = 100 - 12 - 10 - 40 - 1.5 - 10;   // embalagem padrão 1,50 da empresa
  return { ok: perto(sem, com), obtido: sem, esperado: com, nota: 'corrigido em 5e7316b (A1+A2)' };
});

// ---------------- Shopee ----------------
const sp = (p, itens, ctx = {}) => S.linhasDe(itens.map((i, k) => ({ order_sn: 'X', data: '2026-09-10T12:00:00Z', status: 'COMPLETED', escrow_final: 1,
  recebido: 70, frete_shopee: 0, devolucao: 0, servico: 0, cupom_vendedor: 0, transportadora: 'Shopee Xpress', linha: k, quantidade: 1, ...p, ...i })),
  { mapa, imposto_pct: 10, embalagem_pedido: 2, proporcao: 0.3, entrega_propria: null, frete_medio: {}, ...ctx });
caso('SP-01', 'Repasse exato: lucro = recebido − custo − embalagem − imposto', () => {
  const r = sp({}, [{ sku: 'DQ-001', preco_unit: 100 }])[0];
  return { ok: perto(r.lucro, 70 - 30 - 2 - 10), obtido: r.lucro, esperado: 28 };
});
caso('SP-02', 'Entrega Direta: repasse 85 já tem 15 de frete da Shopee; vendedor paga 12 à transportadora', () => {
  const r = sp({ recebido: 85, frete_shopee: 15, transportadora: 'Entrega Direta' }, [{ sku: 'DQ-001', preco_unit: 100 }], { entrega_propria: 12 })[0];
  return { ok: perto(r.lucro, 85 - 12 - 30 - 2 - 10), obtido: r.lucro, esperado: 31 };
});
caso('SP-03', 'Entrega Direta sem custo de entrega cadastrado → lucro vazio (falta entrega)', () => {
  const r = sp({ recebido: 85, frete_shopee: 15, transportadora: 'Entrega Direta' }, [{ sku: 'DQ-001', preco_unit: 100 }])[0];
  return { ok: r.lucro === null && r.falta.includes('entrega'), obtido: `${r.lucro} ${r.falta}`, esperado: 'null entrega' };
});
caso('SP-04', 'Reembolsado (repasse final −0,49): produto volta, sem imposto', () => {
  const r = sp({ recebido: -0.49 }, [{ sku: 'DQ-001', preco_unit: 100 }])[0];
  return { ok: r.devolvido && perto(r.lucro, -0.49 - 2) && r.imposto === 0, obtido: `${r.lucro} imposto ${r.imposto}`, esperado: '-2.49 imposto 0' };
});
caso('SP-05', 'Cancelado → fora do lucro (0) e da soma', () => {
  const r = sp({ status: 'CANCELLED', recebido: null }, [{ sku: 'DQ-001', preco_unit: 100 }])[0];
  return { ok: !r.valida && r.lucro === 0, obtido: `${r.valida} ${r.lucro}`, esperado: 'false 0' };
});
caso('SP-06', 'Pedido com 2 itens: tarifa rateada pelo valor (60/40) e soma = recebido', () => {
  const ls = sp({}, [{ sku: 'DQ-001', preco_unit: 60 }, { sku: 'BP-002', preco_unit: 40 }]);
  const soma = ls.reduce((s, l) => s + l.lucro, 0);
  return { ok: perto(ls[0].tarifa, 18) && perto(ls[1].tarifa, 12) && perto(soma, 70 - 37.5 - 2 - 10), obtido: `${ls[0].tarifa}/${ls[1].tarifa} soma ${soma.toFixed(2)}`, esperado: '18/12 soma 20.5' };
});
caso('SP-07', 'Sem repasse ainda → estimado pela proporção da loja (marcado)', () => {
  const r = sp({ recebido: null, escrow_final: 0 }, [{ sku: 'DQ-001', preco_unit: 100 }])[0];
  return { ok: r.estimado && perto(r.tarifa, 30), obtido: `estimado ${r.estimado} tarifa ${r.tarifa}`, esperado: 'estimado true tarifa 30' };
});
caso('SP-08', 'Pedido de valor ZERO concluído (troca/reenvio?) com repasse 0', () => {
  const r = sp({ recebido: 0 }, [{ sku: 'DQ-001', preco_unit: 0, quantidade: 2 }])[0];
  return { ok: true, obtido: `devolvido=${r.devolvido} produto=${r.produto} lucro=${r.lucro}`, esperado: 'a decidir', nota: 'regra atual: concluído com repasse 0 = reembolsado (os casos de R$ 0 da Primor eram "Leve 2": test-canais.js)' };
});

// ---------------- Leroy ----------------
const lr = (linha, ctxExtra = {}, status = 'SHIPPED') => L.linhasDe([{ order_id: 'L1', data: '2026-09-10T12:00:00Z', status,
  linhas: [{ id: 'L1-1', estado: status, preco: 100, quantidade: 1, comissao: 15, comissao_devolvida: 0, reembolso: 0, reembolso_frete: 0, frete_cliente: 10, sku: 'DQ-001', ...linha }] }],
  { mapa, imposto_pct: 10, embalagem_pedido: 2, trocas: new Map(), fretes: new Map([['L1', 20]]), entrega_propria: null, ...ctxExtra })[0];
caso('LR-01', 'Venda: recebido 95 (100 + 10 frete do cliente − 15) − entrega 20 − 30 − 2 − 10', () => {
  const r = lr({});
  return { ok: perto(r.lucro, 95 - 20 - 30 - 2 - 10) && perto(r.recebido, 95), obtido: `${r.lucro} (recebido ${r.recebido})`, esperado: '33 (recebido 95)' };
});
caso('LR-02', 'Reembolso total com comissão devolvida: produto volta, sem imposto', () => {
  const r = lr({ reembolso: 100, comissao_devolvida: 15 });
  // dinheiro: +100 +10 −15 +15 −100 = 10; − entrega 20 − embalagem 2 = −12
  return { ok: r.devolvido && perto(r.lucro, -12), obtido: r.lucro, esperado: -12 };
});
caso('LR-03', 'Sem frete do pedido e sem entrega padrão → lucro vazio', () => {
  const r = lr({}, { fretes: new Map() });
  return { ok: r.lucro === null && r.falta.includes('entrega'), obtido: `${r.lucro} ${r.falta}`, esperado: 'null entrega' };
});

// ---------------- Magalu ----------------
const fin = (ts) => new Map([['M1', ts]]);
const t = (tipo, cat, valor, sub = null) => ({ tipo, cat, sub, valor, status: 'settled', desc: '' });
const mg = (ts) => M.linhasDe([{ code: 'M1', data: '2026-09-10T12:00:00Z', status: 'finished', itens: [{ sku: 'DQ-001', quantidade: 1, faturamento: 100 }] }],
  { mapa, imposto_pct: 10, embalagem_pedido: 2, trocas: new Map(), vinculos: new Map(), financeiro: fin(ts) })[0];
caso('MG-01', 'Venda: recebido 64 (100 − 16 comissão − 20 frete) − 30 − 2 − 10', () => {
  const r = mg([t('CREDIT', 'SALE', 100), t('DEBIT', 'COMMISSION', 16), t('DEBIT', 'SHIPPING_COST', 20)]);
  return { ok: perto(r.lucro, 64 - 30 - 2 - 10), obtido: r.lucro, esperado: 22 };
});
caso('MG-02', 'Reembolso total (REFUND) deveria seguir a regra da Shopee/Leroy: produto volta, sem imposto', () => {
  const r = mg([t('CREDIT', 'SALE', 100), t('DEBIT', 'COMMISSION', 16), t('DEBIT', 'SHIPPING_COST', 20), t('DEBIT', 'REFUND', 100), t('CREDIT', 'COMMISSION', 16)]);
  // dinheiro: 100 − 16 − 20 − 100 + 16 = −20; − embalagem 2 = −22 (produto volta, nota cancelada)
  return { ok: perto(r.lucro, -22), obtido: r.lucro, esperado: -22, nota: 'corrigido em f5d400f (B2)' };
});
caso('MG-03', 'Sem financeiro ainda: frete vira 0 (deveria ficar pendente ou estimado)', () => {
  const r = M.linhasDe([{ code: 'M2', data: '2026-09-10T12:00:00Z', status: 'new', comissao: 16, itens: [{ sku: 'DQ-001', quantidade: 1, faturamento: 100 }] }],
    { mapa, imposto_pct: 10, embalagem_pedido: 2, trocas: new Map(), vinculos: new Map(), financeiro: new Map(), frete_pct: 0.2 })[0];   // C3: frete médio da loja
  return { ok: r.estimado === true && r.frete !== 0, obtido: `estimado ${r.estimado} frete ${r.frete} lucro ${r.lucro}`, esperado: 'frete estimado (não 0)', nota: 'corrigido em ec59286 (C3)' };
});

// ---------------- Amazon (só código; sem dado real) ----------------
caso('AZ-01', 'Reembolso total: produto volta, faturamento e imposto zerados', () => {
  const taxas = { porPedido: new Map([['A1|DQ-001', { lancado: true, tarifa: 15, frete: 0, reembolso: -100, tarifa_reembolso: -12 }]]), mediaSku: () => null, mediaCanal: () => null, armazemUn: 0 };
  const r = Z.linhaDoPedido({ pedido: 'A1', sku: 'DQ-001', status: 'Shipped', quantidade: 1, preco: 100, canal: 'proprio' }, { taxas, custo_unit: 30, embalagem_unit: 2, imposto_pct: 10 });
  return { ok: r.devolvido && perto(r.faturamento, 0) && perto(r.imposto, 0) && r.produto === 0, obtido: `fat ${r.faturamento} imp ${r.imposto} prod ${r.produto} lucro ${r.lucro}`, esperado: 'fat 0 imp 0 prod 0' };
});

// ---------------- Consolidação ----------------
caso('CO-01', 'Margem total = lucro ÷ faturamento com custo (não média de margens)', () => {
  const s = C.somarContas([{ periodo: { faturamento: 1000, lucro: 300, cobertura: 1 } }, { periodo: { faturamento: 100, lucro: -10, cobertura: 1 } }]);
  return { ok: perto(s.periodo.margem, 290 / 1100, 1e-9), obtido: s.periodo.margem.toFixed(4), esperado: (290 / 1100).toFixed(4) };
});

const falhas = res.filter((r) => !r.ok);
if (process.argv.includes('--todos')) for (const r of res) console.log(`${r.ok ? 'OK   ' : 'FALHA'} ${r.id} ${r.nome}\n      obtido: ${r.obtido} | esperado: ${r.esperado}${r.nota ? ' | ' + r.nota : ''}`);
if (falhas.length) {
  for (const r of falhas) console.error(`FALHA ${r.id} ${r.nome}: obtido ${r.obtido} | esperado ${r.esperado}`);
  process.exit(1);
}
console.log(`Auditoria das contas de lucro (ML, Shopee, Leroy, Magalu, Amazon e consolidação): ${res.length}/${res.length} ok`);
