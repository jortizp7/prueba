# Préstamos de equipos

Registro compartido de qué equipo se prestó, a quién, desde cuándo, y cuándo lo devolvieron.

Tres pantallas:

1. **Entrar** — correo y contraseña. Sin sesión iniciada no se ve nada.
2. **La lista** — todos los préstamos con su estado y un filtro: prestados / devueltos / todos.
3. **Registrar** — formulario con equipo, a quién, fecha de entrega y nota opcional.

El botón **Devolver** está en cada fila de la lista, que es donde se usa: se marca la
devolución con el equipo en la otra mano, sin abrir un formulario.

## Cómo está hecho

HTML, CSS y JavaScript sin build ni dependencias que instalar. El único paquete externo
es el cliente de Supabase, que se carga desde CDN. Se puede publicar tal cual en
cualquier hosting estático.

```
index.html            Las tres pantallas
assets/styles.css     Sistema visual, tema claro y oscuro
assets/app.js         Sesión, lista, registro y devolución
config.js             URL y anon key de tu proyecto de Supabase
supabase/schema.sql   Tabla, índices, políticas RLS y trigger
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
alguien sin sesión lea o escriba los datos.

### 3. Copiar las credenciales

1. Ve a **Project Settings → Data API** y copia la **Project URL**.
2. Ve a **Project Settings → API Keys** y copia la clave **anon / public**.
3. Ábre [config.js](config.js) y reemplaza los dos valores.

La `anon key` es pública por diseño: viaja al navegador de cada persona y no es un
secreto. Lo que protege los datos son las políticas RLS del paso 2. **Nunca** pongas ahí
la `service_role key`: esa sí salta RLS y jamás debe salir de un servidor.

### 4. Crear los usuarios del equipo

No hay registro abierto: las cuentas las creas tú, para que nadie de fuera entre.

1. **Authentication → Providers** y confirma que **Email** está habilitado.
2. Para evitar el correo de confirmación en cuentas internas, en
   **Authentication → Sign In / Providers → Email** desactiva **Confirm email**.
3. **Authentication → Users → Add user → Create new user**. Escribe el correo y una
   contraseña, y marca **Auto Confirm User**.
4. Repite para cada persona del equipo.

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

---

## Decisiones que conviene conocer

**Los préstamos no se borran.** No hay política de `DELETE`, así que RLS bloquea
cualquier borrado desde el navegador. Un préstamo solo cambia de estado a devuelto. Como
no hay rol de administrador, la trazabilidad es el único control que queda: cada fila
muestra quién la registró y quién marcó la devolución.

**Una devolución no se puede sobrescribir.** El `UPDATE` filtra por `devuelto_en is null`.
Si dos personas tocan *Devolver* a la vez, la segunda no pisa el registro de la primera:
la app le dice que ya estaba devuelto y refresca la lista. Un trigger en la base impide
además que una actualización cambie el equipo, la persona, la fecha o el autor original.

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
