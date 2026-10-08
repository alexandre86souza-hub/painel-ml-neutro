// Tema da tela (escuro, o padrão, ou claro), escolhido por pessoa neste navegador (botão no menu,
// public/menu.js). Carregado no <head>, sem defer, antes de a página aparecer: sem "piscar" claro.
(function () {
  let t = 'escuro';
  try { t = localStorage.getItem('painel.tema') === 'claro' ? 'claro' : 'escuro'; } catch {}
  document.documentElement.dataset.tema = t;
  // tela atual, para as cores escuras próprias de cada uma (tema-escuro-paginas.css)
  document.documentElement.dataset.pagina = (location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'inicio');
  window.trocarTema = () => {
    const novo = document.documentElement.dataset.tema === 'escuro' ? 'claro' : 'escuro';
    document.documentElement.dataset.tema = novo;
    try { localStorage.setItem('painel.tema', novo); } catch {}
    return novo;
  };
})();
