import { getAgentDir } from "@oh-my-pi/pi-utils";
import { readAntigravityCharacter, readCharacterMode } from "@/lib/character-mode";
import { browserGuard, json } from "@/lib/antigravity/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = browserGuard(req);
  if (rejected) return rejected;
  const agentDir = getAgentDir();
  const character = readCharacterMode(agentDir) === "office"
    ? await readAntigravityCharacter(agentDir)
    : { id: "hikari", alias: "HIKARI(히카리)", names: [], faceUrl: "/avatars/hikari.webp" };
  return json({ character });
}
