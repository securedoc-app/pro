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
      send({
        kind: "req",
        id: id,
        method: "watch",
        params: { id: id, options: options || {} },
      });
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
    var alive = true;
    var tokens = LIMITS.RATE_BURST,
      last = Date.now();

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
      var col = dbInst.collection(collection);
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
      else if (m.kind === "net" && typeof opts.onNetworkRequest === "function") {
        // Aviso informativo de red (fetch/XHR/sendBeacon/WebSocket). No se
        // bloquea nada aquí: sólo se le muestra al usuario para que decida.
        try {
          opts.onNetworkRequest({ method: m.method, url: m.url });
        } catch (e2) {}
      }
      // 'ready' es informativo; no requiere respuesta
    }
    function sendHello() {
      post({
        kind: "hello",
        context: {
          app: appName,
          readOnly: readOnly,
          capabilities: ["list", "get", "add", "update", "remove", "watch"],
          limits: {
            maxLimit: LIMITS.MAX_LIMIT,
            maxWatchers: LIMITS.MAX_WATCHERS,
          },
        },
      });
    }

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", sendHello);
    iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-modals"); // origen opaco; SIN allow-same-origin
    iframe.srcdoc = injectClient(opts.html);

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
      try {
        iframe.removeAttribute("srcdoc");
      } catch (e) {}
    }
    return { destroy: destroy };
  }

  return { open: open, LIMITS: LIMITS, injectClient: injectClient };
})();
