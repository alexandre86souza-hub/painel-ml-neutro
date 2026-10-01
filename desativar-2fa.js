#!/usr/bin/env node
'use strict';
// npm run desativar-2fa — perdeu o celular do aplicativo autenticador? Roda NESTE computador
// (onde o painel está instalado) e desliga a verificação em duas etapas. No próximo login, o
// painel pede para ativar de novo, com uma chave nova. Só funciona aqui: pela internet não há
// como desligar sem a senha e o código atuais.
require('./ambiente.js').carregar();
const D = require('./db.js');

if (!D.configLer('painel_2fa_segredo')) {
  console.log('A verificação em duas etapas já está desligada.');
} else {
  D.configGravar('painel_2fa_segredo', null);
  D.configGravar('painel_2fa_pendente', null);
  D.db.prepare('DELETE FROM sessoes').run();   // quem estava logado entra de novo
  console.log('Verificação em duas etapas desligada. Entre no painel com a senha: ele vai pedir para ativar de novo no celular.');
}
