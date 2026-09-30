// Sino de avisos no cabeçalho de todas as telas: venda nova, mensagem de comprador e anúncio
// pausado (sem estoque ou pelo Mercado Livre). Pergunta ao painel a cada minuto; aviso novo
// também aparece como notificação do Windows (Notification API) se o dono permitir.
(function () {
  const barra = document.getElementById('barraContas');
  if (!barra || document.getElementById('sinoAvisos')) return;

  const css = document.createElement('style');
  css.textContent = `
    .sino{position:relative}
    .sino > button{position:relative;display:inline-grid;place-items:center;width:38px;height:36px;padding:0;border-radius:999px;
      background:#fff;border:1px solid #e3e8f0;cursor:pointer;color:#16213a;box-shadow:0 1px 3px rgba(16,24,40,.08)}
    .sino > button:hover{background:#f2f5fa}
    .sino svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .sino .bolha{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;
      background:#dc2626;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center}
    .sino .painel-avisos{position:absolute;right:0;top:44px;width:min(380px,92vw);max-height:70vh;overflow:auto;z-index:60;
      background:#fff;border:1px solid #e3e8f0;border-radius:14px;box-shadow:0 18px 50px rgba(16,24,40,.22);padding:8px}
    .painel-avisos .topo{display:flex;justify-content:space-between;align-items:center;padding:6px 8px 8px;font-size:13px}
    .painel-avisos .topo b{font-size:14px}
    .painel-avisos .topo button{font:inherit;font-size:12px;background:none;border:0;color:#2563eb;cursor:pointer;padding:0}
    .painel-avisos ul{list-style:none;margin:0;padding:0}
    .painel-avisos li a{display:grid;grid-template-columns:28px 1fr;gap:8px;padding:9px 8px;border-radius:10px;
      color:#16213a;text-decoration:none;font-size:13px;line-height:1.35}
    .painel-avisos li a:hover{background:#f4f7fb}
    .painel-avisos li.novo a{background:#eef4ff}
    .painel-avisos .ic{font-size:17px;line-height:1.2}
    .painel-avisos small{display:block;color:#5f6b7f;font-size:12px}
    .painel-avisos .vazio{padding:14px 8px;color:#5f6b7f;font-size:13px}
    .painel-avisos .perm{margin:6px 8px 4px;font-size:12px}
    .painel-avisos .perm button{font:inherit;font-size:12px;font-weight:600;border:1px solid #c9d8fb;background:#eef4ff;color:#1d4ed8;
      border-radius:8px;padding:5px 10px;cursor:pointer}`;
  document.head.appendChild(css);

  const box = document.createElement('div');
  box.className = 'sino'; box.id = 'sinoAvisos';
  box.innerHTML = '<button type="button" aria-label="Avisos" aria-expanded="false"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="bolha" hidden></span></button>';
  const painel = document.createElement('div');
  painel.className = 'painel-avisos'; painel.hidden = true;
  box.appendChild(painel);
  barra.prepend(box);
  const botao = box.querySelector('button'), bolha = box.querySelector('.bolha');

  const ICONE = { venda: '🛒', mensagem: '💬', pausa: '⏸️' };
  let avisos = [], vistos = null;
  const quando = (iso) => {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return 'agora'; if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60); if (h < 24) return `há ${h} h`;
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };

  function pintar() {
    painel.innerHTML = '';
    const topo = document.createElement('div'); topo.className = 'topo';
    const t = document.createElement('b'); t.textContent = 'Avisos';
    const lidos = document.createElement('button'); lidos.type = 'button'; lidos.textContent = 'Marcar todos como lidos';
    lidos.onclick = async () => { await enviar('/api/avisos/lidos', {}); carregar(); };
    topo.append(t, lidos); painel.appendChild(topo);
    if ('Notification' in window && Notification.permission === 'default') {
      const p = document.createElement('div'); p.className = 'perm';
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Receber avisos no Windows';
      b.onclick = async () => { await Notification.requestPermission(); pintar(); };
      p.appendChild(b); painel.appendChild(p);
    }
    if (!avisos.length) {
      const v = document.createElement('p'); v.className = 'vazio';
      v.textContent = 'Nenhum aviso ainda. Vendas novas, mensagens e anúncios pausados aparecem aqui.';
      painel.appendChild(v); return;
    }
    const ul = document.createElement('ul');
    for (const a of avisos) {
      const li = document.createElement('li'); if (!a.lido) li.className = 'novo';
      const link = document.createElement('a'); link.href = a.link || '#';
      if (/^https?:/.test(a.link || '')) { link.target = '_blank'; link.rel = 'noopener'; }
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = ICONE[a.tipo] || '🔔';
      const tx = document.createElement('span');
      tx.appendChild(document.createTextNode(a.titulo));
      const s = document.createElement('small'); s.textContent = `${a.texto || ''} · ${quando(a.criado_em)}`;
      tx.appendChild(s);
      link.append(ic, tx);
      link.onclick = () => { if (!a.lido) enviar('/api/avisos/lidos', { ids: [a.id] }); };
      li.appendChild(link); ul.appendChild(li);
    }
    painel.appendChild(ul);
  }

  async function enviar(url, corpo) {
    try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }); } catch {}
  }

  async function carregar() {
    try {
      const r = await fetch('/api/avisos');
      if (!r.ok) return;
      const j = await r.json();
      avisos = j.avisos || [];
      bolha.hidden = !j.nao_lidos; bolha.textContent = j.nao_lidos > 99 ? '99+' : String(j.nao_lidos || '');
      // notificação do Windows só para aviso que chegou depois da tela abrir
      const ids = new Set(avisos.map((a) => a.id));
      if (vistos && 'Notification' in window && Notification.permission === 'granted') {
        for (const a of avisos.filter((x) => !vistos.has(x.id) && !x.lido).slice(0, 5)) {
          try { new Notification(a.titulo, { body: a.texto || '', tag: 'aviso-' + a.id }); } catch {}
        }
      }
      vistos = ids;
      if (!painel.hidden) pintar();
    } catch {}
  }

  botao.onclick = () => {
    painel.hidden = !painel.hidden;
    botao.setAttribute('aria-expanded', String(!painel.hidden));
    if (!painel.hidden) pintar();
  };
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) { painel.hidden = true; botao.setAttribute('aria-expanded', 'false'); } });
  carregar();
  setInterval(carregar, 60000);
})();
