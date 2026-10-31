import type http from "node:http";
import defaultHandler from "./index.ts";

export default async function handler(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  req.url = "/api/chat";
  return defaultHandler(req, res);
}
