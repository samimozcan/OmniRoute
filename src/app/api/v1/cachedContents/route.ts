import { tryHandleProviderResourceRequest } from "@/app/api/v1/_helpers/providerResources";
import { handleCorsOptions } from "@/shared/utils/cors";

export const OPTIONS = handleCorsOptions;

export async function POST(request: Request): Promise<Response> {
  return (await tryHandleProviderResourceRequest(request, { kind: "cache" }))!;
}

export async function GET(request: Request): Promise<Response> {
  return (await tryHandleProviderResourceRequest(request, { kind: "cache" }))!;
}
