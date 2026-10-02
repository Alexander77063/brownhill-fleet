/**
 * Read every row of a PostgREST query in pages. PostgREST caps a single
 * response at `max_rows` (1000 here) and says nothing about it; a sweep that
 * "reads every owned vehicle" would silently stop at the thousandth.
 */
export async function pageAll<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
