-- Queries do slide "Protótipo funcional: a prova em números"
-- Rodar com:  sqlite3 -readonly data/evaluations.db < slide-queries.sql
-- Base: última avaliação bem-sucedida de cada sessão com o modelo atual.

.mode box
.headers on

-- ============================================================
-- 1) "20/20 conversas avaliadas" — a rodada, linha a linha
-- ============================================================
WITH run AS (
  SELECT * FROM evaluations e
  WHERE model = 'gpt-5.4-mini' AND status = 'success' AND session_id IS NOT NULL
    AND created_at = (SELECT MAX(created_at) FROM evaluations
                      WHERE session_id = e.session_id
                        AND model = 'gpt-5.4-mini' AND status = 'success')
)
SELECT
  session_id                                        AS sessao,
  json_extract(result, '$.overallScore')            AS overall,
  printf('US$ %.4f', cost_usd)                      AS custo,
  printf('%.1f s', latency_ms / 1000.0)             AS latencia,
  tokens_in || ' -> ' || tokens_out                 AS tokens,
  rubric_id || '@' || rubric_version                AS rubrica
FROM run
ORDER BY session_id;

-- ============================================================
-- 2) "US$ 0,007 por avaliação · latência 6–7,5 s" — agregados
-- ============================================================
WITH run AS (
  SELECT * FROM evaluations e
  WHERE model = 'gpt-5.4-mini' AND status = 'success' AND session_id IS NOT NULL
    AND created_at = (SELECT MAX(created_at) FROM evaluations
                      WHERE session_id = e.session_id
                        AND model = 'gpt-5.4-mini' AND status = 'success')
),
lat AS (SELECT latency_ms FROM run ORDER BY latency_ms)
SELECT
  (SELECT COUNT(*) FROM run)                                    AS avaliacoes,
  printf('US$ %.4f', (SELECT AVG(cost_usd) FROM run))           AS custo_medio,
  printf('US$ %.3f', (SELECT SUM(cost_usd) FROM run))           AS custo_total,
  (SELECT printf('%d -> %d', AVG(tokens_in), AVG(tokens_out))
     FROM run)                                                  AS tokens_medios,
  printf('%.1f s', (SELECT latency_ms FROM lat
                    LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM lat)) / 1000.0)  AS latencia_p50,
  printf('%.1f s', (SELECT latency_ms FROM lat
                    LIMIT 1 OFFSET (SELECT (COUNT(*)-1)*95/100 FROM lat)) / 1000.0) AS latencia_p95;

-- ============================================================
-- 3) "Custo em escala" — projeções a partir do custo medido
-- ============================================================
WITH run AS (
  SELECT * FROM evaluations e
  WHERE model = 'gpt-5.4-mini' AND status = 'success' AND session_id IS NOT NULL
    AND created_at = (SELECT MAX(created_at) FROM evaluations
                      WHERE session_id = e.session_id
                        AND model = 'gpt-5.4-mini' AND status = 'success')
),
media AS (SELECT AVG(cost_usd) AS c FROM run)
SELECT volume, custo FROM (
  SELECT 1 AS ord, '1.000/dia'    AS volume,
         printf('US$ %.0f/mês', c * 1000 * 30) AS custo FROM media
  UNION ALL
  SELECT 2, '100.000/dia', printf('US$ %.0f/dia', c * 100000) FROM media
) ORDER BY ord;

-- ============================================================
-- 4) "Caso real: conversa em loop" — S_5ee36f40, notas por dimensão
-- ============================================================
SELECT
  json_extract(d.value, '$.dimensionId')     AS dimensao,
  json_extract(d.value, '$.score')           AS nota,
  json_extract(d.value, '$.justification')   AS justificativa
FROM evaluations e, json_each(e.result, '$.dimensions') d
WHERE e.session_id = 'S_5ee36f40' AND e.model = 'gpt-5.4-mini' AND e.status = 'success'
  AND e.created_at = (SELECT MAX(created_at) FROM evaluations
                      WHERE session_id = 'S_5ee36f40'
                        AND model = 'gpt-5.4-mini' AND status = 'success');

-- ============================================================
-- 5) Flags disparadas no dataset, com evidências citadas
--    (inclui a frustração do caso de loop e as alucinações
--     que o modelo anterior não pegava)
-- ============================================================
WITH run AS (
  SELECT * FROM evaluations e
  WHERE model = 'gpt-5.4-mini' AND status = 'success' AND session_id IS NOT NULL
    AND created_at = (SELECT MAX(created_at) FROM evaluations
                      WHERE session_id = e.session_id
                        AND model = 'gpt-5.4-mini' AND status = 'success')
)
SELECT
  r.session_id                            AS sessao,
  json_extract(f.value, '$.flagId')       AS flag,
  json_extract(ev.value, '$.messageIndex') AS msg,
  json_extract(ev.value, '$.quote')       AS evidencia
FROM run r,
     json_each(r.result, '$.flags') f,
     json_each(f.value, '$.evidence') ev
WHERE json_extract(f.value, '$.triggered') = 1
ORDER BY flag, sessao, msg;
