'use strict';
// Metas e faturamento por CNPJ (pedido do dono, 26/10/2026: substitui a planilha "Acompanhamento venda"). Faturamento =
// vendas pela data da COMPRA, sem as canceladas, por dia e por loja — o mesmo número que o vendedor lançava à mão (medido:
// ML e Shopee Primor batem com a planilha centavo a centavo; Leroy soma o frete pago pelo cliente, que vai na nota). Cada
// loja é de um CNPJ (configurável); a meta é do TOTAL. Os dias vêm do painel (últimos 60 dias, relidos) e ficam guardados em
// fat_dia; o que é mais antigo fica como foi lido ou importado da planilha. Shein não tem integração: valor do dia à mão.
// Simples Nacional (os dois CNPJs): RBT12 = receita bruta dos 12 meses ANTERIORES ao mês -> faixa e alíquota efetiva
// ((RBT12 × nominal − dedução) ÷ RBT12). Anexo I (comércio), LC 123/2006 com a LC 155/2016. Nada disto vai ao MCP (tem Amazon).
const { lerXlsx, dataDoExcel } = require('./xlsx.js');

const r2 = (v) => Math.round(v * 100) / 100;
const erro = (m, status = 400) => Object.assign(new Error(m), { status });

// Faixas do Simples Nacional: [teto da faixa, alíquota nominal, parcela a deduzir]
const ANEXOS = {
  I: { nome: 'Anexo I — Comércio', faixas: [[180000, 0.04, 0], [360000, 0.073, 5940], [720000, 0.095, 13860], [1800000, 0.107, 22500], [3600000, 0.143, 87300], [4800000, 0.19, 378000]] },
  II: { nome: 'Anexo II — Indústria', faixas: [[180000, 0.045, 0], [360000, 0.078, 5940], [720000, 0.10, 13860], [1800000, 0.112, 22500], [3600000, 0.147, 85500], [4800000, 0.30, 720000]] },
};
// RBT12 -> faixa e alíquota efetiva. Sem receita (empresa nova) vale a 1ª faixa. Acima de R$ 4,8 mi sai do Simples. Função pura: testada.
function simples(rbt12, anexo = 'I') {
  const a = ANEXOS[anexo] || ANEXOS.I;
  const rb = Math.max(0, Number(rbt12) || 0);
  const i = a.faixas.findIndex(([teto]) => rb <= teto);
  if (i < 0) return { anexo, rbt12: r2(rb), faixa: null, acima_teto: true, efetiva: null, nominal: null, deducao: null, teto: 4800000 };
  const [teto, nominal, deducao] = a.faixas[i];
  const efetiva = rb > 0 ? (rb * nominal - deducao) / rb : nominal;
  const prox = a.faixas[i + 1] || null;
  return { anexo, rbt12: r2(rb), faixa: i + 1, de: i ? a.faixas[i - 1][0] + 0.01 : 0, ate: teto, nominal, deducao, efetiva,
    falta_proxima: r2(teto - rb), proxima: prox ? { faixa: i + 2, nominal: prox[1], deducao: prox[2] } : null,
    // sublimite: acima de R$ 3,6 mi o ICMS sai do DAS e é recolhido à parte
    sublimite_icms: rb > 3600000, acima_teto: false };
}

const diasDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const hojeBR = (agora = Date.now()) => new Date(agora - 3 * 3600e3).toISOString().slice(0, 10);
const mesDe = (dia) => dia.slice(0, 7);
// Um mês: realizado, projeção (média dos dias passados × dias do mês), ritmo atual × necessário. Função pura: testada.
function mesResumo({ ano, mes, meta, porDia }, hoje = hojeBR()) {
  const nd = diasDoMes(ano, mes), pref = `${ano}-${String(mes).padStart(2, '0')}`;
  const mesHoje = hoje.slice(0, 7);
  const passados = pref < mesHoje ? nd : pref > mesHoje ? 0 : Number(hoje.slice(8, 10));
  const dias = [];
  let acum = 0;
  for (let d = 1; d <= nd; d++) {
    const dia = `${pref}-${String(d).padStart(2, '0')}`;
    const v = porDia[dia] || 0;
    acum += v;
    dias.push({ dia, valor: r2(v), acumulado: r2(acum), planejado: meta ? r2(meta * d / nd) : null });
  }
  const realizado = r2(acum);
  const ritmo = passados ? realizado / passados : 0;
  const projecao = r2(passados >= nd ? realizado : ritmo * nd);
  const restantes = nd - passados;
  const saldo = meta ? Math.max(0, meta - realizado) : null;
  const necessario = meta ? (restantes > 0 ? saldo / restantes : 0) : null;
  const alerta = !meta ? null : realizado >= meta ? 'META ATINGIDA' : passados === 0 ? 'NÃO COMEÇOU'
    : restantes === 0 ? 'ABAIXO DA META' : ritmo >= necessario ? 'NO RITMO' : 'FORA DO RITMO';
  return { ano, mes, meta: meta ?? null, realizado, projecao, pct_meta: meta ? realizado / meta : null, pct_projecao: meta ? projecao / meta : null,
    dias_mes: nd, dias_passados: passados, ritmo_atual: r2(ritmo), ritmo_necessario: necessario == null ? null : r2(necessario), saldo: saldo == null ? null : r2(saldo), alerta, dias };
}

// Planilha do vendedor -> dias por canal (aba "Base Anual": Data | ML 1 | ML 2 | Amazon | Shopee 1 | Shopee 2 | Shein | Leroy | Magalu)
// e metas (aba "Metas": Mês nº | Mês | anos…). mapa = coluna da planilha -> canal do painel. Função pura: testada.
const COLUNAS_PLANILHA = ['Mercado Livre 1', 'Mercado Livre 2', 'Amazon', 'Shopee 1', 'Shopee 2', 'Shein', 'Leroy', 'Magalu'];
function daPlanilha(buf, mapa) {
  const x = lerXlsx(buf);
  const base = x.aba('Base Anual');
  if (!base) throw erro('A planilha não tem a aba "Base Anual".');
  const cab = base.findIndex((l) => l && String(l[0] || '').trim() === 'Data');
  if (cab < 0) throw erro('Não achei a linha de títulos (Data, Mercado Livre 1…) na aba "Base Anual".');
  const col = Object.fromEntries((base[cab] || []).map((t, i) => [String(t || '').trim(), i]));
  const dias = [];
  for (const l of base.slice(cab + 1)) {
    const dia = l && dataDoExcel(l[0]);
    if (!dia) continue;
    for (const nome of COLUNAS_PLANILHA) {
      const v = l[col[nome]];
      if (typeof v === 'number' && mapa[nome]) dias.push({ dia, canal: mapa[nome], valor: r2(v) });
    }
  }
  const metas = [];
  const m = x.aba('Metas');
  const cm = m ? m.findIndex((l) => l && /m[eê]s n/i.test(String(l[0] || ''))) : -1;
  if (cm >= 0) {
    const anos = (m[cm] || []).map((v, i) => [Number(v), i]).filter(([v]) => v >= 2000 && v <= 2100);
    for (const l of m.slice(cm + 1, cm + 13)) {
      const mes = Number(l?.[0]);
      if (mes >= 1 && mes <= 12) for (const [ano, i] of anos) if (typeof l[i] === 'number' && l[i] > 0) metas.push({ ano, mes, valor: r2(l[i]) });
    }
  }
  return { dias, metas };
}

function criar({ D, routes, CTX }) {
  const urlDe = (p) => new URL(p, 'http://painel');
  // Lojas do painel (canal -> nome) e a configuração dos CNPJs (estado metas_cnpjs; padrão = a da planilha do vendedor)
  function lojas() {
    const l = [];
    for (const c of D.contasListar()) l.push({ canal: `ml:${c.ml_user_id}`, nome: `Mercado Livre · ${c.nickname}` });
    for (const s of D.shopeeLojasListar()) l.push({ canal: `shopee:${s.shop_id}`, nome: `Shopee · ${s.nome || s.shop_id}` });
    if (D.configLer('amazon_refresh_token')) l.push({ canal: 'amazon', nome: 'Amazon' });
    if (D.configLer('leroy_api_key')) l.push({ canal: 'leroy', nome: 'Leroy Merlin' });
    if (D.configLer('magalu_client_id')) l.push({ canal: 'magalu', nome: 'Magalu' });
    l.push({ canal: 'shein', nome: 'Shein (à mão)' });
    return l;
  }
  function config() {
    try { const c = JSON.parse(D.configLer('metas_cnpjs') || 'null'); if (c?.cnpjs?.length) return c; } catch { /* padrão */ }
    const ml = D.contasListar(), sh = D.shopeeLojasListar();
    // padrão: a 1ª conta do ML e a 1ª loja da Shopee (AMG) + Shein no CNPJ 1; o resto no CNPJ 2 (como a planilha)
    return { cnpjs: [
      { id: '1', nome: 'CNPJ 1', anexo: 'I', canais: [ml[0] && `ml:${ml[0].ml_user_id}`, sh[0] && `shopee:${sh[0].shop_id}`, 'shein'].filter(Boolean) },
      { id: '2', nome: 'CNPJ 2', anexo: 'I', canais: [...ml.slice(1).map((c) => `ml:${c.ml_user_id}`), ...sh.slice(1).map((s) => `shopee:${s.shop_id}`), 'amazon', 'leroy', 'magalu'] },
    ] };
  }
  const cnpjDoCanal = (cfg) => new Map(cfg.cnpjs.flatMap((c) => c.canais.map((k) => [k, c.id])));

  // Lê os últimos 60 dias de cada loja (data da compra, sem canceladas) e grava em fat_dia (fonte 'painel'); Shein fica.
  let atualizando = null, atualizadoEm = 0;
  async function atualizar(forcar = false) {
    if (atualizando) return atualizando;
    if (!forcar && Date.now() - atualizadoEm < 15 * 60e3) return null;
    atualizando = (async () => {
      const erros = [], linhas = [];
      const dia = (iso) => new Date(Date.parse(iso) - 3 * 3600e3).toISOString().slice(0, 10);
      const somar = (canal, m) => { for (const [d, v] of Object.entries(m)) linhas.push({ dia: d, canal, valor: r2(v) }); };
      const passo = async (nome, fn) => { try { await fn(); } catch (e) { erros.push(`${nome}: ${e.message}`); } };
      await passo('Mercado Livre', async () => {
        const r = await routes['GET /api/contas/resumo'](urlDe('/api/contas/resumo?dias=60'));
        for (const c of r.contas || []) { const m = {}; for (const x of c.dias || []) m[x.dia] = (m[x.dia] || 0) + (x.faturamento || 0); somar(`ml:${c.ml_user_id}`, m); }
      });
      for (const s of D.shopeeLojasListar()) await passo(`Shopee ${s.nome || s.shop_id}`, async () => {
        const r = await routes['GET /api/shopee/vendas'](urlDe(`/api/shopee/vendas?dias=60&loja=${s.shop_id}`));
        const m = {}; for (const x of r.por_dia || []) m[x.dia] = (m[x.dia] || 0) + (x.faturamento || 0); somar(`shopee:${s.shop_id}`, m);
      });
      const porPedido = async (canal, rota, valor) => {
        const r = await routes[rota](urlDe(`${rota.split(' ')[1]}?dias=60`));
        if (r?.conectada === false) return;
        const m = {}; for (const v of r.vendas || []) if (v.valida !== false && !/cancel/i.test(v.status || '')) m[dia(v.data)] = (m[dia(v.data)] || 0) + valor(v);
        somar(canal, m);
      };
      if (D.configLer('amazon_refresh_token')) await passo('Amazon', () => porPedido('amazon', 'GET /api/amazon/pedidos', (v) => v.faturamento || 0));
      if (routes['GET /api/leroy/pedidos']) await passo('Leroy', () => porPedido('leroy', 'GET /api/leroy/pedidos', (v) => (v.faturamento || 0) + (v.frete_cliente || 0)));
      if (routes['GET /api/magalu/pedidos']) await passo('Magalu', () => porPedido('magalu', 'GET /api/magalu/pedidos', (v) => v.faturamento || 0));
      // os 60 dias lidos: zera o que não teve venda (para não ficar valor velho de outra fonte) e grava o lido
      const de = hojeBR(Date.now() - 59 * 864e5);
      const canaisLidos = [...new Set(linhas.map((l) => l.canal))];
      D.fatDiaSubstituir(de, canaisLidos, linhas);
      atualizadoEm = Date.now();
      D.configGravar('metas_atualizado_em', new Date().toISOString());
      D.configGravar('metas_erros', erros.join(' · ').slice(0, 500));
      return { erros };
    })().finally(() => { atualizando = null; });
    return atualizando;
  }

  function anoDados(ano) {
    const cfg = config(), doCnpj = cnpjDoCanal(cfg);
    const linhas = D.fatDiaPeriodo(`${ano - 1}-01-01`, `${ano}-12-31`);
    const manuais = D.fatMesManualListar();
    return { cfg, doCnpj, linhas, manuais };
  }
  // Faturamento por mês e CNPJ (dias + meses lançados à mão para o histórico do RBT12).
  function porMesCnpj(linhas, manuais, doCnpj) {
    const m = {};
    for (const l of linhas) { const c = doCnpj.get(l.canal) || '?'; const k = mesDe(l.dia); m[k] = m[k] || {}; m[k][c] = (m[k][c] || 0) + l.valor; }
    for (const x of manuais) { m[x.mes] = m[x.mes] || {}; if (!m[x.mes].__manual) m[x.mes].__manual = {}; m[x.mes].__manual[x.cnpj] = x.valor; }
    // mês com valor à mão vale o lançado (meses sem venda no painel, ex.: antes de ligar as lojas)
    for (const k of Object.keys(m)) if (m[k].__manual) { for (const [c, v] of Object.entries(m[k].__manual)) m[k][c] = v; delete m[k].__manual; }
    return m;
  }

  const rotas = {
    // Tudo da tela num pedido: ano, mês escolhido, configuração, metas, Simples de cada CNPJ.
    'GET /api/metas': async (url) => {
      await Promise.race([atualizar(url.searchParams.get('recarregar') === '1'), new Promise((ok) => setTimeout(ok, 25000))]).catch(() => null);
      const hoje = hojeBR();
      const ano = Number(url.searchParams.get('ano')) || Number(hoje.slice(0, 4));
      const mes = Number(url.searchParams.get('mes')) || (ano === Number(hoje.slice(0, 4)) ? Number(hoje.slice(5, 7)) : 12);
      const { cfg, doCnpj, linhas, manuais } = anoDados(ano);
      const metas = new Map(D.metasListar(ano).map((x) => [x.mes, x.valor]));
      const total = {}, porCanalMes = {};
      for (const l of linhas) {
        total[l.dia] = (total[l.dia] || 0) + l.valor;
        const k = mesDe(l.dia); porCanalMes[k] = porCanalMes[k] || {}; porCanalMes[k][l.canal] = r2((porCanalMes[k][l.canal] || 0) + l.valor);
      }
      const meses = Array.from({ length: 12 }, (_, i) => { const r = mesResumo({ ano, mes: i + 1, meta: metas.get(i + 1) ?? null, porDia: total }, hoje); delete r.dias; return r; });
      const escolhido = mesResumo({ ano, mes, meta: metas.get(mes) ?? null, porDia: total }, hoje);
      const pm = porMesCnpj(linhas, manuais, doCnpj);
      // Simples: RBT12 de cada CNPJ para o mês escolhido = os 12 meses anteriores a ele
      const anteriores = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(ano, mes - 2 - i, 1)); return d.toISOString().slice(0, 7); }).reverse();
      const pm12 = porMesCnpj(D.fatDiaPeriodo(`${anteriores[0]}-01`, `${anteriores[11]}-31`), manuais, doCnpj);
      const cnpjs = cfg.cnpjs.map((c) => {
        const rbt12 = anteriores.reduce((s, k) => s + (pm12[k]?.[c.id] || 0), 0);
        const semDados = anteriores.filter((k) => !pm12[k]?.[c.id]);
        const noMes = pm[`${ano}-${String(mes).padStart(2, '0')}`]?.[c.id] || 0;
        const sn = simples(rbt12, c.anexo);
        return { ...c, rbt12: r2(rbt12), meses_sem_dados: semDados, faturamento_mes: r2(noMes), simples: sn,
          imposto_mes: sn.efetiva != null ? r2(noMes * sn.efetiva) : null,
          ano: Array.from({ length: 12 }, (_, i) => r2(pm[`${ano}-${String(i + 1).padStart(2, '0')}`]?.[c.id] || 0)) };
      });
      return { ano, mes, hoje, atualizado_em: D.configLer('metas_atualizado_em'), erros: D.configLer('metas_erros') || null,
        lojas: lojas(), config: cfg, meta_anual: r2([...metas.values()].reduce((s, v) => s + v, 0)), metas: Object.fromEntries(metas),
        meses, escolhido, por_canal: porCanalMes[`${ano}-${String(mes).padStart(2, '0')}`] || {}, por_canal_ano: porCanalMes, cnpjs,
        meses_rbt12: anteriores, anexos: Object.fromEntries(Object.entries(ANEXOS).map(([k, a]) => [k, { nome: a.nome, faixas: a.faixas }])),
        shein: D.fatDiaPeriodo(`${ano}-${String(mes).padStart(2, '0')}-01`, `${ano}-${String(mes).padStart(2, '0')}-31`).filter((l) => l.canal === 'shein') };
    },
    'PUT /api/metas/meta': async (_u, b) => {
      const ano = Number(b?.ano), mes = Number(b?.mes), valor = b?.valor == null || b.valor === '' ? null : Number(b.valor);
      if (!(ano >= 2020 && ano <= 2100) || !(mes >= 1 && mes <= 12)) throw erro('Mês inválido.');
      if (valor != null && !(valor >= 0 && valor < 1e9)) throw erro('Meta inválida.');
      D.metaGravar(ano, mes, valor);
      return { ok: true };
    },
    'PUT /api/metas/config': async (_u, b) => {
      const conhecidos = new Set(lojas().map((l) => l.canal));
      const cnpjs = (Array.isArray(b?.cnpjs) ? b.cnpjs : []).slice(0, 5).map((c, i) => ({ id: String(i + 1), nome: String(c?.nome || `CNPJ ${i + 1}`).trim().slice(0, 60),
        anexo: ANEXOS[c?.anexo] ? c.anexo : 'I', canais: [...new Set((c?.canais || []).map(String).filter((k) => conhecidos.has(k)))] }));
      if (!cnpjs.length) throw erro('Informe pelo menos um CNPJ.');
      const usados = cnpjs.flatMap((c) => c.canais);
      if (new Set(usados).size !== usados.length) throw erro('Cada loja só pode estar em um CNPJ.');
      D.configGravar('metas_cnpjs', JSON.stringify({ cnpjs }));
      return { ok: true, cnpjs };
    },
    // Dias de uma planilha antiga (outro formato, ex.: "Meta Outubro 2025.xls" lida fora do painel): { linhas: [{ dia, canal, valor }] }.
    // Só dias fora dos 60 que o painel lê das lojas (esses ficam com o painel).
    'PUT /api/metas/dias': async (_u, b) => {
      const conhecidos = new Set(lojas().map((l) => l.canal));
      const lidoAte = hojeBR(Date.now() - 59 * 864e5);
      const ls = (Array.isArray(b?.linhas) ? b.linhas : []).slice(0, 5000);
      if (!ls.length) throw erro('Nenhum dia enviado.');
      const ok = [];
      for (const l of ls) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(l?.dia || '') || !conhecidos.has(String(l.canal)) || !(Number(l.valor) >= 0 && Number(l.valor) < 1e8)) throw erro(`Linha inválida: ${JSON.stringify(l).slice(0, 80)}`);
        if (l.dia < lidoAte || l.canal === 'shein') ok.push({ dia: l.dia, canal: String(l.canal), valor: r2(Number(l.valor)), fonte: 'planilha' });
      }
      D.fatDiaGravar(ok);
      return { gravados: ok.length, ignorados: ls.length - ok.length };
    },
    // Valor à mão: Shein por dia, ou o faturamento de um mês inteiro de um CNPJ (histórico do RBT12, ex.: meses de 2025).
    'PUT /api/metas/manual': async (_u, b) => {
      if (b?.dia) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dia)) throw erro('Dia inválido.');
        const v = Number(b.valor);
        if (!(v >= 0 && v < 1e8)) throw erro('Valor inválido.');
        D.fatDiaGravar([{ dia: b.dia, canal: 'shein', valor: r2(v), fonte: 'manual' }]);
        return { ok: true };
      }
      if (!/^\d{4}-\d{2}$/.test(b?.mes || '') || !['1', '2', '3', '4', '5'].includes(String(b?.cnpj))) throw erro('Informe o mês (AAAA-MM) e o CNPJ.');
      const v = b.valor == null || b.valor === '' ? null : Number(b.valor);
      if (v != null && !(v >= 0 && v < 1e9)) throw erro('Valor inválido.');
      D.fatMesManualGravar(b.mes, String(b.cnpj), v == null ? null : r2(v));
      return { ok: true };
    },
  };
  // Importar a planilha (bytes crus; server.js#tratarPainel lê o corpo). Dias que o painel já leu (últimos 60) ficam com o painel.
  function importar(buf) {
    const cfg = config(), ml = D.contasListar(), sh = D.shopeeLojasListar();
    const mapa = { 'Mercado Livre 1': ml[0] && `ml:${ml[0].ml_user_id}`, 'Mercado Livre 2': ml[1] && `ml:${ml[1].ml_user_id}`,
      'Shopee 1': sh[0] && `shopee:${sh[0].shop_id}`, 'Shopee 2': sh[1] && `shopee:${sh[1].shop_id}`, Amazon: 'amazon', Shein: 'shein', Leroy: 'leroy', Magalu: 'magalu' };
    const { dias, metas } = daPlanilha(buf, mapa);
    const lidoAte = hojeBR(Date.now() - 59 * 864e5);
    const antigos = dias.filter((d) => d.dia < lidoAte || d.canal === 'shein');
    D.fatDiaGravar(antigos.map((d) => ({ ...d, fonte: 'planilha' })));
    for (const m of metas) if (!D.metasListar(m.ano).some((x) => x.mes === m.mes)) D.metaGravar(m.ano, m.mes, m.valor);
    return { dias: antigos.length, ignorados_do_painel: dias.length - antigos.length, metas: metas.length, de: antigos[0]?.dia || null, ate: antigos.at(-1)?.dia || null, cnpjs: cfg.cnpjs.length };
  }
  return { rotas, importar, atualizar };
}

module.exports = { criar, simples, mesResumo, daPlanilha, ANEXOS, COLUNAS_PLANILHA };
