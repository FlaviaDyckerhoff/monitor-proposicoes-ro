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

  // Busca as últimas 2 páginas — onde ficam as proposições mais recentes
  const paginas = totalPages > 1 ? [totalPages - 1, totalPages] : [1];

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

async function enviarEmail(novas) {
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
            ${p.numero}/${p.ano}
          </a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#888;font-size:12px;white-space:nowrap">
          ${p.data}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">
          ${p.ementa}
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

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada.');
    process.exit(0);
  }

  const novas = proposicoesRaw
    .filter(p => !idsVistos.has(String(p.id)))
    .map(p => ({
      id: String(p.id),
      tipo: extrairTipo(p.__str__),
      numero: String(p.numero),
      ano: String(p.ano),
      data: normalizarData(p.data_apresentacao),
      ementa: (p.ementa || '-').substring(0, 250),
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
