// UUID v7: ordenado pelo tempo, então os índices do banco crescem em ordem.
export const newId = (): string => Bun.randomUUIDv7();
