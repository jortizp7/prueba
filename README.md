# Préstamos de equipos

Registro compartido de qué equipo se prestó, a quién, desde cuándo, y cuándo lo devolvieron.

Tres pantallas:

1. **Entrar** — correo y contraseña. Sin sesión iniciada no se ve nada.
2. **La lista** — los préstamos con su estado y un filtro: prestados / devueltos / todos.
3. **Registrar** — formulario con equipo, a quién, fecha de entrega y nota opcional.

Dos roles:

| | Usuario normal | Administrador |
|---|---|---|
| Registrar préstamos | Sí | Sí |
| Ver préstamos | Solo los que registró | Todos |
| Marcar devoluciones | No | Sí |

El administrador es `jortiz@equitel.com.co`. El botón **Devolver** solo le aparece a él,
en cada fila que sigue prestada: se marca la devolución con el equipo en la otra mano,
sin abrir un formulario.

## Cómo está hecho

HTML, CSS y JavaScript sin build ni dependencias que instalar. El único paquete externo
es el cliente de Supabase, que se carga desde CDN. Se puede publicar tal cual en
cualquier hosting estático.

```
index.html            Las tres pantallas
assets/styles.css     Sistema visual, tema claro y oscuro
assets/app.js         Sesión, lista, registro y devolución
config.js             URL y anon key de tu proyecto de Supabase
supabase/schema.sql   Tablas, índices, rol de administrador, políticas RLS y triggers
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

### 5. Probarlo en local

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

### 6. Publicarlo

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

**El campo equipo es texto libre.** Es lo que se pidió para esta versión. Vale la pena
saber que `Taladro Bosch`, `taladro bosch` y `Taladro` se registran como tres cosas
distintas: si más adelante hace falta un historial confiable por equipo, el siguiente
paso es un catálogo del que se elija en vez de escribir.

**No hay fecha de devolución esperada,** así que la app no tiene concepto de préstamo
vencido ni alertas. Muestra hace cuántos días salió cada equipo, que es lo que se puede
afirmar con los datos que hay.
