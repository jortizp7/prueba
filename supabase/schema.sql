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
--  Plazo y correo de quien recibe
--  Se agregaron despues de la primera version, por eso van como alter: asi
--  el archivo sirve igual para una base nueva que para una que ya existia.
--  Pueden quedar vacios en prestamos viejos: sin correo no se envia ningun
--  aviso, y sin plazo el prestamo nunca se considera vencido.
-- ---------------------------------------------------------------------------
alter table public.prestamos add column if not exists fecha_limite    date;
alter table public.prestamos add column if not exists correo_prestado text;

alter table public.prestamos drop constraint if exists plazo_no_anterior_a_entrega;
alter table public.prestamos add constraint plazo_no_anterior_a_entrega
  check (fecha_limite is null or fecha_limite >= fecha_entrega);

alter table public.prestamos drop constraint if exists correo_prestado_valido;
alter table public.prestamos add constraint correo_prestado_valido
  check (correo_prestado is null or (
    length(correo_prestado) <= 254
    and correo_prestado = lower(btrim(correo_prestado))
    and correo_prestado ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ));

comment on column public.prestamos.fecha_limite    is 'Ultimo dia para devolver. Desde el dia siguiente el prestamo esta vencido.';
comment on column public.prestamos.correo_prestado is 'Correo de quien recibe el equipo: ahi llegan la confirmacion y los recordatorios.';

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

-- La revision diaria de vencidos solo mira lo que sigue prestado.
create index if not exists prestamos_plazo_pendiente_idx
  on public.prestamos (fecha_limite)
  where devuelto_en is null;

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
  new.correo_prestado       := nullif(lower(btrim(new.correo_prestado)), '');
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
  new.fecha_limite          := old.fecha_limite;
  new.correo_prestado       := old.correo_prestado;
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
--  Correos automaticos con Brevo
--  - Confirmacion: al registrar un prestamo con correo, le llega a quien
--    recibe el equipo.
--  - Recordatorio: cada manana, a quien tenga un prestamo vencido. Se repite
--    cada pocos dias (ajustes_correo) hasta que se marque la devolucion.
--  Los correos salen de la base y no del navegador, porque la llave de Brevo
--  es secreta: vive en Supabase Vault con el nombre brevo_api_key. Mientras
--  esa llave no exista, la app funciona igual y simplemente no se envia nada.
-- ============================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
--  Ajustes: una sola fila. El remitente tiene que estar verificado en Brevo
--  (Senders, Domains & Dedicated IPs > Senders).
-- ---------------------------------------------------------------------------
create table if not exists public.ajustes_correo (
  id                        boolean  primary key default true check (id),
  remitente_correo          text     not null,
  remitente_nombre          text     not null,
  dias_entre_recordatorios  integer  not null default 3
                                     check (dias_entre_recordatorios between 1 and 30)
);

comment on table public.ajustes_correo is 'Remitente y frecuencia de los correos automaticos. Se edita desde el SQL Editor.';

insert into public.ajustes_correo (remitente_correo, remitente_nombre)
values ('jortiz@equitel.com.co', 'Préstamos de equipos · Cumandes')
on conflict (id) do nothing;

alter table public.ajustes_correo enable row level security;
revoke all on public.ajustes_correo from anon, authenticated;

-- ---------------------------------------------------------------------------
--  Registro de lo que se envio. Sirve para no repetir recordatorios y para
--  revisar que paso con un correo: solicitud_id es el id de pg_net, y la
--  respuesta de Brevo queda unas horas en net._http_response.
-- ---------------------------------------------------------------------------
create table if not exists public.avisos_correo (
  id            bigint       generated always as identity primary key,
  prestamo_id   uuid         not null references public.prestamos (id) on delete cascade,
  tipo          text         not null check (tipo in ('confirmacion', 'vencido')),
  para          text         not null,
  solicitud_id  bigint,
  enviado_en    timestamptz  not null default now()
);

create index if not exists avisos_correo_prestamo_idx
  on public.avisos_correo (prestamo_id, tipo, enviado_en desc);

alter table public.avisos_correo enable row level security;
revoke all on public.avisos_correo from anon, authenticated;

-- ---------------------------------------------------------------------------
--  Piezas del correo. Todo texto que escribio una persona pasa por
--  html_escapar antes de entrar al HTML: un equipo llamado "<b>" se lee
--  literal y no rompe ni altera el correo.
-- ---------------------------------------------------------------------------
create or replace function public.html_escapar(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(replace(coalesce(t, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

-- Las fechas se escriben a mano en espanol: no depende del idioma del servidor.
create or replace function public.fecha_larga_es(d date)
returns text
language sql
immutable
set search_path = ''
as $$
  select extract(day from d)::int || ' de ' ||
         (array['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'])[extract(month from d)::int]
         || ' de ' || extract(year from d)::int;
$$;

create or replace function public.correo_detalle(etiqueta text, valor text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '<tr><td style="padding:6px 16px 6px 0;color:#6B7075;vertical-align:top;white-space:nowrap;">'
         || etiqueta || '</td><td style="padding:6px 0;font-weight:600;color:#111111;">'
         || valor || '</td></tr>';
$$;

-- Marco comun: tablas y estilos en linea, que es lo que respetan Outlook y
-- Gmail. titulo y cuerpo llegan ya escapados.
create or replace function public.correo_html(titulo text, cuerpo text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    || '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
    || '<body style="margin:0;padding:0;background:#F4F5F7;font-family:Montserrat,Arial,Helvetica,sans-serif;color:#111111;">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F7;padding:24px 12px;"><tr><td align="center">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:12px;border-top:4px solid #E52528;">'
    || '<tr><td style="padding:24px 28px 6px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6B7075;">Cumandes · Préstamos de equipos</td></tr>'
    || '<tr><td style="padding:0 28px;font-size:20px;font-weight:700;line-height:1.3;">' || titulo || '</td></tr>'
    || '<tr><td style="padding:14px 28px 28px;font-size:15px;line-height:1.55;">' || cuerpo || '</td></tr>'
    || '</table>'
    || '<p style="max-width:560px;margin:14px auto 0;font-size:12px;line-height:1.5;color:#6B7075;">Este correo se envió automáticamente desde la herramienta de préstamos de equipos.</p>'
    || '</td></tr></table></body></html>';
$$;

-- ---------------------------------------------------------------------------
--  Envio por la API de Brevo. pg_net encola la peticion y la manda despues
--  de confirmar la transaccion: si el registro del prestamo falla, no sale
--  ningun correo, y el registro nunca espera a Brevo.
--  Devuelve el id de la solicitud, o null si falta configurar algo.
-- ---------------------------------------------------------------------------
create or replace function public.enviar_correo_brevo(
  para        text,
  nombre      text,
  asunto      text,
  html        text,
  responder_a text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  llave   text;
  ajustes public.ajustes_correo;
  cuerpo  jsonb;
begin
  select ds.decrypted_secret into llave
  from vault.decrypted_secrets ds
  where ds.name = 'brevo_api_key';

  if llave is null or btrim(llave) = '' then
    raise warning 'Falta la llave brevo_api_key en Vault: no se envio el correo a %.', para;
    return null;
  end if;

  select * into ajustes from public.ajustes_correo where id;
  if ajustes.remitente_correo is null then
    raise warning 'Falta el remitente en ajustes_correo: no se envio el correo a %.', para;
    return null;
  end if;

  cuerpo := jsonb_build_object(
    'sender',      jsonb_build_object('email', ajustes.remitente_correo, 'name', ajustes.remitente_nombre),
    'to',          jsonb_build_array(jsonb_build_object('email', para, 'name', nombre)),
    'subject',     asunto,
    'htmlContent', html
  );
  if responder_a is not null then
    cuerpo := cuerpo || jsonb_build_object('replyTo', jsonb_build_object('email', responder_a));
  end if;

  return net.http_post(
    url                  := 'https://api.brevo.com/v3/smtp/email',
    body                 := cuerpo,
    headers              := jsonb_build_object(
                              'api-key',      btrim(llave),
                              'Content-Type', 'application/json',
                              'Accept',       'application/json'),
    timeout_milliseconds := 10000
  );
end;
$$;

-- ---------------------------------------------------------------------------
--  Confirmacion al registrar. Las respuestas le llegan a quien registro el
--  prestamo, que es quien puede aclarar si algo no coincide.
-- ---------------------------------------------------------------------------
create or replace function public.prestamos_enviar_confirmacion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  detalles  text;
  solicitud bigint;
begin
  if new.correo_prestado is null then
    return null;
  end if;

  begin
    detalles := public.correo_detalle('Equipo', public.html_escapar(new.equipo))
             || public.correo_detalle('Fecha de entrega', public.fecha_larga_es(new.fecha_entrega));
    if new.fecha_limite is not null then
      detalles := detalles
             || public.correo_detalle('Devolver a más tardar', public.fecha_larga_es(new.fecha_limite));
    end if;
    if new.nota is not null then
      detalles := detalles || public.correo_detalle('Nota', public.html_escapar(new.nota));
    end if;

    solicitud := public.enviar_correo_brevo(
      new.correo_prestado,
      new.prestado_a,
      'Confirmación de préstamo: ' || new.equipo,
      public.correo_html(
        'Confirmación de tu préstamo',
        '<p style="margin:0 0 14px;">Hola ' || public.html_escapar(new.prestado_a) || ', ¿cómo estás?</p>'
        || '<p style="margin:0 0 14px;">Te confirmamos que recibiste este equipo en préstamo:</p>'
        || '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;font-size:15px;">' || detalles || '</table>'
        || '<p style="margin:0 0 14px;">Recuerda devolverlo a tiempo. Si algo no coincide con lo que recibiste, responde a este correo.</p>'
        || '<p style="margin:0;color:#6B7075;font-size:13px;">Registrado por ' || public.html_escapar(new.registrado_por_correo) || '</p>'
      ),
      new.registrado_por_correo
    );

    if solicitud is not null then
      insert into public.avisos_correo (prestamo_id, tipo, para, solicitud_id)
      values (new.id, 'confirmacion', new.correo_prestado, solicitud);
    end if;
  exception when others then
    -- Un problema con el correo nunca debe impedir registrar el prestamo.
    raise warning 'No se pudo programar la confirmacion del prestamo %: %', new.id, sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists prestamos_enviar_confirmacion_trg on public.prestamos;
create trigger prestamos_enviar_confirmacion_trg
  after insert on public.prestamos
  for each row execute function public.prestamos_enviar_confirmacion();

-- ---------------------------------------------------------------------------
--  Recordatorios de vencidos. Un prestamo vence al dia siguiente de su
--  fecha limite. Las respuestas le llegan al remitente, que es quien
--  administra las devoluciones. Devuelve cuantos correos programo.
-- ---------------------------------------------------------------------------
create or replace function public.enviar_recordatorios_vencidos()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  hoy       date := (now() at time zone 'America/Bogota')::date;
  cada      integer;
  p         record;
  dias      integer;
  solicitud bigint;
  enviados  integer := 0;
begin
  select a.dias_entre_recordatorios into cada from public.ajustes_correo a where a.id;
  cada := coalesce(cada, 3);

  for p in
    select pr.*
    from public.prestamos pr
    where pr.devuelto_en is null
      and pr.correo_prestado is not null
      and pr.fecha_limite < hoy
      and not exists (
        select 1
        from public.avisos_correo av
        where av.prestamo_id = pr.id
          and av.tipo = 'vencido'
          and (av.enviado_en at time zone 'America/Bogota')::date > hoy - cada
      )
    order by pr.fecha_limite
  loop
    begin
      dias := hoy - p.fecha_limite;

      solicitud := public.enviar_correo_brevo(
        p.correo_prestado,
        p.prestado_a,
        'Recordatorio: devuelve ' || p.equipo,
        public.correo_html(
          'Tu préstamo está vencido',
          '<p style="margin:0 0 14px;">Hola ' || public.html_escapar(p.prestado_a) || ', ¿cómo estás?</p>'
          || '<p style="margin:0 0 14px;">Te recordamos que tu equipo prestado fue este, y el plazo para devolverlo ya venció:</p>'
          || '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;font-size:15px;">'
          || public.correo_detalle('Equipo', public.html_escapar(p.equipo))
          || public.correo_detalle('Entregado el', public.fecha_larga_es(p.fecha_entrega))
          || public.correo_detalle('Plazo vencido el', public.fecha_larga_es(p.fecha_limite)
               || ' (hace ' || dias || case when dias = 1 then ' día)' else ' días)' end)
          || '</table>'
          || '<p style="margin:0 0 14px;">Por favor devuélvelo lo antes posible.</p>'
          || '<p style="margin:0;">Si ya lo devolviste, responde a este correo para que quede registrado.</p>'
        )
      );

      if solicitud is null then
        -- Sin llave o sin remitente fallaria igual con los demas.
        exit;
      end if;

      insert into public.avisos_correo (prestamo_id, tipo, para, solicitud_id)
      values (p.id, 'vencido', p.correo_prestado, solicitud);
      enviados := enviados + 1;
    exception when others then
      raise warning 'No se pudo programar el recordatorio del prestamo %: %', p.id, sqlerrm;
    end;
  end loop;

  return enviados;
end;
$$;

-- Estas funciones mandan correos desde la cuenta de Brevo: nadie las puede
-- llamar desde el navegador. Solo las usan el trigger y la tarea diaria.
revoke all on function public.html_escapar(text)                               from public, anon, authenticated;
revoke all on function public.fecha_larga_es(date)                             from public, anon, authenticated;
revoke all on function public.correo_detalle(text, text)                       from public, anon, authenticated;
revoke all on function public.correo_html(text, text)                          from public, anon, authenticated;
revoke all on function public.enviar_correo_brevo(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.prestamos_enviar_confirmacion()                  from public, anon, authenticated;
revoke all on function public.enviar_recordatorios_vencidos()                  from public, anon, authenticated;

-- Todos los dias a las 8:00 a. m. de Colombia (13:00 UTC). Volver a ejecutar
-- este archivo actualiza la tarea en lugar de duplicarla. Va dentro de un
-- bloque para que el SQL Editor responda "Success" y no una tabla suelta.
do $tarea$
begin
  perform cron.schedule(
    'prestamos-recordatorios-vencidos',
    '0 13 * * *',
    'select public.enviar_recordatorios_vencidos()'
  );
end
$tarea$;

-- ============================================================================
--  Listo. Siguiente paso: Authentication > Sign In / Providers > Email, y
--  crear los usuarios del equipo en Authentication > Users > Add user.
--  La cuenta del administrador se crea igual, con el correo de la tabla
--  administradores. Para sumar otro administrador:
--    insert into public.administradores (correo) values ('otro@equitel.com.co');
--  Para los correos falta guardar la llave de Brevo en Vault: ver
--  supabase/llave-brevo.sql.
-- ============================================================================
