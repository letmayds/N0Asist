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
      buscar_por: ['Alias', 'Nombre']
    },
    'Pagos': {
      data_source_id: 'c1b3efe6-9c39-40ee-9d2c-b5c7dc842ff9',
      obligatorios: ['Concepto', 'Evento', 'Monto', 'Fecha de pago', 'Medio', 'Tipo'],
      recomendados: ['Estado']
    },
    'Tarifas': {
      data_source_id: '4182f187-0701-81c9-8974-000bbcc4c923',
      obligatorios: ['Tarifa', 'Vigencia', 'Alquiler', 'Limpieza', 'Seña'],
      recomendados: ['Seguro', 'Horas', 'Estado']
    }
  },

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
