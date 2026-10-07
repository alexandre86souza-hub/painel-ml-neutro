'use strict';
// node test-usuarios.js — usuários do escritório: permissão negada por padrão, cada tela de um módulo
// só chama rotas que o módulo libera, senha temporária, 2FA por pessoa, conta do ML por sessão,
// bloqueio e registro de ações. Sobe o servidor de verdade (portas aleatórias, banco temporário).
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.ML_DB_FILE = path.join(os.tmpdir(), `teste-usu-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = 'chave-de-teste-nao-usar-em-producao';
const assert = require('node:assert');
const http = require('node:http');
const U = require('./usuarios.js');
const SEG = require('./seguranca.js');

// ---------- regras (funções puras) ----------
const exp = { admin: false, modulos: ['expedicao'] };
assert.ok(U.permitido(exp, 'GET', '/comandas.html'));
assert.ok(U.permitido(exp, 'POST', '/api/comandas/impressas'));
assert.ok(U.permitido(exp, 'GET', '/menu.js'), 'arquivos sem dado são livres');
assert.ok(U.permitido(exp, 'GET', '/api/marca'), 'menu e marca: todo mundo');
assert.ok(!U.permitido(exp, 'GET', '/'), 'Dashboard é do módulo de vendas');
assert.ok(!U.permitido(exp, 'GET', '/financeiro.html'));
assert.ok(!U.permitido(exp, 'GET', '/api/financeiro'));
assert.ok(!U.permitido(exp, 'GET', '/configuracao.html'), 'Configurações: só o administrador');
assert.ok(!U.permitido(exp, 'GET', '/api/config'));
assert.ok(!U.permitido(exp, 'PUT', '/api/amazon/config'), 'ler a config (menu) sim; gravar não');
assert.ok(!U.permitido(exp, 'GET', '/api/usuarios'));
assert.ok(!U.permitido(exp, 'GET', '/auth'), 'conectar conta do ML: só o administrador');
assert.ok(!U.permitido(exp, 'GET', '/api/rota-nova-qualquer'), 'rota nova nasce fechada');
assert.ok(!U.permitido({ admin: false, modulos: ['anuncios'] }, 'PUT', '/api/empresa'), 'ler a empresa sim; gravar não');
assert.ok(!U.permitido({ admin: false, modulos: ['anuncios'] }, 'POST', '/api/produtos-custo'), 'colar a tabela de custos: administrador');
assert.ok(U.permitido({ admin: true }, 'GET', '/api/usuarios'));
assert.ok(!U.permitido(null, 'GET', '/comandas.html'));
assert.strictEqual(U.primeiraPagina(exp), '/comandas.html');
assert.strictEqual(U.primeiraPagina({ admin: false, modulos: ['vendas', 'expedicao'] }), '/');
assert.strictEqual(U.primeiraPagina({ admin: false, modulos: [] }), '/sem-acesso');
assert.deepStrictEqual(U.limparModulos(['vendas', 'vendas', 'tudo', 3]), ['vendas']);
assert.throws(() => U.validarUsuario({ login: 'admin', nome: 'X' }), /administrador/);
assert.throws(() => U.validarUsuario({ login: 'Jo', nome: 'X' }), /3 a 30/);
assert.deepStrictEqual(U.validarUsuario({ login: ' Maria.S ', nome: ' Maria ', modulos: ['expedicao'] }), { login: 'maria.s', nome: 'Maria', modulos: ['expedicao'] });
for (let i = 0; i < 50; i++) assert.strictEqual(SEG.problemaSenha(U.senhaTemporaria()), null, 'senha temporária passa pela política');

// ---------- cada tela de um módulo só chama rotas liberadas para o módulo ----------
// (o que a tela tem só para o administrador — conexão e diagnóstico — fica na lista abaixo)
const SO_ADMIN = { '/leroy.html': [/^\/api\/leroy\/(diagnostico|remover)/], '/anuncios.html': [/^\/api\/(produtos-custo|empresa|imposto)$/],
  '/vendas.html': [], '/produtos.html': [] };
for (const m of U.MODULOS) {
  const quem = { admin: false, modulos: [m.id] };
  for (const pg of m.paginas) {
    const html = fs.readFileSync(path.join(__dirname, 'public', pg), 'utf8');
    const rotas = new Set([...html.matchAll(/\/api\/[a-zA-Z0-9/_.${}-]*/g)].map((x) => x[0]
      .replace(/^\/api\/\$\{[^}]*\}/, '/api/amazon').replace(/\/\$\{[^}]*\}?/g, '/X').replace(/\$\{[^}]*\}?/g, '').replace(/\/$/, '')));
    // telas que trocam o começo da rota pela conta: ${BASE}/performance = /api/performance, /api/amazon/performance…
    for (const x of html.matchAll(/\$\{BASE\}(\/[a-zA-Z0-9/_-]*)/g)) {
      for (const b of ['/api', '/api/amazon', '/api/leroy', '/api/magalu', '/api/shopee']) rotas.add(b + x[1]);
    }
    for (const rota of rotas) {
      if (/^\/api(\/(amazon|leroy|magalu|shopee))?$/.test(rota) || rota.includes('{') || (SO_ADMIN[pg] || []).some((r) => r.test(rota))) continue;
      const ok = ['GET', 'POST', 'PUT'].some((mt) => U.permitido(quem, mt, rota));
      assert.ok(ok, `${pg} (módulo ${m.id}) chama ${rota}, que o módulo não libera`);
    }
  }
}
// toda tela do painel está num módulo ou é de administrador (de propósito)
const ADMIN = ['/configuracao.html', '/empresa.html', '/shopee.html', '/amazon.html', '/magalu.html', '/amazon-ads.html', '/navegador.html', '/usuarios.html'];
for (const f of fs.readdirSync(path.join(__dirname, 'public')).filter((x) => x.endsWith('.html'))) {
  const pg = '/' + f;
  assert.ok(ADMIN.includes(pg) || U.MODULOS.some((m) => m.paginas.includes(pg)), `${pg}: ponha num módulo de usuarios.js ou na lista de administrador`);
}

// ---------- servidor de verdade ----------
const S = require('./server.js');
const D = require('./db.js');
function pedir(porta, caminho, { metodo = 'GET', headers = {}, corpo = null } = {}) {
  return new Promise((ok, falha) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: { Host: `localhost:${porta}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, corpo: b }));
    });
    req.on('error', falha);
    if (corpo) req.write(corpo);
    req.end();
  });
}

(async () => {
  const srv = await S.iniciar({ porta: 0, portaPublica: 0,
    servicos: { tunel: () => ({ estado: 'online', provedor: 'cloudflared', url: 'https://teste.trycloudflare.com', verificado: true }), scraper: () => null } });
  const P = srv.porta;
  const form = (o) => new URLSearchParams(o).toString();
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://localhost:${P}` };
  const JSONH = { 'Content-Type': 'application/json', Origin: `http://localhost:${P}` };
  const cookieDe = (r) => String(r.headers['set-cookie']).split(';')[0];
  let r;
  try {
    // administrador pronto (senha + 2FA)
    D.senhaDefinir('Senha-do-dono-2026!');
    const segDono = SEG.novoSegredo();
    D.configGravar('painel_2fa_segredo', segDono);
    D.configGravar('painel_2fa_em', new Date().toISOString());
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ senha: 'Senha-do-dono-2026!', codigo: SEG.codigoTotp(segDono, SEG.passoDe(Date.now())) }) });
    assert.strictEqual(r.status, 302, 'o administrador entra sem usuário, como sempre');
    const ADM = { Cookie: cookieDe(r) };
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'admin', senha: 'Senha-do-dono-2026!', codigo: SEG.codigoTotp(segDono, SEG.passoDe(Date.now())) }) });
    assert.strictEqual(r.status, 302, '… ou com "admin"');

    // cria a Maria (expedição)
    r = await pedir(P, '/api/usuarios', { metodo: 'POST', headers: { ...ADM, ...JSONH }, corpo: JSON.stringify({ login: 'maria', nome: 'Maria', modulos: ['expedicao'] }) });
    assert.strictEqual(r.status, 200, r.corpo);
    const { id, senha_temporaria: temp } = JSON.parse(r.corpo);
    assert.ok(!JSON.stringify(D.usuariosListar()).includes(temp), 'a senha temporária não fica no banco');
    r = await pedir(P, '/api/usuarios', { metodo: 'POST', headers: { ...ADM, ...JSONH }, corpo: JSON.stringify({ login: 'maria', nome: 'Outra' }) });
    assert.strictEqual(r.status, 400, 'login repetido');

    // 1º login: senha temporária -> trocar -> ativar 2FA
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'maria', senha: 'errada-123!' }) });
    assert.strictEqual(r.status, 401);
    assert.match(r.corpo, /Usuário ou senha incorretos/);
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'ninguem', senha: temp }) });
    assert.strictEqual(r.status, 401, 'usuário que não existe: a mesma mensagem');
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'Maria', senha: temp }) });
    assert.strictEqual(r.status, 302);
    let MARIA = { Cookie: cookieDe(r) };
    r = await pedir(P, '/comandas.html', { headers: MARIA });
    assert.strictEqual(r.headers.location, '/trocar-senha', 'senha temporária: troca antes de tudo');
    r = await pedir(P, '/api/comandas', { headers: MARIA });
    assert.strictEqual(r.status, 403);
    r = await pedir(P, '/ativar-2fa', { headers: MARIA });
    assert.strictEqual(r.headers.location, '/trocar-senha', 'nem o 2FA antes de trocar a senha temporária');
    r = await pedir(P, '/trocar-senha', { headers: MARIA });
    assert.match(r.corpo, /senha temporária/);
    r = await pedir(P, '/trocar-senha', { metodo: 'POST', headers: { ...MARIA, ...FORM }, corpo: form({ atual: temp, nova: 'Maria-senha-2026!', confirmacao: 'Maria-senha-2026!' }) });
    assert.strictEqual(r.status, 302);
    assert.ok(!D.senhaConfere('Maria-senha-2026!'), 'a senha da Maria não mexe na do administrador');
    MARIA = { Cookie: cookieDe(r) };
    r = await pedir(P, '/comandas.html', { headers: MARIA });
    assert.strictEqual(r.headers.location, '/ativar-2fa');
    await pedir(P, '/ativar-2fa', { headers: MARIA });
    const pend = D.usuarioMfa(id).pendente;
    assert.ok(pend);
    assert.strictEqual(D.configLer('painel_2fa_segredo'), segDono, 'o 2FA da Maria é só dela');
    r = await pedir(P, '/ativar-2fa', { metodo: 'POST', headers: { ...MARIA, ...FORM }, corpo: form({ codigo: SEG.codigoTotp(pend, SEG.passoDe(Date.now())) }) });
    assert.strictEqual(r.headers.location, '/comandas.html');
    const codigoMaria = () => SEG.codigoTotp(D.usuarioMfa(id).segredo, SEG.passoDe(Date.now()));

    // com 2FA ativo: sem o código não entra
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'maria', senha: 'Maria-senha-2026!' }) });
    assert.strictEqual(r.status, 401);
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'maria', senha: 'Maria-senha-2026!', codigo: codigoMaria() }) });
    assert.strictEqual(r.headers.location, '/comandas.html', 'entra direto na tela dela');
    MARIA = { Cookie: cookieDe(r) };

    // o que ela pode e o que não pode
    r = await pedir(P, '/comandas.html', { headers: MARIA });
    assert.strictEqual(r.status, 200);
    for (const pg of ['/', '/financeiro.html', '/configuracao.html', '/usuarios.html']) {
      r = await pedir(P, pg, { headers: MARIA });
      assert.strictEqual(r.headers.location, '/comandas.html', `${pg} volta para a tela dela`);
    }
    for (const [m, rota] of [['GET', '/api/financeiro'], ['GET', '/api/config'], ['GET', '/api/usuarios'], ['GET', '/api/vendas'],
      ['POST', `/api/usuarios/${id}/zerar-2fa`], ['POST', '/api/accounts/remove']]) {
      r = await pedir(P, rota, { metodo: m, headers: { ...MARIA, ...JSONH }, corpo: m === 'POST' ? '{}' : null });
      assert.strictEqual(r.status, 403, `${m} ${rota} recusado para a expedição`);
    }
    r = await pedir(P, '/api/eu', { headers: MARIA });
    assert.deepStrictEqual(JSON.parse(r.corpo).paginas, ['/comandas.html']);
    r = await pedir(P, '/api/marca', { headers: MARIA });
    assert.strictEqual(r.status, 200);

    // conta do ML escolhida é da sessão: a Maria trocar não muda a do administrador
    D.contaSalvar({ access_token: 'a', refresh_token: 'b', expires_in: 21600 }, { id: 111, nickname: 'LOJA_A', site_id: 'MLB' });
    D.contaSalvar({ access_token: 'a', refresh_token: 'b', expires_in: 21600 }, { id: 222, nickname: 'LOJA_B', site_id: 'MLB' });
    {
      D.contaAtivaDefinir(111);
      r = await pedir(P, '/api/accounts/active', { metodo: 'POST', headers: { ...MARIA, ...JSONH }, corpo: JSON.stringify({ ml_user_id: 222 }) });
      assert.strictEqual(r.status, 200, r.corpo);
      assert.strictEqual(JSON.parse((await pedir(P, '/api/accounts', { headers: MARIA })).corpo).ativa, 222);
      assert.strictEqual(JSON.parse((await pedir(P, '/api/accounts', { headers: ADM })).corpo).ativa, 111, 'a do administrador continua');
      assert.strictEqual(Number(D.contaAtivaId()), 111, 'fora de pedido (MCP) vale a geral');
    }

    // registro de ações
    await pedir(P, '/api/comandas/impressas', { metodo: 'POST', headers: { ...MARIA, ...JSONH }, corpo: JSON.stringify({ chaves: ['ml:1'], impressa: true }) });
    const aud = D.auditoriaListar(50);
    assert.ok(aud.some((a) => a.quem === 'maria' && a.caminho === '/api/comandas/impressas'), 'quem imprimiu fica registrado');
    assert.ok(aud.some((a) => a.quem === 'maria' && a.metodo === 'LOGIN' && a.status === 401), 'tentativa errada também');
    assert.ok(!JSON.stringify(aud).includes('Maria-senha'), 'senha nunca vai para o registro');

    // administrador: mudar módulos, bloquear, zerar 2FA, senha temporária nova, remover
    r = await pedir(P, `/api/usuarios/${id}`, { metodo: 'PUT', headers: { ...ADM, ...JSONH }, corpo: JSON.stringify({ nome: 'Maria', modulos: ['expedicao', 'vendas'] }) });
    assert.strictEqual(r.status, 200);
    r = await pedir(P, '/', { headers: MARIA });
    assert.strictEqual(r.status, 200, 'módulo novo vale na hora');
    r = await pedir(P, `/api/usuarios/${id}`, { metodo: 'PUT', headers: { ...ADM, ...JSONH }, corpo: JSON.stringify({ nome: 'Maria', modulos: ['expedicao'], ativo: false }) });
    r = await pedir(P, '/comandas.html', { headers: MARIA });
    assert.strictEqual(r.headers.location, '/login', 'bloqueada: a sessão cai na hora');
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'maria', senha: 'Maria-senha-2026!', codigo: codigoMaria() }) });
    assert.strictEqual(r.status, 401, 'bloqueada não entra');
    await pedir(P, `/api/usuarios/${id}`, { metodo: 'PUT', headers: { ...ADM, ...JSONH }, corpo: JSON.stringify({ nome: 'Maria', modulos: ['expedicao'], ativo: true }) });
    r = await pedir(P, `/api/usuarios/${id}/zerar-2fa`, { metodo: 'POST', headers: { ...ADM, ...JSONH }, corpo: '{}' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(D.usuarioObter(id).mfa_ativo, false);
    r = await pedir(P, `/api/usuarios/${id}/senha-temporaria`, { metodo: 'POST', headers: { ...ADM, ...JSONH }, corpo: '{}' });
    const temp2 = JSON.parse(r.corpo).senha_temporaria;
    assert.ok(D.usuarioSenhaConfere(id, temp2) && D.usuarioObter(id).senha_temporaria);
    D.db.prepare('UPDATE usuarios SET senha_em=? WHERE id=?').run(new Date(Date.now() - 73 * 3600e3).toISOString(), id);
    r = await pedir(P, '/login', { metodo: 'POST', headers: FORM, corpo: form({ usuario: 'maria', senha: temp2 }) });
    assert.match(r.corpo, /venceu/, 'senha temporária vale 72 h');
    r = await pedir(P, `/api/usuarios/${id}/remover`, { metodo: 'POST', headers: { ...ADM, ...JSONH }, corpo: '{}' });
    assert.strictEqual(D.usuarioObter(id), undefined);

    // usuários fora do MCP
    const mcp = fs.readFileSync(path.join(__dirname, 'mcp.js'), 'utf8');
    assert.ok(!/\/api\/usuarios/.test(mcp), 'usuários fora do MCP');
    console.log('Usuários: permissão por módulo, telas cobertas, senha temporária, 2FA por pessoa, conta por sessão, bloqueio e registro: ok');
  } finally {
    await srv.fechar();
    D.db.close();
    for (const f of [process.env.ML_DB_FILE, process.env.ML_DB_FILE + '-wal', process.env.ML_DB_FILE + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  }
})().catch((e) => { console.error(e); process.exit(1); });
