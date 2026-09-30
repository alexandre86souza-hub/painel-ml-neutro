// Aviso no topo das telas quando falta algo para a integração com o Mercado Livre funcionar.
// O mais importante: a URL do túnel muda a cada reinício, e o aplicativo no DevCenter
// precisa acompanhar — senão o login da conta e as notificações param de chegar.
(async () => {
  let r;
  try {
    const res = await fetch('/api/config/resumo');
    if (!res.ok) return;
    r = await res.json();
  } catch { return; }

  const TEXTOS = {
    credenciais: ['Falta configurar o seu aplicativo do Mercado Livre.', 'Configurar agora'],
    url: ['Cadastre as URLs do túnel no seu aplicativo do Mercado Livre.', 'Ver as URLs'],
    url_mudou: ['A URL pública mudou. Atualize o seu aplicativo no DevCenter do Mercado Livre, ou o login e as notificações param de chegar.', 'Ver a URL nova'],
    tunel: ['O túnel HTTPS está fora do ar: o Mercado Livre não consegue devolver o login nem as notificações.', 'Ver detalhes'],
    conta: ['Nenhuma conta do Mercado Livre conectada ainda.', 'Conectar conta'],
  };
  // Nos primeiros segundos depois do npm start o túnel ainda está abrindo: não é falha.
  const abrindo = r.pendente === 'tunel' && ['iniciando', 'verificando'].includes(r.tunel);
  const t = abrindo ? ['Abrindo o túnel HTTPS… leva alguns segundos.', 'Acompanhar'] : TEXTOS[r.pendente];
  if (!t) return;

  const grave = !abrindo && (r.pendente === 'url_mudou' || r.pendente === 'tunel');
  const barra = document.createElement('div');
  barra.setAttribute('role', grave ? 'alert' : 'status');
  barra.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:10px 20px;'
    + 'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border-bottom:1px solid;'
    + (grave ? 'background:#fce8e6;color:#8c1d18;border-color:#f0b3ad' : 'background:#fff4e0;color:#7a4a00;border-color:#f0c46b');
  const msg = document.createElement('span');
  msg.textContent = t[0];
  const link = document.createElement('a');
  link.href = '/configuracao.html';
  link.textContent = t[1] + ' →';
  link.style.cssText = 'color:inherit;font-weight:700';
  barra.append(msg, link);
  const header = document.querySelector('header');
  if (header) header.after(barra); else document.body.prepend(barra);
})();
