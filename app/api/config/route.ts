export const dynamic = "force-dynamic";

export async function GET() {
  const enabled =
    process.env.NODE_ENV !== "production" ||
    process.env.QUICK_ORDER_ENABLED === "true";
  return Response.json({ quickOrderEnabled: enabled });
}
