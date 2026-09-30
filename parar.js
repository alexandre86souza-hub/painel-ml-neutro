#!/usr/bin/env node
'use strict';
// npm run parar — fecha TUDO: painel, scraper e o túnel.
// O Ctrl+C do npm start deixa o túnel aberto de propósito (a URL fica a mesma no próximo
// npm start). Rode isto quando quiser encerrar de verdade; a próxima URL será nova.
const fs = require('node:fs');
const path = require('node:path');
const P = require('./processos.js');
const { fecharTunelSalvo } = require('./tunel.js');

const LOGS = path.join(__dirname, 'logs');
const PIDS = path.join(LOGS, 'processos.json');
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(PIDS, 'utf8')); } catch {}

  // 1. painel (ele encerra o scraper junto); espera até 5 s pelo encerramento limpo
  if (P.vivo(reg.painel) && /iniciar\.js/.test(P.comandoDo(reg.painel))) {
    try { process.kill(reg.painel, 'SIGINT'); } catch {}
    for (let i = 0; i < 10 && P.vivo(reg.painel); i++) await dormir(500);
    if (P.vivo(reg.painel)) P.matarArvore(reg.painel);
    console.log(`painel encerrado (pid ${reg.painel})`);
  } else {
    console.log('painel: não estava rodando');
  }

  // 2. scraper que tenha sobrado
  if (P.vivo(reg.scraper) && /uvicorn.*api:app/.test(P.comandoDo(reg.scraper))) {
    P.matarArvore(reg.scraper);
    console.log(`scraper encerrado (pid ${reg.scraper})`);
  }

  // 3. túnel
  const tunel = fecharTunelSalvo(path.join(LOGS, 'tunel.json'));
  console.log(tunel ? `túnel fechado (${tunel.url})` : 'túnel: não havia túnel aberto');
  try { fs.unlinkSync(PIDS); } catch {}
  console.log('\nTudo parado. No próximo npm start a URL pública será NOVA: atualize o DevCenter.');
})();
