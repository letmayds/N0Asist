/**
 * SISTEMA: Gestor de Compras (listas de compras por lugar y tarea).
 * Página de Notion: "🛍️ Gestor de Compras". Guía completa: "🧠 Guía para agentes de IA" (en esa página).
 * Bases: Productos (catálogo, habituales y de paso), Listas, Ítems (renglones de una lista), Lugares.
 *
 * Reglas que se respetan: Origen = Agente, Revisar + Notas IA, no duplicar productos ni ítems pendientes,
 * no escribir en campos calculados.
 */

var SISTEMAS = SISTEMAS || [];
SISTEMAS.push({
  nombre: 'Gestor de Compras (listas de compras por lugar y tarea)',

  bases: {
    'Productos': {
      data_source_id: '41b2f187-0701-818a-945b-000be2a03ef6',
      obligatorios: ['Producto', 'Tipo', 'Dónde se consigue'],
      recomendados: ['Categoría', 'Unidad', 'Precio estimado', 'Marca / detalle'],
      buscar_por: ['Producto', 'Marca / detalle'],
      duplicados: [['Producto']],
      no_editar: ['Ítems']                     // relación inversa: se completa sola
    },
    'Listas': {
      data_source_id: '41b2f187-0701-8172-b39a-000b5591372a',
      obligatorios: ['Lista', 'Lugar'],
      recomendados: ['Tarea', 'Para cuándo'],
      fijos: { 'Origen': 'Agente' },
      buscar_por: ['Lista'],
      no_editar: ['Ítems']                     // relación inversa
    },
    'Ítems': {
      data_source_id: '41b2f187-0701-8190-a495-000bc48c756f',
      obligatorios: ['Ítem', 'Producto', 'Lista'],
      recomendados: ['Cantidad', 'Prioridad', 'Detalle'],
      fijos: { 'Origen': 'Agente' },
      // El nombre del ítem es el del producto ("Lavandina"); la medida o marca va en Detalle.
      titulo_auto: ['{Producto>}'],
      // Mismo producto en la misma lista: en vez de otro ítem, se suma la cantidad al pendiente.
      duplicados: [['Producto', 'Lista']]
    },
    'Lugares': {
      data_source_id: '41b2f187-0701-815c-b4a8-000b02a1b808',
      obligatorios: ['Lugar', 'Tipo'],
      recomendados: ['Alias'],
      buscar_por: ['Lugar', 'Alias'],
      duplicados: [['Lugar']],
      no_editar: ['Listas'],                   // relación inversa
      no_modificar: ['Lugar']                  // otras listas lo usan por nombre al hablar
    }
  },

  notas: [
    'Qué es: administra todo lo que hay que comprar (comida, limpieza, repuestos, herramientas, lo que sea). Productos es el catálogo: cada producto es Habitual (se compra seguido) o De paso (algo puntual) y dice dónde se consigue (Supermercado, Almacén, Ferretería, Bulonera, Farmacia…). Una Lista es una lista de compras para un Lugar (Casa Papa, Casa Gorda, Trabajo…) y opcionalmente para una Tarea. Un Ítem es un renglón de una lista: un producto con su cantidad y estado. Otras personas también cargan en Notion: antes de crear, buscá si ya existe.',
    'A este sistema corresponden los pedidos de "anotá…", "hay que comprar…", "agregá a la lista…", "¿qué tengo que comprar…?", "ya compré…". No tiene que ver con facturas ni pagos de servicios (eso es el Gestor de Pagos).',
    'Agregar algo para comprar (en este orden):',
    '- 1. Producto: buscalo en Productos por nombre, normalizando (sin mayúsculas ni acentos, singular = plural, uno contiene al otro: "lavandinas" = "Lavandina"). Si existe, usalo. Si no, crealo con Tipo "De paso" (o "Habitual" si el usuario dice que se compra siempre), Categoría y Dónde se consigue inferido (tornillos → Ferretería y Bulonera; papas → Verdulería y Supermercado; remedios → Farmacia; pañales → Pañalera y Supermercado). El nombre es genérico y sin cantidad; medida o marca fija van en "Marca / detalle", y lo que es solo para esta compra en el "Detalle" del ítem.',
    '- 2. Lugar: el que diga el usuario, buscándolo por Lugar o Alias en Lugares ("lo de papá" = Casa Papa). Si no lo dice, preguntalo. Si no existe, proponé crearlo; no lo inventes.',
    '- 3. Lista: la lista con Estado "Abierta" o "Comprando" de ese Lugar (y de esa Tarea si la nombró). Si hay una, esa; si hay varias, preguntá cuál; si no hay ninguna, creá una con Lista = "Compras <Lugar>" (o "<Tarea> - <Lugar>" si es para una tarea), Lugar y, si corresponde, Tarea.',
    '- 4. Ítem: Producto, Lista, Cantidad (1 si no dice), Prioridad "Normal" o "🚨 Urgente" (si dice urgente, ya, hoy, cuanto antes). El título se completa solo con el nombre del producto. Varios productos en un mismo pedido: un ítem por producto, y un solo resumen para confirmar todos.',
    '- Si ya hay un ítem Pendiente del mismo producto en esa lista (posibles_duplicados), no crees otro: actualizá la Cantidad de ese (sumando) y avisalo. Si el posible duplicado está Comprado, No conseguido o Cancelado, no es el mismo pedido: creá el ítem nuevo (no_es_duplicado).',
    '- Tarea: es una selección con el nombre de una tarea de "DBs Tareas" (todavía no es relación). Usá la opción que coincida; si no hay, escribí el nombre exacto de la tarea (se agrega como opción nueva). Una lista sin tarea es válida.',
    'Marcar compras:',
    '- "Ya compré X": el Ítem Pendiente de ese producto (en la lista del lugar que diga, o la única que lo tenga) pasa a Estado "Comprado". Si dice el precio, va en "Precio real" por unidad (si dice el total, dividilo por la cantidad) y actualizá en el Producto el "Precio estimado" y la "Fecha precio" (hoy).',
    '- "No lo conseguí" → "No conseguido". "Ya no hace falta" → "Cancelado". Si una lista se queda sin ítems pendientes (Faltan = 0), proponé pasarla a "Completa".',
    'Consultas:',
    '- Qué comprar en un comercio ("¿qué compro en la ferretería?"): Ítems con Estado "Pendiente" cuyo Producto tenga ese comercio en "Dónde se consigue" (traé los Productos con ese comercio y después sus ítems pendientes). Agrupá por Lugar y decí primero los urgentes.',
    '- Qué falta para un lugar o una tarea: Ítems "Pendiente" de las Listas abiertas de ese Lugar (relation contains) o con esa Tarea.',
    '- Cuánto se va a gastar: "Total estimado" de la lista (Cantidad × Precio real, o el Precio estimado del producto si no hay real). Los ítems sin precio no suman: decí cuántos no tienen precio.',
    '- Habituales para reponer: Productos con Tipo "Habitual".',
    'Valores y reglas:',
    '- Dónde se consigue: Supermercado, Almacén, Verdulería, Carnicería, Ferretería, Bulonera, Repuestos, Pinturería, Corralón, Electricidad, Farmacia, Pañalera, Química, Librería, ChinoLoco, Online. Categoría: Alimentos, Bebidas, Limpieza, Higiene, Bebé, Farmacia, Ferretería, Herramientas, Repuestos, Electricidad, Hogar, Librería, Otros. Unidad: unidad, kg, g, litro, paquete, caja, metro, docena. Estados de Ítem: Pendiente, Comprado, No conseguido, Cancelado. Estados de Lista: Abierta, Comprando, Completa, Cancelada.',
    '- Cantidades y precios como número con punto decimal (2500, 1.5), nunca con puntos de miles. Pesos argentinos.',
    '- Revisar = sí (con el motivo en "Notas IA") en el Ítem cuando algo se infirió con dudas: producto o lista poco claros, o un producto nuevo con "Dónde se consigue" adivinado.',
    '- No se puede: escribir en campos calculados (en Ítems: Dónde se consigue, Lugar, Tipo, Precio estimado, Subtotal, Pendiente; en Listas: Total estimado, Faltan; en Productos: Pendientes, A comprar), borrar registros (se cancelan), renombrar Lugares ni cambiar la estructura de las bases.'
  ]
});

// ---------------------------------------------------------------------------
// Pruebas de este sistema (ejecutalas desde el editor; no escriben nada)
// ---------------------------------------------------------------------------

/** Consulta: qué hay que comprar en un comercio y cuánto sale. */
function probarCompras_Consulta() {
  conversacionDePrueba_([
    '¿Qué tengo que comprar en la ferretería?',
    '¿Y cuánto suma la lista de Casa Gorda?'
  ]);
}

/** Carga sin confirmar: muestra cómo busca o crea productos, elige la lista y arma el resumen. */
function probarCompras_Carga() {
  conversacionDePrueba_([
    'Anotá para Casa Gorda lavandina, 2 kilos de papas y tornillos 6x40 para la puerta, los tornillos son urgentes.'
  ]);
}
