'use strict';
// node test-servidor.js — sobe os dois servidores de verdade (portas aleatórias, banco
// temporário) e confere as fronteiras de segurança:
//   - pela porta PÚBLICA (a que o túnel expõe) o painel funciona, mas a senha nunca é
//     criada por ali, o login tem limite de tentativas e o cookie é Secure;
//   - PAINEL_ONLINE=0 deixa a porta pública só com /saude, /webhook e /callback;
//   - a porta local só atende localhost e recusa POST vindo de outro site;
//   - o primeiro acesso cria a senha uma única vez; o state do OAuth é de uso único.
const path = require('node:path');
const os = require('node:os');
process.env.ML_DB_FILE = path.join(os.tmpdir(), `teste-srv-${process.pid}-${Date.now()}.sqlite`);
process.env.ML_DB_KEY = 'chave-de-teste-nao-usar-em-producao';
delete process.env.ML_CLIENT_ID;
delete process.env.ML_CLIENT_SECRET;
const assert = require('node:assert');
const http = require('node:http');
const S = require('./server.js');
const D = require('./db.js');

const TUNEL = 'https://teste-da-aula.trycloudflare.com';

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
  // Porta ocupada em qualquer pilha não pode parecer livre. Regressão real: um painel em
  // [::]:3100 passou por "livre" e a cópia da aula subiu por cima, em 127.0.0.1:3100.
  const net = require('node:net');
  const Pr = require('./processos.js');
  for (const host of [undefined, '127.0.0.1']) {
    const outro = net.createServer();
    await new Promise((ok) => outro.listen(0, host, ok));
    assert.strictEqual(await Pr.portaLivre(outro.address().port), false,
      `porta ocupada em ${host || 'todas as interfaces'} tem de contar como ocupada`);
    await new Promise((ok) => outro.close(ok));
  }

  const srv = await S.iniciar({
    porta: 0, portaPublica: 0,
    servicos: { tunel: () => ({ estado: 'online', provedor: 'cloudflared', url: TUNEL, verificado: true }), scraper: () => null },
  });
  const P = srv.porta, PUB = srv.portaPublica;
  const form = (o) => new URLSearchParams(o).toString();
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const ORIGEM = { Origin: `http://localhost:${P}` };
  let r;

  try {
    // ---------- porta pública ----------
    r = await pedir(PUB, '/saude');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.corpo).app, 'aula-ml');
    // Pela internet, ANTES de existir senha: nada de primeiro acesso por ali.
    const DE_FORA = { Host: 'teste-da-aula.trycloudflare.com', 'Cf-Connecting-Ip': '203.0.113.10' };
    const ORIGEM_TUNEL = { Origin: TUNEL };
    for (const c of ['/', '/configuracao.html', '/primeiro-acesso', '/login']) {
      r = await pedir(PUB, c, { headers: DE_FORA });
      assert.strictEqual(r.status, 403, `sem senha, ${c} pela internet manda criar no computador (deu ${r.status})`);
      assert.match(r.corpo, /Crie a senha no computador/);
      assert.ok(r.corpo.includes(`localhost:${P}`), 'mostra a porta REAL do painel, não a padrão');
    }
    r = await pedir(PUB, '/primeiro-acesso', { metodo: 'POST', headers: { ...DE_FORA, ...ORIGEM_TUNEL, 'Content-Type': 'application/x-www-form-urlencoded' },
      corpo: 'senha=tomar-conta-1&confirmacao=tomar-conta-1' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(D.senhaDefinida(), false, 'quem acha a URL não cria a senha antes do aluno');
    r = await pedir(PUB, '/api/config', { headers: DE_FORA });
    assert.strictEqual(r.status, 401);
    r = await pedir(PUB, '/api/items', { metodo: 'POST', headers: DE_FORA, corpo: '{}' });
    assert.strictEqual(r.status, 403, 'POST pela internet sem Origin do próprio painel é recusado');

    // PAINEL_ONLINE=0: a porta pública volta a ter só /callback e /webhook
    process.env.PAINEL_ONLINE = '0';
    r = await pedir(PUB, '/configuracao.html', { headers: DE_FORA });
    assert.strictEqual(r.status, 404);
    r = await pedir(PUB, '/', { headers: DE_FORA });
    assert.ok(r.corpo.includes(`localhost:${P}`), 'a página explicativa mostra a porta real');
    delete process.env.PAINEL_ONLINE;

    r = await pedir(PUB, '/webhook', { metodo: 'POST', corpo: JSON.stringify({ topic: 'items', resource: '/items/MLB1' }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(D.notificacoesListar()[0].topic, 'items');
    r = await pedir(PUB, '/webhook', { metodo: 'POST', corpo: 'lixo' });
    assert.strictEqual(r.status, 200, 'webhook com lixo responde 200 (erro faz a ML desativar a URL)');

    r = await pedir(PUB, '/callback?code=TG-x&state=nao-existe');
    assert.strictEqual(r.status, 400);
    assert.match(r.corpo, /expirada ou desconhecida/);
    r = await pedir(PUB, '/callback?error=x&error_description=' + encodeURIComponent('<script>alert(1)</script>'));
    assert.ok(!r.corpo.includes('<script>alert'), 'o que vem na URL do retorno sai escapado');

    // ---------- painel: só localhost ----------
    r = await pedir(P, '/', { headers: { Host: 'site-malicioso.com' } });
    assert.strictEqual(r.status, 403, 'Host de fora = DNS rebinding');
    r = await pedir(P, '/api/ping');
    assert.strictEqual(JSON.parse(r.corpo).app, 'aula-ml');

    // ---------- primeiro acesso ----------
    r = await pedir(P, '/');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/primeiro-acesso');
    r = await pedir(P, '/api/config');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(JSON.parse(r.corpo).primeiro_acesso, true);
    r = await pedir(P, '/login');
    assert.strictEqual(r.headers.location, '/primeiro-acesso');

    const senha = form({ senha: 'senha-da-aula', confirmacao: 'senha-da-aula' });
    for (const [origem, site] of [['https://site-malicioso.com', 'cross-site'], ['null', undefined], ['null', 'cross-site']]) {
      const h = { ...FORM, Origin: origem, ...(site ? { 'Sec-Fetch-Site': site } : {}) };
      r = await pedir(P, '/primeiro-acesso', { metodo: 'POST', headers: h, corpo: senha });
      assert.strictEqual(r.status, 403, `outro site (Origin ${origem}, ${site}) não cria a senha do aluno`);
      assert.strictEqual(D.senhaDefinida(), false);
    }
    r = await pedir(P, '/primeiro-acesso');
    assert.strictEqual(r.headers['referrer-policy'], 'same-origin',
      'no-referrer faz o navegador mandar Origin: null no POST e trava o login');
    r = await pedir(P, '/primeiro-acesso', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: form({ senha: 'curta', confirmacao: 'curta' }) });
    assert.strictEqual(r.status, 400);
    r = await pedir(P, '/primeiro-acesso', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: form({ senha: 'senha-da-aula', confirmacao: 'outra-coisa' }) });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(D.senhaDefinida(), false);

    r = await pedir(P, '/primeiro-acesso', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: senha });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/configuracao.html');
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    assert.match(cookie, /^aula_ml_sess=[a-f0-9]{64}$/);
    assert.match(String(r.headers['set-cookie']), /HttpOnly/);
    const COOKIE = { Cookie: cookie };

    r = await pedir(P, '/primeiro-acesso');
    assert.strictEqual(r.headers.location, '/login', 'com senha criada, o primeiro acesso some');
    r = await pedir(P, '/primeiro-acesso', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: form({ senha: 'tomar-conta-1', confirmacao: 'tomar-conta-1' }) });
    assert.ok(D.senhaConfere('senha-da-aula'), 'ninguém refaz o primeiro acesso por cima');

    // ---------- painel online (pela internet), depois de a senha existir ----------
    const FORM_FORA = (ip) => ({ ...FORM, ...ORIGEM_TUNEL, Host: 'teste-da-aula.trycloudflare.com', 'Cf-Connecting-Ip': ip });
    r = await pedir(PUB, '/configuracao.html', { headers: DE_FORA });
    assert.strictEqual(r.headers.location, '/login', 'pela internet, sem sessão, vai para o login');
    r = await pedir(PUB, '/primeiro-acesso', { headers: DE_FORA });
    assert.strictEqual(r.headers.location, '/login');
    r = await pedir(PUB, '/login', { metodo: 'POST', headers: { ...FORM_FORA('203.0.113.20'), Origin: 'https://site-malicioso.com' }, corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 403, 'login online vindo de outro site é recusado');

    // limite por IP: 5 erros bloqueiam aquele IP, mesmo que depois acerte a senha
    for (let i = 0; i < 5; i++) {
      r = await pedir(PUB, '/login', { metodo: 'POST', headers: FORM_FORA('198.51.100.1'), corpo: form({ senha: `chute-${i}` }) });
      assert.strictEqual(r.status, 401);
    }
    r = await pedir(PUB, '/login', { metodo: 'POST', headers: FORM_FORA('198.51.100.1'), corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 429, 'IP bloqueado não entra nem com a senha certa');
    assert.match(r.corpo, /Muitas tentativas/);

    // outro IP entra normalmente, com cookie Secure
    r = await pedir(PUB, '/login', { metodo: 'POST', headers: FORM_FORA('198.51.100.2'), corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 302);
    assert.match(String(r.headers['set-cookie']), /; Secure/, 'cookie pela internet é Secure');
    const COOKIE_FORA = { ...DE_FORA, Cookie: String(r.headers['set-cookie']).split(';')[0] };
    r = await pedir(PUB, '/api/config', { headers: COOKIE_FORA });
    assert.strictEqual(r.status, 200, 'com sessão, o painel funciona pela internet');
    r = await pedir(PUB, '/configuracao.html', { headers: COOKIE_FORA });
    assert.strictEqual(r.status, 200);

    // ---------- configuração ----------
    r = await pedir(P, '/api/config', { headers: COOKIE });
    assert.strictEqual(r.status, 200);
    let c = JSON.parse(r.corpo);
    assert.strictEqual(c.tunel.url, TUNEL);
    assert.strictEqual(c.pendente, 'credenciais');
    assert.strictEqual(c.tem_credenciais, false);
    r = await pedir(P, '/api/config/resumo', { headers: COOKIE });
    assert.deepStrictEqual(JSON.parse(r.corpo).pendente, 'credenciais');

    r = await pedir(P, '/api/config/credenciais', { metodo: 'POST', headers: { ...COOKIE, ...ORIGEM }, corpo: JSON.stringify({ app_id: 'abc', secret: 'x' }) });
    assert.strictEqual(r.status, 400, 'App ID com letra é recusado antes de ir ao ML');

    r = await pedir(P, '/auth', { headers: COOKIE });
    assert.strictEqual(r.headers.location, '/configuracao.html?erro=credenciais');

    // ---------- OAuth: state no servidor, de uso único ----------
    D.configGravar('ml_client_id', '1234567890');
    D.configGravar('ml_client_secret', 'segredo-falso-de-teste-123');
    r = await pedir(P, '/auth', { headers: COOKIE });
    assert.strictEqual(r.status, 302);
    const destino = new URL(r.headers.location);
    assert.strictEqual(destino.host, 'auth.mercadolivre.com.br');
    assert.strictEqual(destino.searchParams.get('redirect_uri'), `${TUNEL}/callback`, 'o retorno vai para o túnel');
    const state = destino.searchParams.get('state');
    assert.match(state, /^[a-f0-9]{32}$/);

    r = await pedir(PUB, `/callback?code=TG-falso&state=${state}`);
    assert.ok(!/expirada ou desconhecida/.test(r.corpo), 'o state emitido pelo /auth é aceito');
    assert.ok(r.corpo.includes(`http://localhost:${P}/configuracao.html`), 'o link de volta aponta para o painel local');
    r = await pedir(PUB, `/callback?code=TG-falso&state=${state}`);
    assert.match(r.corpo, /expirada ou desconhecida/, 'o mesmo state não vale duas vezes');

    // "Conectar conta" feito pelo celular volta para o endereço público, não para localhost
    r = await pedir(PUB, '/auth', { headers: COOKIE_FORA });
    assert.strictEqual(r.status, 302);
    const stateFora = new URL(r.headers.location).searchParams.get('state');
    r = await pedir(PUB, `/callback?code=TG-falso&state=${stateFora}`);
    assert.ok(r.corpo.includes(`${TUNEL}/configuracao.html`), 'quem conectou pela internet volta pela internet');

    // limite geral online: trocar de IP a cada chute não contorna (30 erros somados)
    for (let i = 0; i < 25; i++) {
      await pedir(PUB, '/login', { metodo: 'POST', headers: FORM_FORA(`192.0.2.${i + 1}`), corpo: form({ senha: `chute-${i}` }) });
    }
    r = await pedir(PUB, '/login', { metodo: 'POST', headers: FORM_FORA('192.0.2.200'), corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 429, 'depois de 30 erros pela internet, o login online fecha');
    r = await pedir(P, '/login', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 302, 'o login no próprio computador nunca é bloqueado pelo que vem de fora');

    // ---------- login, sessão e saída ----------
    r = await pedir(P, '/login', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: form({ senha: 'errada' }) });
    assert.strictEqual(r.status, 401);
    // navegador com política de privacidade estrita: Origin null, mas o próprio navegador diz same-origin
    r = await pedir(P, '/login', { metodo: 'POST', headers: { ...FORM, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' },
      corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 302, 'login do próprio painel entra mesmo com Origin null');
    r = await pedir(P, '/login', { metodo: 'POST', headers: { ...FORM, ...ORIGEM }, corpo: form({ senha: 'senha-da-aula' }) });
    assert.strictEqual(r.status, 302);
    const COOKIE2 = { Cookie: String(r.headers['set-cookie']).split(';')[0] };

    // ---------- estáticos ----------
    r = await pedir(P, '/aviso.js');
    assert.strictEqual(r.status, 302, 'estático também exige login');
    r = await pedir(P, '/aviso.js', { headers: COOKIE2 });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/javascript/);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    for (const c of ['/..%2fserver.js', '/%2e%2e/db.js', '/..%5cserver.js', '/%E0%A4%A']) {
      r = await pedir(P, c, { headers: COOKIE2 });
      assert.ok([400, 403, 404].includes(r.status), `não pode escapar de public/: ${c} (deu ${r.status})`);
      assert.ok(!r.corpo.includes('use strict'), `não pode vazar código: ${c}`);
    }

    r = await pedir(P, '/sair', { metodo: 'POST', headers: { ...COOKIE2, ...ORIGEM } });
    assert.strictEqual(r.headers.location, '/login');
    r = await pedir(P, '/api/config', { headers: COOKIE2 });
    assert.strictEqual(r.status, 401, 'depois de sair, o cookie antigo não vale');

    console.log("OK — painel local e online, senha só no computador, limite de tentativas, OAuth de uso único, sessão");
  } finally {
    await srv.fechar();
    D.db.close();
    for (const f of [process.env.ML_DB_FILE, process.env.ML_DB_FILE + '-wal', process.env.ML_DB_FILE + '-shm']) {
      try { require('node:fs').unlinkSync(f); } catch {}
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
