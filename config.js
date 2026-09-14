// ---------------------------------------------------------------------------
//  Credenciales del proyecto de Supabase
//
//  Reemplaza los dos valores de abajo con los de tu proyecto:
//    url      -> Supabase > Project Settings > Data API > Project URL
//    anonKey  -> Supabase > Project Settings > API Keys > Publishable key
//                (sb_publishable_...). En proyectos con llaves antiguas sirve
//                igual la "anon / public" de la pestana Legacy API keys.
//
//  Esa llave es PUBLICA por diseno: viaja al navegador de cada persona y no
//  es un secreto. Lo que protege los datos son las politicas RLS y los
//  triggers de supabase/schema.sql, no ocultar esta llave. Nunca pongas aqui
//  la Secret key ni la service_role: esas si saltan RLS y jamas deben salir
//  de un servidor.
// ---------------------------------------------------------------------------

window.CONFIG_SUPABASE = {
  url: "https://TU-PROYECTO.supabase.co",
  anonKey: "TU_ANON_KEY",
};
