# Gestión de equipos

Control de préstamos y devoluciones: qué equipo salió, a quién, hasta cuándo y cuándo volvió.

Secciones:

1. **Dashboard** — cuatro cifras (equipos, prestados, disponibles, vencidos), lo que
   requiere atención (vencidos y lo que vence hoy o mañana) y los préstamos recientes.
2. **Equipos** — el catálogo, con código (EQ-001…), categoría y estado, buscador e
   historial de cada equipo. El administrador agrega equipos uno a uno o pegando una
   lista desde Excel, los edita y los da de baja.
3. **Préstamos** — lo que sigue afuera: prestados, vencidos y los que vencen pronto.
4. **Historial** — todos los préstamos con buscador (equipo, persona o código), filtros y
   la duración de cada uno.
5. **Reportes** (solo administrador) — equipos más solicitados, personas con más
   préstamos, tiempo promedio, devoluciones a tiempo, retrasos y préstamos por mes.

**+ Nuevo préstamo** pide el equipo (se elige del catálogo, solo los disponibles), la
persona responsable, su correo (opcional), la fecha de préstamo, la fecha prevista de
devolución y observaciones. La devolución pide confirmación antes de guardarse.

Si el préstamo tiene correo, a esa persona le llegan correos automáticos, enviados con
[Brevo](https://www.brevo.com):

- **Confirmación**, apenas se registra: qué equipo recibió, cuándo y hasta cuándo lo puede
  tener.
- **Recordatorio**, si se pasa del plazo: sale a las 8:00 a. m. del día siguiente al
  vencimiento y se repite cada 3 días hasta que el administrador marque la devolución.
- **Devolución**, cuando el administrador la marca: qué equipo devolvió y cuándo. Sale una
  sola vez por préstamo.

Dos roles:

| | Usuario normal | Administrador |
|---|---|---|
| Registrar préstamos | Sí | Sí |
| Ver préstamos | Solo los que registró | Todos |
| Ver el catálogo | Sí, y si cada equipo está disponible | Sí, y quién lo tiene |
| Editar el catálogo | No | Sí |
| Marcar devoluciones y recordar | No | Sí |
| Reportes | No | Sí |

El administrador es `jortiz@equitel.com.co`. Los botones **Devolver** y **Recordar** solo
le aparecen a él. **Recordar** envía en ese momento un correo a quien tiene el equipo
(no repite si ya se envió uno hace menos de 10 minutos).

## Cómo está hecho

HTML, CSS y JavaScript sin build ni dependencias que instalar. El único paquete externo
es el cliente de Supabase, que se carga desde CDN. Se puede publicar tal cual en
cualquier hosting estático.

```
index.html            Las tres pantallas
assets/styles.css     Sistema visual, tema claro y oscuro
assets/app.js         Sesión, lista, registro y devolución
config.js             URL y anon key de tu proyecto de Supabase
supabase/schema.sql   Tablas, índices, rol de administrador, políticas RLS, triggers y correos
supabase/llave-brevo.sql  Plantilla para guardar la llave de Brevo en Supabase Vault
```

---

## Puesta en marcha

### 1. Crear el proyecto en Supabase

1. Entra a [supabase.com](https://supabase.com) y crea una cuenta.
2. **New project**. Ponle un nombre (por ejemplo `prestamos-equipos`), define la
   contraseña de la base de datos y elige la región más cercana (`East US` funciona
   bien desde Colombia).
3. Espera a que el proyecto termine de aprovisionarse: toma un par de minutos.

### 2. Crear la tabla

1. En el menú lateral entra a **SQL Editor** y abre **New query**.
2. Copia el contenido completo de [supabase/schema.sql](supabase/schema.sql), pégalo y
   pulsa **Run**.
3. Debe responder `Success`. Puedes volver a ejecutarlo cuantas veces quieras: no
   duplica ni borra nada.

Esto crea la tabla `prestamos` y activa Row Level Security, que es lo que impide que
alguien sin sesión lea o escriba los datos, y que un usuario normal vea préstamos ajenos
o marque devoluciones. También crea la tabla `administradores` con el correo del
administrador.

Cada vez que cambie `schema.sql` hay que volver a ejecutarlo completo, antes de publicar
la nueva versión de la app.

### 3. Copiar las credenciales

1. Ve a **Project Settings → Data API** y copia la **Project URL**.
2. Ve a **Project Settings → API Keys** y copia la **Publishable key** (empieza por
   `sb_publishable_`). Si tu proyecto solo muestra las llaves antiguas, usa la
   **anon / public** de la pestaña **Legacy API keys**: funciona igual.
3. Abre [config.js](config.js) y reemplaza los dos valores.

Esa llave es pública por diseño: viaja al navegador de cada persona y no es un secreto.
Lo que protege los datos son las políticas RLS del paso 2. **Nunca** pongas ahí la
**Secret key** ni la `service_role`: esas sí saltan RLS y jamás deben salir de un
servidor.

### 4. Crear los usuarios del equipo

No hay registro abierto: las cuentas las creas tú, para que nadie de fuera entre.

1. **Authentication → Sign In / Providers** y confirma que **Email** está habilitado.
2. En esa misma página, en **User Signups**, desactiva **Allow new users to sign up** y
   pulsa **Save**. Este es el paso que cierra la puerta: con el registro abierto,
   cualquiera que conozca la dirección de la app puede crearse una cuenta desde fuera
   y ver todos los préstamos. Crear usuarios desde el panel sigue funcionando igual.
3. Para evitar el correo de confirmación en cuentas internas, ahí mismo, dentro de
   **Email**, desactiva **Confirm email**.
4. **Authentication → Users → Add user → Create new user**. Escribe el correo y una
   contraseña, y marca **Auto Confirm User**.
5. Repite para cada persona del equipo, incluido el administrador con
   `jortiz@equitel.com.co`: su cuenta se crea igual que las demás, y el rol lo da la
   tabla `administradores`.

Para sumar otro administrador, en **SQL Editor**:

```sql
insert into public.administradores (correo) values ('otro@equitel.com.co');
```

Y para quitarle el rol a alguien:

```sql
delete from public.administradores where correo = 'otro@equitel.com.co';
```

La base aplica el cambio de inmediato; la pantalla lo refleja la próxima vez que esa
persona abra la app. Esa tabla no se puede
leer ni modificar desde el navegador: nadie puede nombrarse administrador a sí mismo.

### 4b. Recuperar contraseña

En la pantalla de entrar está **¿Olvidaste tu contraseña?**: la persona escribe su correo,
le llega un enlace y, al abrirlo, la app le pide una contraseña nueva antes de dejarla
entrar. Lo resuelve Supabase Auth; la app solo necesita estos ajustes:

1. **Authentication → URL Configuration**: en **Site URL** va
   `https://prestamos-de-equipos.vercel.app`, y en **Redirect URLs** se agrega
   `https://prestamos-de-equipos.vercel.app/**`. Sin esto, el enlace del correo lleva a
   otra dirección.
2. **Authentication → Emails → SMTP Settings**: el servicio de correo que trae Supabase
   solo envía a los miembros del equipo del proyecto y muy pocos por hora. Para que le
   llegue a cualquiera hay que activar **Custom SMTP** con Brevo: host
   `smtp-relay.brevo.com`, puerto `587`, usuario y clave SMTP de **Brevo → SMTP y API →
   SMTP** (la clave empieza por `xsmtpsib-`), remitente `jortiz@equitel.com.co`.
3. Opcional: **Authentication → Emails → Templates → Reset Password**, para dejar el
   correo en español.

### 5. Conectar Brevo para los correos

Sin este paso la app funciona igual; simplemente no envía correos.

Se usan los **correos transaccionales** de Brevo (uno por evento, enviados por API), no
las **campañas de marketing**, que son envíos masivos que se arman a mano.

1. **Verifica el remitente.** En Brevo, entra a **Senders, Domains & Dedicated IPs →
   Senders → Add a sender** y agrega `jortiz@equitel.com.co`. Brevo manda un código a
   ese buzón para confirmarlo. Sin esto Brevo rechaza los envíos.
2. **Autentica el dominio (recomendado).** En **Domains**, agrega `equitel.com.co` y pide
   a quien administre el DNS de la empresa que publique los registros que muestra Brevo.
   Sin esto los correos pueden llegar a spam.
3. **Crea la llave de API.** En el menú de tu cuenta, **SMTP & API → API Keys → Generate
   a new API key**. Empieza por `xkeysib-`. Cópiala: Brevo solo la muestra una vez.
4. **Guárdala en Supabase.** En **SQL Editor**, pega
   [supabase/llave-brevo.sql](supabase/llave-brevo.sql), reemplaza `PEGA_AQUI_TU_LLAVE`
   por la llave y pulsa **Run**. Queda cifrada en Supabase Vault. **No** la escribas en
   ningún archivo del repositorio ni en `config.js`.
5. **Prueba.** Registra un préstamo con tu propio correo. Debe llegarte la confirmación
   en menos de un minuto.

El remitente y la frecuencia de los recordatorios están en la tabla `ajustes_correo`:

```sql
update public.ajustes_correo set remitente_correo = 'prestamos@equitel.com.co';
update public.ajustes_correo set dias_entre_recordatorios = 7;
```

Si un correo no llega, esta consulta muestra lo último que se envió y qué respondió Brevo
(la respuesta se guarda solo unas horas):

```sql
select a.tipo, a.para, a.enviado_en, r.status_code, r.content
from public.avisos_correo a
left join net._http_response r on r.id = a.solicitud_id
order by a.enviado_en desc
limit 10;
```

Un `status_code` 201 significa que Brevo lo aceptó. Si fue así y no llegó, revisa
**Transactional → Logs** en Brevo y la carpeta de spam.

### 6. Probarlo en local

Abrir `index.html` con doble clic **no funciona**: el navegador bloquea el inicio de
sesión en páginas abiertas desde el disco. Hace falta un servidor estático:

```powershell
# Con Python
python -m http.server 5173

# Con Node
npx serve .
```

Luego abre `http://localhost:5173`.

Si no tienes ninguno de los dos instalados, sáltate este paso: al desplegarlo en Vercel
queda accesible igual.

### 7. Publicarlo

Cualquier hosting estático sirve. Con Vercel, apuntando al repositorio, no hay nada que
configurar: no hay build, y el sitio se actualiza en cada push.

El proyecto `prestamos-de-equipos` en Vercel hoy **no** está enlazado al repositorio: se
publica subiendo la carpeta, así que un push a GitHub no cambia lo publicado.

---

## Decisiones que conviene conocer

**Los permisos los aplica la base, no la pantalla.** Esconder el botón *Devolver* o los
préstamos ajenos en la app es solo cortesía. Lo que de verdad lo impide son las políticas
RLS de `schema.sql`: aunque alguien llame la API a mano con su sesión, Supabase solo le
devuelve sus propios préstamos y le rechaza cualquier devolución si no es administrador.

**"Sus préstamos" son los que registró.** Un usuario normal ve los préstamos que registró
con su cuenta, no los que se le entregaron a él. El campo *a quién* es texto libre y no
está atado a ninguna cuenta, así que no hay forma segura de saber que `Carlos Ruiz` es
tal usuario. Si más adelante se quiere que cada persona vea lo que tiene en su poder, el
campo *a quién* tiene que pasar a ser una cuenta elegida de una lista.

**Los préstamos no se borran.** No hay política de `DELETE`, así que RLS bloquea
cualquier borrado desde el navegador, también para el administrador. Un préstamo solo
cambia de estado a devuelto, y cada fila muestra quién la registró y quién marcó la
devolución.

**Una devolución no se puede sobrescribir.** El `UPDATE` filtra por `devuelto_en is null`.
Si dos administradores tocan *Devolver* a la vez, el segundo no pisa el registro del
primero: la app le dice que ya estaba devuelto y refresca la lista.

**La base no le cree al navegador.** Dos triggers en `schema.sql` cierran lo que las
políticas dejan abierto, incluso para alguien que llame la API a mano con una sesión
válida: quién registró y cuándo salen de la sesión y del reloj del servidor; un préstamo
siempre nace sin devolver y con fecha de entrega que no puede ser futura; una
actualización no puede cambiar el equipo, la persona, la fecha ni el autor; y una
devolución ya registrada no se puede deshacer ni reescribir.

**Las fechas se calculan en hora de Colombia.** `fecha_entrega` se guarda como `date`,
sin hora, y el día de hoy se resuelve siempre en `America/Bogota`. Un celular mal
configurado o alguien conectado desde otro país no cambia qué día es para el registro.

**El estado nunca depende solo del color.** Cada fila lo comunica por tres canales a la
vez: un glifo con silueta propia (cuadro macizo si está prestado, cuadro perforado si se
devolvió), la etiqueta escrita, y la frase completa. Al sol, en escala de grises o con
daltonismo se sigue leyendo.

**El equipo se elige del catálogo.** Desde la versión 2 cada préstamo apunta a un equipo
con código, así que el historial y los reportes por equipo son confiables. La base impide
prestar dos veces el mismo equipo al mismo tiempo y prestar uno dado de baja. Los
préstamos registrados antes del catálogo conservan el nombre escrito a mano y aparecen en
el historial sin código.

**Quién tiene cada equipo es privado.** Un usuario normal ve si un equipo está disponible
o prestado, pero no a quién, salvo en los préstamos que registró él. Eso lo resuelve la
función `estado_equipos()` en la base, no la pantalla.

**Un préstamo vence al día siguiente de su plazo.** Si el plazo es el 3 de octubre, ese día
todavía está a tiempo; desde el 4 aparece como *Vencido* y sale el recordatorio. Los
préstamos registrados antes de que existiera el plazo no tienen fecha límite: nunca se
marcan como vencidos ni reciben recordatorios.

**Los correos salen de la base, no del navegador.** La llave de Brevo es secreta: si
estuviera en la página, cualquiera podría leerla y mandar correos a tu nombre. Por eso la
confirmación la envía un trigger de Supabase al registrar, y los recordatorios una tarea
diaria de `pg_cron`. Nadie puede usar esas funciones desde el navegador, y un fallo con
Brevo nunca impide registrar un préstamo.

**El plazo y el correo no se editan.** Igual que el equipo y la fecha de entrega, quedan
fijos al registrar. Si están mal, lo correcto hoy es marcar la devolución y registrar el
préstamo de nuevo.
