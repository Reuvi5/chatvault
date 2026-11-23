import { route } from '@/server/http';
import { handleImportStatus } from '@/server/handlers/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return handleImportStatus(request, id);
});
