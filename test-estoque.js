'use strict';
// node test-estoque.js — estoque: leitor de .xlsx, importação da planilha, fórmulas de reposição,
// baixa automática (kit, cancelamento, Full, sem duplicar), relatórios, contagem, compras, comanda
// manual e permissões. Sobe o servidor de verdade (portas aleatórias, banco temporário).
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.ML_DB_FILE = path.join(os.tmpdir(), `teste-est-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = 'chave-de-teste-nao-usar-em-producao';
const assert = require('node:assert');
const http = require('node:http');
const E = require('./estoque.js');
const X = require('./xlsx.js');

// ---------- planilha .xlsx mínima (ZIP sem compressão) ----------
function zip(arquivos) {
  const partes = [], central = [];
  let off = 0;
  for (const [nome, txt] of Object.entries(arquivos)) {
    const n = Buffer.from(nome), d = Buffer.from(txt);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(0, 8); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0, 10); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    partes.push(h, n, d); central.push(c, n); off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(Object.keys(arquivos).length, 8); fim.writeUInt16LE(Object.keys(arquivos).length, 10);
  fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(off, 16);
  return Buffer.concat([...partes, cd, fim]);
}
const col = (i) => String.fromCharCode(65 + i);
const aba = (linhas) => `<worksheet><sheetData>${linhas.map((l, r) => `<row r="${r + 1}">${l.map((v, c) => v == null ? '' : typeof v === 'number'
  ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
const serial = (dia) => Date.parse(dia + 'T00:00:00Z') / 864e5 + 25569;
const topo = [['TÍTULO'], ['x'], ['x'], ['x']];
function planilha() {
  const abas = {
    'Cadastro Produtos': [...topo, ['Base', 'SKU', 'Custo', 'Produto', 'Seg', 'Classe', 'Situação', 'Ref', 'Fornecedor', 'Prazo'],
      [407, 'DQ-407', 30, 'Ducha 407', 0, 'Ducha', 'Ativo', 'R-407', 'BRUNO', 12],
      [408, 'BP-408', 5, 'Braço 408', 0, 'Braço', 'Ativo', null, 'Aladdin', 12],
      [9, 'TC-009', 100, 'Torneira velha', 0, 'Torneira', 'Descontinuado', null, 'MAXFORTE', 6]],
    Fornecedores: [...topo, ['Fornecedor', 'Rep', 'Tel', 'End', 'Prazo'], ['BRUNO', 'Bruno', null, null, 12], ['Aladdin', null, null, null, 12], ['MAXFORTE', null, null, null, 6]],
    'Movimentações': [...topo, ['Data', 'Tipo', 'Base', 'SKU', 'Qtd', 'Valor', 'Canal', 'Total'],
      [serial('2026-01-01'), 'Entrada', 407, 'DQ-407', 0, 30, 'BRUNO', 0],
      [serial('2026-06-01'), 'Entrada', 407, 'DQ-407', 100, 30, 'BRUNO', 3000],
      [serial('2026-06-10'), 'Entrada', 407, 'DQ-407', 100, 36, 'BRUNO', 3600],
      [serial('2026-08-01'), 'Saída', 407, 'DQ-407', 60, 30, 'Mercado Livre', 1800],
      [serial('2026-10-02'), 'Saida', 407, 'DQ-407', 6, 30, 'Josi', 180],
      [serial('2026-09-03'), 'Entrada', 408, 'BP-408', 9, 5, 'Contagem de Estoque', 45],
      [serial('2026-11-09'), 'Saída', 408, 'BP-408', 1, 5, 'Shopee', 5]],
    Compras: [...topo, ['ID', 'Data', 'Base', 'Qtd', 'SKU', 'Prod', 'Ref', 'Forn', 'Prazo', 'Prev', 'Status'],
      ['KIT-023', serial('2026-04-14'), 407, 50, 'DQ-407', 'x', 'x', 'BRUNO', 12, serial('2027-04-14'), 'Em aberto'],
      ['KIT-022', serial('2026-03-01'), 408, 20, 'BP-408', 'x', 'x', 'Aladdin', 12, serial('2027-03-01'), 'Recebido']],
    Recebimentos: [...topo, ['ID', 'Data', 'Base', 'SKU', 'Prod', 'Forn', 'Ped', 'Rec', 'Valor', 'Conf', 'Total', 'Obs'],
      ['KIT-023', serial('2027-04-14'), 407, 'DQ-407', 'x', 'BRUNO', 50, null, null, null, 0, null],
      ['KIT-022', serial('2026-05-01'), 408, 'BP-408', 'x', 'Aladdin', 20, 20, 4.5, 'Sim', 90, null]],
  };
  const nomes = Object.keys(abas);
  return zip({
    'xl/workbook.xml': `<workbook><sheets>${nomes.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${nomes.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    ...Object.fromEntries(nomes.map((n, i) => [`xl/worksheets/sheet${i + 1}.xml`, aba(abas[n])])),
  });
}

// ---------- leitor e importação ----------
const p = X.lerXlsx(planilha());
assert.deepStrictEqual(p.abas.slice(0, 2), ['Cadastro Produtos', 'Fornecedores']);
assert.strictEqual(X.dataDoExcel(serial('2026-06-10')), '2026-06-10');
const imp = E.importacaoDe(p, '2026-10-07');
assert.strictEqual(imp.produtos.length, 3);
assert.strictEqual(imp.produtos[0].fornecedor, 'BRUNO');
assert.strictEqual(imp.movimentos.length, 6, 'linha com quantidade 0 (saldo inicial vazio) fica de fora');
assert.deepStrictEqual(imp.avisos, { saida_sem_acento: 1, saida_sem_acento_qtd: 6, datas_futuras: 1, sem_produto: 0 });
assert.strictEqual(imp.movimentos.find((m) => m.origem === 'Josi').qtd, -6, '"Saida" sem acento também é saída');
assert.strictEqual(imp.movimentos.find((m) => m.origem === 'Josi').tipo, 'saida');
assert.strictEqual(imp.movimentos.find((m) => m.origem === 'Mercado Livre').tipo, 'venda');
assert.strictEqual(imp.movimentos.find((m) => m.origem === 'Contagem de Estoque').tipo, 'ajuste');
assert.deepStrictEqual(imp.compras.map((c) => c.status), ['aberto', 'recebido']);
assert.strictEqual(imp.compras[1].valor_pago, 4.5);

// ---------- reposição (as fórmulas da planilha: GA-756 em 07/10/2026) ----------
assert.deepStrictEqual(E.reposicao({ ativo: true, saldo: 1096, saidas6m: 1136, prazo: 12 }),
  { media: 189.33, minimo: 2272, maximo: 4544, sugestao: 1176, status: 'Repor agora', dias: 174 });
assert.strictEqual(E.reposicao({ ativo: true, saldo: 5000, saidas6m: 1136, prazo: 12 }).status, 'Próximo de repor');
assert.strictEqual(E.reposicao({ ativo: true, saldo: 6000, saidas6m: 1136, prazo: 12 }).status, 'Regular');
assert.strictEqual(E.reposicao({ ativo: true, saldo: 1096, saidas6m: 1136, prazo: 12, abertos: 1000 }).sugestao, 176, 'pedido em aberto abate a sugestão');
assert.deepStrictEqual(E.reposicao({ ativo: false, saldo: 3, saidas6m: 60, prazo: 6 }).sugestao, 0);
assert.deepStrictEqual([E.reposicao({ ativo: true, saldo: 0, saidas6m: 60, prazo: 6, repor: false })].map((x) => [x.status, x.sugestao]), [['Não repor', 0]],
  'fornecedor descontinuado: não repor');
assert.strictEqual(E.reposicao({ ativo: true, saldo: 3, saidas6m: 60, prazo: 6, repor: false }).status, 'Vender o restante', 'não repor com estoque: vender o restante');
assert.strictEqual(E.reposicao({ ativo: false, saldo: 3, saidas6m: 60, prazo: 6 }).status, 'Vender o restante', 'descontinuado com estoque: vender o restante');
assert.strictEqual(E.reposicao({ ativo: false, saldo: 0, saidas6m: 60, prazo: 6 }).status, 'Descontinuado');

// ---------- código digitado e baixa automática ----------
const porSku = new Map([['DQ-407', 407], ['BP-408', 408]]); porSku.numeros = new Set([407, 408]);
assert.deepStrictEqual(E.numerosDoCodigo('dq-407', porSku), [407]);
assert.deepStrictEqual(E.numerosDoCodigo('KIT-407.408', porSku), [407, 408]);
assert.deepStrictEqual(E.numerosDoCodigo('408', porSku), [408]);
const venda = (ref, sku, qtd, valida = true) => ({ ref, sku, qtd, valida, origem: 'Mercado Livre · LOJA', data: '2026-10-08T15:00:00.000Z' });
// o exemplo do vendedor: KIT-407.408 tira 1 DQ-407 e 1 BP-408 (x quantidade)
let d = E.diferencas([venda('venda:ml:1:A:0', 'KIT-407.408', 2)], new Map(), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd, m.tipo]), [[407, -2, 'venda'], [408, -2, 'venda']]);
// rodar de novo com o que já lançou: nada
d = E.diferencas([venda('venda:ml:1:A:0', 'KIT-407.408', 2)], new Map([['venda:ml:1:A:0|407', -2], ['venda:ml:1:A:0|408', -2]]), porSku);
assert.strictEqual(d.lancar.length, 0, 'não duplica');
// cancelou: volta
d = E.diferencas([venda('venda:ml:1:A:0', 'KIT-407.408', 2, false)], new Map([['venda:ml:1:A:0|407', -2], ['venda:ml:1:A:0|408', -2]]), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd, m.tipo]), [[407, 2, 'cancelamento'], [408, 2, 'cancelamento']]);
// kit com o mesmo produto 2x
d = E.diferencas([venda('venda:ml:2:B:0', 'KIT-407.407', 3)], new Map(), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd]), [[407, -6]]);
// SKU que não existe: pendente, nada sai
d = E.diferencas([venda('venda:ml:3:C:0', 'KIT-999', 1), venda('venda:ml:4:D:0', '', 1)], new Map(), porSku);
assert.strictEqual(d.lancar.length, 0);
assert.strictEqual(d.pendentes.length, 2);

// devolução: entra (+) só o que voltou sem defeito; no kit, a peça com defeito fica de fora
const dev = (sem, extra = {}) => ({ ref: 'devolucao:ml:9', sku: 'KIT-407.408', qtd: 1, valida: true, sinal: 1, sem, tipo: 'devolucao', origem: 'ML', data: 'x', ...extra });
d = E.diferencas([dev(null)], new Map(), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd, m.tipo]), [[407, 1, 'devolucao'], [408, 1, 'devolucao']], 'sem defeito: o kit todo volta');
d = E.diferencas([dev([1])], new Map(), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd]), [[407, 1]], 'BP-408 com defeito: só a DQ-407 volta');
d = E.diferencas([dev([0, 1])], new Map(), porSku);
assert.strictEqual(d.lancar.length, 0, 'tudo com defeito: nada volta');
d = E.diferencas([dev(null, { pendente: 'defeito' })], new Map(), porSku);
assert.deepStrictEqual([d.lancar.length, d.pendentes[0].motivo], [0, 'defeito'], 'ninguém conferiu: pendente');
d = E.diferencas([dev([1])], new Map([['devolucao:ml:9|407', 1], ['devolucao:ml:9|408', 1]]), porSku);
assert.deepStrictEqual(d.lancar.map((m) => [m.numero, m.qtd]), [[408, -1]], 'marcou o defeito depois: tira a peça que tinha entrado');

// ---------- relatório ----------
const movs = [
  { data: '2026-10-05T15:00:00.000Z', tipo: 'venda', origem: 'Mercado Livre · LOJA', numero: 407, qtd: -2, valor_unit: 30 },
  { data: '2026-10-06T15:00:00.000Z', tipo: 'venda', origem: 'Mercado Livre · LOJA B', numero: 407, qtd: -1, valor_unit: 30 },
  { data: '2026-10-07T02:00:00.000Z', tipo: 'cancelamento', origem: 'Mercado Livre · LOJA', numero: 407, qtd: 1, valor_unit: 30 },   // 06/10 em Brasília
  { data: '2026-10-08T15:00:00.000Z', tipo: 'entrada', origem: 'BRUNO', numero: 407, qtd: 10, valor_unit: 31 },
  { data: '2026-10-08T15:00:00.000Z', tipo: 'ajuste', origem: 'Contagem de estoque', numero: 408, qtd: -3, valor_unit: 5 },
];
assert.strictEqual(E.periodoDe('2026-10-08', 'semana'), '2026-10-05', 'semana começa na segunda');
assert.strictEqual(E.periodoDe('2026-10-05', 'semana'), '2026-10-05');
let rel = E.relatorio(movs, { periodo: 'mes', por: 'total' });
assert.deepStrictEqual(rel, [{ periodo: '2026-10', grupo: 'Total', entradas: 10, saidas: 2, ajustes: -3, valor_entradas: 310, valor_saidas: 60 }]);
rel = E.relatorio(movs, { periodo: 'dia', por: 'canal' });
assert.deepStrictEqual(rel.filter((l) => l.grupo === 'Mercado Livre').map((l) => [l.periodo, l.saidas]), [['2026-10-06', 0], ['2026-10-05', 2]]);
rel = E.relatorio(movs, { periodo: 'ano', por: 'loja' });
assert.deepStrictEqual(rel.find((l) => l.grupo === 'Mercado Livre · LOJA').saidas, 1);

// ---------- servidor de verdade ----------
const S = require('./server.js');
const D = require('./db.js');
const SEG = require('./seguranca.js');
function pedir(porta, caminho, { metodo = 'GET', headers = {}, corpo = null } = {}) {
  return new Promise((ok, falha) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: { Host: `localhost:${porta}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, corpo: b, json: () => JSON.parse(b) }));
    });
    req.on('error', falha); if (corpo) req.write(corpo); req.end();
  });
}
(async () => {
  const srv = await S.iniciar({ porta: 0, portaPublica: 0, servicos: { tunel: () => null, scraper: () => null } });
  const P = srv.porta;
  try {
    D.senhaDefinir('Senha-do-dono-2026!');
    D.configGravar('painel_2fa_segredo', SEG.novoSegredo());
    const ADM = { Cookie: `aula_ml_sess=${D.sessaoCriar()}`, 'Content-Type': 'application/json', Origin: `http://localhost:${P}` };
    const api = async (m, u, b, h = ADM) => { const r = await pedir(P, u, { metodo: m, headers: h, corpo: b == null ? null : JSON.stringify(b) }); return { status: r.status, j: r.corpo ? JSON.parse(r.corpo) : null }; };

    // importar
    let r = await pedir(P, '/api/estoque/importar', { metodo: 'POST', headers: { ...ADM, 'Content-Type': 'application/octet-stream' }, corpo: planilha() });
    assert.strictEqual(r.status, 200, r.corpo);
    assert.strictEqual(r.json().movimentos, 6);
    r = await pedir(P, '/api/estoque/importar', { metodo: 'POST', headers: { ...ADM, 'Content-Type': 'application/octet-stream' }, corpo: planilha() });
    assert.strictEqual(D.estoqueMovListar({ historico: true, limite: 100 }).length, 6, 'importar de novo não duplica');
    assert.strictEqual(D.comprasListar().length, 2);

    // antes da contagem: saldo zero, baixa desligada
    let v = (await api('GET', '/api/estoque')).j;
    assert.strictEqual(v.inicio, null);
    const p407 = () => v.produtos.find((x) => x.numero === 407);
    assert.strictEqual(p407().saldo, 0);
    assert.strictEqual(p407().custo_medio, 33, 'custo médio das entradas (100 a 30 + 100 a 36)');
    assert.strictEqual(p407().em_pedido, 50);
    assert.strictEqual(p407().fornecedor, 'BRUNO');

    // contagem: referência da planilha, rascunho e finalizar (liga a baixa)
    let c = (await api('GET', '/api/estoque/contagem')).j;
    assert.strictEqual(c.produtos.find((x) => x.numero === 407).planilha, 134, '200 − 60 − 6');
    await api('PUT', '/api/estoque/contagem', { numero: 407, contado: 130 });
    await api('PUT', '/api/estoque/contagem', { numero: 408, contado: 9 });
    r = await api('POST', '/api/estoque/contagem/finalizar', {});
    assert.strictEqual(r.j.produtos, 2);
    assert.ok(r.j.baixa_ligada_em);
    assert.strictEqual(D.contagemListar().length, 0);

    // venda do ML depois da contagem: KIT-407.408 x2 -> 407: 128, 408: 7. Full não baixa. Cancelada volta.
    D.contaSalvar({ access_token: 'a', refresh_token: 'b', expires_in: 21600 }, { id: 111, nickname: 'LOJA_A', site_id: 'MLB' });
    const depois = new Date(Date.now() + 1000).toISOString();
    D.vendasGravar([
      { order_id: 1, item_id: 'MLB1', variacao: 0, ml_user_id: 111, data: depois, status: 'paid', quantidade: 2, preco_unit: 100, tarifa_unit: 10, envio_id: 1, sku: 'KIT-407.408', origem: 'BRP123', comprador_id: 1, comprador: 'x' },
      { order_id: 2, item_id: 'MLB1', variacao: 0, ml_user_id: 111, data: depois, status: 'paid', quantidade: 5, preco_unit: 100, tarifa_unit: 10, envio_id: 2, sku: 'KIT-407.408', origem: 'BRSP04', comprador_id: 1, comprador: 'x' },
    ]);
    await new Promise((ok) => setTimeout(ok, 1100));
    const saldoDe = (n) => D.estoqueSaldos().get(n) || 0;
    // a baixa roda ao abrir a tela (sincronizar a conta falha sem internet de verdade: fica nos erros)
    v = (await api('GET', '/api/estoque?recarregar=1')).j;
    assert.strictEqual(saldoDe(407), 128, 'kit tirou 2 DQ-407');
    assert.strictEqual(saldoDe(408), 7, 'e 2 BP-408; a venda do Full não mexeu');
    v = (await api('GET', '/api/estoque?recarregar=1')).j;
    assert.strictEqual(saldoDe(407), 128, 'abrir de novo não duplica');
    D.vendasGravar([{ order_id: 1, item_id: 'MLB1', variacao: 0, ml_user_id: 111, data: depois, status: 'cancelled', quantidade: 2, preco_unit: 100, tarifa_unit: 10, envio_id: 1, sku: 'KIT-407.408', origem: 'BRP123', comprador_id: 1, comprador: 'x' }]);
    await api('GET', '/api/estoque?recarregar=1');
    assert.strictEqual(saldoDe(407), 130, 'cancelada voltou');

    // devoluções do ML: chegou sem defeito volta; com defeito não; Full não; sem conferência = pendente
    const devol = (claim, order, defeito, produtos) => {
      D.devolucaoGravar({ claim_id: claim, ml_user_id: 111, order_id: order, item_id: 'MLB1', quantidade: 1, criada_em: new Date().toISOString(),
        atualizada_em: new Date().toISOString(), status_devolucao: 'delivered' });
      if (defeito != null) D.defeitoGravar(claim, defeito, produtos);
    };
    D.vendasGravar([{ order_id: 3, item_id: 'MLB1', variacao: 0, ml_user_id: 111, data: depois, status: 'paid', quantidade: 1, preco_unit: 100, tarifa_unit: 10, envio_id: 3, sku: 'KIT-407.408', origem: 'BRP123', comprador_id: 1, comprador: 'x' }]);
    await api('GET', '/api/estoque?recarregar=1');
    assert.deepStrictEqual([saldoDe(407), saldoDe(408)], [129, 8], 'venda 3 saiu');
    devol(901, 3, false);          // voltou boa
    devol(902, 3, true, [1]);      // BP-408 com defeito
    devol(903, 3, true);           // tudo com defeito
    devol(904, 2, false);          // venda do Full: volta ao armazém do ML
    devol(905, 3, null);           // ninguém conferiu
    v = (await api('GET', '/api/estoque?recarregar=1')).j;
    assert.deepStrictEqual([saldoDe(407), saldoDe(408)], [131, 9], '901 devolveu 407+408, 902 só a 407; 903, 904 e 905 nada');
    assert.ok(v.pendentes.some((p) => p.ref === 'devolucao:ml:905' && p.motivo === 'defeito'), 'a não conferida aparece como pendente');
    D.defeitoGravar(905, false);
    await api('GET', '/api/estoque?recarregar=1');
    assert.deepStrictEqual([saldoDe(407), saldoDe(408)], [132, 10], 'conferiu sem defeito: entrou');
    // volta ao ponto do resto do teste (130 / 9)
    r = await api('POST', '/api/estoque/lancar', { tipo: 'saida', origem: 'Acerto do teste', itens: [{ codigo: 'DQ-407', qtd: 2 }, { codigo: 'BP-408', qtd: 1 }] });
    assert.deepStrictEqual([saldoDe(407), saldoDe(408)], [130, 9]);

    // lançamento manual: entrada de fornecedor e saída (envio ao Full), e desfazer
    r = await api('POST', '/api/estoque/lancar', { tipo: 'entrada', origem: 'BRUNO', itens: [{ codigo: 'DQ-407', qtd: 20, valor_unit: 40 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    assert.strictEqual(saldoDe(407), 150);
    r = await api('POST', '/api/estoque/lancar', { tipo: 'saida', origem: 'Envio Full Mercado Livre', itens: [{ codigo: 'KIT-407.408', qtd: 3 }] });
    assert.strictEqual(saldoDe(407), 147); assert.strictEqual(saldoDe(408), 6, '9 (cancelada voltou) − 3');
    r = await api('POST', '/api/estoque/lancar', { tipo: 'saida', origem: 'Josi', itens: [{ codigo: 'XX-999', qtd: 1 }] });
    assert.strictEqual(r.status, 400, 'produto que não existe é recusado');
    const ultima = D.estoqueMovListar({ tipo: 'saida', limite: 1 })[0];
    await api('POST', '/api/estoque/desfazer', { id: ultima.id });
    assert.strictEqual(saldoDe(407), 150, 'desfazer volta o saldo do lançamento inteiro (kit = 2 produtos)');
    assert.strictEqual(saldoDe(408), 9);
    r = await api('POST', '/api/estoque/desfazer', { id: D.estoqueMovListar({ tipo: 'venda', limite: 1 })[0].id });
    assert.strictEqual(r.status, 400, 'venda automática não se desfaz à mão');

    // compras: pedido novo com número seguinte, recebimento vira entrada
    let cp = (await api('GET', '/api/estoque/compras')).j;
    assert.strictEqual(cp.proximo, 'KIT-024');
    r = await api('POST', '/api/estoque/compras', { fornecedor: 'BRUNO', itens: [{ codigo: 'DQ-407', qtd: 40 }] });
    assert.strictEqual(r.j.pedido, 'KIT-024');
    cp = (await api('GET', '/api/estoque/compras')).j;
    const item = cp.compras.find((x) => x.pedido === 'KIT-024');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(item.previsao) && item.previsao > item.data, 'previsão pelo prazo do fornecedor');
    await api('POST', '/api/estoque/compras/receber', { id: item.id, qtd: 15, valor_unit: 42 });
    assert.strictEqual(D.compraObter(item.id).status, 'parcial');
    assert.strictEqual(saldoDe(407), 165);
    await api('POST', '/api/estoque/compras/receber', { id: item.id, qtd: 25 });
    assert.strictEqual(D.compraObter(item.id).status, 'recebido');

    // comanda manual: tira do estoque; cancelar devolve
    r = await api('POST', '/api/comandas/manual', { cliente: 'Cliente Balcão', loja: 'Josi', itens: [{ codigo: 'KIT-407.408', qtd: 1 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    assert.strictEqual(saldoDe(407), 189);
    const lista = (await api('GET', '/api/comandas')).j;
    const cm = lista.comandas.find((x) => x.chave === r.j.chave);
    assert.strictEqual(cm.categoria, 'Venda direta');
    assert.strictEqual(cm.numero, 1);
    assert.strictEqual(cm.itens[0].titulo, 'Ducha 407 + Braço 408');
    // histórico: pela data da impressão e pelo número da venda
    await api('POST', '/api/comandas/impressas', { chaves: [r.j.chave], impressa: true });
    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    let h = (await api('GET', '/api/comandas/historico?de=' + hoje)).j;
    assert.ok(h.comandas.some((x) => x.chave === r.j.chave && x.pendente), 'impressa hoje aparece, ainda na fila');
    h = (await api('GET', '/api/comandas/historico?de=2020-01-01&ate=2020-01-02')).j;
    assert.strictEqual(h.comandas.length, 0);
    h = (await api('GET', '/api/comandas/historico?pedido=' + encodeURIComponent(cm.pedido))).j;
    assert.ok(h.comandas.some((x) => x.chave === r.j.chave), 'acha pelo número da venda');
    assert.strictEqual((await api('GET', '/api/comandas/historico?pedido=%27%20OR%201%3D1')).status, 400);
    await api('POST', '/api/comandas/manual/cancelar', { chave: r.j.chave });
    assert.strictEqual(saldoDe(407), 190, 'cancelar a venda direta devolve ao estoque');
    assert.ok(!(await api('GET', '/api/comandas')).j.comandas.some((x) => x.chave === r.j.chave));

    // relatório pela rota: por loja, com o histórico da planilha
    rel = (await api('GET', '/api/estoque/relatorio?de=2026-01-01&ate=2027-12-31&periodo=ano&por=canal')).j;
    assert.ok(rel.linhas.some((l) => l.grupo === 'Mercado Livre'));
    assert.ok(rel.lojas.includes('Mercado Livre · LOJA_A'));

    // permissões: usuário do módulo estoque lança, mas não importa
    const sen = U_SENHA();
    const id = D.usuarioCriar({ login: 'estoquista', nome: 'E', modulos: ['estoque'] }, sen);
    D.usuarioSenhaDefinir(id, sen); D.usuarioMfaGravar(id, { segredo: SEG.novoSegredo() });
    const US = { Cookie: `aula_ml_sess=${D.sessaoCriar(undefined, id)}`, 'Content-Type': 'application/json', Origin: `http://localhost:${P}` };
    assert.strictEqual((await api('GET', '/api/estoque', null, US)).status, 200);
    assert.strictEqual((await api('POST', '/api/estoque/lancar', { tipo: 'entrada', origem: 'BRUNO', itens: [{ codigo: '408', qtd: 1 }] }, US)).status, 200);
    r = await pedir(P, '/api/estoque/importar', { metodo: 'POST', headers: { ...US, 'Content-Type': 'application/octet-stream' }, corpo: planilha() });
    assert.strictEqual(r.status, 403, 'importar é só do administrador');
    assert.ok(D.estoqueMovListar({ limite: 5 }).some((m) => m.quem === 'estoquista'), 'quem lançou fica no movimento');

    const mcp = fs.readFileSync(path.join(__dirname, 'mcp.js'), 'utf8');
    assert.ok(!/\/api\/estoque/.test(mcp), 'estoque fora do MCP');
    console.log('Estoque: planilha, reposição, baixa automática (kit, Full, cancelamento, sem duplicar), contagem, compras, comanda manual, relatórios e permissões: ok');
  } finally {
    await srv.fechar();
    D.db.close();
    for (const f of [process.env.ML_DB_FILE, process.env.ML_DB_FILE + '-wal', process.env.ML_DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  }
})().catch((e) => { console.error(e); process.exit(1); });
function U_SENHA() { return require('./usuarios.js').senhaTemporaria(); }
