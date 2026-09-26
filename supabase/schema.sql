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

  -- Quien registro el prestamo. El id apunta a auth.users y queda en null si
  -- esa cuenta se borra algun dia; el correo se guarda aparte justamente para
  -- que el historial siga diciendo quien fue.
  registrado_por         uuid  references auth.users (id) on delete set null,
  registrado_por_correo  text  not null,

  -- Quien marco la devolucion: siempre un administrador.
  devuelto_por_correo    text,

  creado_en        timestamptz not null default now(),

  -- Un equipo no se puede devolver antes de entregarlo.
  constraint devolucion_no_anterior_a_entrega
    check (devuelto_en is null or devuelto_en >= fecha_entrega::timestamptz)
);

-- Si la tabla ya existia de una version anterior de este archivo, donde
-- registrado_por era not null, se corrige: not null con "on delete set null"
-- hace fallar el borrado de cualquier usuario que haya registrado algo.
alter table public.prestamos alter column registrado_por drop not null;

comment on table  public.prestamos                is 'Prestamos de equipos del equipo de trabajo.';
comment on column public.prestamos.devuelto_en    is 'Null = prestado. Con valor = devuelto en ese instante.';
comment on column public.prestamos.fecha_entrega  is 'Dia en que el equipo salio. Puede ser retroactiva, nunca futura.';

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

-- Un usuario normal solo lee los prestamos que registro: este indice atiende
-- esa consulta sin recorrer la tabla completa.
create index if not exists prestamos_registrado_por_idx
  on public.prestamos (registrado_por, fecha_entrega desc);

-- ---------------------------------------------------------------------------
--  Administradores
--  Quien esta en esta tabla ve todos los prestamos y es el unico que marca
--  devoluciones. El resto de cuentas son usuarios normales: registran
--  prestamos y solo ven los que registraron ellos mismos.
--  Se guarda el correo y no el id para poder nombrar al administrador aunque
--  su cuenta todavia no exista en Authentication > Users.
-- ---------------------------------------------------------------------------
create table if not exists public.administradores (
  correo     text        primary key
                         check (correo = lower(btrim(correo)) and correo like '%_@_%'),
  creado_en  timestamptz not null default now()
);

comment on table public.administradores is 'Correos con rol de administrador. Se edita solo desde el SQL Editor.';

-- RLS activo y sin politicas: desde el navegador nadie la lee ni la escribe,
-- ni siquiera un administrador. Nadie puede nombrarse administrador a si mismo.
alter table public.administradores enable row level security;
revoke all on public.administradores from anon, authenticated;

insert into public.administradores (correo)
values ('jortiz@equitel.com.co')
on conflict (correo) do nothing;

-- Dice si la sesion actual es de un administrador. Corre con los permisos de
-- su dueno (security definer) para poder leer administradores y auth.users,
-- que la sesion no puede leer directamente. Compara contra el correo guardado
-- en auth.users, no contra el que viaja en el token.
create or replace function public.es_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.administradores a
    join auth.users u on lower(u.email) = a.correo
    where u.id = auth.uid()
  );
$$;

revoke all on function public.es_admin() from public, anon;
grant execute on function public.es_admin() to authenticated;

-- ---------------------------------------------------------------------------
--  Row Level Security
--  Sin esto, la anon key que viaja en el navegador dejaria la tabla abierta
--  a cualquiera. Con RLS activo, solo las sesiones autenticadas entran, y
--  cada una solo alcanza lo que su rol le permite.
-- ---------------------------------------------------------------------------
alter table public.prestamos enable row level security;

-- Cada usuario ve solo los prestamos que registro; el administrador ve todos.
-- Los select envolventes hacen que auth.uid() y es_admin() se evaluen una vez
-- por consulta y no una vez por fila.
drop policy if exists "leer prestamos autenticado" on public.prestamos;
drop policy if exists "leer prestamos propios o admin" on public.prestamos;
create policy "leer prestamos propios o admin"
  on public.prestamos for select
  to authenticated
  using (registrado_por = (select auth.uid()) or (select public.es_admin()));

-- Al registrar, el autor queda amarrado a la sesion. El trigger de abajo ya
-- lo fuerza; la politica lo exige de nuevo por si alguien quita el trigger.
drop policy if exists "registrar prestamo autenticado" on public.prestamos;
create policy "registrar prestamo autenticado"
  on public.prestamos for insert
  to authenticated
  with check (registrado_por = auth.uid());

-- Solo el administrador marca devoluciones. Lo que una actualizacion puede
-- cambiar lo limita el trigger de abajo, no esta politica.
drop policy if exists "marcar devolucion autenticado" on public.prestamos;
drop policy if exists "marcar devolucion admin" on public.prestamos;
create policy "marcar devolucion admin"
  on public.prestamos for update
  to authenticated
  using ((select public.es_admin()))
  with check ((select public.es_admin()));

-- No se declara politica de DELETE a proposito: sin ella, RLS bloquea todo
-- borrado desde el navegador. El historial de prestamos no se borra.

-- ---------------------------------------------------------------------------
--  Blindaje al registrar
--  Lo que dice quien y cuando no se le cree al navegador: se toma de la
--  sesion y del reloj del servidor. Un prestamo siempre nace sin devolver.
-- ---------------------------------------------------------------------------
create or replace function public.prestamos_al_registrar()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.fecha_entrega > (now() at time zone 'America/Bogota')::date then
    raise exception 'La fecha de entrega no puede ser futura.'
      using errcode = '23514';
  end if;

  new.registrado_por        := auth.uid();
  new.registrado_por_correo := coalesce(auth.jwt() ->> 'email', new.registrado_por_correo);
  new.creado_en             := now();
  new.devuelto_en           := null;
  new.devuelto_por_correo   := null;
  return new;
end;
$$;

drop trigger if exists prestamos_al_registrar_trg on public.prestamos;
create trigger prestamos_al_registrar_trg
  before insert on public.prestamos
  for each row execute function public.prestamos_al_registrar();

-- ---------------------------------------------------------------------------
--  Blindaje al actualizar
--  La politica de UPDATE deja tocar cualquier columna. Este trigger reduce
--  eso a una sola operacion legitima: marcar la devolucion de un prestamo
--  que sigue prestado.
--  - Los datos originales del prestamo y su autoria no cambian nunca.
--  - Una devolucion ya registrada no se puede deshacer ni reescribir.
--  - La hora y el autor de la devolucion salen del servidor y de la sesion.
-- ---------------------------------------------------------------------------
create or replace function public.prestamos_proteger_registro()
returns trigger
language plpgsql
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

  if old.devuelto_en is not null then
    new.devuelto_en         := old.devuelto_en;
    new.devuelto_por_correo := old.devuelto_por_correo;
  elsif new.devuelto_en is not null then
    new.devuelto_en         := now();
    new.devuelto_por_correo := coalesce(auth.jwt() ->> 'email', new.devuelto_por_correo);
  else
    new.devuelto_por_correo := null;
  end if;

  return new;
end;
$$;

drop trigger if exists prestamos_proteger_registro_trg on public.prestamos;
create trigger prestamos_proteger_registro_trg
  before update on public.prestamos
  for each row execute function public.prestamos_proteger_registro();

-- ============================================================================
--  Listo. Siguiente paso: Authentication > Sign In / Providers > Email, y
--  crear los usuarios del equipo en Authentication > Users > Add user.
--  La cuenta del administrador se crea igual, con el correo de la tabla
--  administradores. Para sumar otro administrador:
--    insert into public.administradores (correo) values ('otro@equitel.com.co');
-- ============================================================================
