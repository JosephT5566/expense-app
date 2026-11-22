INSERT INTO public.categories (id, name, kind, sort_order)
VALUES (
    'd9c7637a-45e6-4ba2-8f09-6a2d90c7e531',
    '運動',
    'expense',
    (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.categories WHERE kind = 'expense')
)
ON CONFLICT (name, kind) DO NOTHING;
