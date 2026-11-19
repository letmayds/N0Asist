/**
 * Agente de un módulo: recibe un pedido en lenguaje natural (del agente general o de otro módulo
 * por un conector), trabaja con las tablas de su sector y devuelve un informe.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { cicloClaude, type Mensaje } from "./claude.ts";
import { CONFIG } from "./config.ts";
import { ejecutarCrud, herramientasCrud } from "./crud.ts";
import { db } from "./db.ts";
import { MODULOS, moduloPorId } from "./modulos/registro.ts";
import type { Contexto, Modulo } from "./tipos.ts";

function describirTablas(m: Modulo): string {
  return m.tablas.map((t) => {
    const cols = t.columnas.map((c) =>
      `  - ${c.nombre} (${c.tipo}${c.obligatoria ? ", obligatoria" : ""})${c.descripcion ? ": " + c.descripcion : ""}`
    ).join("\n");
    return `Tabla ${t.nombre}: ${t.descripcion}\n  - id (uuid), creado_en, actualizado_en (automáticos)\n${cols}`;
  }).join("\n\n");
}

function systemDelModulo(m: Modulo): string {
  const conectores = (m.conectores ?? []).map((id) => moduloPorId(id)).filter(Boolean) as Modulo[];
  return [
    `Sos el agente del módulo "${m.nombre}" dentro de N0Asist, un sistema personal de un único dueño.`,
    `Tu sector: ${m.descripcion}`,
    "Los pedidos te llegan del agente general (o de otro módulo); no hablás directo con el dueño.",
    "",
    "Cómo trabajar:",
    "- Leé con buscar/contar antes de afirmar algo o de proponer cambios. No inventes datos ni ids.",
    "- Para crear, modificar o borrar usá proponer_alta / proponer_cambio / proponer_baja. Eso NO guarda: queda pendiente hasta que el dueño confirme con un botón.",
    "- Si faltan datos obligatorios o el pedido es ambiguo, no propongas: devolvé qué falta.",
    "- Fechas en formato AAAA-MM-DD. Montos como números sin símbolos.",
    "- Respondé con un informe breve y concreto: lo que encontraste o propusiste, con los números de propuesta (#) y los ids relevantes.",
    conectores.length
      ? `- Podés pedir datos o acciones a otros módulos con consultar_modulo: ${conectores.map((c) => `${c.id} (${c.descripcion})`).join("; ")}.`
      : "",
    "",
    "Reglas del módulo:",
    ...m.instrucciones.map((i) => `- ${i}`),
    "",
    "Datos del módulo:",
    describirTablas(m),
  ].filter((l) => l !== "").join("\n");
}

function herramientaConector(m: Modulo): Anthropic.Beta.BetaTool | null {
  const ids = m.conectores ?? [];
  if (!ids.length) return null;
  return {
    name: "consultar_modulo",
    description: "Le pide algo a otro módulo conectado (datos o propuestas de cambios en su sector). Devuelve su informe.",
    input_schema: {
      type: "object",
      properties: {
        modulo: { type: "string", enum: ids },
        pedido: { type: "string", description: "Qué necesitás, con todo el contexto necesario" },
      },
      required: ["modulo", "pedido"],
    },
  };
}

/** Corre el agente del módulo y deja la traza en la tabla delegaciones. */
export async function delegarAModulo(idModulo: string, pedido: string, origen: string, ctx: Contexto): Promise<string> {
  const m = moduloPorId(idModulo);
  if (!m) throw new Error(`No existe el módulo "${idModulo}". Módulos: ${MODULOS.map((x) => x.id).join(", ")}`);
  if (ctx.cadena.includes(m.id)) throw new Error(`El módulo ${m.id} ya participa en este pedido (se evita un ciclo).`);
  if (ctx.cadena.length >= CONFIG.maxProfundidad) throw new Error("Se alcanzó la profundidad máxima entre módulos.");

  const sub: Contexto = { ...ctx, cadena: [...ctx.cadena, m.id] };
  ctx.pasos.push(origen === "general" ? `→ ${m.nombre}` : `${origen} → ${m.nombre}`);

  const herramientas = [...herramientasCrud(m), ...(m.herramientas ?? []).map((h) => h.definicion)];
  const conector = herramientaConector(m);
  if (conector) herramientas.push(conector);

  const mensajes: Mensaje[] = [{ role: "user", content: `Pedido de ${origen === "general" ? "el agente general" : "el módulo " + origen}:\n${pedido}` }];
  const inicio = Date.now();
  let respuesta: string | null = null;
  let error: string | null = null;
  try {
    respuesta = await cicloClaude({
      modelo: CONFIG.modeloModulos(),
      esfuerzo: CONFIG.esfuerzoModulos(),
      system: systemDelModulo(m),
      herramientas,
      mensajes,
      maxVueltas: CONFIG.maxVueltasModulo,
      limite: ctx.limite,
      ejecutar: async (nombre, entrada) => {
        const crud = await ejecutarCrud(m, nombre, entrada, sub);
        if (crud !== null) return crud;
        if (nombre === "consultar_modulo") {
          // Se pasa "sub" (comparte pasos y operaciones con el pedido original)
          return await delegarAModulo(String(entrada.modulo), String(entrada.pedido), m.id, sub);
        }
        const propia = m.herramientas?.find((h) => h.definicion.name === nombre);
        if (propia) return await propia.ejecutar(entrada, sub);
        throw new Error(`Herramienta desconocida: ${nombre}`);
      },
    });
    return respuesta;
  } catch (e) {
    error = (e as Error).message;
    throw e;
  } finally {
    await db.from("delegaciones").insert({
      conversacion_id: ctx.conversacionId, origen, modulo: m.id, pedido, respuesta, error, ms: Date.now() - inicio,
    });
  }
}
