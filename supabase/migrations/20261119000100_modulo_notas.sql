-- Módulo de ejemplo "notas": notas y recordatorios.
-- Convención para las tablas de cualquier módulo:
--   * nombre <modulo>_<tabla>
--   * id uuid, creado_en y actualizado_en (con el trigger tocar_actualizado)
--   * RLS activado sin políticas + revoke a anon/authenticated (solo entra la Edge Function)

create table public.notas_notas (
  id                 uuid primary key default gen_random_uuid(),
  titulo             text not null,
  contenido          text,
  etiquetas          text[] not null default '{}',
  fecha_recordatorio date,
  hecha              boolean not null default false,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);
create trigger notas_notas_tocar before update on public.notas_notas
  for each row execute function public.tocar_actualizado();

alter table public.notas_notas enable row level security;
revoke all on public.notas_notas from anon, authenticated;
