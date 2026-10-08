'use strict';
// Usuários do painel (tela public/usuarios.html, só o administrador). O ADMINISTRADOR é a senha
// criada no primeiro acesso (login "admin", tabela estado, como sempre foi): só ele conecta contas,
// mexe em Configurações, Empresa, conexões dos marketplaces e nos usuários. Cada pessoa do
// escritório ganha login próprio com senha forte e verificação em duas etapas próprias
// (seguranca.js) e só os MÓDULOS que o administrador marcar.
//
// Permissão é NEGADA por padrão: tela ou rota que não está em nenhum módulo só abre para o
// administrador. Rota nova de API, então, nasce fechada para os usuários até entrar num módulo
// (test-usuarios.js confere que cada tela de um módulo só chama rotas que o módulo libera).
const crypto = require('node:crypto');
const SEG = require('./seguranca.js');

const CANAIS = '(amazon|shopee|leroy|magalu)';
const re = (s) => new RegExp(`^${s}$`);
// Regras: "MÉTODOS /caminho" (regex). (/.*)? = a rota e as de baixo.
const MODULOS = [
  { id: 'vendas', nome: 'Vendas e relatórios', descricao: 'Dashboard, Todas as contas, Pedidos, Performance, ABC, Full, Devoluções e Reputação',
    paginas: ['/inicio.html', '/geral.html', '/vendas.html', '/performance.html', '/abc.html', '/full.html', '/devolucoes.html',
      '/shopee-devolucoes.html', '/reputacao.html'],
    rotas: ['GET /api/(dashboard|vendas|performance|abc|contas/resumo|contas/lojas|contas/atencao|full|reputacao|periodo|saude)(/.*)?',
      '(GET|POST|PUT) /api/devolucoes(/.*)?', `GET /api/${CANAIS}/(pedidos|performance|abc|vendas|full|devolucoes)(/.*)?`,
      'POST /api/leroy/frete'] },
  { id: 'expedicao', nome: 'Expedição', descricao: 'Comandas de separação (imprimir, comanda manual de venda direta)',
    paginas: ['/comandas.html'], rotas: ['(GET|POST) /api/comandas(/.*)?'] },
  { id: 'estoque', nome: 'Estoque', descricao: 'Saldo, entradas e saídas, contagem, compras, fornecedores e relatórios',
    paginas: ['/estoque.html'], rotas: ['(GET|POST|PUT) /api/estoque(?!/importar)(/.*)?'] },
  { id: 'anuncios', nome: 'Anúncios e produtos', descricao: 'Anúncios (preço, SKU, atacado, pausar), Produtos, Publicar e Calculadora',
    paginas: ['/anuncios.html', '/amazon-anuncios.html', '/shopee-anuncios.html', '/magalu-anuncios.html', '/produtos.html',
      '/publicar.html', '/publicar-canais.html', '/calculadora.html'],
    rotas: ['(GET|POST|PUT) /api/(items|anuncios|category|concorrentes|custos-anuncios|keywords|posicao|atacado|calculadora|predict|tabelas|publicar|listing-types|products|pictures)(/.*)?',
      '(GET|POST|PUT) /api/produtos(/.*)?', 'GET /api/(empresa|imposto|periodo|scraper|produtos-custo)',
      '(GET|POST|PUT) /api/amazon/(anuncios|concorrentes|vendedores|publicar)(/.*)?', '(GET|POST|PUT) /api/shopee/(anuncios|publicar)(/.*)?',
      '(GET|POST|PUT) /api/magalu/(anuncios|sku-vinculo)(/.*)?'] },
  { id: 'campanhas', nome: 'Campanhas e promoções', descricao: 'Promoções do ML, campanhas da Shopee, Amazon, Leroy e Magalu',
    paginas: ['/promocoes.html', '/campanhas-canais.html', '/shopee-campanhas.html'],
    rotas: ['(GET|POST|PUT) /api/promocoes(/.*)?', `(GET|POST|PUT) /api/${CANAIS}/campanhas(/.*)?`, 'GET /api/shopee/anuncios'] },
  { id: 'ads', nome: 'Publicidade (Ads)', descricao: 'Histórico de Ads do ML e Ads da Shopee',
    paginas: ['/ads.html', '/shopee-ads.html'], rotas: ['GET /api/ads(/.*)?', 'GET /api/shopee/ads(/.*)?'] },
  { id: 'financeiro', nome: 'Financeiro', descricao: 'Mercado Pago (extrato e conferência) e repasses da Leroy',
    paginas: ['/financeiro.html', '/leroy.html'],
    rotas: ['(GET|POST|PUT) /api/financeiro(/.*)?', 'GET /api/leroy/repasses'] },
  { id: 'mensagens', nome: 'Mensagens', descricao: 'Perguntas, pós-venda e chat: ler e responder',
    paginas: ['/mensagens.html'], rotas: ['(GET|POST|PUT) /api/mensagens(/.*)?'] },
].map((m) => ({ ...m, regras: m.rotas.map(re) }));

// O que toda pessoa logada usa: menu, marca, lista de contas e o sino de avisos.
const COMUNS = ['GET /api/(marca|marca/logo|accounts|avisos|eu)', 'POST /api/(accounts/active|avisos/lidos)',
  `GET /api/${CANAIS}/config`].map(re);

const IDS = MODULOS.map((m) => m.id);
const limparModulos = (lista) => [...new Set((Array.isArray(lista) ? lista : []).map(String))].filter((m) => IDS.includes(m));
const paginaDe = (caminho) => (caminho === '/' ? '/inicio.html' : caminho);

// Pode? usuario = { admin, modulos }. Arquivo que não é tela nem API (js, css, imagem) é livre:
// não tem dado. Função pura: testada.
function permitido(usuario, metodo, caminho) {
  if (!usuario) return false;
  if (usuario.admin) return true;
  const mods = MODULOS.filter((m) => (usuario.modulos || []).includes(m.id));
  if (caminho.startsWith('/api/')) {
    const alvo = `${metodo === 'HEAD' ? 'GET' : metodo} ${caminho}`;
    return COMUNS.some((r) => r.test(alvo)) || mods.some((m) => m.regras.some((r) => r.test(alvo)));
  }
  const p = paginaDe(caminho);
  if (p.endsWith('.html')) return mods.some((m) => m.paginas.includes(p));
  return !p.startsWith('/api') && !['/auth', '/magalu/callback'].includes(p);
}

// Para onde vai quem entrou (ou abriu uma tela que não pode).
const primeiraPagina = (usuario) => {
  if (usuario?.admin) return '/';
  const m = MODULOS.find((x) => (usuario?.modulos || []).includes(x.id));
  return m ? (m.paginas[0] === '/inicio.html' ? '/' : m.paginas[0]) : '/sem-acesso';
};

// Login: letras minúsculas, números, ponto, hífen e sublinhado; "admin" é do administrador.
function validarUsuario(b, novo = true) {
  const login = String(b?.login ?? '').trim().toLowerCase();
  const nome = String(b?.nome ?? '').trim().slice(0, 60);
  const erro = (m) => Object.assign(new Error(m), { status: 400 });
  if (novo) {
    if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw erro('Login: 3 a 30 caracteres, só letras minúsculas, números, ponto, hífen ou sublinhado.');
    if (login === 'admin') throw erro('"admin" é o login do administrador. Escolha outro.');
  }
  if (!nome) throw erro('Informe o nome da pessoa.');
  return { login, nome, modulos: limparModulos(b?.modulos) };
}

// Senha temporária que já passa pela política (o usuário troca no 1º login). Sem letras parecidas.
function senhaTemporaria() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(14);
  let s = '';
  for (let i = 0; i < 14; i++) s += A[b[i] % A.length];
  s = `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10)}7`;
  if (SEG.problemaSenha(s)) return senhaTemporaria();
  return s;
}
const TEMPORARIA_HORAS = 72;

module.exports = { MODULOS, IDS, COMUNS, permitido, primeiraPagina, validarUsuario, limparModulos, senhaTemporaria, paginaDe, TEMPORARIA_HORAS };
