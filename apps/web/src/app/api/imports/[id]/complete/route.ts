import { route } from '@/server/http';
import { handleCompleteImport } from '@/server/handlers/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    return handleCompleteImport(request, id);
  },
);
