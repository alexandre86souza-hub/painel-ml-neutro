// Mensagem de resultado sem tirar a pessoa do lugar: a faixa de aviso fica no topo da tela; se ela não estiver
// visível (a pessoa desceu a lista para aderir/mudar um por um), mostra uma cópia flutuando no canto, por alguns
// segundos, em vez de rolar a página até o topo. avisoNaTela(elementoDoAviso)
(function () {
  let caixa = null, tempo = null;
  window.avisoNaTela = function (m) {
    if (!m) return;
    const texto = (m.textContent || '').trim();
    if (!texto) { if (caixa) caixa.hidden = true; return; }
    const r = m.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight && r.height > 0) return;   // a faixa já está à vista
    if (!caixa) {
      caixa = document.createElement('div'); caixa.setAttribute('role', 'status'); caixa.setAttribute('aria-live', 'polite');
      caixa.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2000;max-width:min(520px,calc(100vw - 32px));padding:12px 36px 12px 14px;'
        + 'border-radius:10px;font-size:14px;line-height:1.4;box-shadow:0 10px 30px rgba(0,0,0,.35);cursor:pointer';
      caixa.title = 'Clique para fechar';
      caixa.onclick = () => { caixa.hidden = true; };
      document.body.appendChild(caixa);
    }
    const ok = /(^|\s)ok(\s|$)/.test(m.className);
    caixa.style.background = ok ? '#e6f4ea' : '#fdecea';
    caixa.style.color = ok ? '#0b6b33' : '#b42318';
    caixa.style.border = '1px solid ' + (ok ? '#a8dab5' : '#f5c2c0');
    caixa.textContent = texto + '  ✕';
    caixa.hidden = false;
    clearTimeout(tempo); tempo = setTimeout(() => { caixa.hidden = true; }, ok ? 7000 : 12000);
  };
})();
