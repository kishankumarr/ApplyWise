import { prisma } from "@applywise/database";
import { route } from "@/server/http";
import { visibleNotificationsWhere } from "@/server/services/notification.service";

export const GET = route({}, async ({ userId }) =>
  prisma.notification.findMany({ where: visibleNotificationsWhere(userId), orderBy: { createdAt: "desc" }, take: 50 }),
);

export const POST = route({}, async ({ userId }) => {
  const res = await prisma.notification.updateMany({ where: { ...visibleNotificationsWhere(userId), readAt: null }, data: { readAt: new Date() } });
  return { marked: res.count };
});
