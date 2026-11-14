/**
 * SISTEMA: Gestión de Eventos CCVR (alquiler del salón).
 * Página de Notion: "🎉 Gestión de Eventos CCVR". Bases: Eventos, Contactos, Pagos, Tarifas.
 *
 * Todo lo específico de este sistema está acá. Para agregar otro sistema, copiá este archivo como
 * Sistema_<Nombre>.gs y cambiá los datos: el agente lo toma solo (no hay que tocar otros archivos).
 *
 * Por cada base (la clave es el título de la base en Notion):
 *   data_source_id  (opcional) para distinguirla si otro sistema tiene una base con el mismo nombre.
 *   obligatorios    sin estos no deja guardar; el agente los pregunta.
 *   recomendados    los menciona antes de guardar, pero no bloquean.
 *   fechas_futuras  columnas de fecha que deberían ser futuras (avisa si quedan en el pasado).
 *   buscar_por      columnas (título o texto) donde buscar al vincular por nombre. Por defecto, el título.
 * notas: lo que el agente tiene que saber de este sistema (qué significa cada columna, valores por defecto…).
 */

var SISTEMAS = SISTEMAS || [];
SISTEMAS.push({
  nombre: 'Gestión de Eventos CCVR (alquiler del salón)',

  bases: {
    'Eventos': {
      data_source_id: '34e4823b-722c-42af-b481-864061559931',
      obligatorios: ['Evento', 'Cliente', 'Fecha y horario', 'Turno', 'Tipo de evento', 'Modalidad'],
      recomendados: ['Estado', 'Invitados', 'Tarifa aplicada', 'Fecha de seña'],
      fechas_futuras: ['Fecha y horario']
    },
    'Contactos': {
      data_source_id: 'c229eba7-2de4-44c1-a5c1-f33881c412c5',
      obligatorios: ['Alias', 'Tipo'],
      recomendados: ['Nombre', 'Teléfono', 'Origen', 'Email', 'DNI / CUIT'],
      buscar_por: ['Alias', 'Nombre', 'DNI / CUIT']
    },
    'Pagos': {
      data_source_id: 'c1b3efe6-9c39-40ee-9d2c-b5c7dc842ff9',
      obligatorios: ['Concepto', 'Evento', 'Monto', 'Fecha de pago', 'Medio', 'Tipo'],
      recomendados: ['Estado', 'Comprobante', 'Notas'],
      duplicados: ['Fecha de pago', 'Monto'] // avisa si ya hay un pago con la misma fecha y monto
    },
    'Tarifas': {
      data_source_id: '4182f187-0701-81c9-8974-000bbcc4c923',
      obligatorios: ['Tarifa', 'Vigencia', 'Alquiler', 'Limpieza', 'Seña'],
      recomendados: ['Seguro', 'Horas', 'Estado']
    }
  },

  // Comprobantes en Google Drive: al guardar un pago con comprobante, el archivo se mueve a
  // "<carpeta del año>/<fecha del evento> <nombre del evento>/" y se renombra "<fecha> <tipo> <monto>".
  // Si el evento es de otro año, se usa (o crea) la carpeta hermana con ese año ("Eventos Files 2027").
  // Mientras no se confirma, el archivo queda en "_Pendientes" dentro de la carpeta raíz.
  archivos: [{
    base: 'Pagos',
    data_source_id: 'c1b3efe6-9c39-40ee-9d2c-b5c7dc842ff9',
    columna: 'Comprobante',                            // columna de tipo link donde va la URL del archivo
    carpeta_raiz: '1c4S-eVlF84nM9bB_d9gapW2aTB2nmTXL', // "Eventos Files 2026"
    relacion: 'Evento',                                // una carpeta por evento…
    fecha_relacion: 'Fecha y horario',                 // …con su fecha adelante
    nombre_archivo: ['Fecha de pago', 'Tipo', 'Monto']
  }],

  notas: [
    'Base Contactos: "Nombre" es el nombre real y "Alias" (título) un apodo para identificarlo. Si preguntan por una persona, buscala por Nombre o por Alias (filtro "or" con title contains y rich_text contains).',
    'Base Eventos:',
    '- "Saldo": lo que le falta pagar al cliente para completar el pago total del evento. Si preguntan cuánto falta pagar, cuánto deben o quién debe, es esta columna (Saldo mayor a 0).',
    '- "Falta para congelar": lo que le falta pagar para congelar el precio (que no se actualice por IPC). No es la deuda total.',
    '- Cuando hables de lo que falta pagar de un evento, decí el Saldo y, si "Falta para congelar" es mayor a 0, aclará también cuánto le falta para congelar el precio.',
    '- Las fechas límite son "Límite seña" y "Límite pago total"; mencionalas si sirven (por ejemplo, si están cerca o vencidas).',
    '- Si una fecha límite ya pasó (es anterior a hoy), decí que está vencida, no que "vence".',
    'Al cargar datos en este sistema:',
    '- Evento nuevo: el nombre del evento suele ser "<tipo> <nombre del cliente>" si el usuario no da otro. Estado "Consulta" si no dice nada; si ya señó, "Reservado (señado)", y entonces conviene vincular la tarifa vigente (base Tarifas, Estado "Vigente"), cargar la Fecha de seña y registrar el pago en Pagos.',
    '- Pago nuevo: Concepto "<Tipo> <Evento>" si no dice otro (por ejemplo "Seña Fiesta Egresado"); Estado "Acreditado" salvo que diga que está pendiente; si dice "hoy", la fecha de hoy.',
    'Comprobantes de pago (cuando el usuario adjunta un comprobante y en este sistema corresponde a un evento):',
    '- 1. Buscá a quien pagó (ordenante_nombre / ordenante_cuit_dni) en Contactos: consultar_base con filtro "or" sobre Nombre y Alias (rich_text/title contains, probá también solo el apellido) y sobre "DNI / CUIT" si hay número. Si hay varios o ninguno, decilo.',
    '- 2. Buscá sus eventos: en Eventos, filtro por la relación Cliente (relation contains el id del contacto), excluyendo Estado "Cancelado" y "Realizado"; traé Evento, Fecha y horario, Saldo, Falta para congelar, Total pagado y Estado.',
    '- 3. Proponé de qué es el pago: el evento (si tiene uno solo con Saldo > 0, ese) y el Tipo: "Seña" si Total pagado es 0; "Congelamiento de precio" si con este monto llega a congelar (monto >= Falta para congelar > 0); "Saldo final" si el monto cubre el Saldo; si no, "Cuota". Medio "Transferencia" (o "Mercado Pago" si el comprobante es de Mercado Pago). Fecha de pago la del comprobante. En Notas poné, si los hay, el número de operación y desde dónde se hizo (campo origen del comprobante, o el banco), con este formato: "Op. N° 987654 · Desde Cuenta DNI" (si falta uno, poné solo el otro).',
    '- Posible pago repetido: antes de proponer, buscá en Pagos si ya hay uno con el mismo número de operación (Notas contains el número). guardar_registro además avisa (posibles_duplicados) si hay otro con la misma Fecha de pago y Monto: decíselo al usuario con concepto, fecha y monto, y preguntale si ya está cargado o si son dos pagos distintos (puede pasar el mismo día). Si es el mismo, no cargues nada.',
    '- 4. Preguntale al usuario si es eso (por ejemplo: "Es una transferencia de Carla Sforza por cien mil pesos del 14 de noviembre. ¿Es una cuota de Fiesta Egresado?") y esperá su respuesta. Recién con su confirmación armá el resumen con guardar_registro (sin token), incluyendo el archivo en "Comprobante".',
    '- Si quien pagó no está en Contactos, o no tiene eventos, preguntá a qué corresponde el pago (puede ser de otra persona o de otra cosa).',
    '- Contacto nuevo: Tipo "Cliente" si viene por un evento. Si el usuario no da un alias, proponé uno (el nombre, o el nombre más algo que lo identifique, como de dónde viene o de quién es pariente, por ejemplo "Carla Hermana Fabio") y confirmalo en el resumen.'
  ]
});

// ---------------------------------------------------------------------------
// Pruebas de este sistema (ejecutalas desde el editor)
// ---------------------------------------------------------------------------

/** Consulta con seguimiento: pagos pendientes de diciembre. No escribe nada. */
function probarEventos_Consulta() {
  conversacionDePrueba_([
    'De los eventos de diciembre, ¿a alguno le falta pagar algo? ¿Cuánto?',
    '¿Y cuánto suman entre todos?'
  ]);
}

/** Carga de un evento con cliente nuevo, SIN confirmar: muestra qué pregunta y qué resumen arma. No escribe nada. */
function probarEventos_Carga() {
  conversacionDePrueba_([
    'Quiero cargar un evento nuevo: un cumpleaños de 15 para el sábado 13 de marzo a la noche, la clienta es Laura Gómez.',
    'Su teléfono es 11 5555 1234, nos contactó por Instagram. Es solo salón, 80 invitados.'
  ]);
}
