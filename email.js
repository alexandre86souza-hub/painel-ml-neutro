'use strict';
// E-mail do painel (pedido do dono, 27/10/2026): ALERTAS na hora (de 5 em 5 min, juntos num e-mail) e o RELATÓRIO do dia
// anterior às 7h30 (Brasília), com vendas, meta, estoque, pendências e segurança (acessos). SMTP com TLS direto (porta 465;
// no Gmail: "senha de app") e AUTH LOGIN, sem biblioteca. Configuração na tela Configurações (só o administrador); a senha
// fica cifrada em `estado` (email_senha). Dados da Amazon só como TOTAL do dia (compromisso: nada de pedido/produto/cliente
// fora do painel). Nenhum dado de cliente vai no e-mail. Nada disto no MCP.
const tls = require('tls');

const erro = (m, status = 400) => Object.assign(new Error(m), { status });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const real = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (v) => (v == null ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%');
const hojeBR = (agora = Date.now()) => new Date(agora - 3 * 3600e3).toISOString().slice(0, 10);
const horaBR = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
// Tipos de aviso do sino que também vão por e-mail (venda nova, pergunta, mensagem… ficam só no sino).
// pausa_ml = o Mercado Livre pausou ou mandou para revisão; a disputa do catálogo (catalogo) vai só no relatório das 7h30.
const TIPOS_EMAIL = new Set(['estoque_leroy', 'estoque_envio', 'seguranca', 'alerta', 'reclamacao', 'pausa_ml']);

// Mensagem MIME (texto + HTML, UTF-8 em base64). Função pura: testada.
function mensagemMime({ de, para, assunto, html, texto }, agora = new Date(), id = Math.random().toString(36).slice(2)) {
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const fronteira = `=_painel_${id}`;
  return [
    `From: Painel <${de}>`, `To: ${para.join(', ')}`, `Subject: =?UTF-8?B?${Buffer.from(assunto, 'utf8').toString('base64')}?=`,
    `Date: ${agora.toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${id}@painel>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${fronteira}"`, '',
    `--${fronteira}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(texto || ''),
    `--${fronteira}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html || ''),
    `--${fronteira}--`, '',
  ].join('\r\n').replace(/^\./gm, '..');
}

// Envio SMTP: TLS direto, EHLO, AUTH LOGIN, MAIL/RCPT/DATA. Sem biblioteca.
function smtpEnviar(cfg, msg) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: cfg.host, port: cfg.porta || 465, servername: cfg.host });
    let buf = '', esperando = null;
    const fila = [];
    // cada resposta completa do servidor (as de várias linhas "250-…" terminam na linha "250 …")
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const linha = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^\d{3}-/.test(linha)) continue;
        if (esperando) { const f = esperando; esperando = null; f(linha); } else fila.push(linha);
      }
    });
    const resposta = () => new Promise((ok) => { if (fila.length) ok(fila.shift()); else esperando = ok; });
    const passo = async (cmd, esperado, msgErro) => {
      if (cmd != null) sock.write(cmd + '\r\n');
      const l = await resposta();
      if (!esperado.includes(Number(l.slice(0, 3)))) throw erro(msgErro || `O servidor de e-mail recusou: ${l}`, msgErro ? 400 : 502);
      return l;
    };
    const timer = setTimeout(() => { sock.destroy(); reject(erro('O servidor de e-mail não respondeu (tempo esgotado).', 502)); }, 30000);
    sock.on('error', (e) => { clearTimeout(timer); reject(erro(`Não consegui falar com o servidor de e-mail: ${e.message}`, 502)); });
    (async () => {
      await passo(null, [220]);
      await passo('EHLO painel', [250]);
      await passo('AUTH LOGIN', [334]);
      await passo(Buffer.from(cfg.usuario).toString('base64'), [334]);
      await passo(Buffer.from(cfg.senha).toString('base64'), [235], 'Usuário ou senha do e-mail recusados. No Gmail, use uma "senha de app" (não a senha da conta).');
      await passo(`MAIL FROM:<${cfg.usuario}>`, [250]);
      for (const r of msg.para) await passo(`RCPT TO:<${r}>`, [250, 251]);
      await passo('DATA', [354]);
      await passo(mensagemMime({ ...msg, de: cfg.usuario }) + '\r\n.', [250]);
      sock.write('QUIT\r\n'); sock.end();
    })().then(() => { clearTimeout(timer); resolve({ ok: true }); }, (e) => { clearTimeout(timer); sock.destroy(); reject(e); });
  });
}

function criar({ D, routes, estoqueMod, comandasMod, resumoEnviosEstoque, resumoCatalogo = () => null }) {
  const config = () => ({
    host: D.configLer('email_host') || 'smtp.gmail.com', porta: Number(D.configLer('email_porta')) || 465,
    usuario: D.configLer('email_usuario') || '', senha: D.configLer('email_senha') || '',
    para: String(D.configLer('email_para') || '').split(/[,;\s]+/).filter(Boolean),
    alertas: D.configLer('email_alertas') !== '0', relatorio: D.configLer('email_relatorio') !== '0',
  });
  const pronto = (c = config()) => !!(c.usuario && c.senha && c.para.length);
  async function mandar(assunto, html, texto) {
    const c = config();
    if (!pronto(c)) throw erro('Configure o e-mail primeiro (usuário, senha de app e destinatário).');
    return smtpEnviar(c, { para: c.para, assunto, html, texto });
  }
  const casca = (titulo, corpo) => `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Segoe UI,Arial,sans-serif;color:#16213a">
<div style="max-width:680px;margin:0 auto;padding:18px"><h1 style="font-size:19px;margin:0 0 12px">${esc(titulo)}</h1>${corpo}
<p style="font-size:12px;color:#5f6b7f;margin-top:18px">Enviado pelo seu painel (painel.amgmetais.com.br). Para mudar ou desligar: Configurações → E-mail de alertas e relatório.</p></div></body></html>`;
  const bloco = (titulo, html) => `<div style="background:#fff;border:1px solid #e3e8f0;border-radius:12px;padding:14px 16px;margin:0 0 12px"><h2 style="font-size:15px;margin:0 0 8px">${esc(titulo)}</h2>${html}</div>`;
  const tabela = (cab, linhas) => `<table style="width:100%;border-collapse:collapse;font-size:13px"><tr>${cab.map((h, i) => `<th style="text-align:${i ? 'right' : 'left'};border-bottom:1px solid #e3e8f0;padding:4px 6px;color:#5f6b7f">${esc(h)}</th>`).join('')}</tr>${linhas.map((l) => `<tr>${l.map((v, i) => `<td style="text-align:${i ? 'right' : 'left'};border-bottom:1px solid #f0f2f6;padding:4px 6px">${v}</td>`).join('')}</tr>`).join('')}</table>`;

  // ---------- alertas: verificações próprias + os avisos do sino dos tipos importantes, juntos de 5 em 5 min ----------
  function verificar() {
    const dia = hojeBR();
    const todas = (chave, titulo, texto, link) => { for (const c of D.contasListar()) D.avisoCriar(c.ml_user_id, { tipo: 'alerta', chave, titulo, texto, link }); };
    try {
      const v = estoqueMod.visao();
      if (v.inicio && v.resumo?.negativos > 0) {
        const lista = (v.produtos || []).filter((p) => p.saldo < 0).slice(0, 8).map((p) => `${p.sku} (${p.saldo})`).join(', ');
        todas(`estoque_negativo:${dia}`, `${v.resumo.negativos} produto(s) com estoque negativo`, lista, '/estoque.html');
      }
    } catch { /* sem estoque */ }
  }
  let enviandoAlertas = false;
  async function alertas() {
    const c = config();
    if (enviandoAlertas || !c.alertas || !pronto(c)) return;
    enviandoAlertas = true;
    try {
      verificar();
      const comandas = await comandasMod.resumoFila().catch(() => null);
      if (comandas?.atrasadas > 0) for (const ct of D.contasListar()) D.avisoCriar(ct.ml_user_id, { tipo: 'alerta', chave: `comandas_atrasadas:${hojeBR()}`,
        titulo: `${comandas.atrasadas} comanda(s) com prazo de envio vencido`, texto: 'Abra a tela Comandas para separar e despachar.', link: '/comandas.html' });
      const ultimo = Number(D.configLer('email_avisos_ultimo_id')) || D.avisosUltimoId();
      if (!D.configLer('email_avisos_ultimo_id')) { D.configGravar('email_avisos_ultimo_id', ultimo); return; }   // começa a partir de agora
      const novos = D.avisosDepoisDe(ultimo).filter((a) => TIPOS_EMAIL.has(a.tipo));
      const maior = D.avisosUltimoId();
      if (novos.length) {
        const vistos = new Set(), lista = novos.filter((a) => (vistos.has(a.chave) ? false : vistos.add(a.chave)));
        const seg = lista.some((a) => a.tipo === 'seguranca');
        const html = casca(seg ? 'Alerta de segurança no painel' : 'Alerta do painel', lista.map((a) => bloco(a.titulo, `<p style="margin:0;font-size:13px">${esc(a.texto || '')}</p><p style="margin:6px 0 0;font-size:12px;color:#5f6b7f">${horaBR(a.criado_em)}</p>`)).join(''));
        await mandar(`${seg ? '⚠ Segurança: ' : 'Alerta: '}${lista[0].titulo}${lista.length > 1 ? ` (+${lista.length - 1})` : ''}`, html, lista.map((a) => `${a.titulo}\n${a.texto || ''}`).join('\n\n'));
      }
      D.configGravar('email_avisos_ultimo_id', maior);
    } catch (e) { D.configGravar('email_erro', `${new Date().toISOString()} ${e.message}`.slice(0, 300)); }
    finally { enviandoAlertas = false; }
  }

  // ---------- relatório do dia anterior ----------
  async function relatorio(diaRef = null) {
    const hoje = hojeBR();
    const ontem = diaRef || hojeBR(Date.now() - 864e5);
    const semanaAntes = new Date(Date.parse(`${ontem}T12:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10);
    const ano = Number(ontem.slice(0, 4)), mes = Number(ontem.slice(5, 7));
    const metas = await routes['GET /api/metas'](new URL(`/api/metas?ano=${ano}&mes=${mes}`, 'http://painel')).catch(() => null);
    const lojas = new Map((metas?.lojas || []).map((l) => [l.canal, l.nome]));
    const dias = D.fatDiaPeriodo(semanaAntes, ontem);
    const porCanal = (d) => { const m = {}; for (const l of dias) if (l.dia === d) m[l.canal] = (m[l.canal] || 0) + l.valor; return m; };
    const o = porCanal(ontem), s = porCanal(semanaAntes);
    const canais = [...new Set([...Object.keys(o), ...Object.keys(s)])].sort((a, b) => (o[b] || 0) - (o[a] || 0));
    const tot = (m) => Object.values(m).reduce((a, v) => a + v, 0);
    const varia = (a, b) => (b ? `${a >= b ? '▲' : '▼'} ${pct(Math.abs(a - b) / b)}` : '—');
    const dataBR = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    const partes = [];
    partes.push(bloco(`Vendas de ontem (${dataBR(ontem)})`, tabela(['Loja', 'Ontem', `${dataBR(semanaAntes)} (semana antes)`, 'Variação'],
      [...canais.map((k) => [esc(lojas.get(k) || k), real(o[k] || 0), real(s[k] || 0), varia(o[k] || 0, s[k] || 0)]),
        ['<b>Total</b>', `<b>${real(tot(o))}</b>`, `<b>${real(tot(s))}</b>`, `<b>${varia(tot(o), tot(s))}</b>`]])
      + '<p style="font-size:12px;color:#5f6b7f;margin:6px 0 0">Vendas pela data da compra, sem as canceladas.</p>'));
    const m = metas?.escolhido;
    if (m) {
      const mesAtual = `${ano}-${String(mes).padStart(2, '0')}` === hoje.slice(0, 7);
      const linhas = [['Vendido no mês', real(m.realizado)], ['Meta do mês', real(m.meta)], ['% da meta', pct(m.pct_meta)], ['Projeção de fechamento', `${real(m.projecao)} (${pct(m.pct_projecao)})`]];
      if (mesAtual && m.precisa_por_dia != null && m.realizado < (m.meta || 0)) linhas.push(['<b>Precisa vender por dia</b>', `<b>${real(m.precisa_por_dia)}</b> nos ${m.dias_para_vender} dia(s) que faltam`]);
      linhas.push(['Situação', esc((m.alerta || '—').toLowerCase())]);
      partes.push(bloco(`Meta de ${['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][mes - 1]}`, tabela(['', ''], linhas)));
    }
    // estoque: envios de ontem por loja, repor, negativos
    const envLinhas = [];
    try {
      for (const x of resumoEnviosEstoque()) {
        const es = D.estoqueEnviosListar(x.canal, 80).filter((e) => hojeBR(Date.parse(e.em)) === ontem);
        const anuncios = es.reduce((a, e) => a + (e.linhas?.length || 0), 0), errosE = es.reduce((a, e) => a + (e.com_erro || 0), 0);
        envLinhas.push([esc(x.nome), x.automatico ? 'ligado' : '<b style="color:#b42318">desligado</b>', String(es.length), String(anuncios), errosE ? `<b style="color:#b42318">${errosE}</b>` : '0']);
      }
    } catch { /* sem envios */ }
    let est = null; try { est = estoqueMod.visao(); } catch { /* sem estoque */ }
    let estHtml = envLinhas.length ? tabela(['Loja', 'Automático', 'Envios', 'Anúncios', 'Erros'], envLinhas) : '';
    if (est?.inicio) estHtml += `<p style="font-size:13px;margin:8px 0 0">Produtos para repor agora: <b>${est.resumo.repor}</b> · próximos de repor: ${est.resumo.proximo}`
      + ` · com estoque negativo: <b style="color:${est.resumo.negativos ? '#b42318' : 'inherit'}">${est.resumo.negativos}</b></p>`;
    if (estHtml) partes.push(bloco('Estoque', estHtml));
    // disputa do catálogo do ML: por conta, quantos ganham/dividem/perdem e os que estão perdendo ("vale baixar" primeiro)
    let catHtml = '';
    for (const ct of D.contasListar()) {
      const r = (() => { try { return resumoCatalogo(ct.ml_user_id); } catch { return null; } })();
      if (!r?.total) continue;
      catHtml += `<p style="font-size:13px;margin:${catHtml ? '12px' : '0'} 0 6px"><b>${esc(ct.nickname || ct.ml_user_id)}</b>: ${r.total} anúncio(s) de catálogo · ganhando <b>${r.ganhando}</b>`
        + ` · dividindo ${r.dividindo} · perdendo <b style="color:${r.perdendo ? '#b42318' : 'inherit'}">${r.perdendo}</b></p>`;
      if (r.lista_perdendo.length) catHtml += tabela(['Anúncio', 'Preço', 'Para ganhar', 'Margem nesse preço', 'Decisão'], r.lista_perdendo.slice(0, 12).map((x) => [
        `${esc(String(x.titulo || '').slice(0, 48))}<br><span style="color:#5f6b7f;font-size:11px">${esc(x.id)}</span>`, real(x.preco), real(x.preco_ganhar),
        x.margem_ganhar != null ? pct(x.margem_ganhar) : esc(x.lucro_erro ? 'sem custo/frete' : '—'),
        x.veredito === 'vale' ? '<b style="color:#0b6b33">vale baixar</b>' : x.veredito === 'nao_compensa' ? '<span style="color:#b42318">não compensa</span>' : '—']));
    }
    if (catHtml) partes.push(bloco('Catálogo do Mercado Livre (disputa pelo botão de compra)', catHtml
      + `<p style="font-size:12px;color:#5f6b7f;margin:6px 0 0">"Vale baixar" = no preço para ganhar a margem fica em ${D.configLer('catalogo_margem_min') || 15}% ou mais. O painel não muda preço sozinho.</p>`));
    // pendências
    const fila = await comandasMod.resumoFila().catch(() => null);
    const pendLinhas = [];
    if (fila) pendLinhas.push(['Comandas para imprimir', String(fila.nao_impressas)], ['Comandas com prazo vencido', String(fila.atrasadas)]);
    if (est) pendLinhas.push(['Devoluções esperando conferência (fora do estoque)', String((est.pendentes || []).filter((p) => /^devolucao/.test(p.ref)).length)],
      ['Vendas com SKU sem produto (estoque pendente)', String((est.pendentes || []).filter((p) => p.motivo === 'sku').length)]);
    const naoLidos = D.contasListar().reduce((a, c) => Math.max(a, D.avisosNaoLidos(c.ml_user_id)), 0);
    pendLinhas.push(['Avisos não lidos no sino', String(naoLidos)]);
    partes.push(bloco('Pendências', tabela(['', ''], pendLinhas)));
    // segurança: acessos de ontem
    const ac = D.acessosDoDia(ontem);
    const okI = ac.filter((a) => a.ok && a.onde === 'internet'), erros = ac.filter((a) => !a.ok);
    const porIp = {}; for (const a of erros) porIp[a.ip || '?'] = (porIp[a.ip || '?'] || 0) + 1;
    const mud = D.auditoriaDoDia(ontem).filter((x) => ['SENHA', '2FA'].includes(x.metodo) || /usuarios/.test(x.caminho));
    let segHtml = `<p style="font-size:13px;margin:0 0 6px">Entradas pela internet: <b>${okI.length}</b> · tentativas erradas: <b style="color:${erros.length ? '#b42318' : 'inherit'}">${erros.length}</b>`
      + ` · bloqueios por tentativas: <b>${ac.filter((a) => a.motivo === 'bloqueado').length}</b></p>`;
    if (okI.length) segHtml += tabela(['Quem entrou', 'IP', 'Quando'], okI.slice(0, 15).map((a) => [esc(a.quem), esc(a.ip), horaBR(a.em)]));
    if (erros.length) segHtml += '<p style="font-size:13px;margin:8px 0 4px">Tentativas erradas por IP:</p>' + tabela(['IP', 'Tentativas'], Object.entries(porIp).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, n]) => [esc(ip), String(n)]));
    if (mud.length) segHtml += '<p style="font-size:13px;margin:8px 0 4px">Mudanças de acesso:</p>' + tabela(['Quem', 'O quê', 'Quando'], mud.slice(0, 10).map((x) => [esc(x.quem), esc(`${x.metodo} ${x.caminho}`), horaBR(x.em)]));
    if (!erros.length && !ac.some((a) => a.ip_novo)) segHtml += '<p style="font-size:13px;margin:6px 0 0;color:#0b6b33">✓ Nenhum sinal de invasão: sem tentativas erradas e sem acesso de endereço novo.</p>';
    else if (ac.some((a) => a.ip_novo && a.ok)) segHtml += `<p style="font-size:13px;margin:6px 0 0;color:#b42318">⚠ Entrada de endereço novo: ${ac.filter((a) => a.ip_novo && a.ok).map((a) => `${esc(a.quem)} de ${esc(a.ip)}`).join(', ')}. Se não foi você, troque a senha.</p>`;
    partes.push(bloco('Segurança', segHtml));
    const titulo = `Como foi ${dataBR(ontem)}: ${real(tot(o))} em vendas`;
    const texto = [`Vendas de ontem: ${real(tot(o))} (semana antes: ${real(tot(s))})`, m ? `Mês: ${real(m.realizado)} de ${real(m.meta)} (${pct(m.pct_meta)})` : '',
      m?.precisa_por_dia ? `Precisa vender por dia: ${real(m.precisa_por_dia)}` : '', `Segurança: ${erros.length} tentativa(s) errada(s), ${okI.length} entrada(s) pela internet`].filter(Boolean).join('\n');
    return { assunto: titulo, html: casca(titulo, partes.join('')), texto };
  }
  let enviandoRel = false;
  async function relatorioDiario() {
    const c = config();
    const agora = new Date(Date.now() - 3 * 3600e3);
    if (enviandoRel || !c.relatorio || !pronto(c) || agora.getUTCHours() * 60 + agora.getUTCMinutes() < 7 * 60 + 30) return;
    if (D.configLer('email_relatorio_dia') === hojeBR()) return;
    enviandoRel = true;
    try {
      const r = await relatorio();
      await mandar(r.assunto, r.html, r.texto);
      D.configGravar('email_relatorio_dia', hojeBR());
      D.configGravar('email_relatorio_ultimo', new Date().toISOString());
    } catch (e) { D.configGravar('email_erro', `${new Date().toISOString()} ${e.message}`.slice(0, 300)); }
    finally { enviandoRel = false; }
  }

  const rotas = {
    'GET /api/email/config': async () => { const c = config(); return { host: c.host, porta: c.porta, usuario: c.usuario, tem_senha: !!c.senha, para: c.para.join(', '),
      alertas: c.alertas, relatorio: c.relatorio, ultimo_relatorio: D.configLer('email_relatorio_ultimo'), erro: D.configLer('email_erro') || null }; },
    'PUT /api/email/config': async (_u, b) => {
      const host = String(b?.host || 'smtp.gmail.com').trim(), porta = Number(b?.porta) || 465, usuario = String(b?.usuario || '').trim();
      const para = String(b?.para || '').split(/[,;\s]+/).filter(Boolean);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw erro('Servidor de e-mail inválido (ex.: smtp.gmail.com).');
      if (![465].includes(porta)) throw erro('Use a porta 465 (TLS direto).');
      const ehEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      if (!ehEmail(usuario)) throw erro('Informe o e-mail que vai mandar (o mesmo do login no servidor).');
      if (!para.length || para.length > 5 || !para.every(ehEmail)) throw erro('Informe de 1 a 5 e-mails para receber, separados por vírgula.');
      D.configGravar('email_host', host); D.configGravar('email_porta', String(porta)); D.configGravar('email_usuario', usuario);
      D.configGravar('email_para', para.join(','));
      if (b?.senha) D.configGravar('email_senha', String(b.senha).replace(/\s+/g, ''));   // senha de app do Gmail vem com espaços
      D.configGravar('email_alertas', b?.alertas === false ? '0' : '1');
      D.configGravar('email_relatorio', b?.relatorio === false ? '0' : '1');
      return { ok: true };
    },
    'POST /api/email/teste': async () => { await mandar('Teste do painel: o e-mail está funcionando', casca('O e-mail está funcionando', bloco('Tudo certo', '<p style="margin:0">A partir de agora você recebe aqui os alertas do painel e o relatório do dia anterior às 7h30.</p>')), 'O e-mail do painel está funcionando.'); D.configGravar('email_erro', ''); return { ok: true }; },
    'POST /api/email/relatorio': async () => { const r = await relatorio(); await mandar(r.assunto, r.html, r.texto); return { ok: true, assunto: r.assunto }; },
  };
  return { rotas, alertas, relatorioDiario, relatorio, verificar };
}

module.exports = { criar, mensagemMime, smtpEnviar, TIPOS_EMAIL };
