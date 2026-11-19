/**
 * Confirmación de operaciones y bus de eventos (conectores asíncronos entre módulos).
 * Esto corre sin IA: el dueño toca "Confirmar" y se aplica exactamente lo que se propuso.
 */
import { aplicarOperacion } from "./crud.ts";
import { db } from "./db.ts";
import { MODULOS, moduloPorId } from "./modulos/registro.ts";
import type { Evento } from "./tipos.ts";

export async function listarPendientes() {
  const { data, error } = await db.from("operaciones")
    .select("id, conversacion_id, modulo, tabla, tipo, registro_id, datos, resumen, creado_en")
    .eq("estado", "pendiente").order("id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function cancelarOperacion(id: number) {
  const { data, error } = await db.from("operaciones")
    .update({ estado: "cancelada", resuelto_en: new Date().toISOString() })
    .eq("id", id).eq("estado", "pendiente").select("id").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`La operación #${id} no está pendiente`);
  return { id, estado: "cancelada" };
}

export async function confirmarOperacion(id: number) {
  // Tomar la operación de forma atómica: solo si sigue pendiente (evita doble aplicación por doble toque)
  const { data: op, error } = await db.from("operaciones")
    .update({ estado: "aplicada", resuelto_en: new Date().toISOString() })
    .eq("id", id).eq("estado", "pendiente")
    .select("id, modulo, tabla, tipo, registro_id, datos").maybeSingle();
  if (error) throw new Error(error.message);
  if (!op) throw new Error(`La operación #${id} no está pendiente`);

  const modulo = moduloPorId(op.modulo);
  try {
    if (!modulo) throw new Error(`El módulo ${op.modulo} ya no existe`);
    const fila = await aplicarOperacion(modulo, op);
    await db.from("operaciones").update({ resultado: fila }).eq("id", id);
    const reacciones = await publicarEvento({
      tipo: `${op.modulo}.${op.tabla}.${op.tipo}`,
      modulo: op.modulo,
      tabla: op.tabla,
      registro_id: (fila.id as string) ?? op.registro_id,
      datos: fila,
    });
    return { id, estado: "aplicada", resultado: fila, reacciones };
  } catch (e) {
    const mensaje = (e as Error).message;
    await db.from("operaciones").update({ estado: "fallida", error: mensaje }).eq("id", id);
    return { id, estado: "fallida", error: mensaje };
  }
}

function coincide(patron: string, tipo: string): boolean {
  if (patron === "*" || patron === tipo) return true;
  return patron.endsWith(".*") && tipo.startsWith(patron.slice(0, -1));
}

/** Guarda el evento y ejecuta las reacciones de los módulos suscriptos. */
export async function publicarEvento(e: Omit<Evento, "id">) {
  const { data, error } = await db.from("eventos").insert(e).select("id").single();
  if (error) throw new Error(error.message);
  const evento: Evento = { ...e, id: data.id as number };

  const resultados: { modulo: string; ok: boolean; error?: string }[] = [];
  for (const m of MODULOS) {
    for (const [patron, reaccion] of Object.entries(m.reacciones ?? {})) {
      if (!coincide(patron, evento.tipo)) continue;
      try {
        await reaccion(evento);
        resultados.push({ modulo: m.id, ok: true });
      } catch (err) {
        resultados.push({ modulo: m.id, ok: false, error: (err as Error).message });
      }
    }
  }
  if (resultados.length) await db.from("eventos").update({ reacciones: resultados }).eq("id", evento.id);
  return resultados;
}
