-- Synthetic local assertions only. The database-name guard rejects production.
DO $$ BEGIN
 IF current_database() <> 'jopie_baseline_test' THEN
  RAISE EXCEPTION 'This test requires the disposable jopie_baseline_test database';
 END IF;
END $$;
BEGIN;
INSERT INTO public.app_settings(id,allowed_emails)
VALUES(true,ARRAY['a@example.test','b@example.test','c@example.test']::public.citext[]);
INSERT INTO public.categories(id,name,kind) VALUES
 ('11111111-1111-4111-8111-111111111111','Synthetic Expense','expense'),
 ('22222222-2222-4222-8222-222222222222','Synthetic Income','income');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"a@example.test","role":"authenticated"}';
CREATE TEMP TABLE valid_cases(name text, expense jsonb);
INSERT INTO valid_cases VALUES ('personal',jsonb_build_object(
 'note','synthetic personal','amount',851,'currency','TWD',
 'ts',((now() at time zone 'Asia/Taipei')::date::timestamp at time zone 'Asia/Taipei'),
 'payer_email','a@example.test','scope','personal','shares_json',jsonb_build_object('a@example.test',851),
 'category_id','11111111-1111-4111-8111-111111111111','is_settled',true));
INSERT INTO valid_cases SELECT 'household two',expense || '{"note":"synthetic two","scope":"household","is_settled":false,"shares_json":{"a@example.test":426,"b@example.test":425}}' FROM valid_cases WHERE name='personal';
INSERT INTO valid_cases SELECT 'household three',expense || '{"note":"synthetic three","scope":"household","is_settled":false,"shares_json":{"a@example.test":285,"b@example.test":283,"c@example.test":283}}' FROM valid_cases WHERE name='personal';
CREATE TEMP TABLE invalid_cases(name text, expense jsonb);
INSERT INTO invalid_cases
SELECT patch.name, v.expense || patch.value FROM valid_cases v CROSS JOIN (VALUES
 ('extra key','{"extra":true}'::jsonb),
 ('blank note','{"note":"   "}'), ('non-string note','{"note":1}'),
 ('string amount','{"amount":"851"}'), ('zero amount','{"amount":0}'),
 ('negative amount','{"amount":-1}'), ('fractional amount','{"amount":1.5}'),
 ('unsafe amount','{"amount":9007199254740992}'), ('foreign currency','{"currency":"USD"}'),
 ('unknown scope','{"scope":"other"}'), ('null scope','{"scope":null}'),
 ('unknown payer','{"payer_email":"unknown@example.test"}'),
 ('non-boolean settled','{"is_settled":"true"}'), ('non-string date','{"ts":1}'),
 ('not Taipei midnight','{"ts":"2026-03-01T17:00:00Z"}'), ('infinite date','{"ts":"infinity"}'),
 ('unknown category','{"category_id":"99999999-9999-4999-8999-999999999999"}'),
 ('income category','{"category_id":"22222222-2222-4222-8222-222222222222"}'),
 ('non-string category','{"category_id":1}'), ('non-object shares','{"shares_json":[]}'),
 ('unknown share member','{"shares_json":{"unknown@example.test":851}}'),
 ('non-number share','{"shares_json":{"a@example.test":"851"}}'),
 ('negative share','{"shares_json":{"a@example.test":-1}}'),
 ('fractional share','{"shares_json":{"a@example.test":851.5}}'),
 ('wrong share sum','{"shares_json":{"a@example.test":850}}'),
 ('empty shares','{"shares_json":{}}'),
 ('personal other payer','{"payer_email":"b@example.test"}'),
 ('personal other shares','{"shares_json":{"b@example.test":851}}'),
 ('personal unsettled','{"is_settled":false}'),
 ('household one member','{"scope":"household","is_settled":false}'),
 ('household settled','{"scope":"household","shares_json":{"a@example.test":426,"b@example.test":425}}'),
 ('household unequal','{"scope":"household","is_settled":false,"shares_json":{"a@example.test":850,"b@example.test":1}}'),
 ('household wrong remainder','{"scope":"household","is_settled":false,"shares_json":{"a@example.test":425,"b@example.test":426}}')
) AS patch(name,value) WHERE v.name='personal';
INSERT INTO invalid_cases SELECT 'missing key',expense-'note' FROM valid_cases WHERE name='personal';
INSERT INTO invalid_cases SELECT 'tomorrow in Taipei',expense || jsonb_build_object('ts',(((now() at time zone 'Asia/Taipei')::date+1)::timestamp at time zone 'Asia/Taipei')) FROM valid_cases WHERE name='personal';
INSERT INTO invalid_cases VALUES ('non-object expense','[]'), ('null expense','null');

-- Each invocation owns a subtransaction. Catching the error must roll back both
-- the ledger and any earlier expense/share inserts before counts are compared.
CREATE FUNCTION pg_temp.expect_failure(
 label text, value jsonb, batch boolean, expected_state text,
 expected_message text DEFAULT NULL, expected_detail jsonb DEFAULT NULL,
 identifier uuid DEFAULT gen_random_uuid(), digest text DEFAULT repeat('a',64)
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
 expense_count bigint := (SELECT count(*) FROM public.expenses);
 share_count bigint := (SELECT count(*) FROM public.expense_shares);
 ledger_count bigint := (SELECT count(*) FROM public.semantic_entry_requests WHERE request_id=identifier);
 caught boolean := false; state text; message text; detail text;
BEGIN
 BEGIN
  IF batch THEN PERFORM public.create_semantic_expenses(identifier,digest,value);
  ELSE PERFORM public.create_semantic_expense(identifier,digest,value); END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE, message=MESSAGE_TEXT, detail=PG_EXCEPTION_DETAIL;
  caught:=true;
 END;
 IF NOT caught OR state IS DISTINCT FROM expected_state OR
    (expected_message IS NOT NULL AND message IS DISTINCT FROM expected_message) OR
    (expected_detail IS NOT NULL AND detail::jsonb IS DISTINCT FROM expected_detail) OR
    (expected_detail IS NULL AND detail IS DISTINCT FROM '') THEN
  RAISE EXCEPTION '%: expected % / % / %, got % / % / % (caught=%)',label,expected_state,expected_message,expected_detail,state,message,detail,caught;
 END IF;
 IF (SELECT count(*) FROM public.expenses)<>expense_count OR
    (SELECT count(*) FROM public.expense_shares)<>share_count OR
    (SELECT count(*) FROM public.semantic_entry_requests WHERE request_id=identifier)<>ledger_count THEN
  RAISE EXCEPTION '%: rejected request retained expense, share or ledger rows',label;
 END IF;
 RETURN message;
END $$;

DO $$
DECLARE
 v jsonb := (SELECT expense FROM valid_cases WHERE name='personal');
 c record; single_message text; first_result jsonb; replay jsonb; rpc_result jsonb;
 identifier uuid; single_id uuid; v_expense_id uuid; twenty jsonb;
 expense_count bigint; share_count bigint;
BEGIN
 -- The same invalid list checks parity and rollback at indexes zero and one.
 FOR c IN SELECT * FROM invalid_cases LOOP
  single_message:=pg_temp.expect_failure(c.name || ' single',c.expense,false,'PT422');
  PERFORM pg_temp.expect_failure(c.name || ' batch index 0',jsonb_build_array(c.expense),true,'PT422',single_message,'{"index":0}');
  PERFORM pg_temp.expect_failure(c.name || ' batch index 1',jsonb_build_array(v,c.expense),true,'PT422',single_message,'{"index":1}');
 END LOOP;
 FOR c IN SELECT * FROM valid_cases LOOP
  rpc_result:=public.create_semantic_expense(gen_random_uuid(),repeat('a',64),c.expense);
  IF rpc_result->>'replayed' IS DISTINCT FROM 'false' OR rpc_result->'expense'->>'note' IS DISTINCT FROM c.expense->>'note' THEN
   RAISE EXCEPTION '%: valid single rejected or changed',c.name;
  END IF;
  identifier:=gen_random_uuid();
  rpc_result:=public.create_semantic_expenses(identifier,repeat('a',64),jsonb_build_array(c.expense));
  IF rpc_result->>'replayed' IS DISTINCT FROM 'false' OR jsonb_array_length(rpc_result->'expenses')<>1 OR
     rpc_result->'expenses'->0->>'note' IS DISTINCT FROM c.expense->>'note' THEN
   RAISE EXCEPTION '%: valid length-one batch rejected or changed',c.name;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.semantic_entry_requests WHERE request_id=identifier AND expense_id IS NULL AND semantic_entry_requests.result->'batch'='true'::jsonb AND semantic_entry_requests.result->'expenses'=rpc_result->'expenses') THEN
   RAISE EXCEPTION '%: batch ledger marker or expense_id incorrect',c.name;
  END IF;
  v_expense_id:=(rpc_result->'expenses'->0->>'id')::uuid;
  IF (SELECT sum(share_amount) FROM public.expense_shares s WHERE s.expense_id=v_expense_id) IS DISTINCT FROM (c.expense->>'amount')::numeric OR
     (SELECT count(*) FROM public.expense_shares s WHERE s.expense_id=v_expense_id)<>(SELECT count(*) FROM jsonb_object_keys(c.expense->'shares_json')) THEN
   RAISE EXCEPTION '%: trigger share count or total incorrect',c.name;
  END IF;
 END LOOP;
 -- Batch-only cast-boundary group：單筆 RPC create_semantic_expense 對這些輸入會拋出 PostgreSQL 原生錯誤（已知限制，依 #49 計畫不修改單筆 RPC），所以不放進共用 parity 清單。
 FOR c IN SELECT name, v || patch AS expense, message FROM (VALUES
  ('malformed date','{"ts":"not-a-date"}'::jsonb,'Invalid expense date'),
  ('month overflow','{"ts":"2026-13-01T00:00:00+08:00"}','Invalid expense date'),
  ('timestamp overflow','{"ts":"300000-01-01T00:00:00+08:00"}','Invalid expense date'),
  ('timezone overflow','{"ts":"2026-01-01T00:00:00+99:00"}','Invalid expense date'),
  ('malformed category','{"category_id":"not-a-uuid"}','Invalid category'),
  ('personal amount overflow','{"amount":10000000000,"shares_json":{"a@example.test":10000000000}}','Invalid amount'),
  ('household amount overflow','{"scope":"household","is_settled":false,"amount":10000000000,"shares_json":{"a@example.test":5000000000,"b@example.test":5000000000}}','Invalid amount')
 ) AS boundaries(name,patch,message) LOOP
  PERFORM pg_temp.expect_failure(c.name || ' batch index 0',jsonb_build_array(c.expense),true,'PT422',c.message,'{"index":0}');
  PERFORM pg_temp.expect_failure(c.name || ' batch index 1',jsonb_build_array(v,c.expense),true,'PT422',c.message,'{"index":1}');
 END LOOP;
 -- Exercise numeric(12,2) inserts and the real baseline share trigger at the limit.
 FOR c IN SELECT name, v || patch AS expense FROM (VALUES
  ('personal amount limit','{"amount":9999999999,"shares_json":{"a@example.test":9999999999}}'::jsonb),
  ('household amount limit','{"scope":"household","is_settled":false,"amount":9999999999,"shares_json":{"a@example.test":5000000000,"b@example.test":4999999999}}')
 ) AS boundaries(name,patch) LOOP
  rpc_result:=public.create_semantic_expenses(gen_random_uuid(),repeat('a',64),jsonb_build_array(c.expense));
  v_expense_id:=(rpc_result->'expenses'->0->>'id')::uuid;
  IF rpc_result->>'replayed' IS DISTINCT FROM 'false' OR jsonb_array_length(rpc_result->'expenses')<>1 OR
     NOT EXISTS(SELECT 1 FROM public.expenses WHERE id=v_expense_id AND amount=9999999999) OR
     (SELECT sum(share_amount) FROM public.expense_shares WHERE expense_id=v_expense_id) IS DISTINCT FROM 9999999999::numeric OR
     (SELECT jsonb_object_agg(user_email::text,share_amount) FROM public.expense_shares WHERE expense_id=v_expense_id) IS DISTINCT FROM c.expense->'shares_json' THEN
   RAISE EXCEPTION '%: amount limit insert or trigger shares incorrect',c.name;
  END IF;
 END LOOP;
 SELECT jsonb_agg(v) INTO twenty FROM generate_series(1,20);
 rpc_result:=public.create_semantic_expenses(gen_random_uuid(),repeat('a',64),twenty);
 IF jsonb_array_length(rpc_result->'expenses')<>20 OR rpc_result->>'replayed' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Length twenty batch failed'; END IF;
 FOR c IN SELECT * FROM (VALUES ('empty array','[]'::jsonb),('object','{}'),('null','null'),('string','"x"'),('twenty-one',twenty || jsonb_build_array(v)),('SQL null',NULL::jsonb)) shapes(name,value) LOOP
  PERFORM pg_temp.expect_failure(c.name,c.value,true,'PT422','Invalid expense batch');
 END LOOP;
 PERFORM pg_temp.expect_failure('third expense rollback',jsonb_build_array(v,v,v || '{"amount":1.5}'),true,'PT422','Invalid amount','{"index":2}');
 identifier:=gen_random_uuid();
 first_result:=public.create_semantic_expenses(identifier,repeat('a',64),(SELECT jsonb_agg(expense ORDER BY name) FROM valid_cases));
 IF jsonb_array_length(first_result->'expenses')<>3 OR
    (SELECT jsonb_agg(e->>'note' ORDER BY ord) FROM jsonb_array_elements(first_result->'expenses') WITH ORDINALITY AS t(e,ord)) IS DISTINCT FROM
    (SELECT jsonb_agg(expense->>'note' ORDER BY name) FROM valid_cases) THEN RAISE EXCEPTION 'Mixed batch order changed'; END IF;
 expense_count:=(SELECT count(*) FROM public.expenses); share_count:=(SELECT count(*) FROM public.expense_shares);
 replay:=public.create_semantic_expenses(identifier,repeat('a',64),'[]');
 IF replay->>'replayed' IS DISTINCT FROM 'true' OR replay->'expenses' IS DISTINCT FROM first_result->'expenses' OR
    (SELECT count(*) FROM public.expenses)<>expense_count OR (SELECT count(*) FROM public.expense_shares)<>share_count THEN RAISE EXCEPTION 'Matching batch replay changed snapshot or inserted rows'; END IF;
 v_expense_id:=(first_result->'expenses'->0->>'id')::uuid;
 UPDATE public.expenses SET note='edited batch row' WHERE id=v_expense_id;
 replay:=public.create_semantic_expenses(identifier,repeat('a',64),'[]');
 IF replay->'expenses' IS DISTINCT FROM first_result->'expenses' THEN RAISE EXCEPTION 'Edit changed batch snapshot'; END IF;
 DELETE FROM public.expenses WHERE id=v_expense_id;
 replay:=public.create_semantic_expenses(identifier,repeat('a',64),'[]');
 IF replay->'expenses' IS DISTINCT FROM first_result->'expenses' OR EXISTS(SELECT 1 FROM public.expenses WHERE id=v_expense_id) THEN RAISE EXCEPTION 'Delete changed snapshot or recreated expense'; END IF;
 PERFORM pg_temp.expect_failure('different hash',jsonb_build_array(v),true,'PT409','Request text conflict',NULL,identifier,repeat('b',64));
 single_id:=gen_random_uuid();
 PERFORM public.create_semantic_expense(single_id,repeat('a',64),v);
 PERFORM pg_temp.expect_failure('single snapshot protection',jsonb_build_array(v),true,'PT409','Request text conflict',NULL,single_id);
 FOR c IN SELECT * FROM (VALUES ('short hash','a'),('uppercase hash',repeat('A',64)),('null hash',NULL::text)) hashes(name,value) LOOP
  PERFORM pg_temp.expect_failure(c.name,jsonb_build_array(v),true,'PT400','Invalid request identity',NULL,gen_random_uuid(),c.value);
 END LOOP;
 PERFORM pg_temp.expect_failure('null request id',jsonb_build_array(v),true,'PT400','Invalid request identity',NULL,NULL);
 PERFORM set_config('request.jwt.claims','{"email":"a@example.test","role":"authenticated"}',true);
 PERFORM pg_temp.expect_failure('missing subject',jsonb_build_array(v),true,'PT401','Authentication required');
 PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"unknown@example.test","role":"authenticated"}',true);
 PERFORM pg_temp.expect_failure('non-member',jsonb_build_array(v),true,'PT403','Membership required');
 PERFORM set_config('request.jwt.claims','{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","email":"b@example.test","role":"authenticated"}',true);
 IF EXISTS(SELECT 1 FROM public.semantic_entry_requests) THEN RAISE EXCEPTION 'Another owner can read batch ledger'; END IF;
END $$;
RESET ROLE;
DO $$
DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.create_semantic_expenses(uuid,text,jsonb)','public.create_semantic_expense(uuid,text,jsonb)'] LOOP
  IF has_function_privilege('anon',signature,'execute') OR NOT has_function_privilege('authenticated',signature,'execute') THEN RAISE EXCEPTION '%: RPC grants incorrect',signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.create_semantic_expenses(uuid,text,jsonb)'::regprocedure AND prosecdef AND 'search_path=""'=ANY(proconfig)) THEN RAISE EXCEPTION 'Batch definer/search_path incorrect'; END IF;
END $$;
ROLLBACK;
SELECT 'Batch RPC validation parity, cast-boundary, trigger shares, atomicity, replay, authorization and ledger isolation: passed' AS result;
