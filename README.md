# 🏛️ Monitor Proposições RO — ALE-RO

Monitora automaticamente a API SAPL da Assembleia Legislativa de Rondônia e envia email quando há proposições novas. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. O GitHub Actions roda o script nos horários configurados
2. O script chama a API pública do SAPL da ALE-RO (`sapl.al.ro.leg.br/api`)
3. Compara as proposições recebidas com as já registradas no `estado.json`
4. Se há proposições novas → envia email com a lista organizada por tipo
5. Salva o estado atualizado no repositório

---

## API utilizada

A ALE-RO usa o **SAPL (Sistema de Apoio ao Processo Legislativo)**, desenvolvido pelo Interlegis. O SAPL expõe uma API REST pública via django-rest-framework, sem autenticação.

```
URL Base:  https://sapl.al.ro.leg.br/api
Endpoint:  GET /materia/materialegislativa/
Parâmetros: ano, page, page_size, ordering=-data_apresentacao

Tipos:     GET /materia/tipomaterialegislativa/
Autores:   GET /materia/autoria/?materia={id}

Docs:      https://sapl.al.ro.leg.br/api/ (browsable API do DRF)
Portal:    https://sapl.al.ro.leg.br/materia/pesquisar-materia
```

---

## Estrutura do repositório

```
monitor-proposicoes-ro/
├── monitor.js                      # Script principal
├── package.json                    # Dependências (só nodemailer)
├── estado.json                     # Estado salvo automaticamente pelo workflow
├── README.md                       # Este arquivo
└── .github/
    └── workflows/
        └── monitor.yml             # Workflow do GitHub Actions
```

---

## Setup — Passo a Passo

### PARTE 1 — Preparar o Gmail

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Certifique-se de que a **Verificação em duas etapas** está ativa.

**1.3** Procure por **"Senhas de app"** (App Passwords) e clique.

**1.4** Digite um nome qualquer (ex: `monitor-alero`) e clique em **Criar**.

**1.5** Copie a senha de **16 letras** gerada — ela só aparece uma vez.

---

### PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) e crie um **New repository**

**2.2** Nome: `monitor-proposicoes-ro` | Visibility: **Private**

---

### PARTE 3 — Upload dos arquivos

**3.1** Faça upload de `monitor.js`, `package.json`, `README.md`

**3.2** Crie o workflow em **Add file → Create new file**, com o caminho:
```
.github/workflows/monitor.yml
```
Cole o conteúdo do `monitor.yml` e faça commit.

---

### PARTE 4 — Configurar os Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail |
| `EMAIL_SENHA` | senha de 16 letras do App Password (sem espaços) |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

---

### PARTE 5 — Testar

**Actions → Monitor Proposições RO → Run workflow → Run workflow**

O **primeiro run** envia email com todas as proposições do ano atual e salva o estado. A partir do segundo run, só envia se houver proposições novas.

---

## Email recebido

```
🏛️ ALE-RO — 3 nova(s) proposição(ões)

INDICAÇÃO — 2 proposição(ões)
  450/2026 | Dep. Fulano     | 27/03/2026 | Indica pavimentação...
  449/2026 | Dep. Ciclano    | 27/03/2026 | Indica iluminação...

PROJETO DE LEI — 1 proposição(ões)
  101/2026 | Dep. Beltrano   | 27/03/2026 | Dispõe sobre...
```

---

## Horários de execução

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00       | 0 11 * * * |
| 12:00       | 0 15 * * * |
| 17:00       | 0 20 * * * |
| 21:00       | 0 0 * * *  |

---

## Resetar o estado

Para forçar o reenvio de todas as proposições:

1. Edite `estado.json` no repositório
2. Substitua o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode o workflow manualmente

---

## Diferenças em relação ao monitor do PR (ALEP)

| | ALEP (PR) | ALE-RO |
|---|---|---|
| Sistema | API proprietária | SAPL / Interlegis |
| Método | POST /proposicao/filtrar | GET /materia/materialegislativa/ |
| Autenticação | Nenhuma | Nenhuma |
| Autores | Campo direto na resposta | Endpoint separado `/materia/autoria/` |
| Paginação | Parâmetro `pagina` | Parâmetro `page` (padrão DRF) |
| Ordenação | Campo `direcao: DESC` | `ordering=-data_apresentacao` |
