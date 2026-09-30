'use strict';
// Túnel HTTPS público apontado para a PORTA PÚBLICA do painel (/callback, /webhook e o
// painel online). O cloudflared roda desacoplado do npm start: reiniciar o painel
// reaproveita o mesmo túnel e a MESMA URL (ver _cloudflared).
//
// Provedores, medidos em 18/09/2026:
//   cloudflared (padrão) — trycloudflare.com, sem conta. O pacote npm baixa o binário
//     sozinho. URL em ~8 s; navegador e webhook passam direto.
//   localtunnel (plano B) — loca.lt. O webhook passa, mas o NAVEGADOR cai numa página
//     "Tunnel website ahead!" que pede o IP público (uma vez por IP a cada 7 dias). O
//     pacote está parado desde 2023 e traz 2 vulnerabilidades HIGH (axios 0.21), por
//     isso não entra no package.json: é baixado com npx só se o cloudflared falhar.
// Um túnel NOVO sempre tem URL nova (o loca.lt nem devolve o subdomínio pedido se você
// reconectar logo). Por isso o cloudflared é mantido vivo entre reinícios, e o painel
// compara a URL com o que o ML tem cadastrado.
//
// URL_PUBLICA no .env desliga o túnel: use quando você já tem domínio próprio apontando
// para a porta pública (ex.: túnel nomeado da Cloudflare).
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const P = require('./processos.js');

const ESPERA_URL_MS = 45000;
const ESPERA_VERIFICAR_MS = 60000;
const REINICIO_MS = [5000, 10000, 30000, 60000];
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

// O nome novo do trycloudflare leva alguns segundos para existir no DNS, e o domínio NÃO
// é curinga: perguntar antes disso devolve NXDOMAIN com TTL negativo de 1800 s. Medido em
// 18/09/2026: uma consulta cedo demais deixou o macOS respondendo "não existe" para a URL
// do túnel enquanto 1.1.1.1 e 8.8.8.8 já resolviam — o retorno do login do ML cairia em
// "site não encontrado" por até 30 minutos.
// Por isso a primeira pergunta vai direto aos servidores AUTORITATIVOS da Cloudflare, que
// não guardam cache; só depois que o nome existe alguém consulta pelo caminho normal.
async function esperarDnsAutoritativo(host, prazo, parar = () => false) {
  const dominio = host.split('.').slice(-2).join('.');
  let resolvedor;
  try {
    const ns = await dns.resolveNs(dominio);
    const ips = (await Promise.all(ns.map((n) => dns.resolve4(n).catch(() => [])))).flat();
    if (!ips.length) return true; // sem como perguntar direto: segue e deixa o teste HTTP decidir
    resolvedor = new dns.Resolver({ timeout: 3000, tries: 1 });
    resolvedor.setServers(ips);
  } catch { return true; }
  while (Date.now() < prazo && !parar()) {
    try { if ((await resolvedor.resolve4(host)).length) return true; } catch {}
    await dormir(1500);
  }
  return false;
}

// ---------- túnel salvo (persistente entre reinícios) ----------
function lerEstadoTunel(arquivo) {
  try { return arquivo ? JSON.parse(fs.readFileSync(arquivo, 'utf8')) : null; } catch { return null; }
}
function gravarEstadoTunel(arquivo, estado) {
  if (arquivo) try { fs.writeFileSync(arquivo, JSON.stringify(estado, null, 2)); } catch {}
}
// Vivo E nosso: o sistema reaproveita números de PID, então a linha de comando tem de confirmar.
function tunelVivo(estado, porta = estado?.porta) {
  if (!estado?.pid || !P.vivo(estado.pid)) return false;
  const cmd = P.comandoDo(estado.pid);
  return /cloudflared/.test(cmd) && cmd.includes(`127.0.0.1:${porta}`);
}
function fecharTunelSalvo(arquivo) {
  const estado = lerEstadoTunel(arquivo);
  if (estado && tunelVivo(estado)) P.matarArvore(estado.pid);
  if (arquivo) try { fs.unlinkSync(arquivo); } catch {}
  return estado;
}

class Tunel extends EventEmitter {
  constructor({ porta, modo = 'cloudflared', urlFixa = '', log = console.log, arquivoLog = null, arquivoEstado = null }) {
    super();
    this.porta = porta;
    this.modo = modo;
    this.urlFixa = String(urlFixa || '').trim().replace(/\/+$/, '');
    this.log = log;
    this.arquivoLog = arquivoLog;
    this.arquivoEstado = arquivoEstado;
    this._vigias = [];
    this._persistente = false;
    this.estado = 'parado';        // parado | iniciando | verificando | online | caiu | desligado | falhou
    this.provedor = null;
    this.url = null;
    this.verificado = false;
    this.erro = null;
    this.desde = null;
    this.pid = null;
    this._parar = null;
    this._parando = false;
    this._falhas = 0;
    this._timer = null;
    this._geracao = 0;
  }

  info() {
    return { estado: this.estado, provedor: this.provedor, url: this.url, verificado: this.verificado,
      erro: this.erro, desde: this.desde, modo: this.modo };
  }

  _gravar(txt) {
    if (!this.arquivoLog) return;
    try { fs.appendFileSync(this.arquivoLog, txt.endsWith('\n') ? txt : txt + '\n'); } catch {}
  }

  async iniciar() {
    this._parando = false;
    clearTimeout(this._timer);
    if (this.urlFixa) {
      Object.assign(this, { estado: 'verificando', provedor: 'fixa', url: this.urlFixa, desde: new Date().toISOString() });
      this.verificado = await this._verificar();
      this.estado = 'online';
      this.emit('url', this.url, this.provedor);
      return;
    }
    if (this.modo === 'nenhum') { this.estado = 'desligado'; return; }

    this.estado = 'iniciando';
    this.erro = null;
    const ordem = this.modo === 'localtunnel' ? ['localtunnel'] : ['cloudflared', 'localtunnel'];
    const erros = [];
    for (const prov of ordem) {
      try {
        const r = prov === 'cloudflared' ? await this._cloudflared() : await this._localtunnel();
        if (this._parando) { if (!r.persistente) r.parar(); return; }
        // "verificando" e não "online": o painel só mostra a URL quando ela já existe no DNS.
        // Mostrar antes convida o aluno a abrir cedo demais (NXDOMAIN por 30 min).
        Object.assign(this, { provedor: prov, url: r.url, pid: r.pid, _parar: r.parar, _persistente: !!r.persistente,
          estado: 'verificando', desde: new Date().toISOString(), erro: null });
        // O "saiu" de um túnel antigo pode chegar depois do novo subir: só a geração atual conta.
        const geracao = ++this._geracao;
        r.aoSair(() => { if (geracao === this._geracao) this._caiu(`o processo do ${prov} terminou`); });
        this.verificado = await this._verificar();
        if (geracao !== this._geracao || this.estado !== 'verificando') return; // caiu ou parou no meio
        // Reaproveitado mas surdo (a Cloudflare derrubou a sessão): fecha e abre um novo.
        if (r.reaproveitado && !this.verificado) {
          this.log('  o túnel salvo não responde mais; abrindo outro (a URL vai mudar)');
          r.parar();
          this._geracao++;
          return this.iniciar();
        }
        this.estado = 'online';
        this._falhas = 0;
        this.emit('url', this.url, this.provedor);
        return;
      } catch (e) {
        erros.push(`${prov}: ${e.message}`);
        this._gravar(`[${new Date().toISOString()}] ${prov} falhou: ${e.message}`);
        if (ordem.length > 1 && prov === 'cloudflared') this.log(`  cloudflared falhou (${e.message}) — tentando localtunnel…`);
      }
    }
    this.erro = erros.join(' | ');
    this.estado = 'falhou';
    this.emit('falhou', this.erro);
    this._agendar();
  }

  // Encerrar o npm start NÃO fecha o túnel persistente (é o que mantém a URL). Para fechar de
  // verdade: parar({ fecharTunel: true }) ou `npm run parar`.
  parar({ fecharTunel = false } = {}) {
    this._parando = true;
    this._geracao++;
    clearTimeout(this._timer);
    for (const t of this._vigias) clearInterval(t);
    this._vigias = [];
    if (!this._persistente || fecharTunel) try { this._parar?.(); } catch {}
    this._parar = null;
    this.estado = 'parado';
  }

  _caiu(motivo) {
    if (this._parando) return;
    this._parar = null;
    this.estado = 'caiu';
    this.erro = motivo;
    this.verificado = false;
    this.emit('caiu', motivo);
    this._agendar();
  }

  _agendar() {
    if (this._parando) return;
    const ms = REINICIO_MS[Math.min(this._falhas++, REINICIO_MS.length - 1)];
    this._timer = setTimeout(() => this.iniciar(), ms);
  }

  // A URL só vale se um pedido de fora dá a volta e chega na porta pública.
  async _verificar() {
    const fim = Date.now() + ESPERA_VERIFICAR_MS;
    const host = new URL(this.url).hostname;
    if (/\.trycloudflare\.com$/i.test(host) && !(await esperarDnsAutoritativo(host, fim, () => this._parando))) {
      return false;
    }
    while (Date.now() < fim && !this._parando) {
      try {
        const r = await fetch(`${this.url}/saude`, {
          headers: { 'bypass-tunnel-reminder': '1', 'User-Agent': 'aula-ml-verificacao' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok && (await r.json()).app === 'aula-ml') return true;
      } catch {}
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    return false;
  }

  // Túnel PERSISTENTE: o cloudflared roda desacoplado do npm start. Mudar o código e reiniciar
  // o painel reaproveita o túnel que já está aberto — e a MESMA URL, sem recadastrar nada no
  // DevCenter. A URL só muda se o túnel cair, o computador reiniciar ou alguém rodar
  // `npm run parar`. O estado (pid, porta, URL) fica em logs/tunel.json.
  async _cloudflared() {
    const salvo = lerEstadoTunel(this.arquivoEstado);
    if (salvo && salvo.porta === this.porta && salvo.url && tunelVivo(salvo, this.porta)) {
      this.log('  reaproveitando o túnel que já estava aberto: a URL continua a mesma');
      return { url: salvo.url, pid: salvo.pid, persistente: true, reaproveitado: true,
        parar: () => fecharTunelSalvo(this.arquivoEstado), aoSair: (fn) => this._vigiarPid(salvo.pid, fn) };
    }
    if (salvo) fecharTunelSalvo(this.arquivoEstado); // de outra porta ou morto: não serve

    const cf = require('cloudflared');
    if (!fs.existsSync(cf.bin)) {
      this.log('  baixando o cloudflared (só na primeira vez)…');
      await cf.install(cf.bin);
    }
    // Saída num arquivo, não num pipe: o processo tem de sobreviver ao fim do npm start.
    const saida = path.join(path.dirname(this.arquivoEstado), 'cloudflared.log');
    const fd = fs.openSync(saida, 'w');
    const p = spawn(cf.bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.porta}`],
      { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    fs.closeSync(fd);
    p.unref();
    let saiu = null;
    p.on('exit', (code, sinal) => { saiu = code ?? sinal; });
    p.on('error', (e) => { saiu = e.message; });

    const ler = () => { try { return fs.readFileSync(saida, 'utf8'); } catch { return ''; } };
    const fim = Date.now() + ESPERA_URL_MS;
    while (Date.now() < fim && saiu === null) {
      const txt = ler();
      // "https://api.trycloudflare.com" aparece nas mensagens de ERRO: não é o túnel.
      const url = (txt.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/) || [])[0];
      if (url && /Registered tunnel connection/.test(txt)) {
        gravarEstadoTunel(this.arquivoEstado, { pid: p.pid, porta: this.porta, url, desde: new Date().toISOString() });
        return { url, pid: p.pid, persistente: true,
          parar: () => fecharTunelSalvo(this.arquivoEstado), aoSair: (fn) => this._vigiarPid(p.pid, fn) };
      }
      await dormir(500);
    }
    P.matarArvore(p.pid);
    const cauda = ler().split('\n').filter((l) => /ERR|error|failed/i.test(l)).slice(-2)
      .map((l) => l.replace(/^\S+\s+/, '').trim()).join(' / ');
    throw new Error(`${saiu !== null ? `saiu (${saiu})` : `não entregou URL em ${ESPERA_URL_MS / 1000} s`}`
      + `${cauda ? ' — ' + cauda : ''}`);
  }

  // Processo que não é filho deste npm start (reaproveitado) não avisa quando morre: vigia.
  _vigiarPid(pid, fn) {
    const t = setInterval(() => { if (!P.vivo(pid)) { clearInterval(t); fn(); } }, 10000);
    t.unref();
    this._vigias.push(t);
  }

  _localtunnel() {
    return new Promise((resolve, reject) => {
      const args = ['--yes', 'localtunnel@2.0.2', '--port', String(this.porta), '--local-host', '127.0.0.1'];
      // npx é um .cmd no Windows: precisa de shell. Argumentos fixos, nada vem do usuário.
      const p = P.iniciar('npx', args, { shell: P.WIN });
      let pronto = false;
      const saidas = [];
      const falhar = (e) => {
        if (pronto) return;
        pronto = true; clearTimeout(timer); P.matarArvore(p.pid);
        reject(new Error(e));
      };
      const timer = setTimeout(() => falhar(`não entregou URL em ${ESPERA_URL_MS / 1000} s`), ESPERA_URL_MS);
      const ler = (buf) => {
        const s = buf.toString();
        this._gravar(s);
        const m = /https:\/\/[a-z0-9-]+\.loca\.lt/i.exec(s);
        if (m && !pronto) {
          pronto = true; clearTimeout(timer);
          resolve({ url: m[0], pid: p.pid, parar: () => P.matarArvore(p.pid), aoSair: (fn) => saidas.push(fn) });
        }
      };
      p.stdout.on('data', ler);
      p.stderr.on('data', ler);
      p.on('error', (e) => falhar(e.message));
      p.on('exit', (code) => {
        if (!pronto) return falhar(`saiu com código ${code}`);
        for (const fn of saidas) fn(code);
      });
    });
  }
}

module.exports = { Tunel, lerEstadoTunel, tunelVivo, fecharTunelSalvo };
