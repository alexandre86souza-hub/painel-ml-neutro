'use strict';
// Etiquetas de envio (tela public/etiquetas.html, item do menu logo abaixo de Comandas): a etiqueta da
// transportadora que o marketplace libera depois da nota fiscal, para a térmica 10×15 (Elgin L42 Pro Full,
// pelo driver do Windows: PDF, não ZPL). A lista é a MESMA fila das comandas (comandas.js), com o número
// da comanda ao lado, para casar etiqueta e comanda no pacote.
//   Mercado Livre: substatus ready_to_print (liberada) ou printed (já impressa); GET /shipment_labels
//                  ?shipment_ids=…&response_type=pdf, até 50 envios da MESMA conta por arquivo. Baixar a
//                  etiqueta faz o ML marcar o envio como impresso (igual a imprimir pelo site).
//   Shopee:        PROCESSED (o envio já foi organizado e tem rastreio); get_tracking_number ->
//                  create_shipping_document (térmica quando a Shopee deixa) -> get_shipping_document_result
//                  -> download_shipping_document, até 50 pedidos da MESMA loja por arquivo.
// A etiqueta tem nome e endereço do comprador: o painel NÃO guarda o arquivo (só a hora em que foi baixada,
// comandas.etiqueta_em) e nada disto vai para o MCP. Magalu e Amazon: ainda não (ver CLAUDE.md).

const erro = (msg, status) => Object.assign(new Error(msg), { status });
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const MAX = 50;

// Situação da etiqueta de um envio da fila das comandas. Função pura: testada.
//   liberada = pode imprimir; aguardando = ainda não (motivo em texto); null = canal sem etiqueta pelo painel.
function situacaoEtiqueta(c) {
  if (c.canal === 'ml') {
    if (c.etapa === 'ready_to_print') return { situacao: 'liberada' };
    if (c.etapa === 'printed') return { situacao: 'liberada', impressa_no_canal: true };
    if (c.etapa === 'invoice_pending') return { situacao: 'aguardando', motivo: 'Aguardando a nota fiscal' };
    return { situacao: 'aguardando', motivo: c.etapa ? `Etapa no ML: ${c.etapa}` : 'Sem etapa do ML ainda' };
  }
  if (c.canal === 'shopee') {
    if (c.etapa === 'PROCESSED') return { situacao: 'liberada' };
    return { situacao: 'aguardando', motivo: 'Aguardando a nota fiscal e organizar o envio' };
  }
  return null;
}

// Tipo do documento da Shopee: térmica quando dá, senão o sugerido. Função pura: testada.
function tipoShopee(r) {
  const sel = Array.isArray(r?.selectable_shipping_document_type) ? r.selectable_shipping_document_type : [];
  if (sel.includes('THERMAL_AIR_WAYBILL')) return 'THERMAL_AIR_WAYBILL';
  return r?.suggest_shipping_document_type || sel[0] || 'THERMAL_AIR_WAYBILL';
}

// O que a loja devolveu tem de ser um PDF: confere pelos bytes. ZIP = tira o 1º PDF de dentro; JSON/texto = a
// mensagem da loja vira erro (sem repetir os bytes: a etiqueta tem dado do comprador). Função pura: testada.
function soPdf(buf, loja) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw erro(`${loja} devolveu um arquivo vazio.`, 502);
  const ini = buf.indexOf('%PDF');
  if (ini >= 0 && ini < 1024) return ini ? buf.subarray(ini) : buf;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {   // ZIP: percorre os arquivos de dentro
    const zlib = require('node:zlib');
    for (let p = 0; p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50;) {
      const metodo = buf.readUInt16LE(p + 8), tam = buf.readUInt32LE(p + 18), nl = buf.readUInt16LE(p + 26), xl = buf.readUInt16LE(p + 28);
      const nome = buf.toString('utf8', p + 30, p + 30 + nl), dado = buf.subarray(p + 30 + nl + xl, p + 30 + nl + xl + tam);
      if (/\.pdf$/i.test(nome)) return soPdf(metodo === 8 ? zlib.inflateRawSync(dado) : dado, loja);
      p += 30 + nl + xl + tam;
    }
    throw erro(`${loja} mandou um .zip sem PDF dentro.`, 502);
  }
  const txt = buf.subarray(0, 2000).toString('utf8').trim();
  let msg = null;
  try { const j = JSON.parse(txt); msg = j.message || j.error || null; } catch { /* não é JSON */ }
  if (msg) throw erro(`${loja}: ${String(msg).slice(0, 200)}`, 502);
  throw erro(`${loja} não devolveu um PDF (${/^</.test(txt) ? 'página HTML' : 'formato desconhecido'}, ${buf.length} bytes).`, 502);
}

function criar({ D, mlArquivo, daLoja, comandas }) {
  // grupo = de onde sai o arquivo (uma conta do ML ou uma loja da Shopee): cada arquivo é de um grupo só
  function grupos() {
    const ml = new Map(D.contasListar().map((c) => [c.nickname, String(c.ml_user_id)]));
    const sh = new Map(D.shopeeLojasListar().map((l) => [l.nome || `Shopee ${l.shop_id}`, String(l.shop_id)]));
    return (c) => {
      if (c.canal === 'ml' && ml.has(c.loja)) return `ml:${ml.get(c.loja)}`;
      if (c.canal === 'shopee' && sh.has(c.loja)) return `shopee:${sh.get(c.loja)}`;
      return null;
    };
  }

  async function lista(recarregar) {
    const f = await comandas.fila(recarregar);
    const grupoDe = grupos();
    const etiquetas = [];
    for (const c of f.comandas) {
      const s = situacaoEtiqueta(c);
      if (!s) continue;
      etiquetas.push({ chave: c.chave, canal: c.canal, loja: c.loja, grupo: grupoDe(c), categoria: c.categoria, numero: c.numero, dia: c.dia,
        pedido: c.pedido, envio: c.envio, cliente: c.cliente, prazo: c.prazo, situacao_prazo: c.situacao_prazo, unidades: c.unidades,
        comanda_impressa_em: c.impressa_em, etiqueta_em: c.etiqueta_em || null, ...s });
    }
    return { em: f.em, erros: f.erros, etiquetas };
  }

  // Os envios pedidos, conferidos: todos na fila, liberados e do MESMO grupo.
  async function conferir(chaves) {
    const pedidas = [...new Set((Array.isArray(chaves) ? chaves : []).map(String))];
    if (!pedidas.length || pedidas.length > MAX) throw erro(`Escolha de 1 a ${MAX} etiquetas por vez.`, 400);
    const { etiquetas } = await lista(false);
    const porChave = new Map(etiquetas.map((e) => [e.chave, e]));
    const escolhidas = pedidas.map((k) => porChave.get(k));
    if (escolhidas.some((e) => !e)) throw erro('Algum envio não está mais na fila (já saiu ou foi cancelado). Atualize a tela.', 409);
    if (escolhidas.some((e) => e.situacao !== 'liberada')) throw erro('Algum envio ainda não tem a etiqueta liberada.', 409);
    const grupo = escolhidas[0].grupo;
    if (!grupo || escolhidas.some((e) => e.grupo !== grupo)) throw erro('Cada arquivo é de uma conta ou loja só.', 400);
    // na ordem da comanda (categoria, número), para casar com o papel da comanda
    escolhidas.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.numero - b.numero);
    return { grupo, escolhidas };
  }

  async function pdfMl(contaId, escolhidas) {
    const ids = escolhidas.map((e) => e.chave.slice(3));
    const pdf = soPdf(await mlArquivo(`/shipment_labels?shipment_ids=${ids.join(',')}&response_type=pdf`, contaId), 'Mercado Livre');
    return { pdf, ok: escolhidas.map((e) => e.chave), falhas: [] };
  }

  async function pdfShopee(shopId, escolhidas) {
    const falhas = [];
    const resp = (r) => r?.response || {};
    const sn = (e) => e.chave.slice(7);
    // rastreio de cada pedido (exigido para gerar o documento)
    const comRastreio = [];
    for (const e of escolhidas) {
      try {
        const t = resp(await daLoja(shopId, '/api/v2/logistics/get_tracking_number', { order_sn: sn(e) })).tracking_number;
        if (t) comRastreio.push({ e, rastreio: t }); else falhas.push({ chave: e.chave, motivo: 'A Shopee ainda não deu o rastreio deste pedido.' });
      } catch (x) { falhas.push({ chave: e.chave, motivo: x.message }); }
    }
    if (!comRastreio.length) return { pdf: null, ok: [], falhas };
    const param = resp(await daLoja(shopId, '/api/v2/logistics/get_shipping_document_parameter', {}, { order_list: comRastreio.map((x) => ({ order_sn: sn(x.e) })) }));
    const tipoDo = new Map((param.result_list || []).map((r) => [r.order_sn, tipoShopee(r)]));
    // um arquivo = um tipo de documento: fica o tipo da maioria; o resto vai em outro arquivo
    const conta = new Map();
    for (const x of comRastreio) { const t = tipoDo.get(sn(x.e)) || 'THERMAL_AIR_WAYBILL'; conta.set(t, (conta.get(t) || 0) + 1); }
    const tipo = [...conta].sort((a, b) => b[1] - a[1])[0][0];
    const vao = [];
    for (const x of comRastreio) {
      if ((tipoDo.get(sn(x.e)) || 'THERMAL_AIR_WAYBILL') === tipo) vao.push(x);
      else falhas.push({ chave: x.e.chave, motivo: 'Etiqueta de outro modelo da Shopee: imprima este pedido separado.' });
    }
    const criado = resp(await daLoja(shopId, '/api/v2/logistics/create_shipping_document', {},
      { order_list: vao.map((x) => ({ order_sn: sn(x.e), tracking_number: x.rastreio, shipping_document_type: tipo })) }));
    const falhou = new Map((criado.result_list || []).filter((r) => r.fail_error).map((r) => [r.order_sn, r.fail_message || r.fail_error]));
    let pendentes = vao.filter((x) => !falhou.has(sn(x.e)));
    for (const x of vao) if (falhou.has(sn(x.e))) falhas.push({ chave: x.e.chave, motivo: `Shopee: ${falhou.get(sn(x.e))}` });
    // a Shopee gera o documento em segundo plano: confere até ~20 s
    const prontos = [];
    for (let i = 0; i < 10 && pendentes.length; i++) {
      if (i) await espera(2000);
      const r = resp(await daLoja(shopId, '/api/v2/logistics/get_shipping_document_result', {},
        { order_list: pendentes.map((x) => ({ order_sn: sn(x.e), shipping_document_type: tipo })) }));
      const st = new Map((r.result_list || []).map((y) => [y.order_sn, y]));
      const resto = [];
      for (const x of pendentes) {
        const y = st.get(sn(x.e));
        if (y?.status === 'READY') prontos.push(x);
        else if (y?.status === 'FAILED' || y?.fail_error) falhas.push({ chave: x.e.chave, motivo: `Shopee: ${y.fail_message || y.fail_error || 'não gerou a etiqueta'}` });
        else resto.push(x);
      }
      pendentes = resto;
    }
    for (const x of pendentes) falhas.push({ chave: x.e.chave, motivo: 'A Shopee ainda está gerando a etiqueta. Tente de novo em instantes.' });
    if (!prontos.length) return { pdf: null, ok: [], falhas };
    const pdf = await daLoja(shopId, '/api/v2/logistics/download_shipping_document', {},
      { shipping_document_type: tipo, order_list: prontos.map((x) => ({ order_sn: sn(x.e) })) }, true);
    if (!Buffer.isBuffer(pdf)) throw erro('A Shopee não devolveu o arquivo da etiqueta.', 502);
    return { pdf: soPdf(pdf, 'Shopee'), ok: prontos.map((x) => x.e.chave), falhas };
  }

  // O PDF de um grupo. Devolve { pdf, ok, falhas }; marca as baixadas.
  async function pdf(chaves) {
    const { grupo, escolhidas } = await conferir(chaves);
    const [canal, id] = grupo.split(':');
    const r = canal === 'ml' ? await pdfMl(id, escolhidas) : await pdfShopee(id, escolhidas);
    if (r.ok.length) D.comandasEtiqueta(r.ok);
    return r;
  }

  const rotas = {
    'GET /api/etiquetas': async (url) => lista(url.searchParams.get('recarregar') === '1'),
  };
  return { rotas, pdf };
}

module.exports = { criar, situacaoEtiqueta, tipoShopee, soPdf, MAX };
