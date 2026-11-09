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
assert.deepStrictEqual(B.SHOPEE_DA_CONTA, { 1: '445620092', 2: '717079477' });

// nota fiscal tem dado do comprador: nada do Bling no MCP
assert.ok(!/\/api\/bling/.test(fs.readFileSync('./mcp.js', 'utf8')), 'mcp.js não pode apontar para /api/bling');

console.log('test-bling: ok');
