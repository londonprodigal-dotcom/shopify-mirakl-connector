import crypto from 'crypto';

// Louche has two Shopify apps registered (custom app owns INVENTORY_LEVELS_UPDATE,
// OAuth app owns FULFILLMENTS_CREATE/UPDATE + REFUNDS_CREATE). Each signs webhook
// payloads with its own shared secret, so the verifier must try every candidate
// secret and accept if any match. Constant-time comparison is preserved per
// candidate; we return as soon as one matches.
export function verifyShopifyHmac(
  body: Buffer,
  receivedHmacHeader: string | undefined,
  secrets: readonly string[]
): boolean {
  if (!receivedHmacHeader || secrets.length === 0) return false;
  const receivedBuf = Buffer.from(receivedHmacHeader);

  for (const secret of secrets) {
    if (!secret) continue;
    const computed = crypto.createHmac('sha256', secret).update(body).digest('base64');
    const computedBuf = Buffer.from(computed);
    if (computedBuf.length !== receivedBuf.length) continue;
    if (crypto.timingSafeEqual(computedBuf, receivedBuf)) return true;
  }
  return false;
}
