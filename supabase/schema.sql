-- ============================================================================
--  Prestamos de equipos - esquema de base de datos
--  Pegar completo en:  Supabase > SQL Editor > New query > Run
--  Es idempotente: se puede volver a ejecutar sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Tabla: prestamos
--  Un registro por prestamo. La devolucion no borra ni crea filas: marca
--  devuelto_en. Asi la misma fila cuenta la historia completa del prestamo.
-- ---------------------------------------------------------------------------
create table if not exists public.prestamos (
  id               uuid        primary key default gen_random_uuid(),

  -- Que se presto y a quien. Texto libre: el equipo se escribe a mano.
  equipo           text        not null check (length(btrim(equipo)) between 1 and 120),
  prestado_a       text        not null check (length(btrim(prestado_a)) between 1 and 120),

  -- Desde cuando lo tiene. Fecha sin hora: un prestamo ocurre en un dia,
  -- y guardarlo como date evita que la zona horaria lo corra un dia.
  fecha_entrega    date        not null,

  nota             text        check (nota is null or length(nota) <= 500),

  -- Null = sigue prestado. Con valor = devuelto en ese instante.
  -- Es el unico campo que define el estado; no hay columna "estado" que
  -- pueda quedar desincronizada.
  devuelto_en      timestamptz,

  -- Quien registro el prestamo. El id apunta a auth.users; el correo se
  -- guarda aparte porque el navegador no puede leer la tabla auth.users
  -- para resolver el nombre despues.
  registrado_por         uuid  not null references auth.users (id) on delete set null,
  registrado_por_correo  text  not null,

  -- Quien marco la devolucion (puede ser otra persona).
  devuelto_por_correo    text,

  creado_en        timestamptz not null default now(),

  -- Un equipo no se puede devolver antes de entregarlo.
  constraint devolucion_no_anterior_a_entrega
    check (devuelto_en is null or devuelto_en >= fecha_entrega::timestamptz)
);

comment on table  public.prestamos                is 'Prestamos de equipos del equipo de trabajo.';
comment on column public.prestamos.devuelto_en    is 'Null = prestado. Con valor = devuelto en ese instante.';
comment on column public.prestamos.fecha_entrega  is 'Dia en que el equipo salio. Puede ser retroactiva.';

-- ---------------------------------------------------------------------------
--  Indices
--  La lista se ordena por fecha de entrega descendente y se filtra por
--  estado (devuelto_en nulo o no). Estos dos indices cubren ambas cosas.
-- ---------------------------------------------------------------------------
create index if not exists prestamos_fecha_entrega_idx
  on public.prestamos (fecha_entrega desc, creado_en desc);

create index if not exists prestamos_activos_idx
  on public.prestamos (fecha_entrega desc)
  where devuelto_en is null;

-- ---------------------------------------------------------------------------
--  Row Level Security
--  Sin esto, la anon key que viaja en el navegador dejaria la tabla abierta
--  a cualquiera. Con RLS activo, solo las sesiones autenticadas entran.
-- ---------------------------------------------------------------------------
alter table public.prestamos enable row level security;

-- Cualquier persona autenticada ve todos los prestamos: el punto de la app
-- es que el equipo tenga una sola lista compartida.
drop policy if exists "leer prestamos autenticado" on public.prestamos;
create policy "leer prestamos autenticado"
  on public.prestamos for select
  to authenticated
  using (true);

-- Al registrar, el autor queda amarrado a la sesion: nadie puede registrar
-- un prestamo a nombre de otra persona.
drop policy if exists "registrar prestamo autenticado" on public.prestamos;
create policy "registrar prestamo autenticado"
  on public.prestamos for insert
  to authenticated
  with check (registrado_por = auth.uid());

-- Cualquiera del equipo marca devoluciones: quien recibe el equipo de vuelta
-- no siempre es quien lo entrego.
drop policy if exists "marcar devolucion autenticado" on public.prestamos;
create policy "marcar devolucion autenticado"
  on public.prestamos for update
  to authenticated
  using (true)
  with check (true);

-- No se declara politica de DELETE a proposito: sin ella, RLS bloquea todo
-- borrado desde el navegador. El historial de prestamos no se borra.

-- ---------------------------------------------------------------------------
--  Blindaje del registro de autoria
--  Las politicas de UPDATE permiten cambiar cualquier columna. Este trigger
--  impide que una actualizacion reescriba quien registro el prestamo, cuando
--  se creo, o los datos originales del prestamo: una devolucion solo puede
--  tocar los campos de devolucion.
-- ---------------------------------------------------------------------------
create or replace function public.prestamos_proteger_registro()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.id                    := old.id;
  new.equipo                := old.equipo;
  new.prestado_a            := old.prestado_a;
  new.fecha_entrega         := old.fecha_entrega;
  new.nota                  := old.nota;
  new.registrado_por        := old.registrado_por;
  new.registrado_por_correo := old.registrado_por_correo;
  new.creado_en             := old.creado_en;
  return new;
end;
$$;

drop trigger if exists prestamos_proteger_registro_trg on public.prestamos;
create trigger prestamos_proteger_registro_trg
  before update on public.prestamos
  for each row execute function public.prestamos_proteger_registro();

-- ============================================================================
--  Listo. Siguiente paso: Authentication > Providers > Email, y crear los
--  usuarios del equipo en Authentication > Users > Add user.
-- ============================================================================
