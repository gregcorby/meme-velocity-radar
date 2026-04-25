import { radarSnapshots } from "@shared/schema";
import type { InsertRadarSnapshot, RadarSnapshotRecord } from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { desc } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS radar_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

export const db = drizzle(sqlite);

export interface IStorage {
  saveRadarSnapshot(snapshot: InsertRadarSnapshot): Promise<RadarSnapshotRecord>;
  getLatestRadarSnapshot(): Promise<RadarSnapshotRecord | undefined>;
}

export class DatabaseStorage implements IStorage {
  async saveRadarSnapshot(snapshot: InsertRadarSnapshot): Promise<RadarSnapshotRecord> {
    return db.insert(radarSnapshots).values(snapshot).returning().get();
  }

  async getLatestRadarSnapshot(): Promise<RadarSnapshotRecord | undefined> {
    return db.select().from(radarSnapshots).orderBy(desc(radarSnapshots.id)).limit(1).get();
  }
}

export const storage = new DatabaseStorage();
