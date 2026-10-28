'use strict';

// =====================================================================
// Estado: salvo no aparelho (localStorage) e, com contas ativadas, sincronizado no Firebase
// =====================================================================
const STORAGE_KEY = 'tetis-dados';
const NUVEM_ATIVA = !!window.FIREBASE_CONFIG;

const CATEGORIAS = ['Alimentação', 'Mercado', 'Transporte', 'Moradia', 'Contas', 'Saúde', 'Academia', 'Lazer',
  'Assinaturas', 'Compras', 'Educação', 'Transferências', 'Outros'];
const CATEGORIAS_RECEITA = ['Salário', 'Renda extra', 'Rendimentos', 'Reembolso', 'Transferências', 'Outros'];

// Palavras-chave para categorizar lançamentos importados automaticamente.
const REGRAS_DESPESA = [
  [/ifood|rappi|restaurante|lanchonete|padaria|pizza|burger|mcdonald|outback|starbucks|cafeteria/i, 'Alimentação'],
  [/supermerc|mercado(?! ?livre|pago)|carrefour|assai|atacad|pao de acucar|hortifruti|guanabara|prezunic|zona sul/i, 'Mercado'],
  [/\buber\b|99 ?app|99 ?pop|\btaxi\b|cabify|\bposto\b|combust|\bshell\b|ipiranga|estaciona|sem parar|veloe|conectcar|\bmetro\b|metro rio|riocard|bilhete unico/i, 'Transporte'],
  [/aluguel|condominio|iptu/i, 'Moradia'],
  [/\benel\b|\blight\b|cedae|sabesp|naturgy|\bclaro\b|\bvivo\b|\btim\b|internet|energia eletrica|conta de (luz|agua|gas)|telefon/i, 'Contas'],
  [/farmacia|drogaria|\braia\b|drogarias? pacheco|drogasil|hospital|clinica|laborat|unimed|\bamil\b|odonto/i, 'Saúde'],
  [/academia|smart ?fit|bodytech|selfit|gympass|wellhub|totalpass|bluefit/i, 'Academia'],
  [/netflix|spotify|prime video|amazon prime|disney|hbo|youtube|apple\.com|icloud|google one|deezer|globoplay|paramount|chatgpt|openai|claude/i, 'Assinaturas'],
  [/cinema|ingresso|steam|playstation|xbox|nintendo/i, 'Lazer'],
  [/amazon|mercado ?livre|shopee|magalu|magazine|americanas|aliexpress|shein|renner|riachuelo|kabum/i, 'Compras'],
  [/escola|faculdade|curso|udemy|alura|livraria/i, 'Educação'],
  [/\bpix\b|\bted\b|\bdoc\b|transf/i, 'Transferências'],
];
const REGRAS_RECEITA = [
  [/salario|proventos|folha|pagamento de salario/i, 'Salário'],
  [/rendimento|juros|dividend/i, 'Rendimentos'], // "resgate" não é ganho: é o seu dinheiro voltando (e "Resgate Pet Shop" é loja)
  [/estorno|reembolso|devolu/i, 'Reembolso'],
  [/\bpix\b|\bted\b|\bdoc\b|transf/i, 'Transferências'],
];

function estadoInicial() {
  return {
    versao: 1,
    config: { altura: '', metaPeso: '', orcamentos: {} },
    fichas: [],        // { id, nome, exercicios: [{ nome, series, reps, carga }] }
    sessoes: [],       // { id, fichaId, nome, data, inicio, fim, obs, itens: [{ nome, series, reps, carga, feito }] }
    sessaoAtual: null,
    perfil: { nome: '', foto: '' }, // foto: imagem JPEG pequena (data URL), sincronizada com a conta
    checkins: [],      // datas AAAA-MM-DD em que você foi à academia
    checkinsNoDia: [], // as que foram marcadas no próprio dia (só essas contam no ranking)
    pesos: [],       // { id, data, peso }
    notas: [],         // { id, titulo, texto, fixada, atualizada }
    transacoes: [],    // { id, data, descricao, valor (negativo = despesa), categoria, origem, chave }
    regras: {},        // descrição normalizada -> categoria (aprendida quando você corrige)
    integracoes: {},   // pluggy: { clientId, clientSecret, itens[{ id, banco, status }], ultimaSync } — Open Finance
  };
}

// Conta logada e situação da sincronização
const conta = {
  usuario: null,     // { uid, email, nome }
  verificada: !NUVEM_ATIVA, // já sabemos se há alguém logado?
  sincronizada: false, // recebeu a primeira resposta do servidor
  enviado: {},       // id da parte -> JSON que o servidor tem (para enviar só o que mudou)
  timer: null,
  erro: '',
};

// Cada conta tem seu próprio espaço no aparelho; sem contas, usa a chave antiga
const chaveLocal = () => (conta.usuario ? `${STORAGE_KEY}:${conta.usuario.uid}` : STORAGE_KEY);
const chaveSync = () => `tetis-sync:${conta.usuario.uid}`;

// Confere o formato de tudo o que vem de fora (backup, aparelho, nuvem): só passam as chaves conhecidas,
// com o tipo certo. Item quebrado (ex.: lançamento sem data) é descartado em vez de travar o app.
const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;
function normalizarEstado(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Dados inválidos.');
  const base = estadoInicial();
  const lista = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);
  const objeto = (v, padrao) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...padrao, ...v } : { ...padrao });
  const datas = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && DATA_OK.test(x)))] : []);
  const temData = (x) => typeof x.data === 'string' && dataValida(x.data);
  // Mesmo id duas vezes (ex.: item que mudou de ano num aparelho e foi editado no outro): fica o primeiro
  const unicos = (itens) => { const vistos = new Set(); return itens.filter((x) => x.id == null || (!vistos.has(x.id) && vistos.add(x.id))); };
  const s = {
    ...base,
    config: objeto(d.config, base.config),
    fichas: lista(d.fichas).map((f) => ({ ...f, nome: String(f.nome ?? ''), exercicios: lista(f.exercicios) })),
    sessoes: unicos(lista(d.sessoes).filter(temData).map((x) => ({ ...x, itens: lista(x.itens) }))),
    sessaoAtual: d.sessaoAtual && typeof d.sessaoAtual === 'object' && Array.isArray(d.sessaoAtual.itens) && temData(d.sessaoAtual) ? d.sessaoAtual : null,
    perfil: objeto(d.perfil, base.perfil),
    checkins: datas(d.checkins),
    checkinsNoDia: datas(d.checkinsNoDia),
    pesos: lista(d.pesos).filter((p) => temData(p) && Number(p.peso) > 0 && Number(p.peso) < 1000),
    notas: lista(d.notas),
    transacoes: unicos(lista(d.transacoes).map((t) => (typeof t.valor === 'string' ? { ...t, valor: parseNum(t.valor) } : t))
      .filter((t) => temData(t) && Number.isFinite(t.valor) && t.valor !== 0)
      .map((t) => ({ ...t, descricao: String(t.descricao ?? ''), categoria: String(t.categoria || 'Outros') }))),
    regras: objeto(d.regras, {}),
    integracoes: objeto(d.integracoes, {}),
  };
  if (!s.config.orcamentos || typeof s.config.orcamentos !== 'object' || Array.isArray(s.config.orcamentos)) s.config.orcamentos = {};
  return s;
}

function lerLocal(chave) {
  try {
    const bruto = localStorage.getItem(chave);
    if (bruto) return normalizarEstado(JSON.parse(bruto));
  } catch (e) { /* armazenamento indisponível ou corrompido */ }
  return null;
}

const carregar = () => lerLocal(chaveLocal()) || estadoInicial();

let state = NUVEM_ATIVA ? estadoInicial() : carregar();

function salvar() {
  if (NUVEM_ATIVA && !conta.usuario) return;
  try {
    localStorage.setItem(chaveLocal(), JSON.stringify(state));
  } catch (e) {
    toast('Não foi possível salvar neste aparelho. Faça um backup em Configurações.');
  }
  if (conta.usuario) agendarEnvio();
}

// ---------- Sincronização ----------
// Os dados vão para o Firestore divididos em partes (cada documento tem limite de 1 MB):
// "base" com o que é pequeno, "perfil" (por causa da foto) e treinos/lançamentos separados por ano.
function particionar(s) {
  const { sessoes, transacoes, perfil, ...base } = s;
  // O Client Secret da Pluggy nunca sobe para a nuvem (fica só no aparelho — ver openfinance.js)
  const pluggy = base.integracoes?.pluggy;
  if (pluggy?.clientSecret) {
    if (s === state) guardarSegredo(pluggy.clientSecret);
    const { clientSecret, ...semSegredo } = pluggy;
    base.integracoes = { ...base.integracoes, pluggy: semSegredo };
  }
  const partes = { base, perfil };
  for (const [nome, lista] of [['sessoes', sessoes], ['transacoes', transacoes]]) {
    // Item sem data válida (corrompido) não trava a sincronização: fica de fora
    for (const item of lista) if (DATA_OK.test(item?.data)) (partes[`${nome}-${item.data.slice(0, 4)}`] ??= []).push(item);
  }
  return Object.fromEntries(Object.entries(partes).map(([id, v]) => [id, JSON.stringify(v)]));
}

function juntar(partesJson) {
  // Uma parte corrompida não pode derrubar as outras
  const ler = (json, padrao) => { try { return json ? JSON.parse(json) : padrao; } catch (e) { return padrao; } };
  const s = { ...ler(partesJson.base, {}), sessoes: [], transacoes: [] };
  s.perfil = ler(partesJson.perfil, {});
  for (const [id, json] of Object.entries(partesJson)) {
    const m = id.match(/^(sessoes|transacoes)-/);
    const itens = m && ler(json, []);
    if (Array.isArray(itens)) s[m[1]].push(...itens);
  }
  return normalizarEstado(s);
}

// Mesclagem de 3 vias de uma parte que mudou aqui E na nuvem, usando como referência a última versão que os dois tinham:
// - treinos/lançamentos: item a item pelo id (novos dos dois lados entram; apagado de um lado sai; editado nos dois, vale o daqui);
// - base/perfil: campo a campo, e as listas (pesos, notas, fichas, check-ins) item a item (ver mesclarLista).
function mesclarParte(id, localJson, remotoJson, baseJson) {
  const ler = (j, padrao) => { try { return j ? JSON.parse(j) : padrao; } catch (e) { return undefined; } };
  const lista = /^(sessoes|transacoes)-/.test(id);
  const local = ler(localJson, lista ? [] : {}), remoto = ler(remotoJson, lista ? [] : {});
  // Versão da nuvem ilegível: fica a daqui inteira (nunca apagar o que está aqui por causa de lixo vindo de lá)
  if (remoto === undefined || (lista && !Array.isArray(remoto))) return localJson;
  if (local === undefined) return remotoJson;
  const base = ler(baseJson, lista ? [] : {}) ?? (lista ? [] : {});
  return JSON.stringify(lista ? mesclarLista(local, remoto, Array.isArray(base) ? base : []) : mesclarObjeto(local, remoto, base));
}

const ehObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Campo a campo; listas (pesos, notas, fichas, check-ins) item a item; objetos (regras, config, orçamentos) descendo neles
function mesclarObjeto(local, remoto, base) {
  const saida = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remoto)])) {
    const l = local[k], r = remoto[k], b = ehObjeto(base) ? base[k] : undefined;
    let v;
    if (igual(l, b)) v = r;
    else if (igual(r, b)) v = l;
    else if (Array.isArray(l) && Array.isArray(r)) v = mesclarLista(l, r, Array.isArray(b) ? b : []);
    else if (ehObjeto(l) && ehObjeto(r)) v = mesclarObjeto(l, r, ehObjeto(b) ? b : {});
    else v = l;
    if (v !== undefined) saida[k] = v;
  }
  return saida;
}

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 3 vias numa lista: itens com id são comparados pelo id; valores simples (datas de check-in) como conjunto.
// Novo de qualquer lado entra; apagado de um lado (e não editado do outro) sai; editado dos dois lados, vale o daqui.
function mesclarLista(local, remoto, base) {
  const chave = (x) => (x && typeof x === 'object' ? (x.id != null ? `id:${x.id}` : `json:${JSON.stringify(x)}`) : `v:${JSON.stringify(x)}`);
  const mapa = (lista) => new Map(lista.map((x) => [chave(x), x]));
  const B = mapa(base), L = mapa(local), R = mapa(remoto);
  const saida = [];
  for (const k of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(k), r = R.get(k), b = B.get(k);
    // Mesmo item editado nos dois aparelhos: junta campo a campo (categoria daqui + descrição de lá); conflito no mesmo campo, vale o daqui
    if (l !== undefined && r !== undefined) saida.push(igual(l, b) ? r : igual(r, b) ? l : ehObjeto(l) && ehObjeto(r) ? mesclarObjeto(l, r, ehObjeto(b) ? b : {}) : l);
    else if (l !== undefined) { if (b === undefined || !igual(l, b)) saida.push(l); }
    else if (b === undefined || !igual(r, b)) saida.push(r);
  }
  return saida;
}

function agendarEnvio() {
  clearTimeout(conta.timer);
  conta.timer = setTimeout(enviarAlteracoes, 1200);
}

async function enviarAlteracoes() {
  if (!conta.usuario || !conta.sincronizada || !window.Nuvem) return;
  publicarRanking();
  const local = particionar(state);
  const alteradas = Object.fromEntries(Object.entries(local).filter(([id, json]) => conta.enviado[id] !== json));
  const removidas = Object.keys(conta.enviado).filter((id) => !(id in local));
  if (!Object.keys(alteradas).length && !removidas.length) return;
  const anterior = { ...conta.enviado };
  Object.assign(conta.enviado, alteradas);
  removidas.forEach((id) => delete conta.enviado[id]);
  guardarSync();
  try {
    await window.Nuvem.enviar(conta.usuario.uid, alteradas, removidas);
    conta.erro = '';
  } catch (e) {
    // Não chegou na nuvem: volta a referência, para a próxima mesclagem saber que isso ainda é mudança daqui
    conta.enviado = anterior;
    guardarSync();
    conta.erro = 'Não foi possível enviar para a nuvem. Os dados continuam salvos neste aparelho.';
    toast(conta.erro);
  }
}

function guardarSync() {
  try { localStorage.setItem(chaveSync(), JSON.stringify(conta.enviado)); } catch (e) { /* sem espaço */ }
}

// Chamado pelo nuvem.js — a ponte entre o Firebase e o app
window.Tetis = {
  comUsuario(u) {
    conta.usuario = u;
    conta.verificada = true;
    conta.sincronizada = false;
    try { conta.enviado = JSON.parse(localStorage.getItem(chaveSync()) || '{}'); } catch (e) { conta.enviado = {}; }
    state = carregar();
    render(true);
  },
  atualizarNome(nome) {
    if (conta.usuario) { conta.usuario.nome = nome; render(); }
  },
  semUsuario() {
    clearTimeout(conta.timer);
    Object.assign(conta, { usuario: null, verificada: true, sincronizada: false, enviado: {} });
    state = estadoInicial();
    render(true);
  },
  // partes: id -> JSON. doCache: veio do cache do aparelho (ainda sem confirmação do servidor)
  recebeuNuvem(partes, { doCache, pendente }) {
    if (!conta.usuario || pendente) return;
    const temRemoto = Object.keys(partes).length > 0;

    if (!conta.sincronizada) {
      if (doCache) return; // espera o servidor antes de decidir qualquer coisa
      conta.sincronizada = true;
      const jaSincronizouAqui = Object.keys(conta.enviado).length > 0;
      if (!temRemoto) {
        // Conta nova: leva os dados que já existiam neste aparelho (de antes das contas)
        const antigos = lerLocal(STORAGE_KEY);
        if (antigos && !jaSincronizouAqui) {
          state = antigos;
          try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ok */ }
          toast('Seus dados deste aparelho foram enviados para a sua conta.');
        }
        conta.enviado = {};
        salvar();
        render();
        return;
      }
      if (!jaSincronizouAqui) {
        // Primeiro acesso neste aparelho: a nuvem manda
        conta.enviado = { ...partes };
        guardarSync();
        state = juntar(partes);
        salvar();
        render();
        return;
      }
    }

    // Mescla por parte: o que só mudou aqui fica, o que só mudou na nuvem vem de lá.
    // Se os dois lados mexeram na mesma parte, junta item a item (ver mesclarParte).
    const local = particionar(state);
    const final = {};
    for (const id of new Set([...Object.keys(local), ...Object.keys(partes)])) {
      const base = conta.enviado[id];
      const mudouAqui = local[id] !== base, mudouLa = partes[id] !== base;
      // Parte inteira apagada aqui (ex.: último lançamento do ano) mas alterada lá: junta, para não perder o que entrou lá
      const valor = !mudouAqui ? partes[id] : !mudouLa || partes[id] === undefined ? local[id]
        : mesclarParte(id, local[id] ?? (/^(sessoes|transacoes)-/.test(id) ? '[]' : '{}'), partes[id], base);
      if (valor !== undefined) final[id] = valor;
    }
    conta.enviado = { ...partes };
    guardarSync();
    const novo = juntar(final);
    const mudou = JSON.stringify(novo) !== JSON.stringify(state);
    state = novo;
    try { localStorage.setItem(chaveLocal(), JSON.stringify(state)); } catch (e) { /* ok */ }
    agendarEnvio();
    // Redesenha só se não estiver digitando ou com um modal aberto
    const ativo = document.activeElement;
    const digitando = ativo?.matches?.('input, textarea, select') && ativo.closest('#app');
    if (mudou && !digitando && !modalAberto()) render();
  },
  erroNuvem(e) {
    conta.erro = e?.code === 'permission-denied'
      ? 'Sem permissão no banco de dados. Confira as regras do Firestore.'
      : 'Sem conexão com a nuvem. Os dados continuam salvos neste aparelho.';
    toast(conta.erro);
  },
};

// Estado só da interface (não precisa persistir)
const ui = { pesoPeriodo: '90', buscaNotas: '', mes: hoje().slice(0, 7), filtroCat: '', exercicio: '', calMes: hoje().slice(0, 7), ultimoCheckin: '',
  // Preferência do aparelho (não sincroniza): quem está do lado não vê seus valores neste celular
  ocultarValores: (() => { try { return localStorage.getItem('tetis-ocultar') === '1'; } catch (e) { return false; } })(),
  modoLogin: 'entrar', emailLogin: '', entrando: false, treinoAba: 'meu', rankPeriodo: 'mes',
  grupoAtual: '', grupoAba: 'ranking', mapaPeriodo: 'mes' };

// =====================================================================
// Utilitários
// =====================================================================
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const chaveDesc = (s) => norm(s).replace(/\d+/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// Data local em AAAA-MM-DD, deslocada em dias (0 = hoje, -1 = ontem…)
function diaISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function hoje() { return diaISO(0); }

// Ícones dos cards (Lucide, ver icones.js)
const ICONES = {
  peso: ic('scale'),
  treino: ic('dumbbell'),
  financas: ic('wallet'),
  pessoa: ic('user'),
  camera: ic('camera'),
};
const fmtData = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const fmtDataCurta = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const diaSemana = (iso) => DIAS[new Date(iso + 'T12:00').getDay()];
const diasDesde = (iso) => Math.floor((Date.parse(hoje()) - Date.parse(iso)) / 864e5);

const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
// Com "esconder valores" ligado (olho no topo), todo valor em reais aparece mascarado
const VALOR_OCULTO = 'R$ ••••';
const brl = (v) => (ui.ocultarValores ? VALOR_OCULTO : moeda.format(v || 0));
const num1 = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

// Campo numérico opcional: vazio vira '', número dentro da faixa vira número, qualquer outra coisa vira null.
// <input type="number"> sempre entrega ponto decimal e nunca separador de milhar ("2.500" é dois e meio):
// esse formato é lido direto, sem a regra de milhar do parseNum (que é para extratos e texto livre).
function numeroCampo(v, min, max) {
  const t = String(v ?? '').trim();
  if (t === '') return '';
  const n = /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : parseNum(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// "3x12", "4 x 8-10" → { series, reps }; vazio → sem séries; qualquer outra coisa → null
function seriesReps(v) {
  const s = String(v ?? '').trim();
  if (!s) return { series: '', reps: '' };
  const m = s.match(/^(\d{1,2})\s*[x×]\s*([1-9]\d{0,2}(?:\s*(?:-|a)\s*[1-9]\d{0,2})?|[a-zà-ú][a-zà-ú .]{0,14})$/i);
  return m && +m[1] >= 1 ? { series: +m[1], reps: m[2].trim().replace(/^(\d+)\s*(?:-|a)\s*(\d+)$/i, '$1-$2') } : null;
}

// Lê números escritos de vários jeitos: "1.234,56", "1,234.56", "1.234" (mil), "80.5", "R$ -10",
// "−10,00" (sinal de menos tipográfico), "(10,00)" e "10,00-" (formatos de extrato para valor negativo)
function parseNum(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').trim().replace(/[R$\s ]/g, '').replace(/[−–]/g, '-');
  if (!s) return NaN;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negativo = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { negativo = !negativo; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return NaN;
  const ultVirgula = s.lastIndexOf(','), ultPonto = s.lastIndexOf('.');
  if (ultVirgula >= 0 && ultPonto >= 0) {
    // Os dois aparecem: o último é o separador decimal
    s = ultVirgula > ultPonto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (ultVirgula >= 0) {
    s = (s.match(/,/g).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.'));
  } else if (ultPonto >= 0) {
    // Só pontos: vários ou "1.234" (exatamente 3 dígitos depois, sem zero à esquerda) é milhar; "80.5" é decimal
    if (s.match(/\./g).length > 1 || /^[1-9]\d{0,2}\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return negativo ? -n : n;
}

function variacao(d, unidade = ' kg') {
  if (!d) return `0${unidade}`;
  return `<span class="${d < 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : '−'}${num1(Math.abs(d))}${unidade}</span>`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('visivel');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visivel'), 2800);
}

function baixarArquivo(nome, conteudo, tipo) {
  const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nome });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function lerTexto(arquivo) {
  const buf = await arquivo.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // Extratos de bancos brasileiros às vezes vêm em Windows-1252
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

// Erros do Firebase vêm em inglês: troca pelos casos comuns em português
function mensagemErro(err) {
  const m = String(err?.message || err || '');
  if (/offline|unavailable|network/i.test(m) || err?.code === 'unavailable') return 'Sem internet agora. Tente de novo quando a conexão voltar.';
  if (err?.code === 'permission-denied' || /permission/i.test(m)) return 'Sem permissão para isso. Confira as regras do Firestore.';
  return m || 'Algo deu errado. Tente de novo.';
}

// =====================================================================
// Modal
// =====================================================================
let modalSubmit = null;
let modalGeracao = 0; // muda a cada modal aberto ou fechado: um envio antigo que termina depois não mexe no modal novo
let enviandoModal = false;
let modalRota = ''; // tela em que o modal foi aberto: se a pessoa voltar/navegar, ele fecha
let modalFechando = false;
const semAnimacao = matchMedia('(prefers-reduced-motion: reduce)');
const modalAberto = () => $('#modal').open && !modalFechando;

function abrirModal(titulo, corpo, onSubmit, { ok = 'Salvar' } = {}) {
  const m = $('#modal');
  m.classList.remove('fechando');
  modalFechando = false;
  $('#modal-titulo').textContent = titulo;
  $('#modal-corpo').innerHTML = corpo;
  $('#modal-ok').textContent = ok;
  modalSubmit = onSubmit;
  modalRota = location.hash;
  modalGeracao++;
  enviandoModal = false;
  $('#modal-ok').disabled = false;
  clearTimeout(timerFechar);
  // Um modal pode abrir outro (ex.: menu de grupos → criar grupo): só troca o conteúdo
  if (!m.open) m.showModal();
}

// Fecha com animação de saída (a folha desce / o cartão encolhe)
let timerFechar;
function fecharModal() {
  const m = $('#modal');
  modalSubmit = null;
  modalGeracao++;
  enviandoModal = false;
  $('#modal-ok').disabled = false;
  if (!m.open || modalFechando) return;
  if (semAnimacao.matches) { m.close(); if (social.pendente) redesenharSocial(); return; }
  modalFechando = true;
  m.classList.add('fechando');
  timerFechar = setTimeout(() => {
    m.close();
    m.classList.remove('fechando');
    modalFechando = false;
    if (social.pendente) redesenharSocial();
  }, 220);
}

// Esc e toque fora do modal também fecham com animação
$('#modal').addEventListener('cancel', (e) => { e.preventDefault(); fecharModal(); });
$('#modal').addEventListener('click', (e) => {
  if (e.target !== e.currentTarget) return;
  const r = e.currentTarget.getBoundingClientRect();
  const fora = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (fora) fecharModal();
});

// Enquanto um envio está em andamento (foto sendo reduzida, extrato sendo lido…), outro toque em Salvar é ignorado.
// A trava é do modal aberto: fechar ou abrir outro modal a libera (ver abrirModal/fecharModal).
$('#modal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancelar') { fecharModal(); return; }
  if (enviandoModal || !modalSubmit) return;
  const formData = new FormData(e.target);
  const dados = Object.fromEntries(formData);
  const ok = $('#modal-ok');
  const geracao = modalGeracao;
  enviandoModal = true;
  ok.disabled = true;
  try {
    // formData vai junto para campos repetidos (ex.: lista de exercícios da ficha)
    if ((await modalSubmit(dados, formData)) === false) return;
  } catch (err) {
    toast(mensagemErro(err));
    return;
  } finally {
    if (geracao === modalGeracao) { enviandoModal = false; ok.disabled = false; }
  }
  if (geracao !== modalGeracao) { salvar(); render(); return; } // a pessoa já fechou/trocou de modal
  fecharModal();
  salvar();
  render();
});

// =====================================================================
// Gráfico de linha (SVG, sem bibliotecas — funciona offline)
// =====================================================================
function linhaChart(pontos, { mini = false, meta = null, unidade = 'kg' } = {}) {
  if (pontos.length < 2) return mini ? '' : '<p class="vazio">Registre ao menos dois valores para ver o gráfico.</p>';
  // Largura do viewBox ≈ largura real na tela, para o texto dos eixos não encolher no celular
  const W = mini ? 600 : Math.round(Math.min(Math.max(($('#app').clientWidth || 600) - 34, 280), 640));
  const H = mini ? 80 : 220;
  const pl = mini ? 2 : 44, pr = mini ? 2 : 12, pt = mini ? 4 : 14, pb = mini ? 4 : 30;
  const xs = pontos.map((p) => Date.parse(p.data)), ys = pontos.map((p) => p.v);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (meta && !mini) { y0 = Math.min(y0, meta); y1 = Math.max(y1, meta); }
  const pad = Math.max((y1 - y0) * 0.12, 0.5);
  y0 -= pad; y1 += pad;
  const x0 = xs[0], x1 = xs.at(-1) === x0 ? x0 + 1 : xs.at(-1);
  const X = (t) => pl + ((t - x0) / (x1 - x0)) * (W - pl - pr);
  const Y = (v) => pt + ((y1 - v) / (y1 - y0)) * (H - pt - pb);
  const d = pontos.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${Y(ys[i]).toFixed(1)}`).join(' ');
  const area = `${d} L${X(xs.at(-1)).toFixed(1)} ${H - pb} L${X(x0).toFixed(1)} ${H - pb} Z`;

  let extra = '';
  if (!mini) {
    for (let i = 0; i <= 4; i++) {
      const v = y0 + ((y1 - y0) * i) / 4, y = Y(v).toFixed(1);
      extra += `<line class="grade" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>`
        + `<text class="eixo" x="${pl - 8}" y="${+y + 4}" text-anchor="end">${num1(v)}</text>`;
    }
    extra += `<text class="eixo" x="${pl}" y="${H - 8}">${fmtData(pontos[0].data)}</text>`
      + `<text class="eixo" x="${W - pr}" y="${H - 8}" text-anchor="end">${fmtData(pontos.at(-1).data)}</text>`;
    if (meta) {
      const ym = Y(meta).toFixed(1);
      extra += `<line class="meta" x1="${pl}" x2="${W - pr}" y1="${ym}" y2="${ym}"/>`
        + `<text class="eixo meta-txt" x="${W - pr}" y="${ym - 6}" text-anchor="end">meta ${num1(meta)} ${unidade}</text>`;
    }
  }
  const pontosSvg = !mini && pontos.length <= 60
    ? pontos.map((p, i) => `<circle class="ponto" cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="3.5"><title>${fmtData(p.data)}: ${num1(p.v)} ${unidade}</title></circle>`).join('')
    : '';

  return `<svg class="chart${mini ? ' mini' : ''}" viewBox="0 0 ${W} ${H}" ${mini ? 'preserveAspectRatio="none"' : ''} role="img" aria-label="Gráfico">
    <defs><linearGradient id="gradArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="grad-ini"/><stop offset="1" class="grad-fim"/></linearGradient></defs>
    ${extra}<path class="area" d="${area}"/><path class="linha" d="${d}" pathLength="1"/>${pontosSvg}</svg>`;
}

// =====================================================================
// Consultas
// =====================================================================
const pesosOrdenados = () => [...state.pesos].sort((a, b) => a.data.localeCompare(b.data));
const sessoesRecentes = () => [...state.sessoes].sort((a, b) => b.data.localeCompare(a.data) || b.inicio - a.inicio);

function ultimaCarga(nome) {
  const n = norm(nome);
  for (const s of sessoesRecentes()) {
    const it = s.itens.find((i) => norm(i.nome) === n && i.feito && i.carga);
    if (it) return { carga: it.carga, data: s.data };
  }
  return null;
}

function resumoMes(mes) {
  const doMes = state.transacoes.filter((t) => t.data.startsWith(mes));
  const receitas = doMes.filter((t) => t.valor > 0).reduce((s, t) => s + t.valor, 0);
  const despesas = doMes.filter((t) => t.valor < 0).reduce((s, t) => s - t.valor, 0);
  const porCat = {};
  for (const t of doMes) if (t.valor < 0) porCat[t.categoria] = (porCat[t.categoria] || 0) - t.valor;
  return { doMes, receitas, despesas, saldo: receitas - despesas, porCat };
}

function categorizar(descricao, valor) {
  const aprendida = state.regras[chaveDesc(descricao)];
  if (aprendida) return aprendida;
  const d = norm(descricao);
  for (const [re, cat] of valor < 0 ? REGRAS_DESPESA : REGRAS_RECEITA) if (re.test(d)) return cat;
  return 'Outros';
}

// =====================================================================
// Telas
// =====================================================================
function vInicio() {
  const h = new Date().getHours();
  // Madrugada (até 4h59) ainda é "boa noite"
  const saud = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const p = pesosOrdenados();
  const atual = p.at(-1), inicial = p[0];
  const ultimos7 = Array.from({ length: 7 }, (_, i) => diaISO(i - 6));
  const diasTreino = diasAcademia();
  const semana = ultimos7.filter((d) => diasTreino.has(d)).length;
  const ultDia = [...diasTreino].sort().at(-1);
  const meta = numeroCampo(state.config.metaPeso, 20, 400) || NaN;
  const progMeta = meta && p.length > 1 && inicial.peso > meta
    ? Math.min(Math.max((inicial.peso - atual.peso) / (inicial.peso - meta), 0), 1) : null;
  const m = resumoMes(hoje().slice(0, 7));
  const fixadas = state.notas.filter((n) => n.fixada).slice(0, 4);

  return `
    <h1 class="titulo">${saud}${primeiroNome() ? `, ${esc(primeiroNome())}` : ''}!</h1>
    <p class="subtitulo">${diaSemana(hoje())}, ${fmtData(hoje())}</p>

    ${state.sessaoAtual
      ? `<a class="card link destaque" href="#sessao"><div class="card-label">Treino em andamento</div><div class="item-titulo">${esc(state.sessaoAtual.nome)} — continuar</div></a><div style="height:10px"></div>`
      : fichaDeHoje() ? `<a class="card link destaque" href="#treino"><div class="card-label">Treino de hoje</div><div class="item-titulo">${esc(fichaDeHoje().nome)}</div><div class="card-sub" style="color:inherit;opacity:.8">${esc(fichaDeHoje().foco || '')}</div></a><div style="height:10px"></div>` : ''}

    <div class="grid">
      <a class="card link" href="#peso">
        <div class="card-topo"><span class="card-icone">${ICONES.peso}</span><span class="card-label">Peso</span></div>
        <div class="card-valor">${atual ? `${num1(atual.peso)}<small>kg</small>` : '—'}</div>
        <div class="card-sub">${p.length > 1 ? `${variacao(atual.peso - inicial.peso)} desde ${fmtDataCurta(inicial.data)}` : 'Registre seu peso'}</div>
        ${progMeta !== null
          ? `<div class="progresso" title="${Math.round(progMeta * 100)}% da meta"><div style="width:${progMeta * 100}%"></div></div><div class="card-sub">${Math.round(progMeta * 100)}% da meta de ${num1(meta)} kg</div>`
          : linhaChart(p.slice(-30).map((x) => ({ data: x.data, v: x.peso })), { mini: true })}
      </a>
      <a class="card link" href="#treino">
        <div class="card-topo"><span class="card-icone">${ICONES.treino}</span><span class="card-label">Treinos · 7 dias</span></div>
        <div class="card-valor">${semana}</div>
        <div class="card-sub">${ultDia ? `Último ${diasDesde(ultDia) === 0 ? 'hoje' : diasDesde(ultDia) === 1 ? 'ontem' : `há ${diasDesde(ultDia)} dias`}` : 'Nenhum treino ainda'}</div>
        <div class="dias7">${ultimos7.map((d, i) => `<span class="${i === 6 ? 'hoje' : ''}"><i class="${diasTreino.has(d) ? 'on' : ''}"></i>${diaSemana(d).charAt(0)}</span>`).join('')}</div>
      </a>
    </div>

    <a class="card link" href="#financas" style="margin-top:10px">
      <div class="card-topo"><span class="card-icone">${ICONES.financas}</span><span class="card-label">Saldo de ${MESES[new Date().getMonth()].toLowerCase()}</span></div>
      <div class="card-valor ${m.saldo < 0 ? 'neg' : ''}">${brl(m.saldo)}</div>
      <div class="card-sub"><span class="pos">↑ ${brl(m.receitas)}</span> &nbsp; <span class="neg">↓ ${brl(m.despesas)}</span></div>
      ${m.receitas ? `<div class="progresso" title="Quanto da receita já foi gasto"><div style="width:${Math.min(m.despesas / m.receitas, 1) * 100}%"></div></div><div class="card-sub">${Math.round((m.despesas / m.receitas) * 100)}% da receita gasta</div>` : ''}
    </a>

    ${fixadas.length ? `<h2 class="secao">Notas fixadas</h2><div class="nota-grid">${fixadas.map(cardNota).join('')}</div>` : ''}
  `;
}

// ---------- Treino ----------
// Linha: "nome 4x10-12 40kg 60s — observação" (tudo depois do nome é opcional)
function parseExercicios(texto) {
  return texto.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    let [principal, ...resto] = l.split(/\s+[—–|]\s+/);
    // " - " também separa a observação, mas só depois das séries ("Remada 3x10 - devagar"),
    // para não cortar nomes como "Puxada - pegada aberta"
    const comHifen = !resto.length && principal.match(/^(.*\d+\s*x\s*\S+.*?)\s+-\s+(.+)$/i);
    if (comHifen) [principal, resto] = [comHifen[1], [comHifen[2]]];
    const m = principal.match(/^(.+?)(?:\s+(\d+)\s*[x×]\s*(\d+(?:\s*(?:-|a)\s*\d+)?|\S+))?(?:\s+([\d.,]+)\s*kg)?(?:\s+(\d+(?:-\d+)?)\s*(s|seg|min)\b)?\s*$/i);
    const descanso = !m[5] ? '' : /min/i.test(m[6]) ? m[5].split('-').map((x) => +x * 60).join('-') : m[5];
    return {
      nome: m[1].trim(), series: m[2] ? +m[2] : '', reps: (m[3] || '').replace(/^(\d+)\s*(?:-|a)\s*(\d+)$/i, '$1-$2'),
      carga: m[4] ? parseNum(m[4]) : '', descanso, obs: resto.join(' — ').trim(),
    };
  });
}
const exercicioTexto = (e) => `${e.nome}${e.series && e.reps ? ` ${e.series}x${e.reps}` : ''}${e.carga ? ` ${e.carga}kg` : ''}${e.descanso ? ` ${e.descanso}s` : ''}${e.obs ? ` — ${e.obs}` : ''}`;
const exercicioResumo = (e) => [e.series && e.reps ? `${e.series}×${e.reps}` : '', e.carga ? `${num1(e.carga)} kg` : ''].filter(Boolean).join(' · ');
const fichaDeHoje = () => state.fichas.find((f) => f.dia === new Date().getDay());
const planoCarregado = () => PLANO_EXEMPLO.fichas.every((p) => state.fichas.some((f) => f.nome === p.nome));

// ---------- Check-in (dias de academia) ----------
// Só o check-in manual conta como dia de academia (treino registrado não marca sozinho)
const diasAcademia = () => new Set(state.checkins);

// Semanas seguidas (dom–sáb) com pelo menos um dia; a semana atual ainda vazia não quebra a sequência
function semanasSeguidas(dias) {
  const inicioSemana = (iso) => { const d = new Date(iso + 'T12:00'); d.setDate(d.getDate() - d.getDay()); return d; };
  const temNaSemana = (ini) => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(ini); d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }).some((x) => dias.has(x));
  const ini = inicioSemana(hoje());
  if (!temNaSemana(ini)) ini.setDate(ini.getDate() - 7);
  let n = 0;
  while (temNaSemana(ini)) { n++; ini.setDate(ini.getDate() - 7); }
  return n;
}

function cardCheckin() {
  const dias = diasAcademia();
  const hj = hoje();
  const feitoHoje = dias.has(hj);
  const animarCheck = feitoHoje && ui.ultimoCheckin === hj; // desenha o ✓ só no momento do check-in
  const [ano, mes] = ui.calMes.split('-').map(Number);
  const primeiro = new Date(ano, mes - 1, 1).getDay();
  const totalDias = new Date(ano, mes, 0).getDate();
  const noMes = [...dias].filter((d) => d.startsWith(ui.calMes)).length;
  const noAno = [...dias].filter((d) => d.startsWith(hj.slice(0, 4))).length;
  const semanas = semanasSeguidas(dias);

  let celulas = DIAS.map((d) => `<span class="cal-cab">${d.charAt(0)}</span>`).join('');
  celulas += '<span></span>'.repeat(primeiro);
  for (let dia = 1; dia <= totalDias; dia++) {
    const iso = `${ui.calMes}-${String(dia).padStart(2, '0')}`;
    const classes = ['cal-dia', dias.has(iso) && 'on', iso === hj && 'hoje', iso === ui.ultimoCheckin && 'pop'].filter(Boolean).join(' ');
    celulas += `<button class="${classes}" data-act="alternarDia" data-v="${iso}" ${iso > hj ? 'disabled' : ''} aria-label="${fmtData(iso)}${dias.has(iso) ? ', foi à academia' : ''}">${dia}</button>`;
  }
  ui.ultimoCheckin = '';

  return `
    <div class="card checkin">
      <button class="btn-checkin ${feitoHoje ? 'feito' : ''} ${animarCheck ? 'animar' : ''}" data-act="alternarDia" data-v="${hj}">
        <span class="btn-checkin-icone">${ic(feitoHoje ? 'check' : 'plus')}</span>
        <span><b>${feitoHoje ? 'Check-in feito hoje' : 'Fazer check-in hoje'}</b><small>${feitoHoje ? 'Toque para desfazer' : 'Marque que você foi à academia'}</small></span>
      </button>
      <div class="stats checkin-stats">
        <div class="stat"><span>Neste mês</span><b>${noMes} ${noMes === 1 ? 'dia' : 'dias'}</b></div>
        <div class="stat"><span>Em ${hj.slice(0, 4)}</span><b>${noAno} ${noAno === 1 ? 'dia' : 'dias'}</b></div>
        <div class="stat"><span>Sequência</span><b>${semanas} ${semanas === 1 ? 'semana' : 'semanas'}</b></div>
      </div>
      <div class="cal-nav">
        <button class="btn-x" data-act="calMes" data-v="-1" aria-label="Mês anterior">${ic('chevron-left')}</button>
        <b>${MESES[mes - 1]} ${ano}</b>
        <button class="btn-x" data-act="calMes" data-v="1" aria-label="Próximo mês" ${ui.calMes >= hj.slice(0, 7) ? 'disabled' : ''}>${ic('chevron-right')}</button>
      </div>
      <div class="cal">${celulas}</div>
      <p class="dica" style="margin:10px 0 0">Toque em um dia para marcar ou desmarcar.</p>
    </div>`;
}

function cabecalhoTreino() {
  const abas = [['meu', `${ic('dumbbell')} Meu treino`], ['grupos', `${ic('users')} Grupos`]];
  return `
    <h1 class="titulo">Treino</h1>
    <p class="subtitulo">${((n) => `${n} ${n === 1 ? 'treino' : 'treinos'} este mês`)(state.sessoes.filter((s) => s.data.startsWith(hoje().slice(0, 7))).length)}</p>
    <div class="segmento segmento-largo">${abas.map(([v, t]) => `<button data-act="treinoAba" data-v="${v}" class="${ui.treinoAba === v ? 'ativo' : ''}">${t}</button>`).join('')}</div>`;
}

function vTreino() {
  if (ui.treinoAba === 'grupos') return cabecalhoTreino() + vGrupos();
  const sessoes = sessoesRecentes();
  const nomesEx = [...new Set(state.sessoes.flatMap((s) => s.itens.filter((i) => i.feito && i.carga).map((i) => i.nome)))].sort();
  if (!nomesEx.includes(ui.exercicio)) ui.exercicio = nomesEx[0] || '';
  const evolucao = [];
  for (const s of [...sessoes].reverse()) {
    const it = s.itens.find((i) => i.nome === ui.exercicio && i.feito && i.carga);
    if (it) evolucao.push({ data: s.data, v: it.carga });
  }
  const fichaHoje = fichaDeHoje();
  // Fichas na ordem da semana (seg → dom); sem dia vão para o fim
  const ordemDia = (f) => (f.dia === '' || f.dia == null ? 99 : (f.dia + 6) % 7);
  const fichas = [...state.fichas].sort((a, b) => ordemDia(a) - ordemDia(b));

  return `
    ${cabecalhoTreino()}

    ${state.sessaoAtual
      ? `<a class="card link destaque" href="#sessao"><div class="card-label">Em andamento</div><div class="item-titulo">${esc(state.sessaoAtual.nome)} — continuar</div></a>`
      : fichaHoje ? `
      <div class="card destaque treino-hoje">
        <div class="card-label">Treino de hoje · ${DIAS[fichaHoje.dia]}</div>
        <div class="treino-hoje-nome">${esc(fichaHoje.nome)}</div>
        <div class="treino-hoje-foco">${esc(fichaHoje.foco || '')}${fichaHoje.foco ? ' · ' : ''}${fichaHoje.exercicios.length} exercícios</div>
        <button class="btn bloco btn-claro" data-act="iniciarTreino" data-id="${fichaHoje.id}">Iniciar treino</button>
      </div>` : ''}

    <h2 class="secao">Check-in</h2>
    ${cardCheckin()}

    <div class="linha-titulo"><h2 class="secao">Minhas fichas</h2><button class="btn pequeno" data-act="novaFicha">+ Nova ficha</button></div>
    ${fichas.length ? fichas.map((f) => `
      <div class="card ficha ${f === fichaHoje ? 'ficha-hoje' : ''}">
        <div class="linha-titulo">
          ${f.dia !== '' && f.dia != null ? `<span class="ficha-dia">${DIAS[f.dia]}</span>` : ''}
          <div class="item-corpo"><div class="item-titulo">${esc(f.nome)}</div><div class="item-sub">${f.exercicios.length} exercícios · ${esc(f.foco || f.exercicios.map((e) => e.nome).join(', '))}</div></div>
          <div class="acoes">
            <button class="btn pequeno btn-icone" data-act="excluirFicha" data-id="${f.id}" aria-label="Excluir ficha" title="Excluir ficha">${ic('trash-2')}</button>
            <button class="btn pequeno" data-act="editarFicha" data-id="${f.id}">${ic('pencil')} Editar</button>
            <button class="btn pequeno primario" data-act="iniciarTreino" data-id="${f.id}" ${state.sessaoAtual ? 'disabled' : ''}>Iniciar</button>
          </div>
        </div>
      </div>`).join('') : '<div class="card"><p class="vazio">Crie sua primeira ficha (ex.: Treino A — peito e tríceps).</p></div>'}
    ${planoCarregado() ? '' : `
      <button class="card link plano-exemplo" data-act="carregarPlano">
        <span class="card-icone">${ICONES.treino}</span>
        <span class="item-corpo"><span class="item-titulo">Carregar plano de exemplo</span><span class="item-sub">Seg a sex · ABC + U/L em aparelhos, sem agachamento</span></span>
        <span class="muted">${ic('chevron-right')}</span>
      </button>`}

    ${nomesEx.length ? `
      <div class="linha-titulo"><h2 class="secao">Evolução de carga</h2>
        <select id="sel-exercicio" style="width:auto;max-width:55%">${nomesEx.map((n) => `<option ${n === ui.exercicio ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      </div>
      <div class="card">${linhaChart(evolucao, {})}</div>` : ''}

    <h2 class="secao">Histórico</h2>
    <div class="lista">
      ${sessoes.length ? sessoes.slice(0, 40).map((s) => {
        const feitos = s.itens.filter((i) => i.feito).length;
        const min = s.fim && s.inicio ? Math.round((s.fim - s.inicio) / 60000) : null;
        return `<details class="sessao">
          <summary>
            <div class="item-corpo"><div class="item-titulo">${esc(s.nome)}</div><div class="item-sub">${diaSemana(s.data)} ${fmtData(s.data)}${min ? ` · ${min} min` : ''}</div></div>
            <span class="chip">${feitos}/${s.itens.length}</span>
          </summary>
          <div class="sessao-itens">
            ${s.itens.map((i) => `<div><span>${i.feito ? '✓' : '○'} ${esc(i.nome)}</span><span class="muted">${esc(exercicioResumo(i))}</span></div>`).join('')}
            ${s.obs ? `<p class="muted">${esc(s.obs)}</p>` : ''}
            <div class="acoes sessao-acoes">
              <button class="btn pequeno" data-act="editarSessao" data-id="${s.id}">${ic('pencil')} Editar</button>
              <button class="btn pequeno perigo" data-act="excluirSessao" data-id="${s.id}">${ic('trash-2')} Excluir</button>
            </div>
          </div>
        </details>`;
      }).join('') : '<p class="vazio">Nenhum treino registrado.</p>'}
    </div>
  `;
}

const progressoSessao = () => {
  const it = state.sessaoAtual.itens;
  return it.length ? it.filter((i) => i.feito).length / it.length : 0;
};
const textoProgressoSessao = () => {
  const it = state.sessaoAtual.itens;
  return `${it.filter((i) => i.feito).length} de ${it.length} exercícios`;
};

function vSessao() {
  const s = state.sessaoAtual;
  if (!s) { location.hash = '#treino'; return ''; }
  return `
    <h1 class="titulo">${esc(s.nome)}</h1>
    <p class="subtitulo"><span id="sessao-contagem">${textoProgressoSessao()}</span> · iniciado às ${new Date(s.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</p>
    <div class="sessao-barra"><div class="progresso"><div id="sessao-progresso" style="width:${progressoSessao() * 100}%"></div></div></div>
    <div class="lista">
      ${s.itens.map((i, idx) => {
        const ult = ultimaCarga(i.nome);
        return `<div class="ex-linha ${i.feito ? 'feito' : ''}">
          <input type="checkbox" data-sess="${idx}" data-campo="feito" ${i.feito ? 'checked' : ''} aria-label="Concluído">
          <div class="item-corpo">
            <div class="item-titulo ex-nome">${esc(i.nome)}</div>
            ${i.obs ? `<div class="ex-obs">${esc(i.obs)}</div>` : ''}
            <div class="ex-meta">
              ${i.descanso ? `<button class="chip chip-timer" data-act="descanso" data-v="${esc(i.descanso)}" aria-label="Iniciar descanso de ${esc(i.descanso)} segundos">${ic('timer')} ${esc(i.descanso)}s</button>` : ''}
              <span>${ult ? `último: ${num1(ult.carga)} kg em ${fmtDataCurta(ult.data)}` : 'primeira vez'}</span>
            </div>
          </div>
          <div class="ex-campos">
            <input inputmode="numeric" placeholder="séries×reps" value="${esc(i.series && i.reps ? `${i.series}x${i.reps}` : '')}" data-sess="${idx}" data-campo="seriesReps" aria-label="Séries e repetições">
            <input type="number" inputmode="decimal" step="any" min="0" placeholder="kg" value="${esc(i.carga)}" data-sess="${idx}" data-campo="carga" aria-label="Carga em kg">
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="acoes" style="margin-top:10px">
      <button class="btn pequeno" data-act="addExercicioSessao">${ic('plus')} Exercício</button>
      <button class="btn pequeno" data-act="recomecarTreino" title="Zera o horário de início e as marcações">${ic('rotate-ccw')} Recomeçar</button>
    </div>
    <label class="campo" style="margin-top:16px"><span>Observações</span><textarea rows="2" data-sess="obs" placeholder="Como foi o treino?">${esc(s.obs)}</textarea></label>
    <div class="acoes">
      <button class="btn primario" data-act="finalizarTreino" style="flex:1">Finalizar treino</button>
      <button class="btn perigo" data-act="cancelarTreino">Descartar</button>
    </div>
  `;
}

// ---------- Peso ----------
function vPeso() {
  const p = pesosOrdenados();
  const atual = p.at(-1), inicial = p[0];
  const meta = numeroCampo(state.config.metaPeso, 20, 400) || NaN;
  const altura = (numeroCampo(state.config.altura, 100, 250) || NaN) / 100;
  const imc = atual && altura ? atual.peso / (altura * altura) : null;
  const corte = ui.pesoPeriodo === 'tudo' ? '' : (() => {
    const d = new Date(); d.setDate(d.getDate() - +ui.pesoPeriodo); return d.toISOString().slice(0, 10);
  })();
  const visiveis = p.filter((x) => x.data >= corte).map((x) => ({ data: x.data, v: x.peso }));
  const periodos = [['30', '30 dias'], ['90', '3 meses'], ['365', '1 ano'], ['tudo', 'Tudo']];

  return `
    <h1 class="titulo">Peso</h1>
    <form class="card" data-form="peso">
      <div class="linha-form">
        <label class="campo" style="margin:0"><span>Data</span><input type="date" name="data" value="${hoje()}" max="${hoje()}" required></label>
        <label class="campo" style="margin:0"><span>Peso (kg)</span><input type="number" name="peso" step="any" min="20" max="400" inputmode="decimal" placeholder="${atual ? num1(atual.peso) : '80,0'}" required></label>
        <button class="btn primario">Registrar</button>
      </div>
    </form>

    <div class="stats" style="margin-top:10px">
      <div class="stat"><span>Atual</span><b>${atual ? num1(atual.peso) : '—'}</b></div>
      <div class="stat"><span>Variação total</span><b>${p.length > 1 ? variacao(atual.peso - inicial.peso, '') : '—'}</b></div>
      <div class="stat"><span>${meta ? 'Falta p/ meta' : imc ? 'IMC' : 'Mínimo'}</span><b>${meta && atual ? num1(Math.max(atual.peso - meta, 0)) : imc ? num1(imc) : p.length ? num1(Math.min(...p.map((x) => x.peso))) : '—'}</b></div>
    </div>
    ${atual ? `<div class="card agua">
      <span class="agua-icone">${ic('droplet')}</span>
      <div class="item-corpo"><div class="item-titulo">Água: ${num1(atual.peso * 0.035)} a ${num1(atual.peso * 0.04)} L por dia</div>
      <div class="item-sub">35–40 ml por kg de peso</div></div>
    </div>` : ''}

    <div class="linha-titulo"><h2 class="secao">Histórico</h2>
      <div class="segmento">${periodos.map(([v, t]) => `<button data-act="pesoPeriodo" data-v="${v}" class="${ui.pesoPeriodo === v ? 'ativo' : ''}">${t}</button>`).join('')}</div>
    </div>
    <div class="card">${linhaChart(visiveis, { meta: meta || null })}</div>
    ${!meta ? '<p class="dica" style="margin-top:8px">Dica: defina sua meta e altura em <a href="#config" style="color:var(--acento)">Configurações</a>.</p>' : ''}

    <h2 class="secao">Registros</h2>
    <div class="lista">
      ${p.length ? [...p].reverse().map((x, i, arr) => {
        const ant = arr[i + 1];
        return `<div class="item">
          <div class="item-corpo"><div class="item-titulo">${num1(x.peso)} kg</div><div class="item-sub">${diaSemana(x.data)} ${fmtData(x.data)}</div></div>
          ${ant ? `<span class="item-valor">${variacao(x.peso - ant.peso)}</span>` : ''}
          <button class="btn-x" data-act="excluirPeso" data-id="${x.id}" aria-label="Excluir">${ic('x')}</button>
        </div>`;
      }).join('') : '<p class="vazio">Nenhum registro ainda.</p>'}
    </div>
  `;
}

// ---------- Notas ----------
function cardNota(n) {
  return `<button class="card nota" data-act="abrirNota" data-id="${n.id}">
    <div class="item-titulo">${n.fixada ? ic('pin', 'ic-inline') : ''}${esc(n.titulo || 'Sem título')}</div>
    <div class="nota-texto">${esc(n.texto)}</div>
    <div class="nota-rodape"><span>${fmtData(new Date(n.atualizada).toISOString().slice(0, 10))}</span></div>
  </button>`;
}

function listaNotas() {
  const q = norm(ui.buscaNotas);
  const notas = state.notas
    .filter((n) => !q || norm(n.titulo + ' ' + n.texto).includes(q))
    .sort((a, b) => (b.fixada - a.fixada) || b.atualizada - a.atualizada);
  return notas.length ? `<div class="nota-grid">${notas.map(cardNota).join('')}</div>`
    : `<div class="card"><p class="vazio">${q ? 'Nada encontrado.' : 'Nenhuma nota ainda.'}</p></div>`;
}

function vNotas() {
  return `
    <div class="linha-titulo"><h1 class="titulo">Notas</h1><button class="btn primario pequeno" data-act="novaNota">+ Nova nota</button></div>
    <input type="search" id="busca-notas" placeholder="Buscar nas notas…" value="${esc(ui.buscaNotas)}" style="margin:12px 0">
    <div id="lista-notas">${listaNotas()}</div>
  `;
}

// ---------- Finanças ----------
function vFinancas() {
  const [ano, mes] = ui.mes.split('-').map(Number);
  const r = resumoMes(ui.mes);
  const orc = state.config.orcamentos || {};
  // Barras de orçamento só para as categorias que têm limite definido (o mapa de blocos mostra o resto)
  const cats = Object.keys(orc).filter((c) => orc[c]).map((c) => [c, r.porCat[c] || 0]).sort((a, b) => b[1] / orc[b[0]] - a[1] / orc[a[0]]);
  const maior = Math.max(1, ...cats.map(([c, v]) => Math.max(v, orc[c] || 0)));

  const lista = r.doMes.filter((t) => !ui.filtroCat || t.categoria === ui.filtroCat)
    .sort((a, b) => b.data.localeCompare(a.data));
  let diaAtual = '', linhas = '';
  for (const t of lista) {
    if (t.data !== diaAtual) { diaAtual = t.data; linhas += `<div class="dia">${diaSemana(t.data)}, ${fmtData(t.data)}</div>`; }
    linhas += `<button class="item" data-act="editarTransacao" data-id="${t.id}">
      <div class="item-corpo"><div class="item-titulo">${esc(t.descricao)}</div><div class="item-sub">${esc(t.categoria)}${t.origem === 'importado' ? ' · importado' : t.origem === 'openfinance' ? ` · ${esc(t.conta || 'banco')}` : ''}</div></div>
      <span class="item-valor ${t.valor < 0 ? 'neg' : 'pos'}">${t.valor < 0 ? '−' : '+'}${brl(Math.abs(t.valor))}</span>
    </button>`;
  }

  return `
    <div class="mes-nav">
      <button class="btn pequeno" data-act="mes" data-v="-1" aria-label="Mês anterior">${ic('chevron-left')}</button>
      <h1>${MESES[mes - 1]} ${ano}</h1>
      <button class="btn pequeno" data-act="mes" data-v="1" aria-label="Próximo mês">${ic('chevron-right')}</button>
    </div>

    <div class="stats">
      <div class="stat"><span>Receitas</span><b class="pos">${brl(r.receitas)}</b></div>
      <div class="stat"><span>Despesas</span><b class="neg">${brl(r.despesas)}</b></div>
      <div class="stat"><span>Saldo</span><b class="${r.saldo < 0 ? 'neg' : ''}">${brl(r.saldo)}</b></div>
    </div>

    <div class="acoes" style="margin-top:12px">
      <button class="btn primario" data-act="novaTransacao" style="flex:1">+ Lançamento</button>
      <button class="btn" data-act="importarExtrato" style="flex:1">Importar extrato</button>
    </div>

    ${cardBancos()}

    ${visaoFinancas()}

    ${cats.length ? `
      <h2 class="secao">Orçamentos do mês</h2>
      <div class="card barras">
        ${cats.map(([c, v]) => {
          const lim = orc[c];
          const pct = lim ? v / lim : 0;
          return `<button class="barra-item" data-act="filtroCat" data-v="${esc(c)}">
            <div class="barra-topo"><span>${esc(c)}</span><b>${brl(v)}${lim ? ` <span class="muted">/ ${brl(lim)}</span>` : ''}</b></div>
            <div class="barra-trilho"><div class="barra-cheia ${pct > 1 ? 'estourou' : pct > 0.85 ? 'quase' : ''}" style="width:${(v / maior) * 100}%"></div></div>
          </button>`;
        }).join('')}
      </div>` : ''}

    <div class="linha-titulo"><h2 class="secao">Lançamentos</h2>
      ${ui.filtroCat ? `<button class="chip filtro btn-x" data-act="filtroCat" data-v="">${esc(ui.filtroCat)} ✕</button>` : ''}
    </div>
    <div class="lista">${linhas || '<p class="vazio">Nenhum lançamento neste mês.</p>'}</div>

    <details class="card info" style="margin-top:16px">
      <summary>Como funciona a conexão com os bancos?</summary>
      <p>O app usa o <b>Meu Pluggy</b>, o plano pessoal e gratuito da Pluggy (agregador autorizado de Open Finance): você conecta até 5 bancos e
      cartões do seu CPF e o app busca os lançamentos uma vez por dia. Lançamentos repetidos são ignorados, pagamentos de fatura e transferências entre
      suas próprias contas ficam de fora (para não contar em dobro), e as categorias são sugeridas automaticamente — se você corrigir uma, o app aprende.
      Também dá para importar o extrato em <b>OFX</b> ou <b>CSV</b> pelo “Importar extrato”.</p>
    </details>
  `;
}

// ---------- Configurações ----------
function vConfig() {
  const c = state.config;
  return `
    <h1 class="titulo">Configurações</h1>

    ${conta.usuario ? `
    <h2 class="secao">Conta</h2>
    <div class="card conta">
      <a href="#perfil" class="conta-link">
        ${avatarHtml('conta-avatar')}
        <div class="item-corpo">
          <div class="item-titulo">${esc(nomeExibicao() || conta.usuario.email)}</div>
          <div class="item-sub">${nomeExibicao() ? esc(conta.usuario.email) + ' · ' : ''}<span class="${conta.erro ? 'neg' : 'pos'}">${conta.erro ? 'sem conexão' : conta.sincronizada ? '● sincronizado' : 'sincronizando…'}</span></div>
        </div>
      </a>
      <div class="acoes">
        <a class="btn pequeno" href="#perfil">Editar perfil</a>
        <button class="btn pequeno" data-act="sair">Sair</button>
      </div>
    </div>` : ''}

    ${conta.usuario ? '' : `
    <h2 class="secao">Perfil</h2>
    <a class="card link conta" href="#perfil">
      ${avatarHtml('conta-avatar')}
      <div class="item-corpo"><div class="item-titulo">${esc(nomeExibicao() || 'Seu perfil')}</div><div class="item-sub">Foto, nome, altura e meta de peso</div></div>
      <span class="muted">${ic('chevron-right')}</span>
    </a>`}

    <h2 class="secao">Orçamento mensal por categoria</h2>
    <form class="card" data-form="orcamentos">
      <p class="dica">Deixe em branco as categorias sem limite.</p>
      <div class="grid">
        ${CATEGORIAS.map((cat) => `<label class="campo" style="margin:0"><span>${cat}</span><input type="number" min="0" step="any" inputmode="decimal" name="${esc(cat)}" value="${esc(c.orcamentos?.[cat] ?? '')}" placeholder="R$"></label>`).join('')}
      </div>
      <button class="btn primario bloco" style="margin-top:12px">Salvar orçamentos</button>
    </form>

    <h2 class="secao">Dados</h2>
    <div class="card">
      <p class="dica">${conta.usuario
        ? 'Seus dados ficam na sua conta e aparecem em qualquer aparelho em que você entrar. O backup é uma cópia extra, se quiser.'
        : 'Tudo fica salvo só neste aparelho. Faça backup de vez em quando — e use-o para passar os dados para outro celular.'}</p>
      <div class="acoes">
        <button class="btn" data-act="exportar">Baixar backup</button>
        <button class="btn" data-act="restaurar">Restaurar backup</button>
        <button class="btn" data-act="exportarCsv">Exportar finanças (CSV)</button>
      </div>
    </div>
    <h2 class="secao">Limpar</h2>
    <div class="card">
      <p class="dica">Apaga os lançamentos que vieram do banco (Open Finance). Os lançamentos criados à mão e importados de extrato continuam.</p>
      <div class="acoes"><button class="btn perigo" data-act="limparBancos">Apagar lançamentos do banco</button></div>
    </div>
    <div class="card" id="card-instalar" ${instalarEvento ? '' : 'hidden'}>
      <p class="dica">Instale o app para abrir em tela cheia e usar offline.</p>
      <button class="btn primario" data-act="instalar">Instalar app</button>
    </div>
    <div class="card">
      <button class="btn perigo" data-act="apagarTudo">Apagar todos os dados</button>
    </div>
  `;
}

// ---------- Login ----------
function vCarregando() {
  return `<div class="login"><div class="login-marca"></div><p class="muted">${esc(conta.erro || 'Carregando…')}</p>
    ${conta.erro ? '<button class="btn" data-act="recarregar">Tentar de novo</button>' : ''}</div>`;
}

function vLogin() {
  const criar = ui.modoLogin === 'criar';
  return `
    <div class="login">
      <div class="login-marca"></div>
      <h1 class="titulo">${criar ? 'Criar conta' : 'Entrar'}</h1>
      <p class="subtitulo">${criar ? 'Seus dados ficam salvos na sua conta e aparecem em qualquer aparelho.' : 'Treino, peso, notas e finanças — em qualquer aparelho.'}</p>
      <form class="card login-card" data-form="login">
        ${criar ? '<label class="campo"><span>Nome</span><input name="nome" autocomplete="name" placeholder="Como quer ser chamado"></label>' : ''}
        <label class="campo"><span>E-mail</span><input type="email" name="email" required autocomplete="email" value="${esc(ui.emailLogin || '')}"></label>
        <label class="campo"><span>Senha</span><input type="password" name="senha" required minlength="6" autocomplete="${criar ? 'new-password' : 'current-password'}" placeholder="${criar ? 'Mínimo 6 caracteres' : ''}"></label>
        <button class="btn primario bloco" ${ui.entrando ? 'disabled' : ''}>${ui.entrando ? 'Aguarde…' : criar ? 'Criar conta' : 'Entrar'}</button>
        ${criar ? '' : '<button type="button" class="link-btn" data-act="esqueciSenha">Esqueci minha senha</button>'}
        <div class="ou"><span>ou</span></div>
        <button type="button" class="btn bloco" data-act="entrarGoogle">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8.1z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>
          Continuar com Google
        </button>
      </form>
      <p class="login-troca">${criar ? 'Já tem conta?' : 'Ainda não tem conta?'}
        <button class="link-btn" data-act="modoLogin" data-v="${criar ? 'entrar' : 'criar'}">${criar ? 'Entrar' : 'Criar conta'}</button></p>
    </div>`;
}

const ERROS_LOGIN = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'Não existe conta com esse e-mail.',
  'auth/email-already-in-use': 'Já existe uma conta com esse e-mail. Tente entrar.',
  'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/too-many-requests': 'Muitas tentativas. Espere um pouco e tente de novo.',
  'auth/network-request-failed': 'Sem conexão com a internet.',
  'auth/popup-closed-by-user': 'Login com Google cancelado.',
  'auth/popup-blocked': 'O navegador bloqueou a janela do Google. Permita pop-ups e tente de novo.',
  'auth/operation-not-allowed': 'Esse tipo de login não está ativado no Firebase.',
  'auth/admin-restricted-operation': 'A criação de novas contas está desativada.',
  'auth/unauthorized-domain': 'Este endereço não está autorizado no Firebase (Authentication → Settings → Authorized domains).',
};
const msgErroLogin = (e) => ERROS_LOGIN[e?.code] || 'Não foi possível entrar. Tente de novo.';

async function fazerLogin(acao) {
  if (!window.Nuvem) return toast('Ainda conectando… tente em alguns segundos.');
  ui.entrando = true;
  render();
  try {
    await acao();
  } catch (e) {
    toast(msgErroLogin(e));
  } finally {
    ui.entrando = false;
    if (!conta.usuario) render();
  }
}

// ---------- Perfil ----------
const nomeExibicao = () => state.perfil?.nome || conta.usuario?.nome || '';
const fotoPerfil = () => state.perfil?.foto || conta.usuario?.foto || '';
const primeiroNome = () => nomeExibicao().split(' ')[0];

function avatarHtml(classe) {
  const foto = fotoPerfil();
  const inicial = (nomeExibicao() || conta.usuario?.email || '').charAt(0).toUpperCase();
  return foto
    ? `<span class="avatar ${classe}"><img src="${esc(foto)}" alt="" referrerpolicy="no-referrer"></span>`
    : `<span class="avatar ${classe}">${inicial ? esc(inicial) : ICONES.pessoa}</span>`;
}

function vPerfil() {
  const c = state.config;
  return `
    <h1 class="titulo">Perfil</h1>
    <div class="perfil-topo">
      <label class="perfil-foto" title="Trocar foto">
        ${avatarHtml('avatar-grande')}
        <span class="perfil-camera">${ICONES.camera}</span>
        <input type="file" id="input-foto" accept="image/*" hidden>
      </label>
      <div class="acoes" style="justify-content:center">
        <label class="btn pequeno" for="input-foto">${fotoPerfil() ? 'Trocar foto' : 'Adicionar foto'}</label>
        ${state.perfil.foto ? '<button class="btn pequeno perigo" data-act="removerFoto">Remover</button>' : ''}
      </div>
      ${conta.usuario ? `<p class="muted perfil-email">${esc(conta.usuario.email)}</p>` : ''}
    </div>

    <form class="card" data-form="perfil">
      <label class="campo"><span>Nome</span><input name="nome" autocomplete="name" value="${esc(nomeExibicao())}" placeholder="Como quer ser chamado"></label>
      <div class="linha-form">
        <label class="campo"><span>Altura (cm)</span><input type="number" name="altura" min="100" max="250" inputmode="numeric" value="${esc(c.altura)}"></label>
        <label class="campo"><span>Meta de peso (kg)</span><input type="number" name="metaPeso" step="any" min="20" max="400" inputmode="decimal" value="${esc(c.metaPeso)}"></label>
      </div>
      <button class="btn primario bloco">Salvar perfil</button>
    </form>
  `;
}

// Reduz a foto para 320×320 (corte quadrado no centro) — fica com ~30 KB e cabe na conta
async function prepararFoto(arquivo) {
  const img = await createImageBitmap(arquivo);
  const lado = Math.min(img.width, img.height);
  const tam = 320;
  const canvas = Object.assign(document.createElement('canvas'), { width: tam, height: tam });
  canvas.getContext('2d').drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, tam, tam);
  img.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}

// =====================================================================
// Grupos: cada grupo tem seu ranking de frequência e seu feed.
// Check-ins e fotos vão para todos os grupos de que a pessoa participa.
// Quem não entra em nenhum grupo continua com tudo privado.
// =====================================================================
const social = {
  pararGrupos: null,  // escuta da lista de grupos
  pararGrupo: null,   // escuta do grupo aberto (membros + posts)
  grupoOuvido: '',
  grupos: [],         // [{ id, nome, criador, membros[] }]
  gruposCarregados: false,
  membros: [],        // ranking do grupo aberto: [{ uid, nome, avatar, dias[] }]
  feed: [],           // posts do grupo aberto
  fotos: {},          // id do post -> URL de blob (evita colar imagens enormes no HTML)
  carregado: false,
  enviado: {},        // id do grupo -> último JSON publicado no ranking
  mini: { de: '', para: '' }, // cache da miniatura do avatar
};

const emGrupos = () => social.grupos.length > 0;
const grupoAtual = () => social.grupos.find((g) => g.id === ui.grupoAtual);

// Liga/desliga as escutas do Firebase conforme a conta e o grupo aberto
function atualizarEscutaSocial() {
  const pode = !!(conta.usuario && conta.sincronizada && window.Nuvem?.social);
  if (!pode) {
    if (social.pararGrupos || social.pararGrupo) {
      social.pararGrupos?.();
      trocarGrupoOuvido('');
      Object.assign(social, { pararGrupos: null, grupos: [], gruposCarregados: false, enviado: {} });
    }
    return;
  }
  if (!social.pararGrupos) {
    social.pararGrupos = () => {}; // marca como iniciado antes da primeira resposta chegar
    social.pararGrupos = window.Nuvem.social.ouvirGrupos((lista) => {
      social.grupos = lista.sort((a, b) => a.nome.localeCompare(b.nome));
      social.gruposCarregados = true;
      if (!grupoAtual()) ui.grupoAtual = social.grupos[0]?.id || '';
      publicarRanking();
      trocarGrupoOuvido(ui.grupoAtual);
      redesenharSocial();
    }, () => toast('Não foi possível carregar os grupos. Confira as regras do Firestore.'));
  }
  if (social.gruposCarregados) trocarGrupoOuvido(ui.grupoAtual);
}

function trocarGrupoOuvido(id) {
  if (social.grupoOuvido === id) return;
  social.pararGrupo?.();
  Object.values(social.fotos).forEach((u) => URL.revokeObjectURL(u));
  Object.assign(social, { pararGrupo: null, grupoOuvido: id, membros: [], feed: [], fotos: {}, carregado: false });
  if (!id) return;
  social.pararGrupo = window.Nuvem.social.ouvirGrupo(id,
    (lista) => { social.membros = lista; social.carregado = true; redesenharSocial(); },
    (posts) => { social.feed = posts; prepararFotosFeed(); social.carregado = true; redesenharSocial(); },
    () => {});
}

function redesenharSocial() {
  const naTela = location.hash === '#treino' && ui.treinoAba === 'grupos';
  // "Digitando" só conta na própria tela (um campo do modal que está fechando não deve travar)
  const ativo = document.activeElement;
  const digitando = ativo?.matches?.('input, textarea, select') && ativo.closest('#app');
  // Com um modal aberto (ex.: comentários), atualiza quando ele fechar
  social.pendente = naTela && modalAberto();
  if (naTela && !digitando && !modalAberto()) render();
}

// data URL -> URL de blob (bem mais leve para o navegador redesenhar o feed)
function prepararFotosFeed() {
  const ids = new Set(social.feed.map((p) => p.id));
  for (const [id, url] of Object.entries(social.fotos)) {
    if (!ids.has(id)) { URL.revokeObjectURL(url); delete social.fotos[id]; }
  }
  for (const p of social.feed) {
    if (social.fotos[p.id] || !p.foto?.startsWith('data:')) continue;
    const [cab, base64] = p.foto.split(',');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    social.fotos[p.id] = URL.createObjectURL(new Blob([bytes], { type: cab.slice(5, cab.indexOf(';')) }));
  }
}

// Redimensiona uma imagem: quadrada (corte central) ou mantendo a proporção até "max" px
async function redimensionar(fonte, { max, quadrada = false, qualidade = 0.8 }) {
  const img = await createImageBitmap(fonte);
  const lado = Math.min(img.width, img.height);
  const [sx, sy, sw, sh] = quadrada ? [(img.width - lado) / 2, (img.height - lado) / 2, lado, lado] : [0, 0, img.width, img.height];
  const fator = Math.min(1, max / Math.max(sw, sh));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(sw * fator), height: Math.round(sh * fator) });
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return canvas.toDataURL('image/jpeg', qualidade);
}

// Miniatura do avatar para ranking/posts (a foto do perfil inteira seria pesada demais em cada post)
async function avatarPublico() {
  const foto = fotoPerfil();
  if (!foto.startsWith('data:')) return foto; // vazio ou URL do Google
  if (social.mini.de !== foto) {
    const blob = await (await fetch(foto)).blob();
    social.mini = { de: foto, para: await redimensionar(blob, { max: 96, quadrada: true, qualidade: 0.8 }) };
  }
  return social.mini.para;
}

// Mesmos limites das regras do Firestore (README): nome até 60 letras; avatar embutido ou a foto do Google
async function dadosPublicos() {
  const avatar = await avatarPublico();
  const avatarOk = /^data:image\/(jpeg|png|webp);base64,/.test(avatar) ? avatar.length <= 60000 : /^https:\/\/lh\d\.googleusercontent\.com\//.test(avatar);
  return { nome: (nomeExibicao() || conta.usuario.email.split('@')[0]).slice(0, 60), avatar: avatarOk ? avatar : '' };
}

// Atualiza nome, foto e dias de check-in em todos os grupos (só o que mudou)
async function publicarRanking() {
  if (!conta.usuario || !emGrupos() || !window.Nuvem?.social) return;
  const dados = { ...(await dadosPublicos()), dias: [...state.checkinsNoDia].sort().slice(-800) };
  const json = JSON.stringify(dados);
  for (const g of social.grupos) {
    if (social.enviado[g.id] === json) continue;
    social.enviado[g.id] = json;
    window.Nuvem.social.publicar(g.id, dados).catch(() => { delete social.enviado[g.id]; });
  }
}

function avatarDe(pessoa, classe) {
  return pessoa.avatar
    ? `<span class="avatar ${classe}"><img src="${esc(pessoa.avatar)}" alt="" referrerpolicy="no-referrer"></span>`
    : `<span class="avatar ${classe}">${esc((pessoa.nome || '?').charAt(0).toUpperCase())}</span>`;
}

function tempoRelativo(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.floor(min / 60)} h`;
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  const iso = d.toISOString().slice(0, 10);
  return iso === diaISO(-1) ? 'ontem' : fmtDataCurta(iso);
}

// ---------- Telas ----------
const AVISO_PRIVACIDADE = `<p class="dica"><b>Os membros do grupo veem:</b> seu nome, sua foto, os dias de check-in e o que você postar.
  Peso, finanças, notas e treinos continuam privados.</p>`;

function vGrupos() {
  if (!NUVEM_ATIVA) {
    return `<div class="card social-portao"><div class="social-icone">${ic('users')}</div>
      <div class="item-titulo">Grupos precisam das contas ativadas</div>
      <p class="dica">Ative o Firebase (veja o README) para criar grupos com seus amigos, competir na frequência e postar fotos.</p></div>`;
  }
  if (!social.gruposCarregados) return '<div class="card"><p class="vazio">Carregando grupos…</p></div>';
  if (!emGrupos()) {
    return `<div class="card social-portao"><div class="social-icone">${ic('users')}</div>
      <div class="item-titulo">Treine em grupo</div>
      <p class="dica">Crie um grupo e convide amigos com um código, ou entre num grupo que já existe.
        Cada grupo tem um ranking de frequência e um feed de fotos, e você pode participar de vários.</p>
      ${AVISO_PRIVACIDADE}
      <div class="acoes"><button class="btn primario" data-act="criarGrupo" style="flex:1">Criar grupo</button>
        <button class="btn" data-act="entrarGrupo" style="flex:1">Entrar com código</button></div></div>`;
  }
  // Grupo recém-criado/entrado ainda pode não ter chegado do servidor
  const g = grupoAtual();
  if (!g) return '<div class="card"><p class="vazio">Abrindo o grupo…</p></div>';
  // O troféu brilha só quando a pessoa acabou de abrir o ranking (não a cada atualização do grupo)
  const animarTrofeu = ui.animarTrofeu;
  ui.animarTrofeu = false;
  return `
    <div class="grupos-chips">
      ${social.grupos.map((x) => `<button class="grupo-chip ${x.id === ui.grupoAtual ? 'ativo' : ''}" data-act="abrirGrupo" data-v="${esc(x.id)}">${esc(x.nome)}</button>`).join('')}
      <button class="grupo-chip novo" data-act="menuGrupos" aria-label="Criar ou entrar em grupo">+</button>
    </div>
    <div class="card grupo-topo">
      <div class="item-corpo"><div class="item-titulo">${esc(g.nome)}</div>
        <div class="item-sub">${g.membros.length} ${g.membros.length === 1 ? 'membro' : 'membros'} · código <b class="codigo">${esc(g.id)}</b></div></div>
      <button class="btn pequeno" data-act="convidar">Convidar</button>
      <button class="btn-x" data-act="sairGrupo" aria-label="Sair do grupo" title="Sair do grupo">${ic('log-out')}</button>
    </div>
    <div class="segmento segmento-largo" style="margin:12px 0">
      <button data-act="grupoAba" data-v="ranking" class="${ui.grupoAba === 'ranking' ? 'ativo' : ''} ${animarTrofeu ? 'animar' : ''}">${ic('trophy')} Ranking</button>
      <button data-act="grupoAba" data-v="feed" class="${ui.grupoAba === 'feed' ? 'ativo' : ''}">${ic('camera')} Feed</button>
    </div>
    ${!social.carregado ? '<div class="card"><p class="vazio">Carregando…</p></div>' : ui.grupoAba === 'feed' ? vFeed(g) : vRanking()}
  `;
}

function contarDias(dias, periodo) {
  const hj = hoje();
  if (periodo === 'semana') {
    const inicio = diaISO(-new Date(hj + 'T12:00').getDay());
    return dias.filter((x) => x >= inicio && x <= hj).length;
  }
  const prefixo = periodo === 'mes' ? hj.slice(0, 7) : hj.slice(0, 4);
  return dias.filter((x) => x.startsWith(prefixo)).length;
}

function vRanking() {
  const periodo = ui.rankPeriodo;
  const lista = social.membros
    .map((p) => ({ ...p, n: contarDias(p.dias || [], periodo), foiHoje: (p.dias || []).includes(hoje()) }))
    .sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome));
  // Empates dividem a posição
  let pos = 0, anterior = -1;
  lista.forEach((p, i) => { if (p.n !== anterior) { pos = i + 1; anterior = p.n; } p.pos = pos; });
  const medalha = (p) => (p.n > 0 ? ['🥇', '🥈', '🥉'][p.pos - 1] || '' : '');
  const periodos = [['semana', 'Semana'], ['mes', 'Mês'], ['ano', 'Ano']];
  const podio = lista.filter((p) => p.n > 0).slice(0, 3);

  return `
    <div class="linha-titulo">
      <h2 class="secao" style="margin-top:4px">Mais frequentes</h2>
      <div class="segmento">${periodos.map(([v, t]) => `<button data-act="rankPeriodo" data-v="${v}" class="${periodo === v ? 'ativo' : ''}">${t}</button>`).join('')}</div>
    </div>
    ${podio.length ? `<div class="podio">${[podio[1], podio[0], podio[2]].filter(Boolean).map((p) => `
      <div class="podio-item pos-${Math.min(p.pos, 3)}">
        ${avatarDe(p, 'avatar-podio')}
        <span class="podio-medalha">${medalha(p)}</span>
        <b>${esc(p.nome.split(' ')[0])}</b>
        <span class="muted">${p.n} ${p.n === 1 ? 'dia' : 'dias'}</span>
        <div class="podio-base"></div>
      </div>`).join('')}</div>` : ''}
    <div class="lista">
      ${lista.map((p) => `
        <div class="item ranking-item ${p.uid === conta.usuario.uid ? 'eu' : ''}">
          <span class="ranking-pos">${medalha(p) || p.pos + 'º'}</span>
          ${avatarDe(p, 'conta-avatar')}
          <div class="item-corpo"><div class="item-titulo">${esc(p.nome)}${p.uid === conta.usuario.uid ? ' <span class="chip filtro">você</span>' : ''}</div>
            <div class="item-sub">${p.foiHoje ? `<span class="foi-hoje">${ic('circle-check', 'ic-inline')} foi hoje</span>` : 'ainda não foi hoje'}</div></div>
          <span class="item-valor">${p.n} ${p.n === 1 ? 'dia' : 'dias'}</span>
        </div>`).join('') || '<p class="vazio">Ninguém no ranking ainda.</p>'}
    </div>
    <p class="dica" style="margin-top:10px">Contam só os check-ins feitos no próprio dia.</p>
  `;
}

function vFeed(g) {
  const eu = conta.usuario.uid;
  const souCriador = g.criador === eu;
  return `
    <button class="btn primario bloco" data-act="novoPost" style="margin-bottom:12px">${ic('image-plus')} Postar foto</button>
    ${social.feed.map((p) => {
      const curtiu = (p.curtidas || []).includes(eu);
      const nCurt = (p.curtidas || []).length;
      return `<article class="card post">
        <header class="post-topo">
          ${avatarDe(p, 'conta-avatar')}
          <div class="item-corpo"><div class="item-titulo">${esc(p.nome)}</div><div class="item-sub">${esc(tempoRelativo(p.criado))}</div></div>
          ${p.uid === eu || souCriador ? `<button class="btn-x" data-act="apagarPost" data-id="${esc(p.id)}" aria-label="Apagar post">${ic('x')}</button>` : ''}
        </header>
        ${social.fotos[p.id] ? `<img class="post-foto" src="${social.fotos[p.id]}" alt="Foto de ${esc(p.nome)}" loading="lazy" data-post="${esc(p.id)}">` : ''}
        ${p.legenda ? `<p class="post-legenda">${esc(p.legenda)}</p>` : ''}
        <footer class="post-acoes">
          <button class="post-btn ${curtiu ? 'curtiu' : ''}" data-act="curtir" data-id="${esc(p.id)}" aria-pressed="${curtiu}">
            <span class="coracao">${ic('heart')}</span> ${nCurt || ''}</button>
          <button class="post-btn" data-act="verComentarios" data-id="${esc(p.id)}">${ic('message-circle')} ${p.nComentarios || ''}</button>
        </footer>
      </article>`;
    }).join('') || '<div class="card"><p class="vazio">Nenhum post ainda. Que tal ser o primeiro?</p></div>'}
  `;
}

// ---------- Modais ----------
function formPost(titulo = 'Postar foto') {
  const nomes = social.grupos.map((g) => g.nome).join(', ');
  abrirModal(titulo, `
    <label class="post-escolher" id="post-preview">
      <span class="post-escolher-txt">${ic('image-plus', 'ic-grande')}<br>Tirar ou escolher foto</span>
      <input type="file" name="foto" id="post-foto" accept="image/*" required hidden>
    </label>
    <label class="campo"><span>Legenda (opcional)</span><textarea name="legenda" rows="2" maxlength="300" placeholder="Treino de hoje concluído!"></textarea></label>
    <p class="dica">Vai aparecer em: <b>${esc(nomes)}</b></p>
  `, async (d) => {
    if (!d.foto?.size) throw new Error('Escolha uma foto.');
    const foto = await redimensionar(d.foto, { max: 1080, qualidade: 0.72 });
    if (foto.length > 900000) throw new Error('A foto ficou grande demais. Tente outra.');
    const post = { ...(await dadosPublicos()), foto, legenda: d.legenda.trim() };
    window.Nuvem.social.postar(social.grupos.map((g) => g.id), post).catch(() => toast('Não foi possível postar. Tente de novo.'));
    Object.assign(ui, { treinoAba: 'grupos', grupoAba: 'feed' });
    if (location.hash !== '#treino') location.hash = '#treino';
    toast(social.grupos.length > 1 ? `Foto postada em ${social.grupos.length} grupos! 🎉` : 'Foto postada! 🎉');
  }, { ok: 'Postar' });
}

function formCriarGrupo() {
  abrirModal('Criar grupo', `
    <label class="campo"><span>Nome do grupo</span><input name="nome" required maxlength="40" placeholder="Ex.: Galera da academia"></label>
    ${AVISO_PRIVACIDADE}
  `, async (d) => {
    const id = await window.Nuvem.social.criarGrupo(d.nome.trim());
    Object.assign(ui, { grupoAtual: id, treinoAba: 'grupos', grupoAba: 'ranking' });
    toast(`Grupo criado! Convide com o código ${id}.`);
  }, { ok: 'Criar' });
}

function formEntrarGrupo() {
  abrirModal('Entrar num grupo', `
    <label class="campo"><span>Código do grupo</span><input name="codigo" required maxlength="6" autocomplete="off" autocapitalize="characters" class="input-codigo" placeholder="ABC123"></label>
    ${AVISO_PRIVACIDADE}
  `, async (d) => {
    const codigo = d.codigo.trim().toUpperCase();
    if (social.grupos.some((g) => g.id === codigo)) {
      ui.grupoAtual = codigo;
      return;
    }
    const g = await window.Nuvem.social.verGrupo(codigo);
    if (!g) throw new Error('Não existe grupo com esse código.');
    await window.Nuvem.social.entrarGrupo(codigo);
    Object.assign(ui, { grupoAtual: codigo, treinoAba: 'grupos', grupoAba: 'ranking' });
    toast(`Você entrou em ${g.nome}! 💪`);
  }, { ok: 'Entrar' });
}

async function carregarComentarios(g, postId) {
  const caixa = $('#lista-coment');
  if (!caixa) return;
  try {
    const lista = await window.Nuvem.social.comentarios(g, postId);
    const eu = conta.usuario.uid;
    const donoPost = social.feed.find((p) => p.id === postId)?.uid;
    const podeApagar = (c) => c.uid === eu || donoPost === eu || grupoAtual()?.criador === eu;
    caixa.innerHTML = lista.map((c) => `
      <div class="comentario">
        ${avatarDe(c, 'avatar-mini')}
        <div class="item-corpo"><b>${esc(c.nome)}</b> <span class="muted">${esc(tempoRelativo(c.criado))}</span><div>${esc(c.texto)}</div></div>
        ${podeApagar(c) ? `<button type="button" class="btn-x" data-act="apagarComentario" data-post="${esc(postId)}" data-id="${esc(c.id)}" aria-label="Apagar comentário">${ic('x')}</button>` : ''}
      </div>`).join('') || '<p class="muted" style="margin:0">Nenhum comentário ainda.</p>';
    caixa.scrollTop = caixa.scrollHeight;
  } catch (e) {
    caixa.innerHTML = '<p class="muted" style="margin:0">Não foi possível carregar os comentários.</p>';
  }
}

function verComentarios(postId) {
  const g = ui.grupoAtual;
  abrirModal('Comentários', `
    <div id="lista-coment" class="lista-coment"><p class="muted" style="margin:0">Carregando…</p></div>
    <label class="campo" style="margin-top:12px"><span>Seu comentário</span><input name="texto" maxlength="300" required autocomplete="off" placeholder="Escreva algo…"></label>
  `, async (d) => {
    const texto = d.texto.trim();
    if (!texto) return false;
    await window.Nuvem.social.comentar(g, postId, { ...(await dadosPublicos()), texto });
    $('#modal [name=texto]').value = '';
    await carregarComentarios(g, postId);
    return false; // mantém o modal aberto
  }, { ok: 'Enviar' });
  carregarComentarios(g, postId);
}

const views = { inicio: vInicio, treino: vTreino, sessao: vSessao, peso: vPeso, notas: vNotas, financas: vFinancas, config: vConfig, perfil: vPerfil };

// animar = true só ao trocar de tela; atualizações na mesma tela não piscam
function render(animar = false) {
  const rota = location.hash.slice(1) || 'inicio';
  // Com contas ativadas, ninguém vê nada sem entrar
  const precisaLogin = NUVEM_ATIVA && !conta.usuario;
  document.body.classList.toggle('tela-login', precisaLogin);
  const view = precisaLogin ? (conta.verificada ? vLogin : vCarregando) : views[rota] || vInicio;
  const app = $('#app');
  app.innerHTML = view();
  if (!animar) app.classList.remove('entrar');
  else {
    app.classList.remove('entrar');
    [...app.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 10)));
    void app.offsetWidth; // reinicia a animação
    app.classList.add('entrar');
  }
  const aba = rota === 'sessao' ? 'treino' : rota;
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === aba));
  $('#avatar-topo').innerHTML = precisaLogin ? '' : avatarHtml('avatar-topo');
  const olho = $('#btn-ocultar');
  olho.innerHTML = ic(ui.ocultarValores ? 'eye-off' : 'eye');
  olho.setAttribute('aria-label', ui.ocultarValores ? 'Mostrar valores' : 'Esconder valores');
  olho.title = olho.getAttribute('aria-label');
  olho.classList.toggle('ativo', ui.ocultarValores);
  if (NUVEM_ATIVA) atualizarEscutaSocial();
  animarNumeros(); // valores das finanças "contam" até o número novo
  // Ao abrir Finanças, busca lançamentos novos dos bancos (se a última vez foi há mais de 12 h)
  if (animar && rota === 'financas' && !precisaLogin && (!NUVEM_ATIVA || conta.sincronizada)) sincronizarSeAntigo();
  // Atalho do ícone (segurar o ícone no Android): roda uma vez, quando os dados da conta já chegaram
  if (atalhoPendente && !precisaLogin && (!NUVEM_ATIVA || conta.sincronizada)) setTimeout(executarAtalho);
}

// ---------- Atalhos do ícone (manifest "shortcuts": ./?atalho=...) ----------
let atalhoPendente = new URLSearchParams(location.search).get('atalho');
if (atalhoPendente) history.replaceState(null, '', location.pathname + location.hash);

function executarAtalho() {
  const a = atalhoPendente;
  atalhoPendente = null;
  if (!a) return;
  if (a === 'checkin') {
    if (location.hash !== '#treino') location.hash = '#treino';
    if (state.checkins.includes(hoje())) return toast('O check-in de hoje já está feito. 💪');
    acoes.alternarDia({ v: hoje() });
    if (!modalAberto()) { salvar(); render(); }
  } else if (a === 'treino') {
    if (state.sessaoAtual) { location.hash = '#sessao'; return; }
    const f = fichaDeHoje();
    if (!f) { location.hash = '#treino'; return toast('Hoje não tem ficha marcada. Escolha uma para começar.'); }
    acoes.iniciarTreino({ id: f.id });
    salvar();
  } else if (a === 'lancamento') {
    if (location.hash !== '#financas') location.hash = '#financas';
    formTransacao(null);
  } else if (a === 'peso') {
    if (location.hash !== '#peso') location.hash = '#peso';
    setTimeout(() => $('#app input[name="peso"]')?.focus(), 350);
  }
}

// =====================================================================
// Formulários dos modais
// =====================================================================
// Um exercício da ficha, com seus próprios campos (o editor vai empilhando um bloco por exercício)
function blocoExercicio(e = {}) {
  return `<div class="ex-editor">
    <div class="ex-editor-topo">
      <span class="ex-num"></span>
      <input name="ex_nome" value="${esc(e.nome)}" placeholder="Nome do exercício" aria-label="Nome do exercício">
      <button type="button" class="btn-x" data-act="exSubir" aria-label="Subir">${ic('chevron-up')}</button>
      <button type="button" class="btn-x" data-act="exDescer" aria-label="Descer">${ic('chevron-down')}</button>
      <button type="button" class="btn-x" data-act="exRemover" aria-label="Remover exercício">${ic('trash-2')}</button>
    </div>
    <div class="ex-editor-campos">
      <label><span>Séries</span><input name="ex_series" type="number" min="1" inputmode="numeric" value="${esc(e.series)}" placeholder="4"></label>
      <label><span>Reps</span><input name="ex_reps" value="${esc(e.reps)}" placeholder="10-12"></label>
      <label><span>Carga (kg)</span><input name="ex_carga" type="number" step="any" min="0" inputmode="decimal" value="${esc(e.carga)}" placeholder="—"></label>
      <label><span>Descanso (s)</span><input name="ex_descanso" inputmode="numeric" value="${esc(e.descanso)}" placeholder="60"></label>
    </div>
    <input name="ex_obs" class="ex-editor-obs" value="${esc(e.obs)}" placeholder="Observação (opcional)">
  </div>`;
}

// Numera os blocos e atualiza a contagem depois de adicionar, remover ou mover
function renumerarExercicios() {
  const blocos = [...document.querySelectorAll('#lista-ex .ex-editor')];
  blocos.forEach((b, i) => { b.querySelector('.ex-num').textContent = i + 1; });
  const c = $('#ex-contagem');
  if (c) c.textContent = `${blocos.length} ${blocos.length === 1 ? 'exercício' : 'exercícios'}`;
}

function formFicha(f) {
  const diaAtual = f?.dia ?? '';
  abrirModal(f ? 'Editar ficha' : 'Nova ficha', `
    <label class="campo"><span>Nome</span><input name="nome" required value="${esc(f?.nome)}" placeholder="Treino A — Empurrar"></label>
    <div class="linha-form">
      <label class="campo"><span>Foco</span><input name="foco" value="${esc(f?.foco)}" placeholder="Peito, ombros e tríceps"></label>
      <label class="campo" style="flex:0 0 110px"><span>Dia</span><select name="dia">
        <option value="">—</option>
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}" ${diaAtual === d ? 'selected' : ''}>${DIAS[d]}</option>`).join('')}
      </select></label>
    </div>
    <div class="linha-titulo"><span class="campo-rotulo">Exercícios</span><span class="muted" id="ex-contagem"></span></div>
    <div id="lista-ex" class="lista-ex">${(f?.exercicios.length ? f.exercicios : [{}]).map(blocoExercicio).join('')}</div>
    <button type="button" class="btn bloco btn-tracejado" data-act="exAdicionar">${ic('plus')} Adicionar exercício</button>
    ${f ? `<div class="modal-extra" style="margin-top:12px"><button type="button" class="btn pequeno perigo" data-act="excluirFicha" data-id="${f.id}">${ic('trash-2')} Excluir ficha</button></div>` : ''}
  `, (d, fd) => {
    // Cada bloco manda os mesmos nomes de campo; getAll devolve na ordem da tela
    const campo = (nome) => fd.getAll(nome).map((v) => String(v).trim());
    const nomes = campo('ex_nome'), series = campo('ex_series'), reps = campo('ex_reps');
    const cargas = campo('ex_carga'), descansos = campo('ex_descanso'), obs = campo('ex_obs');
    const exercicios = nomes.map((nome, i) => {
      const serie = numeroCampo(series[i], 1, 50), carga = numeroCampo(cargas[i], 0, 1000);
      if (nome && serie === null) throw new Error(`Séries de "${nome}": use um número de 1 a 50.`);
      if (nome && carga === null) throw new Error(`Carga de "${nome}": use um número em kg (ex.: 12,5).`);
      return { nome, series: serie || '', reps: reps[i].replace(/^(\d+)\s*a\s*(\d+)$/i, '$1-$2'), carga, descanso: descansos[i].replace(/\s*s$/i, ''), obs: obs[i] };
    }).filter((e) => e.nome);
    if (!exercicios.length) throw new Error('Adicione pelo menos um exercício.');
    const dados = { nome: d.nome.trim(), foco: d.foco.trim(), dia: d.dia === '' ? '' : Number(d.dia), exercicios };
    if (f) Object.assign(f, dados);
    else state.fichas.push({ id: uid(), ...dados });
  });
  renumerarExercicios();
}

// Editar um treino já registrado (data, nome, cargas, séries, o que foi feito e observações)
function formSessao(s) {
  abrirModal('Editar treino', `
    <div class="linha-form">
      <label class="campo"><span>Treino</span><input name="nome" required value="${esc(s.nome)}"></label>
      <label class="campo" style="flex:0 0 150px"><span>Data</span><input type="date" name="data" required max="${hoje()}" value="${s.data}"></label>
    </div>
    <div class="lista lista-editar">
      ${s.itens.map((i, n) => `<div class="ex-linha">
        <input type="checkbox" name="feito_${n}" ${i.feito ? 'checked' : ''} aria-label="Feito">
        <div class="item-corpo"><div class="item-titulo ex-nome">${esc(i.nome)}</div></div>
        <div class="ex-campos">
          <input name="sr_${n}" placeholder="séries×reps" value="${esc(i.series && i.reps ? `${i.series}x${i.reps}` : '')}" aria-label="Séries e repetições">
          <input type="number" name="carga_${n}" step="any" min="0" inputmode="decimal" placeholder="kg" value="${esc(i.carga)}" aria-label="Carga em kg">
        </div>
      </div>`).join('')}
    </div>
    <label class="campo" style="margin-top:14px"><span>Observações</span><textarea name="obs" rows="2">${esc(s.obs)}</textarea></label>
    <div class="modal-extra"><button type="button" class="btn pequeno perigo" data-act="excluirSessao" data-id="${s.id}">${ic('trash-2')} Excluir treino</button></div>
  `, (d) => {
    if (!dataValida(d.data)) throw new Error('Escolha uma data válida.');
    // Confere tudo antes de mudar qualquer coisa
    const novos = s.itens.map((i, n) => {
      const carga = numeroCampo(d[`carga_${n}`], 0, 1000);
      if (carga === null) throw new Error(`Carga de "${i.nome}": use um número em kg (ex.: 12,5).`);
      const sr = seriesReps(d[`sr_${n}`]);
      if (sr === null) throw new Error(`Séries de "${i.nome}": use o formato 3x12.`);
      return { feito: !!d[`feito_${n}`], carga, ...sr };
    });
    Object.assign(s, { nome: d.nome.trim(), data: d.data, obs: d.obs.trim() });
    s.itens.forEach((i, n) => Object.assign(i, novos[n]));
    toast('Treino atualizado.');
  });
}

function carregarPlano() {
  let novas = 0;
  for (const p of PLANO_EXEMPLO.fichas) {
    if (state.fichas.some((f) => f.nome === p.nome)) continue;
    state.fichas.push({ id: uid(), ...structuredClone(p), exercicios: p.exercicios.map((e) => ({ carga: '', ...e })) });
    novas++;
  }
  if (!state.notas.some((n) => n.titulo === PLANO_EXEMPLO.nota.titulo)) {
    state.notas.push({ id: uid(), ...PLANO_EXEMPLO.nota, fixada: true, atualizada: Date.now() });
  }
  toast(`${novas} fichas adicionadas (seg a sex) + nota com as diretrizes.`);
}

// =====================================================================
// Cronômetro de descanso (baseado em horário, funciona mesmo com a tela bloqueada)
// =====================================================================
let timer = null;

function iniciarDescanso(seg) {
  pararDescanso();
  timer = { fim: Date.now() + seg * 1000, total: seg * 1000 };
  $('#timer').hidden = false;
  requestAnimationFrame(() => $('#timer').classList.add('visivel'));
  timer.intervalo = setInterval(tickDescanso, 200);
  tickDescanso();
}

function tickDescanso() {
  if (!timer) return;
  const resta = Math.max(timer.fim - Date.now(), 0);
  const s = Math.ceil(resta / 1000);
  $('#timer-txt').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('#timer-barra').style.transform = `scaleX(${resta / timer.total})`;
  if (resta <= 0) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    toast('Descanso acabou — próxima série! 💪');
    pararDescanso();
  }
}

function pararDescanso() {
  if (timer) clearInterval(timer.intervalo);
  timer = null;
  const el = $('#timer');
  el.classList.remove('visivel');
  setTimeout(() => { if (!timer) el.hidden = true; }, 250);
}

function formNota(n) {
  abrirModal(n ? 'Editar nota' : 'Nova nota', `
    <label class="campo"><span>Título</span><input name="titulo" value="${esc(n?.titulo)}"></label>
    <label class="campo"><span>Texto</span><textarea name="texto" rows="10">${esc(n?.texto)}</textarea></label>
    <label class="check"><input type="checkbox" name="fixada" ${n?.fixada ? 'checked' : ''}> Fixar no início</label>
    ${n ? `<div class="modal-extra"><button type="button" class="btn pequeno perigo" data-act="excluirNota" data-id="${n.id}">Excluir nota</button></div>` : ''}
  `, (d) => {
    if (!d.titulo.trim() && !d.texto.trim()) throw new Error('A nota está vazia.');
    const dados = { titulo: d.titulo.trim(), texto: d.texto, fixada: !!d.fixada, atualizada: Date.now() };
    if (n) Object.assign(n, dados);
    else state.notas.push({ id: uid(), ...dados });
  });
}

function formTransacao(t) {
  const tipo = t && t.valor > 0 ? 'receita' : 'despesa';
  const opts = (lista) => lista.map((c) => `<option ${t?.categoria === c ? 'selected' : ''}>${c}</option>`).join('');
  abrirModal(t ? 'Editar lançamento' : 'Novo lançamento', `
    <div class="linha-form">
      <label class="campo"><span>Tipo</span><select name="tipo"><option value="despesa" ${tipo === 'despesa' ? 'selected' : ''}>Despesa</option><option value="receita" ${tipo === 'receita' ? 'selected' : ''}>Receita</option></select></label>
      <label class="campo"><span>Valor (R$)</span><input type="number" name="valor" step="any" min="0.01" inputmode="decimal" required value="${t ? Math.abs(t.valor) : ''}"></label>
    </div>
    <label class="campo"><span>Descrição</span><input name="descricao" required value="${esc(t?.descricao)}" placeholder="Mercado, academia, salário…"></label>
    <div class="linha-form">
      <label class="campo"><span>Data</span><input type="date" name="data" required value="${esc(t?.data || (ui.mes === hoje().slice(0, 7) ? hoje() : ui.mes + '-01'))}"></label>
      <label class="campo"><span>Categoria</span><select name="categoria">
        <optgroup label="Despesas">${opts(CATEGORIAS)}</optgroup>
        <optgroup label="Receitas">${opts(CATEGORIAS_RECEITA.filter((c) => !CATEGORIAS.includes(c)))}</optgroup>
      </select></label>
    </div>
    ${t ? `<div class="modal-extra"><button type="button" class="btn pequeno perigo" data-act="excluirTransacao" data-id="${t.id}">Excluir lançamento</button></div>` : ''}
  `, (d) => {
    const valor = Math.abs(numeroCampo(d.valor, 0.01, 1e9) || 0) * (d.tipo === 'despesa' ? -1 : 1);
    if (!valor) throw new Error('Informe um valor válido.');
    if (!dataValida(d.data)) throw new Error('Escolha uma data válida.');
    if (Math.abs(valor) >= 1e9) throw new Error('Valor alto demais.');
    const dados = { data: d.data, descricao: d.descricao.trim().slice(0, 200), valor: Math.round(valor * 100) / 100, categoria: d.categoria };
    if (t) {
      // Aprende a categoria: os lançamentos iguais (mesma descrição, ainda não corrigidos à mão) mudam junto,
      // e os próximos já vêm certos
      if (t.categoria !== d.categoria) {
        const k = chaveDesc(dados.descricao);
        state.regras[k] = d.categoria;
        dados.catManual = true;
        let iguais = 0;
        state.transacoes.forEach((x) => {
          if (x === t || x.catManual || x.categoria === d.categoria || chaveDesc(x.descricao) !== k || (x.valor < 0) !== (valor < 0)) return;
          if (x.categoria === t.categoria || x.categoria === 'Outros') { x.categoria = d.categoria; iguais++; }
        });
        if (iguais) toast(`${iguais} ${iguais === 1 ? 'lançamento igual também foi' : 'lançamentos iguais também foram'} para ${d.categoria}.`);
      }
      Object.assign(t, dados);
    } else {
      state.transacoes.push({ id: uid(), ...dados, origem: 'manual' });
    }
  });
}

// =====================================================================
// Importação de extratos (OFX / CSV)
// =====================================================================
// "Compra &amp; cia" → "Compra & cia" (OFX é SGML/XML e pode vir com entidades)
const decodificarEntidades = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
  const fixas = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (fixas[e.toLowerCase()]) return fixas[e.toLowerCase()];
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
});

// Data AAAA-MM-DD que existe de verdade (nada de mês 13 ou 31 de fevereiro)
function dataValida(iso) {
  if (!DATA_OK.test(iso)) return false;
  const [a, m, d] = iso.split('-').map(Number);
  const dt = new Date(a, m - 1, d);
  return a >= 1990 && a <= 2100 && dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseOFX(txt) {
  return txt.split(/<STMTTRN>/i).slice(1).map((bloco) => {
    const tag = (n) => decodificarEntidades((bloco.match(new RegExp(`<${n}>([^<\\r\\n]*)`, 'i'))?.[1] || '').trim());
    const dt = tag('DTPOSTED');
    return {
      data: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
      valor: /^[-+]?\d+(\.\d+)?$/.test(tag('TRNAMT')) ? Number(tag('TRNAMT')) : parseNum(tag('TRNAMT')),
      descricao: tag('MEMO') || tag('NAME') || 'Sem descrição',
      fitid: tag('FITID'),
    };
  });
}

// Divide uma linha do CSV em campos. Aspas só abrem no começo de um campo: `TV 50" LG` é texto comum
function dividirCSV(linha, sep) {
  const out = []; let cur = '', aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (aspas) {
      if (c === '"' && linha[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') aspas = false; else cur += c;
    } else if (c === '"' && cur.trim() === '') { aspas = true; cur = ''; }
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Quebra o CSV em registros respeitando aspas: uma descrição "com\nquebra de linha" continua sendo um registro só.
// Como em dividirCSV, aspas só abrem no começo de um campo (uma aspa solta no meio do texto não engole o resto do arquivo).
function registrosCSV(txt, sep) {
  if (!sep) { // sem separador informado: deduz pela primeira linha
    const l = txt.split(/\r?\n/)[0] || '', n = (c) => l.split(c).length - 1;
    sep = n(';') > n(',') ? ';' : n('\t') > n(',') ? '\t' : ',';
  }
  const registros = [];
  let atual = '', campo = '', aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) {
      if (c === '"' && txt[i + 1] === '"') { atual += '""'; campo += '"'; i++; continue; }
      if (c === '"') aspas = false;
      atual += c === '\n' || c === '\r' ? ' ' : c;
      campo += c;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      if (atual.trim()) registros.push(atual);
      atual = ''; campo = '';
      continue;
    }
    if (c === '"' && campo.trim() === '') aspas = true;
    campo = c === sep ? '' : campo + c;
    atual += c;
  }
  if (atual.trim()) registros.push(atual);
  return registros;
}

// "05/01/2026", "5-1-26", "05.01.2026" (dia/mês/ano, padrão brasileiro) ou "2026-01-05" → "2026-01-05"
function dataCSV(bruto) {
  const s = String(bruto || '').trim();
  const br = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (br) return `${br[3].length === 2 ? '20' + br[3] : br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  const iso = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\b/);
  return iso ? `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}` : s.slice(0, 10);
}

function parseCSV(txt, cartao) {
  txt = txt.replace(/^﻿/, '');
  // Alguns bancos põem linhas de cabeçalho (nome, agência, período…) antes da tabela: acha a linha com as colunas
  const fisicas = txt.split(/\r?\n/);
  const separador = (l) => {
    const n = (ch) => l.split(ch).length - 1;
    return n(';') > n(',') ? ';' : n('\t') > n(',') ? '\t' : ',';
  };
  const ehCabecalho = (l) => {
    const cab = dividirCSV(l, separador(l)).map(norm);
    return cab.some((c) => /^(data|date|dt)\b/.test(c)) && cab.some((c) => /valor|amount|value|quantia|debito|credito|saida|entrada/.test(c));
  };
  const iCab = fisicas.slice(0, 30).findIndex(ehCabecalho);
  if (iCab < 0) {
    if (fisicas.filter((l) => l.trim()).length < 2) throw new Error('O arquivo CSV está vazio.');
    throw new Error('Não encontrei as colunas de data e valor no CSV.');
  }
  const sep = separador(fisicas[iCab]);
  const linhas = registrosCSV(fisicas.slice(iCab).join('\n'), sep);
  if (linhas.length < 2) throw new Error('O arquivo CSV está vazio.');
  const cab = dividirCSV(linhas[0], sep).map(norm);
  // Procura primeiro o nome exato, depois o que só contém a palavra, sem repetir colunas já usadas
  // ("Data valor" é data; em "Data lançamento" a descrição não pode ser a coluna de data)
  const achar = (exato, contem, ...fora) => {
    const i = cab.findIndex((c, k) => !fora.includes(k) && exato.test(c));
    return i >= 0 ? i : cab.findIndex((c, k) => !fora.includes(k) && contem.test(c));
  };
  const iData = achar(/^(data|date|dt)( (lancamento|movimento|transacao|compra))?$/, /^(data|date|dt)\b/);
  const iValor = achar(/^(valor|amount|value|quantia)( \(?r\$\)?)?$/, /^(?!data|date|dt).*(valor|amount|value|quantia)/, iData);
  // Extratos com duas colunas: Débito e Crédito (ou Saída e Entrada)
  const iDeb = iValor < 0 ? achar(/^(debito|saida)s?( \(?r\$\)?)?$/, /debito|saida/, iData) : -1;
  const iCred = iValor < 0 ? achar(/^(credito|entrada)s?( \(?r\$\)?)?$/, /credito|entrada/, iData) : -1;
  const iDesc = achar(/^(descricao|historico|lancamento|estabelecimento|detalhes)$/, /descri|title|titulo|historico|memo|estabelecimento|lancamento|detalhe/, iData, iValor, iDeb, iCred);
  const iId = achar(/^(identificador|id)$/, /^(identificador|id)$/);
  if (iData < 0 || (iValor < 0 && iDeb < 0 && iCred < 0)) throw new Error('Não encontrei as colunas de data e valor no CSV.');

  return linhas.slice(1).map((l) => {
    const c = dividirCSV(l, sep);
    let valor;
    if (iValor >= 0) valor = parseNum(c[iValor]);
    else {
      const deb = iDeb >= 0 && c[iDeb] ? Math.abs(parseNum(c[iDeb])) : 0;
      const cred = iCred >= 0 && c[iCred] ? Math.abs(parseNum(c[iCred])) : 0;
      valor = (Number.isFinite(cred) ? cred : NaN) - (Number.isFinite(deb) ? deb : NaN);
    }
    if (cartao) valor = -valor;
    return { data: dataCSV(c[iData]), valor, descricao: (iDesc >= 0 ? c[iDesc] : '') || 'Sem descrição', fitid: iId >= 0 ? c[iId] : '' };
  });
}

function formImportar() {
  abrirModal('Importar extrato', `
    <p class="dica">No app do seu banco, exporte o extrato da conta ou a fatura do cartão em <b>OFX</b> (preferível) ou <b>CSV</b>.</p>
    <label class="campo"><span>Arquivo</span><input type="file" name="arquivo" accept=".ofx,.qfx,.csv,.txt" required></label>
    <label class="check"><input type="checkbox" name="cartao"> É fatura de cartão em CSV (valores positivos são gastos)</label>
  `, async (d) => {
    if (!d.arquivo?.size) throw new Error('Escolha o arquivo do extrato.');
    if (d.arquivo.size > 20e6) throw new Error('Arquivo grande demais para um extrato (máx. 20 MB).');
    const txt = await lerTexto(d.arquivo);
    const ehOFX = /<OFX>|OFXHEADER/i.test(txt);
    const lidos = ehOFX ? parseOFX(txt) : parseCSV(txt, !!d.cartao);
    const validos = lidos.filter((t) => dataValida(t.data) && Number.isFinite(t.valor) && t.valor !== 0 && Math.abs(t.valor) < 1e9);
    // Igual ao Open Finance: pagar a fatura e guardar/resgatar dinheiro só mudam o dinheiro de lugar
    const itens = validos.filter((t) => !PAGAMENTO_FATURA.test(t.descricao) && !ehMovimentoGuardado(t.descricao, ''));
    const movimentos = validos.length - itens.length;
    if (!itens.length) throw new Error(validos.length ? 'O arquivo só tem pagamentos de fatura e aplicações/resgates, que não contam como gasto.' : 'Nenhum lançamento reconhecido no arquivo.');

    const chave = (t) => (t.fitid ? `f:${t.fitid}` : `k:${t.data}|${t.valor.toFixed(2)}|${chaveDesc(t.descricao)}`);
    const existentes = new Set(state.transacoes.map((t) => t.chave).filter(Boolean));
    let novos = 0;
    for (const t of itens) {
      const k = chave(t);
      if (existentes.has(k)) continue;
      existentes.add(k);
      state.transacoes.push({ id: uid(), data: t.data, descricao: t.descricao.slice(0, 200), valor: Math.round(t.valor * 100) / 100, categoria: categorizar(t.descricao, t.valor), origem: 'importado', chave: k });
      novos++;
    }
    const ultimo = itens.map((t) => t.data).sort().at(-1);
    ui.mes = ultimo.slice(0, 7);
    const repetidos = itens.length - novos, descartados = lidos.length - validos.length;
    toast(`${novos} lançamentos importados${repetidos ? `, ${repetidos} repetidos ignorados` : ''}${movimentos ? `, ${movimentos} pagamentos de fatura/aplicações fora dos gastos` : ''}${descartados ? `, ${descartados} linhas com data ou valor ilegível ignoradas` : ''}.`);
  }, { ok: 'Importar' });
}

// =====================================================================
// Ações (cliques em elementos com data-act)
// =====================================================================
const porId = (lista, id) => lista.find((x) => x.id === id);

const acoes = {
  novaFicha: () => formFicha(null),
  editarFicha: ({ id }) => formFicha(porId(state.fichas, id)),
  excluirFicha: ({ id }) => {
    const f = porId(state.fichas, id);
    const emUso = state.sessaoAtual?.fichaId === id;
    if (!confirm(`Excluir a ficha "${f?.nome}"? Os treinos já registrados no histórico continuam salvos.${emUso
      ? '\n\nAtenção: o treino em andamento usa esta ficha. Ele continua e será salvo no histórico, mas as cargas novas não vão para ficha nenhuma.' : ''}`)) return false;
    state.fichas = state.fichas.filter((x) => x.id !== id);
    fecharModal();
    salvar();
    render();
    toast('Ficha excluída.');
    return false;
  },
  // Editor de ficha: mexem só nos blocos dentro do modal (não redesenham a tela)
  exAdicionar: () => {
    const lista = $('#lista-ex');
    lista.insertAdjacentHTML('beforeend', blocoExercicio());
    renumerarExercicios();
    const novo = lista.lastElementChild;
    novo.classList.add('ex-novo');
    novo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    novo.querySelector('[name=ex_nome]').focus({ preventScroll: true });
    return false;
  },
  exRemover: (_, el) => {
    const bloco = el.closest('.ex-editor');
    const nome = bloco.querySelector('[name=ex_nome]').value.trim();
    if (nome && !confirm(`Remover "${nome}" da ficha?`)) return false;
    bloco.remove();
    if (!$('#lista-ex .ex-editor')) $('#lista-ex').insertAdjacentHTML('beforeend', blocoExercicio());
    renumerarExercicios();
    return false;
  },
  exSubir: (_, el) => {
    const bloco = el.closest('.ex-editor');
    if (bloco.previousElementSibling) bloco.previousElementSibling.before(bloco);
    renumerarExercicios();
    return false;
  },
  exDescer: (_, el) => {
    const bloco = el.closest('.ex-editor');
    if (bloco.nextElementSibling) bloco.nextElementSibling.after(bloco);
    renumerarExercicios();
    return false;
  },
  carregarPlano: () => carregarPlano(),
  // Ações do cronômetro não redesenham a tela (retornam false)
  descanso: ({ v }) => { iniciarDescanso(parseInt(v, 10) || 60); return false; },
  maisDescanso: () => { if (timer) { timer.fim += 15000; timer.total += 15000; tickDescanso(); } return false; },
  pararDescanso: () => { pararDescanso(); return false; },
  iniciarTreino: ({ id }) => {
    // Toque duplo em "Iniciar" (ou um treino já aberto): só volta para ele, sem zerar o horário
    if (state.sessaoAtual) { location.hash = '#sessao'; return false; }
    const f = porId(state.fichas, id);
    if (!f) { toast('Essa ficha não existe mais.'); return false; }
    state.sessaoAtual = {
      id: uid(), fichaId: f.id, nome: f.nome, data: hoje(), inicio: Date.now(), obs: '',
      itens: f.exercicios.map((e) => ({ ...e, carga: ultimaCarga(e.nome)?.carga ?? e.carga, feito: false })),
    };
    location.hash = '#sessao';
  },
  addExercicioSessao: () => abrirModal('Adicionar exercício', `
    <label class="campo"><span>Exercício</span><input name="linha" required placeholder="Rosca direta 3x12 12kg"></label>`,
  (d) => {
    if (!state.sessaoAtual) throw new Error('O treino já foi encerrado.');
    const ex = parseExercicios(d.linha)[0];
    if (!ex?.nome) throw new Error('Escreva o nome do exercício.');
    state.sessaoAtual.itens.push({ ...ex, feito: false });
  }, { ok: 'Adicionar' }),
  finalizarTreino: () => {
    const s = state.sessaoAtual;
    if (!s) { location.hash = '#treino'; return false; } // segundo toque: o treino já foi salvo
    if (!s.itens.some((i) => i.feito) && !confirm('Nenhum exercício marcado como feito. Salvar mesmo assim?')) return false;
    if (state.sessaoAtual !== s) return false; // outro toque salvou enquanto a pergunta estava aberta
    s.fim = Date.now();
    if (!state.sessoes.some((x) => x.id === s.id)) state.sessoes.push(s);
    // A ficha passa a sugerir a carga mais recente
    const f = porId(state.fichas, s.fichaId);
    if (f) for (const i of s.itens) {
      const e = f.exercicios.find((x) => norm(x.nome) === norm(i.nome));
      if (e && i.feito) Object.assign(e, { carga: i.carga, series: i.series, reps: i.reps });
    }
    state.sessaoAtual = null;
    toast(f ? 'Treino salvo! 💪' : 'Treino salvo! 💪 (a ficha foi excluída, então as cargas não foram atualizadas)');
    location.hash = '#treino';
  },
  // Começou sem querer ou bem antes da hora: o início passa a ser agora e os exercícios voltam a "não feito"
  recomecarTreino: () => {
    const s = state.sessaoAtual;
    if (!s) return false;
    if (!confirm('Recomeçar o treino agora? O horário de início vai para agora e os exercícios marcados voltam a ficar desmarcados (as cargas digitadas continuam).')) return false;
    Object.assign(s, { inicio: Date.now(), data: hoje() });
    s.itens.forEach((i) => { i.feito = false; });
    pararDescanso();
    salvar();
    render();
    toast(`Treino recomeçado às ${new Date(s.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`);
    return false;
  },
  cancelarTreino: () => {
    if (!state.sessaoAtual) { location.hash = '#treino'; return false; }
    if (!confirm('Descartar o treino em andamento?')) return false;
    state.sessaoAtual = null;
    location.hash = '#treino';
  },
  alternarDia: ({ v }) => {
    if (!DATA_OK.test(v || '')) return false;
    if (state.checkins.includes(v)) {
      // Toque duplo logo depois de marcar não desmarca; desmarcar de propósito pede confirmação
      if (ui.ultimoCheckin === v && Date.now() - (ui.ultimoCheckinEm || 0) < 1500) return false;
      const valiaNoRanking = state.checkinsNoDia.includes(v);
      if (!confirm(`Desmarcar o check-in de ${fmtData(v)}?${valiaNoRanking ? '\n\nEle foi feito no próprio dia e conta no ranking dos grupos. Se marcar de novo depois, não vai contar mais.' : ''}`)) return false;
      state.checkins = state.checkins.filter((d) => d !== v);
      state.checkinsNoDia = state.checkinsNoDia.filter((d) => d !== v);
      return;
    }
    state.checkins.push(v);
    ui.ultimoCheckin = v;
    ui.ultimoCheckinEm = Date.now();
    if (navigator.vibrate) navigator.vibrate(15);
    if (v !== hoje()) return;
    // Só o check-in feito no próprio dia vale para o ranking
    if (!state.checkinsNoDia.includes(v)) state.checkinsNoDia.push(v);
    if (emGrupos()) {
      salvar();
      render();
      formPost('Check-in feito! 💪 Postar uma foto?');
    } else {
      toast('Check-in feito! 💪');
    }
  },
  // ---------- Grupos ----------
  treinoAba: ({ v }) => { ui.treinoAba = v; },
  grupoAba: ({ v }) => {
    if (v === 'ranking' && ui.grupoAba !== 'ranking') ui.animarTrofeu = true;
    ui.grupoAba = v;
  },
  rankPeriodo: ({ v }) => { ui.rankPeriodo = v; },
  abrirGrupo: ({ v }) => { ui.grupoAtual = v; },
  criarGrupo: () => formCriarGrupo(),
  entrarGrupo: () => formEntrarGrupo(),
  menuGrupos: () => abrirModal('Grupos', `
    <div class="acoes" style="flex-direction:column">
      <button type="button" class="btn primario bloco" data-act="criarGrupo">Criar um grupo novo</button>
      <button type="button" class="btn bloco" data-act="entrarGrupo">Entrar com um código</button>
    </div>`, () => {}, { ok: 'Fechar' }),
  convidar: () => {
    const g = grupoAtual();
    abrirModal(`Convidar para ${g.nome}`, `
      <p class="dica">Peça para a pessoa abrir o app, ir em <b>Treino → Grupos → Entrar com código</b> e digitar:</p>
      <div class="codigo-grande">${esc(g.id)}</div>
      <button type="button" class="btn bloco" data-act="compartilharCodigo">${navigator.share ? 'Compartilhar convite' : 'Copiar convite'}</button>
    `, () => {}, { ok: 'Pronto' });
  },
  compartilharCodigo: () => {
    const g = grupoAtual();
    const texto = `Bora treinar junto! Entra no grupo "${g.nome}" no Tétis com o código ${g.id} 💪`;
    if (navigator.share) navigator.share({ text: texto, url: location.origin + location.pathname }).catch(() => {});
    else navigator.clipboard?.writeText(texto).then(() => toast('Convite copiado!')).catch(() => toast(`Código: ${g.id}`));
    return false;
  },
  sairGrupo: () => {
    const g = grupoAtual();
    if (!confirm(`Sair de "${g.nome}"? Seus posts nesse grupo serão apagados.`)) return false;
    window.Nuvem.social.sairGrupo(g.id)
      .then(() => toast(`Você saiu de ${g.nome}.`))
      .catch(() => toast('Não foi possível sair do grupo. Tente de novo.'));
    delete social.enviado[g.id];
    return false;
  },
  novoPost: () => formPost(),
  curtir: ({ id }) => {
    const p = social.feed.find((x) => x.id === id);
    if (!p) return false;
    const eu = conta.usuario.uid;
    const sim = !(p.curtidas || []).includes(eu);
    // Atualiza na hora; o Firebase confirma em seguida
    p.curtidas = sim ? [...(p.curtidas || []), eu] : p.curtidas.filter((u) => u !== eu);
    if (sim && navigator.vibrate) navigator.vibrate(10);
    window.Nuvem.social.curtir(ui.grupoAtual, id, sim).catch(() => toast('Não foi possível curtir.'));
    render();
    if (sim) document.querySelector(`[data-act=curtir][data-id="${id}"] .coracao`)?.classList.add('pulsou');
    return false;
  },
  verComentarios: ({ id }) => verComentarios(id),
  apagarPost: ({ id }) => {
    if (!confirm('Apagar este post?')) return false;
    window.Nuvem.social.apagarPost(ui.grupoAtual, id).catch(() => toast('Não foi possível apagar.'));
    return false;
  },
  apagarComentario: ({ post, id }) => {
    const g = ui.grupoAtual;
    window.Nuvem.social.apagarComentario(g, post, id)
      .then(() => carregarComentarios(g, post))
      .catch(() => toast('Não foi possível apagar o comentário.'));
    return false;
  },
  calMes: ({ v }) => {
    const [a, m] = ui.calMes.split('-').map(Number);
    const d = new Date(a, m - 1 + Number(v), 1);
    ui.calMes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },
  editarSessao: ({ id }) => formSessao(porId(state.sessoes, id)),
  excluirSessao: ({ id }) => {
    if (!confirm('Excluir este treino do histórico? Isso não pode ser desfeito.')) return false;
    state.sessoes = state.sessoes.filter((s) => s.id !== id);
    fecharModal();
    salvar();
    render();
    toast('Treino excluído.');
    return false;
  },

  pesoPeriodo: ({ v }) => { ui.pesoPeriodo = v; },
  excluirPeso: ({ id }) => {
    if (!confirm('Excluir este registro de peso?')) return;
    state.pesos = state.pesos.filter((p) => p.id !== id);
  },

  novaNota: () => formNota(null),
  abrirNota: ({ id }) => formNota(porId(state.notas, id)),
  excluirNota: ({ id }) => {
    if (!confirm('Excluir esta nota?')) return;
    state.notas = state.notas.filter((n) => n.id !== id);
    fecharModal();
  },

  mes: ({ v }) => {
    const [a, m] = ui.mes.split('-').map(Number);
    const d = new Date(a, m - 1 + Number(v), 1);
    ui.mes = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    ui.filtroCat = '';
  },
  filtroCat: ({ v }) => { ui.filtroCat = ui.filtroCat === v ? '' : v; },
  mesIr: ({ v }) => { ui.mes = v; ui.filtroCat = ''; },
  mapaPeriodo: ({ v }) => { ui.mapaPeriodo = v; ui.filtroCat = ''; },
  ajustarGuardado: () => abrirModal('Quanto você já tinha guardado?', `
    <p class="dica">O "Guardado no total" soma tudo o que sobrou (receitas − despesas) desde o primeiro lançamento.
      Se você já tinha dinheiro guardado antes de começar a usar o app, informe aqui para o total ficar certo.</p>
    <label class="campo"><span>Valor guardado antes do app (R$)</span>
      <input type="number" name="saldoInicial" step="0.01" inputmode="decimal" value="${esc(state.config.saldoInicial ?? '')}" placeholder="0,00"></label>`,
  (d) => {
    const saldo = numeroCampo(d.saldoInicial, -1e9, 1e9);
    if (saldo === null) throw new Error('Informe um valor em reais, ex.: 1500,00.');
    state.config.saldoInicial = saldo;
    toast('Total guardado atualizado.');
  }),
  novaTransacao: () => formTransacao(null),
  editarTransacao: ({ id }) => formTransacao(porId(state.transacoes, id)),
  excluirTransacao: ({ id }) => {
    if (!confirm('Excluir este lançamento?')) return;
    state.transacoes = state.transacoes.filter((t) => t.id !== id);
    fecharModal();
  },
  importarExtrato: () => formImportar(),

  // O backup não leva as chaves do banco (Client Secret): se o arquivo vazar, ninguém acessa suas contas
  exportar: () => {
    const copia = structuredClone(state);
    if (copia.integracoes?.pluggy) copia.integracoes.pluggy = { ...copia.integracoes.pluggy, clientSecret: '' };
    baixarArquivo(`tetis-backup-${hoje()}.json`, JSON.stringify(copia, null, 1), 'application/json');
  },
  // ---------- Open Finance (openfinance.js) ----------
  conectarBanco: () => formConectarBanco(),
  alternarValores: () => {
    ui.ocultarValores = !ui.ocultarValores;
    try { localStorage.setItem('tetis-ocultar', ui.ocultarValores ? '1' : '0'); } catch (e) { /* sem armazenamento: vale só até fechar */ }
    toast(ui.ocultarValores ? 'Valores escondidos.' : 'Valores visíveis.');
  },
  sincronizarBancos: () => { sincronizarBancos(); return false; },
  rebuscarHistorico: () => { ui.forcarHistorico = true; sincronizarBancos(); return false; },
  pluggyTestar: () => { testarPluggy(); return false; },
  pluggyWidget: () => { conectarPeloWidget(); return false; },
  pluggyAdicionarItem: () => {
    $('#pluggy-itens').insertAdjacentHTML('beforeend', blocoItemId());
    $('#pluggy-itens').lastElementChild.querySelector('input').focus();
    return false;
  },
  pluggyRemoverItem: (_, el) => {
    el.closest('.pluggy-item').remove();
    if (!$('#pluggy-itens .pluggy-item')) $('#pluggy-itens').insertAdjacentHTML('beforeend', blocoItemId());
    return false;
  },
  desconectarBancos: () => {
    const vindos = state.transacoes.filter((t) => t.origem === 'openfinance').length;
    if (!confirm(`Desconectar os bancos deste app? ${vindos} lançamentos vindos dos bancos serão apagados deste app. Lançamentos que você criou ou importou de extrato continuam. (Para revogar o acesso de vez, remova também no Meu Pluggy.)`)) return false;
    delete state.integracoes.pluggy;
    state.transacoes = state.transacoes.filter((t) => t.origem !== 'openfinance');
    guardarSegredo('');
    fecharModal();
    salvar();
    render();
    toast('Bancos desconectados.');
    return false;
  },
  limparBancos: () => {
    const n = state.transacoes.filter((t) => t.origem === 'openfinance').length;
    if (!n) { toast('Não há lançamentos vindos do banco.'); return false; }
    if (!confirm(`Apagar ${n} lançamentos vindos do banco? Os lançamentos criados à mão e importados de extrato continuam.`)) return false;
    state.transacoes = state.transacoes.filter((t) => t.origem !== 'openfinance');
    salvar();
    render();
    toast(`${n} lançamentos do banco apagados.`);
    return false;
  },
  exportarCsv: () => {
    const linhas = [['Data', 'Descrição', 'Categoria', 'Valor'], ...[...state.transacoes].sort((a, b) => a.data.localeCompare(b.data))
      .map((t) => [fmtData(t.data), t.descricao, t.categoria, t.valor.toFixed(2).replace('.', ',')])];
    baixarArquivo(`financas-${hoje()}.csv`, '﻿' + linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n'), 'text/csv');
  },
  restaurar: () => abrirModal('Restaurar backup', `
    <p class="dica"><b>Atenção:</b> tudo o que está na sua conta (neste e nos outros aparelhos) será substituído pelo que está no arquivo.
      O que não estiver no backup será apagado. Se não tiver certeza, faça antes um backup dos dados atuais.</p>
    <label class="campo"><span>Arquivo de backup (.json)</span><input type="file" name="arquivo" accept=".json,application/json" required></label>`,
  async (d) => {
    if (!d.arquivo?.size) throw new Error('Escolha o arquivo de backup.');
    if (d.arquivo.size > 20e6) throw new Error('Arquivo grande demais para ser um backup do Tétis (máx. 20 MB).');
    let dados;
    try { dados = JSON.parse(await lerTexto(d.arquivo)); } catch { throw new Error('Arquivo de backup inválido.'); }
    const pareceBackup = dados && typeof dados === 'object' && ['pesos', 'fichas', 'sessoes', 'notas', 'transacoes'].every((k) => dados[k] === undefined || Array.isArray(dados[k]))
      && ['pesos', 'fichas', 'notas', 'transacoes'].some((k) => Array.isArray(dados[k]));
    if (!pareceBackup) throw new Error('Este arquivo não é um backup do Tétis.');
    // Mantém a conexão com o banco que já existe (o backup não leva o Client Secret)
    const integracoes = state.integracoes;
    state = normalizarEstado(dados);
    if (integracoes?.pluggy) state.integracoes = integracoes;
    if (state.sessaoAtual?.data !== hoje()) state.sessaoAtual = null; // treino "em andamento" de um backup antigo não volta
    toast('Backup restaurado.');
  }, { ok: 'Restaurar' }),
  removerFoto: () => {
    if (!confirm('Remover sua foto de perfil?')) return false;
    state.perfil.foto = '';
  },
  modoLogin: ({ v }) => { ui.modoLogin = v; },
  entrarGoogle: () => { fazerLogin(() => window.Nuvem.google()); return false; },
  esqueciSenha: () => {
    const email = $('.login-card [name=email]')?.value.trim();
    if (!email) return toast('Digite seu e-mail primeiro.');
    ui.emailLogin = email;
    window.Nuvem?.recuperarSenha(email)
      .then(() => toast('Se existir uma conta com esse e-mail, enviamos o link para redefinir a senha.'))
      .catch((e) => toast(msgErroLogin(e)));
    return false;
  },
  sair: () => {
    if (!confirm('Sair da sua conta neste aparelho?')) return false;
    enviarAlteracoes().finally(() => window.Nuvem.sair());
    return false;
  },
  recarregar: () => { location.reload(); return false; },
  apagarTudo: () => {
    if (!confirm(conta.usuario ? 'Apagar TODOS os seus dados (neste aparelho e na nuvem)? Isso não pode ser desfeito.' : 'Apagar TODOS os dados deste aparelho? Isso não pode ser desfeito.')) return;
    if (!confirm('Tem certeza mesmo? Baixe um backup antes, se quiser.')) return;
    state = estadoInicial();
    toast('Dados apagados.');
  },
  instalar: async () => {
    if (!instalarEvento) return;
    instalarEvento.prompt();
    await instalarEvento.userChoice;
    instalarEvento = null;
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  // Ícones que tremem ao serem tocados (ex.: cronômetro do descanso) — só onde a tela não é redesenhada
  if (el.dataset.act === 'descanso') {
    const icone = el.querySelector('.ic');
    icone?.classList.remove('tremor');
    void icone?.getBoundingClientRect();
    icone?.classList.add('tremor');
  }
  const r = acoes[el.dataset.act]?.(el.dataset, el);
  if (r === false || r instanceof Promise) return;
  if (!modalAberto()) { salvar(); render(); }
});

const formularios = {
  peso: (d, form) => {
    const peso = numeroCampo(d.peso, 20, 400);
    if (!peso) throw new Error('Informe um peso entre 20 e 400 kg.');
    if (!dataValida(d.data) || d.data > hoje()) throw new Error('Escolha uma data válida (até hoje).');
    const existente = state.pesos.find((p) => p.data === d.data);
    if (existente) existente.peso = peso;
    else state.pesos.push({ id: uid(), data: d.data, peso });
    toast(existente ? 'Peso do dia atualizado.' : 'Peso registrado.');
    form.reset();
  },
  perfil: (d) => {
    const altura = numeroCampo(d.altura, 100, 250), metaPeso = numeroCampo(d.metaPeso, 20, 400);
    if (altura === null) throw new Error('Altura em centímetros, entre 100 e 250 (ex.: 175).');
    if (metaPeso === null) throw new Error('Meta de peso entre 20 e 400 kg.');
    Object.assign(state.config, { altura, metaPeso });
    const nome = d.nome.trim();
    if (nome !== nomeExibicao()) {
      state.perfil.nome = nome;
      // Mantém o nome da conta do Firebase igual (aparece no e-mail de redefinir senha)
      if (conta.usuario && nome) window.Nuvem?.atualizarNome?.(nome).catch(() => {});
    }
    toast('Perfil salvo.');
  },
  orcamentos: (d) => {
    const errado = Object.entries(d).find(([, v]) => numeroCampo(v, 0.01, 1e8) === null);
    if (errado) throw new Error(`Limite inválido em ${errado[0]}: use um valor maior que zero, ou deixe em branco para não ter limite.`);
    state.config.orcamentos = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, numeroCampo(v, 0.01, 1e8)]).filter(([, v]) => v > 0));
    toast('Orçamentos salvos.');
  },
};

document.addEventListener('submit', (e) => {
  const nome = e.target.dataset.form;
  if (!nome) return;
  e.preventDefault();
  const dados = Object.fromEntries(new FormData(e.target));
  if (nome === 'login') {
    ui.emailLogin = dados.email;
    fazerLogin(() => (ui.modoLogin === 'criar'
      ? window.Nuvem.criarConta(dados.nome?.trim(), dados.email, dados.senha)
      : window.Nuvem.entrar(dados.email, dados.senha)));
    return;
  }
  try {
    formularios[nome](dados, e.target);
  } catch (err) {
    toast(err.message);
    return;
  }
  salvar();
  render();
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'busca-notas') {
    ui.buscaNotas = el.value;
    $('#lista-notas').innerHTML = listaNotas();
    return;
  }
  if (el.dataset.sess != null && state.sessaoAtual) {
    const s = state.sessaoAtual;
    if (el.dataset.sess === 'obs') s.obs = el.value;
    else {
      const it = s.itens[+el.dataset.sess];
      const campo = el.dataset.campo;
      if (campo === 'feito') {
        // Atualiza só a linha e a barra de progresso, sem redesenhar a tela
        it.feito = el.checked;
        el.closest('.ex-linha').classList.toggle('feito', it.feito);
        $('#sessao-contagem').textContent = textoProgressoSessao();
        $('#sessao-progresso').style.width = `${progressoSessao() * 100}%`;
        if (it.feito && navigator.vibrate) navigator.vibrate(12);
      }
      // Enquanto digita, valor inválido (ex.: "3x" pela metade) só não é gravado; o aviso vem ao sair do campo
      if (campo === 'carga') {
        const carga = numeroCampo(el.value, 0, 1000);
        if (carga === null) return;
        it.carga = carga;
      }
      if (campo === 'seriesReps') {
        const sr = seriesReps(el.value);
        if (sr === null) return;
        Object.assign(it, sr);
      }
    }
    salvar();
  }
});

// Ao sair do campo da sessão com um valor inválido: avisa e volta para o último valor válido
document.addEventListener('change', (e) => {
  const el = e.target;
  const it = el.dataset.sess != null && el.dataset.sess !== 'obs' ? state.sessaoAtual?.itens[+el.dataset.sess] : null;
  if (!it) return;
  if (el.dataset.campo === 'carga' && numeroCampo(el.value, 0, 1000) === null) {
    toast('Carga inválida: use um número em kg (ex.: 12,5).');
    el.value = it.carga;
  }
  if (el.dataset.campo === 'seriesReps' && seriesReps(el.value) === null) {
    toast('Use o formato séries x repetições, ex.: 3x12.');
    el.value = it.series && it.reps ? `${it.series}x${it.reps}` : '';
  }
});

// Dois toques na foto do post = curtir (como no Instagram)
document.addEventListener('dblclick', (e) => {
  const foto = e.target.closest('.post-foto');
  if (!foto) return;
  const p = social.feed.find((x) => x.id === foto.dataset.post);
  if (p && !(p.curtidas || []).includes(conta.usuario.uid)) acoes.curtir({ id: p.id });
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'sel-exercicio') { ui.exercicio = e.target.value; render(); }
  // Prévia da foto do post
  if (e.target.id === 'post-foto' && e.target.files[0]) {
    const caixa = $('#post-preview');
    const antiga = caixa.dataset.url;
    if (antiga) URL.revokeObjectURL(antiga);
    caixa.dataset.url = URL.createObjectURL(e.target.files[0]);
    caixa.style.backgroundImage = `url("${caixa.dataset.url}")`;
    caixa.classList.add('com-foto');
  }
  if (e.target.id === 'input-foto' && e.target.files[0]) {
    try {
      state.perfil.foto = await prepararFoto(e.target.files[0]);
      salvar();
      render();
      toast('Foto atualizada.');
    } catch (err) {
      toast('Não foi possível usar essa imagem. Tente outra (JPG ou PNG).');
    }
  }
});

// =====================================================================
// PWA: instalação e funcionamento offline
// =====================================================================
let instalarEvento = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  instalarEvento = e;
  const card = $('#card-instalar');
  if (card) card.hidden = false;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
// Pede ao navegador para não apagar os dados em caso de pouco espaço
navigator.storage?.persist?.().catch(() => {});

window.addEventListener('hashchange', () => {
  // Voltar no navegador com um modal aberto: o modal era de outra tela, então fecha (não grava nada)
  if (modalAberto() && modalRota !== location.hash) fecharModal();
  window.scrollTo({ top: 0, behavior: 'instant' });
  render(true);
});
render(true);

// Contas ativadas: carrega o Firebase (módulo separado, só quando configurado)
if (NUVEM_ATIVA) {
  import('./nuvem.js').catch(() => {
    conta.erro = 'Não foi possível conectar. Verifique a internet.';
    render();
  });
  // Se o Firebase não responder, mostra o aviso em vez de ficar carregando para sempre
  setTimeout(() => { if (!conta.verificada) { conta.erro = 'A conexão está demorando… verifique a internet.'; render(); } }, 10000);
}
