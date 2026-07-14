# Conversation Quality Analyzer

API em Node.js/TypeScript que avalia a qualidade de conversas de atendimento ao
cliente usando um LLM como juiz (*LLM-as-judge*). Ela recebe uma conversa,
aplica pré-processamento determinístico (normalização, mascaramento de PII,
validação de avaliabilidade e truncamento por tokens), avalia com uma única
chamada à OpenAI usando saída estruturada derivada de uma **rubrica YAML
versionada**, agrega as notas de forma determinística e persiste a trilha de
auditoria completa em SQLite.

A rubrica é a única fonte da verdade: o prompt, o JSON Schema da saída
estruturada e a agregação ponderada são todos derivados dela em tempo de
execução — mudar os critérios de avaliação é uma edição de YAML, sem mudança de
código.

## Entregáveis do desafio

Este repositório é o protótipo funcional (Entregável 2). Os entregáveis
escritos estão em `docs/`:

- [`docs/SOLUCAO.md`](docs/SOLUCAO.md) — documento de solução: visão geral,
  fluxo, decisões técnicas, estratégia de prompts/modelos/orquestração,
  comparação entre as duas abordagens arquiteturais, riscos e próximos passos.
- [`docs/USO_DE_IA.md`](docs/USO_DE_IA.md) — registro de como assistentes de IA
  foram usados no desenvolvimento e como as sugestões foram validadas.

## O que a API faz

- **Notas** por dimensão da rubrica (0–5 com âncoras descritivas), cada uma com
  justificativa e evidências literais citadas da conversa (por índice de
  mensagem), ou `insufficient_data` quando não há base para julgar.
- **Nota geral**: média ponderada determinística (dimensões marcadas
  `insufficient_data` saem da conta e os pesos são renormalizados).
- **Flags críticas** (ex.: alucinação, exposição de dados sensíveis) com
  evidência.
- **Resumo executivo** em português.
- **Trilha de auditoria completa**: conversa original + mascarada,
  rubrica@versão, prompt renderizado, resposta bruta do LLM, resultado,
  tokens/custo/latência, status — persistida para toda avaliação (sucesso e
  falha).
- **Observabilidade**: `/metrics` (custo, tokens, latência p50/p95,
  distribuição de notas, contagem de flags) e `/health` (processo + banco).

## Pipeline

```
POST /evaluations
  → adapter (formato externo → canônico)
  → normalização + mascaramento de PII
  → validação de avaliabilidade (→ 422)
  → truncamento (início+fim, índices originais preservados)
  → avaliação LLM em chamada única (saída estruturada da rubrica, retry/backoff)
  → agregação determinística
  → persistência da auditoria (SQLite)
  → resposta estruturada
```

## Requisitos

- Node.js >= 20 (desenvolvido e testado no Node 22)
- Uma chave de API da OpenAI — apenas para rodar localmente e para a demo.
  **A suíte de testes roda sem chave** (usa um cliente LLM mockado).

## Setup

```bash
npm install
cp .env.example .env   # depois preencha OPENAI_API_KEY
```

Variáveis de ambiente (ver `.env.example`):

| Variável                  | Default                  | Descrição                                    |
| ------------------------- | ------------------------ | -------------------------------------------- |
| `OPENAI_API_KEY`          | — (obrigatória)          | Chave de API da OpenAI                       |
| `DEFAULT_MODEL`           | `gpt-4o-mini`            | Modelo padrão de avaliação                   |
| `MAX_CONVERSATION_TOKENS` | `30000`                  | Limite de tokens antes do truncamento        |
| `LLM_MAX_CONCURRENCY`     | `5`                      | Máximo de chamadas LLM simultâneas           |
| `PORT`                    | `3000`                   | Porta HTTP                                   |
| `DB_PATH`                 | `./data/evaluations.db`  | Caminho do arquivo SQLite de auditoria       |
| `LOG_LEVEL`               | `info`                   | Nível de log (pino)                          |

A configuração é validada no boot (*fail-fast*): chave ausente ou valor
inválido derruba o processo com um erro claro.

## Rodando localmente

```bash
npm run dev     # sobe a API em watch mode (tsx), carrega o .env automaticamente
```

O servidor loga `server listening` quando está no ar. Ele só sobe com
`OPENAI_API_KEY` configurada.

## API

| Método e caminho     | Descrição                                                 |
| -------------------- | --------------------------------------------------------- |
| `POST /evaluations`  | Avalia uma conversa e retorna o resultado estruturado     |
| `GET /health`        | Liveness (processo + acesso ao SQLite)                    |
| `GET /metrics`       | Métricas agregadas de todas as avaliações persistidas     |

### Exemplo de requisição

`POST /evaluations` — a `conversation` é o contrato canônico; `options` é
opcional. A requisição abaixo é a sessão de exemplo `S_84b564f9` **resumida às
duas mensagens de abertura**; a resposta a seguir é a saída real dessa sessão,
então os metadados refletem a conversa completa de 24 mensagens.

```bash
curl -s http://localhost:3000/evaluations \
  -H 'content-type: application/json' \
  -d '{
    "conversation": {
      "sessionId": "S_84b564f9",
      "channel": "whatsapp",
      "messages": [
        { "role": "customer",  "content": "Eu sou Pessoa_015" },
        { "role": "attendant", "content": "Olá, Karina! Ótimo saber que você atua em Saúde Corporativa. Qual seu principal objetivo ao buscar uma especialização agora?" }
      ]
    },
    "options": { "rubric": "default@1", "model": "gpt-4o-mini" }
  }'
```

### Exemplo de resposta (saída real de `S_84b564f9`, justificativas resumidas)

```json
{
  "evaluationId": "fc2a0235-95f4-4214-a262-b1ca2cf74f15",
  "dimensions": [
    {
      "dimensionId": "communication",
      "score": 4,
      "justification": "Comunicação clara e objetiva, com tom amigável.",
      "evidence": [
        { "messageIndex": 1, "quote": "Olá, Karina! Ótimo saber que você atua em Saúde Corporativa." }
      ]
    },
    { "dimensionId": "contextual_understanding", "score": 4, "justification": "…", "evidence": [] },
    { "dimensionId": "compliance_accuracy",      "score": 4, "justification": "…", "evidence": [] },
    { "dimensionId": "resolution",               "score": 4, "justification": "…", "evidence": [] }
  ],
  "overallScore": 4,
  "flags": [
    { "flagId": "hallucination", "triggered": false, "justification": "", "evidence": [] }
  ],
  "summary": "Atendimento claro, com boa compreensão do contexto e encaminhamento adequado.",
  "metadata": {
    "evaluationId": "fc2a0235-95f4-4214-a262-b1ca2cf74f15",
    "rubricId": "default",
    "rubricVersion": 1,
    "promptVersion": "v1",
    "model": "gpt-4o-mini",
    "tokensIn": 3668,
    "tokensOut": 669,
    "costUsd": 0.0009516,
    "latencyMs": 11305,
    "truncated": false,
    "createdAt": "2026-07-14T03:24:19.679Z"
  }
}
```

### Respostas de erro

| Status | Quando                                                                  |
| ------ | ----------------------------------------------------------------------- |
| `400`  | Requisição malformada / conversa fora do schema canônico                |
| `404`  | Seletor de rubrica desconhecido (o corpo lista as rubricas disponíveis) |
| `422`  | Conversa não avaliável (falta mensagem de cliente/atendente)            |
| `502`  | LLM falhou após esgotar os retries (a falha ainda é auditada)           |
| `500`  | Erro interno (ex.: falha na escrita da auditoria — sem 200 sem auditoria) |

### Selecionando rubrica e modelo

- `options.rubric` — ex.: `"default"` (versão mais recente) ou `"default@1"`
  (versão pinada). Seletores desconhecidos retornam `404` com a lista de
  rubricas disponíveis.
- `options.model` — ex.: `"gpt-4o-mini"` (default) ou `"gpt-4o"`. Sem valor,
  usa `DEFAULT_MODEL`.

## Rubricas

As rubricas vivem em `rubrics/*.yaml`, validadas no boot (ids únicos, pesos
somando 1.0, âncoras 0–5 completas). Cada uma define `id`, `version`,
`dimensions[]` (id, nome, descrição, peso, âncoras) e `flags[]`. Para mudar os
critérios, edite o YAML e incremente a versão — o prompt, o schema e a
agregação acompanham automaticamente. Avaliações antigas permanecem
interpretáveis porque cada linha de auditoria carrega a rubrica@versão e a
versão de prompt que a produziram.

## Demo

Avalia conversas de `data/examples.json` contra uma API **no ar** (OpenAI
real). Suba o servidor em um terminal e rode a demo em outro:

```bash
npm run dev                                   # terminal 1

npm run demo -- --session S_84b564f9          # terminal 2: uma sessão
npm run demo                                  # todas as conversas
npm run demo -- --session S_84b564f9 --session S_5ee36f40
npm run demo -- --rubric default@1 --model gpt-4o
```

Para cada conversa a demo imprime as notas por dimensão, a nota geral, as
flags disparadas, custo, latência e uso de tokens, além de um resumo da
execução.

Casos de sanidade sugeridos do dataset de exemplo:

- `S_84b564f9` — possível alucinação ("curso mais procurado")
- `S_5ee36f40` — loop / perda de contexto
- `S_213f6505` — coleta de CPF (PII)
- `S_68c0d237` — honestidade sobre professor não encontrado

## Docker

A imagem é multi-stage: o estágio de build compila o TypeScript e o addon
nativo `better-sqlite3`; o estágio de runtime slim reutiliza os módulos
compilados.

```bash
docker build -t conversation-quality-analyzer .

docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=sk-sua-chave \
  conversation-quality-analyzer
```

Para persistir o banco de auditoria entre execuções, monte um volume em
`/app/data`:

```bash
docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=sk-sua-chave \
  -v "$(pwd)/data:/app/data" \
  conversation-quality-analyzer
```

## Testes

```bash
npm test        # roda a suíte completa (vitest) — sem chave de API
```

A suíte cobre o pré-processamento, o subsistema de rubrica, os adapters, a
camada de LLM/orquestrador/agregação e a API de ponta a ponta (com cliente LLM
mockado), incluindo a persistência da auditoria e as métricas.

## Scripts

```bash
npm run dev     # sobe a API em watch mode (tsx), carrega o .env
npm run build   # compila o TypeScript para dist/
npm start       # roda o build compilado
npm test        # roda a suíte de testes (sem chave de API)
npm run demo    # avalia conversas de exemplo contra uma API no ar
```

## Estrutura do projeto

```
src/
  api/            servidor Fastify, rotas (evaluations, health, metrics), mapeamento de erros
  adapters/       formato externo → conversa canônica
  preprocessing/  normalização, mascaramento de PII, avaliabilidade, truncamento
  rubric/         schema/loader do YAML, geração de prompt + JSON Schema
  evaluation/     cliente LLM (retry/backoff), orquestrador single-call, agregação
  persistence/    SQLite (WAL) + migrations, repositório de auditoria
  observability/  logger, custo, métricas
  config/         validação de env, tabela de preços
rubrics/          rubricas YAML versionadas
data/             conversas de exemplo (fixture da demo e dos testes)
scripts/          script de demo
```

## Notas e limitações

- **Sem autenticação** e avaliação **síncrona** por decisão de projeto
  (protótipo). O caminho de escala (fila + workers + Postgres, autenticação,
  rate limiting) está documentado no documento de solução.
- O mascaramento de PII é por regex (melhor-esforço); NER é a evolução
  documentada.
- A conversa original (sem máscara) fica apenas na trilha de auditoria local em
  SQLite; somente a versão mascarada é enviada à OpenAI.
- Uma segunda arquitetura, mais sofisticada (multi-agente, multi-chamadas), é
  analisada no documento de solução, mas deliberadamente não implementada
  (time-box).
