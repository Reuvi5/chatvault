import { route } from '@/server/http';
import { handleCreateImport } from '@/server/handlers/imports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handleCreateImport);
