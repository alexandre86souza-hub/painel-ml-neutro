'use strict';
// node test.js  — checa a montagem do payload e as validações de entrada.
// Banco temporário: rodar teste não pode criar nem mexer no dados.sqlite do aluno.
process.env.ML_DB_FILE = require('node:path').join(require('node:os').tmpdir(), `teste-ml-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = process.env.ML_DB_KEY || 'chave-de-teste-nao-usar-em-producao';
const assert = require('node:assert');
const { buildItem } = require('./server.js');

const base = { title:'Camiseta Preta', category_id:'MLB31447', price:'89.90', quantity:'3' };

const ok = buildItem({
  ...base,
  picture_ids: ['ML-1', ' ML-2 ', ''],
  pictures: 'https://a.com/9.jpg',
  attributes: { BRAND:'Nike', MODEL:'  ', COLOR:' Preto ' },
  free_shipping: true,
});
assert.strictEqual(ok.price, 89.9);
assert.strictEqual(ok.available_quantity, 3);
assert.strictEqual(ok.currency_id, 'BRL');
assert.strictEqual(ok.buying_mode, 'buy_it_now');
assert.strictEqual(ok.title, 'Camiseta Preta');
assert.strictEqual(ok.family_name, undefined, 'conta comum manda title, nunca family_name');
// conta "User Products": o ML exige family_name e recusa title (medido com /items/validate)
const up = buildItem(base, { userProduct: true });
assert.strictEqual(up.family_name, 'Camiseta Preta');
assert.ok(!('title' in up), 'com family_name, title não pode ir junto');
assert.deepStrictEqual(ok.pictures, [{id:'ML-1'},{id:'ML-2'},{source:'https://a.com/9.jpg'}]); // ids primeiro, vazio descartado
assert.deepStrictEqual(ok.attributes, [{id:'BRAND',value_name:'Nike'},{id:'COLOR',value_name:'Preto'}]); // vazio descartado, valor trimado
assert.strictEqual(ok.shipping.free_shipping, true);
assert.strictEqual(ok.shipping.local_pick_up, false);

const rejeita = (form, trecho) => assert.throws(() => buildItem(form), (e) => e.status === 400 && e.message.includes(trecho), trecho);
rejeita({ ...base, title:'' }, 'Título é obrigatório');
rejeita({ ...base, title:'x'.repeat(61) }, '60 caracteres');
rejeita({ ...base, category_id:'' }, 'Categoria');
rejeita({ ...base, price:'0' }, 'Preço');
rejeita({ ...base, price:'abc' }, 'Preço');
rejeita({ ...base, quantity:'0' }, 'Quantidade');
rejeita({ ...base, quantity:'1.5' }, 'Quantidade');
rejeita({ ...base, pictures:'http://inseguro.com/1.jpg' }, 'https');

console.log('OK — payload e validações');

// ---- buildEdicao: lista fechada de campos ----
const { buildEdicao } = require('./server.js');

const e1 = buildEdicao({ price: '199.90', available_quantity: '0', status: 'paused' });
assert.deepStrictEqual(e1, { price: 199.9, available_quantity: 0, status: 'paused' });
assert.strictEqual(buildEdicao({ available_quantity: 0 }).available_quantity, 0, 'estoque 0 é válido (pausa)');
assert.deepStrictEqual(buildEdicao({ picture_ids: ['A', 'B'] }).pictures, [{ id: 'A' }, { id: 'B' }]);

// campo fora da lista não passa
assert.deepStrictEqual(Object.keys(buildEdicao({ price: 10, seller_id: 9, id: 'MLB1', health: 1 })), ['price']);

const recusa = (f, t) => assert.throws(() => buildEdicao(f), (e) => e.status === 400 && e.message.includes(t), t);
recusa({}, 'Nada para alterar');
recusa({ price: 0 }, 'Preço');
recusa({ price: -5 }, 'Preço');
recusa({ available_quantity: -1 }, 'Estoque');
recusa({ available_quantity: 1.5 }, 'Estoque');
recusa({ title: '   ' }, 'vazio');
recusa({ title: 'x'.repeat(61) }, '60 caracteres');
recusa({ status: 'deleted' }, 'Status inválido');

// campos completos da modal (todos medidos como aceitos pela API do ML)
const cheio = buildEdicao({
  title: '  iMac 27  ', warranty: 'Garantia de 3 meses', condition: 'used',
  category_id: 'MLB1652', video_id: 'abc123', seller_custom_field: 'SKU-9',
  picture_ids: ['P3', 'P1', 'P2'],
  attributes: { BRAND: 'Apple', MODEL: '  ', COLOR: ' Prata ' },
  shipping: { mode: 'me2', free_shipping: true },
});
assert.strictEqual(cheio.title, 'iMac 27', 'título é trimado');
assert.strictEqual(cheio.warranty, 'Garantia de 3 meses');
assert.strictEqual(cheio.condition, 'used');
assert.strictEqual(cheio.category_id, 'MLB1652');
assert.strictEqual(cheio.video_id, 'abc123');
assert.strictEqual(cheio.seller_custom_field, 'SKU-9');
assert.deepStrictEqual(cheio.pictures, [{id:'P3'},{id:'P1'},{id:'P2'}], 'a ordem enviada é a ordem no anúncio');
assert.deepStrictEqual(cheio.attributes, [{id:'BRAND',value_name:'Apple'},{id:'COLOR',value_name:'Prata'}]);
assert.deepStrictEqual(cheio.shipping, { mode:'me2', free_shipping:true, local_pick_up:false });

// campos que limpam
assert.strictEqual(buildEdicao({ video_id: '' }).video_id, null, 'vídeo vazio remove o vídeo');
assert.strictEqual(buildEdicao({ seller_custom_field: '' }).seller_custom_field, null, 'SKU vazio limpa');

// listing_type_id nunca sai por aqui: tem endpoint próprio
assert.deepStrictEqual(Object.keys(buildEdicao({ title:'x', listing_type_id:'gold_pro' })), ['title']);

recusa({ condition: 'novinho' }, 'Condição inválida');
recusa({ category_id: 'xyz' }, 'Categoria inválida');
recusa({ picture_ids: [] }, 'ao menos uma foto');
recusa({ warranty: 'g'.repeat(256) }, 'Garantia passa');
recusa({ warranty: '  ' }, 'Garantia não pode');
recusa({ seller_custom_field: 's'.repeat(61) }, 'SKU passa');
recusa({ shipping: { mode: 'drone' } }, 'Modo de envio inválido');

console.log('OK — edição de anúncio (campos completos)');

// sale_terms (garantia) entram como os atributos: pares id/valor, vazios descartados
const st = buildEdicao({ sale_terms: { WARRANTY_TYPE: 'Garantia do vendedor', WARRANTY_TIME: ' 3 meses ', X: '' } });
assert.deepStrictEqual(st.sale_terms,
  [{id:'WARRANTY_TYPE', value_name:'Garantia do vendedor'}, {id:'WARRANTY_TIME', value_name:'3 meses'}]);
assert.strictEqual(buildEdicao({ title:'x', sale_terms: {} }).sale_terms, undefined, 'sale_terms vazio não vai');

console.log('OK — sale_terms');

// ---------- comparativo do Ads: 7 dias contra os 7 anteriores ----------
{
  const { comparativoAds } = require('./server.js');
  const ontem = Date.parse('2026-09-29T12:00:00Z');
  const dia = (n) => new Date(ontem - n * 864e5).toISOString().slice(0, 10);
  const linha = (n, custo, receita) => [dia(n), { data: dia(n), investimento: custo, receita, direta: receita, indireta: 0,
    organica: 0, cliques: 10, impressoes: 100, unidades: 1 }];
  // 14 dias: os 7 mais recentes gastam 20/dia e vendem 100/dia; os 7 anteriores, 10 e 40
  const porDia = new Map([...Array(7).keys()].map((n) => linha(n, 20, 100))
    .concat([...Array(7).keys()].map((n) => linha(n + 7, 10, 40))));
  const [p7, p15] = comparativoAds(porDia, ontem, [7, 15]);
  assert.strictEqual(p7.atual.investimento, 140);
  assert.strictEqual(p7.antes.investimento, 70);
  assert.strictEqual(p7.variacao.investimento, 1, 'dobrou o investimento');
  assert.strictEqual(p7.variacao.receita, 1.5);
  assert.strictEqual(p7.atual.roas, 5, 'razão recalculada da soma');
  assert.strictEqual(p7.por_dia.receita, 100);
  assert.strictEqual(p15.antes, null, 'sem os 15 dias anteriores inteiros não há comparação');
  assert.strictEqual(p15.variacao, null);
  assert.strictEqual(p15.atual.investimento, 210);
  console.log('OK — comparativo do Ads');

  // mudanças na campanha: compara a configuração guardada com a de agora
  const { mudancasDaCampanha } = require('./server.js');
  const antes = { nome: 'Todo Portfólio 07', status: 'active', estrategia: 'PROFITABILITY', roas_alvo: 23.5, orcamento: 20 };
  assert.deepStrictEqual(mudancasDaCampanha(antes, { ...antes }), [], 'nada mudou');
  assert.deepStrictEqual(mudancasDaCampanha(antes, { ...antes, roas_alvo: 25, orcamento: 30 }),
    [{ campo: 'roas_alvo', de: 23.5, para: 25 }, { campo: 'orcamento', de: 20, para: 30 }]);
  assert.deepStrictEqual(mudancasDaCampanha(antes, { ...antes, status: 'paused' }), [{ campo: 'status', de: 'active', para: 'paused' }]);
  assert.deepStrictEqual(mudancasDaCampanha(null, antes), [], 'primeira vez que vê a campanha: só guarda');
  console.log('OK — mudanças nas campanhas do Ads');

  // identidade do painel: nome e logo (só PNG, JPG ou WebP de verdade, até 300 KB)
  const { validarMarca } = require('./server.js');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const url = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
  assert.deepStrictEqual(validarMarca({ nome: '  Loja   Exemplo ' }), { nome: 'Loja Exemplo' }, 'sem logo no corpo: não mexe no logo');
  assert.deepStrictEqual(validarMarca({ nome: '' }), { nome: null }, 'nome vazio volta ao padrão');
  assert.deepStrictEqual(validarMarca({ logo: null }), { logo: null }, 'null remove o logo');
  assert.deepStrictEqual(validarMarca({ logo: url('image/png', png) }).logo, { mime: 'image/png', b64: png.toString('base64') });
  assert.throws(() => validarMarca({ nome: 'x'.repeat(41) }), /40 caracteres/);
  assert.throws(() => validarMarca({ logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }), /PNG, JPG ou WebP/, 'SVG não entra');
  assert.throws(() => validarMarca({ logo: url('image/png', Buffer.from('<script>alert(1)</script> nada de imagem')) }), /não é uma imagem/,
    'tipo declarado não basta: os primeiros bytes têm de ser da imagem');
  assert.throws(() => validarMarca({ logo: url('image/png', Buffer.concat([png, Buffer.alloc(301 * 1024)])) }), /300 KB/);
  console.log('OK — identidade do painel');
}

// Amazon com identidade e empresa próprias (?conta=amazon), separadas das contas do ML.
(async () => {
  const S = require('./server.js');
  const D = require('./db.js');
  const pedir = (m, c, corpo) => S.despachar(m, new URL('http://painel' + c), corpo || {});
  const m = await pedir('PUT', '/api/marca?conta=amazon', { nome: 'Loja na Amazon' });
  assert.strictEqual(m.conta, 'amazon'); assert.strictEqual(m.nome, 'Loja na Amazon');
  assert.strictEqual(D.configLer('marca_nome:amazon'), 'Loja na Amazon');
  assert.notStrictEqual((await pedir('GET', '/api/marca')).nome, 'Loja na Amazon', 'a geral não muda');
  assert.strictEqual((await pedir('GET', '/api/marca?conta=amazon')).nome, 'Loja na Amazon');
  assert.strictEqual((await pedir('GET', '/api/empresa?conta=amazon')).salvo, false, 'sem salvar: mostra a de reserva');
  const e = await pedir('PUT', '/api/empresa?conta=amazon', { regime: 'Simples Nacional', impostos: [{ nome: 'Simples', pct: '6,5' }], embalagem_padrao: '2' });
  assert.strictEqual(e.imposto_total, 6.5);
  const g = await pedir('GET', '/api/empresa?conta=amazon');
  assert.strictEqual(g.salvo, true); assert.strictEqual(g.embalagem_padrao, 2);
  console.log('OK — Amazon com identidade e empresa próprias');
})().catch((e) => { console.error(e); process.exit(1); });
