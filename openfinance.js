'use strict';

// =====================================================================
// Open Finance pelo Meu Pluggy (plano pessoal gratuito).
// Cada pessoa usa a PRÓPRIA conta Pluggy: Client ID/Secret e Item IDs ficam só nos dados dela
// (Firestore, protegido pelas regras) e o app fala direto com a API da Pluggy — sem servidor.
// Usa funções e o estado do app.js, chamadas só na hora do uso.
// =====================================================================

const PLUGGY_API = 'https://api.pluggy.ai';
const pluggyConfig = () => state.integracoes?.pluggy || null;
const pluggyConectado = () => !!(pluggyConfig()?.clientId && pluggySegredo() && pluggyConfig()?.itens?.length);
// Configurado em outro aparelho, mas o Client Secret ainda não foi digitado neste
const pluggyFaltaSegredo = () => !!(pluggyConfig()?.clientId && pluggyConfig()?.itens?.length && !pluggySegredo());

// O Client Secret fica SÓ neste aparelho: não vai para a nuvem nem para o backup. Assim, quem chegar aos dados
// da conta (na nuvem ou num backup) não consegue abrir o banco. Em outro aparelho, é preciso digitar de novo.
const chaveSegredo = () => `tetis-pluggy:${conta.usuario?.uid || 'local'}`;
function guardarSegredo(segredo) {
  try { if (segredo) localStorage.setItem(chaveSegredo(), segredo); else localStorage.removeItem(chaveSegredo()); } catch (e) { /* sem armazenamento */ }
}
function pluggySegredo() {
  const cfg = pluggyConfig();
  // Versões antigas guardavam o secret junto dos dados (e, por isso, na nuvem): passa para o aparelho e apaga de lá
  if (cfg?.clientSecret) {
    guardarSegredo(cfg.clientSecret);
    delete cfg.clientSecret;
    salvar();
  }
  try { return localStorage.getItem(chaveSegredo()) || ''; } catch (e) { return ''; }
}

class ErroPluggy extends Error {}

async function pluggyChamar(caminho, { apiKey, metodo = 'GET', corpo } = {}) {
  let resp;
  try {
    resp = await fetch(PLUGGY_API + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch (e) {
    throw new ErroPluggy('Sem conexão com a Pluggy. Verifique a internet.');
  }
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new ErroPluggy(dados.message || `Erro ${resp.status} na Pluggy.`);
    erro.status = resp.status;
    erro.codigo = dados.codeDescription || dados.code;
    throw erro;
  }
  return dados;
}

async function pluggyAutenticar(clientId, clientSecret) {
  try {
    const { apiKey } = await pluggyChamar('/auth', { metodo: 'POST', corpo: { clientId, clientSecret } });
    return apiKey;
  } catch (e) {
    if (e.status === 400 || e.status === 401 || e.status === 403) throw new ErroPluggy('Client ID ou Client Secret incorretos.');
    throw e;
  }
}

// Transações de uma conta. Tenta a listagem nova (v2, por cursor "next") e cai para a antiga (paginada) se precisar.
async function pluggyTransacoes(apiKey, contaId, de, ate) {
  return unicasPorId(await buscarTransacoes(apiKey, contaId, de, ate));
}
// Se a v2 falha no meio e cai para a listagem antiga, as primeiras páginas vêm duas vezes: fica uma de cada
const unicasPorId = (lista) => { const vistas = new Set(); return lista.filter((t) => t?.id == null || (!vistas.has(t.id) && vistas.add(t.id))); };

async function buscarTransacoes(apiKey, contaId, de, ate) {
  const todas = [];
  // "next" vem como query string com o cursor em "after" (base64): tira só o cursor e manda de volta
  // junto com os mesmos filtros — a v2 recusa parâmetros que não conhece
  const cursor = (next) => {
    const s = String(next).trim();
    const m = s.match(/(?:^|[?&])after=([^&]*)/);
    // Sem "after=": se parece query string, não tem cursor; senão é o próprio cursor (base64 pode terminar em "=")
    // (base64 pode começar com "/": só é caminho se tiver "?" ou "/v2/")
    const pareceQuery = /^\?|^https?:|\?|\/v2\/|&|^(accountId|dateFrom|dateTo|ids|createdAtFrom)=/.test(s);
    const bruto = m ? m[1] : pareceQuery ? '' : s;
    try { return decodeURIComponent(bruto); } catch (e) { return bruto; }
  };
  try {
    const base = `accountId=${contaId}&dateFrom=${de}&dateTo=${ate}`;
    let qs = base;
    const vistas = new Set();
    for (let i = 0; i < 200 && !vistas.has(qs); i++) {
      vistas.add(qs);
      const r = await pluggyChamar(`/v2/transactions?${qs}`, { apiKey });
      todas.push(...(r.results || []));
      const after = r.next ? cursor(r.next) : '';
      if (!after) return todas;
      qs = `${base}&after=${encodeURIComponent(after)}`;
    }
    return todas;
  } catch (e) {
    if (![400, 404, 410].includes(e.status)) throw e;
  }
  // Listagem antiga (paginada): segue enquanto vierem páginas cheias
  for (let page = 1; page <= 200; page++) {
    const r = await pluggyChamar(`/transactions?accountId=${contaId}&from=${de}&to=${ate}&pageSize=500&page=${page}`, { apiKey });
    const lista = r.results || [];
    todas.push(...lista);
    if (r.totalPages ? page >= r.totalPages : lista.length < 500) break;
  }
  return todas;
}

// Busca o histórico em blocos de 3 meses, do mais recente para o mais antigo (até ~2 anos).
// Para quando os blocos antigos vêm vazios: é o limite do que o banco compartilha.
// Blocos que dão erro vão para "erros" (antes eram ignorados em silêncio e o histórico ficava pela metade).
async function pluggyHistorico(apiKey, contaId, diasAtras, erros = []) {
  const todas = [];
  let vaziosSeguidos = 0;
  for (let fim = 0; fim < diasAtras; fim += 90) {
    const ate = diaISO(-fim), de = diaISO(-Math.min(fim + 89, diasAtras));
    let bloco = [];
    try {
      bloco = await pluggyTransacoes(apiKey, contaId, de, ate);
    } catch (e) {
      if (fim === 0) throw e; // erro no bloco mais recente é problema de verdade
      if (e.status === 429) { // muitas chamadas seguidas: espera um pouco e tenta de novo
        await new Promise((r) => setTimeout(r, 2000));
        try { bloco = await pluggyTransacoes(apiKey, contaId, de, ate); } catch (e2) { erros.push(`${fmtData(de)} a ${fmtData(ate)}: ${e2.message}`); }
      } else erros.push(`${fmtData(de)} a ${fmtData(ate)}: ${e.message}`);
    }
    todas.push(...bloco);
    vaziosSeguidos = bloco.length ? 0 : vaziosSeguidos + 1;
    if (fim >= 365 && vaziosSeguidos >= 2) break;
  }
  return todas;
}

// Categorias da Pluggy (vêm em inglês) → categorias do app
const CATEGORIAS_PLUGGY = [
  [/same person|between own|mesma titularidade/i, null], // transferência entre as próprias contas: ignorada
  [/salary|payroll|wage/i, 'Salário'],
  [/interest|dividend|investment income|yield|rendimento/i, 'Rendimentos'],
  [/refund|reversal|cashback|estorno/i, 'Reembolso'],
  [/groceries|supermarket/i, 'Mercado'],
  [/eating out|restaurant|food|delivery|bakery|coffee/i, 'Alimentação'],
  [/taxi|ride|transport|gas station|fuel|parking|toll|airline|airport|car /i, 'Transporte'],
  [/rent|housing|condominium|mortgage/i, 'Moradia'],
  [/electricity|water|gas$|utilities|internet|telecom|mobile|phone/i, 'Contas'],
  [/pharmacy|health|hospital|clinic|lab|dentist|doctor|optician/i, 'Saúde'],
  [/gym|fitness|sport/i, 'Academia'],
  [/streaming|digital service|subscription|software/i, 'Assinaturas'],
  [/leisure|entertainment|ticket|cinema|\bbars?\b|\bgames?\b|tourism|hotel|travel/i, 'Lazer'],
  [/shopping|clothing|electronics|department|marketplace|online/i, 'Compras'],
  [/education|school|university|course|book/i, 'Educação'],
  [/transfer|pix|ted|doc/i, 'Transferências'],
];

function categoriaPluggy(t, valor) {
  const aprendida = state.regras[chaveDesc(t.descricao)];
  if (aprendida) return aprendida;
  for (const [re, cat] of CATEGORIAS_PLUGGY) {
    if (t.categoria && re.test(t.categoria)) {
      if (cat === null) return null;
      const deReceita = CATEGORIAS_RECEITA.includes(cat) && !CATEGORIAS.includes(cat);
      if (valor > 0 ? deReceita || cat === 'Transferências' : !deReceita) return cat;
    }
  }
  return categorizar(t.descricao, valor);
}

// "Pagamento de fatura", "PAGTO FATURA", "PAG FATURA ITAU", "Pgto cartão de crédito", "Credit card payment"…
// Mas não "PAG FATURA CLARO" nem "Pagamento fatura de energia": fatura de conta de consumo é gasto de verdade.
const PAGAMENTO_FATURA = new RegExp([
  String.raw`^\s*(pagamento|pagto|pgto|pag)\s+(de\s+|da\s+)?fatura\s*$`,                               // "Pagamento de fatura" (Nubank)
  String.raw`\b(pagamento|pagto|pgto|pag)\b.{0,15}\bfat(ura)?\b.{0,20}(cart|cr[eé]d|nubank|nu\b|ita[uú]|bradesco|santander|inter\b|c6|caixa|\bbb\b|visa|master|elo\b|amex|hipercard|porto)`,
  String.raw`\b(pagamento|pagto|pgto|pag)\b.{0,15}\bcart[aã]o( de)? cr[eé]d`,                          // "Pgto cartão de crédito"
  String.raw`fatura.{0,10}cart[aã]o`, String.raw`credit card (bill )?payment`, String.raw`card bill payment`, String.raw`credit card bill`,
].join('|'), 'i');
// No extrato do cartão, o pagamento da fatura aparece como um crédito ("Pagamento recebido")
const PAGAMENTO_NO_CARTAO = /\b(pagamento|pagto|pgto)\b.{0,12}\b(recebido|efetuado|realizado)|^pagamento$|payment received/i;

// Guardar na caixinha / aplicar / resgatar só muda o dinheiro de lugar: não é gasto nem receita.
// O valor guardado vem do saldo real dos investimentos (ver saldos em sincronizarBancos).
// "Poupança" sozinha não basta (pode ser o sobrenome de quem recebeu um Pix): precisa vir com depósito/transferência/aplicação.
// Aplicação/resgate e caixinha só contam com contexto de investimento: "Resgate Pet Shop" e "Caixinha Lanches" são lojas.
const INVEST = String.raw`(rdb|cdb|lci|lca|caixinha|poupan[cç]a|tesouro|fundo|investimento|aplica[cç][aã]o)`;
const MOV_GUARDADO_DESC = new RegExp([
  String.raw`^\s*aplica[cç][aã]o\b`, String.raw`aplica[cç][aã]o( autom|.{0,15}${INVEST})`, String.raw`resgate.{0,15}${INVEST}`,
  'dinheiro guardado', 'dinheiro resgatado', String.raw`guardad[oa] na caixinha`, String.raw`\b(para|na|da) caixinha`,
  String.raw`\b(rdb|cdb|lci|lca)\b`, 'tesouro direto',
  String.raw`(dep[oó]sito|transf\w*|movimenta\w*)\s+(para|na|da|a)\s+(a\s+)?poupan[cç]a`, String.raw`dep[oó]sito\s+poupan[cç]a`, String.raw`poupan[cç]a autom`,
].join('|'), 'i');
const MOV_GUARDADO_CAT = /^(investments?|fixed income|variable income|mutual funds?|savings|pension|investimentos?)\b/i;
function ehMovimentoGuardado(descricao = '', categoria = '') {
  // Rendimento é ganho de verdade (vira receita), mesmo vindo da caixinha. "Income" genérico não conta:
  // uma "Aplicação automática" pode vir com categoria Income e continua sendo só dinheiro mudando de lugar
  if (/rendimento|juros|dividend|yield/i.test(descricao) || /interest|dividend|yield|investment income/i.test(categoria || '')) return false;
  return MOV_GUARDADO_DESC.test(descricao) || MOV_GUARDADO_CAT.test(categoria || '');
}

// Converte uma transação da Pluggy para o formato do app (ou null para ignorar)
function converterTransacao(tp, conta) {
  if (tp.status && tp.status !== 'POSTED') return null; // pendentes mudam de id ao confirmar
  const cartao = conta.type === 'CREDIT';
  const bruto = Number(tp.amountInAccountCurrency ?? tp.amount);
  if (!bruto) return null;
  const descricao = (tp.description || tp.descriptionRaw || 'Sem descrição').trim();
  // Pagar a fatura aparece na conta E já existem as compras do cartão: ignora para não contar duas vezes
  if (PAGAMENTO_FATURA.test(`${descricao} ${tp.category || ''}`)) return null;
  if (cartao && bruto < 0 && PAGAMENTO_NO_CARTAO.test(descricao)) return null;
  if (ehMovimentoGuardado(descricao, tp.category)) return null;
  // Cartão: compra vem positiva (vira despesa); conta: débito já vem negativo
  const data = String(tp.date).slice(0, 10);
  if (!dataValida(data)) return null; // data estranha vinda da API não entra
  const valor = Math.round((cartao ? -bruto : bruto) * 100) / 100;
  const categoria = categoriaPluggy({ descricao, categoria: tp.category }, valor);
  if (categoria === null) return null;
  return {
    id: uid(), data, descricao: descricao.slice(0, 200), valor, categoria,
    origem: 'openfinance', conta: conta.marketingName || conta.name || '', chave: `p:${tp.id}`, catPluggy: tp.category || '',
  };
}

// ---------- Sincronização ----------
async function sincronizarBancos({ silencioso = false } = {}) {
  const cfg = pluggyConfig();
  if (!pluggyConectado() || ui.sincronizandoBancos) return;
  ui.sincronizandoBancos = true;
  if (!silencioso) render();
  try {
    const apiKey = await pluggyAutenticar(cfg.clientId, pluggySegredo());
    // Enquanto o histórico completo não foi baixado: busca tudo o que o banco tiver (até ~2 anos, em blocos de 3 meses).
    // Depois: só desde a última sincronização, com folga de 10 dias
    const completo = !cfg.historicoCompleto || ui.forcarHistorico;
    const diasNovos = Math.min(365, Math.ceil((Date.now() - (cfg.ultimaSync || 0)) / 864e5) + 10);
    const buscar = (contaId, erros) => (completo ? pluggyHistorico(apiKey, contaId, 730, erros) : pluggyTransacoes(apiKey, contaId, diaISO(-diasNovos), hoje()));
    const porConta = []; // o que a Pluggy entregou de cada conta (aparece no cartão dos bancos)
    let deuErro = false;
    // Limpeza única (versão 2): tira aplicações/resgates e pagamentos de fatura que versões anteriores importaram como
    // gasto/receita. Roda UMA vez só (a sincronização de rotina busca só os últimos dias, então nada apagado voltaria)
    // e nunca mexe em lançamento que a pessoa corrigiu à mão.
    if ((cfg.limpezaV || 0) < 2) {
      const antes = state.transacoes.length;
      state.transacoes = state.transacoes.filter((t) => !(t.origem === 'openfinance' && !t.catManual
        && (ehMovimentoGuardado(t.descricao, t.catPluggy) || PAGAMENTO_FATURA.test(`${t.descricao} ${t.catPluggy || ''}`))));
      cfg.limpezaV = 2;
      const saiu = antes - state.transacoes.length;
      if (saiu) toast(`${saiu} ${saiu === 1 ? 'lançamento de pagamento de fatura ou aplicação saiu' : 'lançamentos de pagamento de fatura ou aplicação saíram'} dos gastos.`);
    }
    const existentes = new Set(state.transacoes.map((t) => t.chave).filter(Boolean));
    let novos = 0, contas = 0;
    const problemas = [];
    const saldos = { contas: [], investimentos: [] };
    for (const item of cfg.itens) {
      try {
        const info = await pluggyChamar(`/items/${item.id}`, { apiKey });
        item.banco = info.connector?.name || item.banco || '';
        item.status = info.status || '';
        const expirou = ['LOGIN_ERROR', 'OUTDATED', 'WAITING_USER_INPUT'].includes(item.status);
        if (expirou) problemas.push(`${item.banco || 'Banco'}: a autorização expirou — reconecte no Meu Pluggy.`);
        const { results: lista = [] } = await pluggyChamar(`/accounts?itemId=${item.id}`, { apiKey });
        if (!lista.length && !expirou) problemas.push(`${item.banco || item.id.slice(0, 8)}: nenhuma conta (o banco está vinculado ao conector "MeuPluggy" no Dashboard?)`);
        // Itens criados pelo Meu Pluggy podem vir com o nome do conector, não do banco: usa o nome da conta
        if (lista.length && (!item.banco || /meu\s*pluggy/i.test(item.banco))) item.banco = lista[0].marketingName || lista[0].name || item.banco;
        // Saldos reais: conta corrente, poupança, fatura do cartão e investimentos (caixinhas entram aqui)
        for (const c of lista) {
          saldos.contas.push({ nome: c.marketingName || c.name || '', tipo: c.type, subtipo: c.subtype || '', saldo: Number(c.balance) || 0 });
        }
        try {
          const inv = await pluggyChamar(`/investments?itemId=${item.id}`, { apiKey });
          for (const i of inv.results || []) {
            if (i.status && i.status !== 'ACTIVE') continue;
            saldos.investimentos.push({ nome: i.name || i.type || 'Investimento', tipo: i.type || '', saldo: Number(i.balance ?? i.amount) || 0 });
          }
        } catch (e) { /* banco sem investimentos ou sem permissão: segue só com as contas */ }
        for (const conta of lista) {
          contas++;
          const erros = [];
          const lidas = await buscar(conta.id, erros);
          const nomeConta = conta.type === 'CREDIT' ? 'Cartão' : conta.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Conta';
          if (erros.length) { deuErro = true; problemas.push(`${nomeConta}: parte do histórico não veio (${erros[0]})`); }
          const datas = lidas.map((tp) => String(tp.date).slice(0, 10)).sort();
          porConta.push({ nome: `${nomeConta} ${item.banco || ''}`.trim(), qtd: lidas.length, de: datas[0] || '', ate: datas.at(-1) || '' });
          for (const tp of lidas) {
            const t = converterTransacao(tp, conta);
            if (!t || existentes.has(t.chave)) continue;
            existentes.add(t.chave);
            state.transacoes.push(t);
            novos++;
          }
        }
      } catch (e) {
        deuErro = true;
        problemas.push(`${item.banco || item.id.slice(0, 8)}: ${e.status === 404 || e.status === 400 ? 'Item ID não encontrado' : e.message}`);
      }
    }
    ui.forcarHistorico = false;
    // Durante os "await" os dados podem ter sido trocados (chegou versão da nuvem, backup restaurado, bancos desconectados):
    // grava o resultado na configuração ATUAL, e não na que existia quando a sincronização começou
    const destino = pluggyConfig();
    if (!destino) return; // desconectou no meio: não grava nada
    for (const item of cfg.itens) {
      const atual = destino.itens?.find((i) => i.id === item.id);
      if (atual) Object.assign(atual, { banco: item.banco, status: item.status });
    }
    // Se o estado foi trocado no meio, um lançamento pode ter entrado duas vezes: fica um por chave
    const vistas = new Set();
    state.transacoes = state.transacoes.filter((t) => !t.chave || (!vistas.has(t.chave) && vistas.add(t.chave)));
    destino.ultimaSync = Date.now();
    destino.limpezaV = Math.max(destino.limpezaV || 0, cfg.limpezaV || 0);
    if (completo && !deuErro) destino.historicoCompleto = true; // se algo falhou, tenta o histórico inteiro de novo na próxima
    const doBanco = state.transacoes.filter((t) => t.origem === 'openfinance').map((t) => t.data).sort();
    // O resumo por conta só vale para a busca completa (a de rotina pega só os últimos dias)
    const lidoPorConta = completo ? porConta : destino.ultimoResultado?.porConta;
    destino.ultimoResultado = { novos, contas, problemas, quando: Date.now(), desde: doBanco[0] || '', porConta: lidoPorConta || [] };
    if (saldos.contas.length) destino.saldos = { ...saldos, quando: Date.now() };
    salvar();
    if (!silencioso || novos) toast(novos ? `${novos} lançamentos novos dos seus bancos.` : 'Tudo em dia: nenhum lançamento novo.');
    if (problemas.length && !silencioso) toast(problemas[0]);
  } catch (e) {
    if (pluggyConfig()) pluggyConfig().ultimoResultado = { erro: e.message, quando: Date.now() };
    salvar();
    if (!silencioso) toast(e.message);
  } finally {
    ui.sincronizandoBancos = false;
    render();
  }
}

// Ao abrir Finanças, atualiza sozinho se a última sincronização tiver mais de 12 h (a Pluggy atualiza 1x por dia)
function sincronizarSeAntigo() {
  const cfg = pluggyConfig();
  if (pluggyConectado() && navigator.onLine && (!cfg.ultimaSync || Date.now() - cfg.ultimaSync > 12 * 3600e3)) {
    sincronizarBancos({ silencioso: true });
  }
}

// ---------- Telas ----------
function cardBancos() {
  const cfg = pluggyConfig();
  if (pluggyFaltaSegredo()) {
    return `<button class="card link fin-conectar" data-act="conectarBanco">
      <span class="card-icone">${ic('wallet')}</span>
      <span class="item-corpo"><span class="item-titulo">Digite o Client Secret neste aparelho</span>
        <span class="item-sub">Seus bancos já estão configurados. Por segurança, o Client Secret fica só no aparelho onde foi digitado.</span></span>
      <span class="muted">${ic('chevron-right')}</span>
    </button>`;
  }
  if (!pluggyConectado()) {
    return `<button class="card link fin-conectar" data-act="conectarBanco">
      <span class="card-icone">${ic('wallet')}</span>
      <span class="item-corpo"><span class="item-titulo">Conectar meus bancos (Open Finance)</span>
        <span class="item-sub">Puxe os lançamentos das suas contas e cartões automaticamente, de graça, pelo Meu Pluggy</span></span>
      <span class="muted">${ic('chevron-right')}</span>
    </button>`;
  }
  const res = cfg.ultimoResultado;
  const quando = cfg.ultimaSync ? tempoRelativoSimples(cfg.ultimaSync) : 'nunca';
  return `<div class="card fin-bancos">
    <div class="fin-card-topo">
      <span class="card-label">Bancos conectados</span>
      <button class="link-btn" data-act="conectarBanco">Configurar</button>
    </div>
    <div class="fin-bancos-lista">${cfg.itens.map((i) => `<span class="chip ${['LOGIN_ERROR', 'OUTDATED'].includes(i.status) ? 'chip-erro' : ''}">${esc(i.banco || 'Banco ' + i.id.slice(0, 6))}</span>`).join('')}</div>
    ${res?.porConta?.length ? `<div class="fin-bancos-contas">${res.porConta.map((c) => `<span>${esc(c.nome)}: ${c.qtd} ${c.qtd === 1 ? 'lançamento' : 'lançamentos'}${c.de ? ` · de ${fmtData(c.de)} a ${fmtData(c.ate)}` : ''}</span>`).join('')}</div>` : ''}
    <div class="fin-bancos-rodape">
      <span class="item-sub">${res?.erro ? `<span class="neg">${esc(res.erro)}</span>` : `Atualizado ${quando}${res?.desde ? ` · histórico desde ${MESES[+res.desde.slice(5, 7) - 1].toLowerCase()}/${res.desde.slice(2, 4)}` : ''}${res?.problemas?.length ? ` · <span class="neg">${esc(res.problemas[0])}</span>` : ''}`}
        <button class="link-btn fin-rebuscar" data-act="rebuscarHistorico">buscar histórico de novo</button></span>
      <button class="btn pequeno" data-act="sincronizarBancos" ${ui.sincronizandoBancos ? 'disabled' : ''}>${ic('rotate-ccw', ui.sincronizandoBancos ? 'girando' : '')} ${ui.sincronizandoBancos ? 'Sincronizando…' : 'Sincronizar'}</button>
    </div>
  </div>`;
}

function tempoRelativoSimples(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / 1440)} dias`;
}

const blocoItemId = (item = {}) => `<div class="pluggy-item">
  <input name="item_id" value="${esc(item.id)}" placeholder="Item ID (ex.: 1a2b3c4d-…)" autocomplete="off" spellcheck="false" aria-label="Item ID">
  <button type="button" class="btn-x" data-act="pluggyRemoverItem" aria-label="Remover banco">${ic('trash-2')}</button>
</div>`;

// ---------- Janela oficial da Pluggy (Pluggy Connect): conecta o banco e devolve o Item ID ----------
const PLUGGY_CONNECT_JS = 'https://cdn.pluggy.ai/pluggy-connect/v2.10.0/pluggy-connect.js';
const CONECTOR_MEU_PLUGGY = 200;

function carregarPluggyConnect() {
  if (window.PluggyConnect) return Promise.resolve();
  return new Promise((ok, erro) => {
    const s = Object.assign(document.createElement('script'), { src: PLUGGY_CONNECT_JS, onload: ok });
    s.onerror = () => erro(new ErroPluggy('Não foi possível abrir a janela da Pluggy. Verifique a internet.'));
    document.head.append(s);
  });
}

// O que está digitado no formulário (para não perder ao abrir a janela da Pluggy)
function rascunhoPluggy() {
  return {
    clientId: $('#modal [name=clientId]')?.value.trim() || '',
    clientSecret: $('#modal [name=clientSecret]')?.value.trim() || '',
    itens: [...document.querySelectorAll('#modal [name=item_id]')].map((i) => i.value.trim()).filter(Boolean).map((id) => ({ id })),
  };
}

async function conectarPeloWidget() {
  const r = rascunhoPluggy();
  const caixa = $('#pluggy-resultado');
  if (!r.clientId || !r.clientSecret) { caixa.innerHTML = '<p class="neg">Preencha o Client ID e o Client Secret primeiro.</p>'; return; }
  caixa.innerHTML = '<p class="muted">Abrindo a janela da Pluggy…</p>';
  let token;
  try {
    const apiKey = await pluggyAutenticar(r.clientId, r.clientSecret);
    ({ accessToken: token } = await pluggyChamar('/connect_token', { apiKey, metodo: 'POST', corpo: { clientUserId: conta.usuario?.uid || 'tetis' } }));
    await carregarPluggyConnect();
  } catch (e) {
    caixa.innerHTML = `<p class="neg">${esc(e.message)}</p>`;
    return;
  }
  // O modal do app fica por cima de tudo: fecha antes e reabre depois, com o que já estava digitado
  ui.pluggyRascunho = r;
  fecharModal();
  const reabrir = (mensagem) => setTimeout(() => { ui.pluggyMensagem = mensagem; formConectarBanco(); }, 250);
  let terminou = false;
  const widget = new window.PluggyConnect({
    connectToken: token,
    connectorIds: [CONECTOR_MEU_PLUGGY],
    language: 'pt',
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    onSuccess: ({ item }) => {
      terminou = true;
      const nome = /meu\s*pluggy/i.test(item.connector?.name || '') ? '' : item.connector?.name || '';
      if (!ui.pluggyRascunho.itens.some((i) => i.id === item.id)) ui.pluggyRascunho.itens.push({ id: item.id, banco: nome });
      reabrir(`<p class="pos">Banco conectado${nome ? `: ${esc(nome)}` : ''}! O Item ID já foi preenchido — toque em "Salvar e sincronizar".</p>`);
    },
    onError: (erro) => {
      terminou = true;
      reabrir(`<p class="neg">A conexão não foi concluída${erro?.message ? `: ${esc(erro.message)}` : ''}. Tente de novo.</p>`);
    },
    onClose: () => { if (!terminou) reabrir(''); },
  });
  widget.init();
}

function formConectarBanco() {
  // Ao voltar da janela da Pluggy, usa o que estava digitado (e o Item ID novo)
  const cfg = ui.pluggyRascunho ? { ...(pluggyConfig() || {}), ...ui.pluggyRascunho } : (pluggyConfig() || {});
  const mensagem = ui.pluggyMensagem || '';
  ui.pluggyRascunho = null;
  ui.pluggyMensagem = '';
  abrirModal('Conectar bancos (Open Finance)', `
    <details class="info pluggy-passos" ${cfg.clientId ? '' : 'open'}>
      <summary>Passo a passo (uns 10 minutos, uma vez só)</summary>
      <ol>
        <li>Crie sua conta grátis em <b>meu.pluggy.ai</b> e conecte seus bancos e cartões (até 5). Você autoriza no app do próprio banco.</li>
        <li>Crie uma conta em <b>dashboard.pluggy.ai</b> (pode ser o mesmo e-mail) e crie <b>uma aplicação</b>.
          O <b>Client Secret aparece só na criação</b> — copie na hora.</li>
        <li>Abra a aplicação, copie o <b>Client ID</b> e cole aqui embaixo junto com o Client Secret.</li>
        <li>Toque em <b>"Conectar banco pelo Meu Pluggy"</b>, entre com a sua conta do Meu Pluggy na janela que abrir e escolha o banco.
          O Item ID é preenchido sozinho. Repita para cada banco.</li>
      </ol>
      <p>É o plano pessoal gratuito da Pluggy: só funciona com contas <b>do seu CPF</b>. Cada pessoa do app usa a própria conta.</p>
    </details>
    <label class="campo"><span>Client ID</span><input name="clientId" required autocomplete="off" spellcheck="false" value="${esc(cfg.clientId)}"></label>
    <label class="campo"><span>Client Secret</span><input name="clientSecret" type="password" required autocomplete="off" value="${esc(cfg.clientSecret || pluggySegredo())}"></label>
    <div class="linha-titulo"><span class="campo-rotulo">Bancos</span></div>
    <button type="button" class="btn primario bloco" data-act="pluggyWidget" style="margin:8px 0 10px">${ic('plus')} Conectar banco pelo Meu Pluggy</button>
    <div id="pluggy-itens" class="pluggy-itens">${(cfg.itens?.length ? cfg.itens : [{}]).map(blocoItemId).join('')}</div>
    <button type="button" class="link-btn" data-act="pluggyAdicionarItem" style="font-size:13px">ou colar outro Item ID manualmente</button>
    <div class="acoes" style="margin-top:10px"><button type="button" class="btn pequeno" data-act="pluggyTestar">Testar conexão</button></div>
    <div id="pluggy-resultado" class="pluggy-resultado">${mensagem}</div>
    <p class="dica" style="margin-top:10px">${ic('check', 'ic-inline')} O Client Secret fica guardado <b>só neste aparelho</b>: não vai para a nuvem nem para o backup.
      Em outro celular ou computador, é só digitar ele de novo.</p>
    ${cfg.clientId ? '<div class="modal-extra"><button type="button" class="btn pequeno perigo" data-act="desconectarBancos">Desconectar bancos</button></div>' : ''}
  `, (d, fd) => {
    const itens = fd.getAll('item_id').map((v) => String(v).trim()).filter(Boolean);
    if (!itens.length) throw new Error('Adicione pelo menos um Item ID.');
    const antigos = Object.fromEntries((cfg.itens || []).map((i) => [i.id, i]));
    state.integracoes = { ...(state.integracoes || {}) };
    const { clientSecret, ...semSegredo } = cfg;
    state.integracoes.pluggy = { ...semSegredo, clientId: d.clientId.trim(), itens: itens.map((id) => antigos[id] || { id }) };
    guardarSegredo(d.clientSecret.trim());
    toast('Bancos salvos. Buscando seus lançamentos…');
    setTimeout(() => sincronizarBancos(), 300);
  }, { ok: 'Salvar e sincronizar' });
}

// Testa as chaves e mostra as contas encontradas, sem salvar nada
async function testarPluggy() {
  const caixa = $('#pluggy-resultado');
  const clientId = $('#modal [name=clientId]').value.trim(), clientSecret = $('#modal [name=clientSecret]').value.trim();
  const itens = [...document.querySelectorAll('#modal [name=item_id]')].map((i) => i.value.trim()).filter(Boolean);
  if (!clientId || !clientSecret) { caixa.innerHTML = '<p class="neg">Preencha o Client ID e o Client Secret.</p>'; return; }
  caixa.innerHTML = '<p class="muted">Testando…</p>';
  try {
    const apiKey = await pluggyAutenticar(clientId, clientSecret);
    if (!itens.length) { caixa.innerHTML = '<p class="pos">Chaves corretas! Agora adicione os Item IDs dos seus bancos.</p>'; return; }
    const linhas = [];
    for (const id of itens) {
      try {
        const info = await pluggyChamar(`/items/${id}`, { apiKey });
        const { results: contas = [] } = await pluggyChamar(`/accounts?itemId=${id}`, { apiKey });
        const nome = info.connector?.name || `Item ${id.slice(0, 8)}`;
        const expirou = ['LOGIN_ERROR', 'OUTDATED', 'WAITING_USER_INPUT'].includes(info.status);
        linhas.push(expirou
          ? `<li class="neg">${esc(nome)}: a autorização expirou — reconecte este banco no Meu Pluggy.</li>`
          : contas.length
            ? `<li class="pos">${esc(nome)}: ${contas.map((c) => esc(c.marketingName || c.name)).join(', ')}</li>`
            : `<li class="neg">${esc(nome)}: nenhuma conta — vincule este banco ao conector "MeuPluggy" no Dashboard.</li>`);
      } catch (e) {
        linhas.push(`<li class="neg">${esc(id.slice(0, 8))}…: ${e.status === 404 || e.status === 400 ? 'Item ID não encontrado' : esc(e.message)}</li>`);
      }
    }
    caixa.innerHTML = `<p>Chaves corretas. Contas encontradas:</p><ul>${linhas.join('')}</ul>`;
  } catch (e) {
    caixa.innerHTML = `<p class="neg">${esc(e.message)}</p>`;
  }
}
