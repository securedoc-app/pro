/**
 * app-runner.js — Puente consola ↔ app y ejecución aislada
 * -----------------------------------------------------
 * Las apps generadas por IA son PERSONALES y se ejecutan DENTRO de SecureDoc,
 * no como sitios públicos autónomos. No configuran Firebase ni tienen login:
 * la consola es la pasarela de datos.
 *
 * Modelo de aislamiento:
 *   - La app corre en un <iframe sandbox="allow-scripts"> (ORIGEN OPACO): no puede
 *     tocar la consola, ni sus cookies, ni el Firestore descifrado. Como el origen
 *     es opaco NO validamos por e.origin, sino por e.source === iframe.contentWindow.
 *   - No se embebe código ajeno en la consola (accedaría a secretos ya descifrados).
 *   - Todo el acceso a datos pasa por un puente postMessage con contrato cerrado.
 *
 * Contrato del sobre:  { v:1, channel:'securedoc', kind, ... }
 *   kinds: hello (consola→app), ready (app→consola), req (app→consola),
 *          res (consola→app), event (consola→app, para watch).
 *   La API de datos (SecureDoc.data.*) devuelve Promesas.
 *   Servicios externos (opcional, ver js/connections.js): SecureDoc.api.call(
 *   nombre, valores) y SecureDoc.openLink(url). La app pide por nombre; la
 *   consola pone la URL y el token y NUNCA se los entrega a la app.
 *
 * Límites de seguridad aplicados en la consola (lado de confianza):
 *   MAX_LIMIT 500, MAX_BYTES 64KB, MAX_DEPTH 8, MAX_WATCHERS 5, RATE 20/s ráfaga 40.
 * Namespace reservado: ids y campos con prefijo '_' quedan ocultos y no escribibles.
 *
 * La consola lee/escribe con UserFirebase.session(S.fb) (sesión del dueño).
 */
const AppRunner = (() => {
  "use strict";

  const V = 1,
    CH = "securedoc";
  const LIMITS = {
    MAX_LIMIT: 500,
    MAX_BYTES: 64 * 1024,
    MAX_DEPTH: 8,
    MAX_WATCHERS: 5,
    RATE_PER_SEC: 20,
    RATE_BURST: 40,
  };
  // Tiempo máximo (ms) que esperamos a navigator.geolocation antes de rechazar
  // la promesa de SecureDoc.geo.current(), para que no se quede colgada.
  const GEO_TIMEOUT_MS = 12000;
  // Límites de SecureDoc.files.*: leer texto hasta 1 MB; subir/descargar binario
  // (blob) hasta 5 MB. Son límites de confianza aplicados en la consola.
  const FILE_LIMITS = {
    READ_MAX_BYTES: 1 * 1024 * 1024,
    WRITE_MAX_BYTES: 5 * 1024 * 1024,
    BLOB_MAX_BYTES: 5 * 1024 * 1024,
  };
  // Tipo MIME según la extensión, para que files.url() entregue un Blob con el
  // Content-Type correcto (imágenes, PDF, vídeo, etc.).
  const MIME = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", md: "text/markdown",
    json: "application/json", xml: "application/xml", html: "text/html", htm: "text/html",
    js: "text/javascript", css: "text/css",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    zip: "application/zip", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  function mimeOf(path) {
    var s = String(path || "");
    var i = s.lastIndexOf(".");
    var ext = i >= 0 ? s.slice(i + 1).toLowerCase() : "";
    return MIME[ext] || "application/octet-stream";
  }
  const OPS = new Set([
    "==",
    "!=",
    "<",
    "<=",
    ">",
    ">=",
    "in",
    "array-contains",
  ]);
  const CODES = [
    "bad-request",
    "not-found",
    "permission-denied",
    "too-large",
    "rate-limited",
    "unavailable",
    "internal",
    // Servicios externos (ver js/connections.js): sólo los usa SecureDoc.api.*
    "not-configured",
    "expired",
    "network-error",
    "bad-response",
  ];

  // ================= CLIENTE INYECTADO (corre DENTRO del iframe) =================
  // Se serializa a texto y se antepone al HTML de la app. Define window.SecureDoc.
  // No tiene acceso a nada de la consola: sólo habla por postMessage con el padre.
  function CLIENT(V, CH, MAXW) {
    "use strict";
    var pending = {},
      watchers = {},
      seq = 0,
      ctx = null,
      readyCbs = [],
      isReady = false;
    function uid() {
      return ++seq + "-" + Math.random().toString(36).slice(2);
    }
    function send(msg) {
      msg.v = V;
      msg.channel = CH;
      parent.postMessage(msg, "*");
    }
    // Intercepta fetch/XHR/sendBeacon/WebSocket SÓLO para avisar a la consola
    // qué peticiones de red hace la app (transparencia). No bloquea ni altera
    // el resultado de la llamada: el usuario decide si confía, no nosotros.
    (function () {
      var origFetch = window.fetch;
      if (typeof origFetch === "function") {
        window.fetch = function (input, init) {
          try {
            var url =
              typeof input === "string"
                ? input
                : (input && input.url) || String(input);
            send({ kind: "net", method: "fetch", url: url });
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      }
      var OrigXHR = window.XMLHttpRequest;
      if (OrigXHR && OrigXHR.prototype && OrigXHR.prototype.open) {
        var origOpen = OrigXHR.prototype.open;
        OrigXHR.prototype.open = function (method, url) {
          try {
            send({ kind: "net", method: "xhr", url: String(url) });
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };
      }
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        var origBeacon = navigator.sendBeacon;
        navigator.sendBeacon = function (url, data) {
          try {
            send({ kind: "net", method: "sendBeacon", url: String(url) });
          } catch (e) {}
          return origBeacon.apply(this, arguments);
        };
      }
      var OrigWS = window.WebSocket;
      if (typeof OrigWS === "function") {
        window.WebSocket = function (url, protocols) {
          try {
            send({ kind: "net", method: "websocket", url: String(url) });
          } catch (e) {}
          return protocols !== undefined
            ? new OrigWS(url, protocols)
            : new OrigWS(url);
        };
        window.WebSocket.prototype = OrigWS.prototype;
      }
    })();
    function req(method, params) {
      return new Promise(function (res, rej) {
        var id = uid();
        pending[id] = { res: res, rej: rej };
        send({ kind: "req", id: id, method: method, params: params || {} });
      });
    }
    // cloneNode()/outerHTML NUNCA copian el contenido de un shadow root (así lo
    // define el propio DOM): un componente Web Component de tus "Bibliotecas"
    // (una barra de navegación, una barra de progreso, etc.) que dibuje su
    // apariencia ahí desaparecería por completo de la foto de impresión, y con
    // ella su CSS encapsulado (por eso se ve "sin estilo"). Se recorre el
    // documento a mano y, donde un elemento tenga shadowRoot ABIERTO, se
    // insertan sus hijos como si fueran DOM normal ("aplanado"): los
    // selectores ":host" del CSS de ese componente dejan de aplicar al
    // aplanarse (ya no hay límite de shadow que los delimite), pero el resto
    // de su hoja de estilos sigue funcionando, ahora de forma global en la
    // foto. Un shadow CERRADO (closed) no es accesible desde fuera: no hay
    // nada que hacer con él (poco común; las librerías de SecureDoc se piden
    // siempre con shadow ABIERTO o sin shadow).
    function cloneWithShadow(node) {
      if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
      if (node.nodeType !== 1) return node.cloneNode(false);
      // <slot>: el propio navegador NUNCA "pinta" el <slot> en sí, pinta el
      // contenido de luz que tiene ASIGNADO (assignedNodes) en su lugar —o,
      // si no tiene nada asignado, su contenido de respaldo declarado dentro.
      // Sin este reemplazo, el texto de un componente como una barra de
      // navegación (proyectado vía <slot>) quedaba colgado como hermano
      // suelto DESPUÉS de la barra en vez de aparecer dentro de ella.
      if (node.tagName === "SLOT" && typeof node.assignedNodes === "function") {
        var assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) {
          var frag = document.createDocumentFragment();
          for (var a = 0; a < assigned.length; a++) {
            frag.appendChild(cloneWithShadow(assigned[a]));
          }
          return frag;
        }
        // sin nada asignado: sigue abajo y clona el contenido de respaldo
        // del propio <slot>, como lo haría el navegador en pantalla.
      }
      var clone = document.createElement(node.tagName);
      var attrs = node.attributes || [];
      for (var i = 0; i < attrs.length; i++) {
        clone.setAttribute(attrs[i].name, attrs[i].value);
      }
      // Un elemento fijado al viewport (position:fixed) o pegado al hacer
      // scroll (position:sticky) escapa del flujo normal del documento: en
      // la impresión, eso lo pinta ARRIBA de nuestro encabezado sin importar
      // en qué orden aparezcan en el HTML (p. ej. la barra de navegación fija
      // de la app). Se fuerza a "static" en el clon para que respete el
      // flujo normal y el encabezado de impresión quede siempre primero.
      try {
        var computedPos = window.getComputedStyle(node).position;
        if (computedPos === "fixed" || computedPos === "sticky") {
          clone.style.setProperty("position", "static", "important");
        }
      } catch (eComputed) {}
      if (node.shadowRoot) {
        // Sin esto, el elemento quedaría "inline" por defecto (así tratan los
        // navegadores a un elemento desconocido/personalizado sin CSS), aun
        // cuando su :host original decía display:block.
        clone.style.display = clone.style.display || "block";
        var sc = node.shadowRoot.childNodes;
        for (var s = 0; s < sc.length; s++) {
          clone.appendChild(cloneWithShadow(sc[s]));
        }
        // Los hijos de LUZ del host solo se ven en pantalla si algún <slot>
        // de su shadow root los proyecta (ya resuelto arriba, dentro del
        // clon del shadow root): no se repiten aquí como hijos sueltos,
        // igual que el navegador no los pintaría dos veces ni sin proyectar.
      } else {
        var kids = node.childNodes;
        for (var k2 = 0; k2 < kids.length; k2++) {
          clone.appendChild(cloneWithShadow(kids[k2]));
        }
      }
      return clone;
    }

    // Función "Imprimir" (cintillo externo de la consola): arma una FOTO estática
    // de lo que la app tiene en pantalla en este momento. document.documentElement
    // .outerHTML por sí solo NO alcanza porque value/checked/selected son
    // PROPIEDADES en vivo, no atributos reflejados en el HTML: un <input> que el
    // usuario ya llenó, o un <select> ya elegido, saldrían vacíos/con su valor
    // original. Por eso se clona el documento y se copian esas propiedades vivas
    // a atributos del clon (mismo orden estructural: mismo índice en ambos
    // querySelectorAll). Se quitan los <script> porque es una foto, no debe
    // volver a ejecutarse (y en la copia de impresión ni siquiera existiría
    // window.SecureDoc para que la app hable con la consola).
    function buildPrintSnapshot() {
      var clone = cloneWithShadow(document.documentElement);
      var liveCtrls = document.querySelectorAll("input, textarea, select");
      var cloneCtrls = clone.querySelectorAll("input, textarea, select");
      for (var i = 0; i < liveCtrls.length; i++) {
        var live = liveCtrls[i],
          c = cloneCtrls[i];
        if (!c) continue;
        var tag = live.tagName;
        if (tag === "TEXTAREA") {
          c.textContent = live.value;
        } else if (tag === "SELECT") {
          var liveOpts = live.options,
            cloneOpts = c.options;
          for (var j = 0; j < liveOpts.length; j++) {
            if (!cloneOpts[j]) continue;
            if (liveOpts[j].selected) cloneOpts[j].setAttribute("selected", "");
            else cloneOpts[j].removeAttribute("selected");
          }
        } else {
          var type = (live.getAttribute("type") || "text").toLowerCase();
          if (type === "checkbox" || type === "radio") {
            if (live.checked) c.setAttribute("checked", "");
            else c.removeAttribute("checked");
          } else if (type !== "password") {
            c.setAttribute("value", live.value);
          }
        }
      }
      var scripts = clone.querySelectorAll("script");
      for (var k = 0; k < scripts.length; k++) {
        scripts[k].parentNode.removeChild(scripts[k]);
      }
      return clone.outerHTML;
    }
    window.addEventListener("message", function (e) {
      if (e.source !== parent) return; // sólo mensajes de la consola
      var m = e.data;
      if (!m || m.channel !== CH || m.v !== V) return;
      if (m.kind === "hello") {
        ctx = m.context || {};
        isReady = true;
        readyCbs.splice(0).forEach(function (fn) {
          try {
            fn(ctx);
          } catch (x) {}
        });
        send({ kind: "ready" });
        return;
      }
      if (m.kind === "print-snapshot-req") {
        var htmlOut = "";
        try {
          htmlOut = buildPrintSnapshot();
        } catch (e4) {
          try {
            htmlOut = document.documentElement.outerHTML;
          } catch (e5) {
            htmlOut = "";
          }
        }
        send({
          kind: "print-snapshot-res",
          id: m.id,
          html: htmlOut,
          title: document.title || "",
        });
        return;
      }
      if (m.kind === "res") {
        var p = pending[m.id];
        if (p) {
          delete pending[m.id];
          if (m.ok) p.res(m.result);
          else {
            var err = new Error((m.error && m.error.message) || "Error");
            err.code = m.error && m.error.code;
            p.rej(err);
          }
          return;
        }
        // No es una respuesta de req(): puede ser el rechazo inicial de un
        // watch() (p. ej. límite de suscripciones o consulta inválida). Si tuvo
        // éxito no hay nada que hacer aquí (los datos llegan por 'event'); si
        // falló, hay que avisar por onError y liberar el cupo, porque si no
        // este mensaje se pierde en silencio y la app nunca se entera del error.
        var wRes = watchers[m.id];
        if (wRes && !m.ok) {
          delete watchers[m.id];
          if (wRes.onError) {
            try {
              wRes.onError(
                m.error || { code: "internal", message: "Error al suscribirse" },
              );
            } catch (x) {}
          }
        }
        return;
      }
      if (m.kind === "event") {
        var w = watchers[m.id];
        if (!w) return;
        if (m.event === "snapshot") {
          try {
            w.cb(m.result);
          } catch (x) {}
        } else if (m.event === "error" && w.onError) {
          try {
            w.onError(m.error);
          } catch (x) {}
        }
      }
    });
    function watch(options, cb, onError) {
      if (typeof options === "function") {
        onError = cb;
        cb = options;
        options = {};
      }
      if (typeof cb !== "function")
        throw new Error("watch necesita una función de callback");
      if (Object.keys(watchers).length >= MAXW)
        throw new Error("Demasiadas suscripciones activas (máx. " + MAXW + ")");
      var id = uid();
      watchers[id] = { cb: cb, onError: onError };
      var __app = options && options.__app;
      if (__app) {
        var optNoApp = {};
        for (var k in options)
          if (options.hasOwnProperty(k) && k !== "__app") optNoApp[k] = options[k];
        send({
          kind: "req",
          id: id,
          method: "db.watch",
          params: { id: id, app: __app, options: optNoApp },
        });
      } else {
        send({
          kind: "req",
          id: id,
          method: "watch",
          params: { id: id, options: options || {} },
        });
      }
      return function () {
        if (watchers[id]) {
          delete watchers[id];
          send({
            kind: "req",
            id: uid(),
            method: "unwatch",
            params: { id: id },
          });
        }
      };
    }
    window.SecureDoc = {
      get context() {
        return ctx;
      },
      ready: function (fn) {
        if (typeof fn !== "function") return;
        if (isReady) {
          try {
            fn(ctx);
          } catch (x) {}
        } else readyCbs.push(fn);
      },
      data: {
        list: function (options) {
          return req("list", { options: options || {} });
        },
        get: function (id) {
          return req("get", { id: id });
        },
        add: function (data) {
          return req("add", { data: data });
        },
        update: function (id, patch) {
          return req("update", { id: id, patch: patch });
        },
        remove: function (id) {
          return req("remove", { id: id });
        },
        watch: watch,
        serverTimestamp: function () {
          return { __sd: "serverTimestamp" };
        },
        now: function () {
          return new Date().toISOString();
        },
      },
      // Servicios externos declarados por la app (ver js/connections.js). La app
      // pide por NOMBRE y con valores; NUNCA conoce la URL ni el token: la
      // consola arma la URL, agrega el token y devuelve solo el resultado.
      api: {
        call: function (name, params) {
          return req("api.call", { name: name, params: params || {} });
        },
      },
      // Abrir un enlace (p. ej. uno que devolvió un servicio) en una pestaña
      // nueva: la consola lo valida y, si el servidor no es uno ya confirmado,
      // pide confirmación al usuario. Un <a target="_blank"> dentro del iframe no
      // funciona (el sandbox no permite ventanas nuevas).
      openLink: function (url) {
        return req("openLink", { url: url });
      },
      // Ubicación del dispositivo. El iframe de la app es de origen opaco y no
      // puede llamar al GPS; por eso lo pide la CONSOLA (ventana superior, con
      // origen real y HTTPS). La primera vez el navegador pedirá permiso al
      // usuario. current() resuelve { lat, lng, accuracy } (accuracy en metros,
      // puede venir null si el navegador no lo informa).
      geo: {
        current: function () {
          return req("geo.current", {});
        },
      },
      // Archivos del usuario (repositorios de documentos de la sección «Archivos»).
      // El token de GitHub NUNCA entra al iframe: la CONSOLA lee/escribe y sólo
      // devuelve el resultado. Reglas: se pueden LEER todos los repositorios de
      // archivos; sólo se puede ESCRIBIR/BORRAR en el repositorio PROPIO de la app
      // (uno como máximo), que la app obtiene con requestRepo(). Leer/escribir en el
      // repo propio no requiere trámite (igual que data/geo); crear el repo propio
      // la primera vez pide una confirmación ligera al usuario.
      files: {
        // Lista los repositorios de archivos disponibles (todos de lectura). Cada
        // uno trae { id, name, repo, private, branch, folders, pages, createdAt,
        // mine } — mine:true es el repositorio propio de esta app.
        repos: function () {
          return req("files.repos", {});
        },
        // Lista el contenido de una carpeta de un repositorio (repoId = el "id"
        // devuelto por repos(), o la cadena "owner/name"). folder vacío = raíz.
        // Devuelve [{ name, path, type:'file'|'dir', size }].
        list: function (repoId, folder) {
          return req("files.list", { repo: repoId, folder: folder || "" });
        },
        // Lee un archivo de TEXTO (hasta 1 MB) de cualquier repositorio. Devuelve
        // { path, name, size, text }.
        read: function (repoId, path) {
          return req("files.read", { repo: repoId, path: path });
        },
        // Obtiene una URL utilizable dentro de la app (<img src>, <a href>, etc.)
        // para un archivo (hasta 5 MB) de cualquier repositorio. La consola envía
        // el contenido en base64 y el Blob/objectURL se crea DENTRO del iframe
        // (origen opaco: la URL blob del padre no serviría). Devuelve
        // { url, name, mime, size }. Recuerda liberar la URL con
        // URL.revokeObjectURL(url) cuando dejes de usarla.
        url: function (repoId, path) {
          return req("files.blob", { repo: repoId, path: path }).then(
            function (r) {
              var b64 = (r && r.base64) || "";
              var bin = atob(b64);
              var len = bin.length;
              var bytes = new Uint8Array(len);
              for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
              var blob = new Blob([bytes], {
                type: (r && r.mime) || "application/octet-stream",
              });
              return {
                url: URL.createObjectURL(blob),
                name: r && r.name,
                mime: r && r.mime,
                size: r && r.size,
              };
            },
          );
        },
        // Crea (una sola vez) el repositorio PROPIO de la app: privado, con el
        // nombre que decide SecureDoc, y aparece en la sección «Archivos» marcado
        // con el nombre de la app. Es idempotente: si ya existe, lo devuelve sin
        // volver a crearlo. Devuelve el registro { id, name, repo, ..., mine:true }.
        requestRepo: function () {
          return req("files.requestRepo", {});
        },
        // Guarda un archivo en el repositorio PROPIO de la app (créalo antes con
        // requestRepo()). path admite carpetas ("notas/hoy.txt"). content puede ser
        // una cadena de texto, o un objeto { base64, binary:true } para binarios
        // (hasta 5 MB). Devuelve { path, size }.
        save: function (path, content, opts) {
          var o = opts || {};
          var params = { path: path, message: o.message };
          if (content && typeof content === "object" && content.base64) {
            params.base64 = String(content.base64);
            params.binary = true;
          } else if (o.binary && typeof content === "string") {
            params.base64 = content;
            params.binary = true;
          } else {
            params.text = content == null ? "" : String(content);
          }
          return req("files.save", params);
        },
        // Borra un archivo del repositorio PROPIO de la app. Devuelve true.
        remove: function (path) {
          return req("files.remove", { path: path });
        },
      },
      // Datos de OTRAS apps del usuario (acceso cruzado declarado). Solo funciona
      // con las apps que ESTA app declaró en su definición (appsVinculadas); con
      // cualquier otra da permission-denied. Permisos: leer (list/get/watch) y
      // escribir add/update; NO se puede borrar en otra app. Para TUS propios
      // datos usa SecureDoc.data.*. appId es el identificador que devuelve apps().
      db: {
        // Lista las apps que esta app puede usar (las declaradas + la propia).
        // Devuelve [{ id, name, mine }].
        apps: function () {
          return req("db.apps", {});
        },
        list: function (appId, options) {
          return req("db.list", { app: appId, options: options || {} });
        },
        get: function (appId, id) {
          return req("db.get", { app: appId, id: id });
        },
        add: function (appId, data) {
          return req("db.add", { app: appId, data: data });
        },
        update: function (appId, id, patch) {
          return req("db.update", { app: appId, id: id, patch: patch });
        },
        // Tiempo real sobre otra app. Cuenta en el mismo límite de 5 watch y
        // devuelve un unsubscribe(), igual que data.watch.
        watch: function (appId, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = {};
          }
          var o = {};
          for (var k in options)
            if (options.hasOwnProperty(k)) o[k] = options[k];
          o.__app = appId;
          return watch(o, cb);
        },
      },
    };
  }

  function clientSource() {
    return (
      "(" +
      CLIENT.toString() +
      ")(" +
      V +
      "," +
      JSON.stringify(CH) +
      "," +
      LIMITS.MAX_WATCHERS +
      ");"
    );
  }

  // Hace que la app herede el tema visual (Bootswatch) que el usuario tiene
  // elegido en la consola (ver js/theme.js), para que no se vea "desentonada"
  // dentro del mismo panel. Es puramente cosmético y de solo-lectura:
  //   - Si el usuario no eligió tema (Bootstrap por defecto), no toca nada.
  //   - Si la app no carga el Bootstrap 5.3.3 estándar por CDN (por ejemplo,
  //     no usa Bootstrap, o usa otra versión), tampoco toca nada: mejor dejar
  //     la app intacta que arriesgarse a romper sus estilos.
  function injectTheme(html) {
    var s = String(html || "");
    try {
      if (typeof Theme === "undefined") return s;
      var name = Theme.saved();
      if (!name) return s; // tema por defecto: la app ya trae el mismo Bootstrap
      var RE_BS_HREF =
        /https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.3\/dist\/css\/bootstrap\.min\.css/gi;
      if (RE_BS_HREF.test(s)) {
        s = s.replace(RE_BS_HREF, Theme.themeUrl(name));
      }
    } catch (e) {}
    return s;
  }

  // Inserta el cliente al principio del documento SIN romper el <!DOCTYPE> (modo
  // estándar) y antes de cualquier script de la app.
  function injectClient(html) {
    var tag = "<script>" + clientSource() + "<\/script>";
    var s = String(html || "");
    var mHead = s.match(/<head[^>]*>/i);
    if (mHead) return s.replace(mHead[0], mHead[0] + "\n" + tag);
    var mHtml = s.match(/<html[^>]*>/i);
    if (mHtml) return s.replace(mHtml[0], mHtml[0] + "\n" + tag);
    var mDoc = s.match(/<!DOCTYPE[^>]*>/i);
    if (mDoc) return s.replace(mDoc[0], mDoc[0] + "\n" + tag);
    return tag + "\n" + s;
  }
  // ================= LADO CONSOLA (confianza) =================
  function err(code, message) {
    return { code: code, message: message };
  }

  // Reemplaza el sentinel { __sd:'serverTimestamp' } por el FieldValue real.
  function convertSentinels(value) {
    if (Array.isArray(value)) return value.map(convertSentinels);
    if (value && typeof value === "object") {
      if (value.__sd === "serverTimestamp")
        return firebase.firestore.FieldValue.serverTimestamp();
      var o = {};
      for (var k in value)
        if (Object.prototype.hasOwnProperty.call(value, k))
          o[k] = convertSentinels(value[k]);
      return o;
    }
    return value;
  }

  // Comprueba que sea JSON "plano" y respete la profundidad máxima.
  function checkPlain(value, depth) {
    if (depth > LIMITS.MAX_DEPTH)
      throw err(
        "bad-request",
        "Estructura de datos demasiado anidada (máx. " + LIMITS.MAX_DEPTH + ")",
      );
    if (value === null) return;
    var t = typeof value;
    if (t === "string" || t === "boolean") return;
    if (t === "number") {
      if (!isFinite(value)) throw err("bad-request", "Número no válido");
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(function (v) {
        checkPlain(v, depth + 1);
      });
      return;
    }
    if (t === "object") {
      if (value.__sd === "serverTimestamp") return; // sentinel permitido como valor
      for (var k in value)
        if (Object.prototype.hasOwnProperty.call(value, k))
          checkPlain(value[k], depth + 1);
      return;
    }
    throw err("bad-request", "Tipo de dato no permitido en los datos");
  }

  // Valida datos/patch de escritura: objeto plano, sin campos reservados, dentro
  // del límite de tamaño. Devuelve una copia con los sentinels convertidos.
  function validateData(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data))
      throw err("bad-request", "Los datos deben ser un objeto");
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      if (k.charAt(0) === "_")
        throw err(
          "bad-request",
          'Campo reservado no permitido: "' +
            k +
            '" (los campos con "_" están reservados)',
        );
    }
    checkPlain(data, 0);
    var bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    if (bytes > LIMITS.MAX_BYTES)
      throw err(
        "too-large",
        "Los datos superan el límite de " + LIMITS.MAX_BYTES / 1024 + " KB",
      );
    return convertSentinels(data);
  }

  // Convierte valores de Firestore a JSON clonable por postMessage (Timestamp→ISO).
  function toPlain(value) {
    if (value && typeof value.toDate === "function") {
      try {
        return value.toDate().toISOString();
      } catch (e) {
        return null;
      }
    }
    if (Array.isArray(value)) return value.map(toPlain);
    if (value && typeof value === "object") {
      var o = {};
      for (var k in value)
        if (Object.prototype.hasOwnProperty.call(value, k))
          o[k] = toPlain(value[k]);
      return o;
    }
    return value;
  }
  function docToPlain(doc) {
    return Object.assign({ id: doc.id }, toPlain(doc.data() || {}));
  }
  function reserved(id) {
    return String(id == null ? "" : id).charAt(0) === "_";
  }

  // Construye la consulta a partir de options, aplicando los límites.
  function buildQuery(base, options) {
    var q = base,
      o = options || {};
    if (o.where != null) {
      if (!Array.isArray(o.where))
        throw err("bad-request", '"where" debe ser una lista de condiciones');
      o.where.forEach(function (w) {
        if (!Array.isArray(w) || w.length !== 3)
          throw err(
            "bad-request",
            "Cada condición where debe ser [campo, operador, valor]",
          );
        if (!OPS.has(w[1]))
          throw err("bad-request", "Operador no permitido: " + w[1]);
        if (String(w[0]).charAt(0) === "_")
          throw err(
            "bad-request",
            'No se puede filtrar por campos reservados ("_")',
          );
        q = q.where(w[0], w[1], w[2]);
      });
    }
    if (o.orderBy != null) {
      var f =
        typeof o.orderBy === "string"
          ? o.orderBy
          : o.orderBy && o.orderBy.field;
      var d =
        o.orderBy && typeof o.orderBy === "object" && o.orderBy.dir
          ? o.orderBy.dir
          : "asc";
      if (d !== "asc" && d !== "desc")
        throw err("bad-request", "Dirección de orden no válida (asc|desc)");
      if (f) q = q.orderBy(f, d);
    }
    var lim = Number(o.limit);
    if (!isFinite(lim) || lim <= 0) lim = LIMITS.MAX_LIMIT;
    q = q.limit(Math.min(Math.floor(lim), LIMITS.MAX_LIMIT));
    return q;
  }
  // Traduce el error capturado a nuestro sobre { code, message }.
  function toError(e) {
    if (e && typeof e.code === "string" && CODES.indexOf(e.code) >= 0)
      return err(e.code, e.message || "Error");
    var code = e && e.code;
    var msg = (e && e.message) || "Error interno";
    if (code === "permission-denied" || code === "unauthenticated")
      return err("permission-denied", msg);
    if (code === "not-found") return err("not-found", msg);
    if (code === "unavailable" || code === "deadline-exceeded")
      return err("unavailable", msg);
    if (code === "invalid-argument" || code === "failed-precondition")
      return err("bad-request", msg);
    return err("internal", msg);
  }

  /**
   * Arranca una app dentro de un iframe con el puente de datos.
   * @param {Object} opts
   *   iframe      {HTMLIFrameElement} destino (se le fija sandbox y srcdoc)
   *   html        {string}           HTML de la app (sin login ni Firebase)
   *   collection  {string}           colección Firestore real (la app NO la conoce)
   *   getDb       {Function}         () => firestore | Promise<firestore> (sesión dueño)
   *   appName     {string}           nombre mostrado en context.app
   *   readOnly    {boolean}          si true, bloquea add/update/remove
   * @returns {{ destroy: Function }}
   */
  function open(opts) {
    opts = opts || {};
    var iframe = opts.iframe,
      collection = opts.collection,
      getDb = opts.getDb;
    var readOnly = !!opts.readOnly,
      appName = opts.appName || "App";
    if (!iframe || !collection || typeof getDb !== "function") {
      throw new Error(
        "AppRunner.open: faltan opciones obligatorias (iframe, collection, getDb)",
      );
    }

    var unsubs = {}; // watchId -> unsubscribe de onSnapshot
    var pendingSnapshots = {}; // id -> {resolve, reject, timer} de requestPrintSnapshot()
    var alive = true;
    var tokens = LIMITS.RATE_BURST,
      last = Date.now();

    // ---- Servicios externos (opcional; ver js/connections.js) ----
    // Si la consola no pasa "connections" (o falta el módulo), SecureDoc.api.* y
    // SecureDoc.openLink responden con error y NADA cambia para las apps de hoy.
    //   connections: {
    //     declared  [{name, label, params, …}]  declaración validada de la app
    //     get       async (name) => conexión descifrada | null
    //     onNeeded  (name, reason) => void       falta configurar / venció
    //     onRejected(name, {status}) => void     el servicio rechazó el token
    //     onCall    ({name, host, label, ok, status, ms}) => void  (sin secretos)
    //     confirmLink async ({url, host, needsConfirm}) => boolean
    //     openUrl   (url) => void                abre la pestaña nueva
    //     fetch, now, timeoutMs, maxBytes        (inyectables, para pruebas)
    //   }
    var connOpts = opts.connections || null;
    var svcDecl = {};
    var connEnabled = false;
    var apiBuckets = {},
      apiInflight = 0,
      linkBucket = null;
    if (
      connOpts &&
      typeof Connections !== "undefined" &&
      Array.isArray(connOpts.declared) &&
      connOpts.declared.length &&
      typeof connOpts.get === "function"
    ) {
      connOpts.declared.forEach(function (s) {
        if (s && typeof s.name === "string") svcDecl[s.name] = s;
      });
      connEnabled = Object.keys(svcDecl).length > 0;
    }

    // ---- Archivos del usuario (opcional; ver SecureDoc.files.*) ----
    // Si la consola no pasa "files" (o falta GitHubAPI), SecureDoc.files.* responde
    // con error y nada cambia para las apps de hoy. El token de GitHub NUNCA entra
    // al iframe: sólo lo usa la consola a través de estos ganchos.
    //   files: {
    //     appSlug   string                         slug de la app (marca de propiedad)
    //     getToken  () => token | Promise<token>   token de GitHub del dueño
    //     getRepos  () => [registros fileRepos]     repos de archivos registrados
    //     saveRepos async (lista) => void           persiste el registro actualizado
    //     confirmCreateRepo async ({name,repo,appSlug}) => bool  confirmación 1ª vez
    //   }
    var filesOpts = opts.files || null;
    var filesEnabled =
      !!(filesOpts &&
        typeof GitHubAPI !== "undefined" &&
        typeof filesOpts.getToken === "function" &&
        typeof filesOpts.getRepos === "function" &&
        typeof filesOpts.saveRepos === "function" &&
        typeof filesOpts.appSlug === "string" &&
        filesOpts.appSlug);

    // ---- Datos de otras apps del usuario (opcional; ver SecureDoc.db.*) ----
    // Si la consola no pasa "db", SecureDoc.db.* responde con error y nada cambia
    // para las apps de hoy. La app NUNCA conoce la colección real: la resuelve la
    // consola, y sólo contra las apps que la app declaró (whitelist).
    //   db: {
    //     getApps  () => [{ id, name, mine }]              apps visibles (declaradas + propia)
    //     resolve  (appId) => { collection, self } | null  colección real si está autorizada
    //     confirmAccess async (appId) => bool              confirmación 1ª vez (apps ajenas)
    //   }
    var dbOpts = opts.db || null;
    var dbEnabled = !!(dbOpts && typeof dbOpts.resolve === "function");

    // La sesión de datos se obtiene UNA sola vez por app y se REUTILIZA. Es crítico:
    // UserFirebase.session() hace teardown()+reconnect() (borra la named app de
    // Firebase y vuelve a autenticar). Si se invocara en CADA petición, un add/
    // update/remove destruiría la instancia sobre la que están montados los
    // onSnapshot de watch(), matando el tiempo real: la app carga bien la primera
    // vez y luego ya no vuelve a refrescarse. Cacheando la sesión, los listeners
    // sobreviven a las escrituras.
    var dbPromise = null;
    function getSession() {
      if (!dbPromise) {
        dbPromise = Promise.resolve()
          .then(getDb)
          .then(function (d) {
            if (!d) throw new Error("sin sesión");
            return d;
          })
          .catch(function (e) {
            dbPromise = null;
            throw e;
          }); // permite reintentar luego
      }
      return dbPromise;
    }
    function allow() {
      var now = Date.now();
      tokens = Math.min(
        LIMITS.RATE_BURST,
        tokens + ((now - last) / 1000) * LIMITS.RATE_PER_SEC,
      );
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    }

    function post(msg) {
      if (!alive) return;
      msg.v = V;
      msg.channel = CH;
      try {
        iframe.contentWindow.postMessage(msg, "*");
      } catch (e) {}
    }
    function respond(id, ok, payload) {
      post(
        ok
          ? { kind: "res", id: id, ok: true, result: payload }
          : { kind: "res", id: id, ok: false, error: payload },
      );
    }

    // Botón "Imprimir" del cintillo externo (lado consola, de confianza): le pide
    // a la app, por el mismo canal postMessage, una foto de lo que muestra ahora
    // mismo (ver buildPrintSnapshot() en CLIENT). No toca Firestore ni límites de
    // datos: es una operación de UI, independiente de handleReq().
    function requestPrintSnapshot(timeoutMs) {
      return new Promise(function (resolve, reject) {
        if (!alive || !iframe.contentWindow) {
          reject(new Error("La app ya no está activa."));
          return;
        }
        var id = "snap-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
        var timer = setTimeout(function () {
          delete pendingSnapshots[id];
          reject(new Error("La app no respondió a tiempo."));
        }, timeoutMs || 4000);
        pendingSnapshots[id] = { resolve: resolve, reject: reject, timer: timer };
        post({ kind: "print-snapshot-req", id: id });
      });
    }

    // Llama un gancho OPCIONAL de la consola sin que un fallo suyo rompa el puente.
    function hook(name) {
      var f = connOpts && connOpts[name];
      if (typeof f !== "function") return;
      try {
        var r = f.apply(connOpts, Array.prototype.slice.call(arguments, 1));
        if (r && typeof r.catch === "function") r.catch(function () {});
      } catch (e) {}
    }

    // SecureDoc.api.call(nombre, valores): la CONSOLA hace la llamada (ver
    // Connections.call). La app nunca ve la URL ni el token, y ningún mensaje de
    // error que vuelve a la app contiene el token ni la URL con él.
    async function handleApiCall(m, params) {
      if (!connEnabled) {
        respond(m.id, false, err("bad-request", "Esta app no declaró servicios externos."));
        return;
      }
      var name = typeof params.name === "string" ? params.name : "";
      if (!Object.prototype.hasOwnProperty.call(svcDecl, name)) {
        respond(
          m.id,
          false,
          err("bad-request", 'Servicio no declarado: "' + name.slice(0, 40) + '".'),
        );
        return;
      }
      var svc = svcDecl[name];
      var bucket =
        apiBuckets[name] ||
        (apiBuckets[name] = Connections.makeBucket(
          Connections.LIMITS.RATE_PER_SEC,
          Connections.LIMITS.RATE_BURST,
        ));
      if (!bucket.take()) {
        respond(
          m.id,
          false,
          err("rate-limited", "Demasiadas consultas al servicio; espera un momento."),
        );
        return;
      }
      // El cupo se reserva ANTES de cualquier "await": si se comprobara y se
      // sumara después, una ráfaga de peticiones llegadas en el mismo instante
      // pasaría todas la comprobación antes de que ninguna sumara.
      if (apiInflight >= Connections.LIMITS.MAX_INFLIGHT) {
        respond(m.id, false, err("rate-limited", "Hay demasiadas consultas en curso."));
        return;
      }
      apiInflight++;
      var t0 = Date.now();
      var conn = null;
      try {
        try {
          conn = await connOpts.get(name);
        } catch (e) {
          respond(
            m.id,
            false,
            err(
              "permission-denied",
              "La consola está bloqueada o no puede leer las conexiones. Desbloquea con tu frase.",
            ),
          );
          return;
        }
        if (!conn) {
          hook("onNeeded", name, "missing");
          respond(
            m.id,
            false,
            err(
              "not-configured",
              'La conexión "' + name + '" aún no está configurada. SecureDoc te pedirá los datos.',
            ),
          );
          return;
        }
        var out = await Connections.call(svc, conn, params.params, {
          fetch: connOpts.fetch,
          now: typeof connOpts.now === "function" ? connOpts.now() : undefined,
          timeoutMs: connOpts.timeoutMs,
          maxBytes: connOpts.maxBytes,
        });
        hook("onCall", {
          name: name,
          host: out.host,
          label: out.label,
          ok: true,
          status: out.status,
          ms: Date.now() - t0,
        });
        respond(m.id, true, out.data);
      } catch (e) {
        if (e && (e.code === "not-configured" || e.code === "expired"))
          hook("onNeeded", name, e.code === "expired" ? "expired" : "unconfirmed");
        if (e && e.credentialRejected) hook("onRejected", name, { status: e.status });
        hook("onCall", {
          name: name,
          host: conn ? Connections.hostOf(conn.url) : "",
          ok: false,
          status: (e && e.status) || 0,
          ms: Date.now() - t0,
        });
        // Solo códigos conocidos y mensajes propios: nunca el texto crudo de un
        // error inesperado (podría traer la URL, y con ella el token).
        if (e && typeof e.code === "string" && CODES.indexOf(e.code) >= 0)
          respond(m.id, false, err(e.code, e.message));
        else
          respond(m.id, false, err("internal", "Error interno al consultar el servicio."));
      } finally {
        apiInflight--;
      }
    }

    // SecureDoc.openLink(url): abre una pestaña nueva tras validar el enlace. Si
    // su servidor no es uno de los ya confirmados en las conexiones de la app,
    // se pide confirmación al usuario (gancho confirmLink).
    async function handleOpenLink(m, params) {
      if (!connEnabled) {
        respond(m.id, false, err("bad-request", "Esta app no declaró servicios externos."));
        return;
      }
      if (!linkBucket)
        linkBucket = Connections.makeBucket(
          Connections.LIMITS.LINK_RATE_PER_SEC,
          Connections.LIMITS.LINK_RATE_BURST,
        );
      if (!linkBucket.take()) {
        respond(m.id, false, err("rate-limited", "Demasiados enlaces seguidos; espera un momento."));
        return;
      }
      var hosts = [];
      try {
        var names = Object.keys(svcDecl);
        for (var i = 0; i < names.length; i++) {
          var c = await connOpts.get(names[i]);
          if (c && c.confirmedHost) hosts.push(c.confirmedHost);
        }
      } catch (e) {
        respond(
          m.id,
          false,
          err(
            "permission-denied",
            "La consola está bloqueada o no puede leer las conexiones. Desbloquea con tu frase.",
          ),
        );
        return;
      }
      var chk;
      try {
        chk = Connections.checkLink(params.url, hosts);
      } catch (e) {
        respond(m.id, false, toError(e));
        return;
      }
      if (chk.needsConfirm) {
        var accepted = false;
        if (typeof connOpts.confirmLink === "function") {
          try {
            accepted =
              (await connOpts.confirmLink({ url: chk.url, host: chk.host, needsConfirm: true })) ===
              true;
          } catch (e) {
            accepted = false;
          }
        }
        if (!accepted) {
          respond(
            m.id,
            false,
            err("permission-denied", "No se abrió el enlace: el usuario no lo confirmó."),
          );
          return;
        }
      }
      try {
        if (typeof connOpts.openUrl === "function") connOpts.openUrl(chk.url);
        else {
          // Los enlaces solo se abren cuando el usuario los pide con un clic. Sin
          // activación de usuario el navegador bloquearía la ventana EN SILENCIO
          // (con "noopener" window.open siempre devuelve null) y la app creería
          // que se abrió: mejor decírselo con un error claro.
          var ua = typeof navigator !== "undefined" ? navigator.userActivation : null;
          if (ua && ua.isActive === false) {
            respond(
              m.id,
              false,
              err(
                "permission-denied",
                "El enlace solo se abre cuando el usuario lo pide con un clic (el navegador bloquea las ventanas que se abren solas).",
              ),
            );
            return;
          }
          window.open(chk.url, "_blank", "noopener,noreferrer");
        }
      } catch (e) {
        respond(m.id, false, err("unavailable", "No se pudo abrir el enlace."));
        return;
      }
      respond(m.id, true, null);
    }

    // SecureDoc.geo.current(): la CONSOLA (ventana superior, origen real + HTTPS)
    // obtiene la ubicación con navigator.geolocation y devuelve SOLO
    // { lat, lng }. La primera vez el navegador pide permiso al usuario. Se
    // aplica un timeout propio para no dejar la promesa colgada y se mapean los
    // fallos nativos a los códigos de error ya existentes.
    function handleGeoCurrent(m) {
      var geo =
        typeof navigator !== "undefined" ? navigator.geolocation : null;
      if (!geo || typeof geo.getCurrentPosition !== "function") {
        respond(
          m.id,
          false,
          err("unavailable", "Este navegador no permite obtener la ubicaci\u00f3n."),
        );
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        finish(false, err("unavailable", "La ubicaci\u00f3n tard\u00f3 demasiado en responder."));
      }, GEO_TIMEOUT_MS);
      function finish(ok, payload) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        respond(m.id, ok, payload);
      }
      try {
        geo.getCurrentPosition(
          function (pos) {
            var c = pos && pos.coords;
            if (
              !c ||
              typeof c.latitude !== "number" ||
              typeof c.longitude !== "number"
            ) {
              finish(false, err("unavailable", "No se pudo leer la ubicaci\u00f3n."));
              return;
            }
            // accuracy: radio de incertidumbre en metros (puede faltar en
            // algunos navegadores); si no es un número válido va null.
            var acc =
              typeof c.accuracy === "number" && isFinite(c.accuracy)
                ? c.accuracy
                : null;
            finish(true, { lat: c.latitude, lng: c.longitude, accuracy: acc });
          },
          function (gerr) {
            // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
            if (gerr && gerr.code === 1) {
              finish(
                false,
                err("permission-denied", "El usuario no concedi\u00f3 el permiso de ubicaci\u00f3n."),
              );
            } else if (gerr && gerr.code === 3) {
              finish(
                false,
                err("unavailable", "La ubicaci\u00f3n tard\u00f3 demasiado en responder."),
              );
            } else {
              finish(
                false,
                err("unavailable", "La ubicaci\u00f3n no est\u00e1 disponible en este momento."),
              );
            }
          },
          { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
        );
      } catch (e) {
        finish(false, err("unavailable", "No se pudo obtener la ubicaci\u00f3n."));
      }
    }

    // ================= SecureDoc.files.* (lado consola, de confianza) =================
    // La consola usa GitHubAPI con el token del dueño (que NUNCA sale de aquí).
    // Reglas: lectura en todos los repos de archivos registrados; escritura/borrado
    // sólo en el repositorio propio de la app (ownerApp === appSlug).

    // Resuelve el token (puede venir síncrono o como promesa). Lanza si falta.
    function filesToken() {
      return Promise.resolve()
        .then(function () {
          return filesOpts.getToken();
        })
        .then(function (t) {
          if (!t) {
            var e = new Error(
              "La consola est\u00e1 bloqueada o no hay sesi\u00f3n de GitHub. Desbloquea con tu frase.",
            );
            e.code = "permission-denied";
            throw e;
          }
          return t;
        });
    }
    function filesList() {
      return Promise.resolve().then(function () {
        var r = filesOpts.getRepos();
        return Array.isArray(r) ? r : [];
      });
    }
    // Vista pública de un registro (lo que ve la app). No añade nada sensible.
    function pubRepo(r) {
      return {
        id: r.id,
        name: r.name,
        repo: r.repo,
        private: !!r.private,
        branch: r.branch || "main",
        folders: Array.isArray(r.folders) ? r.folders.slice() : [],
        pages: !!r.pages,
        createdAt: r.createdAt || null,
        mine: r.ownerApp === filesOpts.appSlug,
      };
    }
    function findRepo(list, ref) {
      ref = String(ref || "");
      for (var i = 0; i < list.length; i++)
        if (list[i].id === ref) return list[i];
      for (var j = 0; j < list.length; j++)
        if (list[j].repo === ref) return list[j];
      return null;
    }
    // Normaliza y valida una ruta dentro del repo: sin barras iniciales, sin
    // segmentos ".." y no vacía. Devuelve la ruta limpia o lanza bad-request.
    function safePath(p) {
      var s = String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\/+/, "");
      var segs = s.split("/").filter(function (x) {
        return x !== "" && x !== ".";
      });
      if (!segs.length || segs.indexOf("..") >= 0) {
        var e = new Error("Ruta de archivo no v\u00e1lida.");
        e.code = "bad-request";
        throw e;
      }
      return segs.join("/");
    }
    function ownerName(r) {
      var parts = String(r.repo).split("/");
      return { owner: parts[0], repo: parts[1] };
    }
    // base64 (ArrayBuffer) -> cadena, por trozos para no desbordar la pila.
    function bytesToB64(bytes) {
      var bin = "";
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(
          null,
          bytes.subarray(i, Math.min(i + chunk, bytes.length)),
        );
      }
      return btoa(bin);
    }
    // base64 (GitHub, con saltos de línea) -> texto UTF-8.
    function b64ToText(b64) {
      var bin = atob(String(b64 || "").replace(/\n/g, ""));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (typeof TextDecoder !== "undefined")
        return new TextDecoder("utf-8").decode(bytes);
      return decodeURIComponent(escape(bin));
    }
    // Longitud en bytes de una cadena de texto UTF-8.
    function utf8Len(str) {
      if (typeof TextEncoder !== "undefined")
        return new TextEncoder().encode(str).length;
      return unescape(encodeURIComponent(str)).length;
    }
    // Tamaño aproximado (bytes) de un contenido base64.
    function b64Len(b64) {
      var s = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
      var pad = (s.match(/=+$/) || [""])[0].length;
      return Math.floor((s.length * 3) / 4) - pad;
    }

    // files.repos: lista los repositorios de archivos (todos de lectura).
    async function handleFilesRepos(m) {
      try {
        var list = await filesList();
        respond(
          m.id,
          true,
          list.map(function (r) {
            return pubRepo(r);
          }),
        );
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // files.list: contenido de una carpeta de cualquier repositorio registrado.
    async function handleFilesList(m, params) {
      try {
        var list = await filesList();
        var r = findRepo(list, params.repo);
        if (!r) {
          respond(m.id, false, err("not-found", "Repositorio no encontrado."));
          return;
        }
        var token = await filesToken();
        var on = ownerName(r);
        var folder = String(params.folder || "").replace(/^\/+|\/+$/g, "");
        var items = await GitHubAPI.listDir(token, on.owner, on.repo, folder);
        respond(
          m.id,
          true,
          items
            .filter(function (it) {
              return it && it.name && it.name !== ".gitkeep";
            })
            .map(function (it) {
              return {
                name: it.name,
                path: it.path,
                type: it.type === "dir" ? "dir" : "file",
                size: typeof it.size === "number" ? it.size : 0,
              };
            }),
        );
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // files.read: lee un archivo de TEXTO (hasta READ_MAX_BYTES) de cualquier repo.
    async function handleFilesRead(m, params) {
      try {
        var list = await filesList();
        var r = findRepo(list, params.repo);
        if (!r) {
          respond(m.id, false, err("not-found", "Repositorio no encontrado."));
          return;
        }
        var path = safePath(params.path);
        var token = await filesToken();
        var on = ownerName(r);
        var f = await GitHubAPI.getContent(token, on.owner, on.repo, path);
        if (!f || Array.isArray(f) || f.type !== "file") {
          respond(m.id, false, err("not-found", "El archivo no existe."));
          return;
        }
        if (typeof f.size === "number" && f.size > FILE_LIMITS.READ_MAX_BYTES) {
          respond(
            m.id,
            false,
            err(
              "too-large",
              "El archivo supera 1 MB; usa files.url() para leerlo como binario.",
            ),
          );
          return;
        }
        var text = f.content ? b64ToText(f.content) : "";
        respond(m.id, true, {
          path: f.path,
          name: f.name,
          size: typeof f.size === "number" ? f.size : utf8Len(text),
          text: text,
        });
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // files.blob (lo pide SecureDoc.files.url): devuelve el archivo en base64 para
    // que el iframe construya el Blob/objectURL. Hasta BLOB_MAX_BYTES.
    async function handleFilesBlob(m, params) {
      try {
        var list = await filesList();
        var r = findRepo(list, params.repo);
        if (!r) {
          respond(m.id, false, err("not-found", "Repositorio no encontrado."));
          return;
        }
        var path = safePath(params.path);
        var token = await filesToken();
        var on = ownerName(r);
        var blob = await GitHubAPI.getRawBlob(token, on.owner, on.repo, path);
        if (blob && typeof blob.size === "number" && blob.size > FILE_LIMITS.BLOB_MAX_BYTES) {
          respond(
            m.id,
            false,
            err("too-large", "El archivo supera 5 MB y no se puede abrir."),
          );
          return;
        }
        var buf = await blob.arrayBuffer();
        var name = path.split("/").pop();
        respond(m.id, true, {
          base64: bytesToB64(new Uint8Array(buf)),
          mime: mimeOf(path),
          name: name,
          size: buf.byteLength,
        });
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // files.requestRepo: crea (una sola vez) el repositorio PROPIO de la app.
    // Idempotente, privado, nombre decidido por SecureDoc, confirmación la 1ª vez.
    async function handleFilesRequestRepo(m) {
      try {
        var list = await filesList();
        var mine = list.filter(function (r) {
          return r.ownerApp === filesOpts.appSlug;
        })[0];
        if (mine) {
          respond(m.id, true, pubRepo(mine));
          return;
        }
        var token = await filesToken();
        var user = await GitHubAPI.getAuthenticatedUser(token);
        var owner = user && user.login;
        if (!owner) {
          respond(m.id, false, err("unavailable", "No se pudo leer tu cuenta de GitHub."));
          return;
        }
        var slug = String(filesOpts.appSlug)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "app";
        var base = "securedoc-app-" + slug;
        var name = base;
        var n = 2;
        while (await GitHubAPI.repoExists(token, owner, name)) {
          name = base + "-" + n;
          n++;
          if (n > 50) {
            respond(
              m.id,
              false,
              err("unavailable", "No se pudo encontrar un nombre libre para el repositorio."),
            );
            return;
          }
        }
        if (typeof filesOpts.confirmCreateRepo === "function") {
          var ok = false;
          try {
            ok =
              (await filesOpts.confirmCreateRepo({
                name: name,
                repo: owner + "/" + name,
                appSlug: filesOpts.appSlug,
              })) === true;
          } catch (e) {
            ok = false;
          }
          if (!ok) {
            respond(
              m.id,
              false,
              err("permission-denied", "El usuario no autoriz\u00f3 crear el repositorio."),
            );
            return;
          }
        }
        var created = await GitHubAPI.createRepo(
          token,
          name,
          true,
          "Archivos de la app " + filesOpts.appSlug + " \u00b7 SecureDoc",
        );
        var rec = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: name,
          repo: (created && created.full_name) || owner + "/" + name,
          private: true,
          branch: (created && created.default_branch) || "main",
          folders: [],
          pages: false,
          createdAt: new Date().toISOString(),
          ownerApp: filesOpts.appSlug,
        };
        await Promise.resolve(filesOpts.saveRepos(list.concat(rec)));
        respond(m.id, true, pubRepo(rec));
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // files.save: escribe en el repositorio PROPIO de la app (texto o binario).
    async function handleFilesSave(m, params) {
      try {
        var list = await filesList();
        var mine = list.filter(function (r) {
          return r.ownerApp === filesOpts.appSlug;
        })[0];
        if (!mine) {
          respond(
            m.id,
            false,
            err(
              "permission-denied",
              "La app a\u00fan no tiene repositorio propio. Ll\u00e1malo con files.requestRepo() antes de guardar.",
            ),
          );
          return;
        }
        var path = safePath(params.path);
        var token = await filesToken();
        var on = ownerName(mine);
        if (params.binary) {
          var b64 = String(params.base64 || "");
          if (b64Len(b64) > FILE_LIMITS.WRITE_MAX_BYTES) {
            respond(m.id, false, err("too-large", "El archivo supera 5 MB."));
            return;
          }
          await GitHubAPI.putBinaryFile(
            token,
            on.owner,
            on.repo,
            path,
            b64.replace(/\n/g, ""),
            params.message || "Guarda " + path,
          );
          respond(m.id, true, { path: path, size: b64Len(b64) });
        } else {
          var text = String(params.text == null ? "" : params.text);
          var len = utf8Len(text);
          if (len > FILE_LIMITS.WRITE_MAX_BYTES) {
            respond(m.id, false, err("too-large", "El archivo supera 5 MB."));
            return;
          }
          await GitHubAPI.putFile(
            token,
            on.owner,
            on.repo,
            path,
            text,
            params.message || "Guarda " + path,
          );
          respond(m.id, true, { path: path, size: len });
        }
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // files.remove: borra un archivo del repositorio PROPIO de la app.
    async function handleFilesRemove(m, params) {
      try {
        var list = await filesList();
        var mine = list.filter(function (r) {
          return r.ownerApp === filesOpts.appSlug;
        })[0];
        if (!mine) {
          respond(
            m.id,
            false,
            err("permission-denied", "La app no tiene repositorio propio."),
          );
          return;
        }
        var path = safePath(params.path);
        var token = await filesToken();
        var on = ownerName(mine);
        await GitHubAPI.deleteFile(
          token,
          on.owner,
          on.repo,
          path,
          params.message || "Elimina " + path,
        );
        respond(m.id, true, true);
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    // ================= SecureDoc.db.* (datos de OTRAS apps, de confianza) =================
    // La app sólo puede tocar las apps que declaró (whitelist resuelta por la
    // consola) y la propia. Lectura y escritura add/update; borrar en otra app
    // NO se permite. La colección real la decide la consola, nunca la app.
    async function handleDbApps(m) {
      try {
        var a = dbOpts.getApps ? dbOpts.getApps() : [];
        if (!Array.isArray(a)) a = [];
        respond(
          m.id,
          true,
          a.map(function (x) {
            return { id: x.id, name: x.name || x.id, mine: !!x.mine };
          }),
        );
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }
    // Confirmaciones ya dadas en esta sesión (por app destino), para no repetir.
    var dbGranted = {};
    async function dbConfirm(appId) {
      if (dbGranted[appId]) return true;
      var ok = true;
      if (typeof dbOpts.confirmAccess === "function") {
        try {
          ok = (await dbOpts.confirmAccess(appId)) === true;
        } catch (e) {
          ok = false;
        }
      }
      if (ok) dbGranted[appId] = true;
      return ok;
    }

    async function handleReq(m) {
      var method = m.method,
        params = m.params || {};
      if (method !== "unwatch" && !allow()) {
        respond(
          m.id,
          false,
          err(
            "rate-limited",
            "Demasiadas peticiones seguidas; espera un momento.",
          ),
        );
        return;
      }
      if (method === "unwatch") {
        var u = unsubs[params.id];
        if (u) {
          try {
            u();
          } catch (e) {}
          delete unsubs[params.id];
        }
        respond(m.id, true, null);
        return;
      }
      // Servicios externos: no necesitan Firestore, se resuelven antes de abrir
      // la sesión de datos.
      if (method === "api.call") {
        await handleApiCall(m, params);
        return;
      }
      if (method === "openLink") {
        await handleOpenLink(m, params);
        return;
      }
      // Ubicación: no necesita Firestore, la resuelve la consola directamente.
      if (method === "geo.current") {
        handleGeoCurrent(m);
        return;
      }
      // Archivos: no necesitan Firestore; usan GitHubAPI con el token del dueño.
      if (method.indexOf("files.") === 0) {
        if (!filesEnabled) {
          respond(
            m.id,
            false,
            err("bad-request", "Esta app no tiene acceso a los archivos."),
          );
          return;
        }
        if (method === "files.repos") {
          await handleFilesRepos(m);
        } else if (method === "files.list") {
          await handleFilesList(m, params);
        } else if (method === "files.read") {
          await handleFilesRead(m, params);
        } else if (method === "files.blob") {
          await handleFilesBlob(m, params);
        } else if (method === "files.requestRepo") {
          await handleFilesRequestRepo(m);
        } else if (method === "files.save") {
          await handleFilesSave(m, params);
        } else if (method === "files.remove") {
          await handleFilesRemove(m, params);
        } else {
          respond(
            m.id,
            false,
            err("bad-request", "Método de archivos desconocido: " + method),
          );
        }
        return;
      }
      // Datos de OTRAS apps del usuario: usan Firestore igual que data.*, pero
      // sobre la colección de la app indicada (resuelta y autorizada por la consola).
      var crossColl = null;
      if (method.indexOf("db.") === 0) {
        if (!dbEnabled) {
          respond(
            m.id,
            false,
            err("bad-request", "Esta app no puede usar datos de otras apps."),
          );
          return;
        }
        var sub = method.slice(3);
        if (sub === "apps") {
          await handleDbApps(m);
          return;
        }
        if (["list", "get", "add", "update", "watch"].indexOf(sub) < 0) {
          respond(
            m.id,
            false,
            err("bad-request", "Método de datos desconocido: " + method),
          );
          return;
        }
        var appId = String((params && (params.app || params.appId)) || "");
        var resolved;
        try {
          resolved = await Promise.resolve(dbOpts.resolve(appId));
        } catch (e) {
          respond(m.id, false, toError(e));
          return;
        }
        if (!resolved || !resolved.collection) {
          respond(
            m.id,
            false,
            err(
              "permission-denied",
              "Esta app no está autorizada a usar los datos de \u00ab" + appId + "\u00bb.",
            ),
          );
          return;
        }
        if (!resolved.self) {
          var okc = await dbConfirm(appId);
          if (!okc) {
            respond(
              m.id,
              false,
              err(
                "permission-denied",
                "No autorizaste el acceso a los datos de \u00ab" + appId + "\u00bb.",
              ),
            );
            return;
          }
        }
        crossColl = resolved.collection;
        method = sub; // list|get|add|update|watch (remove queda excluido)
      }
      var dbInst;
      try {
        dbInst = await getSession();
      } catch (e) {
        respond(
          m.id,
          false,
          err(
            "permission-denied",
            "La consola está bloqueada o sin acceso configurado. Desbloquea con tu frase.",
          ),
        );
        return;
      }
      var col = dbInst.collection(crossColl || collection);
      try {
        if (method === "list") {
          var snap = await buildQuery(col, params.options).get();
          var out = [];
          snap.forEach(function (d) {
            if (!reserved(d.id)) out.push(docToPlain(d));
          });
          respond(m.id, true, out);
          return;
        }
        if (method === "get") {
          if (reserved(params.id)) {
            respond(m.id, true, null);
            return;
          } // oculto
          var d = await col.doc(String(params.id)).get();
          respond(m.id, true, d.exists ? docToPlain(d) : null);
          return;
        }
        if (method === "add") {
          if (readOnly) {
            respond(
              m.id,
              false,
              err("permission-denied", "Esta app es de sólo lectura."),
            );
            return;
          }
          var dataAdd = validateData(params.data);
          var refAdd = await col.add(dataAdd);
          respond(m.id, true, { id: refAdd.id });
          return;
        }
        if (method === "update") {
          if (readOnly) {
            respond(
              m.id,
              false,
              err("permission-denied", "Esta app es de sólo lectura."),
            );
            return;
          }
          if (reserved(params.id)) {
            respond(
              m.id,
              false,
              err(
                "permission-denied",
                "Documento reservado; no se puede modificar.",
              ),
            );
            return;
          }
          var patch = validateData(params.patch);
          await col.doc(String(params.id)).set(patch, { merge: true });
          respond(m.id, true, null);
          return;
        }
        if (method === "remove") {
          if (readOnly) {
            respond(
              m.id,
              false,
              err("permission-denied", "Esta app es de sólo lectura."),
            );
            return;
          }
          if (reserved(params.id)) {
            respond(
              m.id,
              false,
              err(
                "permission-denied",
                "Documento reservado; no se puede eliminar.",
              ),
            );
            return;
          }
          await col.doc(String(params.id)).delete();
          respond(m.id, true, null);
          return;
        }
        if (method === "watch") {
          var wid = params.id;
          if (!wid) {
            respond(
              m.id,
              false,
              err("bad-request", "Falta el id de la suscripción"),
            );
            return;
          }
          if (Object.keys(unsubs).length >= LIMITS.MAX_WATCHERS) {
            respond(
              m.id,
              false,
              err(
                "rate-limited",
                "Demasiadas suscripciones activas (máx. " +
                  LIMITS.MAX_WATCHERS +
                  ")",
              ),
            );
            return;
          }
          var qy;
          try {
            qy = buildQuery(col, params.options);
          } catch (e2) {
            respond(m.id, false, toError(e2));
            return;
          }
          unsubs[wid] = qy.onSnapshot(
            function (s) {
              var arr = [];
              s.forEach(function (d) {
                if (!reserved(d.id)) arr.push(docToPlain(d));
              });
              post({ kind: "event", id: wid, event: "snapshot", result: arr });
            },
            function (e3) {
              post({
                kind: "event",
                id: wid,
                event: "error",
                error: toError(e3),
              });
            },
          );
          respond(m.id, true, null);
          return;
        }
        respond(
          m.id,
          false,
          err("bad-request", "Método desconocido: " + method),
        );
      } catch (e) {
        respond(m.id, false, toError(e));
      }
    }

    function onMessage(e) {
      if (!alive || !iframe.contentWindow || e.source !== iframe.contentWindow)
        return; // origen opaco: validar por source
      var m = e.data;
      if (!m || m.channel !== CH || m.v !== V) return;
      if (m.kind === "req") handleReq(m);
      else if (m.kind === "print-snapshot-res") {
        var pend = pendingSnapshots[m.id];
        if (pend) {
          delete pendingSnapshots[m.id];
          clearTimeout(pend.timer);
          pend.resolve({ html: m.html || "", title: m.title || "" });
        }
      } else if (m.kind === "net" && typeof opts.onNetworkRequest === "function") {
        // Aviso informativo de red (fetch/XHR/sendBeacon/WebSocket). No se
        // bloquea nada aquí: sólo se le muestra al usuario para que decida.
        try {
          opts.onNetworkRequest({ method: m.method, url: m.url });
        } catch (e2) {}
      }
      // 'ready' es informativo; no requiere respuesta
    }
    function sendHello() {
      var caps = ["list", "get", "add", "update", "remove", "watch", "geo"];
      var context = {
        app: appName,
        readOnly: readOnly,
        capabilities: caps,
        limits: {
          maxLimit: LIMITS.MAX_LIMIT,
          maxWatchers: LIMITS.MAX_WATCHERS,
        },
      };
      // Solo si la app declaró servicios externos: así el contexto de las apps
      // de hoy queda exactamente igual que antes.
      if (connEnabled) {
        caps.push("api", "openLink");
        context.services = Object.keys(svcDecl).map(function (n) {
          var s = svcDecl[n];
          return {
            name: n,
            label: s.label || n,
            description: s.description || "",
            params: (s.params || []).map(function (p) {
              return p.name;
            }),
          };
        });
      }
      // Si la consola habilitó el acceso a archivos, se anuncia la capacidad.
      if (filesEnabled) caps.push("files");
      // Si la consola habilitó el acceso a datos de otras apps.
      if (dbEnabled) caps.push("db");
      post({ kind: "hello", context: context });
    }

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", sendHello);
    iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-modals"); // origen opaco; SIN allow-same-origin
    iframe.srcdoc = injectClient(injectTheme(opts.html));

    function destroy() {
      if (!alive) return;
      alive = false;
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", sendHello);
      Object.keys(unsubs).forEach(function (k) {
        try {
          unsubs[k]();
        } catch (e) {}
      });
      unsubs = {};
      Object.keys(pendingSnapshots).forEach(function (k) {
        try {
          clearTimeout(pendingSnapshots[k].timer);
          pendingSnapshots[k].reject(new Error("La app se cerró."));
        } catch (e) {}
      });
      pendingSnapshots = {};
      try {
        iframe.removeAttribute("srcdoc");
      } catch (e) {}
    }
    return { destroy: destroy, requestPrintSnapshot: requestPrintSnapshot };
  }

  return { open: open, LIMITS: LIMITS, injectClient: injectClient, injectTheme: injectTheme };
})();
