/**
 * SISTEMA: Gestor de Pagos (cuentas a pagar de varios domicilios).
 * Página de Notion: "💸 Gestor de Pagos". Guía completa: "🧠 Guía para agentes de IA" (en esa página).
 * Bases: Domicilios, Servicios, Personas, Proveedores, Facturas, Pagos.
 *
 * Convive con el bot de Telegram, que escribe en las mismas bases: por eso se respetan sus reglas
 * (Origen = Agente, Revisar + Notas IA, no duplicar, no tocar Telegram chat ID ni links de Archivo).
 */

var SISTEMAS = SISTEMAS || [];
SISTEMAS.push({
  nombre: 'Gestor de Pagos (cuentas a pagar de domicilios)',

  bases: {
    'Domicilios': {
      data_source_id: '61eeafcb-72af-4c5f-8320-8fabc6a8d78e',
      obligatorios: ['Nombre'],
      recomendados: ['Dirección', 'Localidad', 'Alias', 'Titulares', 'Responsables', 'Activo'],
      buscar_por: ['Nombre', 'Alias', 'Dirección'],
      no_modificar: ['Nombre']                 // es el nombre de la carpeta en Drive
    },
    'Servicios': {
      data_source_id: '5878d386-6e51-4c0d-a19e-94d23c73787e',
      obligatorios: ['Servicio', 'Domicilio', 'Proveedor'],
      recomendados: ['Nro. de cliente', 'Titular', 'Responsable', 'Categoría', 'Medio de pago habitual', 'Activo'],
      buscar_por: ['Servicio', 'Nro. de cliente'],
      duplicados: [['Nro. de cliente'], ['Domicilio', 'Proveedor']]
    },
    'Personas': {
      data_source_id: 'fa49fa10-6b70-4788-939b-f028fbaeb93e',
      obligatorios: ['Nombre'],
      recomendados: ['DNI / CUIT', 'Teléfono', 'Email'],
      buscar_por: ['Nombre', 'DNI / CUIT'],
      duplicados: [['DNI / CUIT']],
      no_editar: ['Telegram chat ID']          // da acceso al bot: solo un humano autorizado, en Notion
    },
    'Proveedores': {
      data_source_id: '1b4446c1-579e-4587-b3ef-9fde9ec33998',
      obligatorios: ['Nombre'],
      recomendados: ['CUIT / ID fiscal', 'Categoría', 'Recurrente', 'Medio de pago habitual'],
      buscar_por: ['Nombre', 'CUIT / ID fiscal'],
      duplicados: [['CUIT / ID fiscal']]
    },
    'Facturas': {
      data_source_id: '5ef38a9c-15bd-4af2-bca7-491b3049eec5',
      obligatorios: ['Concepto', 'Proveedor', 'Monto', 'Moneda'],
      recomendados: ['Domicilio', 'Servicio', 'Titular', 'Responsable', 'Nro. factura', 'Fecha emisión', 'Vencimiento', 'Período', 'Categoría', 'Archivo'],
      fijos: { 'Origen': 'Agente' },
      duplicados: [['Nro. factura', 'Proveedor']],
      no_modificar: ['Archivo']
    },
    'Pagos': {
      data_source_id: 'aec2f26f-99c8-4251-9563-03899745bf59',
      obligatorios: ['Descripción', 'Monto pagado', 'Fecha de pago', 'Moneda', 'Medio de pago'],
      recomendados: ['Factura', 'Proveedor', 'Domicilio', 'Pagado por', 'Nro. operación', 'Archivo'],
      fijos: { 'Origen': 'Agente' },
      duplicados: [['Nro. operación'], ['Factura', 'Monto pagado', 'Fecha de pago']],
      no_modificar: ['Archivo']
    }
  },

  // Archivos en Drive con la misma estructura que el bot:
  //   Archivos / <Domicilio> / <Año> / <Proveedor> / <MM - Mes> / "AAAA-MM-DD Factura|Pago <Proveedor> <Detalle>"
  // Año y mes salen de la fecha del documento (emisión para facturas, fecha de pago para pagos).
  archivos: [{
    base: 'Facturas',
    data_source_id: '5ef38a9c-15bd-4af2-bca7-491b3049eec5',
    columna: 'Archivo',
    carpeta_raiz: 'COMPLETAR_ID_CARPETA_ARCHIVOS',   // carpeta "Archivos" del Gestor de Pagos
    ruta: ['{Domicilio>|Sin asignar}', '{Fecha emisión/Vencimiento:año|Sin fecha}', '{Proveedor>|Sin proveedor}', '{Fecha emisión/Vencimiento:mes} - {Fecha emisión/Vencimiento:mesNombre}'],
    nombre: '{Fecha emisión/Vencimiento} Factura {Proveedor>} {Concepto}'
  }, {
    base: 'Pagos',
    data_source_id: 'aec2f26f-99c8-4251-9563-03899745bf59',
    columna: 'Archivo',
    carpeta_raiz: 'COMPLETAR_ID_CARPETA_ARCHIVOS',
    ruta: ['{Domicilio>|Sin asignar}', '{Fecha de pago:año|Sin fecha}', '{Proveedor>|Sin proveedor}', '{Fecha de pago:mes} - {Fecha de pago:mesNombre}'],
    nombre: '{Fecha de pago} Pago {Proveedor>} {Descripción}'
  }],

  notas: [
    'Qué es: administra las cuentas a pagar de varios domicilios (servicios, impuestos, alquileres, seguros, suscripciones). Un Domicilio tiene Servicios (la cuenta de un Proveedor en ese domicilio, con su Nro. de cliente, Titular y Responsable). Una Factura es lo que hay que pagar; un Pago cancela total o parcialmente una Factura. El bot de Telegram y otras personas también escriben acá: antes de crear, buscá si ya existe.',
    'A este sistema corresponden las FACTURAS a pagar y los comprobantes de pagos que se HACEN a empresas o proveedores (luz, gas, agua, internet, impuestos, alquiler, seguros…): el destinatario es un proveedor. Si el comprobante es de un cliente que le paga al salón, es del sistema de Eventos.',
    'Consultas:',
    '- Pendiente = Facturas con Estado distinto de "✅ Pagada": {"property":"Estado","formula":{"string":{"does_not_equal":"✅ Pagada"}}}. Vencidas: Estado "🔴 Vencida". Que vencen pronto: Vencimiento entre hoy y hoy+7. Por domicilio o persona: relation contains el id (buscá antes el Domicilio o la Persona por nombre o alias).',
    '- Saldo de una factura = Monto − Pagado (columnas Saldo, Pagado, Estado y Días para vencer son calculadas). Gasto de un mes: suma de Monto de Facturas con Mes = AAAA-MM. Lo pagado: suma de Monto pagado de Pagos con ese Mes.',
    '- Nunca sumes monedas distintas: separá los totales por moneda (ARS, USD, EUR).',
    'Al cargar (Origen = Agente se pone solo):',
    '- Facturas: Concepto "Servicio Proveedor período" (ej. "Luz Edenor octubre 2026"). Asigná domicilio, titular y responsable con esta prioridad: 1) por Nro. de cliente: si coincide con un Servicio (comparando solo dígitos y sin ceros a la izquierda), el servicio define Domicilio, Servicio, Titular y Responsable; 2) por domicilio (dirección de suministro, nombre, alias o lo que diga el usuario): si ese domicilio tiene un único servicio de ese proveedor, usalo; 3) si se conoce el domicilio pero no existe el servicio, proponé crearlo primero (Domicilio, Proveedor, Nro. de cliente, Titular de la factura, Responsable = el primero del domicilio); 4) Titular: el del servicio, si no la persona de la factura (buscala por nombre o DNI), si no el primer titular del domicilio; 5) Responsable: el del servicio, si no el primer responsable del domicilio; 6) si no se puede identificar el domicilio, cargala sin domicilio con Revisar = sí y explicá en Notas IA qué faltó.',
    '- Proveedor: buscalo por CUIT o por nombre normalizado (sin mayúsculas, acentos ni "S.A.", "S.R.L.", "S.A.S.", aceptando que uno contenga al otro: "EDENOR S.A." = "Edenor"). Si no existe, proponé crearlo con Nombre, CUIT y Categoría. No dupliques.',
    '- Personas: buscalas por DNI/CUIT o por nombre (todas las palabras del nombre más corto aparecen en el más largo: "PEREZ JUAN CARLOS" = "Juan Pérez"). Nunca cargues el Telegram chat ID.',
    '- Pagos: vinculá la Factura así: 1) si el comprobante o el usuario menciona la factura (número, período), esa; 2) si no, buscá facturas pendientes del mismo proveedor (y domicilio si se conoce) cuyo Saldo coincida con el monto: vinculá solo si hay exactamente una; 3) un pago menor al saldo es un pago parcial y se vincula igual; 4) si hay varias candidatas, preguntá cuál; si no hay ninguna clara, cargalo sin factura con Revisar = sí y explicalo en Notas IA (no adivines). Domicilio y Proveedor: los de la factura. Pagado por: si el usuario no lo dice, proponé el Responsable de la factura. El número de operación va en "Nro. operación" (no en Notas). Medio de pago: Transferencia, Débito automático, Tarjeta de crédito, Tarjeta de débito, Efectivo o Billetera virtual (Mercado Pago, Cuenta DNI, Ualá, Naranja X, etc. son "Billetera virtual"; una transferencia desde un banco es "Transferencia"). Moneda ARS si no dice otra.',
    '- Después de guardar un pago con factura, consultá de nuevo la factura y decí su nuevo Estado y Saldo.',
    '- Revisar = sí cuando falta un dato clave, algo se infirió o era ilegible, un pago no se pudo vincular, o se creó un servicio o persona nuevos que conviene confirmar; explicá el motivo en "Notas IA".',
    '- Valores válidos: Categoría: Servicios, Alquiler, Impuestos, Seguros, Suscripciones, Supermercado, Salud, Transporte, Otros. Moneda: ARS, USD, EUR. Fechas AAAA-MM-DD sin hora. Montos como número ("$ 1.234,56" → 1234.56).',
    '- Archivo (factura o comprobante adjunto): usá el valor "drive:<id>" que vino con el archivo; al guardar queda el link y el archivo se ordena solo en Drive (Archivos / Domicilio / Año / Proveedor / MM - Mes). No modifiques links de Archivo existentes.',
    '- No se puede: escribir en campos calculados (Pagado, Saldo, Estado, Días para vencer, Mes, rollups, ID), marcar una factura como pagada editándola (se paga creando un Pago vinculado), renombrar domicilios, cambiar la estructura de las bases ni borrar registros. El agente no paga nada: solo registra pagos ya hechos.'
  ]
});

// ---------------------------------------------------------------------------
// Pruebas de este sistema (ejecutalas desde el editor; no escriben nada)
// ---------------------------------------------------------------------------

/** Consultas: qué hay que pagar y qué venció. */
function probarGestor_Consulta() {
  conversacionDePrueba_([
    '¿Qué facturas hay pendientes de pago?',
    '¿Y cuáles ya vencieron?'
  ]);
}

/** Carga de un pago sin confirmar: muestra cómo busca la factura y qué resumen arma. */
function probarGestor_Pago() {
  conversacionDePrueba_([
    'Pagué la última factura de luz pendiente por transferencia hoy, cargame el pago.'
  ]);
}
