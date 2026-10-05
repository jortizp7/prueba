/* ==========================================================================
   GESTIÓN DE EQUIPOS · control de préstamos y devoluciones
   Secciones: Dashboard · Equipos · Préstamos · Historial · Reportes, más el
   formulario de nuevo préstamo y las ventanas de confirmación.
   Sin sesión no se pinta nada de la app.

   Los permisos los aplica la base (RLS y funciones de schema.sql). Esta
   página solo evita ofrecer lo que la sesión no podría hacer.
   ========================================================================== */
(function () {
  "use strict";

  // ------------------------------------------------------------------------
  // Configuración y cliente
  // ------------------------------------------------------------------------
  var CONFIG = window.CONFIG_SUPABASE || {};
  var ZONA = "America/Bogota";

  var $ = function (id) { return document.getElementById(id); };

  var pantallaEntrar = $("pantalla-entrar");
  var app = $("app");

  // Enlaces que llegan desde el correo de "olvidé mi contraseña". Se leen
  // antes de crear el cliente, porque él limpia la dirección al procesarlos.
  var hashInicial = location.hash || "";
  var modoRecuperacion = hashInicial.indexOf("type=recovery") !== -1;
  var enlaceVencido = /error_code=otp_expired|error=access_denied/.test(hashInicial);

  if (!window.supabase || !CONFIG.url || !CONFIG.anonKey ||
      CONFIG.url.indexOf("TU-PROYECTO") !== -1 || CONFIG.anonKey.indexOf("TU_ANON_KEY") !== -1) {
    mostrarErrorEntrar(
      "Falta conectar la app con Supabase. En el archivo config.js hay que pegar la URL del proyecto y su llave pública (Publishable key)."
    );
    $("btn-entrar").disabled = true;
    return;
  }

  var cliente = window.supabase.createClient(CONFIG.url, CONFIG.anonKey);

  // ------------------------------------------------------------------------
  // Estado en memoria
  // ------------------------------------------------------------------------
  var usuario = null;
  var esAdmin = false;
  var prestamos = [];          // lo que RLS deja ver: propios, o todos si es admin
  var equipos = [];            // catálogo con disponibilidad (estado_equipos)
  var equiposPorId = {};
  var catalogoListo = false;   // false si la base todavía no tiene el catálogo
  var cargando = false;
  var temporizadorToast = null;

  var VISTAS = ["dashboard", "equipos", "prestamos", "historial", "reportes", "nuevo"];
  var vistaActual = "dashboard";
  var vistaAnterior = "dashboard";

  var filtroEquipos = "todos";
  var filtroPrestamos = "activos";
  var filtroHistorial = "todos";

  var prestamoPorDevolver = null;
  var equipoEditando = null;
  var equipoEnDetalle = null;

  // ------------------------------------------------------------------------
  // Fechas — todo se calcula en hora de Colombia.
  // Un celular mal configurado o alguien conectado desde otro país no debe
  // cambiar qué día es "hoy" para el registro.
  // ------------------------------------------------------------------------
  var MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
               "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  function hoyBogota() {
    // en-CA entrega el formato AAAA-MM-DD, que es justo el de una columna date.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function isoMasDias(iso, dias) {
    var p = iso.split("-");
    // Se opera en UTC a propósito: la fecha ya viene resuelta en Bogotá y así
    // sumar días no cruza ningún borde de zona horaria.
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  function diasEntre(isoDesde, isoHasta) {
    var a = isoDesde.split("-"), b = isoHasta.split("-");
    var ms = Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2]);
    return Math.round(ms / 86400000);
  }

  function fechaLarga(iso) {
    var p = iso.split("-");
    return +p[2] + " de " + MESES[+p[1] - 1] + " de " + p[0];
  }

  // "2 oct" este año; "2 oct 2025" si es de otro año, para que no se confunda.
  function fechaCorta(iso) {
    var p = iso.split("-");
    var texto = +p[2] + " " + MESES[+p[1] - 1].slice(0, 3);
    return p[0] === hoyBogota().slice(0, 4) ? texto : texto + " " + p[0];
  }

  // Instante (timestamptz) mostrado en hora de Colombia.
  function instanteLegible(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    var fecha = new Intl.DateTimeFormat("es-CO", {
      timeZone: ZONA, day: "numeric", month: "short"
    }).format(d);
    var hora = new Intl.DateTimeFormat("es-CO", {
      timeZone: ZONA, hour: "numeric", minute: "2-digit", hour12: true
    }).format(d);
    return fecha + " a las " + hora;
  }

  function isoDeInstante(ts) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(ts));
  }

  function dias(n) { return n === 1 ? "1 día" : n + " días"; }

  function frasePrestado(fechaEntrega) {
    var d = diasEntre(fechaEntrega, hoyBogota());
    if (d < 0) return "Se entrega el " + fechaCorta(fechaEntrega);
    if (d === 0) return "Entregado hoy";
    if (d === 1) return "Prestado desde ayer";
    return "Prestado hace " + d + " días";
  }

  // Un préstamo vence al día siguiente de su fecha límite: es el mismo
  // criterio con que la base manda los recordatorios (schema.sql).
  function estaVencido(p) {
    return !p.devuelto_en && !!p.fecha_limite && diasEntre(p.fecha_limite, hoyBogota()) > 0;
  }

  function estadoDe(p) {
    if (p.devuelto_en) return "devuelto";
    return estaVencido(p) ? "vencido" : "prestado";
  }

  function frasePlazo(fechaLimite) {
    var d = diasEntre(hoyBogota(), fechaLimite);
    if (d < 0) return "Venció el " + fechaCorta(fechaLimite) + ", hace " + dias(-d);
    if (d === 0) return "Vence hoy";
    if (d === 1) return "Vence mañana";
    return "Devolver a más tardar el " + fechaCorta(fechaLimite);
  }

  function fraseDevuelto(devueltoEn) {
    var d = diasEntre(isoDeInstante(devueltoEn), hoyBogota());
    if (d === 0) return "Devuelto hoy";
    if (d === 1) return "Devuelto ayer";
    return "Devuelto el " + fechaCorta(isoDeInstante(devueltoEn));
  }

  function duracion(p) {
    var fin = p.devuelto_en ? isoDeInstante(p.devuelto_en) : hoyBogota();
    var d = Math.max(0, diasEntre(p.fecha_entrega, fin));
    var texto = d === 0 ? "Mismo día" : dias(d);
    return p.devuelto_en ? texto : texto + " (en curso)";
  }

  // ------------------------------------------------------------------------
  // Texto y DOM
  // ------------------------------------------------------------------------
  // Para buscar sin que importen tildes ni mayúsculas: "multimetro" encuentra
  // "Multímetro".
  function normalizar(t) {
    return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  var numero = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });

  // Construye nodos sin innerHTML: todo texto que escribió una persona entra
  // como textContent y nunca se interpreta como HTML.
  function el(tag, props, hijos) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "texto") n.textContent = v;
        else if (k === "clase") n.className = v;
        else if (k === "al") n.addEventListener("click", v);
        else n.setAttribute(k, v === true ? "" : v);
      });
    }
    (hijos || []).forEach(function (h) {
      if (h === null || h === undefined || h === false) return;
      n.appendChild(typeof h === "string" ? document.createTextNode(h) : h);
    });
    return n;
  }

  var NOMBRE_ESTADO = {
    prestado: "Prestado", devuelto: "Devuelto", vencido: "Vencido",
    disponible: "Disponible", baja: "De baja"
  };

  function etiqueta(estado) {
    return el("span", { clase: "etiqueta etiqueta--" + estado, texto: NOMBRE_ESTADO[estado] });
  }

  function td(etiquetaCelda, contenido, clase) {
    var celda = el("td", { "data-etiqueta": etiquetaCelda, clase: clase || null });
    (Array.isArray(contenido) ? contenido : [contenido]).forEach(function (c) {
      if (c === null || c === undefined) return;
      celda.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return celda;
  }

  function codigoDe(p) {
    var e = p.equipo_id ? equiposPorId[p.equipo_id] : null;
    return e ? e.codigo : "";
  }

  // ------------------------------------------------------------------------
  // Mensajes de error: cada fallo se traduce a una frase accionable.
  // Nunca se muestra un código técnico ni la palabra "error" a secas.
  // ------------------------------------------------------------------------
  function esDeRed(m) { return m.indexOf("failed to fetch") !== -1 || m.indexOf("network") !== -1; }

  function mensajeEntrar(error) {
    var m = (error && error.message ? error.message : "").toLowerCase();
    if (m.indexOf("invalid login") !== -1 || m.indexOf("invalid credentials") !== -1) {
      return "Correo o contraseña incorrectos. Revísalos e inténtalo de nuevo.";
    }
    if (m.indexOf("email not confirmed") !== -1) {
      return "Tu cuenta todavía no está confirmada. Revisa el correo de invitación y confírmala.";
    }
    if (m.indexOf("rate limit") !== -1 || m.indexOf("too many") !== -1) {
      return "Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.";
    }
    if (esDeRed(m)) return "No pudimos conectar. Revisa tu conexión e inténtalo otra vez.";
    return "No pudimos iniciar sesión. Inténtalo otra vez en unos segundos.";
  }

  function mensajeDatos(error) {
    var m = (error && error.message ? error.message : "").toLowerCase();
    var codigo = error && error.code ? String(error.code) : "";
    if (esDeRed(m)) return "No pudimos conectar. Revisa tu conexión e inténtalo otra vez.";
    if (codigo === "42501" || m.indexOf("row-level security") !== -1) {
      return "Tu sesión no tiene permiso para hacer esto. Sal, vuelve a entrar e inténtalo de nuevo.";
    }
    if (codigo === "23505") {
      if (m.indexOf("prestamos_equipo_prestado") !== -1) {
        return "Ese equipo acaba de quedar prestado. Elige otro equipo.";
      }
      return "Ya existe un equipo con ese código. Usa otro código o déjalo vacío para que se asigne solo.";
    }
    if (codigo === "23503") return "Ese equipo ya no está disponible en el catálogo. Elige otro.";
    if (codigo === "23514") {
      return "Revisa los datos: la fecha de préstamo no puede ser futura, la devolución no puede ser anterior al préstamo, el correo tiene que ser válido, y el equipo y la persona no pueden quedar vacíos.";
    }
    if (codigo === "PGRST204" || codigo === "PGRST202" || codigo === "42703" || codigo === "42883" || codigo === "42P01") {
      return "Falta actualizar la base en Supabase: ejecuta el script de la versión 2 en el editor SQL.";
    }
    return "No se pudo guardar. Revisa la conexión e inténtalo otra vez.";
  }

  function mensajeRol(error) {
    var m = (error && error.message ? error.message : "").toLowerCase();
    var codigo = error && error.code ? String(error.code) : "";
    if (codigo === "PGRST202" || codigo === "42883") {
      return "Falta actualizar la base en Supabase. Mientras tanto no se pueden marcar devoluciones.";
    }
    if (esDeRed(m)) return "No pudimos conectar. Revisa tu conexión e inténtalo otra vez.";
    return "No pudimos confirmar tus permisos. Sal, vuelve a entrar e inténtalo de nuevo.";
  }

  var RESPUESTA_RECORDAR = {
    enviado: "Recordatorio enviado por correo.",
    sin_correo: "Este préstamo no tiene correo registrado: no hay a dónde enviar el recordatorio.",
    devuelto: "Ese préstamo ya fue devuelto.",
    reciente: "Ya se envió un recordatorio de este préstamo hace menos de 10 minutos.",
    sin_configurar: "Los correos no están configurados todavía: falta la llave de Brevo en Supabase.",
    no_existe: "Ese préstamo ya no existe. Actualiza la página."
  };

  // ------------------------------------------------------------------------
  // Avisos
  // ------------------------------------------------------------------------
  function mostrarErrorEntrar(texto) {
    var n = $("entrar-error");
    n.textContent = texto;
    n.hidden = false;
  }
  function limpiarErrorEntrar() { $("entrar-error").hidden = true; }

  function mostrarAviso(id, texto) {
    var n = $(id);
    n.textContent = texto;
    n.hidden = false;
  }
  function limpiarAviso(id) { $(id).hidden = true; }

  function anunciar(texto) { $("anuncio").textContent = texto; }

  function toast(texto) {
    var n = $("toast");
    n.textContent = "";
    n.appendChild(el("span", { texto: texto }));
    n.appendChild(el("button", {
      type: "button", clase: "boton boton--fantasma", texto: "Cerrar", al: ocultarToast
    }));
    n.hidden = false;
    anunciar(texto);
    if (temporizadorToast) clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(ocultarToast, 6000);
  }
  function ocultarToast() {
    $("toast").hidden = true;
    if (temporizadorToast) { clearTimeout(temporizadorToast); temporizadorToast = null; }
  }

  function ocupado(boton, texto) {
    boton.dataset.textoOriginal = boton.textContent;
    boton.disabled = true;
    boton.textContent = texto;
  }
  function libre(boton) {
    boton.disabled = false;
    if (boton.dataset.textoOriginal) boton.textContent = boton.dataset.textoOriginal;
  }

  // ------------------------------------------------------------------------
  // ENTRAR
  // ------------------------------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll("[data-ver]"), function (b) {
    b.addEventListener("click", function () {
      var campo = $(b.getAttribute("data-ver"));
      var visible = campo.type === "text";
      campo.type = visible ? "password" : "text";
      b.textContent = visible ? "Ver" : "Ocultar";
      b.setAttribute("aria-pressed", visible ? "false" : "true");
      campo.focus();
    });
  });

  // La caja de entrar tiene tres modos: entrar, pedir el enlace para
  // recuperar la contraseña, y crear la contraseña nueva.
  var MODOS_ENTRAR = {
    entrar: ["Entrar", "Usa el correo y la contraseña que te dieron para esta herramienta."],
    olvide: ["Recuperar contraseña", "Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva."],
    nueva: ["Crea una contraseña nueva", "Elige una contraseña que no hayas usado antes en esta herramienta."]
  };

  function modoEntrar(modo) {
    $("form-entrar").hidden = modo !== "entrar";
    $("form-olvide").hidden = modo !== "olvide";
    $("form-nueva-clave").hidden = modo !== "nueva";
    $("entrar-titulo").textContent = MODOS_ENTRAR[modo][0];
    $("entrar-ayuda").textContent = MODOS_ENTRAR[modo][1];
    ["entrar-error", "entrar-ok", "olvide-error", "olvide-ok", "nueva-error"].forEach(limpiarAviso);
  }

  $("btn-olvide").addEventListener("click", function () {
    $("correo-olvide").value = $("correo").value.trim();
    $("btn-enviar-enlace").textContent = "Enviar enlace";
    modoEntrar("olvide");
    $("correo-olvide").focus();
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-volver-entrar]"), function (b) {
    b.addEventListener("click", function () {
      if ($("correo-olvide").value.trim()) $("correo").value = $("correo-olvide").value.trim();
      modoEntrar("entrar");
      $("correo").focus();
    });
  });

  function mensajeRecuperar(error) {
    var m = (error && error.message ? error.message : "").toLowerCase();
    var codigo = error && error.code ? String(error.code) : "";
    if (codigo === "over_email_send_rate_limit" || m.indexOf("rate limit") !== -1 ||
        m.indexOf("security purposes") !== -1 || m.indexOf("too many") !== -1) {
      return "Ya se pidió un enlace hace muy poco. Espera un minuto y vuelve a intentarlo.";
    }
    if (codigo === "same_password" || m.indexOf("different from the old") !== -1) {
      return "La contraseña nueva tiene que ser distinta de la anterior.";
    }
    if (codigo === "weak_password" || m.indexOf("password should") !== -1) {
      return "Esa contraseña es muy débil. Usa al menos 8 caracteres, mezclando letras y números.";
    }
    if (m.indexOf("session") !== -1 || m.indexOf("expired") !== -1) {
      return "El enlace venció. Pide uno nuevo con «¿Olvidaste tu contraseña?».";
    }
    if (esDeRed(m)) return "No pudimos conectar. Revisa tu conexión e inténtalo otra vez.";
    return "No pudimos completar el cambio. Inténtalo otra vez en unos minutos.";
  }

  // Supabase responde igual exista o no la cuenta: así nadie puede usar este
  // formulario para averiguar qué correos están registrados.
  $("form-olvide").addEventListener("submit", function (e) {
    e.preventDefault();
    limpiarAviso("olvide-error");
    limpiarAviso("olvide-ok");
    var correo = $("correo-olvide").value.trim();
    if (!CORREO_VALIDO.test(correo)) {
      mostrarAviso("olvide-error", "Escribe tu correo completo, por ejemplo nombre@empresa.com.");
      $("correo-olvide").focus();
      return;
    }
    var boton = $("btn-enviar-enlace");
    ocupado(boton, "Enviando…");
    cliente.auth.resetPasswordForEmail(correo, { redirectTo: location.origin + location.pathname })
      .then(function (res) {
        if (res.error) {
          mostrarAviso("olvide-error", mensajeRecuperar(res.error));
          return;
        }
        mostrarAviso("olvide-ok", "Si ese correo tiene una cuenta, en unos minutos te llega un enlace para crear una contraseña nueva. Revisa también la carpeta de spam. El enlace sirve una sola vez.");
        boton.dataset.textoOriginal = "Enviar de nuevo";
      })
      .catch(function (err) { mostrarAviso("olvide-error", mensajeRecuperar(err)); })
      .finally(function () { libre(boton); });
  });

  function mostrarNuevaClave() {
    if (!app.hidden) {
      app.hidden = true;
      usuario = null;
    }
    pantallaEntrar.hidden = false;
    $("clave-nueva").value = "";
    $("clave-repetir").value = "";
    modoEntrar("nueva");
    $("clave-nueva").focus();
  }

  $("form-nueva-clave").addEventListener("submit", function (e) {
    e.preventDefault();
    limpiarAviso("nueva-error");
    var clave = $("clave-nueva").value;
    if (clave.length < 8) {
      mostrarAviso("nueva-error", "La contraseña debe tener al menos 8 caracteres.");
      $("clave-nueva").focus();
      return;
    }
    if (clave !== $("clave-repetir").value) {
      mostrarAviso("nueva-error", "Las dos contraseñas no coinciden. Escríbelas otra vez.");
      $("clave-repetir").focus();
      return;
    }
    var boton = $("btn-guardar-clave");
    ocupado(boton, "Guardando…");
    cliente.auth.updateUser({ password: clave })
      .then(function (res) {
        if (res.error) {
          mostrarAviso("nueva-error", mensajeRecuperar(res.error));
          return;
        }
        modoRecuperacion = false;
        $("clave-nueva").value = "";
        $("clave-repetir").value = "";
        modoEntrar("entrar");
        // El enlace ya dejó la sesión abierta: se entra directo a la app.
        return cliente.auth.getSession().then(function (r) {
          var sesion = r && r.data ? r.data.session : null;
          if (sesion && sesion.user) {
            entrarAlApp(sesion);
            toast("Tu contraseña quedó actualizada.");
          } else {
            mostrarAviso("entrar-ok", "Tu contraseña quedó actualizada. Ya puedes entrar con ella.");
          }
        });
      })
      .catch(function (err) { mostrarAviso("nueva-error", mensajeRecuperar(err)); })
      .finally(function () { libre(boton); });
  });

  if (enlaceVencido) {
    mostrarErrorEntrar("El enlace para cambiar la contraseña venció o ya se usó. Pide uno nuevo con «¿Olvidaste tu contraseña?».");
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* no es crítico */ }
  }

  $("form-entrar").addEventListener("submit", function (e) {
    e.preventDefault();
    limpiarErrorEntrar();

    var correo = $("correo").value.trim();
    var clave = $("clave").value;

    if (!correo || !clave) {
      mostrarErrorEntrar("Escribe tu correo y tu contraseña para entrar.");
      (correo ? $("clave") : $("correo")).focus();
      return;
    }

    var boton = $("btn-entrar");
    ocupado(boton, "Entrando…");

    cliente.auth.signInWithPassword({ email: correo, password: clave })
      .then(function (res) {
        if (res.error) {
          mostrarErrorEntrar(mensajeEntrar(res.error));
          $("clave").value = "";
          $("clave").focus();
        }
        // El éxito lo maneja onAuthStateChange: una sola puerta de entrada.
      })
      .catch(function (err) { mostrarErrorEntrar(mensajeEntrar(err)); })
      .finally(function () { libre(boton); });
  });

  $("btn-salir").addEventListener("click", function () { cliente.auth.signOut(); });

  // ------------------------------------------------------------------------
  // Puerta de sesión y rol
  // ------------------------------------------------------------------------
  function entrarAlApp(sesion) {
    usuario = sesion.user;
    $("sesion-correo").textContent = usuario.email || "";
    pantallaEntrar.hidden = true;
    app.hidden = false;
    $("clave").value = "";
    limpiarErrorEntrar();
    var inicial = (location.hash || "").slice(1);
    mostrarVista(VISTAS.indexOf(inicial) !== -1 && inicial !== "nuevo" ? inicial : "dashboard", { foco: false });
    consultarRol();
  }

  // El rol lo decide la base (función es_admin de schema.sql). Los datos se
  // cargan después, porque de él depende qué columnas y botones se pintan.
  function consultarRol() {
    esAdmin = false;
    pintarRol(false);
    cliente.rpc("es_admin")
      .then(function (res) {
        if (res.error) throw res.error;
        esAdmin = res.data === true;
        return null;
      })
      .catch(function (err) { return err; })
      .then(function (errorRol) {
        if (!usuario) return;
        pintarRol(!errorRol);
        cargarDatos(errorRol ? mensajeRol(errorRol) : null);
      });
  }

  function pintarRol(conocido) {
    $("sesion-rol").hidden = !esAdmin;
    $("alcance").textContent = !conocido ? "" : esAdmin
      ? "Ves todo el inventario y los préstamos de todo el equipo, y registras las devoluciones."
      : "Ves el catálogo de equipos y solo los préstamos que registraste tú. Las devoluciones las registra el administrador.";
    Array.prototype.forEach.call(document.querySelectorAll(".solo-admin"), function (n) {
      n.hidden = !esAdmin;
    });
    $("tab-reportes").hidden = !esAdmin;
    $("th-responsable").hidden = !esAdmin;
    if (!esAdmin && vistaActual === "reportes") mostrarVista("dashboard", { foco: false });
  }

  function salirDelApp() {
    usuario = null;
    esAdmin = false;
    prestamos = [];
    equipos = [];
    equiposPorId = {};
    pintarRol(false);
    Array.prototype.forEach.call(document.querySelectorAll("dialog[open]"), function (d) { d.close(); });
    app.hidden = true;
    pantallaEntrar.hidden = false;
    modoEntrar("entrar");
    ocultarToast();
    pintarTodo();
  }

  // Única puerta de sesión. En supabase-js v2 este evento también se dispara
  // al cargar (INITIAL_SESSION), así que no hace falta llamar a getSession.
  // El trabajo se difiere con setTimeout porque consultar la base dentro del
  // propio callback puede quedar esperando el candado interno de la sesión.
  cliente.auth.onAuthStateChange(function (evento, sesion) {
    setTimeout(function () {
      // Quien llega desde el enlace del correo tiene sesión, pero primero
      // tiene que crear su contraseña nueva; no entra a la app todavía.
      if (evento === "PASSWORD_RECOVERY") modoRecuperacion = true;
      if (modoRecuperacion && sesion && sesion.user) {
        mostrarNuevaClave();
        return;
      }
      if (sesion && sesion.user) {
        if (!usuario) entrarAlApp(sesion);
        else usuario = sesion.user;
      } else if (usuario) {
        salirDelApp();
      }
    }, 0);
  });

  // ------------------------------------------------------------------------
  // Navegación
  // ------------------------------------------------------------------------
  function mostrarVista(nombre, opciones) {
    if (VISTAS.indexOf(nombre) === -1) nombre = "dashboard";
    if (nombre === "reportes" && !esAdmin) nombre = "dashboard";
    if (nombre !== "nuevo") vistaAnterior = nombre;
    vistaActual = nombre;

    VISTAS.forEach(function (v) { $("vista-" + v).hidden = v !== nombre; });
    Array.prototype.forEach.call(document.querySelectorAll("[data-vista]"), function (tab) {
      tab.setAttribute("aria-selected", tab.getAttribute("data-vista") === nombre ? "true" : "false");
    });
    try { history.replaceState(null, "", "#" + nombre); } catch (e) { /* no es crítico */ }
    // Si la página iba muy abajo, se sube hasta las pestañas para que la
    // sección nueva se vea desde el principio.
    var pestanas = document.querySelector(".pestanas");
    var tope = pestanas.getBoundingClientRect().top + window.pageYOffset - 72;
    if (window.pageYOffset > tope) window.scrollTo(0, Math.max(0, tope));
    // El foco va a la sección para los lectores de pantalla, sin mover la
    // página por su cuenta.
    if (!opciones || opciones.foco !== false) $("vista-" + nombre).focus({ preventScroll: true });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-vista]"), function (tab) {
    tab.addEventListener("click", function () { mostrarVista(tab.getAttribute("data-vista")); });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-ir]"), function (b) {
    b.addEventListener("click", function () {
      var destino = b.getAttribute("data-ir");
      if (destino === "nuevo") abrirNuevo();
      else if (destino === "atras") mostrarVista(vistaAnterior);
      else mostrarVista(destino);
    });
  });

  $("btn-nuevo").addEventListener("click", function () { abrirNuevo(); });

  // ------------------------------------------------------------------------
  // Tema
  // ------------------------------------------------------------------------
  try {
    var guardado = localStorage.getItem("tema");
    if (guardado === "dark" || guardado === "light") {
      document.documentElement.setAttribute("data-theme", guardado);
    }
  } catch (e) { /* Sin almacenamiento se usa la preferencia del sistema. */ }

  $("btn-tema").addEventListener("click", function () {
    var actual = document.documentElement.getAttribute("data-theme");
    var oscuroDelSistema = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var esOscuro = actual ? actual === "dark" : oscuroDelSistema;
    var nuevo = esOscuro ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nuevo);
    try { localStorage.setItem("tema", nuevo); } catch (e) { /* no es crítico */ }
    anunciar(nuevo === "dark" ? "Tema oscuro activado" : "Tema claro activado");
  });

  // ------------------------------------------------------------------------
  // Carga de datos: préstamos (lo que RLS deja ver) y estado del catálogo.
  // ------------------------------------------------------------------------
  function cargarDatos(avisoPrevio) {
    if (cargando) return;
    cargando = true;
    limpiarAviso("app-error");

    Promise.all([
      cliente.from("prestamos").select("*")
        .order("fecha_entrega", { ascending: false })
        .order("creado_en", { ascending: false }),
      cliente.rpc("estado_equipos")
    ]).then(function (r) {
      var avisos = [];
      if (avisoPrevio) avisos.push(avisoPrevio);

      if (r[0].error) avisos.push(mensajeDatos(r[0].error));
      else prestamos = r[0].data || [];

      if (r[1].error) {
        catalogoListo = false;
        equipos = [];
        avisos.push(mensajeDatos(r[1].error));
      } else {
        catalogoListo = true;
        equipos = r[1].data || [];
      }
      equiposPorId = {};
      equipos.forEach(function (e) { equiposPorId[e.id] = e; });

      if (avisos.length) mostrarAviso("app-error", avisos[0]);
      pintarTodo();
    }).catch(function (err) {
      mostrarAviso("app-error", mensajeDatos(err));
    }).finally(function () { cargando = false; });
  }

  function pintarTodo() {
    pintarDashboard();
    pintarEquipos();
    pintarPrestamos();
    pintarHistorial();
    if (esAdmin) pintarReportes();
  }

  // ------------------------------------------------------------------------
  // Fila de préstamo (Dashboard y Préstamos)
  // ------------------------------------------------------------------------
  function construirFila(p) {
    var devuelto = !!p.devuelto_en;
    var vencido = estaVencido(p);

    var li = el("li", { clase: "fila" + (devuelto ? " fila--devuelto" : "") });
    li.appendChild(el("span", {
      clase: "glifo " + (devuelto ? "glifo--devuelto" : "glifo--prestado"), "aria-hidden": "true"
    }));

    var cuerpo = el("div", { clase: "fila__cuerpo" });

    var codigo = codigoDe(p);
    cuerpo.appendChild(el("div", { clase: "fila__linea" }, [
      el("span", { clase: "fila__equipo" }, [
        p.equipo,
        codigo ? el("span", { clase: "tabla__secundario mono", texto: codigo }) : null
      ]),
      el("span", {
        clase: "fila__fecha mono", texto: fechaCorta(p.fecha_entrega),
        title: "Prestado el " + fechaLarga(p.fecha_entrega)
      })
    ]));

    cuerpo.appendChild(el("p", { clase: "fila__persona" }, [
      "Con: ", el("strong", { texto: p.prestado_a }),
      p.correo_prestado ? " · " + p.correo_prestado : null
    ]));

    // Estado en tres canales: glifo, etiqueta escrita y frase.
    var estado = el("p", { clase: "fila__estado" }, [
      etiqueta(estadoDe(p)),
      el("span", { texto: devuelto ? fraseDevuelto(p.devuelto_en) : frasePrestado(p.fecha_entrega) })
    ]);
    if (!devuelto && p.fecha_limite) {
      estado.appendChild(el("span", {
        clase: "fila__plazo" + (vencido ? " fila__plazo--vencido" : ""),
        texto: frasePlazo(p.fecha_limite),
        title: "Devolver a más tardar el " + fechaLarga(p.fecha_limite)
      }));
    }
    cuerpo.appendChild(estado);

    if (p.nota) cuerpo.appendChild(el("p", { clase: "fila__nota", texto: p.nota }));

    var pie = el("p", { clase: "fila__pie" }, [
      el("span", { texto: "Registrado por " + p.registrado_por_correo + " · " + instanteLegible(p.creado_en) })
    ]);
    if (devuelto && p.devuelto_por_correo) {
      pie.appendChild(el("span", {
        texto: "Devolución registrada por " + p.devuelto_por_correo + " · " + instanteLegible(p.devuelto_en)
      }));
    }
    cuerpo.appendChild(pie);
    li.appendChild(cuerpo);

    // Acciones: solo para el administrador y solo en lo que sigue prestado.
    // Un contenedor vacío ocuparía una fila fantasma en la retícula.
    if (!devuelto && esAdmin) {
      var accion = el("div", { clase: "fila__accion" });
      if (p.correo_prestado) {
        var recordarBtn = el("button", {
          type: "button", clase: "boton boton--fantasma", texto: "Recordar",
          "aria-label": "Enviar recordatorio por correo a " + p.prestado_a
        });
        recordarBtn.addEventListener("click", function () { recordar(p, recordarBtn); });
        accion.appendChild(recordarBtn);
      }
      accion.appendChild(el("button", {
        type: "button", clase: "boton boton--contorno", texto: "Devolver",
        "aria-label": "Marcar devolución de " + p.equipo + ", prestado a " + p.prestado_a,
        al: function () { pedirDevolucion(p); }
      }));
      li.appendChild(accion);
    }

    return li;
  }

  // ------------------------------------------------------------------------
  // DASHBOARD
  // ------------------------------------------------------------------------
  function kpi(n, rotulo, valor, nota, alerta) {
    $("kpi-" + n + "-rotulo").textContent = rotulo;
    $("kpi-" + n).textContent = valor === null ? "—" : valor;
    $("kpi-" + n + "-nota").textContent = nota;
    $("kpi-" + n).parentNode.classList.toggle("tarjeta--alerta", !!alerta);
  }

  function pintarDashboard() {
    var enCatalogo = equipos.filter(function (e) { return e.activo; });
    var disponibles = enCatalogo.filter(function (e) { return !e.prestado; }).length;
    var activos = prestamos.filter(function (p) { return !p.devuelto_en; });
    var vencidos = activos.filter(estaVencido).length;
    var total = catalogoListo ? enCatalogo.length : null;
    var libres = catalogoListo ? disponibles : null;

    kpi(1, "Total equipos", total, "en el catálogo");
    if (esAdmin) {
      kpi(2, "Prestados", activos.length, "afuera en este momento");
      kpi(3, "Disponibles", libres, "listos para prestar");
      kpi(4, "Vencidos", vencidos, "pasados de su plazo", vencidos > 0);
    } else {
      kpi(2, "Disponibles", libres, "listos para prestar");
      kpi(3, "Mis préstamos", activos.length, "registrados por ti, sin devolver");
      kpi(4, "Vencidos", vencidos, "de tus préstamos", vencidos > 0);
    }

    // Requieren atención: vencidos, y los que vencen hoy o mañana.
    var hoy = hoyBogota();
    var atencion = activos.filter(function (p) {
      return p.fecha_limite && diasEntre(hoy, p.fecha_limite) <= 1;
    }).sort(function (a, b) { return a.fecha_limite < b.fecha_limite ? -1 : 1; });

    var lista = $("lista-atencion");
    lista.textContent = "";
    atencion.forEach(function (p) { lista.appendChild(construirFila(p)); });
    lista.hidden = !atencion.length;
    $("atencion-vacio").hidden = !!atencion.length;

    // Préstamos recientes: los últimos registrados.
    var recientes = prestamos.slice().sort(function (a, b) {
      return a.creado_en < b.creado_en ? 1 : -1;
    }).slice(0, 6);

    var cuerpo = $("tabla-recientes").tBodies[0];
    cuerpo.textContent = "";
    recientes.forEach(function (p) {
      var codigo = codigoDe(p);
      var accion = null;
      if (esAdmin && !p.devuelto_en) {
        accion = el("button", {
          type: "button", clase: "boton boton--contorno", texto: "Devolver",
          al: function () { pedirDevolucion(p); }
        });
      }
      cuerpo.appendChild(el("tr", null, [
        td("Equipo", [p.equipo, codigo ? el("span", { clase: "tabla__secundario mono", texto: codigo }) : null], "tabla__principal"),
        td("Responsable", p.prestado_a),
        td("Fecha préstamo", el("span", { clase: "mono", texto: fechaCorta(p.fecha_entrega) })),
        td("Devolución prevista", p.fecha_limite ? el("span", { clase: "mono", texto: fechaCorta(p.fecha_limite) }) : el("span", { clase: "texto-suave", texto: "—" })),
        td("Estado", etiqueta(estadoDe(p))),
        td("", accion, "tabla__accion")
      ]));
    });
    $("tabla-recientes").parentNode.hidden = !recientes.length;
    $("recientes-vacio").hidden = !!recientes.length;
  }

  // ------------------------------------------------------------------------
  // EQUIPOS
  // ------------------------------------------------------------------------
  function estadoEquipo(e) {
    if (!e.activo) return "baja";
    if (!e.prestado) return "disponible";
    if (e.fecha_limite && diasEntre(e.fecha_limite, hoyBogota()) > 0) return "vencido";
    return "prestado";
  }

  function pintarEquipos() {
    var q = normalizar($("buscar-equipo").value);
    var activos = equipos.filter(function (e) { return e.activo; });

    $("eq-cifra-todos").textContent = activos.length;
    $("eq-cifra-disponibles").textContent = activos.filter(function (e) { return !e.prestado; }).length;
    $("eq-cifra-prestados").textContent = activos.filter(function (e) { return e.prestado; }).length;
    $("eq-cifra-baja").textContent = equipos.length - activos.length;

    var lista = equipos.filter(function (e) {
      if (filtroEquipos === "baja") { if (e.activo) return false; }
      else {
        if (!e.activo) return false;
        if (filtroEquipos === "disponibles" && e.prestado) return false;
        if (filtroEquipos === "prestados" && !e.prestado) return false;
      }
      if (!q) return true;
      return normalizar([e.nombre, e.codigo, e.categoria, e.responsable].join(" ")).indexOf(q) !== -1;
    });

    var cuerpo = $("tabla-equipos").tBodies[0];
    cuerpo.textContent = "";
    lista.forEach(function (e) {
      var estado = estadoEquipo(e);
      var acciones = [];
      if (estado === "disponible") {
        acciones.push(el("button", {
          type: "button", clase: "boton boton--contorno", texto: "Prestar",
          "aria-label": "Prestar " + e.nombre, al: function () { abrirNuevo(e.id); }
        }));
      }
      acciones.push(el("button", {
        type: "button", clase: "boton boton--fantasma", texto: "Ver",
        "aria-label": "Ver detalle de " + e.nombre, al: function () { abrirDetalle(e); }
      }));

      var fila = el("tr", null, [
        td("Equipo", e.nombre, "tabla__principal"),
        td("Código", el("span", { clase: "mono", texto: e.codigo })),
        td("Categoría", e.categoria || el("span", { clase: "texto-suave", texto: "—" })),
        td("Estado", etiqueta(estado))
      ]);
      if (esAdmin) {
        fila.appendChild(td("Responsable", e.responsable || el("span", { clase: "texto-suave", texto: "—" })));
      }
      fila.appendChild(td("", acciones, "tabla__accion"));
      cuerpo.appendChild(fila);
    });

    $("equipos-conteo").textContent = lista.length === 1 ? "1 equipo" : lista.length + " equipos";
    var vacio = !lista.length;
    $("equipos-marco").hidden = vacio;
    $("equipos-vacio").hidden = !vacio;
    $("btn-vacio-agregar").hidden = !(esAdmin && !equipos.length);
    if (vacio) {
      $("equipos-vacio-texto").textContent = !catalogoListo
        ? "El catálogo no está disponible todavía. Hay que actualizar la base en Supabase."
        : !equipos.length
          ? (esAdmin
              ? "Todavía no hay equipos en el catálogo. Agrega el primero o pega una lista desde Excel con «Agregar varios»."
              : "Todavía no hay equipos en el catálogo. El administrador los agrega.")
          : "Ningún equipo coincide con la búsqueda o el filtro.";
    }
  }

  $("buscar-equipo").addEventListener("input", pintarEquipos);

  Array.prototype.forEach.call(document.querySelectorAll("[data-filtro-equipos]"), function (chip) {
    chip.addEventListener("click", function () {
      filtroEquipos = chip.getAttribute("data-filtro-equipos");
      marcarChips("[data-filtro-equipos]", chip);
      pintarEquipos();
    });
  });

  function marcarChips(selector, activo) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (c) {
      c.setAttribute("aria-pressed", c === activo ? "true" : "false");
    });
  }

  // ------------------------------------------------------------------------
  // PRÉSTAMOS · lo que sigue afuera
  // ------------------------------------------------------------------------
  function vencePronto(p) {
    if (!p.fecha_limite || estaVencido(p)) return false;
    return diasEntre(hoyBogota(), p.fecha_limite) <= 2;
  }

  var VACIO_PRESTAMOS = {
    activos: "No hay equipos prestados en este momento.",
    vencidos: "No hay préstamos vencidos. ¡Todo al día!",
    pronto: "Ningún préstamo vence en los próximos dos días."
  };

  function pintarPrestamos() {
    var activos = prestamos.filter(function (p) { return !p.devuelto_en; });
    var vencidos = activos.filter(estaVencido);
    var pronto = activos.filter(vencePronto);

    $("pr-cifra-activos").textContent = activos.length;
    $("pr-cifra-vencidos").textContent = vencidos.length;
    $("pr-cifra-pronto").textContent = pronto.length;

    var lista = filtroPrestamos === "vencidos" ? vencidos : filtroPrestamos === "pronto" ? pronto : activos;
    var ul = $("lista-prestamos");
    ul.textContent = "";
    lista.forEach(function (p) { ul.appendChild(construirFila(p)); });

    $("prestamos-conteo").textContent = lista.length ? (lista.length === 1 ? "1 préstamo" : lista.length + " préstamos") : "";
    ul.hidden = !lista.length;
    $("prestamos-vacio").hidden = !!lista.length;
    $("prestamos-vacio-texto").textContent = VACIO_PRESTAMOS[filtroPrestamos];
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-filtro-prestamos]"), function (chip) {
    chip.addEventListener("click", function () {
      filtroPrestamos = chip.getAttribute("data-filtro-prestamos");
      marcarChips("[data-filtro-prestamos]", chip);
      pintarPrestamos();
    });
  });

  // ------------------------------------------------------------------------
  // HISTORIAL
  // ------------------------------------------------------------------------
  function pintarHistorial() {
    var q = normalizar($("buscar-historial").value);
    var coincide = prestamos.filter(function (p) {
      if (!q) return true;
      return normalizar([p.equipo, codigoDe(p), p.prestado_a, p.correo_prestado].join(" ")).indexOf(q) !== -1;
    });

    var porEstado = { prestados: [], devueltos: [], vencidos: [] };
    coincide.forEach(function (p) {
      if (p.devuelto_en) porEstado.devueltos.push(p);
      else {
        porEstado.prestados.push(p);
        if (estaVencido(p)) porEstado.vencidos.push(p);
      }
    });

    $("hi-cifra-todos").textContent = coincide.length;
    $("hi-cifra-prestados").textContent = porEstado.prestados.length;
    $("hi-cifra-devueltos").textContent = porEstado.devueltos.length;
    $("hi-cifra-vencidos").textContent = porEstado.vencidos.length;

    var lista = filtroHistorial === "todos" ? coincide : porEstado[filtroHistorial];

    var cuerpo = $("tabla-historial").tBodies[0];
    cuerpo.textContent = "";
    lista.forEach(function (p) {
      var codigo = codigoDe(p);
      cuerpo.appendChild(el("tr", null, [
        td("Equipo", [p.equipo, codigo ? el("span", { clase: "tabla__secundario mono", texto: codigo }) : null], "tabla__principal"),
        td("Persona", p.prestado_a),
        td("Salida", el("span", { clase: "mono", texto: fechaCorta(p.fecha_entrega) })),
        td("Devolución", p.devuelto_en
          ? el("span", { clase: "mono", texto: fechaCorta(isoDeInstante(p.devuelto_en)) })
          : el("span", { clase: "texto-suave", texto: "—" })),
        td("Duración", duracion(p)),
        td("Estado", etiqueta(estadoDe(p)))
      ]));
    });

    $("historial-conteo").textContent = lista.length === 1 ? "1 préstamo" : lista.length + " préstamos";
    $("historial-marco").hidden = !lista.length;
    $("historial-vacio").hidden = !!lista.length;
    $("historial-vacio-texto").textContent = !prestamos.length
      ? (esAdmin ? "Todavía no hay préstamos registrados." : "Todavía no has registrado préstamos.")
      : "Ningún préstamo coincide con la búsqueda o el filtro.";
  }

  $("buscar-historial").addEventListener("input", pintarHistorial);

  Array.prototype.forEach.call(document.querySelectorAll("[data-filtro-historial]"), function (chip) {
    chip.addEventListener("click", function () {
      filtroHistorial = chip.getAttribute("data-filtro-historial");
      marcarChips("[data-filtro-historial]", chip);
      pintarHistorial();
    });
  });

  // ------------------------------------------------------------------------
  // REPORTES · solo administrador; se calculan con los préstamos cargados.
  // ------------------------------------------------------------------------
  function barras(contenedor, items, alerta, vacio) {
    var n = $(contenedor);
    n.textContent = "";
    if (!items.length) {
      n.appendChild(el("p", { clase: "barras__vacio", texto: vacio }));
      return;
    }
    var maximo = Math.max.apply(null, items.map(function (i) { return i.valor; })) || 1;
    items.forEach(function (i) {
      n.appendChild(el("div", { clase: "barra-fila" }, [
        el("span", { clase: "barra-fila__rotulo", texto: i.rotulo, title: i.rotulo }),
        el("span", { clase: "barra-fila__pista", "aria-hidden": "true" }, [
          el("span", {
            clase: "barra-fila__relleno" + (alerta ? " barra-fila__relleno--alerta" : ""),
            style: "width:" + Math.round((i.valor / maximo) * 100) + "%"
          })
        ]),
        el("span", { clase: "barra-fila__valor mono", texto: String(i.valor) })
      ]));
    });
  }

  // Agrupa y deja los 5 con más valor. La clave junta variantes del mismo
  // nombre ("taladro" y "Taladro"); el rótulo es el más reciente.
  function top(lista, clave, rotulo, filtro) {
    var grupos = {};
    lista.forEach(function (p) {
      if (filtro && !filtro(p)) return;
      var k = clave(p);
      if (!grupos[k]) grupos[k] = { rotulo: rotulo(p), valor: 0 };
      grupos[k].valor += 1;
    });
    return Object.keys(grupos).map(function (k) { return grupos[k]; })
      .sort(function (a, b) { return b.valor - a.valor || a.rotulo.localeCompare(b.rotulo, "es"); })
      .slice(0, 5);
  }

  function claveEquipo(p) { return p.equipo_id || "texto:" + normalizar(p.equipo); }
  function rotuloEquipo(p) {
    var codigo = codigoDe(p);
    return codigo ? p.equipo + " · " + codigo : p.equipo;
  }

  function devueltoTarde(p) {
    return !!(p.devuelto_en && p.fecha_limite && isoDeInstante(p.devuelto_en) > p.fecha_limite);
  }

  function pintarReportes() {
    // Ordenados del más reciente al más viejo: así el rótulo de cada grupo es
    // el nombre que se usó por última vez.
    var lista = prestamos.slice().sort(function (a, b) { return a.creado_en < b.creado_en ? 1 : -1; });
    var devueltos = lista.filter(function (p) { return p.devuelto_en; });
    var conPlazo = devueltos.filter(function (p) { return p.fecha_limite; });

    $("rep-total").textContent = lista.length;
    if (devueltos.length) {
      var suma = devueltos.reduce(function (s, p) {
        return s + Math.max(0, diasEntre(p.fecha_entrega, isoDeInstante(p.devuelto_en)));
      }, 0);
      var promedio = suma / devueltos.length;
      $("rep-promedio").textContent = numero.format(promedio) + (promedio === 1 ? " día" : " días");
    } else {
      $("rep-promedio").textContent = "—";
    }
    $("rep-a-tiempo").textContent = conPlazo.length
      ? Math.round(100 * conPlazo.filter(function (p) { return !devueltoTarde(p); }).length / conPlazo.length) + " %"
      : "—";
    $("rep-vencidos").textContent = lista.filter(estaVencido).length;

    // Préstamos por mes: los últimos seis meses, incluido el actual.
    var hoy = hoyBogota();
    var anio = +hoy.slice(0, 4), mes = +hoy.slice(5, 7);
    var meses = [];
    for (var i = 5; i >= 0; i--) {
      var m = mes - i, a = anio;
      while (m < 1) { m += 12; a -= 1; }
      var clave = a + "-" + (m < 10 ? "0" + m : m);
      meses.push({
        clave: clave,
        rotulo: MESES[m - 1].charAt(0).toUpperCase() + MESES[m - 1].slice(1) + (a !== anio ? " " + a : ""),
        valor: 0
      });
    }
    lista.forEach(function (p) {
      var k = p.fecha_entrega.slice(0, 7);
      meses.forEach(function (x) { if (x.clave === k) x.valor += 1; });
    });
    barras("rep-mes", lista.length ? meses : [], false, "Todavía no hay préstamos para graficar.");

    barras("rep-equipos", top(lista, claveEquipo, rotuloEquipo), false,
      "Todavía no hay préstamos registrados.");
    barras("rep-personas", top(lista,
      function (p) { return normalizar(p.prestado_a); },
      function (p) { return p.prestado_a; }), false,
      "Todavía no hay préstamos registrados.");
    barras("rep-retrasos", top(lista, claveEquipo, rotuloEquipo, function (p) {
      return devueltoTarde(p) || estaVencido(p);
    }), true, "Ningún equipo se ha devuelto tarde. ¡Bien!");
  }

  // ------------------------------------------------------------------------
  // DEVOLUCIÓN · con confirmación
  // La hora y el autor de la devolución los fija el servidor (trigger en
  // schema.sql); lo que se envía aquí es solo la intención.
  // ------------------------------------------------------------------------
  function llenarDetalles(dl, pares) {
    dl.textContent = "";
    pares.forEach(function (par) {
      if (par[1] === null || par[1] === undefined || par[1] === "") return;
      dl.appendChild(el("dt", { texto: par[0] }));
      dl.appendChild(el("dd", null, [par[1]]));
    });
  }

  function pedirDevolucion(p) {
    prestamoPorDevolver = p;
    var codigo = codigoDe(p);
    llenarDetalles($("devolver-detalles"), [
      ["Equipo", p.equipo + (codigo ? " · " + codigo : "")],
      ["Responsable", p.prestado_a],
      ["Prestado el", fechaLarga(p.fecha_entrega)],
      ["Fecha de devolución", fechaLarga(hoyBogota())]
    ]);
    limpiarAviso("devolver-error");
    libre($("btn-confirmar-devolver"));
    $("dlg-devolver").showModal();
  }

  $("form-devolver").addEventListener("submit", function (e) {
    e.preventDefault();
    var p = prestamoPorDevolver;
    if (!p) return;
    var boton = $("btn-confirmar-devolver");
    ocupado(boton, "Guardando…");
    limpiarAviso("devolver-error");

    cliente.from("prestamos")
      .update({ devuelto_en: new Date().toISOString(), devuelto_por_correo: usuario.email })
      .eq("id", p.id)
      // El filtro sobre devuelto_en hace la devolución idempotente: si otro
      // administrador ya la marcó, no se sobrescribe su registro.
      .is("devuelto_en", null)
      .select()
      .then(function (res) {
        if (res.error) {
          mostrarAviso("devolver-error", mensajeDatos(res.error));
          libre(boton);
          return;
        }
        $("dlg-devolver").close();
        toast(res.data && res.data.length
          ? "Equipo devuelto correctamente: " + p.equipo + "."
          : "Ese préstamo ya estaba marcado como devuelto.");
        cargarDatos();
      })
      .catch(function (err) {
        mostrarAviso("devolver-error", mensajeDatos(err));
        libre(boton);
      });
  });

  // Todas las ventanas se cierran igual: botón Cancelar o tecla Escape.
  Array.prototype.forEach.call(document.querySelectorAll("[data-cerrar]"), function (b) {
    b.addEventListener("click", function () { b.closest("dialog").close(); });
  });

  // ------------------------------------------------------------------------
  // RECORDAR · correo inmediato (función recordar_prestamo de schema.sql)
  // ------------------------------------------------------------------------
  function recordar(p, boton) {
    ocupado(boton, "Enviando…");
    cliente.rpc("recordar_prestamo", { p_prestamo: p.id })
      .then(function (res) {
        if (res.error) toast(mensajeDatos(res.error));
        else toast(RESPUESTA_RECORDAR[res.data] || "No se pudo enviar el recordatorio.");
      })
      .catch(function (err) { toast(mensajeDatos(err)); })
      .finally(function () { libre(boton); });
  }

  // ------------------------------------------------------------------------
  // DETALLE DE EQUIPO
  // ------------------------------------------------------------------------
  function abrirDetalle(e) {
    equipoEnDetalle = e;
    var estado = estadoEquipo(e);
    $("detalle-codigo").textContent = e.codigo;
    $("dlg-detalle-titulo").textContent = e.nombre;
    llenarDetalles($("detalle-datos"), [
      ["Categoría", e.categoria || "Sin categoría"],
      ["Estado", etiqueta(estado)],
      ["Responsable", e.responsable],
      ["Fecha de salida", e.fecha_entrega ? fechaLarga(e.fecha_entrega) : null],
      ["Devolución prevista", e.fecha_limite ? fechaLarga(e.fecha_limite) : null]
    ]);

    var historial = prestamos.filter(function (p) { return p.equipo_id === e.id; });
    var ul = $("detalle-historial");
    ul.textContent = "";
    historial.forEach(function (p) {
      ul.appendChild(el("li", null, [
        el("span", null, [el("strong", { texto: p.prestado_a }), " · " + fechaCorta(p.fecha_entrega) +
          (p.devuelto_en ? " → " + fechaCorta(isoDeInstante(p.devuelto_en)) : " → sin devolver")]),
        el("span", { clase: "texto-suave", texto: duracion(p) })
      ]));
    });
    if (!historial.length) {
      ul.appendChild(el("li", { clase: "texto-suave", texto: esAdmin
        ? "Este equipo todavía no se ha prestado."
        : "No has registrado préstamos de este equipo." }));
    }

    $("btn-detalle-prestar").hidden = estado !== "disponible";
    $("btn-detalle-editar").hidden = !esAdmin;
    $("dlg-detalle").showModal();
  }

  $("btn-detalle-prestar").addEventListener("click", function () {
    $("dlg-detalle").close();
    if (equipoEnDetalle) abrirNuevo(equipoEnDetalle.id);
  });

  $("btn-detalle-editar").addEventListener("click", function () {
    $("dlg-detalle").close();
    if (equipoEnDetalle) abrirEquipo(equipoEnDetalle);
  });

  // ------------------------------------------------------------------------
  // AGREGAR / EDITAR EQUIPO · solo administrador (RLS lo exige igual)
  // ------------------------------------------------------------------------
  function llenarCategorias() {
    var dl = $("categorias-conocidas");
    dl.textContent = "";
    var vistas = {};
    equipos.forEach(function (e) {
      if (e.categoria && !vistas[normalizar(e.categoria)]) {
        vistas[normalizar(e.categoria)] = true;
        dl.appendChild(el("option", { value: e.categoria }));
      }
    });
  }

  function abrirEquipo(e) {
    equipoEditando = e || null;
    $("dlg-equipo-titulo").textContent = e ? "Editar equipo" : "Agregar equipo";
    $("eq-nombre").value = e ? e.nombre : "";
    $("eq-categoria").value = e && e.categoria ? e.categoria : "";
    $("eq-codigo").value = e ? e.codigo : "";
    $("eq-codigo").placeholder = e ? "" : "Se asigna solo: EQ-001, EQ-002…";
    $("btn-baja-equipo").hidden = !e;
    if (e) $("btn-baja-equipo").textContent = e.activo ? "Dar de baja" : "Reactivar";
    llenarCategorias();
    limpiarAviso("equipo-error");
    libre($("btn-guardar-equipo"));
    $("dlg-equipo").showModal();
    $("eq-nombre").focus();
  }

  $("btn-agregar-equipo").addEventListener("click", function () { abrirEquipo(null); });
  $("btn-vacio-agregar").addEventListener("click", function () { abrirEquipo(null); });

  $("form-equipo").addEventListener("submit", function (ev) {
    ev.preventDefault();
    limpiarAviso("equipo-error");
    var nombre = $("eq-nombre").value.trim();
    var categoria = $("eq-categoria").value.trim();
    var codigo = $("eq-codigo").value.trim().toUpperCase();
    if (!nombre) {
      mostrarAviso("equipo-error", "Escribe el nombre del equipo.");
      $("eq-nombre").focus();
      return;
    }

    var datos = { nombre: nombre, categoria: categoria || null };
    if (codigo) datos.codigo = codigo;

    var boton = $("btn-guardar-equipo");
    ocupado(boton, "Guardando…");
    var consulta = equipoEditando
      ? cliente.from("equipos").update(datos).eq("id", equipoEditando.id).select()
      : cliente.from("equipos").insert(datos).select();

    consulta.then(function (res) {
      if (res.error) {
        mostrarAviso("equipo-error", mensajeDatos(res.error));
        libre(boton);
        return;
      }
      $("dlg-equipo").close();
      var guardado = res.data && res.data[0];
      toast(equipoEditando
        ? "Equipo actualizado: " + nombre + "."
        : "Equipo agregado: " + nombre + (guardado ? " · " + guardado.codigo : "") + ".");
      cargarDatos();
    }).catch(function (err) {
      mostrarAviso("equipo-error", mensajeDatos(err));
      libre(boton);
    });
  });

  $("btn-baja-equipo").addEventListener("click", function () {
    var e = equipoEditando;
    if (!e) return;
    if (e.activo && e.prestado) {
      mostrarAviso("equipo-error", "Este equipo está prestado. Registra primero su devolución y después dalo de baja.");
      return;
    }
    var boton = this;
    ocupado(boton, "Guardando…");
    cliente.from("equipos").update({ activo: !e.activo }).eq("id", e.id).select()
      .then(function (res) {
        if (res.error) {
          mostrarAviso("equipo-error", mensajeDatos(res.error));
          libre(boton);
          return;
        }
        $("dlg-equipo").close();
        toast(e.activo
          ? e.nombre + " quedó dado de baja. Su historial se conserva."
          : e.nombre + " volvió al catálogo.");
        cargarDatos();
      })
      .catch(function (err) {
        mostrarAviso("equipo-error", mensajeDatos(err));
        libre(boton);
      });
  });

  // ------------------------------------------------------------------------
  // AGREGAR VARIOS · una línea por equipo; columnas pegadas desde Excel
  // (separadas por tabulación) o separadas por punto y coma.
  // ------------------------------------------------------------------------
  function leerVarios() {
    var lineas = $("varios-texto").value.split(/\r?\n/);
    var equiposNuevos = [];
    var problemas = [];
    var codigos = {};
    lineas.forEach(function (linea, i) {
      if (!linea.trim()) return;
      var col = linea.split(/\t|;/).map(function (c) { return c.trim(); });
      // Si la primera línea es la fila de títulos de Excel, se salta.
      if (!equiposNuevos.length && !problemas.length && normalizar(col[0]) === "nombre") return;
      var nombre = col[0] || "";
      var codigo = (col[2] || "").toUpperCase();
      if (!nombre) { problemas.push("La línea " + (i + 1) + " no tiene nombre."); return; }
      if (nombre.length > 120) { problemas.push("El nombre de la línea " + (i + 1) + " es demasiado largo."); return; }
      if (codigo) {
        if (codigos[codigo]) { problemas.push("El código " + codigo + " se repite en la lista."); return; }
        codigos[codigo] = true;
      }
      var fila = { nombre: nombre, categoria: col[1] || null };
      if (codigo) fila.codigo = codigo;
      equiposNuevos.push(fila);
    });
    return { equipos: equiposNuevos, problemas: problemas };
  }

  function revisarVarios() {
    var r = leerVarios();
    var n = r.equipos.length;
    $("varios-resumen").textContent = n
      ? (n === 1 ? "Se agregará 1 equipo." : "Se agregarán " + n + " equipos.")
      : "";
    if (r.problemas.length) mostrarAviso("varios-error", r.problemas[0]);
    else limpiarAviso("varios-error");
    $("btn-guardar-varios").disabled = !n || r.problemas.length > 0;
    return r;
  }

  $("btn-agregar-varios").addEventListener("click", function () {
    $("varios-texto").value = "";
    revisarVarios();
    $("btn-guardar-varios").textContent = "Agregar";
    $("dlg-varios").showModal();
    $("varios-texto").focus();
  });

  $("varios-texto").addEventListener("input", revisarVarios);

  $("form-varios").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var r = revisarVarios();
    if (!r.equipos.length || r.problemas.length) return;
    var boton = $("btn-guardar-varios");
    ocupado(boton, "Agregando…");
    cliente.from("equipos").insert(r.equipos).select()
      .then(function (res) {
        if (res.error) {
          mostrarAviso("varios-error", res.error.code === "23505"
            ? "Algún código de la lista ya existe en el catálogo. Revisa la tercera columna o déjala vacía."
            : mensajeDatos(res.error));
          libre(boton);
          return;
        }
        $("dlg-varios").close();
        var n = res.data ? res.data.length : r.equipos.length;
        toast(n === 1 ? "Se agregó 1 equipo al catálogo." : "Se agregaron " + n + " equipos al catálogo.");
        cargarDatos();
      })
      .catch(function (err) {
        mostrarAviso("varios-error", mensajeDatos(err));
        libre(boton);
      });
  });

  // ------------------------------------------------------------------------
  // NUEVO PRÉSTAMO
  // ------------------------------------------------------------------------
  var PLAZO_POR_DEFECTO = 7;
  var CORREO_VALIDO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  // El plazo no puede ser anterior al préstamo; el calendario lo respeta.
  function ajustarMinimoPlazo() { $("plazo").min = $("fecha").value || ""; }

  function fechasPorDefecto() {
    $("fecha").value = hoyBogota();
    $("fecha").max = hoyBogota();
    $("plazo").value = isoMasDias(hoyBogota(), PLAZO_POR_DEFECTO);
    ajustarMinimoPlazo();
  }

  // Solo se ofrece lo que está disponible, agrupado por categoría.
  function llenarSelectorEquipos(preseleccion) {
    var sel = $("equipo-sel");
    sel.textContent = "";
    var libres = equipos.filter(function (e) { return e.activo && !e.prestado; })
      .sort(function (a, b) {
        // Sin categoría va al final de la lista.
        var ca = a.categoria || "\uffff", cb = b.categoria || "\uffff";
        return ca === cb ? a.nombre.localeCompare(b.nombre, "es") : ca.localeCompare(cb, "es");
      });

    sel.appendChild(el("option", { value: "", texto: libres.length ? "Elige un equipo…" : "No hay equipos disponibles" }));
    var grupo = null, grupoNombre = null;
    libres.forEach(function (e) {
      var nombreGrupo = e.categoria || "Sin categoría";
      if (nombreGrupo !== grupoNombre) {
        grupo = el("optgroup", { label: nombreGrupo });
        sel.appendChild(grupo);
        grupoNombre = nombreGrupo;
      }
      grupo.appendChild(el("option", { value: e.id, texto: e.codigo + " · " + e.nombre }));
    });

    sel.value = preseleccion && equiposPorId[preseleccion] && !equiposPorId[preseleccion].prestado ? preseleccion : "";
    sel.disabled = !libres.length;
    $("btn-prestar").disabled = !libres.length;

    var ayuda = $("equipo-ayuda");
    if (!catalogoListo) ayuda.textContent = "El catálogo no está disponible todavía: hay que actualizar la base en Supabase.";
    else if (!equipos.length) ayuda.textContent = esAdmin
      ? "Todavía no hay equipos en el catálogo. Agrégalos en la pestaña Equipos."
      : "Todavía no hay equipos en el catálogo. El administrador los agrega.";
    else if (!libres.length) ayuda.textContent = "Todos los equipos están prestados en este momento.";
    else ayuda.textContent = libres.length === 1 ? "1 equipo disponible." : libres.length + " equipos disponibles.";
  }

  // Las personas a las que ya se les prestó, para elegirlas en vez de
  // escribirlas otra vez (y no terminar con "Carlos Ruiz" y "carlos ruiz").
  function llenarPersonas() {
    var dl = $("personas-conocidas");
    dl.textContent = "";
    var vistas = {};
    prestamos.forEach(function (p) {
      var k = normalizar(p.prestado_a);
      if (!vistas[k]) { vistas[k] = true; dl.appendChild(el("option", { value: p.prestado_a })); }
    });
  }

  function abrirNuevo(equipoId) {
    if (vistaActual !== "nuevo") vistaAnterior = vistaActual;
    $("form-prestamo").reset();
    fechasPorDefecto();
    limpiarAviso("prestamo-error");
    llenarSelectorEquipos(equipoId);
    llenarPersonas();
    mostrarVista("nuevo");
    (equipoId ? $("persona") : $("equipo-sel")).focus({ preventScroll: true });
  }

  // Si la persona ya tuvo un préstamo con correo, se le propone ese correo.
  $("persona").addEventListener("change", function () {
    if ($("correo-persona").value.trim()) return;
    var k = normalizar(this.value);
    for (var i = 0; i < prestamos.length; i++) {
      if (normalizar(prestamos[i].prestado_a) === k && prestamos[i].correo_prestado) {
        $("correo-persona").value = prestamos[i].correo_prestado;
        return;
      }
    }
  });

  $("fecha").addEventListener("change", ajustarMinimoPlazo);

  Array.prototype.forEach.call(document.querySelectorAll("[data-dias]"), function (chip) {
    chip.addEventListener("click", function () {
      $("fecha").value = isoMasDias(hoyBogota(), parseInt(chip.getAttribute("data-dias"), 10));
      ajustarMinimoPlazo();
    });
  });

  // Los atajos de plazo cuentan desde la fecha de préstamo, no desde hoy.
  Array.prototype.forEach.call(document.querySelectorAll("[data-plazo]"), function (chip) {
    chip.addEventListener("click", function () {
      $("plazo").value = isoMasDias($("fecha").value || hoyBogota(), parseInt(chip.getAttribute("data-plazo"), 10));
    });
  });

  function faltaCampo(id, texto) {
    mostrarAviso("prestamo-error", texto);
    $(id).focus();
  }

  $("form-prestamo").addEventListener("submit", function (e) {
    e.preventDefault();
    limpiarAviso("prestamo-error");

    var equipoId = $("equipo-sel").value;
    var equipo = equiposPorId[equipoId];
    var persona = $("persona").value.trim();
    var correoPersona = $("correo-persona").value.trim().toLowerCase();
    var fecha = $("fecha").value;
    var plazo = $("plazo").value;
    var nota = $("nota").value.trim();

    if (!equipo) { faltaCampo("equipo-sel", "Elige qué equipo vas a prestar."); return; }
    if (!persona) { faltaCampo("persona", "Escribe a quién le entregas el equipo."); return; }

    // Si la persona ya existe con otra mayúscula o tilde, se usa el nombre
    // como ya estaba escrito: así los reportes no la cuentan dos veces.
    for (var i = 0; i < prestamos.length; i++) {
      if (normalizar(prestamos[i].prestado_a) === normalizar(persona)) { persona = prestamos[i].prestado_a; break; }
    }
    if (correoPersona && !CORREO_VALIDO.test(correoPersona)) {
      faltaCampo("correo-persona", "Revisa el correo: debe verse como nombre@empresa.com. Si no lo sabes, déjalo vacío.");
      return;
    }
    if (!fecha) { faltaCampo("fecha", "Indica la fecha en que sale el equipo."); return; }
    if (diasEntre(hoyBogota(), fecha) > 0) {
      faltaCampo("fecha", "La fecha de préstamo no puede ser futura. Si el equipo sale hoy, usa Hoy.");
      return;
    }
    if (!plazo) { faltaCampo("plazo", "Indica hasta cuándo puede tener el equipo."); return; }
    if (diasEntre(fecha, plazo) < 0) {
      faltaCampo("plazo", "La devolución prevista no puede ser anterior a la fecha de préstamo.");
      return;
    }

    var boton = $("btn-prestar");
    ocupado(boton, "Guardando…");

    cliente.from("prestamos")
      .insert({
        equipo_id: equipo.id,
        equipo: equipo.nombre,
        prestado_a: persona,
        correo_prestado: correoPersona || null,
        fecha_entrega: fecha,
        fecha_limite: plazo,
        nota: nota || null,
        registrado_por: usuario.id,
        registrado_por_correo: usuario.email
      })
      .select()
      .then(function (res) {
        if (res.error) {
          mostrarAviso("prestamo-error", mensajeDatos(res.error));
          // Si otro alcanzó a prestar ese equipo, se refresca la lista.
          if (res.error.code === "23505" || res.error.code === "23503") {
            cargarDatos();
            setTimeout(function () { llenarSelectorEquipos(); }, 800);
          }
          return;
        }
        $("form-prestamo").reset();
        filtroPrestamos = "activos";
        marcarChips("[data-filtro-prestamos]", document.querySelector('[data-filtro-prestamos="activos"]'));
        mostrarVista("prestamos");
        toast("Préstamo registrado correctamente: " + equipo.nombre + " para " + persona + "." +
          (correoPersona ? " La confirmación va para " + correoPersona + "." : ""));
        cargarDatos();
      })
      .catch(function (err) { mostrarAviso("prestamo-error", mensajeDatos(err)); })
      .finally(function () { libre(boton); });
  });

  // Al volver a la pestaña, los datos pueden estar desactualizados: otra
  // persona pudo prestar o devolver algo, o pudo cambiar el día.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && usuario) {
      $("fecha").max = hoyBogota();
      cargarDatos();
    }
  });
})();
