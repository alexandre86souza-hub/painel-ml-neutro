// Acompanhamento da devolução, igual em todas as lojas (telas de devoluções do ML, da Shopee e da Amazon/Leroy/Magalu):
// "Pedi reembolso ao marketplace" deixa a devolução EM ABERTO até a resposta ("Marketplace reembolsou" / "Marketplace negou"
// = fechada), com uma observação. PUT /api/devolucoes/acompanhamento. Usa el/api do comum.js.
(function(){
  const css = `
  .acomp{border:1px dashed var(--line);border-radius:10px;padding:8px 10px;display:grid;gap:6px;font-size:13px;min-width:0;max-width:460px}
  .acomp .linha{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .acomp select,.acomp input{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;min-width:0}
  .acomp input{flex:1 1 180px}
  .acomp small{font-size:11px;color:var(--muted)}
  .chip-estado{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
  .chip-estado.conferir{background:#eef1f6;color:#475569}
  .chip-estado.aberta{background:#fff4d6;color:#7a5600}
  .chip-estado.fechada{background:#e6f4ea;color:#0b6b33}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const NOMES = { aguardando: 'Pedi reembolso ao marketplace (em aberto)', reembolsado: 'Marketplace reembolsou (fechada)', negado: 'Marketplace negou (fechada)' };
  // conferir = ainda não chegou / falta conferir; aberta = esperando a resposta do marketplace; fechada = resolvida
  window.estadoDevolucao = (conferida, acomp) => (acomp?.situacao === 'aguardando' ? 'aberta' : conferida || acomp?.situacao ? 'fechada' : 'conferir');
  window.NOME_ESTADO = { conferir: 'Falta conferir', aberta: 'Em aberto', fechada: 'Fechada' };
  window.chipEstado = (estado) => el('span', 'chip-estado ' + estado, window.NOME_ESTADO[estado]);

  window.blocoAcomp = function(chave, acomp, { aoSalvar } = {}){
    const box = el('div', 'acomp');
    const l1 = el('div', 'linha');
    const sel = el('select'); sel.setAttribute('aria-label', 'Reembolso pedido ao marketplace');
    sel.innerHTML = '<option value="">Sem pedido de reembolso ao marketplace</option>'
      + Object.entries(NOMES).map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    sel.value = acomp?.situacao || '';
    l1.appendChild(sel); box.appendChild(l1);
    const l2 = el('div', 'linha');
    const ob = el('input'); ob.maxLength = 500; ob.placeholder = 'Observação (ex.: pedi reembolso em 20/10, protocolo 123)'; ob.value = acomp?.obs || '';
    ob.setAttribute('aria-label', 'Observação da devolução');
    const bt = el('button', 'bt', 'Salvar'); bt.type = 'button';
    l2.append(ob, bt); box.appendChild(l2);
    const info = el('small', null, acomp ? `salvo em ${new Date(acomp.atualizado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${acomp.quem ? ' por ' + acomp.quem : ''}` : '');
    box.appendChild(info);
    bt.onclick = async () => {
      bt.disabled = true; bt.textContent = 'Salvando…';
      try{
        await api('/api/devolucoes/acompanhamento', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chave, situacao: sel.value || null, obs: ob.value }) });
        if(aoSalvar) aoSalvar(); else { bt.disabled = false; bt.textContent = 'Salvar'; info.textContent = '✓ Salvo'; }
      }catch(e){ bt.disabled = false; bt.textContent = 'Salvar'; info.textContent = e.message; }
    };
    return box;
  };
})();
