import { z } from "zod";

const STORAGE_KEY = "omniroute:command-palette";
const MAX_HISTORY_ITEMS = 100;
const MAX_EXECUTIONS = 1_000_000;
const MAX_STORAGE_LENGTH = 32_768;

export interface CommandPalettePreferences {
  version: 1;
  mostUsedFirst: boolean;
  counts: Record<string, number>;
}

const preferencesSchema = z.object({
  version: z.literal(1),
  mostUsedFirst: z.boolean(),
  counts: z.record(z.string(), z.unknown()),
});
const countSchema = z.number().int().min(1).max(MAX_EXECUTIONS);

function emptyPreferences(): CommandPalettePreferences {
  return { version: 1, mostUsedFirst: false, counts: {} };
}

function normalizeCounts(counts: Record<string, unknown>, knownIds: ReadonlySet<string>) {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([id, count]) => knownIds.has(id) && countSchema.safeParse(count).success)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, MAX_HISTORY_ITEMS)
  ) as Record<string, number>;
}

/** This personal preference stays in the browser, alongside other local UI preferences. */
export function readCommandPalettePreferences(
  knownIds: ReadonlySet<string>
): CommandPalettePreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_LENGTH) return emptyPreferences();
    const parsed = preferencesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return emptyPreferences();
    return { ...parsed.data, counts: normalizeCounts(parsed.data.counts, knownIds) };
  } catch {
    // Privacy modes, corrupted data and server rendering must never block navigation.
    return emptyPreferences();
  }
}

export function saveCommandPalettePreferences(preferences: CommandPalettePreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Keep the preference usable for this open palette if persistence is unavailable.
  }
}

export function recordCommandPaletteExecution(
  preferences: CommandPalettePreferences,
  id: string,
  knownIds: ReadonlySet<string>
): CommandPalettePreferences {
  if (!preferences.mostUsedFirst || !knownIds.has(id)) return preferences;
  return {
    ...preferences,
    counts: normalizeCounts(
      { ...preferences.counts, [id]: Math.min((preferences.counts[id] ?? 0) + 1, MAX_EXECUTIONS) },
      knownIds
    ),
  };
}

interface SearchablePaletteItem {
  id: string;
  label: string;
}

function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Eligibility remains with the kit filter; match quality only breaks ties in usage. */
export function orderCommandPaletteItems<T extends SearchablePaletteItem>(
  items: readonly T[],
  query: string,
  counts: Readonly<Record<string, number>>
): T[] {
  const search = fold(query).trim();
  const rank = (label: string) => {
    if (!search) return 0;
    const value = fold(label);
    if (value === search) return 0;
    if (value.startsWith(search)) return 1;
    if (value.includes(search)) return 2;
    return 3;
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item.label) }))
    .sort(
      (a, b) =>
        (counts[b.item.id] ?? 0) - (counts[a.item.id] ?? 0) || a.rank - b.rank || a.index - b.index
    )
    .map(({ item }) => item);
}
