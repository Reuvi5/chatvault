import { route } from '@/server/http';
import { handleHeadObject, handleObjectContent } from '@/server/handlers/objects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return handleObjectContent(request, id);
});

export const HEAD = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return handleHeadObject(request, id);
});
