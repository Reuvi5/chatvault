import { route } from '@/server/http';
import { handleCreateVault } from '@/server/handlers/vaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = route(handleCreateVault);
