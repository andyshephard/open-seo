import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { gscConnections, projects } from "@/db/schema";

export type GscConnection = typeof gscConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<GscConnection | null> {
  const rows = await db
    .select()
    .from(gscConnections)
    .where(eq(gscConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  siteUrl: string;
  connectedByUserId: string;
  gscAccountId: string;
  connectedAccountEmail: string | null;
}): Promise<GscConnection> {
  const [row] = await db
    .insert(gscConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: gscConnections.projectId,
      set: {
        siteUrl: input.siteUrl,
        organizationId: input.organizationId,
        connectedByUserId: input.connectedByUserId,
        gscAccountId: input.gscAccountId,
        connectedAccountEmail: sql`case
          when ${gscConnections.connectedByUserId} = ${input.connectedByUserId}
            and ${gscConnections.gscAccountId} = ${input.gscAccountId}
          then coalesce(${input.connectedAccountEmail}, ${gscConnections.connectedAccountEmail})
          else ${input.connectedAccountEmail}
        end`,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) {
    throw new Error("Failed to upsert gsc_connection");
  }
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(gscConnections)
    .where(eq(gscConnections.projectId, projectId));
}

/** Every connection on a live (unarchived) project, for the daily history sync. */
async function listActive() {
  return db
    .select({
      connection: gscConnections,
      organizationId: projects.organizationId,
    })
    .from(gscConnections)
    .innerJoin(projects, eq(projects.id, gscConnections.projectId))
    .where(and(isNull(projects.archivedAt)));
}

export const GscConnectionRepository = {
  getByProjectId,
  listActive,
  upsert,
  deleteByProjectId,
};
