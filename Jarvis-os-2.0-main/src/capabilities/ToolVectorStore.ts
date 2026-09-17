import { Pool, PoolConfig } from 'pg';
import { registerTypes } from 'pgvector/pg';

export class ToolVectorStore {
  private pool: Pool;
  private isInitialized: boolean = false;

  constructor(connectionString?: string) {
    const connStr = connectionString 
      || process.env.DATABASE_URL 
      || process.env.POSTGRES_URL 
      || process.env.DB_URL;
    
    let poolConfig: PoolConfig;
    if (connStr) {
      poolConfig = { connectionString: connStr };
    } else {
      const user = process.env.PGUSER || process.env.POSTGRES_USER || process.env.DB_USER || 'postgres';
      const password = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || '';
      const host = process.env.PGHOST || process.env.POSTGRES_HOST || process.env.DB_HOST || 'localhost';
      const port = parseInt(process.env.PGPORT || process.env.POSTGRES_PORT || process.env.DB_PORT || '5432', 10);
      const database = process.env.PGDATABASE || process.env.POSTGRES_DB || process.env.DB_NAME || 'jarvis';

      poolConfig = { host, port, database, user, password: String(password) };
    }

    this.pool = new Pool(poolConfig);
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;
    
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await registerTypes(client);
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS system_tools (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          description TEXT NOT NULL,
          embedding vector(768),
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      this.isInitialized = true;
    } finally {
      client.release();
    }
  }

  public async upsertTool(
    name: string, 
    description: string, 
    embedding: number[], 
    metadata: Record<string, any> = {}
  ): Promise<void> {
    await this.init();
    
    if (embedding.length !== 768) {
      throw new Error(`Invalid embedding dimension: expected 768, got ${embedding.length}`);
    }

    const query = `
      INSERT INTO system_tools (name, description, embedding, metadata)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (name) 
      DO UPDATE SET 
        description = EXCLUDED.description, 
        embedding = EXCLUDED.embedding, 
        metadata = EXCLUDED.metadata
    `;
    
    const vectorLiteral = '[' + embedding.join(',') + ']';
    await this.pool.query(query, [name, description, vectorLiteral, metadata]);
  }

  public async searchTools(queryEmbedding: number[], limit: number = 3): Promise<Array<{
    name: string;
    description: string;
    metadata: any;
    similarity: number;
  }>> {
    await this.init();

    if (queryEmbedding.length !== 768) {
      throw new Error(`Invalid query embedding dimension: expected 768, got ${queryEmbedding.length}`);
    }

    const vectorLiteral = '[' + queryEmbedding.join(',') + ']';
    
    const query = `
      SELECT name, description, metadata, 1 - (embedding <=> $1) as similarity
      FROM system_tools
      ORDER BY embedding <=> $1
      LIMIT $2
    `;
    
    const { rows } = await this.pool.query(query, [vectorLiteral, limit]);
    return rows;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
