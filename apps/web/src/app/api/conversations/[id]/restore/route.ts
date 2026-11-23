import { route } from '@/server/http';
import { handleRestoreConversation } from '@/server/handlers/conversations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return handleRestoreConversation(request, id);
});
