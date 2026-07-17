# Uso de IA no desenvolvimento

Este documento registra, de forma contínua, onde a IA (um assistente de código)
foi usada durante o desenvolvimento, com qual propósito e como suas sugestões
foram validadas. Ele é atualizado ao final de cada fase — não reconstruído de
memória no fim do projeto.

Para cada uso relevante registramos três pontos:

- **Onde**: em que parte do trabalho a IA foi aplicada.
- **Por quê**: qual era o objetivo.
- **Como foi validado**: como confirmamos que a sugestão estava correta.

---

## Fase 1 — Fundação do projeto

- **Onde**: estrutura inicial do projeto (package.json, tsconfig, vitest),
  validação de variáveis de ambiente (`src/config/env.ts`), a tabela de preços
  (`src/config/pricing.ts`), o logger estruturado
  (`src/observability/logger.ts`) e o esqueleto da documentação.
- **Por quê**: montar uma base mínima, tipada e testável, com configuração
  validada em *fail-fast* e sem vazamento de segredos nos logs.
- **Como foi validado**:
  - Testes unitários para `env.ts` (`tests/config/env.test.ts`) cobrindo
    carregamento com defaults, coerção numérica, chave de API ausente/vazia e
    valores inválidos; `npm test` passa.
  - Redação de `OPENAI_API_KEY` configurada no logger (pino `redact`) para
    garantir que a chave nunca apareça nos logs.
  - Conferência manual dos preços por token contra a tabela pública da OpenAI.

## Fase 2 — Domínio + rubrica (fonte da verdade)

- **Onde**: schemas canônicos do domínio (`src/domain/conversation.ts`,
  `src/domain/evaluation.ts`) e o subsistema de rubrica (`src/rubric/schema.ts`,
  `loader.ts`, `prompt.ts`, `json-schema.ts`), além de `rubrics/default.v1.yaml`.
- **Por quê**: tornar a rubrica a única fonte da verdade — o prompt de avaliação
  e o JSON Schema de *structured output* da OpenAI são ambos derivados dela em
  tempo de execução, de modo que adicionar ou alterar um critério é uma edição de
  YAML sem mudança de código.
- **Como foi validado**:
  - Testes unitários (`tests/rubric/*.test.ts`, 17 testes) cobrindo: *fail-fast*
    do loader (pesos que não somam 1, ids duplicados, nível de âncora ausente,
    YAML inválido, `id@version` duplicado), resolução de versão (`default` →
    latest) e o critério-chave de aceitação de que uma nova dimensão adicionada a
    uma rubrica aparece tanto no prompt renderizado quanto no JSON Schema gerado.
  - Um teste recursivo garantindo que o schema gerado obedece ao *strict mode* da
    OpenAI (`additionalProperties: false` e `required` completo em todo objeto).
  - Verificação manual fim a fim carregando o `rubrics/default.v1.yaml` real: os
    pesos somam 1.0, e 4 dimensões e 4 flags fluem para o schema e o prompt.

## Fase 3 — Pré-processamento determinístico

- **Onde**: normalização de texto, mascaramento de PII, verificação de
  avaliabilidade e truncamento baseado em tokens
  (`src/preprocessing/{normalize,pii,evaluability,truncate}.ts`).
- **Por quê**: executar toda etapa determinística e barata antes de qualquer
  chamada ao LLM — mascarar dados sensíveis, rejeitar conversas não avaliáveis
  (R2) e limitar o tamanho da conversa preservando a abertura, o fechamento e os
  índices originais das mensagens.
- **Como foi validado**: testes unitários (`tests/preprocessing/*.test.ts`)
  cobrindo formatos de PII (válidos, de fronteira e não-PII que não devem ser
  mascarados), as regras de avaliabilidade, a tolerância a mojibake e o
  truncamento (início+fim preservados, marcador inserido, índices originais
  mantidos, flag `truncated`).

## Fase 4 — Adaptadores de entrada

- **Onde**: o *passthrough* canônico e o conversor do formato de exemplo
  (`src/adapters/{canonical,example-json}.ts`) mais o fixture
  `data/examples.json`.
- **Por quê**: permitir que qualquer formato externo entre por um adaptador em um
  único contrato canônico, de modo que o núcleo nunca mude quando um novo formato
  for adicionado.
- **Como foi validado**: testes unitários cobrindo o mapeamento de papéis
  (`human`→`customer`, `ai`→`attendant`), conteúdo preservado (incluindo
  prefixos `"Reposta da mensagem:"` embutidos), mensagens malformadas gerando um
  erro claro e o carregamento do fixture de 20 conversas.

## Fase 5 — Camada de LLM, orquestrador e agregação

- **Onde**: a interface `LlmClient` com a implementação OpenAI e um mock
  (`src/evaluation/llm-client.ts`), o orquestrador de chamada única
  (`orchestrator.ts`) e a agregação determinística (`aggregate.ts`).
- **Por quê**: um cliente fino e substituível (retry/backoff, um único re-prompt
  em resposta inválida, semáforo de concorrência) por trás do qual o orquestrador
  transforma uma rubrica em prompt/schema, uma chamada estruturada e uma nota
  ponderada.
- **Como foi validado**: testes unitários com temporização falsa e um cliente
  mock (retry/backoff, esgotamento → erro explícito, re-prompt, limite do
  semáforo, agregação com renormalização de `insufficient_data`). A integração
  com a OpenAI é testada com um fake OpenAI injetado, e um teste de contrato
  mantém o JSON Schema e o validador Zod em sincronia. Nenhum teste precisa de
  chave de API.

## Fase 6 — API mínima fim a fim (v0.1-mvp)

- **Onde**: o servidor Fastify, `POST /evaluations`, `GET /health`, o mapeamento
  erro-de-domínio → HTTP e o correlation id (`src/api/*`), além de conectar o
  truncamento ao prompt/orquestrador para que as evidências citadas mantenham os
  índices originais das mensagens.
- **Por quê**: expor o pipeline completo (adaptador → normalização → máscara →
  avaliabilidade → truncamento → avaliação em chamada única → agregação) como um
  único endpoint síncrono retornando o corpo estruturado R7.
- **Como foi validado**:
  - Testes de integração com o cliente mock (sem chave de API): 200 com o corpo
    R7 completo, 400 (schema inválido e JSON malformado), 404 (rubrica
    desconhecida listando as disponíveis), 422 (não avaliável, com motivo), 502
    (retries esgotados), um teste garantindo que só conteúdo com PII mascarada
    chega ao LLM, e um teste de truncamento.
  - **Validação manual com OpenAI real** na sessão `S_84b564f9` com `gpt-4o-mini`:
    HTTP 200, análise estruturada coerente (as quatro dimensões com nota 4, geral
    4, sem flags), com evidências literais e índices de mensagem;
    `tokensIn≈3668`, `tokensOut≈669`, custo ≈ US$0,00095, latência ≈ 11s.
  - Observação de calibração desse *run*: a afirmação sem suporte do atendente
    ("mais procurado atualmente") foi citada, mas a flag `hallucination` não foi
    disparada. Registrado como limitação conhecida do `gpt-4o-mini` em casos
    sutis — motiva oferecer um modelo maior (`gpt-5.6-terra`) e construir um
    dataset dourado (ambos já no plano).

## Fase 7 — Persistência e trilha de auditoria

- **Onde**: SQLite (WAL) com migrações idempotentes no boot, o repositório de
  auditoria (`src/persistence/*`), o cálculo de custo
  (`src/observability/cost.ts`) e a integração da escrita de auditoria ao caminho
  da requisição.
- **Por quê**: persistir uma linha de auditoria completa e reproduzível (R8) para
  cada avaliação — sucesso e falha — no caminho crítico, de modo que nenhum 200
  seja retornado sem sua auditoria.
- **Como foi validado**: testes de *round-trip* do repositório sobre um SQLite
  temporário, teste de migração idempotente e testes de API comprovando uma linha
  de auditoria de sucesso completa, uma auditoria de falha em um 502 e um 500
  quando a escrita falha.

## Fase 8 — Métricas e observabilidade

- **Onde**: `GET /metrics` (`computeMetrics` puro + agregados do repositório), a
  verificação de acessibilidade do SQLite em `GET /health` e o log com
  correlation id ao longo das etapas de requisição/LLM/persistência.
- **Por quê**: expor métricas operacionais (custo, tokens, latência p50/p95,
  distribuições de notas, flags) e tornar as falhas observáveis de ponta a ponta.
- **Como foi validado**: testes unitários da matemática de percentil e de
  `computeMetrics` contra valores conhecidos (incluindo o agrupamento por
  múltiplas versões de rubrica), um teste de integração com uma avaliação com
  falha na mistura, `/health` no ar/fora do ar e uma asserção de log com
  correlation id atravessando as camadas.

## Fase 9 — Demo, Docker e README (v1.0)

- **Onde**: `scripts/demo.ts` (avalia conversas de exemplo contra a API no ar), o
  `Dockerfile` multi-stage (o `better-sqlite3` nativo compilado no estágio de
  build, reutilizado no runtime slim) e o `README.md` completo.
- **Por quê**: empacotar o protótipo para uso real e fornecer a demonstração em
  tempo real da abordagem de chamada única implementada.
- **Como foi validado**:
  - `docker build` bem-sucedido e o container serviu `/health`, `/metrics` e um
    422 apenas com uma chave dummy (sem custo com a OpenAI).
  - **Casos de sanidade executados contra a API real** (`gpt-4o-mini`, via
    `npm run demo`), custo total ≈ US$0,0033, latência média ≈ 14 s:
    - `S_5ee36f40` (loop / perda de contexto): corretamente discriminado — geral
      **2,5**, dimensões 2/2/4/2, e a flag `customer_frustration` disparada.
    - `S_84b564f9` (possível alucinação): geral 4, sem flags — a alucinação sutil
      novamente não foi sinalizada (limitação consistente do `gpt-4o-mini`).
    - `S_213f6505` (coleta de CPF): geral 4, sem flags. Nota: a PII é mascarada
      antes do LLM, então `sensitive_data_exposure` é intencionalmente difícil de
      disparar a partir do texto mascarado — uma nuance de desenho, não um erro do
      juiz.
    - `S_68c0d237` (honestidade sobre um professor): geral 4, sem flags.
  - Conclusão: o juiz separa com clareza a conversa genuinamente problemática (o
    loop) das aceitáveis; a detecção de alucinação sutil é a principal lacuna e é
    tratada no documento de solução (escolha de modelo + dataset dourado).

## Fase 10 — Entregáveis (registro de uso de IA + documento de solução)

- **Onde**: consolidação deste registro e escrita do documento de solução
  (`docs/SOLUCAO.md`).
- **Por quê**: produzir os dois entregáveis escritos do desafio (este log de uso
  de IA e o documento de solução) sem contradizer a implementação.
- **Como foi validado**: as seções de viabilidade econômica e de comparação de
  arquitetura do documento de solução usam números reais lidos de `GET /metrics`
  sobre as quatro avaliações de sanidade (média ≈ US$0,00083/avaliação, latência
  p50 ≈ 11,2 s / p95 ≈ 17,2 s); cada afirmação foi cruzada com o código e a suíte
  de testes.

---

## Fase 11 — Migração de modelos e re-medição (2026-07-17)

- **Onde**: `src/config/pricing.ts`, `src/config/env.ts`, testes, README e
  `docs/SOLUCAO.md`.
- **Por quê**: a OpenAI aposentou a família `gpt-4o`; o padrão migrou para
  `gpt-5.4-mini` (com `gpt-5.6-terra` e `gpt-5.4-nano` na tabela de preços).
  Os números citados nos documentos foram re-medidos no modelo novo.
- **Como foi validado**: a suíte completa (122 testes, sem chave) e o typecheck
  passaram após a troca; em seguida, **execução real na OpenAI sobre as 20
  conversas do dataset** (`npm run demo`, `default@2`): 20/20 avaliadas, custo
  médio ≈ US$0,0069/avaliação (total US$0,137), tokens médios ≈ 3.332 → 967,
  latência p50 ≈ 6,0 s / p95 ≈ 7,5 s — números relidos da trilha de auditoria
  no SQLite. Observação de calibração: a alucinação sutil de `S_84b564f9`, que
  o `gpt-4o-mini` consistentemente não sinalizava, **passou a disparar** a flag
  `hallucination` no `gpt-5.4-mini` (3 disparos no dataset), e a distribuição
  de notas ficou mais discriminada (communication deixou de travar em 4). Os
  números de fases anteriores foram mantidos como registro histórico do modelo
  antigo.

---

# Como a IA foi usada — em resumo

- **Assistente**: um assistente de código com IA (Claude Code) foi usado ao longo
  de todo o trabalho, conduzido por um fluxo *spec-first* (entrevista → SPEC →
  PLAN → implementar/revisar por tarefa).
- **Escopo**: estrutura inicial, modelagem de domínio/rubrica, pré-processamento,
  a camada de LLM/orquestrador/agregação, a API, persistência, observabilidade, a
  demo, o Dockerfile e estes documentos.
- **Disciplina de validação** (o "como foi validado" de cada fase, resumido):
  - Testes automatizados foram escritos junto com cada módulo e executados **sem
    chave de API** (um cliente LLM mockado), de modo que o comportamento é
    verificado deterministicamente — 122 testes na v1.0.
  - O comportamento dependente do LLM foi verificado com **execuções reais na
    OpenAI** sobre as próprias conversas de exemplo do desafio (validação manual
    do MVP + os quatro casos de sanidade), e os números foram relidos da trilha de
    auditoria e do `/metrics`.
  - Cada sugestão da IA foi revisada contra a spec e, onde tocava comportamento,
    travada com um teste antes de ser aceita; nada foi aceito no escuro.
