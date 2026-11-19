/** Módulo de ejemplo: notas y recordatorios. Sirve para probar todo el circuito de punta a punta. */
import type { Modulo } from "../tipos.ts";

export const notas: Modulo = {
  id: "notas",
  nombre: "Notas",
  descripcion: "Notas, ideas, pendientes y recordatorios con fecha del dueño.",
  instrucciones: [
    "Si piden 'recordame X el viernes', creá una nota con fecha_recordatorio calculada a partir de la fecha actual que viene en el pedido.",
    "Etiquetas en minúsculas y sin tildes.",
    "Para 'qué tengo pendiente' buscá las notas con hecha = false, ordenadas por fecha_recordatorio.",
    "Marcar como hecha = proponer_cambio con hecha: true (no borrar).",
  ],
  tablas: [
    {
      nombre: "notas_notas",
      descripcion: "Una fila por nota o recordatorio.",
      columnas: [
        { nombre: "titulo", tipo: "texto", obligatoria: true, descripcion: "Resumen corto" },
        { nombre: "contenido", tipo: "texto", descripcion: "Detalle libre" },
        { nombre: "etiquetas", tipo: "lista de textos", descripcion: 'Ej.: ["casa", "trabajo"]' },
        { nombre: "fecha_recordatorio", tipo: "fecha (AAAA-MM-DD)", descripcion: "Cuándo recordarla" },
        { nombre: "hecha", tipo: "sí/no", descripcion: "true cuando ya se resolvió" },
      ],
    },
  ],
};
