'use strict';
// Quem fez o pedido HTTP que está sendo atendido agora: a sessão (e o usuário dela) acompanha o
// pedido por todos os await sem passar parâmetro em cada função. O server.js abre um contexto por
// pedido (`rodar`) e preenche depois do login; o db.js lê a conta do ML escolhida NESTA sessão
// (cada pessoa do escritório olha a sua conta sem trocar a dos outros). Fora de pedido (MCP,
// tarefas em segundo plano) não há contexto: vale a conta ativa geral, como antes.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const rodar = (fn) => als.run({}, fn);
const atual = () => als.getStore() || null;

module.exports = { rodar, atual };
