// Tema da tela (escuro, o padrão, ou claro) e menu lateral recolhido ou não, escolhidos por pessoa
// neste navegador (botões no rodapé do menu, public/menu.js). Carregado no <head>, sem defer, antes de
// a página aparecer: sem "piscar" claro nem o menu abrindo e fechando.
(function () {
  const raiz = document.documentElement;
  let t = 'escuro';
  try { t = localStorage.getItem('painel.tema') === 'claro' ? 'claro' : 'escuro'; } catch {}
  raiz.dataset.tema = t;
  try { if (localStorage.getItem('painel.menu.recolhido') === '1') raiz.dataset.menu = 'recolhido'; } catch {}
  // tela atual, para as cores escuras próprias de cada uma (tema-escuro-paginas.css)
  raiz.dataset.pagina = (location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'inicio');
  window.trocarTema = () => {
    const novo = raiz.dataset.tema === 'escuro' ? 'claro' : 'escuro';
    raiz.dataset.tema = novo;
    try { localStorage.setItem('painel.tema', novo); } catch {}
    return novo;
  };
  window.recolherMenu = (sim) => {
    const r = sim ?? raiz.dataset.menu !== 'recolhido';
    if (r) raiz.dataset.menu = 'recolhido'; else delete raiz.dataset.menu;
    try { localStorage.setItem('painel.menu.recolhido', r ? '1' : '0'); } catch {}
    return r;
  };
})();
