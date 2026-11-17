/**
 * Archivos adjuntos desde la app (uso general): comprobantes de pago en foto o PDF.
 *
 * Cuando llega un archivo con la pregunta:
 *   1. Se guarda en Google Drive, en la carpeta única de pendientes (CARPETA_PENDIENTES_ID, Config.gs).
 *   2. La IA lee el comprobante y devuelve los datos en JSON (quién transfiere, monto, fecha…).
 *   3. Se le pasa al agente como texto, con el valor "drive:<id>" para la columna de comprobante.
 * Al guardar el registro en Notion, la columna queda con el link del archivo y el archivo se mueve a la
 * carpeta que corresponde (por ejemplo la del evento) y se renombra, según la regla "archivos" del
 * archivo Sistema_*.gs. Qué hacer con los datos leídos (a quién y a qué corresponde) lo dicen sus notas.
 */

const TIPOS_ARCHIVO = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_BYTES_ARCHIVO = 8 * 1024 * 1024;

/**
 * @param {{nombre: string, tipo: string, datos: string}} archivo  datos en base64 (sin "data:...;base64,")
 * @param {string} modelo  modelo elegido en la app (define qué IA lee el comprobante)
 * @return {string} texto para anteponer al mensaje del usuario
 */
function procesarAdjunto_(archivo, modelo) {
  if (!archivo || !archivo.datos) return '';
  const nombre = String(archivo.nombre || 'comprobante').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
  const bytes = Utilities.base64Decode(archivo.datos);
  // Android a veces manda el archivo sin tipo (o "application/octet-stream"): se deduce por el contenido.
  const tipo = tipoPorContenido_(bytes, String(archivo.tipo || '').toLowerCase(), nombre);
  if (TIPOS_ARCHIVO.indexOf(tipo) < 0) throw new Error('Tipo de archivo no soportado (' + (tipo || 'desconocido') + '). Mandá una foto (JPG o PNG) o un PDF.');
  if (bytes.length > MAX_BYTES_ARCHIVO) throw new Error('El archivo es muy grande (máximo 8 MB).');

  const partes = ['[Archivo adjunto por el usuario: "' + nombre + '".'];

  // 1) Leer el comprobante o la factura
  paso_('Leyendo el archivo…');
  let datos = null;
  try {
    datos = leerComprobante_(archivo.datos, tipo, modelo);
  } catch (e) {
    partes.push('No pude leer el contenido del archivo (' + e.message + '); pedile los datos al usuario.');
  }

  // 2) Guardar en Drive, en la carpeta de pendientes (al confirmar se mueve a su carpeta final)
  paso_('Guardando el archivo en Drive…');
  try {
    const f = carpetaPendientes_().createFile(Utilities.newBlob(bytes, tipo,
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH.mm.ss') + ' ' + nombre));
    partes.push('Ya está guardado en Google Drive (pendiente): para adjuntarlo, en la columna de archivo o comprobante (por ejemplo "Comprobante" o "Archivo") usá el valor "drive:' + f.getId() + '" en guardar_registro; al guardar queda el link y el archivo se ordena solo en su carpeta.');
  } catch (e) {
    partes.push('No se pudo guardar el archivo en Drive (' + e.message + '), así que no se puede adjuntar; los datos sí se pueden cargar.');
  }
  if (datos) partes.push('Datos leídos del archivo: ' + JSON.stringify(datos) + '.');
  if (datos) {
    try { buscarAlLeer_(datos).forEach(function (t) { partes.push(t); }); }
    catch (e) { /* si falla la búsqueda automática, el agente busca por su cuenta */ }
  }
  partes.push('Decidí a qué sistema corresponde según las notas de cada sistema (si dudás, preguntá), seguí sus reglas para identificar a quién y a qué corresponde, y preguntale al usuario antes de cargar nada.]');
  return partes.join(' ');
}

const PROMPT_COMPROBANTE = [
  'Leé este archivo. Puede ser un comprobante de pago (transferencia, Mercado Pago, depósito, recibo) o una factura/boleta a pagar (luz, gas, agua, internet, impuestos, alquiler, etc.). Extraé los datos.',
  'Respondé SOLO con un objeto JSON, sin texto alrededor, con estas claves (null si no aparece):',
  '{"tipo_documento": "comprobante de pago"|"factura"|"otro", "es_comprobante": true|false, "medio": "transferencia"|"mercado pago"|"depósito"|"efectivo"|"débito automático"|"tarjeta"|"otro",',
  ' "monto": número sin separadores de miles, "moneda": "ARS"|"USD"|..., "fecha": "AAAA-MM-DD", "hora": "HH:MM",',
  ' "ordenante_nombre": nombre de quien paga/transfiere, "ordenante_cuit_dni": solo dígitos, "ordenante_banco": banco de la cuenta de origen,',
  ' "origen": app o entidad DESDE donde se hizo el pago, deducida por el logo, los colores, el diseño o el texto (por ejemplo "Cuenta DNI", "Mercado Pago", "Naranja X", "Ualá", "Brubank", "Banco Galicia", "Banco Nación", "Santander", "BBVA", "Personal Pay", "Modo"); null si no se puede saber,',
  ' "destinatario_nombre": texto, "destinatario_cuit_dni": solo dígitos, "numero_operacion": número de operación, transacción, comprobante o ID de la transferencia (texto),',
  ' "concepto": texto del concepto o referencia,',
  ' solo si es factura: "proveedor_nombre": razón social que figura (ej. "AMX Argentina S.A."), "proveedor_marca": nombre comercial o marca que se ve en el logo (ej. "Claro"), "proveedor_cuit": solo dígitos, "nro_factura", "nro_cliente": tal como figura (cliente, cuenta, suministro, partida o contrato),',
  ' "fecha_emision": "AAAA-MM-DD", "vencimiento": "AAAA-MM-DD" (el primero si hay varios), "periodo": texto, "monto_total": número (total a pagar),',
  ' "direccion_suministro": texto, "titular_nombre": texto, "titular_dni_cuit": solo dígitos, "categoria": "Servicios"|"Alquiler"|"Impuestos"|"Seguros"|"Suscripciones"|"Supermercado"|"Salud"|"Transporte"|"Otros",',
  ' "observaciones": cualquier otro dato útil}',
  'En Argentina los montos usan punto para miles y coma para decimales: "$ 150.000,00" es 150000.'
].join('\n');

/** Tipo real del archivo mirando sus primeros bytes (sirve cuando el celular no lo informa). */
function tipoPorContenido_(bytes, tipo, nombre) {
  if (TIPOS_ARCHIVO.indexOf(tipo) >= 0) return tipo;
  const b = function (i) { return (bytes[i] + 256) % 256; };
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';   // %PDF
  if (b(0) === 0xFF && b(1) === 0xD8) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46) return 'image/webp';          // RIFF…WEBP
  if (/\.pdf$/i.test(nombre)) return 'application/pdf';
  return tipo;
}

/** Usa Claude o Gemini (según el modelo elegido en la app) para leer el comprobante. */
function leerComprobante_(base64, tipo, modelo) {
  // Primero la IA elegida en la app; si falla (cuota, sobrecarga, respuesta cortada), la otra.
  const claude = { nombre: 'Claude', leer: leerConClaude_, hay: !!prop_('ANTHROPIC_API_KEY', false) };
  const gemini = { nombre: 'Gemini', leer: leerConGemini_, hay: !!prop_('GEMINI_API_KEY', false) };
  const orden = (/^claude-/.test(modelo || '') ? [claude, gemini] : [gemini, claude]).filter(function (x) { return x.hay; });
  if (!orden.length) throw new Error('no hay ninguna key de IA configurada');
  const fallas = [];
  for (let i = 0; i < orden.length; i++) {
    paso_('Leyendo el archivo con ' + orden[i].nombre + '…');
    try {
      const texto = orden[i].leer(base64, tipo);
      const m = String(texto || '').match(/\{[\s\S]*\}/);
      if (!m) throw new Error('no devolvió datos (respuesta: "' + String(texto || '').slice(0, 120) + '")');
      let datos;
      try { datos = JSON.parse(m[0]); }
      catch (e) { throw new Error('la respuesta vino incompleta o mal formada (' + e.message + ')'); }
      if (fallas.length) datos._leido_con = orden[i].nombre + ' (' + fallas.join('; ') + ')';
      return datos;
    } catch (e) {
      fallas.push(orden[i].nombre + ': ' + e.message);
      Logger.log('Lectura de archivo con ' + orden[i].nombre + ' falló: ' + e.message);
      if (orden[i + 1]) aviso_(orden[i].nombre + ' no pudo leer el archivo (' + motivoCorto_(e.message) + '): lo leo con ' + orden[i + 1].nombre);
    }
  }
  throw new Error(fallas.join(' | '));
}

/** Motivo de un error en pocas palabras, para mostrarlo en la app. */
function motivoCorto_(msg) {
  const m = String(msg || '');
  if (/\b429\b|quota|exhausted|cuota/i.test(m)) return 'sin cuota por ahora';
  if (/\b(500|502|503|504|529)\b|overload|unavailable|ocupad/i.test(m)) return 'ocupado';
  if (/incompleta|mal formada|no devolvió/i.test(m)) return 'respuesta incompleta';
  return m.slice(0, 60);
}

/** UrlFetch con reintentos ante límite de uso (429) o sobrecarga (5xx, 529): 3 intentos, esperando 2 y 4 segundos. */
function fetchConReintentos_(url, opts) {
  let res;
  for (let intento = 0; intento < 3; intento++) {
    res = UrlFetchApp.fetch(url, opts);
    const code = res.getResponseCode();
    if (code !== 429 && code !== 529 && code < 500) return res;
    if (intento < 2) {
      const quien = /anthropic/.test(url) ? 'Claude' : /generativelanguage/.test(url) ? 'Gemini' : 'El servicio';
      paso_(quien + (code === 429 ? ' sin cuota por un momento' : ' ocupado') + ': reintento en ' + Math.pow(2, intento + 1) + ' s…');
      Utilities.sleep(Math.pow(2, intento + 1) * 1000);
    }
  }
  return res;
}

function leerConClaude_(base64, tipo) {
  const bloque = tipo === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: tipo, data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: tipo, data: base64 } };
  const res = fetchConReintentos_(ANTHROPIC_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': prop_('ANTHROPIC_API_KEY', true), 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify({ model: MODELO_DEFAULT, max_tokens: 4096, messages: [{ role: 'user', content: [bloque, { type: 'text', text: PROMPT_COMPROBANTE }] }] })
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Claude ' + res.getResponseCode() + ': ' + ((data.error && data.error.message) || ''));
  return (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
}

function leerConGemini_(base64, tipo) {
  const res = fetchConReintentos_(GEMINI_API + MODELO_APP_DEFAULT + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY', true) },
    payload: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: tipo, data: base64 } }, { text: PROMPT_COMPROBANTE }] }],
      // Espacio de sobra: el modelo puede "pensar" antes de responder y eso también cuenta.
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 }
    })
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + ((data.error && data.error.message) || ''));
  const cand = (data.candidates || [])[0] || {};
  if (!cand.content) {
    const motivo = (data.promptFeedback && data.promptFeedback.blockReason) || cand.finishReason || 'sin respuesta';
    throw new Error('Gemini no devolvió contenido (' + motivo + ')');
  }
  if (cand.finishReason === 'MAX_TOKENS') Logger.log('Aviso: la lectura del archivo llegó al límite de largo');
  const parts = (cand.content.parts || []);
  return parts.filter(function (p) { return p.text && !p.thought; }).map(function (p) { return p.text; }).join('');
}

// ---------------------------------------------------------------------------
// Google Drive: carpetas y archivado
// ---------------------------------------------------------------------------

/** Reglas "archivos" de todos los sistemas. */
function reglasArchivos_() {
  const out = [];
  SISTEMAS.forEach(function (s) { (s.archivos || []).forEach(function (r) { out.push(r); }); });
  return out;
}

/** Carpeta única de pendientes (Config.gs). */
function carpetaPendientes_() {
  return DriveApp.getFolderById(CARPETA_PENDIENTES_ID);
}

function subcarpeta_(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

/**
 * Carpeta del año: si el evento es de otro año que la carpeta raíz ("Eventos Files 2026"), usa o crea
 * la carpeta hermana con ese año ("Eventos Files 2027") en la misma carpeta madre.
 */
function carpetaDelAnio_(raiz, anio) {
  const nombre = raiz.getName();
  const m = nombre.match(/(19|20)\d{2}/);
  if (!anio || !m || m[0] === anio) return raiz;
  const padres = raiz.getParents();
  if (!padres.hasNext()) return raiz;
  return subcarpeta_(padres.next(), nombre.replace(m[0], anio));
}

/** Valor de una propiedad ya convertida al formato de Notion, como texto para nombres de archivo. */
function textoDePropNotion_(n) {
  if (!n) return '';
  if (n.date) return String(n.date.start || '').slice(0, 10);
  if (n.select) return n.select.name;
  if (n.status) return n.status.name;
  if (typeof n.number === 'number') return String(n.number);
  if (n.title) return n.title.map(function (t) { return t.text.content; }).join('');
  if (n.rich_text) return n.rich_text.map(function (t) { return t.text.content; }).join('');
  return '';
}

/**
 * Después de guardar un registro: mueve y renombra los archivos "drive:<id>" según las reglas.
 * Ejemplo (eventos): Comprobante de un pago → "Eventos Files 2026/2026-12-19 Fiesta Egresado/2026-11-14 Cuota 100000.jpg".
 * @return {Array<string>} rutas finales (para informar)
 */
function archivarAdjuntos_(esq, crudo, notion) {
  const hechos = [];
  reglasArchivos_().forEach(function (r) {
    const coincide = (r.data_source_id && normId_(r.data_source_id) === normId_(esq.data_source_id)) || normTexto_(r.base) === normTexto_(esq.titulo);
    if (!coincide) return;
    const m = String(crudo[r.columna] || '').match(/^drive:([\w-]+)$/);
    if (!m) return;
    const archivo = DriveApp.getFileById(m[1]);
    const ext0 = (archivo.getName().match(/\.[a-z0-9]{2,4}$/i) || [''])[0];

    // Modo plantilla: ruta de carpetas y nombre armados con columnas y relaciones (ver plantilla_).
    if (r.ruta) {
      const cache = {};
      let dest = DriveApp.getFolderById(r.carpeta_raiz);
      r.ruta.forEach(function (seg) { const nom = limpiarNombre_(plantilla_(seg, notion, cache)); if (nom) dest = subcarpeta_(dest, nom); });
      let baseNom = limpiarNombre_(plantilla_(r.nombre || '', notion, cache)) || archivo.getName().replace(/\.[^.]+$/, '');
      let nom = baseNom + ext0, k = 2;
      while (dest.getFilesByName(nom).hasNext()) nom = baseNom + ' (' + (k++) + ')' + ext0;
      archivo.setName(nom);
      archivo.moveTo(dest);
      hechos.push(r.ruta.map(function (seg) { return limpiarNombre_(plantilla_(seg, notion, cache)); }).filter(String).join('/') + '/' + nom);
      return;
    }

    // Carpeta destino: la del registro relacionado (por ejemplo el evento), con fecha y nombre.
    let destino = DriveApp.getFolderById(r.carpeta_raiz);
    if (r.relacion && notion[r.relacion] && notion[r.relacion].relation && notion[r.relacion].relation.length) {
      const pg = notion_('get', '/pages/' + notion[r.relacion].relation[0].id);
      const props = pg.properties || {};
      const tit = Object.keys(props).map(function (k) { return props[k]; }).find(function (x) { return x.type === 'title'; });
      const nombreRel = tit ? textoPlano_(tit.title) : 'Sin nombre';
      const fp = r.fecha_relacion && props[r.fecha_relacion] && props[r.fecha_relacion].date;
      const fecha = fp && fp.start ? fp.start.slice(0, 10) : '';
      destino = subcarpeta_(carpetaDelAnio_(destino, fecha.slice(0, 4)), ((fecha ? fecha + ' ' : 'Sin fecha ') + nombreRel).replace(/[\\/]/g, '-').trim());
    }

    // Nombre del archivo: columnas indicadas (por ejemplo "2026-11-14 Cuota 100000") + extensión original.
    const ext = (archivo.getName().match(/\.[a-z0-9]{2,4}$/i) || [''])[0];
    let base = (r.nombre_archivo || []).map(function (c) { return textoDePropNotion_(notion[c]); }).filter(String).join(' ').replace(/[\\/:*?"<>|]/g, '-').trim();
    if (!base) base = archivo.getName().replace(/\.[^.]+$/, '');
    let nombre = base + ext, i = 2;
    while (destino.getFilesByName(nombre).hasNext()) nombre = base + ' (' + (i++) + ')' + ext;
    archivo.setName(nombre);
    archivo.moveTo(destino);
    hechos.push(destino.getName() + '/' + nombre);
  });
  return hechos;
}

const MESES_ = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function limpiarNombre_(t) { return String(t || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim(); }

/**
 * Plantillas para carpetas y nombres de archivo:
 *   {Columna}                 valor de la columna del registro (fechas como AAAA-MM-DD)
 *   {Columna>}                título del registro vinculado en esa relación (ej. {Domicilio>})
 *   {Columna:año} {Columna:mes} {Columna:mesNombre}   partes de una fecha ("2026", "10", "Octubre")
 *   {A/B:año}                 la primera columna con dato (ej. {Fecha emisión/Vencimiento:año})
 *   {...|Texto}               valor si está vacío (ej. {Domicilio>|Sin asignar})
 */
function plantilla_(tpl, notion, cache) {
  return String(tpl).replace(/\{([^}]+)\}/g, function (m, expr) {
    let def = '';
    const pi = expr.indexOf('|');
    if (pi >= 0) { def = expr.slice(pi + 1); expr = expr.slice(0, pi); }
    let parte = '';
    const ci = expr.lastIndexOf(':');
    if (ci >= 0) { parte = expr.slice(ci + 1); expr = expr.slice(0, ci); }
    const rel = /\>$/.test(expr);
    if (rel) expr = expr.slice(0, -1);
    const cols = expr.split('/').map(function (x) { return x.trim(); });
    let val = '';
    for (let i = 0; i < cols.length && !val; i++) {
      const n = notion[cols[i]];
      if (!n) continue;
      if (rel) {
        const id = n.relation && n.relation[0] && n.relation[0].id;
        if (id) {
          if (!(id in cache)) {
            const pg = notion_('get', '/pages/' + id);
            const t = Object.keys(pg.properties || {}).map(function (k) { return pg.properties[k]; }).find(function (x) { return x.type === 'title'; });
            cache[id] = t ? textoPlano_(t.title) : '';
          }
          val = cache[id];
        }
      } else {
        val = textoDePropNotion_(n);
      }
    }
    if (val && parte) {
      const f = String(val).match(/^(\d{4})-(\d{2})/);
      val = !f ? '' : parte === 'año' ? f[1] : parte === 'mes' ? f[2] : parte === 'mesNombre' ? MESES_[+f[2] - 1] : val;
    }
    return val || def;
  });
}

/** Como plantilla_, pero devuelve null si algún dato (sin valor por defecto) quedó vacío. */
function plantillaCompleta_(tpl, notion, cache) {
  let completa = true;
  String(tpl).replace(/\{([^}]+)\}/g, function (m) {
    if (m.indexOf('|') < 0 && !plantilla_(m, notion, cache)) completa = false;
    return m;
  });
  return completa ? plantilla_(tpl, notion, cache).replace(/\s+/g, ' ').trim() : null;
}

/**
 * Búsquedas automáticas apenas se lee un archivo (regla "al_leer_archivo" de cada Sistema_*.gs).
 * Ejemplo (Gestor de Pagos): con el nro. de cliente de una factura busca el Servicio que lo tiene
 * (comparando solo dígitos y sin ceros a la izquierda) y le pasa al agente sus datos.
 * @return {Array<string>} textos para el agente
 */
function buscarAlLeer_(datos) {
  const out = [];
  const digitos = function (t) { return String(t || '').replace(/\D/g, '').replace(/^0+/, ''); };
  SISTEMAS.forEach(function (sis) {
    (sis.al_leer_archivo || []).forEach(function (r) {
      const valor = datos[r.dato];
      if (!valor) return;
      const esq = verEsquema_(r.data_source_id || r.base);
      paso_('Buscando por ' + (r.etiqueta || r.dato) + ' en ' + esq.titulo + '…');
      const objetivo = r.comparar === 'digitos' ? digitos(valor) : normTexto_(valor);
      if (!objetivo) return;
      // Trae los registros que tienen la columna cargada (hasta 300) y compara acá, normalizando.
      const encontrados = [];
      let cursor, vueltas = 0;
      do {
        const body = { page_size: 100, filter: { property: r.columna, rich_text: { is_not_empty: true } } };
        if (cursor) body.start_cursor = cursor;
        const res = notion_('post', '/data_sources/' + esq.data_source_id + '/query', body);
        (res.results || []).forEach(function (pg) {
          if (pg.in_trash || pg.archived) return;
          const v = textoPlano_((pg.properties[r.columna] || {}).rich_text);
          if ((r.comparar === 'digitos' ? digitos(v) : normTexto_(v)) === objetivo) encontrados.push(pg);
        });
        cursor = res.has_more ? res.next_cursor : null;
      } while (cursor && ++vueltas < 3);

      const etiqueta = r.etiqueta || (r.dato + ' ' + valor);
      if (!encontrados.length) {
        out.push('Búsqueda automática por ' + etiqueta + ' en ' + esq.titulo + ': no hay ningún registro con ese valor. ' + (r.si_no_hay || ''));
        return;
      }
      const cache = {};
      const describir = function (pg) {
        const partes = [];
        (r.mostrar || []).forEach(function (col) {
          const p = pg.properties[col];
          if (!p) return;
          if (p.type === 'relation') {
            const nombres = (p.relation || []).slice(0, 3).map(function (x) {
              if (!(x.id in cache)) {
                const rp = notion_('get', '/pages/' + x.id);
                const t = Object.keys(rp.properties || {}).map(function (k) { return rp.properties[k]; }).find(function (y) { return y.type === 'title'; });
                cache[x.id] = t ? textoPlano_(t.title) : x.id;
              }
              return cache[x.id] + ' (id ' + x.id + ')';
            });
            if (nombres.length) partes.push(col + ': ' + nombres.join(', '));
          } else {
            const v = valorPropiedad_(p);
            if (v !== null && v !== '' && v !== undefined) partes.push(col + ': ' + (Array.isArray(v) ? v.join(', ') : v));
          }
        });
        return '"' + partes.shift() + '" (id ' + pg.id + ')' + (partes.length ? ' → ' + partes.join('; ') : '');
      };
      out.push('Búsqueda automática por ' + etiqueta + ' en ' + esq.titulo + ': ' +
        (encontrados.length === 1 ? 'coincide con ' + describir(encontrados[0]) + '. ' + (r.si_hay || '')
          : 'coinciden ' + encontrados.length + ': ' + encontrados.map(describir).join(' | ') + '. Preguntá cuál corresponde.'));
    });
  });
  return out;
}

/**
 * Diagnóstico desde el editor: lee el archivo más reciente de la carpeta de pendientes (lo último que se
 * subió desde la app) con Gemini y con Claude, y muestra la respuesta cruda y los datos que se obtienen.
 */
function probarLecturaUltimoArchivo() {
  let ultimo = null;
  const it = carpetaPendientes_().getFiles();
  while (it.hasNext()) { const f = it.next(); if (!ultimo || f.getDateCreated() > ultimo.getDateCreated()) ultimo = f; }
  if (!ultimo) { Logger.log('No hay archivos en la carpeta de pendientes.'); return; }
  const blob = ultimo.getBlob();
  const bytes = blob.getBytes();
  const tipo = tipoPorContenido_(bytes, String(blob.getContentType() || '').toLowerCase(), ultimo.getName());
  Logger.log('Archivo: ' + ultimo.getName() + ' (' + Math.round(bytes.length / 1024) + ' KB, tipo informado "' + blob.getContentType() + '", tipo usado "' + tipo + '")');
  const b64 = Utilities.base64Encode(bytes);
  [['Gemini', leerConGemini_], ['Claude', leerConClaude_]].forEach(function (x) {
    try {
      const t = x[1](b64, tipo);
      Logger.log(x[0] + ' respondió (' + String(t).length + ' caracteres): ' + String(t).slice(0, 1500));
      Logger.log(x[0] + ' datos: ' + JSON.stringify(leerComprobante_(b64, tipo, x[0] === 'Claude' ? 'claude-' : 'gemini')));
    } catch (e) { Logger.log(x[0] + ' ERROR: ' + e.message); }
  });
}
