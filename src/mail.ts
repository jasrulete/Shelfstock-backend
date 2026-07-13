// Transactional email via the Resend HTTP API (no SDK - it's one POST).
// Email is optional infrastructure: when RESEND_API_KEY is unset every send
// is a silent no-op, and a failed send only logs - an email problem must
// never fail an order.

interface OrderEmailData {
  id: number;
  total_amount: string;
  shipping_name: string | null;
  shipping_address: string | null;
  shipping_city: string | null;
}

interface OrderEmailItem {
  name: string;
  quantity: number;
  price: number;
}

function esc(value: string | null): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Resolves true only if Resend accepted the message, so callers that need
// to record "this email was really sent" (e.g. the win-back job) can.
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const from = process.env.MAIL_FROM ?? 'ShelfStock <onboarding@resend.dev>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string };
      console.log(`Email "${subject}" sent to ${to} (${body.id ?? 'no id'})`);
      return true;
    }
    console.error(`Email "${subject}" to ${to} failed: ${res.status} ${await res.text()}`);
    return false;
  } catch (err) {
    console.error(`Email "${subject}" to ${to} failed:`, err);
    return false;
  }
}

export function sendWinback(to: string, name: string | null, storeUrl: string): Promise<boolean> {
  const greeting = name ? `Hi ${esc(name)},` : 'Hi,';
  const html = `
    <div style="font-family:sans-serif;max-width:480px">
      <h2>We miss you!</h2>
      <p>${greeting} it's been a while since your last ShelfStock order. We've kept
      the shelves stocked - come see what's new.</p>
      <p><a href="${esc(storeUrl)}" style="display:inline-block;background:#2563eb;color:#fff;
      padding:10px 18px;border-radius:6px;text-decoration:none">Browse the store</a></p>
      <p style="color:#999;font-size:12px">ShelfStock · You're receiving this because you shopped with us.</p>
    </div>`;

  return sendEmail(to, 'We miss you at ShelfStock', html);
}

export function sendOrderConfirmation(
  to: string,
  order: OrderEmailData,
  items: OrderEmailItem[]
): Promise<boolean> {
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:4px 12px 4px 0">${esc(i.name)} × ${i.quantity}</td>` +
        `<td style="padding:4px 0;text-align:right">$${(i.price * i.quantity).toFixed(2)}</td></tr>`
    )
    .join('');

  const html = `
    <div style="font-family:sans-serif;max-width:480px">
      <h2>Thanks for your order!</h2>
      <p>Hi ${esc(order.shipping_name)}, we've received order <strong>#${order.id}</strong> and
      will get it moving soon. You'll pay <strong>$${order.total_amount} (Cash on Delivery)</strong>
      when it arrives.</p>
      <table style="width:100%;border-collapse:collapse">${rows}
        <tr><td style="padding:8px 12px 0 0;border-top:1px solid #ddd"><strong>Total</strong></td>
        <td style="padding:8px 0 0;border-top:1px solid #ddd;text-align:right"><strong>$${order.total_amount}</strong></td></tr>
      </table>
      <p style="color:#555">Shipping to: ${esc(order.shipping_address)}, ${esc(order.shipping_city)}</p>
      <p style="color:#999;font-size:12px">ShelfStock</p>
    </div>`;

  return sendEmail(to, `Order #${order.id} confirmed - ShelfStock`, html);
}

export function sendOrderShipped(to: string, order: OrderEmailData): Promise<boolean> {
  const html = `
    <div style="font-family:sans-serif;max-width:480px">
      <h2>Your order is on the way!</h2>
      <p>Hi ${esc(order.shipping_name)}, order <strong>#${order.id}</strong> has shipped to
      ${esc(order.shipping_address)}, ${esc(order.shipping_city)}.</p>
      <p>Please prepare <strong>$${order.total_amount}</strong> for Cash on Delivery.</p>
      <p style="color:#999;font-size:12px">ShelfStock</p>
    </div>`;

  return sendEmail(to, `Order #${order.id} shipped - ShelfStock`, html);
}
