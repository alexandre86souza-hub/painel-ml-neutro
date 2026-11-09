'use strict';
// Bling (bling.js): funções puras da conexão e o compromisso de nada do Bling no MCP.
const assert = require('assert');
const fs = require('fs');
const B = require('./bling.js');

// credenciais
assert.throws(() => B.validarConfig({ client_id: 'x' }), /Client ID/);
const c = B.validarConfig({ client_id: ' a1b2c3d4e5f6a7b8c9d0 ', nome: ' AMG ', lojas: 'Shopee AMG' });
assert.deepStrictEqual(c, { client_id: 'a1b2c3d4e5f6a7b8c9d0', nome: 'AMG', lojas: 'Shopee AMG' }, 'segredo vazio = mantém o gravado');
assert.throws(() => B.validarConfig({ client_id: 'a1b2c3d4e5f6a7b8c9d0', client_secret: 'com espaço no meio' }), /Client Secret/);
assert.strictEqual(B.validarConfig({ client_id: 'a1b2c3d4e5f6a7b8c9d0', client_secret: 'f'.repeat(60) }).client_secret, 'f'.repeat(60));

// conta
assert.strictEqual(B.contaValida(2), '2');
assert.throws(() => B.contaValida('3'), /inválida/);

// autorização
const u = new URL(B.urlAutorizacao({ clientId: 'abc123', state: 'xyz' }));
assert.strictEqual(u.origin + u.pathname, 'https://www.bling.com.br/Api/v3/oauth/authorize');
assert.strictEqual(u.searchParams.get('response_type'), 'code');
assert.strictEqual(u.searchParams.get('client_id'), 'abc123');
assert.strictEqual(u.searchParams.get('state'), 'xyz');

// itens: só o que é do produto
const it = B.itensDoProduto([{ codigo: 'AMg-769.790', descricao: 'Ducha', classificacaoFiscal: '8481.80.19', unidade: 'UN', quantidade: 1, valor: 10, produto: { id: 0 }, contato: { nome: 'x' } },
  { codigo: '', descricao: 'Chuveirinho', quantidade: 2, produto: { id: 55 } }]);
assert.deepStrictEqual(it[0], { codigo: 'AMg-769.790', descricao: 'Ducha', ncm: '8481.80.19', unidade: 'UN', quantidade: 1, produto_vinculado: false });
assert.strictEqual(it[1].produto_vinculado, true);
assert.ok(!('contato' in it[0]) && !('valor' in it[0]));

// correção da nota pendente
assert.strictEqual(B.ncmValido('84818019'), '8481.80.19');
assert.throws(() => B.ncmValido('8481.80'), /NCM/);
assert.strictEqual(B.descricaoValida('  Ducha   Inox  '), 'Ducha Inox');
assert.throws(() => B.descricaoValida('x'.repeat(121)), /120/);
assert.strictEqual(B.origemDoProduto('1', false), 1, 'AMG importa direto');
assert.strictEqual(B.origemDoProduto('2', false), 2, 'Primor compra o importado no Brasil');
assert.strictEqual(B.origemDoProduto('2', true), 0);
assert.ok(B.nacionalPeloNome('Bucha de Fixação 8mm') && B.nacionalPeloNome('Desempenadeira de aço') && !B.nacionalPeloNome('Ducha Inox'));
const sg = B.sugestaoDe({ descricao: 'Ducha GW Comercial', classificacaoFiscal: '' }, null);
assert.deepStrictEqual(sg, { descricao: 'Ducha GW Comercial', ncm: '8481.80.19', cest: '10.079.00', nacional: false, salvo: false });
const dz = B.sugestaoDe({ descricao: 'Desempenadeira Plástica Lisa 18x30' }, null);
assert.deepStrictEqual([dz.ncm, dz.cest, dz.nacional], ['3926.90.90', '10.020.00', true], 'desempenadeira: NCM, CEST e nacional');
const bz = B.sugestaoDe({ descricao: 'Bucha de Nylon 8mm com Parafuso' }, null);
assert.deepStrictEqual([bz.ncm, bz.cest, bz.nacional], ['3925.90.90', '10.020.00', true], 'bucha: NCM, CEST e nacional');
assert.strictEqual(B.cestValido('1007900'), '10.079.00');
assert.strictEqual(B.cestValido(''), '');
assert.throws(() => B.cestValido('123'), /CEST/);
assert.deepStrictEqual(B.sugestaoDe({}, { descricao: 'Ducha', ncm: '8481.90.10', nacional: false }), { descricao: 'Ducha', ncm: '8481.90.10', cest: '', nacional: false, salvo: true });
const nota = { id: 9, numero: '1', contato: { nome: 'x' }, itens: [
  { codigo: 'AMG-1', descricao: 'Longo', classificacaoFiscal: '', origem: 0, valor: 10, cfop: '6108', impostos: { icms: { st: 102, origem: 0 } } },
  { codigo: 'AMG-2', descricao: 'Outro', valor: 5 }] };
const cp = B.corpoCorrigido(nota, '2', [{ i: 0, descricao: 'Curto', ncm: '8481.80.19', cest: '10.079.00', nacional: false }]);
assert.ok(!('id' in cp) && cp.contato.nome === 'x' && cp.numero === '1', 'a nota vai inteira, sem o id');
assert.deepStrictEqual(cp.itens[0], { codigo: 'CFOP6108', descricao: 'Curto', classificacaoFiscal: '8481.80.19', cest: '10.079.00', origem: 2, valor: 10, cfop: '6108', impostos: { icms: { st: 102, origem: 2 } } });
assert.deepStrictEqual(cp.itens[1], nota.itens[1], 'item não mudado vai como veio');
assert.strictEqual(nota.itens[0].codigo, 'AMG-1', 'não mexe na nota lida');
// frete do GET (valorFrete) volta em transporte.frete, que é o que o Bling grava; desconto conta o frete
const comFrete = B.corpoCorrigido({ valorNota: 509.7, valorFrete: 8, transporte: { fretePorConta: 0 }, itens: [{ cfop: '5405', valor: 137.58, valorTotal: 550.32, quantidade: 4 }] }, '1', []);
assert.strictEqual(comFrete.transporte.frete, 8);
assert.strictEqual(comFrete.transporte.fretePorConta, 0);
assert.strictEqual(comFrete.desconto, 48.62);
// desconto que o GET não traz volta pela diferença entre itens + frete e o valor da nota
const comCupom = B.corpoCorrigido({ valorNota: 26.8, valorFrete: 0, itens: [{ codigo: 'AMG-750.831', cfop: '5405', valor: 28.81, quantidade: 1 }] }, '1',
  [{ i: 0, descricao: 'Ducha', ncm: '8481.80.19', cest: '10.079.00', nacional: false }]);
assert.strictEqual(comCupom.desconto, 2.01);
assert.ok(!('desconto' in B.corpoCorrigido({ valorNota: 10, itens: [{ cfop: '5102', valor: 10, quantidade: 1 }] }, '2', [])), 'sem diferença, sem desconto');

assert.ok(B.itemAjustado([{ codigo: 'CFOP5405', ncm: '8481.80.19', cest: '1007900', origem: 2, sugestao: { origem: 2, cest: '10.079.00' } }]), 'CEST com ou sem pontos');
assert.ok(B.semCodigo('CFOP5405') && B.semCodigo('') && !B.semCodigo('AMG-1'));
assert.throws(() => B.codigoNeutro({ descricao: 'x' }), /CFOP/);
assert.ok(B.itemAjustado([{ codigo: 'CFOP6108', ncm: '8481.80.19', origem: 2, sugestao: { origem: 2 } }]));
assert.ok(B.itemAjustado([{ codigo: '', ncm: '8481.80.19', origem: 2, sugestao: { origem: 2 } }]));
assert.ok(!B.itemAjustado([{ codigo: 'AMG-1', ncm: '8481.80.19', origem: 2, sugestao: { origem: 2 } }]), 'código ainda no item');
assert.ok(!B.itemAjustado([{ codigo: '', ncm: '', origem: 2, sugestao: { origem: 2 } }]), 'sem NCM');
assert.ok(!B.itemAjustado([{ codigo: '', ncm: '8481.80.19', origem: 0, sugestao: { origem: 2 } }]), 'origem diferente');

// nota da Shopee vai à loja pelo painel (o Bling não tem envio automático para a Shopee)
assert.ok(B.ehShopee('Shopee AMG', null));
assert.ok(!B.ehShopee('Leroy Merlin', '251106ABC123XY'));
assert.ok(B.ehShopee(null, '251106ABC123XY'));
assert.ok(!B.ehShopee(null, '702-1234567-1234567'));
assert.ok(B.ehAmazon(null, '702-1234567-1234567'));
assert.ok(B.ehAmazon('Amazon Marketplace', null));
assert.ok(!B.ehAmazon(null, '251106ABC123XY'));
assert.deepStrictEqual(B.SHOPEE_DA_CONTA, { 1: '445620092', 2: '717079477' });

// DANFE simplificada: campos do XML autorizado (chave, protocolo, emitente, destinatário sem endereço, itens)
{
  const xml = '<nfeProc><NFe><infNFe Id="NFe35261124330502000149550010000131861493504858"><ide><serie>1</serie><nNF>13186</nNF><dhEmi>2026-11-09T10:52:36-03:00</dhEmi><tpNF>1</tpNF></ide>'
    + '<emit><CNPJ>24330502000149</CNPJ><xNome>Loja &amp; Cia</xNome><enderEmit><UF>SP</UF></enderEmit><IE>123</IE></emit><dest><CPF>11122233344</CPF><xNome>Fulano</xNome><enderDest><xLgr>Rua X</xLgr><UF>PA</UF></enderDest></dest>'
    + '<det nItem="1"><prod><xProd>Ducha</xProd><qCom>2.0000</qCom><uCom>UN</uCom></prod></det><total><ICMSTot><vProd>197.12</vProd><vNF>197.12</vNF></ICMSTot></total></infNFe></NFe>'
    + '<protNFe><infProt><chNFe>35261124330502000149550010000131861493504858</chNFe><dhRecbto>2026-11-09T10:52:40-03:00</dhRecbto><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>';
  const d = B.danfeDoXml(xml);
  assert.strictEqual(d.chave.length, 44);
  assert.strictEqual(d.protocolo, '135260000000001');
  assert.strictEqual(d.emitente.nome, 'Loja & Cia');
  assert.strictEqual(d.destinatario.uf, 'PA');
  assert.strictEqual(d.destinatario.endereco.logradouro, 'Rua X', 'endereço do consumidor, como na etiqueta do Bling');
  assert.strictEqual(d.acrescimos, 0);
  assert.strictEqual(d.itens[0].descricao, 'Ducha'); assert.strictEqual(d.itens[0].quantidade, 2);
  assert.throws(() => B.danfeDoXml(xml.replace(/<nProt>[^<]*<\/nProt>/, '')), /protocolo/);
  const C = require('./public/codigo128.js');
  assert.strictEqual(C.largurasC('35261124330502000149550010000131861493504858').length, 151, 'chave em 22 pares + início, verificador e parada');
  assert.strictEqual(C.largurasC('123'), null, 'conjunto C só com número par de dígitos');
}

// nota fiscal tem dado do comprador: nada do Bling no MCP
assert.ok(!/\/api\/bling/.test(fs.readFileSync('./mcp.js', 'utf8')), 'mcp.js não pode apontar para /api/bling');

// Notas do ML pelo Faturador (ml-notas.js)
{
  const { situacaoNota, pedidosDoEnvio } = require('./ml-notas.js');
  const a = situacaoNota({ id: 9, status: 'authorized', invoice_number: 123, invoice_series: '1', attributes: { invoice_key: 'K' } });
  assert.strictEqual(a.situacao, 'autorizada'); assert.strictEqual(a.numero, 123); assert.strictEqual(a.chave, 'K');
  const r = situacaoNota({ status: 'rejected', errors: [{ code: '01', description: 'NCM inválido' }] });
  assert.strictEqual(r.situacao, 'rejeitada'); assert.strictEqual(r.motivo, 'NCM inválido');
  assert.strictEqual(situacaoNota({ status: 'pending' }).situacao, 'processando');
  assert.strictEqual(situacaoNota({}).situacao, 'processando');
  // pacote: todas as vendas numa nota só, sem repetir; sem lista, o pedido
  assert.deepStrictEqual(pedidosDoEnvio({ pedidos: ['2000001234567', '2000001234568', '2000001234567'] }), [2000001234567, 2000001234568]);
  assert.deepStrictEqual(pedidosDoEnvio({ pedido: '2000001234567' }), [2000001234567]);
  assert.deepStrictEqual(pedidosDoEnvio({ pedido: 'abc' }), []);
  assert.ok(!/\/api\/ml-notas/.test(fs.readFileSync('./mcp.js', 'utf8')), 'mcp.js não pode apontar para /api/ml-notas');
}

// Nota de devolução pelo Bling (devolucao-nf.js)
{
  const { vendaDoXml, escolhidosValidos, corpoDevolucao } = require('./devolucao-nf.js');
  const ch = '35251112345678000199550010000716521000000017';
  const xml = `<nfeProc><NFe><infNFe Id="NFe${ch}"><ide><nNF>71652</nNF><serie>1</serie><dhEmi>2026-11-09T10:00:00-03:00</dhEmi><tpNF>1</tpNF></ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>AMG</xNome></emit>
    <dest><CPF>12345678909</CPF><xNome>Fulano &amp; Cia</xNome><enderDest><xLgr>Rua X</xLgr><nro>10</nro><xBairro>Centro</xBairro><xMun>Campinas</xMun><UF>SP</UF><CEP>13000-000</CEP></enderDest><indIEDest>9</indIEDest></dest>
    <det nItem="1"><prod><cProd>CFOP5102</cProd><cEAN>SEM GTIN</cEAN><xProd>Ducha 20x20</xProd><NCM>84818019</NCM><CEST>1007900</CEST><CFOP>5102</CFOP><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>60.00</vUnCom><vProd>120.00</vProd><vDesc>0.58</vDesc></prod>
      <imposto><ICMS><ICMSSN102><orig>2</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
    <det nItem="2"><prod><cProd>NI-831</cProd><cEAN>7891234567895</cEAN><xProd>Niple</xProd><NCM>73079900</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1</qCom><vUnCom>5.00</vUnCom><vProd>5.00</vProd></prod>
      <imposto><ICMS><ICMSSN102><orig>0</orig></ICMSSN102></ICMS></imposto></det>
  </infNFe></NFe><protNFe><infProt><chNFe>${ch}</chNFe><nProt>135250000000001</nProt></infProt></protNFe></nfeProc>`;
  const v = vendaDoXml(xml);
  assert.strictEqual(v.chave, ch); assert.strictEqual(v.numero, '71652'); assert.strictEqual(v.emissao, '2026-11-09');
  assert.strictEqual(v.emitente_cnpj, '12345678000199');
  assert.strictEqual(v.destinatario.nome, 'Fulano & Cia'); assert.strictEqual(v.destinatario.endereco.cep, '13000000');
  assert.strictEqual(v.itens.length, 2);
  assert.strictEqual(v.itens[0].unitario, 59.71, 'valor unitário líquido do desconto');
  assert.strictEqual(v.itens[0].origem, '2'); assert.strictEqual(v.itens[0].gtin, null); assert.strictEqual(v.itens[1].gtin, '7891234567895');
  assert.throws(() => vendaDoXml(xml.replace('<nProt>135250000000001</nProt>', '')), /autorizada/);
  assert.throws(() => vendaDoXml(xml.replace('<tpNF>1</tpNF>', '<tpNF>0</tpNF>')), /saída/);
  assert.throws(() => escolhidosValidos(v, [{ n: 1, quantidade: 3 }]), /vendido com 2/);
  assert.throws(() => escolhidosValidos(v, [{ n: 1, quantidade: 0 }]), /pelo menos um/);
  assert.throws(() => escolhidosValidos(v, [{ n: 9, quantidade: 1 }]), /inválido/);
  const esc = escolhidosValidos(v, [{ n: 1, quantidade: 1 }, { n: 2, quantidade: 0 }]);
  const c = corpoDevolucao(v, esc, '777', '2026-11-09 15:00:00', 'Pedido Mercado Livre 2000019340356416');
  assert.strictEqual(c.tipo, 0); assert.strictEqual(c.finalidade, 4); assert.strictEqual(c.naturezaOperacao.id, 777);
  assert.deepStrictEqual(c.documentoReferenciado, { modelo: '55', chaveAcesso: ch, numero: '71652', serie: '1', data: '2026-11-09' });
  assert.strictEqual(c.contato.tipoPessoa, 'F'); assert.strictEqual(c.contato.numeroDocumento, '12345678909'); assert.strictEqual(c.contato.contribuinte, 9);
  assert.strictEqual(c.itens.length, 1);
  assert.deepStrictEqual(c.itens[0].documentoReferenciado, { chaveAcesso: ch, numeroItem: '1' });
  assert.strictEqual(c.itens[0].quantidade, 1); assert.strictEqual(c.itens[0].valor, 59.71); assert.strictEqual(c.itens[0].origem, 2);
  assert.strictEqual(c.itens[0].classificacaoFiscal, '84818019'); assert.strictEqual(c.itens[0].cest, '1007900');
  assert.ok(c.observacoes.includes(ch) && c.observacoes.includes('09/11/2026'));
  assert.ok(!/\/api\/devolucao-nf/.test(fs.readFileSync('./mcp.js', 'utf8')), 'mcp.js não pode apontar para /api/devolucao-nf');
}
{
  const { devolucaoDaNotaMl, devolucaoDaNotaBling } = require('./devolucao-nf.js');
  // devolução emitida no site do ML (medido 09/11/2026): o pedido vem em items[].external_order_id
  const d = devolucaoDaNotaMl({ id: '7426347947', status: 'authorized', invoice_number: 71816, invoice_series: '2', issued_date: '2026-11-09T17:20:00Z',
    fiscal_data: { transaction_type: 'devolution' }, items: [{ external_order_id: '2000019340356416' }, { external_order_id: '2000019340356416' }] });
  assert.deepStrictEqual(d.pedidos, ['2000019340356416']); assert.strictEqual(d.numero, 71816); assert.strictEqual(d.status, 'authorized');
  assert.strictEqual(devolucaoDaNotaMl({ fiscal_data: { transaction_type: 'sale' }, items: [] }), null);
  const b = devolucaoDaNotaBling({ tipo: 0, finalidade: 4, numero: '1234', situacao: 5,
    observacoes: 'Devolução de venda referente à NF-e nº 13179 série 1 de 05/11/2026, chave 35251112345678000199550010000131791000000017. Pedido Shopee 251105ABC123XY.' });
  assert.strictEqual(b.chave_venda, '35251112345678000199550010000131791000000017'); assert.strictEqual(b.pedido_obs, '251105ABC123XY');
  assert.strictEqual(devolucaoDaNotaBling({ tipo: 0, finalidade: 4, documentoReferenciado: { chaveAcesso: '3525 1112 3456 7800 0199 5500 1000 0131 7910 0000 0017' } }).chave_venda,
    '35251112345678000199550010000131791000000017');
  assert.strictEqual(devolucaoDaNotaBling({ tipo: 1, finalidade: 1 }), null);
  assert.strictEqual(devolucaoDaNotaBling({ tipo: 0, finalidade: 1 }), null, 'entrada que não é devolução');
}

console.log('test-bling: ok');
