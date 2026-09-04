import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const db = new PrismaClient({ adapter });

/**
 * Dev-only seed: one workspace + owner membership so the v1 API can be
 * exercised locally with `x-workspace-id` / `x-user-id` headers before
 * real authentication (section 9) is wired up.
 */
async function main() {
  const workspace = await db.workspace.upsert({
    where: { id: 'dev-workspace' },
    update: {},
    create: {
      id: 'dev-workspace',
      name: 'Dev Workspace',
      planId: 'free',
    },
  });

  await db.membership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: 'dev-user' } },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId: 'dev-user',
      role: 'owner',
      status: 'active',
    },
  });

  console.log(`Seeded workspace "${workspace.id}" with owner "dev-user".`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
