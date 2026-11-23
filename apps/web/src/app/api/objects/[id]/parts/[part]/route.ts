import { route } from '@/server/http';
import { handleUploadPart } from '@/server/handlers/objects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = route(
  async (request: Request, context: { params: Promise<{ id: string; part: string }> }) => {
    const { id, part } = await context.params;
    return handleUploadPart(request, id, part);
  },
);
