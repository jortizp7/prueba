-- ============================================================================
--  Llave de Brevo para los correos automaticos
--  Guarda la llave en Supabase Vault (o la reemplaza si ya existia).
--
--  1. Reemplaza PEGA_AQUI_TU_LLAVE por tu llave de API de Brevo. Empieza por
--     xkeysib- ; la que empieza por xsmtpsib- es la de SMTP y no sirve aqui.
--  2. Pulsa Run.
--
--  La llave solo se escribe en el SQL Editor de Supabase: nunca en este
--  archivo del repositorio, en config.js ni en ninguna parte de la app.
-- ============================================================================
do $$
declare
  llave     text := btrim('PEGA_AQUI_TU_LLAVE');
  existente uuid;
begin
  if llave not like 'xkeysib-%' then
    raise exception 'Pega tu llave de API de Brevo (empieza por xkeysib-) en lugar de PEGA_AQUI_TU_LLAVE.';
  end if;

  select s.id into existente from vault.secrets s where s.name = 'brevo_api_key';

  if existente is null then
    perform vault.create_secret(llave, 'brevo_api_key', 'Llave de API de Brevo para los correos de prestamos');
  else
    perform vault.update_secret(existente, llave);
  end if;
end $$;
