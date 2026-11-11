import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { config } from '../../config';
import { Migration20261110230000_schema_inicial } from './migrations/Migration20261110230000_schema_inicial';

// O MikroORM cuida da conexão, das transações (em.transactional) e das migrations. O domínio não
// conhece o ORM: os repositórios usam SQL explícito para controlar travas e updates condicionais.
export default defineConfig({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  dbName: config.db.name,
  pool: { min: 1, max: config.db.poolMax },
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: 'src/infrastructure/database/migrations',
    // lista explícita, sem varrer a pasta: funciona igual no Mac, no Linux e dentro do container
    // (cada migration nova criada com `bun run db:migration` entra aqui também)
    migrationsList: [Migration20261110230000_schema_inicial],
    transactional: true,
    allOrNothing: true,
    silent: process.env.LOG_LEVEL === 'silent',
  },
  debug: process.env.ORM_DEBUG === 'true',
});
