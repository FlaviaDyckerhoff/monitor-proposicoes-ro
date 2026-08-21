const FICHA_URL = process.env.FICHA_URL || 'https://doe.monitorlegislativo.com.br/ficha';

function fichaEmailButtonHtml() {
  return '<div style="background:#eef6ff;border:1px solid #c7ddf2;border-radius:6px;padding:11px 13px;margin:12px 0;color:#173d63;font-size:13px;line-height:1.45">' +
    '<strong>Ficha</strong><br>' +
    '<span>Cole o link oficial de uma proposição para criar ficha e acelerar a revisão/cadastro.</span><br>' +
    '<a href="' + FICHA_URL + '" style="display:inline-block;background:#0f3d5c;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-weight:bold;margin-top:8px">Criar ficha</a>' +
    '</div>';
}

const fs = require('fs');
const nodemailer = require('nodemailer');
let promoverInteresseClienteProposicao = (_item, atuais) => Array.isArray(atuais) ? atuais : [];
try {
  try {
    ({ promoverInteresseClienteProposicao } = require('./client_interest_matcher_js'));
  } catch (_localErr) {
    ({ promoverInteresseClienteProposicao } = require('../../agents/pautas/client_interest_matcher_js'));
  }
} catch (err) {
  console.warn('⚠️ Matcher cliente/palavra comum indisponível; usando destaque legado: ' + err.message);
}

function mlClientInterestContext() {
  return {
    uf: typeof CLIENT_INTEREST_UF !== 'undefined' ? CLIENT_INTEREST_UF : (process.env.CLIENT_INTEREST_UF || process.env.UF || ''),
    municipio: typeof CLIENT_INTEREST_MUNICIPIO !== 'undefined' ? CLIENT_INTEREST_MUNICIPIO : (process.env.CLIENT_INTEREST_MUNICIPIO || process.env.MUNICIPIO || ''),
    casa: typeof CASA_RADAR03 !== 'undefined' ? CASA_RADAR03 : (process.env.CASA_RADAR03 || process.env.CASA || ''),
  };
}


const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const CONTROLE03_FORCE_LATEST = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'ALERO';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

const API_BASE = 'https://sapl.al.ro.leg.br/api';
const SITE_BASE = 'https://sapl.al.ro.leg.br';
function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [] };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function buscarPagina(ano, pagina) {
  const url = `${API_BASE}/materia/materialegislativa/?ano=${ano}&page=${pagina}&page_size=100`;
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!response.ok) {
    console.error(`❌ Erro na página ${pagina}: ${response.status}`);
    return null;
  }
  return response.json();
}

async function buscarProposicoes() {
  const ano = new Date().getFullYear();
  console.log(`🔍 Buscando proposições de ${ano}...`);

  // 1ª chamada: sonda na página 1 para descobrir total de páginas
  // (ordering é ignorado pelo SAPL — a página 1 traz as mais antigas)
  const sonda = await buscarPagina(ano, 1);
  if (!sonda) return [];

  const totalEntries = sonda.pagination?.total_entries || sonda.count || 0;
  const totalPages = sonda.pagination?.total_pages || Math.ceil(totalEntries / 100) || 1;
  console.log(`📊 Total: ${totalEntries} proposições, ${totalPages} páginas`);

  // O SAPL/ALERO não mantém ordenação cronológica confiável entre tipos de matéria.
  // Buscar só as últimas páginas deixa PLs recentes para trás quando entram vetos/requerimentos.
  const paginas = Array.from({ length: totalPages }, (_, i) => i + 1);

  const resultados = [];
  for (const pagina of paginas) {
    console.log(`📄 Buscando página ${pagina}/${totalPages}...`);
    const json = await buscarPagina(ano, pagina);
    if (json?.results) resultados.push(...json.results);
  }

  console.log(`📦 ${resultados.length} proposições recebidas`);
  return resultados;
}

function normalizarData(str) {
  if (!str) return '-';
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const [y, m, d] = str.substring(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  return str;
}

function dataIso(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
  return '';
}

// "Indicação nº 15315 de 2026" → "INDICAÇÃO"
function extrairTipo(str) {
  if (!str) return 'OUTRO';
  const match = str.match(/^(.+?)\s+n[ºo°]/i);
  return match ? match[1].trim().toUpperCase() : str.split(' ')[0].toUpperCase();
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra'
];

const CLIENTES_INATIVOS_NAO_DESTACAR = [
  'CVC', 'DIAGEO', 'Femsa', 'Lalamove', 'lalamove',
  'Maersk', 'Matrix', 'Rei do Pitaco', 'Sanofi', 'Syngenta',
  'Ypê', 'Ype', 'Braskem', 'Vital', 'Natural Energia',
  'Pacto Pela Fome', 'TikTok', 'Norte Energia', 'Mac Jee',
  'Solar', 'Grupo Simões', 'Grupo Simoes'
];

function clienteAtivoParaDestaque(nome) {
  return !CLIENTES_INATIVOS_NAO_DESTACAR.some(inativo => inativo.toLowerCase() === String(nome || '').toLowerCase());
}

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    if (!clienteAtivoParaDestaque(nome)) continue;
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return promoverInteresseClienteProposicao(p, achados, mlClientInterestContext());
}

const KEYWORDS_CLIENTES = [
  {
    cliente: '4Um/Opportunity',
    termosDiretos: [
      'BR-364', 'BR 364', 'BR364', 'Rota Agro Norte', 'lote CN 5', 'lote CN5',
      'concessão de estrada', 'concessão de estradas', 'concessão rodoviária',
      'concessao de estrada', 'concessao de estradas', 'concessao rodoviaria',
      'pedágio', 'pedagio', 'cancela', 'free flow', 'freeflow'
    ],
    municipiosRota: [
      'Porto Velho', 'Candeias do Jamari', 'Itapuã do Oeste', 'Itapua do Oeste',
      'Ariquemes', 'Jaru', 'Ouro Preto do Oeste', 'Presidente Médici',
      'Presidente Medici', 'Cacoal', 'Pimenta Bueno', 'Chupinguaia', 'Vilhena'
    ],
    termosRodovia: [
      'rodovia', 'rodovias', 'estrada', 'estradas', 'DER/RO', 'Departamento Estadual de Estradas',
      'pavimentação', 'pavimentacao',
      'recuperação', 'recuperacao', 'manutenção', 'manutencao', 'ponte', 'bueiro',
      'tapa-buracos', 'tapa buracos', 'patrolamento', 'encascalhamento', 'RO-', 'BR-'
    ]
  }
];

function normalizarTextoBusca(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function contemTermo(textoNormalizado, termo) {
  return textoNormalizado.includes(normalizarTextoBusca(termo));
}

function clientesPorKeyword(p) {
  const textoOriginal = [p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const texto = normalizarTextoBusca(textoOriginal);
  const achados = [];

  for (const regra of KEYWORDS_CLIENTES) {
    const termos = [];
    for (const termo of regra.termosDiretos) {
      if (contemTermo(texto, termo)) termos.push(termo);
    }

    const temRodovia = regra.termosRodovia.some(termo => contemTermo(texto, termo));
    if (temRodovia) {
      for (const municipio of regra.municipiosRota) {
        if (contemTermo(texto, municipio)) termos.push(municipio);
      }
    }

    if (termos.length) {
      achados.push({ cliente: regra.cliente, termos: Array.from(new Set(termos)) });
    }
  }

  return achados;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    const keywordHits = clientesPorKeyword(p);
    for (const hit of keywordHits) {
      if (!clientes.some(c => c.toLowerCase() === hit.cliente.toLowerCase())) clientes.push(hit.cliente);
    }
    p.clientesCitados = clientes;
    p.keywordHits = keywordHits;
  }
}

function renderizarEmentaEmail(p) {
  const destaques = [];
  if (p.clientesCitados?.length) {
    destaques.push(`
      <div style="margin-top:8px;padding:6px 8px;background:#fff1f2;border-left:3px solid #fb7185;color:#991b1b;font-weight:800">
        <strong>🆘 CLIENTE CITADO:</strong> ${escapeHtml(p.clientesCitados.join(', '))}
      </div>`);
  }
  if (p.keywordHits?.length) {
    const detalhes = p.keywordHits
      .map(hit => `${hit.cliente}: ${hit.termos.join(', ')}`)
      .join(' | ');
    destaques.push(`
      <div style="margin-top:6px;padding:6px 8px;background:#fff4e5;border-left:3px solid #f29900;color:#7a4b00">
        <strong>Palavra-chave:</strong> ${escapeHtml(detalhes)}
      </div>`);
  }

  return `
    <div>${renderizarEmentaCliente(p)}</div>
    ${destaques.join('')}
  `;
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .filter(clienteAtivoParaDestaque)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function clientesCitadosResumoEmail(novas) {
  const nomes = [];
  for (const p of novas || []) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      if (nome && !nomes.some(n => n.toLowerCase() === String(nome).toLowerCase())) nomes.push(String(nome));
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 Cliente citado: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}


function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;

  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;

  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}


function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : ''))
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PROJETO LEI': 'PL', 'PROJETO DE LEI ORDINARIA': 'PL', 'PLO': 'PL', 'PL': 'PL', 'PL - PROJETO DE LEI': 'PL', 'PL PROJETO DE LEI': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC', 'PLC - PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC', 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC', 'PEC PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'PROJETO DE INDICACAO': 'PIL', 'PIL': 'PIL', 'PIL - PROJETO DE INDICACAO': 'PIL', 'PIL PROJETO DE INDICACAO': 'PIL',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = rec.itens && rec.itens.length ? rec.itens : [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item && !(det.id || det.link)) {
          item = casa.items.find(i => radar03TipoControle(i?.tipo || '') === det.tipo);
        }
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data, merge_casas: [CASA_RADAR03] }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03AgruparNovidades(novas).map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}


function radar03SemNovidadeUrl() {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    situacao: 'sem_novidade',
    fonte: 'monitor-proposicoes',
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function renderRadar03SemNovidadeEmailButton() {
  return '\n    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;margin:14px 0;color:#334155;font-size:13px">\n      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Sem novidades</div>\n      <div style="margin-bottom:9px;color:#475569">' + radar03Escape(CASA_RADAR03) + ' · fonte vista sem proposição nova nesta rodada</div>\n      <a href="' + radar03Escape(radar03SemNovidadeUrl()) + '" style="display:inline-block;background:#475569;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Marcar sem novidade na 03</a>\n      <span style="font-size:12px;color:#64748b;margin-left:8px">abre a 03 pronta para fechar o dia</span>\n    </div>\n  ';
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return renderRadar03SemNovidadeEmailButton();
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  if (CONTROLE03_FORCE_LATEST) {
    console.log('📌 Modo Controle 03: email de novidades não enviado.');
    return;
  }

  anotarClientesCitados(novas);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    if (!porTipo[p.tipo]) porTipo[p.tipo] = [];
    porTipo[p.tipo].push(p);
  });

  const blocos = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = `
      <tr>
        <td colspan="3" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;
          color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">
          ${tipo} — ${porTipo[tipo].length} proposição(ões)
        </td>
      </tr>`;
    const rows = porTipo[tipo].map(p => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;font-size:13px">
          <a href="${p.link}" style="color:#1a3a5c;font-weight:bold;text-decoration:none">
            ${escapeHtml(p.numero)}/${escapeHtml(p.ano)}
          </a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#888;font-size:12px;white-space:nowrap">
          ${escapeHtml(p.data)}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">
          ${renderizarEmentaEmail(p)}
        </td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:860px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ Assembleia Legislativa de Rondônia — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;margin-top:0">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left;white-space:nowrap">Número/Ano</th>
            <th style="padding:10px;text-align:left;white-space:nowrap">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${blocos}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Pesquisa completa: <a href="https://sapl.al.ro.leg.br/materia/pesquisar-materia">sapl.al.ro.leg.br</a>
      </p>
    </div>
  `;

  if (process.env.DRY_RUN_EMAIL === 'true') {
    console.log(`🧪 DRY_RUN_EMAIL=true — email não enviado. Proposições: ${novas.length}`);
    console.log(novas.map(p => `${p.tipo} ${p.numero}/${p.ano} — ${renderizarEmentaCliente(p)}`).join('\n'));
    return;
  }

  await transporter.sendMail({
    from: `"Monitor Rondônia" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: assuntoEmailClienteCitado(novas, `🏛️ Rondônia: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`),
    html: fichaEmailButtonHtml() + html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

(async () => {
  console.log('🚀 Iniciando monitor ALE-RO...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);
  const dataCorteInicial = estado.ignorar_anteriores_a || `${new Date().getFullYear()}-01-01`;

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada.');
    process.exit(0);
  }

  const novas = proposicoesRaw
    .filter(p => !idsVistos.has(String(p.id)))
    .filter(p => dataIso(p.data_apresentacao) >= dataCorteInicial)
    .map(p => ({
      id: String(p.id),
      tipo: extrairTipo(p.__str__),
      numero: String(p.numero),
      ano: String(p.ano),
      data: normalizarData(p.data_apresentacao),
      ementa: (p.ementa || '-'),
      link: `${SITE_BASE}${p.link_detail_backend}`,
    }));

  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return Number(b.numero) - Number(a.numero);
    });

    await sincronizarRadar03(novas);
    await enviarEmail(novas);

    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
