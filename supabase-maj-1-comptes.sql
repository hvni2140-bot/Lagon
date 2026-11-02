-- ============================================================
-- Lagon : mise à jour 1 — comptes créés par le gérant
-- À coller dans Supabase > SQL Editor > Run (une seule fois)
-- ============================================================

-- Identifiant de connexion affiché dans l'onglet Gestion
alter table public.profiles add column if not exists login text;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name, is_admin, login)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
                  split_part(new.email, '@', 1)), 40),
    not exists (select 1 from profiles),
    case when new.email like '%@lagon.example.com' then split_part(new.email, '@', 1) end
  );
  return new;
end $$;
