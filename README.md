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
`"default"` (versão mais recente) ou pinada, ex.: `"default@2"` — e `model`
troca o modelo (`"gpt-5.4-mini"` default; ex.: `"gpt-5.6-terra"`). Erros são explícitos:
`400` (schema inválido), `404` (rubrica desconhecida), `422` (conversa não
avaliável), `502` (LLM falhou após retries), `500` (falha de auditoria).

### Exemplo de requisição

A requisição abaixo é a sessão de exemplo `S_5ee36f40` **completa** (16
mensagens, de `data/examples.json`) — um atendimento problemático: o atendente
ignora correções do cliente, repete perguntas já respondidas e a conversa
termina sem resolução. A resposta a seguir é a saída real dessa requisição.

```bash
curl -s http://localhost:3000/evaluations \
  -H 'content-type: application/json' \
  -d '{
    "conversation": {
      "sessionId": "S_5ee36f40",
      "channel": "whatsapp",
      "messages": [
        { "role": "customer",  "content": "Eu sou Pessoa_018" },
        { "role": "customer",  "content": "Licenciatura" },
        { "role": "attendant", "content": "Olá, Pessoa_018, eu sou a Beatriz, consultora de carreira da +A Code Academy. Vi que você tem interesse em uma pós-graduação. Me conta: você já tem um curso em mente?" },
        { "role": "attendant", "content": "Entendi, você tem interesse em Licenciatura. Gostaria de entender um pouco mais sobre seus objetivos profissionais para te orientar melhor: o que te levou a buscar uma licenciatura neste momento?" },
        { "role": "customer",  "content": "Não eu não tenho interesse em licenciatura eu tenho licenciatura em filosofia" },
        { "role": "attendant", "content": "Entendi, obrigado pelo esclarecimento. Você está buscando uma pós-graduação em alguma área específica ou pensando em mudar de área? Quero entender melhor seus objetivos para te orientar da melhor forma." },
        { "role": "customer",  "content": "Respondi a pergunta" },
        { "role": "attendant", "content": "Obrigado! Só para confirmar, você está buscando uma pós-graduação em uma área específica ou interessado em migrar para outra área?\nSe puder me contar qual área você tem interesse, consigo te orientar melhor." },
        { "role": "customer",  "content": "Mas agora já está tarde e não poderei aprofundar a conversa" },
        { "role": "customer",  "content": "Retorno noutra ocasião" },
        { "role": "attendant", "content": "Sem problemas, podemos continuar quando for melhor para você. Prefere agendar um horário para retomarmos a conversa? Assim consigo te ajudar com calma." },
        { "role": "customer",  "content": "Vc não viu as mensagens" },
        { "role": "attendant", "content": "Sem problemas! Quando for o melhor momento para você retomar, estarei à disposição para ajudar. Fique à vontade para retornar quando quiser continuar a conversa sobre sua pós-graduação." },
        { "role": "customer",  "content": "Bia noite" },
        { "role": "attendant", "content": "Recebi suas mensagens sim! Só para ter certeza, você está interessado em uma pós-graduação em alguma área específica ou deseja migrar de área? Assim consigo te orientar com mais precisão." },
        { "role": "attendant", "content": "Boa noite! Podemos retomar sua orientação sobre pós-graduação agora? Fico à disposição para entender seus objetivos e ajudar na escolha do curso ideal, caso queira continuar." }
      ]
    },
    "options": { "rubric": "default@2", "model": "gpt-5.4-mini" }
  }'
```

### Exemplo de resposta (saída real de `S_5ee36f40`)

Note as notas baixas com evidências apontando as mensagens originais
(`messageIndex`), a flag `customer_frustration` disparada e o resumo executivo.

```json
{
  "evaluationId": "1593ecd8-5737-464e-a1b9-cfbb1e5d25f0",
  "dimensions": [
    {
      "dimensionId": "communication",
      "score": 2,
      "justification": "A comunicação é compreensível, mas há redundância e tom pouco adaptado ao fluxo da conversa. O atendente repete a mesma linha de questionamento várias vezes, mesmo após o cliente indicar que já respondeu e que não poderia aprofundar a conversa.",
      "evidence": [
        { "messageIndex": 3, "quote": "Entendi, você tem interesse em Licenciatura. Gostaria de entender um pouco mais sobre seus objetivos profissionais para te orientar melhor: o que te levou a buscar uma licenciatura neste momento?" },
        { "messageIndex": 7, "quote": "Obrigado! Só para confirmar, você está buscando uma pós-graduação em uma área específica ou interessado em migrar para outra área?" },
        { "messageIndex": 14, "quote": "Recebi suas mensagens sim! Só para ter certeza, você está interessado em uma pós-graduação em alguma área específica ou deseja migrar de área?" }
      ]
    },
    {
      "dimensionId": "contextual_understanding",
      "score": 1,
      "justification": "Há falha clara de acompanhamento do contexto: o cliente corrige que não quer licenciatura, diz que já respondeu e informa que não poderá aprofundar a conversa, mas o atendente continua repetindo perguntas já respondidas e não incorpora adequadamente essas correções.",
      "evidence": [
        { "messageIndex": 4, "quote": "Não eu não tenho interesse em licenciatura eu tenho licenciatura em filosofia" },
        { "messageIndex": 5, "quote": "Entendi, obrigado pelo esclarecimento. Você está buscando uma pós-graduação em alguma área específica ou pensando em mudar de área?" },
        { "messageIndex": 6, "quote": "Respondi a pergunta" },
        { "messageIndex": 7, "quote": "Obrigado! Só para confirmar, você está buscando uma pós-graduação em uma área específica ou interessado em migrar para outra área?" },
        { "messageIndex": 8, "quote": "Mas agora já está tarde e não poderei aprofundar a conversa" },
        { "messageIndex": 14, "quote": "Recebi suas mensagens sim! Só para ter certeza, você está interessado em uma pós-graduação em alguma área específica ou deseja migrar de área?" }
      ]
    },
    {
      "dimensionId": "compliance_accuracy",
      "score": 3,
      "justification": "Não há violação explícita de regra de negócio nem invenção de fatos observável. O atendente mantém a conversa dentro do tema de orientação de pós-graduação e não expõe dados sensíveis além do nome informado pelo próprio cliente.",
      "evidence": [
        { "messageIndex": 2, "quote": "Olá, Pessoa_018, eu sou a Beatriz, consultora de carreira da +A Code Academy." },
        { "messageIndex": 10, "quote": "Sem problemas, podemos continuar quando for melhor para você. Prefere agendar um horário para retomarmos a conversa?" }
      ]
    },
    {
      "dimensionId": "resolution",
      "score": 2,
      "justification": "A conversa não avança de forma efetiva para o objetivo do cliente. Embora haja tentativa de retomar e agendar, o atendente não aproveita as informações já dadas nem respeita a indisponibilidade do cliente, mantendo perguntas repetidas sem encaminhamento concreto.",
      "evidence": [
        { "messageIndex": 8, "quote": "Mas agora já está tarde e não poderei aprofundar a conversa" },
        { "messageIndex": 10, "quote": "Sem problemas, podemos continuar quando for melhor para você. Prefere agendar um horário para retomarmos a conversa?" },
        { "messageIndex": 14, "quote": "Recebi suas mensagens sim! Só para ter certeza, você está interessado em uma pós-graduação em alguma área específica ou deseja migrar de área?" }
      ]
    }
  ],
  "overallScore": 2,
  "flags": [
    { "flagId": "hallucination", "triggered": false, "justification": "Não há afirmações factuais claramente inventadas ou números/prazos/promessas não sustentados pela conversa.", "evidence": [] },
    {
      "flagId": "sensitive_data_exposure",
      "triggered": false,
      "justification": "O único dado pessoal visível é o nome/identificador fornecido pelo próprio cliente, usado na saudação sem exposição indevida adicional.",
      "evidence": [
        { "messageIndex": 0, "quote": "Eu sou Pessoa_018" },
        { "messageIndex": 2, "quote": "Olá, Pessoa_018, eu sou a Beatriz, consultora de carreira da +A Code Academy." }
      ]
    },
    {
      "flagId": "customer_frustration",
      "triggered": true,
      "justification": "O cliente demonstra irritação e sensação de não ter sido ouvido, com reclamações explícitas sobre a leitura das mensagens.",
      "evidence": [
        { "messageIndex": 6, "quote": "Respondi a pergunta" },
        { "messageIndex": 11, "quote": "Vc não viu as mensagens" }
      ]
    },
    { "flagId": "business_rule_violation", "triggered": false, "justification": "Não há evidência de violação explícita de regra de negócio na conversa.", "evidence": [] }
  ],
  "summary": "O atendimento foi compreensível, mas pouco adaptado ao contexto e repetitivo. O principal problema foi a baixa compreensão contextual: o cliente corrigiu que não queria licenciatura, disse que já havia respondido e informou que não poderia continuar, mas o atendente insistiu nas mesmas perguntas. Não houve violação clara de regra nem exposição sensível indevida, porém a conversa avançou pouco e gerou frustração no cliente.",
  "metadata": {
    "evaluationId": "1593ecd8-5737-464e-a1b9-cfbb1e5d25f0",
    "rubricId": "default",
    "rubricVersion": 2,
    "promptVersion": "v1",
    "model": "gpt-5.4-mini",
    "tokensIn": 3159,
    "tokensOut": 1066,
    "costUsd": 0.007166,
    "latencyMs": 5810,
    "truncated": false,
    "createdAt": "2026-07-17T13:13:34.115Z"
  }
}
```

## Demo

Avalia conversas de `data/examples.json` (as 20 conversas de exemplo do
desafio) contra uma API **no ar** (OpenAI real). Suba o servidor em um terminal
e rode a demo em outro:

```bash
npm run demo -- --session S_5ee36f40          # uma sessão
npm run demo                                  # todas as conversas
npm run demo -- --rubric default@1 --model gpt-5.6-terra
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
