'use strict';
// Central de mensagens (tela public/mensagens.html): o que espera resposta do vendedor em todas
// as contas, num lugar só, e as mensagens padrão (modelos) que ele salva e edita antes de enviar.
//
// Medido em 06/10/2026:
//   - ML perguntas: /questions/search?seller_id=&status=UNANSWERED&api_version=4 -> questions[]
//     (id, text, item_id, date_created). Resposta: POST /answers {question_id, text}.
//   - ML reclamações: /post-purchase/v1/claims/search?status=opened traz também as que a CONTA
//     abriu como compradora (players complainant = a conta): só valem as em que ela é respondent.
//     /claims/{id}/messages -> [{sender_role complainant|respondent|mediator, message,
//     message_date}]. Resposta: POST /claims/{id}/actions/send-message {receiver_role, message}.
//   - ML pós-venda: /messages/unread?role=seller&tag=post_sale (só as não lidas). Conversa:
//     /messages/packs/{pack}/sellers/{seller}?tag=post_sale&mark_as_read=false. Os packs vistos
//     ficam em msg_packs (15 dias) para continuarem na lista até o vendedor responder, mesmo se
//     ele abrir a mensagem no site do ML.
//   - Shopee: sellerchat/get_conversation_list (to_id = comprador; latest_message_from_id diz
//     quem falou por último), get_message e send_message {to_id, message_type text, content}.
//   - Amazon: a SP-API não lê mensagens de comprador (só envia avisos prontos por pedido): fica
//     o link da caixa de mensagens do Seller Central.
// Mensagens de comprador são dado pessoal: nada disto vai para o MCP.
const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const LIMITE = { pergunta: 2000, mensagem: 350, reclamacao: 2000, chat: 1000 };

// Data de qualquer formato (ISO, segundos, milissegundos, nanossegundos) -> ISO. Função pura: testada.
function dataDe(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && !/^\d+$/.test(v)) { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1e17) n /= 1e6; else if (n > 1e14) n /= 1e3; else if (n < 1e11) n *= 1e3;
  return new Date(n).toISOString();
}

// Reclamação do ML esperando o vendedor: a conta é a vendedora (respondent), pode mandar mensagem
// (available_actions send_message_to_complainant|mediator) e o último a falar não foi ela — ou,
// sem conversa, o ML diz que a vez é dela (detail.action_responsible). Medido: devolução em
// mediação com a vez do comprador não pede nada ao vendedor. Função pura: testada.
function destinosDe(claim) {
  const v = (claim.players || []).find((p) => p.role === 'respondent');
  const acoes = (v?.available_actions || []).map((a) => a.action);
  return ['complainant', 'mediator'].filter((d) => acoes.includes(`send_message_to_${d}`));
}
function reclamacaoPendente(claim, mensagens, contaId, detalhe = null) {
  const vendedor = (claim.players || []).find((p) => p.role === 'respondent');
  if (!vendedor || Number(vendedor.user_id) !== Number(contaId) || !destinosDe(claim).length) return false;
  const ms = [...(mensagens || [])].sort((a, b) => String(a.message_date || a.date_created).localeCompare(String(b.message_date || b.date_created)));
  const ultima = ms[ms.length - 1];
  if (ultima && ultima.sender_role !== 'respondent') return true;
  return detalhe?.action_responsible === 'respondent' && !(ultima && ultima.sender_role === 'respondent');
}

// Conversa da Shopee esperando o vendedor: o comprador falou por último. Função pura: testada.
const chatPendente = (c) => c.latest_message_from_id != null && Number(c.latest_message_from_id) === Number(c.to_id);

// Texto de uma mensagem da Shopee (texto, ou o tipo quando é cartão de produto/pedido/imagem). Função pura: testada.
function textoShopee(tipo, conteudo) {
  if (conteudo?.text) return conteudo.text;
  return { image: '[imagem]', item: '[produto]', order: '[pedido]', sticker: '[figurinha]', video: '[vídeo]', item_list: '[produtos]' }[tipo] || `[${tipo || 'mensagem'}]`;
}

// Modelo com variáveis {produto}, {pedido}, {comprador}: troca as que vierem. Função pura: testada.
function preencher(texto, vars = {}) {
  return String(texto || '').replace(/\{(produto|pedido|comprador)\}/g, (m, k) => (vars[k] ? String(vars[k]) : m));
}

// Texto da resposta: sem vazio, sem passar do limite do canal. Função pura: testada.
function textoValido(texto, tipo) {
  const t = String(texto || '').trim();
  if (!t) throw erro('Escreva a resposta.');
  const max = LIMITE[tipo] || 1000;
  if (t.length > max) throw erro(`A mensagem passou do limite de ${max} caracteres deste canal (tem ${t.length}).`);
  return t;
}

function criar({ D, ml, emLotes, daLoja }) {
  D.db.exec(`CREATE TABLE IF NOT EXISTS mensagens_modelos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, texto TEXT NOT NULL, tipo TEXT,
      usos INTEGER NOT NULL DEFAULT 0, atualizado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS msg_packs (
      ml_user_id INTEGER NOT NULL, pack_id TEXT NOT NULL, visto_em TEXT NOT NULL, PRIMARY KEY (ml_user_id, pack_id));`);
  const agora = () => new Date().toISOString();

  // ---------- leitura por canal ----------
  const titulos = new Map();   // item_id -> título (memória)
  async function tituloDos(contaId, ids) {
    const faltam = [...new Set(ids.filter((i) => i && !titulos.has(i)))];
    for (let i = 0; i < faltam.length; i += 20) {
      try {
        const r = await ml(`/items?ids=${faltam.slice(i, i + 20).join(',')}&attributes=id,title,thumbnail,permalink`, {}, contaId);
        for (const x of r || []) if (x.code === 200) titulos.set(x.body.id, { titulo: x.body.title, foto: x.body.thumbnail, link: x.body.permalink });
      } catch { /* título é enfeite */ }
    }
    return (id) => titulos.get(id) || {};
  }

  async function perguntasML(conta) {
    const r = await ml(`/questions/search?seller_id=${conta.ml_user_id}&status=UNANSWERED&api_version=4&limit=50&sort_fields=date_created&sort_types=DESC`, {}, conta.ml_user_id);
    const qs = r.questions || [];
    const tit = await tituloDos(conta.ml_user_id, qs.map((q) => q.item_id));
    return qs.map((q) => ({ canal: 'ml', conta: String(conta.ml_user_id), conta_nome: conta.nickname, tipo: 'pergunta', id: String(q.id),
      texto: q.text, data: dataDe(q.date_created), produto: tit(q.item_id).titulo || q.item_id, foto: tit(q.item_id).foto || null,
      ref: q.item_id, link: `https://www.mercadolivre.com.br/perguntas/vendedor` }));
  }

  const pedidosTit = new Map();   // order_id -> { titulo, foto, comprador }
  async function pedidoML(contaId, orderId) {
    if (pedidosTit.has(orderId)) return pedidosTit.get(orderId);
    let v = {};
    try {
      const o = await ml(`/orders/${orderId}`, {}, contaId);
      const it = o.order_items?.[0]?.item || {};
      v = { titulo: it.title || null, item_id: it.id || null, comprador: o.buyer?.nickname || null, pack: o.pack_id ? String(o.pack_id) : String(orderId),
        comprador_id: o.buyer?.id || null };
    } catch { /* pedido de outra conta ou apagado */ }
    pedidosTit.set(orderId, v);
    return v;
  }

  async function reclamacoesML(conta) {
    let lista = [];
    for (let offset = 0; offset < 300; offset += 50) {
      const r = await ml(`/post-purchase/v1/claims/search?status=opened&limit=50&offset=${offset}`, {}, conta.ml_user_id);
      lista = lista.concat(r.data || []);
      if ((r.data || []).length < 50) break;
    }
    lista = lista.filter((c) => (c.players || []).some((p) => p.role === 'respondent' && Number(p.user_id) === Number(conta.ml_user_id)));
    const out = [];
    await emLotes(lista, 4, async (c) => {
      if (!destinosDe(c).length) return;
      const [ms, det] = await Promise.all([ml(`/post-purchase/v1/claims/${c.id}/messages`, {}, conta.ml_user_id).catch(() => []),
        ml(`/post-purchase/v1/claims/${c.id}/detail`, {}, conta.ml_user_id).catch(() => null)]);
      if (!reclamacaoPendente(c, ms, conta.ml_user_id, det)) return;
      const ultima = [...ms].sort((a, b) => String(b.message_date).localeCompare(String(a.message_date)))[0];
      const p = c.resource === 'order' ? await pedidoML(conta.ml_user_id, c.resource_id) : {};
      const acoes = (c.players.find((x) => x.role === 'respondent')?.available_actions || []);
      const prazo = acoes.map((a) => a.due_date).filter(Boolean).sort()[0] || null;
      out.push({ canal: 'ml', conta: String(conta.ml_user_id), conta_nome: conta.nickname, tipo: 'reclamacao', id: String(c.id),
        texto: ultima?.message || det?.problem || det?.title || 'Reclamação aberta', data: dataDe(ultima?.message_date || c.last_updated),
        situacao: [det?.title, det?.description].filter(Boolean).join(' — ') || null, destinos: destinosDe(c),
        de: ultima?.sender_role === 'mediator' ? 'Mercado Livre' : 'comprador', etapa: c.stage === 'dispute' ? 'mediação' : 'reclamação',
        prazo: dataDe(det?.action_responsible === 'respondent' ? det.due_date : prazo), produto: p.titulo || null, pedido: String(c.resource_id), comprador: p.comprador || null,
        link: `https://www.mercadolivre.com.br/vendas/${c.resource_id}/detalhe` });
    });
    return out;
  }

  async function mensagensML(conta) {
    const id = conta.ml_user_id;
    try {
      const r = await ml(`/messages/unread?role=seller&tag=post_sale`, {}, id);
      for (const x of r.results || []) {
        const pack = /packs\/(\d+)/.exec(x.resource || '')?.[1] || (x.pack_id ? String(x.pack_id) : null);
        if (pack) D.db.prepare('INSERT OR IGNORE INTO msg_packs (ml_user_id, pack_id, visto_em) VALUES (?,?,?)').run(id, pack, agora());
      }
    } catch { /* sem não lidas agora */ }
    D.db.prepare('DELETE FROM msg_packs WHERE ml_user_id=? AND visto_em < ?').run(id, new Date(Date.now() - 15 * 864e5).toISOString());
    const packs = D.db.prepare('SELECT pack_id FROM msg_packs WHERE ml_user_id=?').all(id).map((x) => x.pack_id);
    const out = [];
    await emLotes(packs, 4, async (pack) => {
      const c = await ml(`/messages/packs/${pack}/sellers/${id}?tag=post_sale&mark_as_read=false`, {}, id).catch(() => null);
      const ms = (c?.messages || []).slice().sort((a, b) => String(a.message_date?.created).localeCompare(String(b.message_date?.created)));
      const ultima = ms[ms.length - 1];
      if (!ultima || Number(ultima.from?.user_id) === Number(id)) {   // o vendedor já respondeu: sai da lista
        D.db.prepare('DELETE FROM msg_packs WHERE ml_user_id=? AND pack_id=?').run(id, pack);
        return;
      }
      const p = await pedidoML(id, pack);
      out.push({ canal: 'ml', conta: String(id), conta_nome: conta.nickname, tipo: 'mensagem', id: pack, texto: ultima.text,
        data: dataDe(ultima.message_date?.created), produto: p.titulo || null, pedido: pack, comprador: p.comprador || null,
        para: String(ultima.from?.user_id || ''), link: `https://www.mercadolivre.com.br/vendas/${pack}/detalhe` });
    });
    return out;
  }

  async function chatShopee(loja) {
    const out = [];
    const limite = Date.now() - 30 * 864e5;
    let cursor = null;
    for (let pag = 0; pag < 4; pag++) {
      const p = { direction: 'latest', type: 'all', page_size: 25 };
      if (cursor) { p.next_message_time_nano = cursor.next_message_time_nano; p.conversation_id = cursor.conversation_id; }
      const r = await daLoja(loja.shop_id, '/api/v2/sellerchat/get_conversation_list', p);
      const cs = r.response?.conversations || [];
      let velha = false;
      for (const c of cs) {
        const data = dataDe(c.last_message_timestamp ?? c.latest_message_time ?? null);
        if (data && Date.parse(data) < limite) { velha = true; continue; }
        if (!chatPendente(c)) continue;
        out.push({ canal: 'shopee', conta: String(loja.shop_id), conta_nome: loja.nome || `Shopee ${loja.shop_id}`, tipo: 'chat',
          id: String(c.conversation_id), texto: textoShopee(c.latest_message_type, c.latest_message_content), data,
          comprador: c.to_name || null, para: String(c.to_id), nao_lidas: c.unread_count || 0,
          link: 'https://seller.shopee.com.br/webchat/conversations' });
      }
      cursor = r.response?.page_result?.next_cursor;
      if (velha || !r.response?.page_result?.more || !cursor) break;
    }
    return out;
  }

  // ---------- caixa de entrada ----------
  let cache = null;
  async function caixa(recarregar) {
    if (!recarregar && cache && Date.now() - cache.em < 2 * 60e3) return cache.v;
    const itens = [], erros = [];
    const tarefas = [];
    for (const conta of D.contasListar()) {
      for (const [nome, fn] of [['perguntas', perguntasML], ['reclamações', reclamacoesML], ['mensagens pós-venda', mensagensML]]) {
        tarefas.push(fn(conta).then((ls) => itens.push(...ls)).catch((e) => erros.push(`${conta.nickname}: ${nome} — ${e.message}`)));
      }
    }
    for (const loja of D.shopeeLojasListar()) {
      tarefas.push(chatShopee(loja).then((ls) => itens.push(...ls)).catch((e) => erros.push(`${loja.nome || 'Shopee'}: chat — ${e.message}`)));
    }
    await Promise.all(tarefas);
    itens.sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
    const amazon = !!D.configLer('amazon_lwa_client_id');
    const v = { itens, erros, gerado_em: agora(),
      por_tipo: Object.fromEntries(['pergunta', 'mensagem', 'reclamacao', 'chat'].map((t) => [t, itens.filter((i) => i.tipo === t).length])),
      amazon: amazon ? { link: 'https://sellercentral.amazon.com.br/messaging/inbox', nota: 'A Amazon não libera as mensagens de comprador pela API: responda no Seller Central.' } : null };
    cache = { em: Date.now(), v };
    return v;
  }

  // ---------- uma conversa ----------
  async function conversa(canal, conta, tipo, id) {
    if (canal === 'ml') {
      const c = D.contaObter(Number(conta));
      if (!c) throw erro('Conta do Mercado Livre não conectada.', 404);
      if (tipo === 'pergunta') {
        const q = await ml(`/questions/${id}?api_version=4`, {}, c.ml_user_id);
        // perguntas anteriores do mesmo comprador no mesmo anúncio (contexto)
        const antes = await ml(`/questions/search?item=${q.item_id}&from=${q.from?.id}&api_version=4&limit=10`, {}, c.ml_user_id).catch(() => ({ questions: [] }));
        const ms = [];
        for (const x of (antes.questions || []).filter((x) => x.id !== q.id).sort((a, b) => String(a.date_created).localeCompare(String(b.date_created)))) {
          ms.push({ de: 'comprador', texto: x.text, data: dataDe(x.date_created) });
          if (x.answer?.text) ms.push({ de: 'voce', texto: x.answer.text, data: dataDe(x.answer.date_created) });
        }
        ms.push({ de: 'comprador', texto: q.text, data: dataDe(q.date_created) });
        const tit = await tituloDos(c.ml_user_id, [q.item_id]);
        return { mensagens: ms, produto: tit(q.item_id).titulo || q.item_id, link_produto: tit(q.item_id).link || null, limite: LIMITE.pergunta };
      }
      if (tipo === 'reclamacao') {
        const [ms, cl, det] = await Promise.all([ml(`/post-purchase/v1/claims/${id}/messages`, {}, c.ml_user_id),
          ml(`/post-purchase/v1/claims/${id}`, {}, c.ml_user_id).catch(() => null), ml(`/post-purchase/v1/claims/${id}/detail`, {}, c.ml_user_id).catch(() => null)]);
        const papel = { complainant: 'comprador', respondent: 'voce', mediator: 'Mercado Livre' };
        return { limite: LIMITE.reclamacao, destinos: cl ? destinosDe(cl) : ['complainant'],
          situacao: det ? [det.title, det.description, det.problem && `Problema: ${det.problem}`].filter(Boolean).join(' — ') : null, mensagens: ms.slice().sort((a, b) => String(a.message_date).localeCompare(String(b.message_date)))
          .map((m) => ({ de: papel[m.sender_role] || m.sender_role, texto: m.message, data: dataDe(m.message_date), anexos: (m.attachments || []).length })) };
      }
      if (tipo === 'mensagem') {
        const r = await ml(`/messages/packs/${id}/sellers/${c.ml_user_id}?tag=post_sale&mark_as_read=false`, {}, c.ml_user_id);
        return { limite: LIMITE.mensagem, mensagens: (r.messages || []).slice().sort((a, b) => String(a.message_date?.created).localeCompare(String(b.message_date?.created)))
          .map((m) => ({ de: Number(m.from?.user_id) === Number(c.ml_user_id) ? 'voce' : 'comprador', texto: m.text, data: dataDe(m.message_date?.created),
            anexos: (m.message_attachments || []).length })) };
      }
    }
    if (canal === 'shopee' && tipo === 'chat') {
      const loja = D.shopeeLojaObter(Number(conta));
      if (!loja) throw erro('Loja da Shopee não conectada.', 404);
      const r = await daLoja(loja.shop_id, '/api/v2/sellerchat/get_message', { conversation_id: id, page_size: 25 });
      const ms = r.response?.messages || [];
      const comprador = ms.find((m) => Number(m.from_shop_id) !== Number(loja.shop_id))?.from_id;
      return { limite: LIMITE.chat, mensagens: ms.slice().sort((a, b) => (a.created_timestamp || 0) - (b.created_timestamp || 0))
        .map((m) => ({ de: Number(m.from_shop_id) === Number(loja.shop_id) || (comprador && Number(m.from_id) !== Number(comprador)) ? 'voce' : 'comprador',
          texto: textoShopee(m.message_type, m.content), data: dataDe(m.created_timestamp) })) };
    }
    throw erro('Conversa inválida.');
  }

  // ---------- responder (escrita na conta: só pela tela) ----------
  async function responder(b) {
    const { canal, conta, tipo, id } = b || {};
    if (!/^\d{1,30}$/.test(String(id || ''))) throw erro('Conversa inválida.');
    const texto = textoValido(b.texto, tipo);
    if (canal === 'ml') {
      const c = D.contaObter(Number(conta));
      if (!c) throw erro('Conta do Mercado Livre não conectada.', 404);
      const post = (caminho, corpo) => ml(caminho, { method: 'POST', body: JSON.stringify(corpo) }, c.ml_user_id);
      if (tipo === 'pergunta') await post('/answers', { question_id: Number(id), text: texto });
      else if (tipo === 'reclamacao') await post(`/post-purchase/v1/claims/${id}/actions/send-message`,
        { receiver_role: b.para === 'mediator' ? 'mediator' : 'complainant', message: texto, attachments: [] });
      else if (tipo === 'mensagem') {
        let para = String(b.para || '');
        if (!/^\d+$/.test(para)) para = String((await pedidoML(c.ml_user_id, id)).comprador_id || '');
        if (!para) throw erro('Não achei o comprador desta conversa.');
        await post(`/messages/packs/${id}/sellers/${c.ml_user_id}?tag=post_sale`, { from: { user_id: c.ml_user_id }, to: { user_id: Number(para) }, text: texto });
        D.db.prepare('DELETE FROM msg_packs WHERE ml_user_id=? AND pack_id=?').run(c.ml_user_id, String(id));
      } else throw erro('Tipo inválido.');
    } else if (canal === 'shopee' && tipo === 'chat') {
      const loja = D.shopeeLojaObter(Number(conta));
      if (!loja) throw erro('Loja da Shopee não conectada.', 404);
      if (!/^\d+$/.test(String(b.para || ''))) throw erro('Não achei o comprador desta conversa.');
      await daLoja(loja.shop_id, '/api/v2/sellerchat/send_message', {}, { to_id: Number(b.para), message_type: 'text', content: { text: texto } });
    } else throw erro('Canal inválido.');
    if (b.modelo) D.db.prepare('UPDATE mensagens_modelos SET usos = usos + 1 WHERE id=?').run(Number(b.modelo));
    if (cache) cache.v.itens = cache.v.itens.filter((i) => !(i.canal === canal && i.conta === String(conta) && i.tipo === tipo && i.id === String(id)));
    return { enviado: true };
  }

  const modelos = () => D.db.prepare('SELECT id, titulo, texto, tipo, usos, atualizado_em FROM mensagens_modelos ORDER BY usos DESC, titulo').all();
  const rotas = {
    'GET /api/mensagens': async (url) => caixa(url.searchParams.get('recarregar') === '1'),
    'GET /api/mensagens/conversa': async (url) => {
      const q = url.searchParams;
      return conversa(q.get('canal'), q.get('conta'), q.get('tipo'), String(q.get('id') || '').replace(/\D/g, ''));
    },
    'POST /api/mensagens/responder': async (_u, b) => responder(b),
    'GET /api/mensagens/modelos': async () => ({ modelos: modelos() }),
    'POST /api/mensagens/modelos': async (_u, b) => {
      const titulo = String(b?.titulo || '').trim().slice(0, 80), texto = String(b?.texto || '').trim();
      if (!titulo) throw erro('Dê um nome à mensagem padrão.');
      if (!texto || texto.length > 2000) throw erro('O texto precisa ter de 1 a 2.000 caracteres.');
      const tipo = ['pergunta', 'mensagem', 'reclamacao', 'chat'].includes(b?.tipo) ? b.tipo : null;
      if (b?.id) D.db.prepare('UPDATE mensagens_modelos SET titulo=?, texto=?, tipo=?, atualizado_em=? WHERE id=?').run(titulo, texto, tipo, agora(), Number(b.id));
      else D.db.prepare('INSERT INTO mensagens_modelos (titulo, texto, tipo, atualizado_em) VALUES (?,?,?,?)').run(titulo, texto, tipo, agora());
      return { modelos: modelos() };
    },
    'POST /api/mensagens/modelos/apagar': async (_u, b) => {
      D.db.prepare('DELETE FROM mensagens_modelos WHERE id=?').run(Number(b?.id));
      return { modelos: modelos() };
    },
  };
  return { rotas, rotasParam: [] };
}

module.exports = { criar, dataDe, reclamacaoPendente, destinosDe, chatPendente, textoShopee, preencher, textoValido, LIMITE };
