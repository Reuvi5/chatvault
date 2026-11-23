import { route } from '@/server/http';
import { handleAuthorizeDownload } from '@/server/handlers/objects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return handleAuthorizeDownload(request, id);
});
