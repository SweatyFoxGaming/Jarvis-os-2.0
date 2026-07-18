import { getPool } from "./db.js";
import type { AnalysisIssue } from "../evolution/analyzer.js";

export interface StoredAnalysis {
  id: number;
  analysis_type: string;
  score: number;
  issues: AnalysisIssue[];
  created_at: Date;
}

export async function saveAnalysis(type: string, score: number, issues: AnalysisIssue[]): Promise<StoredAnalysis> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO evolution_analyses (analysis_type, score, issues) VALUES ($1, $2, $3) RETURNING *`,
    [type, score, JSON.stringify(issues)]
  );
  return rows[0];
}

export async function getLatestAnalysis(type: string): Promise<StoredAnalysis | null> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM evolution_analyses WHERE analysis_type = $1 ORDER BY created_at DESC LIMIT 1`,
    [type]
  );
  return rows[0] || null;
}

export async function getLatestAnalysisPerType(): Promise<StoredAnalysis[]> {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT DISTINCT ON (analysis_type) *
    FROM evolution_analyses
    ORDER BY analysis_type, created_at DESC
  `);
  return rows;
}

export async function getAllAnalyses(limit = 50): Promise<StoredAnalysis[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT * FROM evolution_analyses ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getTrend(type: string, limit = 30): Promise<{ score: number; created_at: Date }[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT score, created_at FROM evolution_analyses WHERE analysis_type = $1 ORDER BY created_at ASC LIMIT $2`,
    [type, limit]
  );
  return rows;
}

export interface EvolutionGoal {
  id: number;
  metric: string;
  target_value: number;
  comparator: "lte" | "gte";
  created_at: Date;
}

export async function createGoal(metric: string, targetValue: number, comparator: "lte" | "gte"): Promise<EvolutionGoal> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO evolution_goals (metric, target_value, comparator) VALUES ($1, $2, $3) RETURNING *`,
    [metric, targetValue, comparator]
  );
  return rows[0];
}

export async function listGoals(): Promise<EvolutionGoal[]> {
  const db = getPool();
  const { rows } = await db.query(`SELECT * FROM evolution_goals ORDER BY created_at DESC`);
  return rows;
}
