/**
 * Agente general: conversa con el dueño y reparte el trabajo entre los módulos.
 * No toca datos directamente: todo pasa por el agente de cada módulo.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { delegarAModulo } from "./agente-modulo.ts";
import { cicloClaude, type Mensaje } from "./claude.ts";
import { CONFIG } from "./config.ts";
import { db } from "./db.ts";
import { MODULOS } from "./modulos/registro.ts";
import type { Contexto, OperacionPropuesta } from "./tipos.ts";

// Fijo mientras no cambie la lista de módulos (así se aprovecha la caché de prompts).
function systemGeneral(): string {
  return [
    "Sos N0Asist, el asistente personal de un único dueño. Coordinás módulos: cada uno es un agente que administra un sector de datos en la base.",
    "",
    "Módulos disponibles:",
    ...MODULOS.map((m) => `- ${m.id} (${m.nombre}): ${m.descripcion}`),
    "",
    "Cómo trabajar:",
    "- Para leer o cambiar datos, delegá con la herramienta delegar al módulo que corresponde. Si el pedido toca varios sectores, delegá a cada uno (podés hacerlo en paralelo) y uní las respuestas.",
    "- En el pedido al módulo incluí todo el contexto necesario (nombres, fechas, montos, lo que se habló antes): el módulo no ve esta conversación.",
    "- Los cambios que propone un módulo quedan pendientes; el dueño los confirma o cancela con botones debajo de tu respuesta. Nunca digas que algo ya quedó guardado hasta que te llegue el aviso de que se aplicó.",
    "- Si ningún módulo cubre lo pedido, decilo y sugerí crear un módulo nuevo para eso.",
    "- Respondé en español rioplatense, breve y claro (la respuesta puede leerse en voz alta): sin tablas ni markdown pesado.",
  ].join("\n");
}

function herramientaDelegar(): Anthropic.Beta.BetaTool {
  return {
    name: "delegar",
    description: "Le pasa un pedido al agente de un módulo y devuelve su informe (datos encontrados o propuestas de cambio con su número).",
    input_schema: {
      type: "object",
      properties: {
        modulo: { type: "string", enum: MODULOS.map((m) => m.id) },
        pedido: { type: "string", description: "Qué tiene que hacer el módulo, con todo el contexto necesario" },
      },
      required: ["modulo", "pedido"],
    },
  };
}

function ahora(): string {
  return new Date().toLocaleString("es-AR", {
    timeZone: CONFIG.zonaHoraria, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

async function cargarHistorial(conversacionId: string): Promise<Mensaje[]> {
  const { data, error } = await db.from("mensajes").select("rol, contenido").eq("conversacion_id", conversacionId).order("orden");
  if (error) throw new Error(error.message);
  return (data ?? []).map((f) => ({ role: f.rol, content: f.contenido }) as Mensaje);
}

/** Avisos de operaciones que el dueño confirmó o canceló desde el último mensaje. */
async function avisosDeOperaciones(conversacionId: string): Promise<string> {
  const { data } = await db.from("operaciones").select("id, resumen, estado, error")
    .eq("conversacion_id", conversacionId).eq("informada", false).neq("estado", "pendiente");
  if (!data?.length) return "";
  await db.from("operaciones").update({ informada: true }).in("id", data.map((o) => o.id));
  return "[Novedades: " + data.map((o) =>
    `#${o.id} ${o.estado}${o.error ? " (" + o.error + ")" : ""}: ${o.resumen}`
  ).join("; ") + "]\n";
}

export interface RespuestaChat {
  conversacion_id: string;
  respuesta: string;
  pasos: string[];
  operaciones: OperacionPropuesta[];
  nueva_conversacion: boolean;
}

export async function conversar(texto: string, conversacionId: string | null): Promise<RespuestaChat> {
  let historial: Mensaje[] = [];
  let nueva = false;
  if (conversacionId) {
    historial = await cargarHistorial(conversacionId);
    if (historial.length >= CONFIG.maxMensajesConversacion) conversacionId = null; // muy larga: arrancar otra
  }
  if (!conversacionId) {
    const { data, error } = await db.from("conversaciones").insert({ titulo: texto.slice(0, 80) }).select("id").single();
    if (error) throw new Error(error.message);
    conversacionId = data.id as string;
    historial = [];
    nueva = true;
  }

  const avisos = nueva ? "" : await avisosDeOperaciones(conversacionId);
  const mensajes: Mensaje[] = [...historial, { role: "user", content: `${avisos}[${ahora()}]\n${texto}` }];
  const desde = historial.length;

  const ctx: Contexto = {
    conversacionId, cadena: [], limite: Date.now() + CONFIG.tiempoMaximoMs, pasos: [], operaciones: [],
  };

  const respuesta = await cicloClaude({
    modelo: CONFIG.modeloGeneral(),
    esfuerzo: CONFIG.esfuerzoGeneral(),
    system: systemGeneral(),
    herramientas: [herramientaDelegar()],
    mensajes,
    maxVueltas: CONFIG.maxVueltasGeneral,
    limite: ctx.limite,
    ejecutar: async (nombre, entrada) => {
      if (nombre !== "delegar") throw new Error(`Herramienta desconocida: ${nombre}`);
      return await delegarAModulo(String(entrada.modulo), String(entrada.pedido), "general", ctx);
    },
  });

  // Guardar solo lo nuevo (append-only)
  const filas = mensajes.slice(desde).map((m, i) => ({
    conversacion_id: conversacionId, orden: desde + i, rol: m.role, contenido: m.content,
  }));
  const { error } = await db.from("mensajes").insert(filas);
  if (error) throw new Error(error.message);
  await db.from("conversaciones").update({ actualizado_en: new Date().toISOString() }).eq("id", conversacionId);

  return { conversacion_id: conversacionId, respuesta, pasos: ctx.pasos, operaciones: ctx.operaciones, nueva_conversacion: nueva };
}
