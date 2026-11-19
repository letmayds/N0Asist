/**
 * PLANTILLA de módulo (no está registrada). Copiala como <id>.ts, completala y agregala en registro.ts.
 * Ejemplo hipotético: un módulo "pagos" conectado a "notas".
 */
import { db } from "../db.ts";
import type { Modulo } from "../tipos.ts";

export const plantilla: Modulo = {
  id: "pagos", // minúsculas; es el prefijo de sus tablas
  nombre: "Pagos",
  descripcion: "Facturas y pagos de servicios de los domicilios.", // el agente general decide con esto
  instrucciones: [
    "Reglas del negocio que el agente del módulo tiene que respetar.",
  ],
  tablas: [
    {
      nombre: "pagos_facturas",
      descripcion: "Una fila por factura recibida.",
      columnas: [
        { nombre: "proveedor", tipo: "texto", obligatoria: true },
        { nombre: "monto", tipo: "número", obligatoria: true },
        { nombre: "vencimiento", tipo: "fecha (AAAA-MM-DD)" },
        { nombre: "pagada", tipo: "sí/no" },
      ],
    },
  ],

  // Conector síncrono: este módulo puede pedirle cosas al módulo "notas" (herramienta consultar_modulo)
  conectores: ["notas"],

  // Herramientas propias (opcional)
  herramientas: [
    {
      definicion: {
        name: "total_impago",
        description: "Suma el monto de las facturas no pagadas.",
        input_schema: { type: "object", properties: {} },
      },
      ejecutar: async () => {
        const { data, error } = await db.from("pagos_facturas").select("monto").eq("pagada", false);
        if (error) throw new Error(error.message);
        return String((data ?? []).reduce((s, f) => s + Number(f.monto), 0));
      },
    },
  ],

  // Conector asíncrono: reacciona a eventos (operaciones ya aplicadas), sin IA y sin confirmación
  reacciones: {
    "pagos.pagos_facturas.alta": async (evento) => {
      const f = evento.datos ?? {};
      if (!f.vencimiento) return;
      await db.from("notas_notas").insert({
        titulo: `Pagar ${f.proveedor} (${f.monto})`,
        fecha_recordatorio: f.vencimiento,
        etiquetas: ["pagos"],
      });
    },
  },
};
