'use strict';

// =====================================================================
// Visão geral das finanças (inspirada no "Analytics Bento" do 21st.dev, em JS puro):
// - quanto está guardado no total e como isso evoluiu mês a mês;
// - gastos de cada mês, empilhados por categoria;
// - mapa de blocos coloridos mostrando para onde foi o dinheiro.
// Usa funções e o estado do app.js (state, ui, brl, esc, MESES…), chamadas só na hora de desenhar.
// =====================================================================

const CORES_CATEGORIA = {
  'Alimentação': '#FFB800', 'Mercado': '#7CFF5B', 'Transporte': '#22D3EE', 'Moradia': '#8B3DFF',
  'Contas': '#3B82F6', 'Saúde': '#FF3DA5', 'Academia': '#12B863', 'Lazer': '#FF5A1F',
  'Assinaturas': '#A78BFA', 'Compras': '#F43F5E', 'Educação': '#14B8A6', 'Transferências': '#94A3B8', 'Outros': '#71717A',
};
const corCategoria = (c) => CORES_CATEGORIA[c] || '#71717A';
// Texto escuro em cores claras e branco nas escuras
function tintaCategoria(c) {
  const n = parseInt(corCategoria(c).slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#0a0a0a' : '#ffffff';
}

const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nomeMes = (m) => `${MESES[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
function brlCurto(v) {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e6) return `${s}R$ ${(a / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `${s}R$ ${(a / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `${s}R$ ${Math.round(a)}`;
}
const somarMes = (m, n) => { const d = new Date(+m.slice(0, 4), +m.slice(5) - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// Saldos reais vindos do banco (Open Finance), se a pessoa conectou: conta, guardado e fatura
function saldosReais() {
  const s = typeof pluggyConectado === 'function' && pluggyConectado() ? pluggyConfig().saldos : null;
  if (!s?.contas?.length) return null;
  const soma = (lista) => lista.reduce((a, x) => a + x.saldo, 0);
  const naConta = soma(s.contas.filter((c) => c.tipo === 'BANK' && c.subtipo !== 'SAVINGS_ACCOUNT'));
  const poupanca = soma(s.contas.filter((c) => c.subtipo === 'SAVINGS_ACCOUNT'));
  const fatura = soma(s.contas.filter((c) => c.tipo === 'CREDIT'));
  const guardado = poupanca + soma(s.investimentos || []);
  return { naConta, guardado, fatura, total: naConta + guardado, quando: s.quando, investimentos: s.investimentos || [], temCartao: s.contas.some((c) => c.tipo === 'CREDIT') };
}

// Um resumo por mês, do primeiro lançamento até o mês atual, com o acumulado.
// Com o banco conectado, o último mês bate com o saldo real (conta + guardado) e os anteriores são
// reconstruídos para trás pelo que sobrou em cada mês; sem banco, soma a partir do valor informado em "Ajustar".
function historicoMensal() {
  const ts = state.transacoes;
  if (!ts.length) return [];
  let mes = ts.reduce((m, t) => (t.data < m ? t.data : m), ts[0].data).slice(0, 7);
  const fim = [hoje().slice(0, 7), ...ts.map((t) => t.data.slice(0, 7))].sort().at(-1);
  const meses = [];
  while (mes <= fim) {
    const r = resumoMes(mes);
    meses.push({ mes, receitas: r.receitas, despesas: r.despesas, saldo: r.saldo, porCat: r.porCat });
    mes = somarMes(mes, 1);
  }
  const real = saldosReais();
  if (real) {
    let acumulado = real.total;
    for (let i = meses.length - 1; i >= 0; i--) { meses[i].acumulado = acumulado; acumulado -= meses[i].saldo; }
  } else {
    let acumulado = parseNum(state.config.saldoInicial) || 0;
    for (const m of meses) { acumulado += m.saldo; m.acumulado = acumulado; }
  }
  return meses;
}

// Caminho suave entre pontos (catmull-rom em curvas bézier)
function caminhoSuave(P) {
  if (P.length < 2) return '';
  const g = (i) => P[Math.max(0, Math.min(P.length - 1, i))];
  let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2), k = 0.18;
    d += `C${(p1[0] + (p2[0] - p0[0]) * k).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) * k).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) * k).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) * k).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

// Texto do balão de detalhes (lido pelo tooltip ao tocar/passar o mouse)
const dicaJson = (titulo, linhas) => esc(JSON.stringify({ titulo, linhas }));

// Largura útil dentro de um card (desconta o padding da página e o do card), para os desenhos saírem no tamanho real
function larguraCard() {
  const app = $('#app');
  if (!app) return 320;
  const cs = getComputedStyle(app);
  const util = app.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return Math.max(240, Math.floor(util - 2 * 18 - 2));
}

// ---------- Guardado no total ----------
function graficoGuardado(meses) {
  const W = larguraCard() - 2, H = 150, padX = 14, top = 16, bot = 22;
  const vals = meses.map((m) => m.acumulado);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals, 1);
  const X = (i) => padX + (meses.length === 1 ? (W - 2 * padX) / 2 : (i / (meses.length - 1)) * (W - 2 * padX));
  const Y = (v) => top + (1 - (v - lo) / (hi - lo || 1)) * (H - top - bot);
  const P = meses.map((m, i) => [X(i), Y(m.acumulado)]);
  // Com um mês só, desenha uma linha reta de ponta a ponta (ainda não há evolução para mostrar)
  if (P.length === 1) P.unshift([padX, P[0][1]]), (P[1][0] = W - padX);
  const d = caminhoSuave(P);
  const ult = P.at(-1);
  const zero = lo < 0 ? `<line class="fin-zero" x1="0" x2="${W}" y1="${Y(0)}" y2="${Y(0)}"/>` : '';
  const passo = Math.max(1, Math.ceil(meses.length / 6));
  const rotulos = meses.map((m, i) => (i % passo === 0 || i === meses.length - 1)
    ? `<text class="fin-eixo" x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 && meses.length > 1 ? 'start' : i === meses.length - 1 && meses.length > 1 ? 'end' : 'middle'}">${MESES_CURTOS[+m.mes.slice(5) - 1]}${m.mes.endsWith('-01') || i === 0 ? '/' + m.mes.slice(2, 4) : ''}</text>` : '').join('');
  const rotuloTotal = saldosReais() ? 'Conta + guardado' : 'Guardado';
  const alvos = meses.map((m, i) => `<circle class="fin-alvo" cx="${X(i)}" cy="${Y(m.acumulado)}" r="14" data-tip="${dicaJson(nomeMes(m.mes), [
    [rotuloTotal, brl(m.acumulado), 'var(--grafico)'], ['Sobrou no mês', `${m.saldo >= 0 ? '+' : '−'}${brl(Math.abs(m.saldo))}`],
  ])}"/>`).join('');
  return `<svg class="fin-grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução do total guardado">
    <defs><linearGradient id="finArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fin-grad-a"/><stop offset="1" class="fin-grad-b"/></linearGradient></defs>
    ${zero}
    <path class="fin-area" d="${d}L${ult[0]},${H - bot}L${P[0][0]},${H - bot}Z"/>
    <path class="fin-linha" d="${d}" pathLength="1"/>
    <circle class="fin-ponto" cx="${ult[0]}" cy="${ult[1]}" r="4.5"/>
    ${rotulos}${alvos}
  </svg>`;
}

// ---------- Gastos por mês (barras empilhadas por categoria) ----------
function graficoMeses(meses) {
  const ultimos = meses.slice(-12);
  const W = larguraCard() - 2, H = 190, padX = 6, top = 10, bot = 24;
  const max = Math.max(1, ...ultimos.map((m) => m.despesas));
  const slot = (W - 2 * padX) / ultimos.length, larg = Math.min(34, slot * 0.62);
  const Y = (v) => (v / max) * (H - top - bot);
  // Mesma ordem de categorias em todas as barras (as maiores embaixo)
  const totais = {};
  ultimos.forEach((m) => Object.entries(m.porCat).forEach(([c, v]) => { totais[c] = (totais[c] || 0) + v; }));
  const ordem = Object.keys(totais).sort((a, b) => totais[b] - totais[a]);
  const barras = ultimos.map((m, i) => {
    const x = padX + i * slot + (slot - larg) / 2;
    let y = H - bot;
    const blocos = ordem.filter((c) => m.porCat[c]).map((c, k) => {
      const h = Math.max(1.5, Y(m.porCat[c]) - 1.5);
      y -= h + 1.5;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${larg.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${corCategoria(c)}" style="--i:${i};--k:${k}"/>`;
    }).join('');
    const linhas = ordem.filter((c) => m.porCat[c]).map((c) => [c, brl(m.porCat[c]), corCategoria(c)]);
    linhas.push(['Total', brl(m.despesas)]);
    return `<g class="fin-barra ${m.mes === ui.mes ? 'atual' : ''}" data-act="mesIr" data-v="${m.mes}" data-tip="${dicaJson(nomeMes(m.mes), linhas)}">
      <rect class="fin-barra-fundo" x="${(padX + i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"/>
      ${blocos}
      <text class="fin-eixo" x="${(x + larg / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${MESES_CURTOS[+m.mes.slice(5) - 1]}</text>
    </g>`;
  }).join('');
  return `<svg class="fin-grafico fin-barras" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gastos por mês">
    <line class="fin-zero" x1="0" x2="${W}" y1="${H - bot}" y2="${H - bot}"/>${barras}</svg>`;
}

// ---------- Mapa de blocos (treemap "squarified") ----------
function squarify(itens, x, y, w, h) {
  const total = itens.reduce((a, b) => a + b.v, 0) || 1, escala = (w * h) / total, saida = [];
  let resto = itens.map((i) => ({ ...i, a: i.v * escala }));
  const pior = (linha, lado) => {
    const s = linha.reduce((a, b) => a + b.a, 0), mx = Math.max(...linha.map((r) => r.a)), mn = Math.min(...linha.map((r) => r.a));
    return Math.max((lado * lado * mx) / (s * s), (s * s) / (lado * lado * mn));
  };
  while (resto.length) {
    const lado = Math.min(w, h), linha = [resto[0]];
    let i = 1;
    while (i < resto.length && pior([...linha, resto[i]], lado) <= pior(linha, lado)) linha.push(resto[i++]);
    resto = resto.slice(i);
    const s = linha.reduce((a, b) => a + b.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; for (const r of linha) { const rh = r.a / cw; saida.push({ ...r, x, y: cy, w: cw, h: rh }); cy += rh; } x += cw; w -= cw; }
    else { const rh = s / w; let cx = x; for (const r of linha) { const rw = r.a / rh; saida.push({ ...r, x: cx, y, w: rw, h: rh }); cx += rw; } y += rh; h -= rh; }
  }
  return saida;
}

function mapaCategorias(porCat) {
  const itens = Object.entries(porCat).filter(([, v]) => v > 0).map(([nome, v]) => ({ nome, v })).sort((a, b) => b.v - a.v);
  if (!itens.length) return '<p class="vazio">Nenhum gasto neste período.</p>';
  const W = larguraCard(), H = W < 420 ? 300 : 340, G = 6;
  const total = itens.reduce((a, b) => a + b.v, 0);
  return `<div class="fin-mapa" style="height:${H}px">${squarify(itens, 0, 0, W + G, H + G).map((r, i) => {
    const w = r.w - G, h = r.h - G, pct = `${((r.v / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
    const valor = brl(r.v);
    // O valor e a porcentagem precisam caber lado a lado; se não couber, a porcentagem sai (fica no balão)
    let mostraPct = h > 70, fs = Math.min(26, (w - 24 - 50) / (valor.length * 0.6));
    if (fs < 14) { mostraPct = false; fs = Math.min(26, (w - 22) / (valor.length * 0.6)); }
    const mostraNome = h >= 46 && w >= 70, mostraValor = fs >= 11 && h >= 64;
    return `<button class="fin-bloco ${ui.filtroCat === r.nome ? 'ativo' : ''}" data-act="filtroCat" data-v="${esc(r.nome)}"
      style="left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;background:${corCategoria(r.nome)};color:${tintaCategoria(r.nome)};--i:${i}"
      data-tip="${dicaJson(r.nome, [['Gasto', valor, corCategoria(r.nome)], ['Parte do total', pct]])}" aria-label="${esc(r.nome)}: ${valor} (${pct})">
      ${mostraNome ? `<span class="fin-bloco-nome">${esc(r.nome)}</span>` : ''}
      ${mostraValor ? `<span class="fin-bloco-rodape"><b style="font-size:${fs.toFixed(0)}px">${valor}</b>${mostraPct ? `<em>${pct}</em>` : ''}</span>` : ''}
    </button>`;
  }).join('')}</div>`;
}

// ---------- Bento: os três cards juntos ----------
function visaoFinancas() {
  const meses = historicoMensal();
  if (!meses.length) {
    return `<div class="card fin-vazio">${ic('wallet', 'ic-grande')}<p>Lance receitas e despesas (ou importe um extrato) para ver quanto você guardou, os gastos de cada mês e para onde vai o dinheiro.</p></div>`;
  }
  const atual = meses.find((m) => m.mes === ui.mes) || meses.at(-1);
  const anterior = meses[meses.indexOf(atual) - 1];
  const total = meses.at(-1).acumulado;
  const real = saldosReais();
  const periodo = ui.mapaPeriodo;
  const porCat = {};
  const doPeriodo = periodo === 'mes' ? [atual] : periodo === 'ano' ? meses.filter((m) => m.mes.startsWith(ui.mes.slice(0, 4))) : meses;
  doPeriodo.forEach((m) => Object.entries(m.porCat).forEach(([c, v]) => { porCat[c] = (porCat[c] || 0) + v; }));
  const gastoPeriodo = Object.values(porCat).reduce((a, b) => a + b, 0);
  const rotuloPeriodo = periodo === 'mes' ? nomeMes(atual.mes) : periodo === 'ano' ? `Ano de ${ui.mes.slice(0, 4)}` : 'Desde o início';
  const mediaGastos = meses.slice(-6).reduce((a, m) => a + m.despesas, 0) / Math.min(6, meses.length);
  const varGasto = anterior && anterior.despesas ? (atual.despesas - anterior.despesas) / anterior.despesas : null;

  return `
    <div class="fin-bento">
      ${real ? `
      <section class="card fin-card fin-guardado">
        <div class="fin-card-topo">
          <span class="card-label">Seu dinheiro hoje</span>
          <span class="muted fin-legenda-mini">do banco · ${tempoRelativo(real.quando)}</span>
        </div>
        <div class="fin-saldos">
          <div><span>Na conta</span><b class="${real.naConta < 0 ? 'neg' : ''}" data-contar="${real.naConta}" data-chave="naConta">${brl(real.naConta)}</b></div>
          <div data-tip="${dicaJson('Guardado', real.investimentos.length ? real.investimentos.map((i) => [i.nome, brl(i.saldo)]) : [['Caixinhas e investimentos', brl(real.guardado)]])}">
            <span>Guardado</span><b class="pos" data-contar="${real.guardado}" data-chave="guardadoReal">${brl(real.guardado)}</b></div>
          ${real.temCartao ? `<div><span>Fatura do cartão</span><b class="neg" data-contar="${real.fatura}" data-chave="fatura">${brl(real.fatura)}</b></div>` : ''}
        </div>
        <div class="card-sub" style="margin-top:10px">Conta + guardado ao longo do tempo · <span class="${atual.saldo >= 0 ? 'pos' : 'neg'}">${atual.saldo >= 0 ? '▲' : '▼'} ${brl(Math.abs(atual.saldo))}</span> em ${MESES[+atual.mes.slice(5) - 1].toLowerCase()}</div>
        <div class="fin-area-grafico">${graficoGuardado(meses)}</div>
      </section>` : `
      <section class="card fin-card fin-guardado">
        <div class="fin-card-topo">
          <span class="card-label">Guardado no total</span>
          <button class="link-btn fin-ajustar" data-act="ajustarGuardado">Ajustar</button>
        </div>
        <div class="fin-numero ${total < 0 ? 'neg' : ''}" data-contar="${total}" data-chave="guardado">${brl(total)}</div>
        <div class="card-sub"><span class="${atual.saldo >= 0 ? 'pos' : 'neg'}">${atual.saldo >= 0 ? '▲' : '▼'} ${brl(Math.abs(atual.saldo))}</span> em ${MESES[+atual.mes.slice(5) - 1].toLowerCase()} · estimado pelos lançamentos</div>
        <div class="fin-area-grafico">${graficoGuardado(meses)}</div>
      </section>`}

      <section class="card fin-card">
        <div class="fin-card-topo"><span class="card-label">Gastos por mês</span><span class="muted fin-legenda-mini">toque numa barra para abrir o mês</span></div>
        <div class="fin-numero" data-contar="${atual.despesas}" data-chave="gastoMes">${brl(atual.despesas)}</div>
        <div class="card-sub">${varGasto === null ? `média de ${brl(mediaGastos)} por mês` : `<span class="${varGasto <= 0 ? 'pos' : 'neg'}">${varGasto <= 0 ? '▼' : '▲'} ${Math.abs(varGasto * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%</span> em relação a ${MESES[+anterior.mes.slice(5) - 1].toLowerCase()}`}</div>
        <div class="fin-area-grafico">${graficoMeses(meses)}</div>
      </section>

      <section class="card fin-card">
        <div class="fin-card-topo fin-card-topo-mapa">
          <span class="card-label">Para onde foi o dinheiro</span>
          <div class="segmento">${[['mes', 'Mês'], ['ano', 'Ano'], ['tudo', 'Tudo']].map(([v, t]) => `<button data-act="mapaPeriodo" data-v="${v}" class="${periodo === v ? 'ativo' : ''}">${t}</button>`).join('')}</div>
        </div>
        <div class="fin-numero" data-contar="${gastoPeriodo}" data-chave="mapa-${periodo}">${brl(gastoPeriodo)}</div>
        <div class="card-sub">${rotuloPeriodo} · toque num bloco para ver os lançamentos</div>
        <div class="fin-legenda">${Object.keys(porCat).sort((a, b) => porCat[b] - porCat[a]).map((c) => `<span><i style="background:${corCategoria(c)}"></i>${esc(c)}</span>`).join('')}</div>
        ${mapaCategorias(porCat)}
      </section>
    </div>`;
}

// ---------- Números que "contam" até o valor ----------
const ultimosNumeros = {};
function animarNumeros() {
  const reduzir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-contar]').forEach((el) => {
    const alvo = Number(el.dataset.contar), chave = el.dataset.chave;
    const de = ultimosNumeros[chave] ?? 0;
    ultimosNumeros[chave] = alvo;
    if (reduzir || de === alvo) { el.textContent = brl(alvo); return; }
    const t0 = performance.now(), dur = 900;
    const passo = (agora) => {
      const t = Math.min(1, (agora - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      el.textContent = brl(de + (alvo - de) * e);
      if (t < 1 && el.isConnected) requestAnimationFrame(passo);
    };
    requestAnimationFrame(passo);
  });
}

// ---------- Balão de detalhes (tooltip) ----------
(() => {
  const tip = document.createElement('div');
  tip.id = 'fin-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let timer;
  const mostrar = (el, x, y) => {
    let dados;
    try { dados = JSON.parse(el.dataset.tip); } catch (e) { return; }
    tip.innerHTML = `<div class="fin-tip-titulo">${esc(dados.titulo)}</div>${dados.linhas.map(([rot, val, cor]) =>
      `<div class="fin-tip-linha"><span>${cor ? `<i style="background:${cor}"></i>` : ''}${esc(rot)}</span><b>${esc(val)}</b></div>`).join('')}`;
    tip.classList.add('visivel');
    const r = tip.getBoundingClientRect();
    let l = x + 14, t = y - r.height - 12;
    if (l + r.width > innerWidth - 8) l = x - r.width - 14;
    if (l < 8) l = 8;
    if (t < 8) t = y + 16;
    tip.style.left = `${l}px`;
    tip.style.top = `${t}px`;
  };
  const esconder = () => tip.classList.remove('visivel');
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (el) mostrar(el, e.clientX, e.clientY); else esconder();
  });
  // No celular: toque mostra o balão por alguns segundos
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest?.('[data-tip]');
    if (!el) { esconder(); return; }
    mostrar(el, e.clientX, e.clientY);
    clearTimeout(timer);
    timer = setTimeout(esconder, 2500);
  });
  window.addEventListener('scroll', esconder, { passive: true });
  window.addEventListener('hashchange', esconder);

  // Os desenhos usam a largura da tela: ao girar o celular ou redimensionar, redesenha as finanças
  let largura = innerWidth, espera;
  window.addEventListener('resize', () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      if (Math.abs(innerWidth - largura) < 8 || location.hash !== '#financas' || modalAberto()) return;
      largura = innerWidth;
      render();
    }, 200);
  });
})();
