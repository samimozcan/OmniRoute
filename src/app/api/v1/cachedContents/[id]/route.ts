import { tryHandleProviderResourceRequest } from "@/app/api/v1/_helpers/providerResources";
import { handleCorsOptions } from "@/shared/utils/cors";

export const OPTIONS = handleCorsOptions;
type Context = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return (await tryHandleProviderResourceRequest(request, { kind: "cache", id }))!;
}

export const GET = handle;
export const PATCH = handle;
export const DELETE = handle;
