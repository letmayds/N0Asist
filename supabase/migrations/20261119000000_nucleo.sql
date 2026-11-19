-- Núcleo del agente general: conversaciones, operaciones a confirmar, eventos entre módulos y trazas.
-- Todas las tablas tienen RLS activado y SIN políticas: desde el navegador (anon/authenticated) no se
-- puede leer ni escribir nada. Solo la Edge Function "agente" (con la clave secreta) accede.

create or replace function public.tocar_actualizado() returns trigger
language plpgsql as $$
begin
  new.actualizado_en = now();
  return new;
end $$;

-- Conversación con el agente general (orquestador)
create table public.conversaciones (
  id             uuid primary key default gen_random_uuid(),
  titulo         text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create trigger conversaciones_tocar before update on public.conversaciones
  for each row execute function public.tocar_actualizado();

-- Historial completo (bloques de la API de Claude tal cual, append-only)
create table public.mensajes (
  id              bigint generated always as identity primary key,
  conversacion_id uuid not null references public.conversaciones(id) on delete cascade,
  orden           int  not null,
  rol             text not null check (rol in ('user', 'assistant')),
  contenido       jsonb not null,
  creado_en       timestamptz not null default now(),
  unique (conversacion_id, orden)
);

-- Altas, cambios y bajas que proponen los módulos. Se aplican solo cuando el dueño toca "Confirmar".
create table public.operaciones (
  id              bigint generated always as identity primary key,
  conversacion_id uuid references public.conversaciones(id) on delete set null,
  modulo          text not null,
  tabla           text not null,
  tipo            text not null check (tipo in ('alta', 'cambio', 'baja')),
  registro_id     uuid,
  datos           jsonb,
  resumen         text not null,
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente', 'aplicada', 'cancelada', 'fallida')),
  resultado       jsonb,
  error           text,
  informada       boolean not null default false,  -- ya se le avisó al agente cómo terminó
  creado_en       timestamptz not null default now(),
  resuelto_en     timestamptz
);
create index operaciones_conv_idx on public.operaciones (conversacion_id, estado);

-- Bus de eventos (conectores asíncronos): cada operación aplicada publica "<modulo>.<tabla>.<tipo>"
-- y los módulos suscriptos reaccionan (código, sin IA).
create table public.eventos (
  id          bigint generated always as identity primary key,
  tipo        text not null,
  modulo      text not null,
  tabla       text,
  registro_id uuid,
  datos       jsonb,
  reacciones  jsonb,      -- [{modulo, ok, error}]
  creado_en   timestamptz not null default now()
);
create index eventos_tipo_idx on public.eventos (tipo, creado_en desc);

-- Traza de cada delegación orquestador -> módulo y módulo -> módulo (para depurar y medir)
create table public.delegaciones (
  id              bigint generated always as identity primary key,
  conversacion_id uuid references public.conversaciones(id) on delete set null,
  origen          text not null,   -- 'general' o el id del módulo que consulta
  modulo          text not null,
  pedido          text not null,
  respuesta       text,
  error           text,
  ms              int,
  creado_en       timestamptz not null default now()
);

alter table public.conversaciones enable row level security;
alter table public.mensajes       enable row level security;
alter table public.operaciones    enable row level security;
alter table public.eventos        enable row level security;
alter table public.delegaciones   enable row level security;

revoke all on public.conversaciones, public.mensajes, public.operaciones, public.eventos, public.delegaciones
  from anon, authenticated;
