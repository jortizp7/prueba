/* ==========================================================================
   PRÉSTAMOS DE EQUIPOS
   Tres pantallas: Entrar · La lista · Registrar.
   Sin sesión no se pinta nada de la app.
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

  if (!window.supabase || !CONFIG.url || !CONFIG.anonKey ||
      CONFIG.url.indexOf("TU-PROYECTO") !== -1 || CONFIG.anonKey.indexOf("TU_ANON_KEY") !== -1) {
    mostrarErrorEntrar(
      "Falta configurar la conexión con Supabase. Abre el archivo config.js y pega la URL y la anon key de tu proyecto."
    );
    $("btn-entrar").disabled = true;
    return;
  }

  var cliente = window.supabase.createClient(CONFIG.url, CONFIG.anonKey);

  // ------------------------------------------------------------------------
  // Estado en memoria
  // ------------------------------------------------------------------------
  var usuario = null;
  var prestamos = [];
  var filtro = "prestados";
  var cargando = false;
  var temporizadorToast = null;

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

  function fechaCorta(iso) {
    var p = iso.split("-");
    return +p[2] + " " + MESES[+p[1] - 1].slice(0, 3);
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

  // "Prestado hace 5 días" dice más que una fecha suelta, y no inventa
  // ningún concepto de vencimiento que el alcance no tiene.
  function frasePrestado(fechaEntrega) {
    var dias = diasEntre(fechaEntrega, hoyBogota());
    if (dias < 0) return "Se entrega el " + fechaCorta(fechaEntrega);
    if (dias === 0) return "Entregado hoy";
    if (dias === 1) return "Prestado desde ayer";
    return "Prestado hace " + dias + " días";
  }

  function fraseDevuelto(devueltoEn) {
    var dias = diasEntre(isoDeInstante(devueltoEn), hoyBogota());
    if (dias === 0) return "Devuelto hoy";
    if (dias === 1) return "Devuelto ayer";
    return "Devuelto el " + fechaCorta(isoDeInstante(devueltoEn));
  }

  // ------------------------------------------------------------------------
  // Mensajes de error: cada fallo se traduce a una frase accionable.
  // Nunca se muestra un código técnico ni la palabra "error" a secas.
  // ------------------------------------------------------------------------
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
    if (m.indexOf("failed to fetch") !== -1 || m.indexOf("network") !== -1) {
      return "No pudimos conectar. Revisa tu conexión e inténtalo otra vez.";
    }
    return "No pudimos iniciar sesión. Inténtalo otra vez en unos segundos.";
  }

  function mensajeDatos(error) {
    var m = (error && error.message ? error.message : "").toLowerCase();
    var codigo = error && error.code ? String(error.code) : "";
    if (m.indexOf("failed to fetch") !== -1 || m.indexOf("network") !== -1) {
      return "No pudimos conectar. Revisa tu conexión e inténtalo otra vez.";
    }
    if (codigo === "42501" || m.indexOf("row-level security") !== -1) {
      return "Tu sesión no tiene permiso para guardar esto. Vuelve a entrar e inténtalo de nuevo.";
    }
    if (codigo === "23514") {
      return "Revisa los datos: la fecha de entrega no puede ser posterior a la devolución.";
    }
    if (codigo === "42P01") {
      return "Falta crear las tablas en Supabase. Ejecuta el archivo supabase/schema.sql en el editor SQL.";
    }
    return "No se pudo guardar. Revisa la conexión e inténtalo otra vez.";
  }

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
    var p = document.createElement("span");
    p.textContent = texto;
    n.appendChild(p);
    var cerrar = document.createElement("button");
    cerrar.type = "button";
    cerrar.className = "boton boton--fantasma";
    cerrar.textContent = "Cerrar";
    cerrar.addEventListener("click", ocultarToast);
    n.appendChild(cerrar);
    n.hidden = false;
    anunciar(texto);
    if (temporizadorToast) clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(ocultarToast, 6000);
  }
  function ocultarToast() {
    $("toast").hidden = true;
    if (temporizadorToast) { clearTimeout(temporizadorToast); temporizadorToast = null; }
  }

  // ------------------------------------------------------------------------
  // PANTALLA 1 · ENTRAR
  // ------------------------------------------------------------------------
  $("ver-clave").addEventListener("click", function () {
    var campo = $("clave");
    var visible = campo.type === "text";
    campo.type = visible ? "password" : "text";
    this.textContent = visible ? "Ver" : "Ocultar";
    this.setAttribute("aria-pressed", visible ? "false" : "true");
    campo.focus();
  });

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
    boton.disabled = true;
    boton.textContent = "Entrando…";

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
      .finally(function () {
        boton.disabled = false;
        boton.textContent = "Entrar";
      });
  });

  $("btn-salir").addEventListener("click", function () {
    cliente.auth.signOut();
  });

  // ------------------------------------------------------------------------
  // Puerta de sesión
  // ------------------------------------------------------------------------
  function entrarAlApp(sesion) {
    usuario = sesion.user;
    $("sesion-correo").textContent = usuario.email || "";
    pantallaEntrar.hidden = true;
    app.hidden = false;
    $("clave").value = "";
    limpiarErrorEntrar();
    cargarPrestamos();
  }

  function salirDelApp() {
    usuario = null;
    prestamos = [];
    app.hidden = true;
    pantallaEntrar.hidden = false;
    ocultarToast();
    $("lista").textContent = "";
  }

  cliente.auth.onAuthStateChange(function (evento, sesion) {
    if (sesion && sesion.user) {
      if (!usuario) entrarAlApp(sesion);
      else usuario = sesion.user;
    } else {
      if (usuario) salirDelApp();
    }
  });

  cliente.auth.getSession().then(function (res) {
    if (res.data && res.data.session) entrarAlApp(res.data.session);
  });

  // ------------------------------------------------------------------------
  // Navegación entre pantalla 2 y 3
  // ------------------------------------------------------------------------
  function mostrarVista(cual) {
    var esLista = cual === "lista";
    $("vista-lista").hidden = !esLista;
    $("vista-registrar").hidden = esLista;
    $("tab-lista").setAttribute("aria-selected", esLista ? "true" : "false");
    $("tab-registrar").setAttribute("aria-selected", esLista ? "false" : "true");
    $(esLista ? "vista-lista" : "vista-registrar").focus();
  }

  $("tab-lista").addEventListener("click", function () { mostrarVista("lista"); });
  $("tab-registrar").addEventListener("click", function () { mostrarVista("registrar"); });
  $("btn-vacio-registrar").addEventListener("click", function () { mostrarVista("registrar"); });

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
  // PANTALLA 2 · LA LISTA
  // ------------------------------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll("[data-filtro]"), function (chip) {
    chip.addEventListener("click", function () {
      filtro = chip.getAttribute("data-filtro");
      Array.prototype.forEach.call(document.querySelectorAll("[data-filtro]"), function (otro) {
        otro.setAttribute("aria-pressed", otro === chip ? "true" : "false");
      });
      pintarLista();
    });
  });

  function cargarPrestamos() {
    if (cargando) return;
    cargando = true;
    limpiarAviso("lista-error");

    cliente.from("prestamos")
      .select("*")
      .order("fecha_entrega", { ascending: false })
      .order("creado_en", { ascending: false })
      .then(function (res) {
        if (res.error) {
          mostrarAviso("lista-error", mensajeDatos(res.error));
          return;
        }
        prestamos = res.data || [];
        pintarLista();
      })
      .catch(function (err) { mostrarAviso("lista-error", mensajeDatos(err)); })
      .finally(function () { cargando = false; });
  }

  function filtrados() {
    if (filtro === "prestados") return prestamos.filter(function (p) { return !p.devuelto_en; });
    if (filtro === "devueltos") return prestamos.filter(function (p) { return !!p.devuelto_en; });
    return prestamos;
  }

  var VACIOS = {
    prestados: "Ningún equipo está prestado en este momento.",
    devueltos: "Todavía no hay devoluciones registradas.",
    todos: "Todavía no hay préstamos registrados. Registra el primero y aparecerá aquí."
  };

  function pintarLista() {
    var activos = prestamos.filter(function (p) { return !p.devuelto_en; }).length;
    var devueltos = prestamos.length - activos;

    $("cifra-prestados").textContent = activos;
    $("cifra-devueltos").textContent = devueltos;
    $("cifra-todos").textContent = prestamos.length;

    var items = filtrados();
    var lista = $("lista");
    lista.textContent = "";

    if (!items.length) {
      lista.hidden = true;
      $("lista-vacio").hidden = false;
      $("lista-vacio-texto").textContent = VACIOS[filtro];
      $("lista-conteo").textContent = "";
      return;
    }

    lista.hidden = false;
    $("lista-vacio").hidden = true;
    $("lista-conteo").textContent =
      items.length === 1 ? "1 préstamo" : items.length + " préstamos";

    items.forEach(function (p) { lista.appendChild(construirFila(p)); });
  }

  function construirFila(p) {
    var devuelto = !!p.devuelto_en;

    var li = document.createElement("li");
    li.className = "fila" + (devuelto ? " fila--devuelto" : "");

    // La fila entera se anuncia como una frase completa, no como una pila de
    // celdas sueltas: "Taladro Bosch, prestado a Carlos Ruiz, prestado hace 3 días".
    li.setAttribute("aria-label",
      p.equipo + ", " + (devuelto ? "devuelto" : "prestado") + " a " + p.prestado_a + ", " +
      (devuelto ? fraseDevuelto(p.devuelto_en) : frasePrestado(p.fecha_entrega)));

    var glifo = document.createElement("span");
    glifo.className = "glifo " + (devuelto ? "glifo--devuelto" : "glifo--prestado");
    glifo.setAttribute("aria-hidden", "true");
    li.appendChild(glifo);

    var cuerpo = document.createElement("div");
    cuerpo.className = "fila__cuerpo";

    // Línea 1: equipo ................ fecha de entrega
    var l1 = document.createElement("div");
    l1.className = "fila__linea";
    var equipo = document.createElement("span");
    equipo.className = "fila__equipo";
    equipo.textContent = p.equipo;
    l1.appendChild(equipo);
    var fecha = document.createElement("span");
    fecha.className = "fila__fecha mono";
    fecha.textContent = fechaCorta(p.fecha_entrega);
    fecha.title = "Entregado el " + fechaLarga(p.fecha_entrega);
    l1.appendChild(fecha);
    cuerpo.appendChild(l1);

    // Línea 2: a quién
    var persona = document.createElement("p");
    persona.className = "fila__persona";
    persona.textContent = "Con: ";
    var nombre = document.createElement("strong");
    nombre.textContent = p.prestado_a;
    persona.appendChild(nombre);
    cuerpo.appendChild(persona);

    // Línea 3: estado, en tres canales — glifo, etiqueta escrita y frase.
    var estado = document.createElement("p");
    estado.className = "fila__estado";
    var etiqueta = document.createElement("span");
    etiqueta.className = "etiqueta " + (devuelto ? "etiqueta--devuelto" : "etiqueta--prestado");
    etiqueta.textContent = devuelto ? "Devuelto" : "Prestado";
    estado.appendChild(etiqueta);
    var frase = document.createElement("span");
    frase.textContent = devuelto ? fraseDevuelto(p.devuelto_en) : frasePrestado(p.fecha_entrega);
    estado.appendChild(frase);
    cuerpo.appendChild(estado);

    if (p.nota) {
      var nota = document.createElement("p");
      nota.className = "fila__nota";
      nota.textContent = p.nota;
      cuerpo.appendChild(nota);
    }

    // Pie: la trazabilidad es el único control que existe, porque no hay
    // rol de administrador. Por eso siempre se ve quién hizo cada movimiento.
    var pie = document.createElement("p");
    pie.className = "fila__pie";
    var reg = document.createElement("span");
    reg.textContent = "Registrado por " + p.registrado_por_correo + " · " + instanteLegible(p.creado_en);
    pie.appendChild(reg);
    if (devuelto && p.devuelto_por_correo) {
      var dev = document.createElement("span");
      dev.textContent = "Devolución registrada por " + p.devuelto_por_correo + " · " + instanteLegible(p.devuelto_en);
      pie.appendChild(dev);
    }
    cuerpo.appendChild(pie);

    li.appendChild(cuerpo);

    // Acción
    var accion = document.createElement("div");
    accion.className = "fila__accion";
    if (!devuelto) {
      var boton = document.createElement("button");
      boton.type = "button";
      boton.className = "boton boton--contorno";
      boton.textContent = "Devolver";
      boton.setAttribute("aria-label", "Marcar devolución de " + p.equipo);
      boton.addEventListener("click", function () { devolver(p, boton); });
      accion.appendChild(boton);
    }
    li.appendChild(accion);

    return li;
  }

  // ------------------------------------------------------------------------
  // Marcar como devuelto
  // ------------------------------------------------------------------------
  function devolver(p, boton) {
    boton.disabled = true;
    boton.textContent = "Guardando…";
    limpiarAviso("lista-error");

    cliente.from("prestamos")
      .update({
        devuelto_en: new Date().toISOString(),
        devuelto_por_correo: usuario.email
      })
      .eq("id", p.id)
      // El filtro sobre devuelto_en hace la devolución idempotente: si otra
      // persona ya la marcó, no se sobrescribe su registro, no vuelven filas
      // y se lo decimos como un hecho, no como un fallo.
      .is("devuelto_en", null)
      .select()
      .then(function (res) {
        if (res.error) {
          mostrarAviso("lista-error", mensajeDatos(res.error));
          boton.disabled = false;
          boton.textContent = "Devolver";
          return;
        }
        if (!res.data || !res.data.length) {
          toast("Ese préstamo ya estaba marcado como devuelto.");
          cargarPrestamos();
          return;
        }
        var actualizado = res.data[0];
        for (var i = 0; i < prestamos.length; i++) {
          if (prestamos[i].id === actualizado.id) { prestamos[i] = actualizado; break; }
        }
        pintarLista();
        toast(p.equipo + " quedó marcado como devuelto.");
      })
      .catch(function (err) {
        mostrarAviso("lista-error", mensajeDatos(err));
        boton.disabled = false;
        boton.textContent = "Devolver";
      });
  }

  // ------------------------------------------------------------------------
  // PANTALLA 3 · REGISTRAR
  // ------------------------------------------------------------------------
  $("fecha").value = hoyBogota();

  Array.prototype.forEach.call(document.querySelectorAll("[data-dias]"), function (chip) {
    chip.addEventListener("click", function () {
      $("fecha").value = isoMasDias(hoyBogota(), parseInt(chip.getAttribute("data-dias"), 10));
    });
  });

  $("form-prestamo").addEventListener("submit", function (e) {
    e.preventDefault();
    limpiarAviso("prestamo-error");

    var equipo = $("equipo").value.trim();
    var persona = $("persona").value.trim();
    var fecha = $("fecha").value;
    var nota = $("nota").value.trim();

    if (!equipo) { faltaCampo("equipo", "Escribe qué equipo estás entregando."); return; }
    if (!persona) { faltaCampo("persona", "Escribe a quién le entregas el equipo."); return; }
    if (!fecha) { faltaCampo("fecha", "Indica la fecha en que se entregó el equipo."); return; }
    if (diasEntre(hoyBogota(), fecha) > 0) {
      faltaCampo("fecha", "La fecha de entrega no puede ser futura.");
      return;
    }

    var boton = $("btn-prestar");
    boton.disabled = true;
    boton.textContent = "Guardando…";

    cliente.from("prestamos")
      .insert({
        equipo: equipo,
        prestado_a: persona,
        fecha_entrega: fecha,
        nota: nota || null,
        registrado_por: usuario.id,
        registrado_por_correo: usuario.email
      })
      .select()
      .then(function (res) {
        if (res.error) {
          mostrarAviso("prestamo-error", mensajeDatos(res.error));
          return;
        }
        if (res.data && res.data.length) prestamos.unshift(res.data[0]);
        $("form-prestamo").reset();
        $("fecha").value = hoyBogota();
        filtro = "prestados";
        Array.prototype.forEach.call(document.querySelectorAll("[data-filtro]"), function (c) {
          c.setAttribute("aria-pressed", c.getAttribute("data-filtro") === "prestados" ? "true" : "false");
        });
        pintarLista();
        mostrarVista("lista");
        toast(equipo + " quedó a nombre de " + persona + ".");
      })
      .catch(function (err) { mostrarAviso("prestamo-error", mensajeDatos(err)); })
      .finally(function () {
        boton.disabled = false;
        boton.textContent = "Registrar préstamo";
      });
  });

  function faltaCampo(id, texto) {
    mostrarAviso("prestamo-error", texto);
    $(id).focus();
  }

  // Al volver a la pestaña, la lista puede estar desactualizada: otra persona
  // pudo registrar o devolver algo mientras tanto.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && usuario) cargarPrestamos();
  });
})();
