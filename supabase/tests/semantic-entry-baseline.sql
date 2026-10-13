-- Synthetic local assertions only. The database-name guard rejects production.
DO $$ BEGIN
 IF current_database() <> 'jopie_baseline_test' THEN
  RAISE EXCEPTION 'This test requires the disposable jopie_baseline_test database';
 END IF;
END $$;
BEGIN;
INSERT INTO public.app_settings(id,allowed_emails) VALUES(true,ARRAY['a@example.test','b@example.test']::public.citext[]);
INSERT INTO public.categories(id,name,kind) VALUES('11111111-1111-4111-8111-111111111111','Synthetic Other','expense');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims='{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","email":"a@example.test","role":"authenticated"}';
DO $$
DECLARE
 payload jsonb := jsonb_build_object('note','synthetic baseline test','amount',851,'currency','TWD','ts',((now() at time zone 'Asia/Taipei')::date::timestamp at time zone 'Asia/Taipei'),'payer_email','a@example.test','scope','household','shares_json',jsonb_build_object('a@example.test',426,'b@example.test',425),'category_id','11111111-1111-4111-8111-111111111111','is_settled',false);
 first_result jsonb;
 replay jsonb;
 expense_identifier uuid;
 i integer;
BEGIN
 first_result := public.create_semantic_expense('12345678-1234-4123-8123-123456789abc',repeat('a',64),payload);
 expense_identifier := (first_result->'expense'->>'id')::uuid;
 IF first_result->>'replayed' <> 'false' THEN RAISE EXCEPTION 'First write unexpectedly replayed'; END IF;
 IF first_result->'expense'->'meta' <> '{}'::jsonb THEN RAISE EXCEPTION 'Actual JSONB default not preserved'; END IF;
 IF (SELECT count(*) FROM public.expense_shares WHERE expense_id=expense_identifier) <> 2 THEN RAISE EXCEPTION 'Share trigger did not run'; END IF;
 IF (SELECT sum(share_amount) FROM public.expense_shares WHERE expense_id=expense_identifier) <> 851 THEN RAISE EXCEPTION 'Share amounts changed'; END IF;
 replay := public.create_semantic_expense('12345678-1234-4123-8123-123456789abc',repeat('a',64),payload);
 IF replay->>'replayed' <> 'true' OR replay->'expense' <> first_result->'expense' THEN RAISE EXCEPTION 'Replay changed result'; END IF;
 BEGIN
  PERFORM public.create_semantic_expense('12345678-1234-4123-8123-123456789abc',repeat('b',64),payload);
  RAISE EXCEPTION 'Changed input hash accepted';
 EXCEPTION WHEN SQLSTATE 'PT409' THEN NULL;
 END;
 BEGIN
  PERFORM public.create_semantic_expense('22345678-1234-4123-8123-123456789abc',repeat('a',64),payload || '{"amount":-1}'::jsonb);
  RAISE EXCEPTION 'Invalid amount accepted';
 EXCEPTION WHEN SQLSTATE 'PT422' THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM public.semantic_entry_requests WHERE request_id='22345678-1234-4123-8123-123456789abc') THEN RAISE EXCEPTION 'Rejected write retained ledger'; END IF;
 UPDATE public.expenses SET note='edited synthetic row' WHERE id=expense_identifier;
 replay := public.create_semantic_expense('12345678-1234-4123-8123-123456789abc',repeat('a',64),payload);
 IF replay->'expense' <> first_result->'expense' THEN RAISE EXCEPTION 'Edited row changed snapshot'; END IF;
 DELETE FROM public.expenses WHERE id=expense_identifier;
 replay := public.create_semantic_expense('12345678-1234-4123-8123-123456789abc',repeat('a',64),payload);
 IF replay->'expense' <> first_result->'expense' OR EXISTS(SELECT 1 FROM public.expenses WHERE id=expense_identifier) THEN RAISE EXCEPTION 'Deleted row was recreated'; END IF;
 FOR i IN 1..100 LOOP
  IF NOT public.consume_semantic_entry_quota() THEN RAISE EXCEPTION 'Quota denied before 100'; END IF;
 END LOOP;
 IF public.consume_semantic_entry_quota() THEN RAISE EXCEPTION 'Quota allowed attempt 101'; END IF;
 PERFORM set_config('request.jwt.claims','{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","email":"b@example.test","role":"authenticated"}',true);
 IF EXISTS(SELECT 1 FROM public.semantic_entry_requests) THEN RAISE EXCEPTION 'Another owner can read request ledger'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF has_function_privilege('anon','public.create_semantic_expense(uuid,text,jsonb)','execute') THEN RAISE EXCEPTION 'Anonymous RPC execution granted'; END IF;
 IF has_table_privilege('authenticated','public.semantic_entry_requests','insert') THEN RAISE EXCEPTION 'Direct request mutation granted'; END IF;
END $$;
ROLLBACK;
SELECT 'Baseline chain, share trigger, replay/conflict, rollback, quota and ledger isolation: passed' AS result;
