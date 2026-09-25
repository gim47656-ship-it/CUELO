import { proxySidecarRequest } from "@/lib/sidecar-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SidecarRouteContext = {
  params: Promise<{ service: string; path: string[] }>;
};

async function handle(request: Request, context: SidecarRouteContext): Promise<Response> {
  const { service, path } = await context.params;
  return proxySidecarRequest(request, service, path);
}

export async function GET(request: Request, context: SidecarRouteContext): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: SidecarRouteContext): Promise<Response> {
  return handle(request, context);
}
