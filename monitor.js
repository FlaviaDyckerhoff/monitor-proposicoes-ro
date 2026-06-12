const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
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
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario', 'Boticário', 'Abrasel', 'ANBRASEL',
  'Energisa', 'EnergisaLuz', 'SABESP', 'COMGAS', 'COMGÁS', 'Eletromidia', 'Eletromídia',
  'BRT', 'Regenera', 'Nova Infra', 'Seta', 'SETA', 'AkzoNobel', 'Expedia', 'RTSC',
  'Huawei', 'Carrefour', 'JBS', 'Ajinomoto', 'Vibra', 'Mindlab', 'ABVTEX', 'Neoenergia', 'ENEL',
  '4Um', '4UM', 'Opportunity', 'Oportunity', '4Um Opportunity', '4Um/Opportunity'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
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
      <div style="margin-top:8px;padding:6px 8px;background:#eef6ff;border-left:3px solid #1a73e8;color:#174ea6">
        <strong>Cliente citado:</strong> ${escapeHtml(p.clientesCitados.join(', '))}
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
    <div>${escapeHtml(p.ementa)}</div>
    ${destaques.join('')}
  `;
}

async function enviarEmail(novas) {
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
    console.log(novas.map(p => `${p.tipo} ${p.numero}/${p.ano} — ${p.ementa}`).join('\n'));
    return;
  }

  await transporter.sendMail({
    from: `"Monitor Rondônia" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Rondônia: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
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
