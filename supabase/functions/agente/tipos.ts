import type Anthropic from "@anthropic-ai/sdk";

/** Columna de una tabla de un módulo (el tipo real lo define la migración SQL). */
export interface Columna {
  nombre: string;
  /** Tipo en palabras para la IA: "texto", "número", "fecha (AAAA-MM-DD)", "uuid de notas_notas", ... */
  tipo: string;
  descripcion?: string;
  obligatoria?: boolean;
}

export interface Tabla {
  /** Nombre real en Postgres, con el prefijo del módulo: "<modulo>_<tabla>" */
  nombre: string;
  descripcion: string;
  columnas: Columna[];
}

/** Contexto de un pedido: viaja por el orquestador, los módulos y sus conectores. */
export interface Contexto {
  conversacionId: string | null;
  /** Módulos por los que ya pasó el pedido (evita ciclos entre conectores) */
  cadena: string[];
  /** Hora límite (Date.now()) para cortar antes del límite de la Edge Function */
  limite: number;
  /** Lo que se fue haciendo, para mostrarlo bajo la respuesta */
  pasos: string[];
  /** Operaciones propuestas en este pedido (el dueño las confirma con un botón) */
  operaciones: OperacionPropuesta[];
}

export interface OperacionPropuesta {
  id: number;
  modulo: string;
  tabla: string;
  tipo: "alta" | "cambio" | "baja";
  resumen: string;
  datos: Record<string, unknown> | null;
  registro_id: string | null;
}

/** Herramienta propia de un módulo (además del CRUD genérico). */
export interface HerramientaModulo {
  definicion: Anthropic.Beta.BetaTool;
  ejecutar: (entrada: Record<string, unknown>, ctx: Contexto) => Promise<string>;
}

/** Evento del bus: lo publica cada operación aplicada, con tipo "<modulo>.<tabla>.<alta|cambio|baja>". */
export interface Evento {
  id: number;
  tipo: string;
  modulo: string;
  tabla: string;
  registro_id: string | null;
  datos: Record<string, unknown> | null;
}

/**
 * Un módulo = un mini agente dueño de un sector de datos (sus tablas).
 * Para agregar uno: copiá modulos/_plantilla.ts, creá su migración SQL y registralo en modulos/registro.ts.
 */
export interface Modulo {
  /** Identificador corto, en minúsculas; también es el prefijo de sus tablas */
  id: string;
  nombre: string;
  /** Para el agente general: qué maneja y cuándo delegarle */
  descripcion: string;
  /** Reglas del negocio para el agente del módulo */
  instrucciones: string[];
  tablas: Tabla[];
  /** Conectores síncronos: ids de módulos a los que este módulo les puede preguntar o pedir cosas */
  conectores?: string[];
  /** Herramientas propias (cálculos, integraciones, etc.) */
  herramientas?: HerramientaModulo[];
  /**
   * Conectores asíncronos: reacciones a eventos de otros módulos (o propios), sin IA.
   * Clave: tipo exacto ("pagos.pagos_pagos.alta") o con comodín ("pagos.*", "*").
   * Lo que escriban acá se aplica directo, sin pasar por la confirmación.
   */
  reacciones?: Record<string, (evento: Evento) => Promise<void>>;
}
