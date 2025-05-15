export function getDateRangeFromQuery(query) {
  const { start_date, end_date } = query;

  if (!start_date || !end_date) {
    throw new Error('Faltan start_date o end_date');
  }

  const start = new Date(start_date);
  const end = new Date(end_date);

  if (isNaN(start) || isNaN(end)) {
    throw new Error('Fechas inválidas');
  }

  return { start, end };
}
