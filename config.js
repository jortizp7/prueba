// ---------------------------------------------------------------------------
//  Credenciales del proyecto de Supabase
//
//  Reemplaza los dos valores de abajo con los de tu proyecto. Los encuentras en
//  Supabase > Project Settings > Data API  (y la llave en > API Keys).
//
//  La anon key es PUBLICA por diseno: viaja al navegador de cada persona y no
//  es un secreto. Lo que protege los datos son las politicas RLS de
//  supabase/schema.sql, no ocultar esta llave. Nunca pongas aqui la
//  service_role key: esa si salta RLS y jamas debe salir del servidor.
// ---------------------------------------------------------------------------

window.CONFIG_SUPABASE = {
  url: "https://TU-PROYECTO.supabase.co",
  anonKey: "TU_ANON_KEY",
};
