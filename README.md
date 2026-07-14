# Conversation Quality Analyzer

> Resolução do desafio técnico para a vaga de Engenheiro(a) de Inteligência
> Artificial da **+A Educação**.

API em Node.js/TypeScript que avalia a qualidade de conversas de atendimento
(chat/WhatsApp) usando um LLM como juiz, guiado por uma rubrica YAML versionada.
Recebe uma conversa e retorna notas por dimensão (0–5) com justificativas e
evidências, nota geral, flags críticas e resumo executivo — persistindo a
trilha de auditoria completa em SQLite.

**Para entender a solução** (arquitetura, decisões técnicas, estratégias de
prompt/modelo/orquestração, comparação de abordagens, custos medidos, riscos e
evolução), leia o documento de solução: [`docs/SOLUCAO.md`](docs/SOLUCAO.md).
Este README cobre apenas **como executar**.

## Entregáveis do desafio

- [`docs/SOLUCAO.md`](docs/SOLUCAO.md) — documento de solução (Entregável 1).
- Este repositório — protótipo funcional (Entregável 2).
- [`docs/USO_DE_IA.md`](docs/USO_DE_IA.md) — registro de uso de IA no
  desenvolvimento (Entregável 3).

## Requisitos

- Node.js >= 20 (desenvolvido e testado no Node 22)
- Uma chave de API da OpenAI — apenas para rodar localmente e para a demo.
  **A suíte de testes roda sem chave** (usa um cliente LLM mockado).

## Setup e execução

```bash
npm install
cp .env.example .env   # depois preencha OPENAI_API_KEY
npm run dev            # sobe a API em watch mode na porta 3000
```

A configuração é validada no boot (*fail-fast*); as variáveis disponíveis e
seus defaults estão em `.env.example`. Outros scripts:

```bash
npm test        # suíte completa (vitest) — sem chave de API
npm run build   # compila para dist/   |   npm start roda o build
npm run demo    # avalia conversas de exemplo contra uma API no ar
```

## API

| Método e caminho     | Descrição                                              |
| -------------------- | ------------------------------------------------------ |
| `POST /evaluations`  | Avalia uma conversa e retorna o resultado estruturado  |
| `GET /health`        | Liveness (processo + acesso ao SQLite)                 |
| `GET /metrics`       | Métricas agregadas das avaliações persistidas          |

Em `options` (opcional): `rubric` seleciona a rubrica de `rubrics/*.yaml` —
`"default"` (versão mais recente) ou pinada, ex.: `"default@1"` — e `model`
troca o modelo (`"gpt-4o-mini"` default, `"gpt-4o"`). Erros são explícitos:
`400` (schema inválido), `404` (rubrica desconhecida), `422` (conversa não
avaliável), `502` (LLM falhou após retries), `500` (falha de auditoria).

### Exemplo de requisição

A requisição abaixo é a sessão de exemplo `S_84b564f9` **resumida às duas
mensagens de abertura**; a resposta a seguir é a saída real dessa sessão, então
os metadados refletem a conversa completa de 24 mensagens.

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

## Demo

Avalia conversas de `data/examples.json` (as 20 conversas de exemplo do
desafio) contra uma API **no ar** (OpenAI real). Suba o servidor em um terminal
e rode a demo em outro:

```bash
npm run demo -- --session S_84b564f9          # uma sessão
npm run demo                                  # todas as conversas
npm run demo -- --rubric default@1 --model gpt-4o
```

Para cada conversa a demo imprime notas, flags, custo, latência e tokens.

## Docker

```bash
docker build -t conversation-quality-analyzer .

docker run --rm -p 3000:3000 \
  -e OPENAI_API_KEY=sk-sua-chave \
  -v "$(pwd)/data:/app/data" \
  conversation-quality-analyzer
```

O volume em `/app/data` persiste o banco de auditoria entre execuções (opcional).

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
