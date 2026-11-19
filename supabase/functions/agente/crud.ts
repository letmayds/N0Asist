/**
 * CRUD genérico y seguro sobre las tablas de un módulo.
 * - Solo tablas declaradas por el módulo y solo columnas declaradas (o id/creado_en/actualizado_en).
 * - Lecturas: directas. Escrituras: se guardan como operación pendiente y se aplican al confirmar.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "./config.ts";
import { db } from "./db.ts";
import type { Contexto, Modulo, OperacionPropuesta, Tabla } from "./tipos.ts";

const COLUMNAS_SISTEMA = ["id", "creado_en", "actualizado_en"];
const OPERADORES = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains"] as const;
type Operador = typeof OPERADORES[number];

interface Filtro {
  columna: string;
  op: Operador;
  valor: unknown;
}

export function tablaDe(modulo: Modulo, nombre: string): Tabla {
  const t = modulo.tablas.find((x) => x.nombre === nombre);
  if (!t) {
    throw new Error(`La tabla "${nombre}" no es del módulo ${modulo.id}. Tablas: ${modulo.tablas.map((x) => x.nombre).join(", ")}`);
  }
  return t;
}

function columnasDe(t: Tabla): Set<string> {
  return new Set([...COLUMNAS_SISTEMA, ...t.columnas.map((c) => c.nombre)]);
}

function validarColumnas(t: Tabla, nombres: string[]) {
  const validas = columnasDe(t);
  const malas = nombres.filter((n) => !validas.has(n));
  if (malas.length) throw new Error(`Columnas inexistentes en ${t.nombre}: ${malas.join(", ")}`);
}

function limpiarDatos(t: Tabla, datos: Record<string, unknown>): Record<string, unknown> {
  validarColumnas(t, Object.keys(datos));
  const salida = { ...datos };
  for (const c of COLUMNAS_SISTEMA) delete salida[c];
  return salida;
}

// deno-lint-ignore no-explicit-any
function aplicarFiltros(q: any, t: Tabla, filtros: Filtro[] = []) {
  validarColumnas(t, filtros.map((f) => f.columna));
  for (const f of filtros) {
    if (!OPERADORES.includes(f.op)) throw new Error(`Operador inválido: ${f.op}`);
    if (f.op === "in") {
      if (!Array.isArray(f.valor)) throw new Error(`"in" necesita una lista en ${f.columna}`);
      q = q.in(f.columna, f.valor);
    } else if (f.op === "contains") {
      q = q.contains(f.columna, Array.isArray(f.valor) ? f.valor : [f.valor]);
    } else {
      q = q[f.op](f.columna, f.valor);
    }
  }
  return q;
}

// ---------- Lecturas ----------

async function buscar(modulo: Modulo, e: Record<string, unknown>): Promise<string> {
  const t = tablaDe(modulo, String(e.tabla));
  const columnas = (e.columnas as string[] | undefined) ?? [];
  if (columnas.length) validarColumnas(t, columnas);
  const limite = Math.min(Number(e.limite) || 20, CONFIG.limiteFilas);
  let q = db.from(t.nombre).select(columnas.length ? columnas.join(",") : "*", { count: "exact" });
  q = aplicarFiltros(q, t, e.filtros as Filtro[]);
  const orden = e.orden as { columna: string; descendente?: boolean } | undefined;
  if (orden?.columna) {
    validarColumnas(t, [orden.columna]);
    q = q.order(orden.columna, { ascending: !orden.descendente });
  }
  const { data, error, count } = await q.limit(limite);
  if (error) throw new Error(error.message);
  return JSON.stringify({ total: count, mostrando: data?.length ?? 0, filas: data });
}

async function contar(modulo: Modulo, e: Record<string, unknown>): Promise<string> {
  const t = tablaDe(modulo, String(e.tabla));
  let q = db.from(t.nombre).select("id", { count: "exact", head: true });
  q = aplicarFiltros(q, t, e.filtros as Filtro[]);
  const { error, count } = await q;
  if (error) throw new Error(error.message);
  return JSON.stringify({ total: count });
}

// ---------- Escrituras (propuestas) ----------

async function registrarPropuesta(
  ctx: Contexto,
  p: Omit<OperacionPropuesta, "id">,
): Promise<OperacionPropuesta> {
  const { data, error } = await db.from("operaciones").insert({
    conversacion_id: ctx.conversacionId,
    modulo: p.modulo,
    tabla: p.tabla,
    tipo: p.tipo,
    registro_id: p.registro_id,
    datos: p.datos,
    resumen: p.resumen,
  }).select("id").single();
  if (error) throw new Error(error.message);
  const op = { ...p, id: data.id as number };
  ctx.operaciones.push(op);
  return op;
}

async function existe(t: Tabla, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from(t.nombre).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No existe el registro ${id} en ${t.nombre}`);
  return data;
}

const AVISO = "Queda pendiente: el dueño la confirma con el botón. No digas que ya está guardado.";

async function proponerAlta(modulo: Modulo, e: Record<string, unknown>, ctx: Contexto): Promise<string> {
  const t = tablaDe(modulo, String(e.tabla));
  const datos = limpiarDatos(t, (e.datos ?? {}) as Record<string, unknown>);
  const faltan = t.columnas.filter((c) => c.obligatoria && (datos[c.nombre] === undefined || datos[c.nombre] === null || datos[c.nombre] === ""));
  if (faltan.length) throw new Error(`Faltan datos obligatorios: ${faltan.map((c) => c.nombre).join(", ")}`);
  const op = await registrarPropuesta(ctx, {
    modulo: modulo.id, tabla: t.nombre, tipo: "alta", registro_id: null, datos, resumen: String(e.resumen ?? ""),
  });
  return `Propuesta #${op.id} (alta en ${t.nombre}) creada. ${AVISO}`;
}

async function proponerCambio(modulo: Modulo, e: Record<string, unknown>, ctx: Contexto): Promise<string> {
  const t = tablaDe(modulo, String(e.tabla));
  const id = String(e.id);
  const actual = await existe(t, id);
  const cambios = limpiarDatos(t, (e.cambios ?? {}) as Record<string, unknown>);
  if (!Object.keys(cambios).length) throw new Error("No hay cambios");
  const op = await registrarPropuesta(ctx, {
    modulo: modulo.id, tabla: t.nombre, tipo: "cambio", registro_id: id, datos: cambios, resumen: String(e.resumen ?? ""),
  });
  const antes = Object.fromEntries(Object.keys(cambios).map((k) => [k, actual[k]]));
  return `Propuesta #${op.id} (cambio en ${t.nombre}) creada. Valores actuales: ${JSON.stringify(antes)}. ${AVISO}`;
}

async function proponerBaja(modulo: Modulo, e: Record<string, unknown>, ctx: Contexto): Promise<string> {
  const t = tablaDe(modulo, String(e.tabla));
  const id = String(e.id);
  const actual = await existe(t, id);
  const op = await registrarPropuesta(ctx, {
    modulo: modulo.id, tabla: t.nombre, tipo: "baja", registro_id: id, datos: actual, resumen: String(e.resumen ?? ""),
  });
  return `Propuesta #${op.id} (baja en ${t.nombre}) creada. ${AVISO}`;
}

/** Aplica una operación ya confirmada. Devuelve la fila resultante. */
export async function aplicarOperacion(
  modulo: Modulo,
  op: { tabla: string; tipo: string; registro_id: string | null; datos: Record<string, unknown> | null },
): Promise<Record<string, unknown>> {
  const t = tablaDe(modulo, op.tabla);
  if (op.tipo === "alta") {
    const { data, error } = await db.from(t.nombre).insert(limpiarDatos(t, op.datos ?? {})).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  if (!op.registro_id) throw new Error("Falta el id del registro");
  if (op.tipo === "cambio") {
    const { data, error } = await db.from(t.nombre).update(limpiarDatos(t, op.datos ?? {})).eq("id", op.registro_id).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  const { data, error } = await db.from(t.nombre).delete().eq("id", op.registro_id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// ---------- Definiciones para Claude ----------

export function herramientasCrud(modulo: Modulo): Anthropic.Beta.BetaTool[] {
  const tablas = modulo.tablas.map((t) => t.nombre);
  const tabla = { type: "string", enum: tablas, description: "Tabla del módulo" };
  const filtros = {
    type: "array",
    description: "Condiciones (todas deben cumplirse). like/ilike usan % como comodín; contains es para listas (text[]).",
    items: {
      type: "object",
      properties: {
        columna: { type: "string" },
        op: { type: "string", enum: [...OPERADORES] },
        valor: { description: "Valor a comparar; lista para 'in' y 'contains'; null para 'is'" },
      },
      required: ["columna", "op", "valor"],
    },
  };
  const resumen = { type: "string", description: "Una línea clara para el dueño: qué se va a hacer y con qué datos" };
  return [
    {
      name: "buscar",
      description: `Lee filas de una tabla del módulo (máx. ${CONFIG.limiteFilas}). Devuelve el total que cumple los filtros.`,
      input_schema: {
        type: "object",
        properties: {
          tabla,
          filtros,
          columnas: { type: "array", items: { type: "string" }, description: "Solo estas columnas (opcional)" },
          orden: {
            type: "object",
            properties: { columna: { type: "string" }, descendente: { type: "boolean" } },
            required: ["columna"],
          },
          limite: { type: "integer", minimum: 1, maximum: CONFIG.limiteFilas },
        },
        required: ["tabla"],
      },
    },
    {
      name: "contar",
      description: "Cuenta las filas que cumplen los filtros.",
      input_schema: { type: "object", properties: { tabla, filtros }, required: ["tabla"] },
    },
    {
      name: "proponer_alta",
      description: "Propone crear un registro. No guarda: queda pendiente hasta que el dueño confirme.",
      input_schema: {
        type: "object",
        properties: { tabla, datos: { type: "object", description: "Columna → valor" }, resumen },
        required: ["tabla", "datos", "resumen"],
      },
    },
    {
      name: "proponer_cambio",
      description: "Propone modificar un registro existente (por id). Buscalo antes. Queda pendiente hasta que el dueño confirme.",
      input_schema: {
        type: "object",
        properties: { tabla, id: { type: "string" }, cambios: { type: "object", description: "Solo las columnas que cambian" }, resumen },
        required: ["tabla", "id", "cambios", "resumen"],
      },
    },
    {
      name: "proponer_baja",
      description: "Propone borrar un registro (por id). Buscalo antes. Queda pendiente hasta que el dueño confirme.",
      input_schema: {
        type: "object",
        properties: { tabla, id: { type: "string" }, resumen },
        required: ["tabla", "id", "resumen"],
      },
    },
  ];
}

export async function ejecutarCrud(
  modulo: Modulo,
  nombre: string,
  entrada: Record<string, unknown>,
  ctx: Contexto,
): Promise<string | null> {
  switch (nombre) {
    case "buscar": return await buscar(modulo, entrada);
    case "contar": return await contar(modulo, entrada);
    case "proponer_alta": return await proponerAlta(modulo, entrada, ctx);
    case "proponer_cambio": return await proponerCambio(modulo, entrada, ctx);
    case "proponer_baja": return await proponerBaja(modulo, entrada, ctx);
    default: return null;
  }
}
